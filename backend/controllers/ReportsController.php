<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /reports/summary — Master Reference §6 "Audit / reports" section,
 * §9 W2 Admin Dashboard screen spec, §7 role matrix ("View/generate
 * reports": Admin full, Punong Barangay read-only — both simply GET here,
 * there is no separate write path to restrict further).
 *
 * The reference fixes the response's top-level keys
 * ({total_incidents,resolved_count,avg_response_time_minutes,active_tanods,
 * by_incident_type,by_status,trend}) and states avg_response_time_minutes
 * is exactly incident.created_at -> dispatch.arrived_at for incidents that
 * reached arrived (§6) — but the "?..." after the endpoint is never
 * expanded, and by_incident_type/by_status/trend[]'s internal shapes are
 * only described in prose ("trend[] with a defined date bucket and
 * counts", §9). Resolved decisions, logged in DEVLOG.md:
 *
 *   - Query params: optional `date_from` / `date_to` (YYYY-MM-DD,
 *     inclusive, calendar days in Asia/Manila per §5's UI-display-uses-
 *     Asia/Manila rule). Default range when neither is given: trailing 30
 *     days (today back 29 days). Range capped at 366 days to keep trend[]
 *     bounded. date_from later than date_to, or either malformed, is 400
 *     VALIDATION_ERROR.
 *   - by_incident_type / by_status: objects keyed by every §5 enum member
 *     (incident_type / status respectively), value = count in range,
 *     always present at 0 rather than omitted — so the dashboard never has
 *     to assume which keys can appear.
 *   - trend[]: one entry per calendar day in the range, in order,
 *     {date:"YYYY-MM-DD", count:N} — count is incidents created that
 *     Asia/Manila day. Every day in the range is present even at count 0,
 *     so the chart never has to infer a gap in the series.
 *   - avg_response_time_minutes is null (not 0) when no incident in range
 *     reached `arrived` — a real zero-minute average and "no data" are
 *     different facts and must not collide on the same value.
 *   - active_tanods is a current-state count (same-barangay active tanods
 *     whose most recently recorded duty_status is on_duty/responding), not
 *     filtered by the date range — "active" is a snapshot, not a report
 *     metric over a period. Sprint 1 hasn't built duty-toggle yet (that's
 *     mobile M2, Sprint 2), so this is legitimately 0 until then — the
 *     dashboard's fresh-deployment empty state (§9) covers this case too.
 *
 * Day-boundary math is done in PHP against a fixed Asia/Manila = UTC+8
 * offset (the Philippines has no DST) rather than MariaDB's CONVERT_TZ(),
 * which depends on the mysql.time_zone_name tables being loaded — not
 * guaranteed on a stock XAMPP install. incident_created_at is fetched as
 * stored UTC and converted in PHP for trend bucketing instead.
 */
final class ReportsController
{
    private const INCIDENT_TYPES = [
        'theft', 'physical_injury', 'disturbance', 'domestic_dispute',
        'vandalism', 'traffic_incident', 'fire', 'medical_emergency',
        'missing_person', 'animal_complaint', 'other',
    ];
    private const INCIDENT_STATUSES = ['pending', 'dispatched', 'resolved'];
    private const MAX_RANGE_DAYS = 366;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function summary(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);
        $barangayId = $identity['barangay_id'];

        $manila = new \DateTimeZone('Asia/Manila');
        $utc = new \DateTimeZone('UTC');

        [$from, $to] = self::resolveDateRange(Http::query('date_from'), Http::query('date_to'), $manila);

        // Asia/Manila calendar-day bounds, converted to UTC for the SQL
        // comparison against created_at (stored UTC). Upper bound is
        // exclusive (start of the day after $to) so it's a plain half-open
        // range with no "23:59:59 vs 23:59:59.999" rounding question.
        $rangeStartUtc = $from->setTime(0, 0, 0)->setTimezone($utc);
        $rangeEndUtc = $to->setTime(0, 0, 0)->modify('+1 day')->setTimezone($utc);

