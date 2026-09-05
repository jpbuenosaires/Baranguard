<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Citizen reports — Master Reference §6 "Citizen reports" section, §5
 * `citizen_report` table, §7 role matrix ("View citizen report inbox":
 * Admin/Secretary only), §9 W19 Public Citizen Report + W16 Citizen
 * Reports Inbox + Convert (2026-09-05: the convert endpoint §6 always
 * documented — `citizen_report.incident_id`/`converted_at` existed in
 * the schema from the baseline — was built this pass; W16's own Sprint 1
 * checklist entry said "list only" because only the list half existed
 * yet, not because convert was out of scope).
 *
 * Resolved decisions, logged in DEVLOG.md:
 *   - **Rate limiting.** §6 says `POST /citizen-reports` is "rate-limited
 *     and size-limited" but never states a threshold or mechanism, and
 *     `citizen_report` itself has no IP column to key a limiter off of.
 *     `audit_log` already exists for exactly this kind of write-once
 *     tracking (has `ip_address`, `action`, `created_at`) — reused here
 *     rather than adding a new table: every submission attempt (accepted
 *     or rate-limited) writes an `audit_log` row with
 *     `action='citizen_report_submitted'`, and a new request is rejected
 *     with 429 once the same IP has 3 accepted submissions inside a
 *     rolling 15-minute window. Same "reuse an existing schema entity
 *     instead of inventing one" precedent as `AuthController`'s lockout
 *     counters living on the `user` row itself.
 *   - **`confirmation`.** §6: "Creates report before attempting optional
 *     confirmation SMS. Response includes `{report_id,confirmation}`."
 *     No SMS/GSM transport exists yet (Sprint 4 dependency — same
 *     "not wired up yet" situation `DispatchController` documents for
 *     OSRM). `confirmation` is always `null` here rather than a fabricated
 *     `{sent:true}` — this is queued dependent-feature absence, not a
 *     bug, and mirrors `dispatch.route_status="unavailable"`'s precedent
 *     exactly: don't claim a side effect that never actually happened.
 *   - **Response shape for a listed report.** §6 fixes
 *     `{report_id,description,contact_number,latitude,longitude,
 *     submitted_at,incident_id}` for the inbox list; that's returned
 *     verbatim, no raw narrative concept applies here (citizen reports
 *     have no separate raw/redacted split — that split is only on
 *     `incident`, post-conversion).
 *   - **Size limit.** `description` is capped at 2000 characters (the
 *     column is TEXT, effectively unbounded — this is an abuse-prevention
 *     ceiling on a public unauthenticated endpoint, not a schema limit).
 *     `contact_number` follows the column's own VARCHAR(32).
 */
final class CitizenReportsController
{
    private const MAX_DESCRIPTION_LENGTH = 2000;
    private const MAX_CONTACT_LENGTH = 32;
    private const RATE_LIMIT_MAX_ATTEMPTS = 3;
    private const RATE_LIMIT_WINDOW_MINUTES = 15;
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    // Same 11-member enum as `incident.incident_type` (§5) — duplicated
    // here rather than made public on IncidentsController because that
    // class already keeps its own copy private; every JS consumer of
    // this same list (DonutChart, statistical-reports.js, etc.) already
    // duplicates it too, so this matches the codebase's existing pattern
    // rather than inventing a new one.
    private const INCIDENT_TYPES = [
        'theft', 'physical_injury', 'disturbance', 'domestic_dispute', 'vandalism',
        'traffic_incident', 'fire', 'medical_emergency', 'missing_person',
        'animal_complaint', 'other',
    ];
    private const INCIDENT_PRIORITIES = ['normal', 'high', 'critical'];

    public static function submit(PDO $pdo): void
    {
        $ip = $_SERVER['REMOTE_ADDR'] ?? null;

        if ($ip !== null) {
            $stmt = $pdo->prepare(
                "SELECT COUNT(*) FROM audit_log
                 WHERE action = 'citizen_report_submitted' AND ip_address = :ip
                   AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :window_minutes MINUTE)"
            );
            $stmt->bindValue('ip', $ip);
            $stmt->bindValue('window_minutes', self::RATE_LIMIT_WINDOW_MINUTES, PDO::PARAM_INT);
            $stmt->execute();
            if ((int) $stmt->fetchColumn() >= self::RATE_LIMIT_MAX_ATTEMPTS) {
                throw new ApiError(429, 'RATE_LIMITED', 'Too many reports submitted recently. Please try again later.');
            }
        }

        $body = Http::jsonBody();
        $barangayId = $body['barangay_id'] ?? null;
        $description = $body['description'] ?? null;
        $contactNumber = $body['contact_number'] ?? null;
        $latitude = $body['latitude'] ?? null;
        $longitude = $body['longitude'] ?? null;

