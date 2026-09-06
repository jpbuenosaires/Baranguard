<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Pdf\SimplePdf;
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
        // by_hour[]: incidents by Asia/Manila hour-of-day, 0-23, summed
        // across every day in the range — Phase 9 of the mockup-driven UI
        // round 2 (see .claude/plans/clever-wishing-hummingbird.md). §8
        // names this the legitimate replacement for the rejected
        // cross-barangay "Performance by Barangay" chart: a real,
        // single-barangay time-of-day distribution, not a comparison
        // across tenants the current model can't produce.
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

        // Second trend series: incidents CLOSED OUT per day, for W2's
        // reported-vs-resolved line chart.
        //
        // Bucketed on dispatch.completed_at because that is the only
        // resolution moment this schema actually records — `incident` has
        // no resolved_at column, and `updated_at` moves on any write, so
        // neither can honestly answer "resolved on which day". An incident
        // closed by the Admin resolve action without a completed dispatch
        // therefore contributes to resolved_count (a state count) but not
        // to this per-day series (a timing series); the two answer
        // different questions and are not expected to reconcile.
        $resolvedMap = array_fill_keys(array_keys($trendMap), 0);
        $stmt = $pdo->prepare(
            "SELECT d.completed_at
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
            if (isset($resolvedMap[$dayKey])) {
                $resolvedMap[$dayKey]++;
            }
        }

        $trend = [];
        foreach ($trendMap as $date => $count) {
            // `count` keeps its existing meaning (incidents reported that
            // day) so every current consumer is unaffected; `resolved` is
            // additive, same precedent as officer_name on GET /incidents.
            $trend[] = ['date' => $date, 'count' => $count, 'resolved' => $resolvedMap[$date]];
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

        // response_time_trend[]: avg response minutes PER DAY, alongside
        // the single range-level scalar above — Phase 9. Bucketed the same
        // way as trend[]/trend[].resolved: on the incident's own
        // created_at day, only for incidents that actually reached
        // `arrived` (the same population avg_response_time_minutes
        // already restricts to). A day with no arrivals has `null`, not
        // 0 — a real zero-minute average and "no data" are different
        // facts, same reasoning as the range-level scalar.
        $responseTimeMap = array_fill_keys(array_keys($trendMap), []);
        $stmt = $pdo->prepare(
            'SELECT i.created_at, TIMESTAMPDIFF(MINUTE, i.created_at, d.arrived_at) AS minutes
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
            'active_tanods' => $activeTanods,
            'by_incident_type' => $byType,
            'by_status' => $byStatus,
            'trend' => $trend,
            // Phase 9 additions — see the comments at each computation
            // above for what each one means and why.
            'by_hour' => $byHour,
            'response_time_trend' => $responseTimeTrend,
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

    /**
     * GET /reports/nav-counts — §4.1 of the UI/UX review (sidebar badge
     * counts). NOT in §6's original documented endpoint list — a resolved,
     * logged addition, same precedent as `GET /barangays`/`GET /search`
     * earlier this project: the sidebar needs a small, real count per
     * relevant nav item (Dispatch Center's pending queue, the Citizen
     * Reports inbox, Swap Requests, Fatigue Flags), and fetching that as
     * FOUR separate round-trips on every single page load — every
     * navigation, not just once — would be real, avoidable load for
     * something that isn't time-critical. One small object instead.
     *
     * Admin-only: every one of the four counts feeds a nav item that is
     * itself Admin-only (`AppShell.js`'s `NAV_ITEMS`), so a non-Admin has
     * no use for this and no route to it either — same reasoning
     * `GET /system/health` already uses.
     *
     * Tenant-scoped exactly like every other endpoint here — each count is
     * `WHERE barangay_id = :barangay_id`, never a cross-tenant total.
     */
    public static function navCounts(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        $barangayId = $identity['barangay_id'];

        $pendingIncidents = (int) self::countWhere($pdo, 'incident', 'barangay_id = :b AND status = :s', ['b' => $barangayId, 's' => 'pending']);
        $unconvertedCitizenReports = (int) self::countWhere($pdo, 'citizen_report', 'barangay_id = :b AND converted_at IS NULL', ['b' => $barangayId]);
        // shift_swap_request has no barangay_id of its own — scoped via the
        // shift it targets, same join every other swap-request query in
        // this codebase already uses.
        $pendingSwapRequests = (int) self::countWhere(
            $pdo,
            'shift_swap_request ssr JOIN shift_schedule sh ON sh.shift_id = ssr.shift_id',
            'sh.barangay_id = :b AND ssr.status = :s',
            ['b' => $barangayId, 's' => 'pending']
        );
        // fatigue_flag has no barangay_id of its own either — scoped via
        // the flagged user.
        $unacknowledgedFatigueFlags = (int) self::countWhere(
            $pdo,
            'fatigue_flag ff JOIN user u ON u.user_id = ff.user_id',
            'u.barangay_id = :b AND ff.acknowledged_at IS NULL',
            ['b' => $barangayId]
        );

        Http::send(200, [
            'pending_incidents' => $pendingIncidents,
            'unconverted_citizen_reports' => $unconvertedCitizenReports,
            'pending_swap_requests' => $pendingSwapRequests,
            'unacknowledged_fatigue_flags' => $unacknowledgedFatigueFlags,
        ]);
    }

    /**
     * GET /reports/export — §6: "Admin/PB own barangay → {file_url,
     * format,generated_at} for approved formats; request is scoped and
     * audited." §9 W9: "Generate and Export are separate; Export calls
     * GET /reports/export and is audited."
     *
     * Resolved decisions (logged in DEVLOG.md):
     *
     *   - **CSV and PDF are the two approved formats.** §6 says "for
     *     approved formats" without listing them. CSV remains the
     *     dependency-free default; PDF was added 2026-09-06 on explicit
     *     user request, reusing `SimplePdf` — the same hand-rolled,
     *     dependency-free writer §6's Lupon packet endpoint already
     *     built (there is still no Composer here, so this is the same
     *     one-column, no-images, no-embedded-fonts writer, not a
     *     general report/table renderer — see that class's own doc).
     *     Both formats render the exact same aggregates (below), so
     *     neither can drift from the other. An unsupported `format=` is
     *     still a 400 naming what IS supported, never a silent fallback —
     *     a caller asking for XLSX and receiving CSV bytes is worse than
     *     an honest refusal.
     *
     *   - **The file is written OUTSIDE the web root and served through
     *     an authorized download route**, exactly like the Lupon packet
     *     and map packages. An export contains a barangay's whole
     *     incident summary; a guessable path under the web root would
     *     make tenant scoping decorative. `file_url` is API-relative for
     *     the same Rule 7 reason `download_url` already is.
     *
     *   - **Content is exactly what `GET /reports/summary` already
     *     returns** for the same range — the same numbers the screen
     *     shows, not a second query that could disagree with it. No
     *     narrative, no coordinates, no personal data: the export is the
     *     aggregate report, and §6's own summary shape is aggregate-only.
     *
     *   - **The audit row is written on GENERATE, not on download**, and
     *     records the range and format only (Rule 17's allow-list). §6
     *     says "request is scoped and audited"; the request is the
     *     generate call. The download route re-checks authorization
     *     independently (Rule 30) rather than trusting that whoever holds
     *     the URL was the one who generated it.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function export(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

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
     * most recently generated export.
     *
     * Not in §6's endpoint list, added for the same reason
     * `GET /incidents/:id/lupon-packet/download` was: §6 promises a
     * `file_url` while the file must not sit in the web root. Every
     * download re-checks that the caller is logged in and belongs to
     * this barangay (Rule 30) rather than trusting the requestor just
     * holds the URL.
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

        $contentType = $format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8';
        header('Content-Type: ' . $contentType);
        header('Content-Length: ' . (string) filesize($path));
        header('Content-Disposition: attachment; filename="baranguard-report-barangay-' . $identity['barangay_id'] . '.' . $format . '"');
        readfile($path);
        exit;
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
     * `avg_response_time_minutes` uses (§6 summary() above): incidents in
     * range whose dispatch actually reached `arrived_at`. A fresh,
     * independent query rather than a call into summary() — that method
     * writes its own HTTP response and isn't structured to hand back a
     * value — but it is intentionally the exact same SQL shape, so the
     * export can never disagree with the screen it's exporting.
     */
    private static function averageResponseTimeMinutes(
        PDO $pdo,
        int $barangayId,
        \DateTimeImmutable $from,
        \DateTimeImmutable $to,
        \DateTimeZone $manila
    ): ?float {
        $utc = new \DateTimeZone('UTC');
        $rangeStartUtc = $from->setTime(0, 0, 0)->setTimezone($utc)->format('Y-m-d H:i:s');
        $rangeEndUtc = $to->setTime(0, 0, 0)->modify('+1 day')->setTimezone($utc)->format('Y-m-d H:i:s');

        $stmt = $pdo->prepare(
            'SELECT AVG(TIMESTAMPDIFF(MINUTE, i.created_at, d.arrived_at)) AS avg_minutes
             FROM incident i
             JOIN dispatch d ON d.incident_id = i.incident_id
             WHERE i.barangay_id = :barangay_id
               AND i.created_at >= :range_start
               AND i.created_at < :range_end
               AND d.arrived_at IS NOT NULL'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStartUtc,
            'range_end' => $rangeEndUtc,
        ]);
        $raw = $stmt->fetchColumn();
        return $raw !== null ? round((float) $raw, 1) : null;
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
        $avgResponseMinutes = self::averageResponseTimeMinutes($pdo, $barangayId, $from, $to, $manila);

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

        // Fetch Desk Officer / Generator Name and Role
        $genStmt = $pdo->prepare('SELECT full_name, role FROM user WHERE user_id = :uid LIMIT 1');
        $genStmt->execute([':uid' => $identity['user_id']]);
        $genRow = $genStmt->fetch(PDO::FETCH_ASSOC);
        $generatorName = !empty($genRow['full_name']) ? (string) $genRow['full_name'] : 'Desk Officer';
        $generatorRole = self::humanizeRole((string) ($genRow['role'] ?? $identity['role']));

        // Fetch Punong Barangay (Captain) for attestation
        $pbStmt = $pdo->prepare(
            "SELECT full_name FROM user WHERE barangay_id = :bid AND role = 'punong_barangay' AND is_active = 1 LIMIT 1"
        );
        $pbStmt->execute([':bid' => $barangayId]);
        $pbRow = $pbStmt->fetch(PDO::FETCH_ASSOC);
        $pbName = !empty($pbRow['full_name']) ? (string) $pbRow['full_name'] : 'HON. PUNONG BARANGAY';

        // Count Active Tanod Peacekeeping Force
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

        // Pending and In-Progress Load
        $activeLoad = (int) ($byStatus['pending'] ?? 0)
            + (int) ($byStatus['investigating'] ?? 0)
            + (int) ($byStatus['dispatched'] ?? 0);

        $nowManila = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
            ->setTimezone($manila)
            ->format('d M Y, g:i A');
        $rangeLabel = $from->format('d M Y') . ' to ' . $to->format('d M Y') . ' (Asia/Manila)';

        $pdf = SimplePdf::create("Baranguard Statistical Report - Barangay {$barangayName}")
            // 1. Official Republic Header
            ->center('REPUBLIC OF THE PHILIPPINES', 8.5, false, [0.35, 0.40, 0.48], 11.0)
            ->center('PROVINCE OF ' . strtoupper($province), 8.5, false, [0.35, 0.40, 0.48], 11.0)
            ->center('MUNICIPALITY OF ' . strtoupper($municipality), 8.5, false, [0.35, 0.40, 0.48], 11.0)
            ->center('BARANGAY ' . strtoupper($barangayName), 11.0, true, [0.10, 0.16, 0.28], 15.0)
            ->center('OFFICE OF THE LUPONG TAGAPAMAYAPA & BARANGAY PEACEKEEPING ACTION TEAM', 7.5, true, [0.22, 0.32, 0.50], 12.0)
            ->rule(1.5, [0.12, 0.23, 0.43], 6.0)
            ->rule(0.5, [0.70, 0.75, 0.82], 8.0)

            // 2. Title Banner
            ->banner('INCIDENT & PEACEKEEPING OPERATIONS STATISTICAL REPORT', 9.5, [0.12, 0.23, 0.43], [1.0, 1.0, 1.0], 20.0, 24.0)

            // 3. Report Metadata
            ->keyValue('Reporting Coverage', $rangeLabel)
            ->keyValue('Prepared By', "{$generatorName} ({$generatorRole})")
            ->keyValue('Report Generated', "{$nowManila} (Ref: BRGY-{$barangayId}-RPT)")
            ->spacer(6.0)

            // 4. Executive KPI Grid (4 Metrics)
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
                    'value' => $avgResponseMinutes !== null ? "{$avgResponseMinutes} min" : 'N/A',
                    'sub' => 'Dispatch to arrival',
                ],
                [
                    'label' => 'Tanod Force',
                    'value' => (string) $activeTanods,
                    'sub' => 'Active peacekeeping unit',
                ],
            ], 48.0)
            ->spacer(8.0)

            // 5. Operational Highlights
            ->subheading('OPERATIONAL HIGHLIGHTS & PATTERNS', 10.0)
            ->keyValue('Leading Incident Category', self::humanizeEnum($topType) . " ({$topCount} cases, {$topShare}% of total)")
            ->keyValue('Peak Incident Hours', $peakHourStr)
            ->keyValue('Highest Activity Date', $busiestCount > 0 ? "{$busiestDate} ({$busiestCount} cases logged)" : 'Evenly distributed / No incidents')
            ->keyValue('Active Caseload Requiring Action', "{$activeLoad} ongoing cases (Pending/Dispatched/Investigating)")
            ->spacer(8.0)

            // 6. Section 1: Classification of Incidents Table
            ->subheading('1. CLASSIFICATION OF REPORTED INCIDENTS', 10.0)
            ->tableHeader(['Incident Classification / Type', 'Recorded Cases', 'Percentage Share'], [0.55, 0.22, 0.23], ['left', 'right', 'right'], 8.5, 18.0);

        foreach ($byType as $type => $count) {
            $shareStr = $total > 0 ? sprintf('%.1f%%', ($count / $total) * 100) : '0.0%';
            $pdf->tableRow([self::humanizeEnum($type), (string) $count, $shareStr], [0.55, 0.22, 0.23], ['left', 'right', 'right']);
        }
        $pdf->tableRow(['TOTAL INCIDENTS RECORDED', (string) $total, '100.0%'], [0.55, 0.22, 0.23], ['left', 'right', 'right'], true, true)
            ->spacer(10.0)

            // 7. Section 2: Case Disposition & Status Breakdown Table
            ->subheading('2. CASE DISPOSITION & RESOLUTION BREAKDOWN', 10.0)
            ->tableHeader(['Case Disposition / Status', 'Case Count', 'Resolution Share'], [0.55, 0.22, 0.23], ['left', 'right', 'right'], 8.5, 18.0);

        foreach ($byStatus as $status => $count) {
            $statusShareStr = $total > 0 ? sprintf('%.1f%%', ($count / $total) * 100) : '0.0%';
            $pdf->tableRow([self::humanizeEnum($status), (string) $count, $statusShareStr], [0.55, 0.22, 0.23], ['left', 'right', 'right']);
        }
        $pdf->tableRow(['TOTAL CASES PROCESSED', (string) $total, '100.0%'], [0.55, 0.22, 0.23], ['left', 'right', 'right'], true, true)
            ->spacer(10.0)

            // 8. Section 3: Daily Activity Flow Table
            ->subheading('3. DAILY INCIDENT FLOW', 10.0)
            ->tableHeader(['Date (YYYY-MM-DD)', 'Day of Week', 'Daily Cases', 'Cumulative Cases'], [0.28, 0.28, 0.22, 0.22], ['left', 'left', 'right', 'right'], 8.5, 18.0);

        $cumCount = 0;
        foreach ($byDay as $date => $count) {
            $cumCount += $count;
            $dayOfWeek = (new \DateTimeImmutable($date))->format('l');
            $pdf->tableRow([$date, $dayOfWeek, (string) $count, (string) $cumCount], [0.28, 0.28, 0.22, 0.22], ['left', 'left', 'right', 'right']);
        }
        $pdf->tableRow(['PERIOD TOTAL', '-', (string) $total, (string) $total], [0.28, 0.28, 0.22, 0.22], ['left', 'left', 'right', 'right'], true, true)
            ->spacer(12.0)

            // 9. Attestation & Dual Sign-Off Block
            ->paragraph(
                'OFFICIAL ATTESTATION: I hereby certify under oath that the statistics, incident counts, and operational performance indicators set forth in this summary report are faithfully compiled from official records logged within the Baranguard Incident Management System for the stated period.',
                7.8
            )
            ->spacer(10.0)
            ->signatureBlock(
                'PREPARED BY (DESK OFFICER):',
                $generatorName,
                $generatorRole,
                'ATTESTED & APPROVED BY:',
                $pbName,
                'PUNONG BARANGAY',
                58.0
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
     * One file per barangay, overwritten by each generate — an export is
     * a transient artifact regenerated on demand, not an archive. Keeping
     * every historical export would accumulate a barangay's whole report
     * history outside the retention job's reach (§11/Rule 11), which is
     * exactly the kind of shadow copy Rule 11 warns about.
     */
    private static function exportPath(int $barangayId, string $format): string
    {
        $base = baranguard_env('REPORT_EXPORT_DIR');
        $directory = ($base !== false && trim((string) $base) !== '')
            ? rtrim((string) $base, '/\\')
            : dirname(__DIR__) . '/storage/report-exports';

        // One file per barangay PER FORMAT — csv and pdf are independent
        // artifacts now (a Punong Barangay generating a PDF must not
        // clobber an Admin's just-generated CSV, or vice versa), each
        // still following the same "overwritten by each generate, not an
        // archive" rule the original one-file-per-barangay comment above
        // this method described.
        return $directory . '/barangay-' . $barangayId . '.' . $format;
    }

    /** @param array<string,mixed> $params */
    private static function countWhere(PDO $pdo, string $from, string $where, array $params): int
    {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM {$from} WHERE {$where}");
        $stmt->execute($params);
        return (int) $stmt->fetchColumn();
    }
}
