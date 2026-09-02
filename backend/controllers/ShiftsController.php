<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Scheduling\FatigueCalculator;
use PDO;

/**
 * Shifts — Master Reference §6 "Shifts and fatigue" section, §5
 * `shift_schedule` table, §9 W11 Shift & Roster Scheduler ("Week view
 * uses real start_at/end_at. Overlaps are rejected. Fatigue recalculates
 * on create/edit/reassignment and shows its calculation basis.").
 *
 * Resolved decisions, logged in DEVLOG.md:
 *   - **`barangay_id?` in the POST body is accepted but ignored.** Every
 *     other write endpoint in this codebase derives tenant strictly from
 *     the caller's own session (§2 Rule: never trust request JSON for
 *     identity/tenant) — the `?` marking it optional in §6 doesn't carry
 *     license to trust a client-supplied barangay over the Admin's own
 *     token, so this endpoint does the same as `POST /users`/`POST
 *     /incidents`: barangay always comes from `$identity`.
 *   - **Overlap check is a plain time-range intersection**
 *     (`start_at < :end_at AND end_at > :start_at`) for the *same*
 *     Tanod, locked via `SELECT ... FOR UPDATE` before insert/update so
 *     two concurrent requests can't both pass the check and create
 *     overlapping shifts for the same person.
 *   - **`user_id` is nullable** (migration 0003 — see that file's own
 *     doc) so `PATCH /shift-swap-requests/:id` can actually leave a shift
 *     "unassigned" per §6, and so an Admin can directly unassign a shift
 *     via a normal edit (`user_id: null`) without needing the swap-
 *     request flow. A currently-unassigned shift has no user to validate/
 *     lock against and contributes nothing to anyone's fatigue total.
 *   - **`GET /shifts` ordering**: `start_at ASC` — §6 doesn't state one,
 *     but a week/roster view needs chronological order, not insertion
 *     order.
 *   - version is included in GET /shifts and POST /shifts responses even
 *     though Section 6's documented list item shape omits it. This isn't
 *     an invented field -- version already exists on the table and is
 *     required by the very next endpoint in the same section (PATCH
 *     /shifts/:id's optimistic-concurrency check); a client has no other
 *     way to learn the current version to send back. Treated as a
 *     mechanical spec gap (the paired write endpoint cannot function
 *     without it), not an architectural fork, so fixed without pausing
 *     to ask -- unlike the user_id nullability question, which changed
 *     the schema itself.
 */
final class ShiftsController
{
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $body = Http::jsonBody();
        $userId = $body['user_id'] ?? null;
        $patrolZone = $body['patrol_zone'] ?? null;
        $requestId = $body['request_id'] ?? null;

