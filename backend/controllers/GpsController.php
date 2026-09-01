<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GPS — Master Reference §6 "GPS" section (`GET /gps/live`,
 * `GET /gps/history` only; `POST /gps` is Tanod-only mobile-broadcast
 * scope, Sprint 3, not built here), §5 `gps_track` table, §9 W4 GIS Live
 * Tracking.
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
 *     absent from `items` (there is no "position" to show), which is the
 *     correct/expected state until Sprint 3's mobile GPS broadcast
 *     exists — this will legitimately return an empty list against real
 *     data today.
 *   - `age_seconds`/`is_stale` are computed against `recorded_at` (the
 *     device's own capture time), not `received_at` — staleness is about
 *     how old the *position* is, not network/queue delay.
 *   - `GET /gps/history`'s date range reuses the same 366-day cap
 *     `ReportsController` already established for date-range endpoints,
 *     for consistency rather than inventing a different number.
 */
final class GpsController
{
    private const MAX_RANGE_DAYS = 366;
    private const STALE_AFTER_SECONDS = 120;
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

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
