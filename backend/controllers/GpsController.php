<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GPS — Master Reference §6 "GPS" section (`GET /gps/live`,
 * `GET /gps/history`, and — added this Sprint 3 cut — `POST /gps`), §5
 * `gps_track` table, §9 W4 GIS Live Tracking / M7 Live Map.
 *
 * §6 fixes the freshness fields (`recorded_at`, `received_at`,
 * `age_seconds`, `is_stale` at >=120s) and `GET /gps/history`'s exact
 * item shape, but never states `GET /gps/live`'s response shape beyond
 * prose ("returns latest position plus freshness metadata"). Resolved
 * decisions, logged in DEVLOG.md:
 *   - `GET /gps/live` returns one row per same-barangay active Tanod who
 *     has ever recorded a GPS point — their single latest `gps_track`
 *     row plus freshness — as `{items:[{user_id,full_name,dispatch_id,
 *     latitude,longitude,accuracy_m,recorded_at,received_at,
 *     age_seconds,is_stale}]}`. A Tanod with no GPS row at all is simply
 *     absent from `items` (there is no "position" to show).
 *   - `age_seconds`/`is_stale` are computed against `recorded_at` (the
 *     device's own capture time), not `received_at` — staleness is about
 *     how old the *position* is, not network/queue delay.
 *   - `GET /gps/history`'s date range reuses the same 366-day cap
 *     `ReportsController` already established for date-range endpoints,
 *     for consistency rather than inventing a different number.
 *
 * POST /gps (Sprint 3 cut): §6 — "Tanod only → {track_id,received_at}. If
 * dispatch_id is supplied, it must belong to caller, same barangay, and be
 * active. client_event_id required for offline/retryable writes. Server
 * records received_at and validates coordinate ranges/accuracy bounds."
 * The exact request body isn't spelled out beyond that prose; resolved
 * here from §5's `gps_track` columns (logged in DEVLOG.md):
 *   - Body: {latitude,longitude,accuracy_m,recorded_at,dispatch_id?,
 *     client_event_id}. `recorded_at` is the device's own capture
 *     timestamp (§5 `gps_track.recorded_at`, distinct from the
 *     server-authoritative `received_at` — Rule 31: client timestamps are
 *     informational and never replace server receipt time).
 *   - `client_event_id` is always required, not just "for offline/
 *     retryable writes" — every mobile write in this codebase already
 *     requires one (duty status, dispatch creation, shifts), and a
 *     broadcast-cadence endpoint like this is retried by definition.
 *   - "Active" dispatch (for the optional `dispatch_id` check) means
 *     status IN ('assigned','en_route','arrived') — the same "not yet
 *     completed/cancelled" definition DispatchController already uses
 *     elsewhere in this codebase.
 *   - `createItem()` is `public static` so `SyncController::batch()`
 *     (POST /sync/batch's `gps_tracks[]` items, same Sprint 3 cut) reuses
 *     the identical validation/idempotency/insert path.
 */
final class GpsController
{
    private const MAX_RANGE_DAYS = 366;
    private const STALE_AFTER_SECONDS = 120;
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const ACTIVE_DISPATCH_STATUSES = ['assigned', 'en_route', 'arrived'];
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function live(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

        $barangayIdParam = Http::query('barangay_id');
        if ($barangayIdParam === null || !ctype_digit($barangayIdParam)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id is required.');
        }
        AuthMiddleware::requireTenant($identity, (int) $barangayIdParam);

        $stmt = $pdo->prepare(
            "SELECT gt.user_id, u.full_name, gt.dispatch_id, gt.latitude, gt.longitude,
                    gt.accuracy_m, gt.recorded_at, gt.received_at
             FROM gps_track gt
             JOIN user u ON u.user_id = gt.user_id
             WHERE u.barangay_id = :barangay_id AND u.role = 'tanod' AND u.is_active = 1
               AND gt.recorded_at = (
                   SELECT MAX(gt2.recorded_at) FROM gps_track gt2 WHERE gt2.user_id = gt.user_id
               )
             ORDER BY u.full_name ASC"
        );
        $stmt->execute(['barangay_id' => $identity['barangay_id']]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $items = array_map(static function (array $row) use ($now): array {
            $recordedAt = new \DateTimeImmutable($row['recorded_at'], new \DateTimeZone('UTC'));
            $ageSeconds = $now->getTimestamp() - $recordedAt->getTimestamp();
            return [
                'user_id' => (int) $row['user_id'],
                'full_name' => $row['full_name'],
                'dispatch_id' => $row['dispatch_id'] !== null ? (int) $row['dispatch_id'] : null,
                'latitude' => (float) $row['latitude'],
                'longitude' => (float) $row['longitude'],
                'accuracy_m' => (float) $row['accuracy_m'],
                'recorded_at' => $row['recorded_at'],
                'received_at' => $row['received_at'],
                'age_seconds' => $ageSeconds,
                'is_stale' => $ageSeconds >= GpsController::STALE_AFTER_SECONDS,
            ];
        }, $rows);

        Http::send(200, ['items' => $items]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function history(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $userIdParam = Http::query('user_id');
        if ($userIdParam === null || !ctype_digit($userIdParam)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'user_id is required.');
        }
        $userId = (int) $userIdParam;

        $userStmt = $pdo->prepare('SELECT barangay_id FROM user WHERE user_id = :user_id');
        $userStmt->execute(['user_id' => $userId]);
        $userRow = $userStmt->fetch(PDO::FETCH_ASSOC);
        if ($userRow === false) {
            throw new ApiError(404, 'NOT_FOUND', 'User not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $userRow['barangay_id']);

        $utc = new \DateTimeZone('UTC');
        $fromRaw = Http::query('date_from');
        $toRaw = Http::query('date_to');
        $to = $toRaw !== null ? self::parseDate($toRaw, $utc, 'date_to') : new \DateTimeImmutable('now', $utc);
        $from = $fromRaw !== null ? self::parseDate($fromRaw, $utc, 'date_from') : $to->modify('-29 days');
        if ($from > $to) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'date_from must not be after date_to.');
        }
        if ($from->diff($to)->days > self::MAX_RANGE_DAYS) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'date_from/date_to range cannot exceed ' . self::MAX_RANGE_DAYS . ' days.');
        }
        $rangeStart = $from->setTime(0, 0, 0);
        $rangeEnd = $to->setTime(0, 0, 0)->modify('+1 day');

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $params = [
            'user_id' => $userId,
            'range_start' => $rangeStart->format('Y-m-d H:i:s'),
            'range_end' => $rangeEnd->format('Y-m-d H:i:s'),
        ];

        $countStmt = $pdo->prepare(
            'SELECT COUNT(*) FROM gps_track
             WHERE user_id = :user_id AND recorded_at >= :range_start AND recorded_at < :range_end'
        );
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            'SELECT track_id, user_id, dispatch_id, latitude, longitude, accuracy_m, recorded_at, received_at
             FROM gps_track
             WHERE user_id = :user_id AND recorded_at >= :range_start AND recorded_at < :range_end
             ORDER BY recorded_at ASC
             LIMIT :limit OFFSET :offset'
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'track_id' => (int) $row['track_id'],
                'user_id' => (int) $row['user_id'],
                'dispatch_id' => $row['dispatch_id'] !== null ? (int) $row['dispatch_id'] : null,
                'latitude' => (float) $row['latitude'],
                'longitude' => (float) $row['longitude'],
                'accuracy_m' => (float) $row['accuracy_m'],
                'recorded_at' => $row['recorded_at'],
                'received_at' => $row['received_at'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $body = Http::jsonBody();
        $result = self::createItem($pdo, $identity, $body);
        Http::send($result['wasCreated'] ? 201 : 200, [
            'track_id' => $result['track_id'],
            'received_at' => $result['received_at'],
        ]);
    }

    /**
     * Core GPS-broadcast logic, shared by the direct POST /gps path and
     * `SyncController::batch()`'s `gps_tracks[]` items — see class doc.
     *
     * @param array<string,mixed> $item
     * @return array{track_id:int, received_at:string, wasCreated:bool}
     */
    public static function createItem(PDO $pdo, array $identity, array $item): array
    {
        $latitude = $item['latitude'] ?? null;
        $longitude = $item['longitude'] ?? null;
        $accuracyM = $item['accuracy_m'] ?? null;
        $recordedAtRaw = $item['recorded_at'] ?? null;
        $dispatchId = $item['dispatch_id'] ?? null;
        $clientEventId = $item['client_event_id'] ?? null;

        if (!is_string($clientEventId) || !preg_match(self::UUID_PATTERN, $clientEventId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
        }
        if (!is_numeric($latitude) || !is_numeric($longitude)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude and longitude are required.');
        }
        $lat = (float) $latitude;
        $lng = (float) $longitude;
        if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude/longitude are out of range.');
        }
        if (!is_numeric($accuracyM) || (float) $accuracyM < 0) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'accuracy_m must be a non-negative number.');
        }
        if (!is_string($recordedAtRaw) || strtotime($recordedAtRaw) === false) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'recorded_at must be a valid timestamp.');
        }
        $recordedAt = gmdate('Y-m-d H:i:s', (int) strtotime($recordedAtRaw));

        $dispatchIdInt = null;
        if ($dispatchId !== null) {
            if (!is_int($dispatchId) && !(is_string($dispatchId) && ctype_digit($dispatchId))) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'dispatch_id must be an integer.');
            }
            $dispatchIdInt = (int) $dispatchId;
            // §6: "must belong to caller, same barangay, and be active."
            $dispatchStmt = $pdo->prepare(
                "SELECT d.dispatch_id
                 FROM dispatch d
                 JOIN incident i ON i.incident_id = d.incident_id
                 WHERE d.dispatch_id = :dispatch_id AND d.tanod_id = :tanod_id
                   AND i.barangay_id = :barangay_id
                   AND d.status IN ('assigned','en_route','arrived')
                 LIMIT 1"
            );
            $dispatchStmt->execute([
                'dispatch_id' => $dispatchIdInt,
                'tanod_id' => $identity['user_id'],
                'barangay_id' => $identity['barangay_id'],
            ]);
            if ($dispatchStmt->fetch(PDO::FETCH_ASSOC) === false) {
                throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'dispatch_id does not reference an active dispatch assigned to you.');
            }
        }

        // §5 UNIQUE(user_id, client_event_id).
        $existingStmt = $pdo->prepare(
            'SELECT track_id, received_at FROM gps_track WHERE user_id = :user_id AND client_event_id = :client_event_id LIMIT 1'
        );
        $existingStmt->execute(['user_id' => $identity['user_id'], 'client_event_id' => $clientEventId]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            return ['track_id' => (int) $existing['track_id'], 'received_at' => $existing['received_at'], 'wasCreated' => false];
        }

        $insertStmt = $pdo->prepare(
            'INSERT INTO gps_track (user_id, dispatch_id, latitude, longitude, accuracy_m, recorded_at, received_at, client_event_id)
             VALUES (:user_id, :dispatch_id, :latitude, :longitude, :accuracy_m, :recorded_at, UTC_TIMESTAMP(), :client_event_id)'
        );
        $insertStmt->execute([
            'user_id' => $identity['user_id'],
            'dispatch_id' => $dispatchIdInt,
            'latitude' => $lat,
            'longitude' => $lng,
            'accuracy_m' => (float) $accuracyM,
            'recorded_at' => $recordedAt,
            'client_event_id' => $clientEventId,
        ]);
        $trackId = (int) $pdo->lastInsertId();

        $readBack = $pdo->prepare('SELECT received_at FROM gps_track WHERE track_id = :track_id');
        $readBack->execute(['track_id' => $trackId]);
        $receivedAt = $readBack->fetchColumn();

        return ['track_id' => $trackId, 'received_at' => $receivedAt, 'wasCreated' => true];
    }

    private static function parseDate(string $raw, \DateTimeZone $tz, string $field): \DateTimeImmutable
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $raw, $tz);
        $errors = \DateTimeImmutable::getLastErrors();
        $hasErrors = $errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0);
        if ($date === false || $hasErrors) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be in YYYY-MM-DD format.");
        }
        return $date;
    }
}