        if (!is_int($userId) && !(is_string($userId) && ctype_digit($userId))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'user_id is required.');
        }
        $userId = (int) $userId;
        if (!is_string($requestId) || !preg_match(self::UUID_PATTERN, $requestId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'request_id must be a UUID.');
        }
        [$startAt, $endAt] = self::parseTimeRange($body['start_at'] ?? null, $body['end_at'] ?? null);
        if ($patrolZone !== null && !is_string($patrolZone)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'patrol_zone must be a string.');
        }

        // Idempotency: a retry with the same request_id returns the
        // original shift instead of creating a duplicate (§6).
        $existingStmt = $pdo->prepare(
            'SELECT shift_id, user_id, patrol_zone, start_at, end_at, version
             FROM shift_schedule WHERE client_request_id = :request_id AND barangay_id = :barangay_id LIMIT 1'
        );
        $existingStmt->execute(['request_id' => $requestId, 'barangay_id' => $identity['barangay_id']]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            Http::send(200, self::mapShift($existing));
        }

        $pdo->beginTransaction();
        try {
            self::assertTanodEligible($pdo, $userId, $identity['barangay_id']);
            self::assertNoOverlap($pdo, $userId, $startAt, $endAt, null);

            $insertStmt = $pdo->prepare(
                'INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, client_request_id)
                 VALUES (:barangay_id, :user_id, :patrol_zone, :start_at, :end_at, :created_by, :request_id)'
            );
            $insertStmt->execute([
                'barangay_id' => $identity['barangay_id'],
                'user_id' => $userId,
                'patrol_zone' => $patrolZone,
                'start_at' => $startAt->format('Y-m-d H:i:s'),
                'end_at' => $endAt->format('Y-m-d H:i:s'),
                'created_by' => $identity['user_id'],
                'request_id' => $requestId,
            ]);
            $shiftId = (int) $pdo->lastInsertId();

            FatigueCalculator::recalculate($pdo, $userId, $shiftId);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(201, [
            'shift_id' => $shiftId,
            'user_id' => $userId,
            'patrol_zone' => $patrolZone,
            'start_at' => $startAt->format('Y-m-d\TH:i:s\Z'),
            'end_at' => $endAt->format('Y-m-d\TH:i:s\Z'),
            'version' => 1,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'tanod']);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($identity['role'] === 'tanod') {
            $where[] = 'user_id = :user_id';
            $params['user_id'] = $identity['user_id'];
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM shift_schedule WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT shift_id, user_id, patrol_zone, start_at, end_at, version
             FROM shift_schedule
             WHERE {$whereSql}
             ORDER BY start_at ASC
             LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        Http::send(200, [
            'items' => array_map([self::class, 'mapShift'], $rows),
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function update(PDO $pdo, array $identity, string $shiftIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        if (!ctype_digit($shiftIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Shift not found.');
        }
        $shiftId = (int) $shiftIdParam;

        $body = Http::jsonBody();
        $version = $body['version'] ?? null;
        if (!is_int($version) && !(is_string($version) && ctype_digit($version))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'version is required.');
        }
        $version = (int) $version;

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT * FROM shift_schedule WHERE shift_id = :shift_id FOR UPDATE');
            $stmt->execute(['shift_id' => $shiftId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Shift not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);
            if ((int) $row['version'] !== $version) {
                throw new ApiError(409, 'CONFLICT', 'This shift was changed by someone else — reload and try again.');
            }

            $hasUserId = array_key_exists('user_id', $body);
            $newUserId = $hasUserId ? $body['user_id'] : (int) $row['user_id'];
            if ($hasUserId && $newUserId !== null) {
                if (!is_int($newUserId) && !(is_string($newUserId) && ctype_digit($newUserId))) {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'user_id must be an integer or null.');
                }
                $newUserId = (int) $newUserId;
            }
            $newPatrolZone = array_key_exists('patrol_zone', $body) ? $body['patrol_zone'] : $row['patrol_zone'];
            if ($newPatrolZone !== null && !is_string($newPatrolZone)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'patrol_zone must be a string.');
            }
            // A field the caller didn't touch falls back to the DB's own
            // naive-UTC value (default timezone UTC for that one); a
            // field the caller did supply is a fresh client string
            // (default timezone Asia/Manila) — see parseTimestamp()'s doc.
            $utc = new \DateTimeZone('UTC');
            $manila = new \DateTimeZone('Asia/Manila');
            $newStartAt = array_key_exists('start_at', $body)
                ? self::parseTimestamp($body['start_at'], $manila)
                : self::parseTimestamp($row['start_at'], $utc);
            $newEndAt = array_key_exists('end_at', $body)
                ? self::parseTimestamp($body['end_at'], $manila)
                : self::parseTimestamp($row['end_at'], $utc);
            if ($newStartAt >= $newEndAt) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'start_at must be before end_at.');
            }

            $oldUserId = $row['user_id'] !== null ? (int) $row['user_id'] : null;
            if ($newUserId !== null) {
                self::assertTanodEligible($pdo, $newUserId, $identity['barangay_id']);
                self::assertNoOverlap($pdo, $newUserId, $newStartAt, $newEndAt, $shiftId);
            }

            $pdo->prepare(
                'UPDATE shift_schedule
                 SET user_id = :user_id, patrol_zone = :patrol_zone, start_at = :start_at, end_at = :end_at,
                     version = version + 1, updated_at = UTC_TIMESTAMP()
                 WHERE shift_id = :shift_id AND version = :version'
            )->execute([
                'user_id' => $newUserId,
                'patrol_zone' => $newPatrolZone,
                'start_at' => $newStartAt->format('Y-m-d H:i:s'),
                'end_at' => $newEndAt->format('Y-m-d H:i:s'),
                'shift_id' => $shiftId,
                'version' => $version,
            ]);

            // Recalculate for whoever is affected: the previous assignee
            // (their load just changed/dropped), and the new assignee if
            // this is a reassignment.
            if ($oldUserId !== null) {
                FatigueCalculator::recalculate($pdo, $oldUserId, $shiftId);
            }
            if ($newUserId !== null && $newUserId !== $oldUserId) {
                FatigueCalculator::recalculate($pdo, $newUserId, $shiftId);
            }

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, ['shift_id' => $shiftId, 'updated_at' => gmdate('Y-m-d\TH:i:s\Z'), 'version' => $version + 1]);
    }

    /** Same-barangay, active Tanod check shared by create()/update(). */
    public static function assertTanodEligible(PDO $pdo, int $userId, int $barangayId): void
    {
        $stmt = $pdo->prepare(
            "SELECT user_id FROM user WHERE user_id = :user_id AND barangay_id = :barangay_id AND role = 'tanod' AND is_active = 1 LIMIT 1"
        );
        $stmt->execute(['user_id' => $userId, 'barangay_id' => $barangayId]);
        if ($stmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'The selected Tanod is not available for scheduling.');
        }
    }

    /**
     * Locks (FOR UPDATE) and checks for a time-overlapping shift already
     * assigned to $userId. $excludeShiftId omits the row being edited
     * (so a no-op time-range submit on the same shift doesn't conflict
     * with itself).
     */
    public static function assertNoOverlap(PDO $pdo, int $userId, \DateTimeImmutable $startAt, \DateTimeImmutable $endAt, ?int $excludeShiftId): void
    {
        $sql = 'SELECT shift_id FROM shift_schedule
                WHERE user_id = :user_id AND start_at < :end_at AND end_at > :start_at';
        $params = [
            'user_id' => $userId,
            'start_at' => $startAt->format('Y-m-d H:i:s'),
            'end_at' => $endAt->format('Y-m-d H:i:s'),
        ];
        if ($excludeShiftId !== null) {
            $sql .= ' AND shift_id != :exclude_id';
            $params['exclude_id'] = $excludeShiftId;
        }
        $stmt = $pdo->prepare($sql . ' FOR UPDATE');
        $stmt->execute($params);
        if ($stmt->fetch(PDO::FETCH_ASSOC) !== false) {
            throw new ApiError(409, 'CONFLICT', 'This Tanod already has an overlapping shift.');
        }
    }

    /**
     * Parses one timestamp and normalizes it to UTC for storage.
     * `$defaultTimezone` matters only for a string with NO explicit
     * offset/zone of its own: a client-supplied "2026-09-10T14:30:00"
     * from an HTML `datetime-local` input carries no offset at all, and
     * §5 says operational shift times are entered/interpreted in
     * Asia/Manila — so a fresh client value is parsed with Asia/Manila as
     * the default. A DB round-trip value (`update()`'s fallback for a
     * field the caller didn't touch) is already a naive UTC string with
     * no offset either, so `update()` passes UTC as the default there
     * instead — same parser, different default per source, per PHP's own
     * DateTimeImmutable rule that an explicit offset in the string always
     * wins over the constructor's default timezone regardless of which
     * default was passed in.
     */
    public static function parseTimestamp(mixed $raw, \DateTimeZone $defaultTimezone): \DateTimeImmutable
    {
        if (!is_string($raw)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'start_at and end_at are required.');
        }
        try {
            return (new \DateTimeImmutable($raw, $defaultTimezone))->setTimezone(new \DateTimeZone('UTC'));
        } catch (\Exception) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'start_at/end_at must be valid ISO 8601 timestamps.');
        }
    }

    /**
     * Parses a fresh client-supplied start_at/end_at pair (Asia/Manila
     * default — see parseTimestamp()) and validates the ordering.
     *
     * @return array{0:\DateTimeImmutable,1:\DateTimeImmutable}
     */
    public static function parseTimeRange(mixed $startAtRaw, mixed $endAtRaw): array
    {
        $manila = new \DateTimeZone('Asia/Manila');
        $startAt = self::parseTimestamp($startAtRaw, $manila);
        $endAt = self::parseTimestamp($endAtRaw, $manila);
        if ($startAt >= $endAt) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'start_at must be before end_at.');
        }
        return [$startAt, $endAt];
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    public static function mapShift(array $row): array
    {
        return [
            'shift_id' => (int) $row['shift_id'],
            'user_id' => $row['user_id'] !== null ? (int) $row['user_id'] : null,
            'patrol_zone' => $row['patrol_zone'],
            'start_at' => $row['start_at'],
            'end_at' => $row['end_at'],
            'version' => (int) $row['version'],
        ];
    }
}
