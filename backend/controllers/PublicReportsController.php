<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use PDO;

/**
 * PublicReportsController — the one unauthenticated READ surface in the
 * system: an aggregate transparency report a barangay can publish.
 *
 * WHY THIS EXISTS: the original problem statement is that barangay watch
 * operations leave no shared, structured record. A record that only the
 * barangay hall can see solves half of that. This endpoint is the other
 * half — residents can see how much is being reported and how much is
 * being resolved, without anyone having to trust a figure read out at a
 * meeting.
 *
 * =====================================================================
 * EVERY DESIGN DECISION HERE IS A PRIVACY DECISION. Read before editing.
 * =====================================================================
 *
 * This is UNAUTHENTICATED. There is no session, no role, no tenant
 * scoping to fall back on — the response itself is the entire security
 * boundary. `POST /citizen-reports` is the only other public route and
 * it only WRITES; this is the only thing that reads out.
 *
 *   1. **Counts only, never rows.** No incident ids, no `display_id`, no
 *      narratives (redacted or otherwise), no names, no contact numbers,
 *      no coordinates, no `location_description`. Nothing that could be
 *      joined back to a case.
 *
 *   2. **No location breakdown at all.** Not even by purok. Baranguard's
 *      barangays are ~2,500 people; "1 domestic dispute in Purok 3"
 *      identifies a household to anyone living there. The heatmap exists
 *      for authorised oversight and stays behind a login.
 *
 *   3. **Monthly buckets, never daily.** A daily count in a community
 *      this size, cross-referenced with what a neighbour saw, is close
 *      to an identifier. Months are coarse enough to be safe and still
 *      show a trend.
 *
 *   4. **SMALL COUNTS ARE SUPPRESSED** (`MIN_BUCKET`). A category with
 *      one or two cases is not a statistic, it is a case. Categories
 *      under the floor are MERGED into a single combined bucket rather
 *      than dropped — dropping them silently would make the parts stop
 *      summing to the total, which both misleads the reader and, by
 *      subtraction, leaks exactly the number being hidden.
 *
 *   5. **No response-time figure.** It would be the obvious thing to
 *      publish and it is deliberately absent: `avg_response_time_minutes`
 *      double-counts incidents with more than one arrived dispatch
 *      (`docs/REMAINING.md` F8, still open). Publishing a known-wrong
 *      number to the public is worse than publishing none, and §2 Rule 6
 *      forbids presenting a figure as measured when it isn't. Add it
 *      when F8 is fixed, not before.
 *
 * NOT RATE-LIMITED, STATED PLAINLY RATHER THAN FAKED. The obvious move
 * was to copy `CitizenReportsController::submit()`'s limiter, but that
 * one works by counting the `audit_log` rows its own writes produce, and
 * this endpoint deliberately writes none — one audit row per anonymous
 * page view would flood a table on a 7-year retention clock (§11) with
 * public traffic. An APCu counter was written and then removed: APCu is
 * not loaded on this XAMPP build, so it was a control that looked
 * functional and did nothing, which is precisely what §2 Rule 6 forbids.
 *
 * What actually protects it today is network placement — §2 Rule 7 keeps
 * the API on the LAN, so this is not internet-reachable in a correct
 * deployment. The cost of an unthrottled call is also bounded and
 * read-only: three aggregates over one indexed column, no writes, no
 * per-row work. **If this system is ever deliberately exposed to the
 * public internet, a real limiter becomes a prerequisite and needs its
 * own store** (a small counter table, or APCu/Redis once one exists) —
 * that is a deployment decision, tracked with F1, not something to
 * pretend is already handled.
 */
final class PublicReportsController
{
    /**
     * Smallest count that may be reported for a single category on its
     * own. Below this, categories are pooled.
     *
     * 5 is the conventional small-cell floor for published statistics.
     * It is a PRIVACY control, not a display preference, which is why it
     * is a constant here rather than a query parameter — letting a caller
     * lower it would defeat the entire point of having it.
     */
    private const MIN_BUCKET = 5;

    /** How far back the report covers. Fixed, not caller-supplied: an
     *  arbitrary window lets a caller narrow the period until a bucket
     *  isolates a single case. */
    private const MONTHS = 6;

    private const TYPE_LABELS = [
        'theft' => 'Theft / Robbery',
        'physical_injury' => 'Physical Injury',
        'disturbance' => 'Disturbance',
        'domestic_dispute' => 'Domestic Dispute',
        'vandalism' => 'Vandalism',
        'traffic_incident' => 'Traffic Incident',
        'fire' => 'Fire',
        'medical_emergency' => 'Medical Emergency',
        'missing_person' => 'Missing Person',
        'animal_complaint' => 'Animal Complaint',
        'other' => 'Other',
    ];

