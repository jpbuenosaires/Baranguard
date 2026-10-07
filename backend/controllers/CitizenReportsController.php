<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Dispatch\OfferService;
use Baranguard\Services\Sms\CitizenUpdateNotifier;
use Baranguard\Services\Notifications\NotificationService;
use PDO;

/**
 * Citizen reports — Master Reference §6 "Citizen reports" section, §5
 * `citizen_report` table, §7 role matrix ("View citizen report inbox":
 * Admin/Secretary only), §9 W16 Citizen Reports Inbox + Convert.
 *
 * **The public submission endpoint (`POST /citizen-reports`, W19) was
 * REMOVED in Wave 1 (2026-10-07 review decisions)** together with
 * everything that existed only to defend it (per-IP audit_log limiter,
 * per-barangay volume limit, duplicate-text detection, size caps).
 * Walk-ins are logged by staff from Incident Management with
 * `report_channel = walk_in`. The table and every existing row are kept;
 * this controller still lists them (`GET /citizen-reports`) and converts
 * one into an incident (`POST /citizen-reports/:id/convert`), and the SMS
 * `CitizenUpdateNotifier` still works off those rows. Historic audit rows
 * with `action='citizen_report_submitted'` stay in `audit_log` (it is
 * write-once).
 *
 * Resolved decisions still in force, logged in DEVLOG.md:
 *   - **Response shape for a listed report.** §6 fixes
 *     `{report_id,description,contact_number,latitude,longitude,
 *     submitted_at,incident_id}` for the inbox list; that's returned
 *     verbatim, no raw narrative concept applies here (citizen reports
 *     have no separate raw/redacted split — that split is only on
 *     `incident`, post-conversion).
 */
final class CitizenReportsController
{
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

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);

        $status = Http::query('status');
        if ($status !== null && !in_array($status, ['unconverted', 'converted', 'all'], true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be "unconverted", "converted", or "all" when provided.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($status === 'unconverted') {
            $where[] = 'incident_id IS NULL';
        } elseif ($status === 'converted') {
            $where[] = 'incident_id IS NOT NULL';
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
     * convention used elsewhere for fields with no source to pull from
     * (the blotter/AI-draft controllers this once referenced were removed).
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
                    (barangay_id, reported_by, device_id, incident_type, priority, raw_narrative, status, source, report_channel,
                     latitude, longitude, complainant_contact_number, display_id, created_at, updated_at)
                 VALUES
                    (:barangay_id, NULL, NULL, :incident_type, :priority, :raw_narrative, 'pending', 'web', 'walk_in',
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

            try {
                $admins = NotificationService::adminRecipients($pdo, (int) $report['barangay_id']);
                if (!empty($admins)) {
                    NotificationService::create(
                        $pdo,
                        (int) $report['barangay_id'],
                        NotificationService::TYPE_PRIORITY_ALERT,
                        ['incident_id' => $incidentId],
                        (int) $identity['user_id'],
                        $admins
                    );
                }
            } catch (\Throwable $ignored) {}

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

        // AFTER the commit, deliberately. The conversion is the records
        // action and must stand on its own; texting the reporter is a
        // courtesy that follows it. Inside the transaction, a gateway
        // timeout would roll back a completed conversion, and an SMS
        // already handed off to send cannot be un-sent by a rollback
        // anyway — so the only correct order is commit first, notify
        // second. The notifier swallows its own failures.
        CitizenUpdateNotifier::notifyReceived($pdo, $reportId);

        // Wave 2: at night the converted (pending) incident opens a dispatch
        // offer. After commit; never fails the conversion (Rule 7).
        OfferService::autoOpenForNewIncident($pdo, $incidentId, (int) $report['barangay_id']);

        Http::send(200, [
            'incident_id' => $incidentId,
            'citizen_report_id' => $reportId,
            'converted_at' => $convertedAt,
        ]);
    }
}
