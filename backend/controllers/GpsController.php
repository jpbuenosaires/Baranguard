<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\DeviceSignature;
use Baranguard\Lib\Http;
use Baranguard\Lib\RateLimiter;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GPS: `GET /gps/live`, `GET /gps/history`, `GET /gps/stream` and
 * `POST /gps`, over the `gps_track` table (W4 GIS Live Tracking / M7 Live Map).
 *
 * Freshness fields are `recorded_at`, `received_at`, `age_seconds` and
 * `is_stale` (at >=120s).
 *   - `GET /gps/live` returns one row per same-barangay active Tanod who
 *     has ever recorded a GPS point — their single latest `gps_track`
 *     row plus freshness — as `{items:[{user_id,full_name,dispatch_id,
 *     latitude,longitude,accuracy_m,recorded_at,received_at,
 *     age_seconds,is_stale}]}`. A Tanod with no GPS row at all is simply
 *     absent from `items` (there is no "position" to show).
 *   - `age_seconds`/`is_stale` are computed against `recorded_at` (the
 *     device's own capture time), not `received_at`: staleness is about
 *     how old the *position* is, not network/queue delay.
 *   - `GET /gps/history`'s date range reuses the same 366-day cap
 *     `ReportsController` uses for date-range endpoints.
 *
 * POST /gps: Tanod only → {track_id,received_at}. If dispatch_id is
 * supplied, it must belong to caller and be in the same barangay. The server
 * records received_at and validates coordinate ranges/accuracy bounds.
 *   - Body: {latitude,longitude,accuracy_m,recorded_at,dispatch_id?,
 *     client_event_id}. `recorded_at` is the device's own capture
 *     timestamp, distinct from the server-authoritative `received_at`:
 *     client timestamps are informational and never replace server receipt
 *     time.
 *   - `client_event_id` is always required: every mobile write requires
 *     one, and a broadcast-cadence endpoint like this is retried by
 *     definition.
 *   - `createItem()` is `public static` so `SyncController::batch()`
 *     (`gps_tracks[]` items) reuses the identical
 *     validation/idempotency/insert path.
 */
final class GpsController
{
    private const MAX_RANGE_DAYS = 366;
    private const STALE_AFTER_SECONDS = 120;

    /** GET /gps/stream: how often the server looks for new fixes, in microseconds (0.5 s). */
    public const STREAM_LOOK_MICROS = 500000;
    /** A stream is closed after this long; the client reopens it with its current token. */
    public const STREAM_MAX_SECONDS = 300;
    /** Keep-alive comment: keeps proxies from dropping the connection and lets the server notice a closed client within this many seconds (a closed client is only detected on a write). */
    public const STREAM_PING_SECONDS = 3;
    /** How often the stream re-checks that the session is still valid. */
    public const STREAM_AUTH_RECHECK_SECONDS = 15;
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const ACTIVE_DISPATCH_STATUSES = ['assigned', 'en_route', 'arrived'];
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    // See createItem()'s own comments for the reasoning. Both numbers are
    // engineering judgment, not a documented requirement.
    private const MAX_FUTURE_SKEW_SECONDS = 300; // 5 minutes — allows minor clock/NTP drift, not a wrong clock.
    private const MAX_PLAUSIBLE_ACCURACY_M = 50000.0; // 50km — comfortably above any real device reading; anything beyond is a garbage value, not just "imprecise".

    /**
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     *
     * Tanod is admitted alongside admin/punong_barangay: a Tanod sees the
     * same same-barangay-active-Tanod roster this query already builds for
     * Admin/PB, with no wider data exposure than those roles already have
     * for their own barangay. requireTenant() below still blocks a Tanod
     * from ever passing a barangay_id other than their own (404).
     */
    public static function live(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay', 'tanod']);

        $barangayIdParam = Http::query('barangay_id');
        if ($barangayIdParam === null || !ctype_digit($barangayIdParam)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id is required.');
        }
        AuthMiddleware::requireTenant($identity, (int) $barangayIdParam);

        Http::send(200, ['items' => self::liveItems($pdo, (int) $identity['barangay_id'])]);
    }

    /**
     * Latest position of every active same-barangay Tanod, with freshness.
     * Shared by GET /gps/live and the first event of GET /gps/stream so the
     * two can never disagree about the shape.
     *
     * @return list<array<string,mixed>>
     */
    private static function liveItems(PDO $pdo, int $barangayId): array
    {
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
        $stmt->execute(['barangay_id' => $barangayId]);
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        return array_map(static fn (array $row): array => self::liveItem($row, $now), $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** @param array<string,mixed> $row */
    private static function liveItem(array $row, \DateTimeImmutable $now): array
    {
        $recordedAt = new \DateTimeImmutable((string) $row['recorded_at'], new \DateTimeZone('UTC'));
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
    }

    /**
     * GET /gps/stream?barangay_id= -- the same positions as /gps/live, pushed
     * as Server-Sent Events the moment a phone's fix is stored, instead of
     * waiting for the dashboard's next poll.
     *
     * Events: `snapshot` ({items}, once, same shape as /gps/live), `position`
     * ({items}, the new fixes, latest per Tanod), `auth_expired` (the session
     * was revoked/expired/suspended mid-stream; client must re-login),
     * `reconnect` (the stream reached STREAM_MAX_SECONDS; open a new one with
     * the current token). A `: ping` comment every STREAM_PING_SECONDS keeps
     * proxies (Cloudflare closes idle connections at about 100 s) open and
     * lets the server notice a closed client quickly.
     *
     * Same authentication, role, tenant and Tanod filter as /gps/live; the
     * session row is re-checked every STREAM_AUTH_RECHECK_SECONDS so a logout,
     * suspension or deactivation ends the stream within that window. The
     * stream is bounded (STREAM_MAX_SECONDS) so a worker thread is never held
     * forever, and opening one is rate limited. It sends only what /gps/live
     * already sends: no narrative, no names beyond full_name.
     *
     * @param array{user_id:int,barangay_id:int,role:string,session_id:int} $identity
     */
    public static function stream(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay', 'tanod']);

        $barangayIdParam = Http::query('barangay_id');
        if ($barangayIdParam === null || !ctype_digit($barangayIdParam)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id is required.');
        }
        AuthMiddleware::requireTenant($identity, (int) $barangayIdParam);

        if (!RateLimiter::check($pdo, 'gps_stream:user:' . $identity['user_id'], 300, 40)) {
            throw new ApiError(429, 'RATE_LIMITED', 'Too many live-stream connections recently. Please wait before reconnecting.');
        }

        $barangayId = (int) $identity['barangay_id'];
        // Take the high-water mark BEFORE the snapshot so no fix can fall
        // between the two (a fix in both is harmless: the client merges by user).
        $lastTrackId = (int) $pdo->query('SELECT COALESCE(MAX(track_id), 0) FROM gps_track')->fetchColumn();

        @ini_set('zlib.output_compression', '0');
        @ini_set('implicit_flush', '1');
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        set_time_limit(0);
        ignore_user_abort(false);
        http_response_code(200);
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-cache, no-transform');
        header('X-Accel-Buffering: no');

        $emit = static function (string $event, array $data): void {
            echo 'event: ' . $event . "\n";
            echo 'data: ' . json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n\n";
            flush();
        };

        try {
            $emit('snapshot', ['items' => self::liveItems($pdo, $barangayId)]);

            $newRows = $pdo->prepare(
                "SELECT gt.track_id, gt.user_id, u.full_name, gt.dispatch_id, gt.latitude, gt.longitude,
                        gt.accuracy_m, gt.recorded_at, gt.received_at
                 FROM gps_track gt
                 JOIN user u ON u.user_id = gt.user_id
                 WHERE gt.track_id > :last AND u.barangay_id = :barangay_id
                   AND u.role = 'tanod' AND u.is_active = 1
                 ORDER BY gt.track_id ASC
                 LIMIT 200"
            );
            $sessionStmt = $pdo->prepare(
                'SELECT s.revoked_at, s.expires_at, u.is_active, u.is_suspended
                 FROM auth_session s JOIN user u ON u.user_id = s.user_id
                 WHERE s.session_id = :sid LIMIT 1'
            );

            $started = $lastPing = $lastAuth = time();
            while (!connection_aborted()) {
                $newRows->execute(['last' => $lastTrackId, 'barangay_id' => $barangayId]);
                $rows = $newRows->fetchAll(PDO::FETCH_ASSOC);
                if ($rows !== []) {
                    $latest = [];
                    foreach ($rows as $row) {
                        $lastTrackId = max($lastTrackId, (int) $row['track_id']);
                        // Latest fix per Tanod by capture time (a queued older fix must not
                        // overwrite a newer one that arrived first).
                        $uid = (int) $row['user_id'];
                        if (!isset($latest[$uid]) || strcmp((string) $row['recorded_at'], (string) $latest[$uid]['recorded_at']) >= 0) {
                            $latest[$uid] = $row;
                        }
                    }
                    $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
                    $emit('position', ['items' => array_values(array_map(static fn (array $r): array => self::liveItem($r, $now), $latest))]);
                    $lastPing = time();
                }

                $t = time();
                if ($t - $lastAuth >= self::STREAM_AUTH_RECHECK_SECONDS) {
                    $sessionStmt->execute(['sid' => $identity['session_id']]);
                    $s = $sessionStmt->fetch(PDO::FETCH_ASSOC);
                    $valid = $s !== false && $s['revoked_at'] === null
                        && strtotime((string) $s['expires_at'] . ' UTC') > $t
                        && (int) $s['is_active'] === 1 && (int) $s['is_suspended'] === 0;
                    if (!$valid) {
                        $emit('auth_expired', []);
                        break;
                    }
                    $lastAuth = $t;
                }
                if ($t - $lastPing >= self::STREAM_PING_SECONDS) {
                    echo ": ping\n\n";
                    flush();
                    $lastPing = $t;
                }
                if ($t - $started >= self::STREAM_MAX_SECONDS) {
                    $emit('reconnect', []);
                    break;
                }
                usleep(self::STREAM_LOOK_MICROS);
            }
        } catch (\Throwable $e) {
            error_log('[baranguard] gps stream ended: ' . $e->getMessage());
        }
        exit;
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

        // Rate limit only on the direct real-time path, deliberately NOT
        // inside createItem(): that method is also the core of SyncController's
        // batch replay of offline-queued points (offline capture is durable
        // state), and a Tanod who was out of range for hours can legitimately
        // sync hundreds of backlogged points in one batch call. Limiting the
        // offline catch-up path would punish exactly the offline-first
        // behavior this app is built for.
        if (!RateLimiter::check($pdo, 'gps_post:user:' . $identity['user_id'], 300, 300)) {
            throw new ApiError(429, 'RATE_LIMITED', 'Too many GPS updates recently. Please wait before sending another.');
        }

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
        // Device signature is optional here: neither the direct POST /gps
        // path nor SyncController::batch() requires X-Device-Id for GPS. A
        // device with no header, or no registered Keystore key, is
        // unaffected; see DeviceSignature's own doc.
        $deviceId = Http::header('X-Device-Id');
        if (is_string($deviceId) && $deviceId !== '') {
            DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);
        }

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
        // Range checks alone let through a technically-valid-but-useless
        // reading: an absurd accuracy value, or a recorded_at from the future,
        // which can only mean the device's clock is wrong or the value was
        // tampered with. This guards the INPUT that is_stale/age_seconds are
        // computed from (staleness still measures position age, not network
        // delay). Deliberately NOT rejecting an old recorded_at: this app is
        // offline-first, and a Tanod's queued points syncing hours later is
        // expected, legitimate traffic, not a clock problem.
        if (!is_numeric($accuracyM) || (float) $accuracyM < 0 || (float) $accuracyM > self::MAX_PLAUSIBLE_ACCURACY_M) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'accuracy_m must be a non-negative number no greater than ' . self::MAX_PLAUSIBLE_ACCURACY_M . '.');
        }
        if (!is_string($recordedAtRaw) || strtotime($recordedAtRaw) === false) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'recorded_at must be a valid timestamp.');
        }
        $recordedAtTimestamp = (int) strtotime($recordedAtRaw);
        if ($recordedAtTimestamp > time() + self::MAX_FUTURE_SKEW_SECONDS) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'recorded_at cannot be in the future.');
        }
        $recordedAt = gmdate('Y-m-d H:i:s', $recordedAtTimestamp);

        $dispatchIdInt = null;
        if ($dispatchId !== null) {
            if (!is_int($dispatchId) && !(is_string($dispatchId) && ctype_digit($dispatchId))) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'dispatch_id must be an integer.');
            }
            $dispatchIdInt = (int) $dispatchId;
            // Only "active" would be strict, but a queued offline fix often
            // syncs after its dispatch completed/cancelled. Ownership + tenant
            // still must match; any status is accepted. Anything else is nulled
            // (never fails the ping, which would stall the sync batch).
            $dispatchStmt = $pdo->prepare(
                "SELECT d.dispatch_id
                 FROM dispatch d
                 JOIN incident i ON i.incident_id = d.incident_id
                 WHERE d.dispatch_id = :dispatch_id AND d.tanod_id = :tanod_id
                   AND i.barangay_id = :barangay_id
                 LIMIT 1"
            );
            $dispatchStmt->execute([
                'dispatch_id' => $dispatchIdInt,
                'tanod_id' => $identity['user_id'],
                'barangay_id' => $identity['barangay_id'],
            ]);
            if ($dispatchStmt->fetch(PDO::FETCH_ASSOC) === false) {
                $dispatchIdInt = null;
            }
        }

        // UNIQUE(user_id, client_event_id).
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
