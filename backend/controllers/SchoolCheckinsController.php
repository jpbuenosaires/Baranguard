<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\DeviceSignature;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Tanod school check-in/out (docs/FEATURE_CONTRACT_2026-10.md section 7,
 * migration 0033, Annex D "deployment days").
 *
 *   POST /school-checkins  tanod; {school_id, checked_in_at,
 *                          checked_out_at?, client_event_id}
 *   GET  /school-checkins  admin/secretary/punong_barangay;
 *                          ?from=&to=&school_id= (Manila dates, inclusive)
 *
 * Idempotency is `client_event_id` + `X-Device-Id` (Rule 3, mobile style).
 * Re-sending the SAME client_event_id with `checked_out_at` set CLOSES the
 * check-in -- the one allowed mutation -- and reports `wasCreated=false`.
 * Anything else on a replay (different school/time, or checked_out_at on an
 * already-closed row) changes nothing. No coordinates are stored: presence at
 * a school is recorded, not the Tanod's position.
 *
 * `createItem()` is the shared core so `SyncController` (POST /sync/batch's
 * `school_checkins[]`) and the direct POST are identical (contract section 6).
 * A unique-key race on (user_id, client_event_id) is handled by
 * SyncController; the direct POST re-reads on a duplicate-key error.
 */
