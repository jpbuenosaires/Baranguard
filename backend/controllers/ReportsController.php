<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Lib\RateLimiter;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Pdf\SimplePdf;
use PDO;

/**
 * GET /reports/summary — Admin full, Punong Barangay read-only (both simply
 * GET; there is no write path to restrict further).
 *
 * Top-level keys: {total_incidents,resolved_count,avg_response_time_minutes,
 * active_tanods,by_incident_type,by_status,trend} plus the extras noted at
 * each computation below. avg_response_time_minutes is incident.created_at ->
 * dispatch.arrived_at for incidents that reached arrived.
 *
 *   - The response time takes the per-incident MIN(arrived_at) (the first
 *     responder to reach the scene), so every incident contributes exactly
 *     one data point even with several arrived dispatches. This applies to
 *     the summary scalar, the per-day response_time_trend[], and the export
 *     path's averageResponseTimeMinutes().
 *
 *   - Query params: optional `date_from` / `date_to` (YYYY-MM-DD,
 *     inclusive, calendar days in Asia/Manila). Default range when neither
 *     is given: trailing 30 days (today back 29 days). Range capped at 366
 *     days to keep trend[] bounded. date_from later than date_to, or either
 *     malformed, is 400 VALIDATION_ERROR.
 *   - by_incident_type / by_status: objects keyed by every enum member
 *     (incident_type / status respectively), value = count in range,
 *     always present at 0 rather than omitted, so the dashboard never has
 *     to assume which keys can appear.
 *   - trend[]: one entry per calendar day in the range, in order,
 *     {date:"YYYY-MM-DD", count:N}: count is incidents created that
 *     Asia/Manila day. Every day in the range is present even at count 0,
 *     so the chart never has to infer a gap in the series.
 *   - avg_response_time_minutes is null (not 0) when no incident in range
 *     reached `arrived`: a real zero-minute average and "no data" are
 *     different facts and must not collide on the same value.
 *   - active_tanods is a current-state count (same-barangay active tanods
 *     whose most recently recorded duty_status is on_duty/responding), not
 *     filtered by the date range: "active" is a snapshot, not a report
 *     metric over a period.
 *
 * Day-boundary math is done in PHP against a fixed Asia/Manila = UTC+8
 * offset (the Philippines has no DST) rather than MariaDB's CONVERT_TZ(),
 * which depends on the mysql.time_zone_name tables being loaded, not
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
    /**
     * Every incident status, including the four lifecycle states, so
     * by_status always adds up to total_incidents. Keys are always present
     * at 0.
     */
    private const INCIDENT_STATUSES = ['pending', 'dispatched', 'resolved', 'reopened', 'cancelled', 'invalid', 'duplicate'];
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
        // by_hour[]: incidents by Asia/Manila hour-of-day, 0-23, summed
        // across every day in the range: a real, single-barangay
        // time-of-day distribution (there is no cross-barangay comparison,
        // since the model has one tenant per caller).
        $byHour = array_fill(0, 24, 0);

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

            $createdAtManila = (new \DateTimeImmutable($row['created_at'], $utc))->setTimezone($manila);
            $dayKey = $createdAtManila->format('Y-m-d');
            if (isset($trendMap[$dayKey])) {
                $trendMap[$dayKey]++;
            }
            $byHour[(int) $createdAtManila->format('G')]++;
        }

        // Second trend series: incidents CLOSED OUT per day, for the
        // reported-vs-resolved line chart.
        //
        // Bucketed on dispatch.completed_at because that is the only
        // resolution moment this schema actually records: `incident` has
        // no resolved_at column, and `updated_at` moves on any write, so
        // neither can honestly answer "resolved on which day". An incident
        // closed by the Admin resolve action without a completed dispatch
        // therefore contributes to resolved_count (a state count) but not
        // to this per-day series (a timing series); the two answer
        // different questions and are not expected to reconcile.
        //
        // Counted per INCIDENT per day, not per completed dispatch, so a
        // multi-responder incident cannot push the "resolved" line above the
        // "reported" one. One incident counts at most once per Manila day.
        $resolvedMap = array_fill_keys(array_keys($trendMap), 0);
        $resolvedSeen = [];
        $stmt = $pdo->prepare(
            "SELECT d.incident_id, d.completed_at
               FROM dispatch d
               JOIN incident i ON i.incident_id = d.incident_id
              WHERE i.barangay_id = :barangay_id
                AND d.status = 'completed'
                AND d.completed_at IS NOT NULL
                AND d.completed_at >= :range_start AND d.completed_at < :range_end"
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStartUtc->format('Y-m-d H:i:s'),
            'range_end' => $rangeEndUtc->format('Y-m-d H:i:s'),
        ]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $completedUtc = new \DateTimeImmutable($row['completed_at'], $utc);
            $dayKey = $completedUtc->setTimezone($manila)->format('Y-m-d');
            $seenKey = $dayKey . '#' . (int) $row['incident_id'];
            if (isset($resolvedMap[$dayKey]) && !isset($resolvedSeen[$seenKey])) {
                $resolvedSeen[$seenKey] = true;
                $resolvedMap[$dayKey]++;
            }
        }

        // Response-time metric: incident.created_at -> FIRST dispatch
        // arrived_at, per incident (de-duplicated). The clock starts
        // when the incident reached the server: an incident captured
        // offline on a Tanod's phone gets created_at at SYNC time
        // (device_offline_created_at holds the capture time), so for those
        // the interval starts at sync; the UI footnotes this.
        $stmt = $pdo->prepare(
            'SELECT AVG(TIMESTAMPDIFF(MINUTE, i.created_at, d.first_arrived_at)) AS avg_minutes,
                    COUNT(*) AS sample_size
             FROM incident i
             JOIN (
                 SELECT incident_id, MIN(arrived_at) AS first_arrived_at
                 FROM dispatch
                 WHERE arrived_at IS NOT NULL
                 GROUP BY incident_id
             ) d ON d.incident_id = i.incident_id
             WHERE i.barangay_id = :barangay_id
               AND i.created_at >= :range_start AND i.created_at < :range_end'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStartUtc->format('Y-m-d H:i:s'),
            'range_end' => $rangeEndUtc->format('Y-m-d H:i:s'),
        ]);
        $avgRow = $stmt->fetch(PDO::FETCH_ASSOC) ?: ['avg_minutes' => null, 'sample_size' => 0];
        $avgMinutesRaw = $avgRow['avg_minutes'];
        $avgResponseMinutes = $avgMinutesRaw !== null ? round((float) $avgMinutesRaw, 1) : null;
        $responseSampleSize = (int) $avgRow['sample_size'];

        // response_time_trend[]: avg response minutes PER DAY, alongside
        // the single range-level scalar above. Bucketed the same way as
        // trend[]/trend[].resolved: on the incident's own created_at day,
        // only for incidents that actually reached `arrived` (the same
        // population avg_response_time_minutes restricts to). A day with no
        // arrivals has `null`, not 0, same reasoning as the range-level
        // scalar.
        $responseTimeMap = array_fill_keys(array_keys($trendMap), []);
        $stmt = $pdo->prepare(
            'SELECT i.created_at, TIMESTAMPDIFF(MINUTE, i.created_at, d.first_arrived_at) AS minutes
             FROM incident i
             JOIN (
                 SELECT incident_id, MIN(arrived_at) AS first_arrived_at
                 FROM dispatch
                 WHERE arrived_at IS NOT NULL
                 GROUP BY incident_id
             ) d ON d.incident_id = i.incident_id
             WHERE i.barangay_id = :barangay_id
               AND i.created_at >= :range_start AND i.created_at < :range_end'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStartUtc->format('Y-m-d H:i:s'),
            'range_end' => $rangeEndUtc->format('Y-m-d H:i:s'),
        ]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $createdAtUtcRow = new \DateTimeImmutable($row['created_at'], $utc);
            $dayKey = $createdAtUtcRow->setTimezone($manila)->format('Y-m-d');
            if (isset($responseTimeMap[$dayKey])) {
                $responseTimeMap[$dayKey][] = (float) $row['minutes'];
            }
        }
        $responseTimeTrend = [];
        foreach ($responseTimeMap as $date => $minutesList) {
            $responseTimeTrend[] = [
                'date' => $date,
                'avg_minutes' => $minutesList === [] ? null : round(array_sum($minutesList) / count($minutesList), 1),
                'sample_size' => count($minutesList),
            ];
        }

        $trend = [];
        foreach ($trendMap as $date => $count) {
            // `count` is incidents reported that day; `resolved` is
            // additive. `arrivals`: how many of that day's incidents had a
            // first Tanod arrival, i.e. the per-day sample size behind
            // response_time_trend; summing it equals response_sample_size.
            $trend[] = [
                'date' => $date,
                'count' => $count,
                'resolved' => $resolvedMap[$date],
                'arrivals' => count($responseTimeMap[$date] ?? []),
            ];
        }

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
            // Number of incidents behind avg_response_time_minutes (those
            // with at least one dispatch arrival). 0 with a null average
            // means "no data", never "zero minutes".
            'response_sample_size' => $responseSampleSize,
            'active_tanods' => $activeTanods,
            'by_incident_type' => $byType,
            'by_status' => $byStatus,
            'trend' => $trend,
            // See the comments at each computation above for what each one
            // means and why.
            'by_hour' => $byHour,
            'response_time_trend' => $responseTimeTrend,
        ]);
    }

    /**
     * GET /reports/heatmap -- Historical Heatmap. Admin/PB own barangay ->
     * {items:[{latitude,longitude,weight}]}; historical coordinates only.
     *   - Reuses the exact same date_from/date_to query shape as
     *     GET /reports/summary (trailing-30-day default, 366-day cap), so the
     *     two report endpoints share one date-range contract.
     *   - Points come from incident.latitude/longitude (one per incident with
     *     known coordinates in range), never gps_track, which is live Tanod
     *     movement, a different concept from a historical incident-density
     *     heatmap.
     *   - weight is always 1 per point rather than a pre-aggregated grid
     *     count: MapLibre's heatmap layer computes visual density itself from
     *     overlapping weighted points.
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
            'SELECT latitude, longitude, incident_type, priority, status
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
                'incident_type' => $row['incident_type'] ?? 'other',
                'priority' => $row['priority'] ?? 'medium',
                'status' => $row['status'] ?? 'pending',
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

    /**
     * GET /reports/nav-counts — the small, real count per relevant nav item
     * (Dispatch Center's pending queue, Swap Requests) for the sidebar badges,
     * as one small object instead of separate round-trips on every page load.
     *
     * Admin-only: every count feeds a nav item that is itself Admin-only
     * (`AppShell.js`'s `NAV_ITEMS`), so a non-Admin has no use for this.
     *
     * Tenant-scoped exactly like every other endpoint here: each count is
     * `WHERE barangay_id = :barangay_id`, never a cross-tenant total.
     */
    public static function navCounts(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        $barangayId = $identity['barangay_id'];

        $pendingIncidents = (int) self::countWhere($pdo, 'incident', "barangay_id = :b AND status IN ('pending', 'reopened')", ['b' => $barangayId]);
        // reopened counts: the Dispatch Center queue lists it with pending, so the badge must match.
        // shift_swap_request has no barangay_id of its own — scoped via the
        // shift it targets, same join every other swap-request query in
        // this codebase already uses.
        $pendingSwapRequests = (int) self::countWhere(
            $pdo,
            'shift_swap_request ssr JOIN shift_schedule sh ON sh.shift_id = ssr.shift_id',
            'sh.barangay_id = :b AND ssr.status = :s',
            ['b' => $barangayId, 's' => 'pending']
        );
        Http::send(200, [
            'pending_incidents' => $pendingIncidents,
            'pending_swap_requests' => $pendingSwapRequests,
        ]);
    }

    /**
     * GET /reports/export — Admin/PB own barangay → {file_url, format,
     * generated_at}; the request is scoped and audited. Export calls this
     * endpoint (Generate and Export are separate).
     *
     *   - CSV and PDF are the two supported formats. CSV is the
     *     dependency-free default; PDF reuses `SimplePdf`, a hand-rolled,
     *     dependency-free writer (one column, no images, no embedded fonts,
     *     not a general report/table renderer; see that class's own doc).
     *     Both formats render the exact same aggregates, so neither can
     *     drift from the other. An unsupported `format=` is a 400 naming
     *     what IS supported, never a silent fallback: a caller asking for
     *     XLSX and receiving CSV bytes is worse than an honest refusal.
     *
     *   - The file is written OUTSIDE the web root and served through an
     *     authorized download route, like map packages. An export contains
     *     a barangay's whole incident summary; a guessable path under the
     *     web root would make tenant scoping decorative. `file_url` is
     *     API-relative, like `download_url`.
     *
     *   - Content is exactly what `GET /reports/summary` returns for the same
     *     range: the same numbers the screen shows, not a second query that
     *     could disagree with it. No narrative, no coordinates, no personal
     *     data.
     *
     *   - The audit row is written on GENERATE, not on download, and records
     *     the range and format only (allow-list). The download route
     *     re-checks authorization independently rather than trusting that
     *     whoever holds the URL was the one who generated it.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function export(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

        // Exports are the expensive part (CSV/PDF generation), not the
        // download: this is the generation call, deliberately not
        // exportDownload() which just streams an already-built file.
        if (!RateLimiter::check($pdo, 'report_export:user:' . $identity['user_id'], 3600, 20)) {
            throw new ApiError(429, 'RATE_LIMITED', 'Too many report exports generated recently. Please wait before generating another.');
        }

        $format = Http::query('format') ?? 'csv';
        if (!in_array($format, ['csv', 'pdf'], true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "format must be 'csv' or 'pdf'.");
        }

        $manila = new \DateTimeZone('Asia/Manila');
        [$from, $to] = self::resolveDateRange(Http::query('date_from'), Http::query('date_to'), $manila);

        $content = $format === 'pdf'
            ? self::buildSummaryPdf($pdo, $identity, $from, $to, $manila)
            : self::buildSummaryCsv($pdo, $identity['barangay_id'], $from, $to, $manila);

        $path = self::exportPath($identity['barangay_id'], $format);
        $directory = dirname($path);
        if (!is_dir($directory) && !mkdir($directory, 0770, true) && !is_dir($directory)) {
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Export storage is not writable on this workstation.');
        }
        if (file_put_contents($path, $content) === false) {
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Could not write the export file.');
        }

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'report_exported', 'report', null, [
            'format' => $format,
            'date_from' => $from->format('Y-m-d'),
            'date_to' => $to->format('Y-m-d'),
        ]);

        Http::send(201, [
            'file_url' => '/reports/export/download',
            'format' => $format,
            'generated_at' => gmdate('Y-m-d\TH:i:s\Z'),
        ]);
    }

    /**
     * GET /reports/export/download — streams the caller's own barangay's
     * most recently generated export. The file must not sit in the web root,
     * so every download re-checks that the caller is logged in and belongs to
     * this barangay rather than trusting that the requestor just holds the
     * URL.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function exportDownload(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

        // `format` here only SELECTS WHICH already-generated file to
        // stream back (csv or pdf) — it never changes what gets read from
        // disk beyond that filename suffix, and the path is still derived
        // entirely from the CALLER's own barangay (never a parameter), so
        // cross-tenant access stays impossible by construction, not by
        // check.
        $format = Http::query('format') ?? 'csv';
        if (!in_array($format, ['csv', 'pdf'], true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "format must be 'csv' or 'pdf'.");
        }

        $path = self::exportPath($identity['barangay_id'], $format);
        if (!is_file($path)) {
            throw new ApiError(404, 'NOT_FOUND', 'No export has been generated for this barangay yet.');
        }

        // export() already audits 'report_exported' at generate time; the
        // actual download fetch is audited under a distinct action string.
        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'report_export_downloaded', 'report', null, [
            'format' => $format,
        ]);

        $contentType = $format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8';
        header('Content-Type: ' . $contentType);
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');
        header('Content-Length: ' . (string) filesize($path));
        header('Content-Disposition: attachment; filename="baranguard-report-barangay-' . $identity['barangay_id'] . '.' . $format . '"');
        readfile($path);
        exit;
    }

    /**
     * The periodic PB digest: CLI-only, the same "no HTTP surface for a
     * background job" discipline as `retention-job.php` (it runs unattended
     * on a schedule, not on a request). Called from
     * `scripts/generate-pb-digest.php`, never over HTTP.
     *
     * Reuses `buildSummaryPdf()` byte-for-byte: the digest is exactly the
     * same aggregate-only PDF a PB can generate by hand via
     * `GET /reports/export?format=pdf`, produced on a timer, and written to a
     * SEPARATE path (`digestPath()`, not `exportPath()`) so a scheduled digest
     * run can never clobber a manually generated export, or vice versa.
     * `identity['user_id'] = null` signals "unattended" to
     * `buildSummaryPdf()`'s generator-name block.
     *
     * Writes a small sidecar `.meta.json` (`generated_at`/`date_from`/
     * `date_to`) next to the PDF; `digestMeta()` below reads it rather than
     * trusting the PDF file's own mtime, which a filesystem restore/copy
     * could make misleading.
     */
    public static function generateDigest(PDO $pdo, int $barangayId, \DateTimeImmutable $from, \DateTimeImmutable $to): void
    {
        $manila = new \DateTimeZone('Asia/Manila');
        $identity = ['user_id' => null, 'barangay_id' => $barangayId, 'role' => 'system'];
        $content = self::buildSummaryPdf($pdo, $identity, $from, $to, $manila);

        $path = self::digestPath($barangayId);
        $directory = dirname($path);
        if (!is_dir($directory) && !mkdir($directory, 0770, true) && !is_dir($directory)) {
            throw new \RuntimeException("Digest storage is not writable: {$directory}");
        }
        if (file_put_contents($path, $content) === false) {
            throw new \RuntimeException("Could not write digest file: {$path}");
        }

        $meta = [
            'generated_at' => gmdate('Y-m-d\TH:i:s\Z'),
            'date_from' => $from->format('Y-m-d'),
            'date_to' => $to->format('Y-m-d'),
        ];
        file_put_contents(self::digestMetaPath($barangayId), json_encode($meta, JSON_PRETTY_PRINT));
    }

    /**
     * `GET /reports/digest` — Admin + Punong Barangay, same role list as
     * `export()`. Reports whether a periodic digest exists for the CALLER's
     * own barangay (never a parameter, same non-guessable-by-construction
     * pattern `exportDownload()` uses). `available: false` is a neutral,
     * honest answer for a fresh install where the scheduled job hasn't run
     * yet, not an error.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function digestMeta(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

        $metaPath = self::digestMetaPath((int) $identity['barangay_id']);
        if (!is_file(self::digestPath((int) $identity['barangay_id'])) || !is_file($metaPath)) {
            Http::send(200, ['available' => false]);
            return;
        }
        $meta = json_decode((string) file_get_contents($metaPath), true);
        if (!is_array($meta)) {
            Http::send(200, ['available' => false]);
            return;
        }
        Http::send(200, [
            'available' => true,
            'generated_at' => $meta['generated_at'] ?? null,
            'date_from' => $meta['date_from'] ?? null,
            'date_to' => $meta['date_to'] ?? null,
        ]);
    }

    /**
     * `GET /reports/digest/download` — streams the caller's own
     * barangay's latest periodic digest PDF. Same tenant-by-construction
     * and independent-recheck-on-download reasoning as
     * `exportDownload()`'s own doc block.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function digestDownload(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

        $path = self::digestPath((int) $identity['barangay_id']);
        if (!is_file($path)) {
            throw new ApiError(404, 'NOT_FOUND', 'No periodic digest has been generated for this barangay yet.');
        }

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'report_digest_downloaded', 'report', null, []);

        header('Content-Type: application/pdf');
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');
        header('Content-Length: ' . (string) filesize($path));
        header('Content-Disposition: attachment; filename="baranguard-pb-digest-barangay-' . $identity['barangay_id'] . '.pdf"');
        readfile($path);
        exit;
    }

    private static function digestPath(int $barangayId): string
    {
        $base = baranguard_env('REPORT_EXPORT_DIR');
        $directory = ($base !== false && trim((string) $base) !== '')
            ? rtrim((string) $base, '/\\')
            : dirname(__DIR__) . '/storage/report-exports';
        // A sibling directory to the interactive export files, not the
        // same one -- see generateDigest()'s own doc for why they must
        // never share a path.
        return $directory . '/digest/barangay-' . $barangayId . '.pdf';
    }

    private static function digestMetaPath(int $barangayId): string
    {
        return dirname(self::digestPath($barangayId)) . '/barangay-' . $barangayId . '.meta.json';
    }

    /**
     * Shared by buildSummaryCsv()/buildSummaryPdf() — one query, the same
     * counting rules `GET /reports/summary` uses (every enum member
     * present at 0, every calendar day in range present at 0), so neither
     * export format can silently drift from the other or from the screen.
     *
     * @return array{total:int, byDay:array<string,int>, byType:array<string,int>, byStatus:array<string,int>, byHour:array<int,int>}
     */
    private static function aggregateIncidents(
        PDO $pdo,
        int $barangayId,
        \DateTimeImmutable $from,
        \DateTimeImmutable $to,
        \DateTimeZone $manila
    ): array {
        $utc = new \DateTimeZone('UTC');
        $rangeStartUtc = $from->setTime(0, 0, 0)->setTimezone($utc)->format('Y-m-d H:i:s');
        $rangeEndUtc = $to->setTime(0, 0, 0)->modify('+1 day')->setTimezone($utc)->format('Y-m-d H:i:s');

        $stmt = $pdo->prepare(
            'SELECT incident_type, status, created_at FROM incident
             WHERE barangay_id = :barangay_id AND created_at >= :range_start AND created_at < :range_end'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStartUtc,
            'range_end' => $rangeEndUtc,
        ]);
        $incidents = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $byType = array_fill_keys(self::INCIDENT_TYPES, 0);
        $byStatus = array_fill_keys(self::INCIDENT_STATUSES, 0);
        $byDay = [];
        $cursor = $from;
        while ($cursor <= $to) {
            $byDay[$cursor->format('Y-m-d')] = 0;
            $cursor = $cursor->modify('+1 day');
        }
        $byHour = array_fill(0, 24, 0);
        foreach ($incidents as $row) {
            if (isset($byType[$row['incident_type']])) {
                $byType[$row['incident_type']]++;
            }
            if (isset($byStatus[$row['status']])) {
                $byStatus[$row['status']]++;
            }
            $dtManila = (new \DateTimeImmutable($row['created_at'], $utc))->setTimezone($manila);
            $day = $dtManila->format('Y-m-d');
            if (isset($byDay[$day])) {
                $byDay[$day]++;
            }
            $hour = (int) $dtManila->format('G');
            if (isset($byHour[$hour])) {
                $byHour[$hour]++;
            }
        }

        return ['total' => count($incidents), 'byDay' => $byDay, 'byType' => $byType, 'byStatus' => $byStatus, 'byHour' => $byHour];
    }

    /**
     * Same population and definition `GET /reports/summary`'s
     * `avg_response_time_minutes` uses: incidents in range whose dispatch
     * actually reached `arrived_at`. A fresh, independent query rather than a
     * call into summary() (that method writes its own HTTP response), but
     * intentionally the exact same SQL shape, so the export can never
     * disagree with the screen it's exporting.
     *
     * @return array{avg:?float, n:int} average minutes (null = no data) and
     *         the number of incidents it is based on.
     */
    private static function averageResponseTimeMinutes(
        PDO $pdo,
        int $barangayId,
        \DateTimeImmutable $from,
        \DateTimeImmutable $to,
        \DateTimeZone $manila
    ): array {
        $utc = new \DateTimeZone('UTC');
        $rangeStartUtc = $from->setTime(0, 0, 0)->setTimezone($utc)->format('Y-m-d H:i:s');
        $rangeEndUtc = $to->setTime(0, 0, 0)->modify('+1 day')->setTimezone($utc)->format('Y-m-d H:i:s');

        $stmt = $pdo->prepare(
            'SELECT AVG(TIMESTAMPDIFF(MINUTE, i.created_at, d.first_arrived_at)) AS avg_minutes,
                    COUNT(*) AS sample_size
             FROM incident i
             JOIN (
                 SELECT incident_id, MIN(arrived_at) AS first_arrived_at
                 FROM dispatch
                 WHERE arrived_at IS NOT NULL
                 GROUP BY incident_id
             ) d ON d.incident_id = i.incident_id
             WHERE i.barangay_id = :barangay_id
               AND i.created_at >= :range_start
               AND i.created_at < :range_end'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStartUtc,
            'range_end' => $rangeEndUtc,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: ['avg_minutes' => null, 'sample_size' => 0];
        return [
            'avg' => $row['avg_minutes'] !== null ? round((float) $row['avg_minutes'], 1) : null,
            'n' => (int) $row['sample_size'],
        ];
    }

    /**
     * Reuses summary()'s own aggregates so the file and the screen can
     * never disagree. Sections are stacked in one CSV with a blank line
     * between them — a single flat table cannot express four differently
     * shaped datasets, and splitting into four files would need a zip
     * dependency this project doesn't have.
     */
    private static function buildSummaryCsv(
        PDO $pdo,
        int $barangayId,
        \DateTimeImmutable $from,
        \DateTimeImmutable $to,
        \DateTimeZone $manila
    ): string {
        ['total' => $total, 'byDay' => $byDay, 'byType' => $byType, 'byStatus' => $byStatus]
            = self::aggregateIncidents($pdo, $barangayId, $from, $to, $manila);

        $escape = static function ($value): string {
            $text = $value === null ? '' : (string) $value;
            return preg_match('/[",\n]/', $text) === 1 ? '"' . str_replace('"', '""', $text) . '"' : $text;
        };
        $line = static fn(array $cells): string => implode(',', array_map($escape, $cells));

        $rows = [];
        $rows[] = $line(['Baranguard incident report']);
        $rows[] = $line(['Barangay ID', $barangayId]);
        $rows[] = $line(['Range (Asia/Manila)', $from->format('Y-m-d') . ' to ' . $to->format('Y-m-d')]);
        $rows[] = $line(['Generated (UTC)', gmdate('Y-m-d H:i:s')]);
        $rows[] = $line(['Total incidents', $total]);
        $rows[] = '';
        $rows[] = $line(['Incidents by day']);
        $rows[] = $line(['Date', 'Count']);
        foreach ($byDay as $date => $count) {
            $rows[] = $line([$date, $count]);
        }
        $rows[] = '';
        $rows[] = $line(['Incidents by type']);
        $rows[] = $line(['Type', 'Count']);
        foreach ($byType as $type => $count) {
            $rows[] = $line([$type, $count]);
        }
        $rows[] = '';
        $rows[] = $line(['Incidents by status']);
        $rows[] = $line(['Status', 'Count']);
        foreach ($byStatus as $status => $count) {
            $rows[] = $line([$status, $count]);
        }

        return implode("\r\n", $rows) . "\r\n";
    }

    /**
     * PDF sibling of buildSummaryCsv() — rendered as an executive Philippine
     * Barangay Statistical & Incident Summary Report via `SimplePdf`.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    private static function buildSummaryPdf(
        PDO $pdo,
        array $identity,
        \DateTimeImmutable $from,
        \DateTimeImmutable $to,
        \DateTimeZone $manila
    ): string {
        $barangayId = (int) $identity['barangay_id'];

        ['total' => $total, 'byDay' => $byDay, 'byType' => $byType, 'byStatus' => $byStatus, 'byHour' => $byHour]
            = self::aggregateIncidents($pdo, $barangayId, $from, $to, $manila);
        ['avg' => $avgResponseMinutes, 'n' => $responseSampleSize]
            = self::averageResponseTimeMinutes($pdo, $barangayId, $from, $to, $manila);

        // Fetch Barangay information (name, municipality, province)
        $brgyStmt = $pdo->prepare('SELECT name, municipality, province FROM barangay WHERE barangay_id = :bid LIMIT 1');
        $brgyStmt->execute([':bid' => $barangayId]);
        $brgy = $brgyStmt->fetch(PDO::FETCH_ASSOC) ?: [
            'name' => 'Barangay #' . $barangayId,
            'municipality' => 'Municipality',
            'province' => 'Province',
        ];
        $barangayName = (string) ($brgy['name'] ?? ('Barangay #' . $barangayId));
        $municipality = (string) ($brgy['municipality'] ?? 'Municipality');
        $province = (string) ($brgy['province'] ?? 'Province');

        // Who asked for this file (shown as "requested by", never as a
        // signer). A null user_id means the unattended weekly digest
        // (generateDigest()). The file says it is a system-generated, unsigned
        // summary and leaves the reviewer's signature, name and date blank for
        // a person to fill in on paper.
        if ($identity['user_id'] === null) {
            $requestedBy = 'the scheduled weekly digest job';
        } else {
            $genStmt = $pdo->prepare('SELECT full_name, role FROM user WHERE user_id = :uid LIMIT 1');
            $genStmt->execute([':uid' => $identity['user_id']]);
            $genRow = $genStmt->fetch(PDO::FETCH_ASSOC);
            $requestedBy = !empty($genRow['full_name'])
                ? (string) $genRow['full_name'] . ' (' . self::humanizeRole((string) ($genRow['role'] ?? $identity['role'])) . ')'
                : 'user #' . (int) $identity['user_id'];
        }

        // Tanod ACCOUNTS that are active right now: a snapshot at
        // generation time, not a figure for the coverage period, and
        // labelled that way below.
        $tanodStmt = $pdo->prepare(
            "SELECT COUNT(*) FROM user WHERE barangay_id = :bid AND role = 'tanod' AND is_active = 1"
        );
        $tanodStmt->execute([':bid' => $barangayId]);
        $activeTanods = (int) $tanodStmt->fetchColumn();

        // Calculate resolution rate
        $resolvedCount = (int) ($byStatus['resolved'] ?? 0);
        $resolutionRate = $total > 0 ? round(($resolvedCount / $total) * 100, 1) : 0.0;

        // Busiest Day
        $busiestDate = 'N/A';
        $busiestCount = 0;
        foreach ($byDay as $d => $c) {
            if ($c > $busiestCount) {
                $busiestCount = $c;
                $busiestDate = $d;
            }
        }

        // Top Incident Type
        $sortedTypes = $byType;
        arsort($sortedTypes);
        $topType = array_key_first($sortedTypes) ?? 'None';
        $topCount = reset($sortedTypes) ?: 0;
        $topShare = $total > 0 ? round(($topCount / $total) * 100, 1) : 0.0;

        // Peak Hour
        arsort($byHour);
        $peakHour = array_key_first($byHour) ?? 0;
        $peakHourCount = reset($byHour) ?: 0;
        $peakHourStr = $peakHourCount > 0
            ? sprintf('%02d:00 - %02d:00 (%d %s)', $peakHour, ($peakHour + 1) % 24, $peakHourCount, $peakHourCount === 1 ? 'incident' : 'incidents')
            : 'No incidents recorded';

        // Still-open incidents from this range (pending, dispatched or
        // reopened -- a reopened incident is active work again).
        $activeLoad = (int) ($byStatus['pending'] ?? 0)
            + (int) ($byStatus['dispatched'] ?? 0)
            + (int) ($byStatus['reopened'] ?? 0);

        $nowManila = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
            ->setTimezone($manila)
            ->format('d M Y, g:i A');
        $nowStamp = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
            ->setTimezone($manila)
            ->format('Ymd-Hi');
        $rangeShort = $from->format('M j, Y') . ' - ' . $to->format('M j, Y');

        $pdf = SimplePdf::create("Baranguard Statistical Report - Barangay {$barangayName}")
            // 1. Official Masthead matching .print-sheet__masthead
            ->center('REPUBLIC OF THE PHILIPPINES', 8.0, true, [0.28, 0.33, 0.41], 11.5)
            ->center('PROVINCE OF ' . strtoupper($province) . '  ·  MUNICIPALITY OF ' . strtoupper($municipality), 7.5, true, [0.35, 0.40, 0.48], 11.5)
            ->center('BARANGAY ' . strtoupper($barangayName) . ' — PEACEKEEPING & OPERATIONS DESK', 12.0, true, [0.118, 0.227, 0.431], 15.5)
            ->pillBadge('BARANGAY INCIDENT & PEACEKEEPING STATISTICAL REPORT', 7.5, 18.0)
            ->rule(1.5, [0.118, 0.227, 0.431], 12.0)

            // 2. 4-Column Meta Bar matching .print-sheet__meta-bar
            ->metaBar([
                [
                    'label' => 'Report Reference',
                    // Names the generation minute so two files can be told
                    // apart (a fixed number would look like a control number).
                    'value' => "BRGY-{$barangayId}-" . $nowStamp,
                ],
                [
                    'label' => 'Coverage Period',
                    'value' => $rangeShort,
                ],
                [
                    'label' => 'Prepared By',
                    'value' => 'System-generated (not signed)',
                ],
                [
                    'label' => 'Date Generated',
                    'value' => $nowManila,
                ],
            ], 42.0)

            // 3. 4-Column Executive KPI Grid matching .print-sheet__kpi-grid
            ->kpiGrid([
                [
                    'label' => 'Total Incidents',
                    'value' => (string) $total,
                    'sub' => 'Logged during coverage',
                ],
                [
                    'label' => 'Resolution Rate',
                    'value' => $resolutionRate . '%',
                    'sub' => "{$resolvedCount} of {$total} resolved",
                ],
                [
                    'label' => 'Avg Response Time',
                    'value' => $avgResponseMinutes !== null ? "{$avgResponseMinutes} min" : 'No data',
                    'sub' => "Reported to first arrival, n={$responseSampleSize}",
                ],
                [
                    'label' => 'Tanod Accounts',
                    'value' => (string) $activeTanods,
                    'sub' => 'Active at time of printing',
                ],
            ], 48.0)

            // 4. Operational Highlights in 2-Column Field Boxes matching .print-sheet__grid-2col
            ->twoColFields(
                [
                    'label' => 'Leading Incident Category',
                    'value' => self::humanizeEnum($topType) . " ({$topCount} cases, {$topShare}% of total)",
                ],
                [
                    'label' => 'Peak Reporting Hours',
                    'value' => $peakHourStr,
                ],
                42.0
            )
            ->twoColFields(
                [
                    'label' => 'Highest Activity Date',
                    'value' => $busiestCount > 0 ? "{$busiestDate} ({$busiestCount} cases logged)" : 'Evenly distributed / No incidents',
                ],
                [
                    'label' => 'Active Caseload Requiring Action',
                    'value' => "{$activeLoad} still open (Pending / Dispatched / Reopened)",
                ],
                44.0
            )

            // 5. Section 1: Classification of Incidents Table
            ->subheading('1. CLASSIFICATION OF REPORTED INCIDENTS', 9.5)
            ->tableHeader(['Incident Classification / Type', 'Recorded Cases', 'Percentage Share'], [0.56, 0.22, 0.22], ['left', 'right', 'right'], 8.2, 18.0);

        foreach ($byType as $type => $count) {
            $shareStr = $total > 0 ? sprintf('%.1f%%', ($count / $total) * 100) : '0.0%';
            $pdf->tableRow([self::humanizeEnum($type), (string) $count, $shareStr], [0.56, 0.22, 0.22], ['left', 'right', 'right']);
        }
        $pdf->tableRow(['TOTAL INCIDENTS RECORDED', (string) $total, '100.0%'], [0.56, 0.22, 0.22], ['left', 'right', 'right'], true, true)
            ->spacer(8.0)

            // 6. Section 2: Case Disposition & Status Breakdown Table
            ->subheading('2. CASE DISPOSITION & RESOLUTION BREAKDOWN', 9.5)
            ->tableHeader(['Case Disposition / Status', 'Case Count', 'Resolution Share'], [0.56, 0.22, 0.22], ['left', 'right', 'right'], 8.2, 18.0);

        foreach ($byStatus as $status => $count) {
            $statusShareStr = $total > 0 ? sprintf('%.1f%%', ($count / $total) * 100) : '0.0%';
            $pdf->tableRow([self::humanizeEnum($status), (string) $count, $statusShareStr], [0.56, 0.22, 0.22], ['left', 'right', 'right']);
        }
        $pdf->tableRow(['TOTAL CASES PROCESSED', (string) $total, '100.0%'], [0.56, 0.22, 0.22], ['left', 'right', 'right'], true, true)
            ->spacer(8.0)

            // 7. Section 3: Daily Activity Flow Table
            ->subheading('3. DAILY INCIDENT FLOW', 9.5)
            ->tableHeader(['Date (YYYY-MM-DD)', 'Day of Week', 'Daily Cases', 'Cumulative Cases'], [0.28, 0.28, 0.22, 0.22], ['left', 'left', 'right', 'right'], 8.2, 18.0);

        $cumCount = 0;
        $compactZeroRows = count($byDay) > 31 && $total > 0;
        $omittedZeroDays = 0;
        foreach ($byDay as $date => $count) {
            $cumCount += $count;
            if ($compactZeroRows && $count === 0) {
                $omittedZeroDays++;
                continue;
            }
            $dayOfWeek = (new \DateTimeImmutable($date))->format('l');
            $pdf->tableRow([$date, $dayOfWeek, (string) $count, (string) $cumCount], [0.28, 0.28, 0.22, 0.22], ['left', 'left', 'right', 'right']);
        }
        if ($omittedZeroDays > 0) {
            $pdf->tableRow(["({$omittedZeroDays} zero-incident days omitted)", '-', '0', (string) $cumCount], [0.28, 0.28, 0.22, 0.22], ['left', 'left', 'right', 'right']);
        }
        $pdf->tableRow(['PERIOD TOTAL', '-', (string) $total, (string) $total], [0.28, 0.28, 0.22, 0.22], ['left', 'left', 'right', 'right'], true, true)
            ->spacer(10.0)

            // 8. Notes + blank sign-off. No oath, no pre-filled signer: the
            // reviewer signs, prints their name and dates it on paper.
            ->calloutSection(
                'NOTES',
                'System-generated summary, not signed or attested. Compiled automatically from Baranguard records on '
                    . $nowManila . ' (Asia/Manila), requested by ' . $requestedBy . '. '
                    . 'This report contains aggregate operational figures only; no personal data. '
                    . 'Avg Response Time is measured from when an incident was recorded on the server to the first '
                    . "Tanod arrival, averaged over the {$responseSampleSize} incident(s) in this period that had an arrival; "
                    . 'an incident captured offline on a Tanod phone starts the clock when it synced. '
                    . 'It is an operational measure, not a rating of any Tanod.',
                8.5
            )
            ->spacer(8.0)
            ->centeredSignatures(
                'Prepared by: system-generated summary',
                '(not signed)',
                'Reviewed and approved by:',
                'Punong Barangay        Date: ____________',
                60.0
            );

        return $pdf->render();
    }

    /** Human-readable display label for user roles. */
    private static function humanizeRole(string $role): string
    {
        return match ($role) {
            'punong_barangay' => 'Punong Barangay',
            'admin' => 'Barangay Administrator / Desk Officer',
            'tanod' => 'Barangay Tanod Officer',
            default => ucfirst(str_replace('_', ' ', $role)),
        };
    }

    /** 'physical_injury' -> 'Physical injury' — for the PDF's human-readable labels only; the CSV keeps raw enum values. */
    private static function humanizeEnum(string $value): string
    {
        return ucfirst(str_replace('_', ' ', $value));
    }

    /**
     * One file per barangay, overwritten by each generate: an export is a
     * transient artifact regenerated on demand, not an archive. Keeping every
     * historical export would accumulate a barangay's whole report history
     * outside the retention job's reach, a shadow copy.
     */
    private static function exportPath(int $barangayId, string $format): string
    {
        $base = baranguard_env('REPORT_EXPORT_DIR');
        $directory = ($base !== false && trim((string) $base) !== '')
            ? rtrim((string) $base, '/\\')
            : dirname(__DIR__) . '/storage/report-exports';

        // One file per barangay PER FORMAT: csv and pdf are independent
        // artifacts (a Punong Barangay generating a PDF must not clobber an
        // Admin's just-generated CSV, or vice versa), each overwritten by each
        // generate, not an archive.
        return $directory . '/barangay-' . $barangayId . '.' . $format;
    }

    /** @param array<string,mixed> $params */
    private static function countWhere(PDO $pdo, string $from, string $where, array $params): int
    {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM {$from} WHERE {$where}");
        $stmt->execute($params);
        return (int) $stmt->fetchColumn();
    }

    /**
     * GET /reports/school-term?term_start=&term_end= -- Safer School Zones
     * Annex D, computed LIVE from current data and not persisted. Admin,
     * Secretary and Punong Barangay, own barangay only. Returns the same
     * count fields a saved `ssz_term_report` snapshot carries, plus the
     * requested range. The computation itself (and its day-bucketing at a
     * fixed +08:00) lives in `SszTermReportsController::compute()`; counts
     * only, no person/narrative/coordinate data.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function schoolTerm(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);

        $termStart = Http::query('term_start');
        $termEnd = Http::query('term_end');
        if ($termStart === null || $termEnd === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'term_start and term_end (YYYY-MM-DD) are required.');
        }
        $computed = SszTermReportsController::compute($pdo, $identity['barangay_id'], $termStart, $termEnd);

        Http::send(200, ['term_start' => $termStart, 'term_end' => $termEnd] + $computed);
    }
}
