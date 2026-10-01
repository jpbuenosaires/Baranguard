<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\DeviceSignature;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Scheduling\RosterSupport;
use PDO;

/**
 * Tanod availability — docs/FEATURE_CONTRACT_2026-10.md section 3, table
 * `tanod_availability` (migration 0030).
 *
 *   POST  /availability        tanod; X-Device-Id + client_event_id (mobile
 *                              write convention, Rule 3). `createItem()` is
 *                              also the `availability[]` group of
 *                              POST /sync/batch.
 *   GET   /availability        tanod: own rows only; admin / secretary /
 *                              punong_barangay: the whole barangay.
 *   PATCH /availability/:id    admin or secretary reviews a `submitted`
 *                              row -> `accepted` | `revised`; web
 *                              Idempotency-Key.
 *
 * Resolved decisions where the contract is silent (logged in DEVLOG.md):
 *   - A period (user_id, period_start, period_end) is one row. Re-submitting
 *     it while `submitted` replaces the windows and bumps `version`; an
 *     `accepted` period is a 409. A `revised` period (the reviewer asked
 *     for changes) is resubmittable and goes back to `submitted` with the
 *     previous review fields cleared — otherwise `revised` would be a dead
 *     end. A resubmission stores the new client_event_id so the sync
 *     ledger's lookup of that id finds the row again (an exact replay of the
 *     same windows is a no-op, never a second version bump).
 *   - Only a `submitted` row can be reviewed (any other state is a 409).
 *   - A Tanod asking for another user's rows via `user_id=` gets 404.
 *   - No audit row is written for the Tanod's own submission (same as
 *     GPS / duty-status writes); the review decision is audited.
 */