        if (!is_int($barangayId) && !(is_string($barangayId) && ctype_digit($barangayId))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id is required.');
        }
        $barangayId = (int) $barangayId;

        if (!is_string($description) || trim($description) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'description is required.');
        }
        if (strlen($description) > self::MAX_DESCRIPTION_LENGTH) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'description must be at most ' . self::MAX_DESCRIPTION_LENGTH . ' characters.');
        }

        if ($contactNumber !== null) {
            if (!is_string($contactNumber) || strlen($contactNumber) > self::MAX_CONTACT_LENGTH) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'contact_number must be a string of at most ' . self::MAX_CONTACT_LENGTH . ' characters.');
            }
        }

        [$latitude, $longitude] = self::validateCoordinates($latitude, $longitude);

        // "Only the four known barangays are accepted" (§6) — checked
        // against the real table rather than hardcoding 1-4, so this
        // still works if the deterministic seed ever changes rows.
        $barangayStmt = $pdo->prepare('SELECT barangay_id FROM barangay WHERE barangay_id = :barangay_id LIMIT 1');
        $barangayStmt->execute(['barangay_id' => $barangayId]);
        if ($barangayStmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id must be one of the known barangays.');
        }

        $insertStmt = $pdo->prepare(
            'INSERT INTO citizen_report (barangay_id, contact_number, description, latitude, longitude, submitted_at)
             VALUES (:barangay_id, :contact_number, :description, :latitude, :longitude, UTC_TIMESTAMP())'
        );
        $insertStmt->execute([
            'barangay_id' => $barangayId,
            'contact_number' => $contactNumber,
            'description' => $description,
            'latitude' => $latitude,
            'longitude' => $longitude,
        ]);
        $reportId = (int) $pdo->lastInsertId();

        // Write-once tracking row, doubling as the rate-limit ledger — see
        // class doc. actor_user_id is NULL: public/unauthenticated caller.
        $auditStmt = $pdo->prepare(
            'INSERT INTO audit_log (barangay_id, actor_user_id, action, entity_type, entity_id, metadata_json, ip_address, user_agent, created_at)
             VALUES (:barangay_id, NULL, :action, :entity_type, :entity_id, :metadata_json, :ip, :ua, UTC_TIMESTAMP())'
        );
        $auditStmt->execute([
            'barangay_id' => $barangayId,
            'action' => 'citizen_report_submitted',
            'entity_type' => 'citizen_report',
            'entity_id' => $reportId,
            'metadata_json' => json_encode([], JSON_UNESCAPED_SLASHES),
            'ip' => $ip,
            'ua' => Http::header('User-Agent'),
        ]);

        Http::send(201, [
            'report_id' => $reportId,
            'confirmation' => null, // No SMS transport built yet — see class doc.
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);

        $status = Http::query('status');
        if ($status !== null && $status !== 'unconverted') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be "unconverted" when provided.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($status === 'unconverted') {
            $where[] = 'incident_id IS NULL';
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM citizen_report WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT report_id, description, contact_number, latitude, longitude, submitted_at, incident_id
             FROM citizen_report
             WHERE {$whereSql}
             ORDER BY submitted_at DESC
             LIMIT :limit OFFSET :offset"
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
                'report_id' => (int) $row['report_id'],
                'description' => $row['description'],
                'contact_number' => $row['contact_number'],
                'latitude' => $row['latitude'] !== null ? (float) $row['latitude'] : null,
                'longitude' => $row['longitude'] !== null ? (float) $row['longitude'] : null,
                'submitted_at' => $row['submitted_at'],
                'incident_id' => $row['incident_id'] !== null ? (int) $row['incident_id'] : null,
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /**
     * POST /citizen-reports/:id/convert — §6: "Admin/Secretary only.
     * Tenant derived from the stored report. Transaction locks report,
     * requires incident_id IS NULL, creates exactly one incident with
     * reported_by=NULL, links report, writes audit, and sets
     * converted_at. Retry returns the already-converted incident."
     *
     * `incident_type` has no citizen-report equivalent (the submission is
     * free text only), so it's a required body field here — the Admin/
     * Secretary reviewing the description picks the closest category,
     * same as the Incident Management "Log Incident" form already
     * requires when creating an incident from scratch. Not defaulted to
     * 'other' silently: that would mis-categorize every converted report
     * in the incident_type breakdowns Analytics/Heatmap already key off.
     * `priority` is optional, same 'normal' default `IncidentsController`
     * uses. The report's own `contact_number` carries forward into
     * `complainant_contact_number` — the person who filed the report is
     * the complainant in every practical sense — but nothing else is
     * inferred; `location_description`/`complainant_name`/
     * `respondent_name` are left null, same "omitted key is simply null"
     * convention `BlotterController::finalize()` already follows for
     * fields with no source to pull from.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function convert(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        if (!ctype_digit($reportIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Citizen report not found.');
        }
        $reportId = (int) $reportIdParam;

        $body = Http::jsonBody();
        $incidentType = $body['incident_type'] ?? null;
        if (!is_string($incidentType) || !in_array($incidentType, self::INCIDENT_TYPES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'incident_type must be one of: ' . implode(', ', self::INCIDENT_TYPES) . '.');
        }
        $priority = $body['priority'] ?? 'normal';
        if (!is_string($priority) || !in_array($priority, self::INCIDENT_PRIORITIES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'priority must be one of: ' . implode(', ', self::INCIDENT_PRIORITIES) . '.');
        }

        $pdo->beginTransaction();
        try {
            $reportStmt = $pdo->prepare(
                'SELECT report_id, barangay_id, description, contact_number, latitude, longitude, incident_id, converted_at
                 FROM citizen_report WHERE report_id = :report_id FOR UPDATE'
            );
            $reportStmt->execute(['report_id' => $reportId]);
            $report = $reportStmt->fetch(PDO::FETCH_ASSOC);
            if ($report === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Citizen report not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $report['barangay_id']);

            if ($report['incident_id'] !== null) {
                // §6: idempotent retry, not a 409 — a Secretary re-clicking
                // Convert after a slow response shouldn't get punished for
                // conversion having already succeeded.
                $pdo->commit();
                Http::send(200, [
                    'incident_id' => (int) $report['incident_id'],
                    'citizen_report_id' => $reportId,
                    'converted_at' => $report['converted_at'],
                ]);
            }

            $insertStmt = $pdo->prepare(
                "INSERT INTO incident
                    (barangay_id, reported_by, device_id, incident_type, priority, raw_narrative, status, source,
                     latitude, longitude, complainant_contact_number, display_id, created_at, updated_at)
                 VALUES
                    (:barangay_id, NULL, NULL, :incident_type, :priority, :raw_narrative, 'pending', 'web',
                     :latitude, :longitude, :complainant_contact_number, :display_id, UTC_TIMESTAMP(), UTC_TIMESTAMP())"
            );
            // display_id (migration 0014): same bounded-retry-on-collision
            // shape IncidentsController::createWeb() already uses.
            $attempts = 0;
            while (true) {
                $displayId = IncidentsController::nextDisplayId($pdo, (int) $report['barangay_id'], 'INC');
                try {
                    $insertStmt->execute([
                        'barangay_id' => $report['barangay_id'],
                        'incident_type' => $incidentType,
                        'priority' => $priority,
                        'raw_narrative' => $report['description'],
                        'latitude' => $report['latitude'],
                        'longitude' => $report['longitude'],
                        'complainant_contact_number' => $report['contact_number'],
                        'display_id' => $displayId,
                    ]);
                    break;
                } catch (\PDOException $e) {
                    $attempts++;
                    if ($attempts >= 3 || !str_contains($e->getMessage(), 'uq_incident_display_id')) {
                        throw $e;
                    }
                }
            }
            $incidentId = (int) $pdo->lastInsertId();

            $updateStmt = $pdo->prepare(
                'UPDATE citizen_report SET incident_id = :incident_id, converted_at = UTC_TIMESTAMP() WHERE report_id = :report_id'
            );
            $updateStmt->execute(['incident_id' => $incidentId, 'report_id' => $reportId]);

            Audit::record($pdo, (int) $report['barangay_id'], $identity['user_id'], 'citizen_report_converted', 'citizen_report', $reportId, [
                'incident_id' => $incidentId,
            ]);

            $convertedAtStmt = $pdo->prepare('SELECT converted_at FROM citizen_report WHERE report_id = :report_id');
            $convertedAtStmt->execute(['report_id' => $reportId]);
            $convertedAt = $convertedAtStmt->fetchColumn();

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, [
            'incident_id' => $incidentId,
            'citizen_report_id' => $reportId,
            'converted_at' => $convertedAt,
        ]);
    }

    /** @return array{0:?float,1:?float} */
    private static function validateCoordinates(mixed $latitude, mixed $longitude): array
    {
        if ($latitude === null && $longitude === null) {
            return [null, null];
        }
        if (!is_numeric($latitude) || !is_numeric($longitude)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude and longitude must both be provided together as numbers.');
        }
        $lat = (float) $latitude;
        $lng = (float) $longitude;
        if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude/longitude are out of range.');
        }
        return [$lat, $lng];
    }
}