    /** `GET /public/transparency?barangay_id=N` — no authentication. */
    public static function transparency(PDO $pdo): void
    {
        $barangayIdRaw = Http::query('barangay_id');
        if ($barangayIdRaw === null || !ctype_digit((string) $barangayIdRaw)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id is required.');
        }
        $barangayId = (int) $barangayIdRaw;

        $nameStmt = $pdo->prepare('SELECT name FROM barangay WHERE barangay_id = :id LIMIT 1');
        $nameStmt->execute(['id' => $barangayId]);
        $barangayName = $nameStmt->fetchColumn();
        if ($barangayName === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Barangay not found.');
        }

        // One window, reused by every query below so the parts are
        // guaranteed to describe the same period as the total.
        $window = 'barangay_id = :barangay_id
                   AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :months MONTH)';
        $params = ['barangay_id' => $barangayId, 'months' => self::MONTHS];

        $totalStmt = $pdo->prepare("SELECT COUNT(*) FROM incident WHERE {$window}");
        self::bindWindow($totalStmt, $params);
        $totalStmt->execute();
        $total = (int) $totalStmt->fetchColumn();

        $resolvedStmt = $pdo->prepare("SELECT COUNT(*) FROM incident WHERE {$window} AND status = 'resolved'");
        self::bindWindow($resolvedStmt, $params);
        $resolvedStmt->execute();
        $resolved = (int) $resolvedStmt->fetchColumn();

        $typeStmt = $pdo->prepare(
            "SELECT incident_type, COUNT(*) AS n FROM incident WHERE {$window} GROUP BY incident_type"
        );
        self::bindWindow($typeStmt, $params);
        $typeStmt->execute();
        $rawTypes = $typeStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        // Month buckets. Asia/Manila, per §2 Rule 11 — a UTC bucket would
        // put late-evening incidents in the wrong month for a reader who
        // lives here. Fixed +08:00 rather than CONVERT_TZ(), which needs
        // tz tables stock XAMPP does not load.
        $monthStmt = $pdo->prepare(
            "SELECT DATE_FORMAT(DATE_ADD(created_at, INTERVAL 8 HOUR), '%Y-%m') AS ym, COUNT(*) AS n
               FROM incident WHERE {$window}
              GROUP BY ym ORDER BY ym"
        );
        self::bindWindow($monthStmt, $params);
        $monthStmt->execute();
        $months = array_map(
            static fn (array $r): array => ['month' => $r['ym'], 'incidents' => (int) $r['n']],
            $monthStmt->fetchAll(PDO::FETCH_ASSOC) ?: []
        );

        Http::send(200, [
            'barangay' => $barangayName,
            'period_months' => self::MONTHS,
            'generated_at' => gmdate('Y-m-d H:i:s'),
            'total_incidents' => $total,
            'resolved_incidents' => $resolved,
            // Integer percent: a decimal implies a precision that a
            // three-digit denominator does not have.
            'resolution_rate_percent' => $total > 0 ? (int) round(($resolved / $total) * 100) : null,
            'by_type' => self::suppressSmallBuckets($rawTypes),
            'by_month' => $months,
            // The caveats travel WITH the data. Anyone republishing this
            // as a figure inherits them instead of having to know them.
            'notes' => [
                'Counts cover incidents recorded in this system only, not all events in the barangay.',
                'Categories with fewer than ' . self::MIN_BUCKET . ' cases are combined to protect the privacy of the people involved.',
                'No location detail is published at any level.',
            ],
        ]);
    }

    /**
     * Pools every category under the floor into one combined entry.
     *
     * The combined entry names how many categories it covers, which is
     * safe (it reveals nothing about which) and necessary — without it a
     * reader cannot tell whether the pooled count is one category or
     * six, and would be free to assume the worst.
     *
     * @param list<array<string,mixed>> $rows
     * @return list<array<string,mixed>>
     */
    private static function suppressSmallBuckets(array $rows): array
    {
        $out = [];
        $pooledCount = 0;
        $pooledCategories = 0;

        foreach ($rows as $row) {
            $n = (int) $row['n'];
            $type = (string) $row['incident_type'];
            if ($n < self::MIN_BUCKET) {
                $pooledCount += $n;
                $pooledCategories++;
                continue;
            }
            $out[] = [
                'type' => $type,
                'label' => self::TYPE_LABELS[$type] ?? $type,
                'incidents' => $n,
            ];
        }

        usort($out, static fn (array $a, array $b): int => $b['incidents'] <=> $a['incidents']);

        if ($pooledCount > 0) {
            $out[] = [
                'type' => 'combined_small_categories',
                'label' => $pooledCategories === 1
                    ? 'Other category (combined for privacy)'
                    : "Other categories ({$pooledCategories} combined for privacy)",
                'incidents' => $pooledCount,
            ];
        }
        return $out;
    }

    /** @param array<string,int> $params */
    private static function bindWindow(\PDOStatement $stmt, array $params): void
    {
        // INTERVAL :months MONTH will not accept a string-bound value on
        // MariaDB — both binds are explicitly PARAM_INT.
        $stmt->bindValue('barangay_id', $params['barangay_id'], PDO::PARAM_INT);
        $stmt->bindValue('months', $params['months'], PDO::PARAM_INT);
    }

}