final class AvailabilityController
{
    private const MAX_WINDOWS = 62;
    private const TIME_PATTERN = '/^([01][0-9]|2[0-3]):[0-5][0-9]$/';
    private const STATUSES = ['submitted', 'accepted', 'revised'];
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const REVIEW_NOTE_MAX = 255;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $deviceId = Http::header('X-Device-Id');
        if ($deviceId === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'X-Device-Id header is required.');
        }
        RosterSupport::assertDeviceOwnership($pdo, $identity, $deviceId);
        // H-09: no-op for a device that has not upgraded to a Keystore key yet.
        DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);

        $result = self::createItem($pdo, $identity, $deviceId, Http::jsonBody());
        Http::send($result['created'] ? 201 : 200, $result['row']);
    }

    /**
     * Shared by POST /availability and POST /sync/batch (contract section 6).
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @param array<string,mixed> $item
     * @return array{id:int,wasCreated:bool,created:bool,row:array<string,mixed>}
     *         `wasCreated` is false only for an exact replay (nothing
     *         written); `created` is true only for a brand-new row (201).
     */
    public static function createItem(PDO $pdo, array $identity, string $deviceId, array $item): array
    {
        RosterSupport::assertDeviceOwnership($pdo, $identity, $deviceId);
        // H-09, per item: one signature covers the sync batch request and every
        // item is held to it exactly like GpsController::createItem. No-op for a
        // device with no registered Keystore key.
        DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);

        $clientEventId = $item['client_event_id'] ?? null;
        if (!is_string($clientEventId) || !preg_match(RosterSupport::UUID_PATTERN, $clientEventId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
        }
        $periodStart = RosterSupport::parseDate($item['period_start'] ?? null, 'period_start');
        $periodEnd = RosterSupport::parseDate($item['period_end'] ?? null, 'period_end');
        if ($periodEnd < $periodStart) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'period_end must not be before period_start.');
        }
        $windows = self::normalizeWindows($item['windows'] ?? null, $periodStart, $periodEnd);
        $windowsJson = json_encode($windows, JSON_UNESCAPED_SLASHES);

        $replay = self::findByClientEvent($pdo, $identity['user_id'], $clientEventId);
        if ($replay !== null) {
            return ['id' => (int) $replay['avail_id'], 'wasCreated' => false, 'created' => false, 'row' => self::mapRow($replay)];
        }

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'SELECT * FROM tanod_availability
                 WHERE user_id = :user_id AND period_start = :period_start AND period_end = :period_end FOR UPDATE'
            );
            $stmt->execute(['user_id' => $identity['user_id'], 'period_start' => $periodStart, 'period_end' => $periodEnd]);
            $existing = $stmt->fetch(PDO::FETCH_ASSOC);

            if ($existing !== false) {
                if ($existing['status'] === 'accepted') {
                    throw new ApiError(409, 'CONFLICT', 'This availability period has already been accepted and can no longer be changed.');
                }
                $sameWindows = json_encode(json_decode((string) $existing['windows_json'], true), JSON_UNESCAPED_SLASHES) === $windowsJson;
                if ($sameWindows && $existing['status'] === 'submitted') {
                    // Same content, new event id: no version bump, but remember
                    // the latest event id so an exact replay of it stays idempotent.
                    $pdo->prepare('UPDATE tanod_availability SET client_event_id = :cid WHERE avail_id = :id')
                        ->execute(['cid' => $clientEventId, 'id' => (int) $existing['avail_id']]);
                    $pdo->commit();
                    return ['id' => (int) $existing['avail_id'], 'wasCreated' => false, 'created' => false, 'row' => self::mapRow($existing)];
                }
                $pdo->prepare(
                    "UPDATE tanod_availability
                        SET windows_json = :windows_json, status = 'submitted', reviewed_by = NULL, reviewed_at = NULL,
                            review_note = NULL, version = version + 1, client_event_id = :client_event_id,
                            updated_at = UTC_TIMESTAMP()
                      WHERE avail_id = :avail_id"
                )->execute([
                    'windows_json' => $windowsJson,
                    'client_event_id' => $clientEventId,
                    'avail_id' => (int) $existing['avail_id'],
                ]);
                $availId = (int) $existing['avail_id'];
                $created = false;
            } else {
                try {
                    $pdo->prepare(
                        "INSERT INTO tanod_availability
                            (barangay_id, user_id, period_start, period_end, windows_json, status, version, client_event_id, created_at, updated_at)
                         VALUES (:barangay_id, :user_id, :period_start, :period_end, :windows_json, 'submitted', 1, :client_event_id, UTC_TIMESTAMP(), UTC_TIMESTAMP())"
                    )->execute([
                        'barangay_id' => $identity['barangay_id'],
                        'user_id' => $identity['user_id'],
                        'period_start' => $periodStart,
                        'period_end' => $periodEnd,
                        'windows_json' => $windowsJson,
                        'client_event_id' => $clientEventId,
                    ]);
                } catch (\PDOException $e) {
                    // A concurrent identical submit won the unique-key race.
                    if ($pdo->inTransaction()) {
                        $pdo->rollBack();
                    }
                    $raced = self::findByClientEvent($pdo, $identity['user_id'], $clientEventId);
                    if ($raced !== null) {
                        return ['id' => (int) $raced['avail_id'], 'wasCreated' => false, 'created' => false, 'row' => self::mapRow($raced)];
                    }
                    throw $e;
                }
                $availId = (int) $pdo->lastInsertId();
                $created = true;
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $row = self::findById($pdo, $availId);
        return ['id' => $availId, 'wasCreated' => true, 'created' => $created, 'row' => self::mapRow($row ?? [])];
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod', 'admin', 'secretary', 'punong_barangay']);

        $status = Http::query('status');
        if ($status !== null && !in_array($status, self::STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: ' . implode(', ', self::STATUSES) . '.');
        }
        $periodStart = Http::query('period_start');
        if ($periodStart !== null) {
            RosterSupport::parseDate($periodStart, 'period_start');
        }
        $userIdParam = Http::query('user_id');
        if ($userIdParam !== null && !ctype_digit($userIdParam)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'user_id must be numeric.');
        }

        $where = ['a.barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($identity['role'] === 'tanod') {
            if ($userIdParam !== null && (int) $userIdParam !== $identity['user_id']) {
                throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
            }
            $where[] = 'a.user_id = :user_id';
            $params['user_id'] = $identity['user_id'];
        } elseif ($userIdParam !== null) {
            $where[] = 'a.user_id = :user_id';
            $params['user_id'] = (int) $userIdParam;
        }
        if ($status !== null) {
            $where[] = 'a.status = :status';
            $params['status'] = $status;
        }
        if ($periodStart !== null) {
            $where[] = 'a.period_start = :period_start';
            $params['period_start'] = $periodStart;
        }
        $whereSql = implode(' AND ', $where);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM tanod_availability a WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT a.*, u.full_name FROM tanod_availability a
             JOIN user u ON u.user_id = a.user_id
             WHERE {$whereSql}
             ORDER BY a.period_start DESC, a.avail_id DESC
             LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        $items = array_map(static function (array $row): array {
            $mapped = self::mapRow($row);
            $mapped['full_name'] = $row['full_name'];
            return $mapped;
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function review(PDO $pdo, array $identity, string $availIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        if (!ctype_digit($availIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Availability not found.');
        }
        $availId = (int) $availIdParam;
        $idempotencyKey = RosterSupport::requireIdempotencyKey();

        $body = Http::jsonBody();
        $status = $body['status'] ?? null;
        if (!is_string($status) || !in_array($status, ['accepted', 'revised'], true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be accepted or revised.');
        }
        $note = $body['review_note'] ?? null;
        if ($note !== null && (!is_string($note) || mb_strlen($note) > self::REVIEW_NOTE_MAX)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'review_note must be a string of at most ' . self::REVIEW_NOTE_MAX . ' characters.');
        }
        if (is_string($note) && trim($note) === '') {
            $note = null;
        }

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT * FROM tanod_availability WHERE avail_id = :id FOR UPDATE');
            $stmt->execute(['id' => $availId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Availability not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);

            $replay = RosterSupport::findAuditReplay($pdo, $identity['barangay_id'], 'availability_reviewed', $availId, $idempotencyKey);
            if ($replay !== null) {
                $pdo->commit();
                Http::send(200, self::mapRow($row));
            }
            if ($row['status'] !== 'submitted') {
                throw new ApiError(409, 'CONFLICT', "An availability submission in '{$row['status']}' status cannot be reviewed.");
            }

            $pdo->prepare(
                'UPDATE tanod_availability
                    SET status = :status, reviewed_by = :reviewed_by, reviewed_at = UTC_TIMESTAMP(), review_note = :note,
                        version = version + 1, updated_at = UTC_TIMESTAMP()
                  WHERE avail_id = :id'
            )->execute(['status' => $status, 'reviewed_by' => $identity['user_id'], 'note' => $note, 'id' => $availId]);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'availability_reviewed', 'tanod_availability', $availId, [
                'avail_id' => $availId,
                'status' => $status,
                'idempotency_key' => $idempotencyKey,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, self::mapRow(self::findById($pdo, $availId) ?? []));
    }

    /**
     * @param mixed $raw
     * @return list<array{date:string,start:string,end:string}>
     */
    private static function normalizeWindows(mixed $raw, string $periodStart, string $periodEnd): array
    {
        if (!is_array($raw) || !array_is_list($raw) || count($raw) < 1 || count($raw) > self::MAX_WINDOWS) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'windows must be an array of 1 to ' . self::MAX_WINDOWS . ' entries.');
        }
        $clean = [];
        foreach ($raw as $window) {
            if (!is_array($window)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'Each window must be an object {date,start,end}.');
            }
            $date = RosterSupport::parseDate($window['date'] ?? null, 'windows[].date');
            if ($date < $periodStart || $date > $periodEnd) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'Each window date must fall inside the availability period.');
            }
            $start = $window['start'] ?? null;
            $end = $window['end'] ?? null;
            if (!is_string($start) || !preg_match(self::TIME_PATTERN, $start) || !is_string($end) || !preg_match(self::TIME_PATTERN, $end)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'Window start and end must be HH:MM (Asia/Manila local time).');
            }
            if ($end <= $start) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'Window end must be after its start.');
            }
            $clean[] = ['date' => $date, 'start' => $start, 'end' => $end];
        }
        return $clean;
    }

    /** @return array<string,mixed>|null */
    private static function findByClientEvent(PDO $pdo, int $userId, string $clientEventId): ?array
    {
        $stmt = $pdo->prepare('SELECT * FROM tanod_availability WHERE user_id = :user_id AND client_event_id = :cid LIMIT 1');
        $stmt->execute(['user_id' => $userId, 'cid' => $clientEventId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /** @return array<string,mixed>|null */
    private static function findById(PDO $pdo, int $availId): ?array
    {
        $stmt = $pdo->prepare('SELECT * FROM tanod_availability WHERE avail_id = :id LIMIT 1');
        $stmt->execute(['id' => $availId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapRow(array $row): array
    {
        $windows = json_decode((string) ($row['windows_json'] ?? '[]'), true);
        return [
            'avail_id' => (int) ($row['avail_id'] ?? 0),
            'barangay_id' => (int) ($row['barangay_id'] ?? 0),
            'user_id' => (int) ($row['user_id'] ?? 0),
            'period_start' => $row['period_start'] ?? null,
            'period_end' => $row['period_end'] ?? null,
            'windows' => is_array($windows) ? $windows : [],
            'status' => $row['status'] ?? null,
            'reviewed_by' => isset($row['reviewed_by']) ? (int) $row['reviewed_by'] : null,
            'reviewed_at' => $row['reviewed_at'] ?? null,
            'review_note' => $row['review_note'] ?? null,
            'version' => (int) ($row['version'] ?? 1),
            'client_event_id' => $row['client_event_id'] ?? null,
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }
}