final class SchoolCheckinsController
{
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    /** Tolerated device-clock skew (matches GpsController). */
    private const FUTURE_SKEW_SECONDS = 300;
    /** Oldest check-in a queued offline write may carry. */
    private const MAX_BACKDATE_DAYS = 62;
    /** Longest plausible single school presence. */
    private const MAX_SESSION_HOURS = 24;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $deviceId = Http::header('X-Device-Id');
        if ($deviceId === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'X-Device-Id header is required.');
        }
        // "The authenticated half of device_id + client_event_id" (Rule 3).
        $deviceStmt = $pdo->prepare(
            'SELECT device_id FROM mobile_device WHERE device_id = :d AND user_id = :u AND is_active = 1 LIMIT 1'
        );
        $deviceStmt->execute(['d' => $deviceId, 'u' => $identity['user_id']]);
        if ($deviceStmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'Device is not registered or not active for this account.');
        }
        // H-09: no-op for a device that has not upgraded to a Keystore key yet.
        DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);

        $item = Http::jsonBody();
        try {
            $result = self::createItem($pdo, $identity, $deviceId, $item);
        } catch (\PDOException $e) {
            if ($e->getCode() !== '23000') {
                throw $e;
            }
            // Lost a race against a concurrent identical request: that
            // request wins; this one is a replay.
            $result = self::createItem($pdo, $identity, $deviceId, $item);
        }

        Http::send($result['wasCreated'] ? 201 : 200, self::mapRow(self::fetchRow($pdo, $result['id'])));
    }

    /**
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @param array<string,mixed> $item
     * @return array{id:int,wasCreated:bool}
     */
    public static function createItem(PDO $pdo, array $identity, string $deviceId, array $item): array
    {
        // H-09, per item: one signature covers the sync batch request and every
        // item is held to it exactly like GpsController::createItem. No-op for a
        // device with no registered Keystore key.
        DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);

        $schoolId = $item['school_id'] ?? null;
        $clientEventId = $item['client_event_id'] ?? null;
        if (!is_string($clientEventId) || !preg_match(IncidentsController::UUID_PATTERN, $clientEventId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
        }

        // Close-by-reference: a check-out that arrives AFTER its check-in was already
        // synced cannot reuse the check-in's client_event_id, because /sync/batch's
        // offline_queue ledger answers 'duplicate' before this method runs. It carries
        // its OWN new client_event_id plus `closes_client_event_id` (the check-in's).
        $closesId = $item['closes_client_event_id'] ?? null;
        if ($closesId !== null) {
            if (!is_string($closesId) || !preg_match(IncidentsController::UUID_PATTERN, $closesId)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'closes_client_event_id must be a UUID.');
            }
            $out = self::parseUtc($item['checked_out_at'] ?? null, 'checked_out_at', true);
            $target = self::findOwn($pdo, $identity['user_id'], $closesId);
            if ($target === null) {
                throw new ApiError(404, 'NOT_FOUND', 'Check-in not found.');
            }
            $closed = self::closeIfRequested($pdo, $target, $out);
            return ['id' => $closed['id'], 'wasCreated' => true];
        }
        if (!is_int($schoolId) && !(is_string($schoolId) && ctype_digit($schoolId))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'school_id is required.');
        }
        $schoolId = (int) $schoolId;
        $checkedInAt = self::parseUtc($item['checked_in_at'] ?? null, 'checked_in_at', true);
        $checkedOutAt = self::parseUtc($item['checked_out_at'] ?? null, 'checked_out_at', false);
        if ($checkedOutAt !== null) {
            self::assertCheckoutOrder($checkedInAt, $checkedOutAt);
        }

        $existing = self::findOwn($pdo, $identity['user_id'], $clientEventId);
        if ($existing !== null) {
            return self::closeIfRequested($pdo, $existing, $checkedOutAt);
        }
        // Window check applies to a NEW row only: a replay of an already-stored
        // check-in must still return the original even after it has aged out.
        self::assertCheckinWindow($checkedInAt);

        // Tenant check: 404 for an unknown school AND for another barangay's
        // school, indistinguishably (Rule 2).
        $schoolStmt = $pdo->prepare('SELECT barangay_id FROM school WHERE school_id = :s LIMIT 1');
        $schoolStmt->execute(['s' => $schoolId]);
        $schoolBarangay = $schoolStmt->fetchColumn();
        if ($schoolBarangay === false) {
            throw new ApiError(404, 'NOT_FOUND', 'School not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $schoolBarangay);

        $pdo->prepare(
            'INSERT INTO school_checkin
                (school_id, barangay_id, user_id, checked_in_at, checked_out_at, client_event_id, created_at)
             VALUES (:school_id, :barangay_id, :user_id, :in_at, :out_at, :c, UTC_TIMESTAMP())'
        )->execute([
            'school_id' => $schoolId,
            'barangay_id' => $identity['barangay_id'],
            'user_id' => $identity['user_id'],
            'in_at' => $checkedInAt->format('Y-m-d H:i:s'),
            'out_at' => $checkedOutAt?->format('Y-m-d H:i:s'),
            'c' => $clientEventId,
        ]);

        return ['id' => (int) $pdo->lastInsertId(), 'wasCreated' => true];
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];

        $from = Http::query('from');
        $to = Http::query('to');
        if ($from !== null) {
            $where[] = 'checked_in_at >= :from_utc';
            $params['from_utc'] = SszTermReportsController::manilaDayStartUtc($from, 'from')->format('Y-m-d H:i:s');
        }
        if ($to !== null) {
            // `to` is an inclusive Manila date: exclusive bound = next day's start.
            $where[] = 'checked_in_at < :to_utc';
            $params['to_utc'] = SszTermReportsController::manilaDayStartUtc($to, 'to')
                ->modify('+1 day')->format('Y-m-d H:i:s');
        }
        $schoolId = Http::query('school_id');
        if ($schoolId !== null) {
            if (!ctype_digit($schoolId)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'school_id must be numeric.');
            }
            $where[] = 'school_id = :school_id';
            $params['school_id'] = (int) $schoolId;
        }
        $whereSql = implode(' AND ', $where);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT);
        if ($limit < 1) {
            $limit = self::DEFAULT_LIMIT;
        }
        $limit = min($limit, self::MAX_LIMIT);
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM school_checkin WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT checkin_id, school_id, user_id, checked_in_at, checked_out_at
             FROM school_checkin WHERE {$whereSql}
             ORDER BY checked_in_at DESC, checkin_id DESC LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        Http::send(200, [
            'items' => array_map([self::class, 'mapRow'], $stmt->fetchAll(PDO::FETCH_ASSOC)),
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }

    /** @return array<string,mixed>|null */
    private static function findOwn(PDO $pdo, int $userId, string $clientEventId): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT checkin_id, school_id, user_id, checked_in_at, checked_out_at
             FROM school_checkin WHERE user_id = :u AND client_event_id = :c LIMIT 1'
        );
        $stmt->execute(['u' => $userId, 'c' => $clientEventId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /**
     * The one allowed mutation: close an open check-in. A replay that
     * carries no checked_out_at, or hits an already-closed row, is a no-op.
     *
     * @param array<string,mixed> $existing
     * @return array{id:int,wasCreated:bool}
     */
    private static function closeIfRequested(PDO $pdo, array $existing, ?\DateTimeImmutable $checkedOutAt): array
    {
        $id = (int) $existing['checkin_id'];
        if ($checkedOutAt !== null && $existing['checked_out_at'] === null) {
            $in = new \DateTimeImmutable((string) $existing['checked_in_at'], new \DateTimeZone('UTC'));
            self::assertCheckoutOrder($in, $checkedOutAt);
            $pdo->prepare(
                'UPDATE school_checkin SET checked_out_at = :out_at WHERE checkin_id = :id AND checked_out_at IS NULL'
            )->execute(['out_at' => $checkedOutAt->format('Y-m-d H:i:s'), 'id' => $id]);
        }
        return ['id' => $id, 'wasCreated' => false];
    }

    /**
     * Strict ISO-8601 timestamp WITH an explicit zone (`Z` or a +/-HH:MM
     * offset) -> UTC DateTimeImmutable. A zone-less or loosely formatted string
     * ("tomorrow", "2026-10-01") is a 400: a check-in time must be unambiguous.
     */
    private static function parseUtc(mixed $value, string $field, bool $required): ?\DateTimeImmutable
    {
        if ($value === null) {
            if ($required) {
                throw new ApiError(400, 'VALIDATION_ERROR', "{$field} is required.");
            }
            return null;
        }
        if (!is_string($value)
            || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/', $value)
        ) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be an ISO-8601 timestamp with a Z or UTC offset.");
        }
        try {
            $parsed = new \DateTimeImmutable($value);
        } catch (\Exception) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be an ISO-8601 timestamp with a Z or UTC offset.");
        }
        return $parsed->setTimezone(new \DateTimeZone('UTC'));
    }

    /**
     * Plausibility window for a client-supplied check-in time: not more than
     * FUTURE_SKEW_SECONDS ahead of the server clock (a wrong device clock), and
     * not older than MAX_BACKDATE_DAYS (an offline queue can sync late, but not
     * two months late).
     */
    private static function assertCheckinWindow(\DateTimeImmutable $checkedInAt): void
    {
        $now = time();
        if ($checkedInAt->getTimestamp() > $now + self::FUTURE_SKEW_SECONDS) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'checked_in_at cannot be in the future.');
        }
        if ($checkedInAt->getTimestamp() < $now - self::MAX_BACKDATE_DAYS * 86400) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'checked_in_at cannot be more than ' . self::MAX_BACKDATE_DAYS . ' days in the past.');
        }
    }

    /** checked_out_at must not precede the check-in nor trail it by more than MAX_SESSION_HOURS. */
    private static function assertCheckoutOrder(\DateTimeImmutable $in, \DateTimeImmutable $out): void
    {
        if ($out < $in) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'checked_out_at cannot be before checked_in_at.');
        }
        if ($out->getTimestamp() - $in->getTimestamp() > self::MAX_SESSION_HOURS * 3600) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'checked_out_at cannot be more than ' . self::MAX_SESSION_HOURS . ' hours after checked_in_at.');
        }
    }

    /** @return array<string,mixed> */
    private static function fetchRow(PDO $pdo, int $checkinId): array
    {
        $stmt = $pdo->prepare(
            'SELECT checkin_id, school_id, user_id, checked_in_at, checked_out_at FROM school_checkin WHERE checkin_id = :id'
        );
        $stmt->execute(['id' => $checkinId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapRow(array $row): array
    {
        $iso = static fn (?string $v): ?string => $v === null
            ? null
            : (new \DateTimeImmutable($v, new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z');
        return [
            'checkin_id' => (int) $row['checkin_id'],
            'school_id' => (int) $row['school_id'],
            'user_id' => (int) $row['user_id'],
            'checked_in_at' => $iso($row['checked_in_at']),
            'checked_out_at' => $iso($row['checked_out_at']),
        ];
    }
}