        $stmt = $pdo->prepare(
            'SELECT incident_type, status, created_at
             FROM incident
             WHERE barangay_id = :barangay_id
               AND created_at >= :range_start AND created_at < :range_end'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStartUtc->format('Y-m-d H:i:s'),
            'range_end' => $rangeEndUtc->format('Y-m-d H:i:s'),
        ]);
        $incidents = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $byType = array_fill_keys(self::INCIDENT_TYPES, 0);
        $byStatus = array_fill_keys(self::INCIDENT_STATUSES, 0);

        $trendMap = [];
        $cursor = $from;
        while ($cursor <= $to) {
            $trendMap[$cursor->format('Y-m-d')] = 0;
            $cursor = $cursor->modify('+1 day');
        }

        $resolvedCount = 0;
        foreach ($incidents as $row) {
            if (isset($byType[$row['incident_type']])) {
                $byType[$row['incident_type']]++;
            }
            if (isset($byStatus[$row['status']])) {
                $byStatus[$row['status']]++;
            }
            if ($row['status'] === 'resolved') {
                $resolvedCount++;
            }

            $createdAtUtc = new \DateTimeImmutable($row['created_at'], $utc);
            $dayKey = $createdAtUtc->setTimezone($manila)->format('Y-m-d');
            if (isset($trendMap[$dayKey])) {
                $trendMap[$dayKey]++;
            }
        }

        $trend = [];
        foreach ($trendMap as $date => $count) {
            $trend[] = ['date' => $date, 'count' => $count];
        }

        $stmt = $pdo->prepare(
            'SELECT AVG(TIMESTAMPDIFF(MINUTE, i.created_at, d.arrived_at)) AS avg_minutes
             FROM incident i
             JOIN dispatch d ON d.incident_id = i.incident_id
             WHERE i.barangay_id = :barangay_id
               AND i.created_at >= :range_start AND i.created_at < :range_end
               AND d.arrived_at IS NOT NULL'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStartUtc->format('Y-m-d H:i:s'),
            'range_end' => $rangeEndUtc->format('Y-m-d H:i:s'),
        ]);
        $avgMinutesRaw = $stmt->fetchColumn();
        $avgResponseMinutes = $avgMinutesRaw !== null ? round((float) $avgMinutesRaw, 1) : null;

        $stmt = $pdo->prepare(
            "SELECT COUNT(DISTINCT ds.user_id) AS active_count
             FROM duty_status ds
             JOIN user u ON u.user_id = ds.user_id
             WHERE u.barangay_id = :barangay_id
               AND u.role = 'tanod' AND u.is_active = 1
               AND ds.status IN ('on_duty', 'responding')
               AND ds.changed_at = (
                   SELECT MAX(ds2.changed_at) FROM duty_status ds2 WHERE ds2.user_id = ds.user_id
               )"
        );
        $stmt->execute(['barangay_id' => $barangayId]);
        $activeTanods = (int) $stmt->fetchColumn();

        Http::send(200, [
            'total_incidents' => count($incidents),
            'resolved_count' => $resolvedCount,
            'avg_response_time_minutes' => $avgResponseMinutes,
            'active_tanods' => $activeTanods,
            'by_incident_type' => $byType,
            'by_status' => $byStatus,
            'trend' => $trend,
        ]);
    }

    /**
     * GET /reports/heatmap -- W5 Historical Heatmap. Section 6: "Admin/PB
     * own barangay -> {items:[{latitude,longitude,weight}]}; historical
     * coordinates only." Resolved decisions, logged in DEVLOG.md:
     *   - Reuses the exact same date_from/date_to query shape as
     *     GET /reports/summary (trailing-30-day default, 366-day cap) --
     *     Section 6 doesn't restate the param names for this endpoint, but
     *     nothing suggests a different convention, and reusing one date-
     *     range contract across both report endpoints avoids two subtly
     *     different date-handling rules in the same file.
     *   - "Historical coordinates only" is read as: source from
     *     incident.latitude/longitude (a point per incident with known
     *     coordinates in range), never gps_track -- that's live/near-live
     *     Tanod movement (W4's own data source), a different concept from
     *     a historical incident-density heatmap.
     *   - weight is always 1 per point rather than a pre-aggregated grid
     *     count: MapLibre's heatmap layer (like most GIS heatmap
     *     renderers) computes visual density itself from overlapping
     *     weighted points -- pre-binning into a grid isn't needed and
     *     Section 6 doesn't describe a grid/cell shape to bin into.
     *   - Incidents with NULL latitude/longitude are excluded (nothing to
     *     plot), not counted as zero-weight points.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function heatmap(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);
        $barangayId = $identity['barangay_id'];

        $manila = new \DateTimeZone('Asia/Manila');
        $utc = new \DateTimeZone('UTC');
        [$from, $to] = self::resolveDateRange(Http::query('date_from'), Http::query('date_to'), $manila);
        $rangeStartUtc = $from->setTime(0, 0, 0)->setTimezone($utc);
        $rangeEndUtc = $to->setTime(0, 0, 0)->modify('+1 day')->setTimezone($utc);

        $stmt = $pdo->prepare(
            'SELECT latitude, longitude
             FROM incident
             WHERE barangay_id = :barangay_id
               AND created_at >= :range_start AND created_at < :range_end
               AND latitude IS NOT NULL AND longitude IS NOT NULL'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStartUtc->format('Y-m-d H:i:s'),
            'range_end' => $rangeEndUtc->format('Y-m-d H:i:s'),
        ]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'latitude' => (float) $row['latitude'],
                'longitude' => (float) $row['longitude'],
                'weight' => 1,
            ];
        }, $rows);

        Http::send(200, ['items' => $items]);
    }

    /** @return array{0:\DateTimeImmutable,1:\DateTimeImmutable} */
    private static function resolveDateRange(?string $fromRaw, ?string $toRaw, \DateTimeZone $manila): array
    {
        $today = new \DateTimeImmutable('now', $manila);
        $to = $toRaw !== null ? self::parseDate($toRaw, $manila, 'date_to') : $today;
        $from = $fromRaw !== null ? self::parseDate($fromRaw, $manila, 'date_from') : $to->modify('-29 days');

        if ($from > $to) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'date_from must not be after date_to.');
        }
        if ($from->diff($to)->days > self::MAX_RANGE_DAYS) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'date_from/date_to range cannot exceed ' . self::MAX_RANGE_DAYS . ' days.');
        }

        return [$from, $to];
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
