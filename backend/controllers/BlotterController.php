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
 * Blotter finalization and amendment — Master Reference §6 "Blotter",
 * §5 `blotter_record`, §7 role matrix (blotter finalization: Secretary
 * only), §9 W7 Electronic Blotter Detail.
 *
 * §2 Rule 24 / §5: "Once finalized, normal overwrite is forbidden;
 * amendment is explicit and audited." Both halves of that are enforced
 * here: `finalize()` refuses to touch an already-finalized record (409),
 * and `amend()` is the only path that may change one — recording the
 * superseded text first.
 *
 * WHY THE LEGAL FRAMING MATTERS (§3): RA 7160 §394(c) makes the Barangay
 * Secretary the custodian of barangay records, which is why finalize and
 * amend are Secretary-only and Admin cannot perform them despite Admin
 * being the higher-privilege role everywhere else in this system. Do not
 * "fix" that asymmetry by adding admin to these role gates.
 *
 * Resolved decisions (logged in DEVLOG.md):
 *
 *   - **Amendment history needed a new table.** §6 requires an amendment
 *     to "never delete the previous finalized value", but
 *     `blotter_record` has one `narrative_summary` column. Migration
 *     `0004_blotter_revision.sql` adds `blotter_revision`; `amend()`
 *     copies the current text into it BEFORE overwriting, so the live
 *     row is always current and every superseded version is retrievable.
 *     Storing the old text in `audit_log` was rejected: Rule 17
 *     allow-lists audit metadata to identifiers and statuses.
 *   - **`finalize()` requires an approved redaction** (§6) —
 *     `redaction_approved_at IS NOT NULL` is §5's documented approval
 *     signal. Until `POST .../ai-draft/approve` (Sprint 6) exists and has
 *     been used on an incident, this endpoint correctly 409s.
 *   - **`narrative_summary` is supplied by the Secretary, not copied from
 *     the AI draft.** §6's body takes it explicitly, and Rule 16's
 *     pipeline ends at human approval — the blotter entry is the
 *     Secretary's own record, informed by the approved draft rather than
 *     mechanically equal to it.
 *   - **`POST /incidents/:id/lupon-packet` generates a real PDF** via
 *     `services/pdf/SimplePdf.php`, a small dependency-free writer added
 *     for exactly this (see its class doc for why that beat vendoring
 *     FPDF or serving print-styled HTML). §6 requires BOTH an approved
 *     redaction AND a finalized blotter before it will produce anything.
 *   - **The packet is written outside the web root and served through an
 *     authorized endpoint**, never linked directly. §5 already requires
 *     this of evidence files ("stored outside the public web root"), and a
 *     Lupon packet contains the full approved narrative — the same
 *     protection applies. `file_url` is therefore API-relative and points
 *     at a download route that re-checks role and tenant, mirroring
 *     `MapPackagesController`'s own `download_url` precedent.
 */
final class BlotterController
{
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /**
     * GET /blotter — Phase 6 of the mockup-driven UI round 2 (see
     * .claude/plans/clever-wishing-hummingbird.md). Not in §6's original
     * endpoint list — a resolved, logged addition, same precedent as
     * `GET /reports/nav-counts`/`GET /notifications`: W6 Electronic
     * Blotter's mockup lists finalized RECORDS (`blotter_record`), which
     * `GET /incidents` cannot answer since a `blotter_record` row and an
     * `incident` row are different things with different lifecycles —
     * every finalized incident has exactly one blotter_record, but not
     * every incident has one yet.
     *
     * Tenant-scoped via `blotter_record.barangay_id` (denormalized onto
     * the table already — see migration 0001). Every row this endpoint
     * lists is, by construction, already finalized: `finalize()` never
     * inserts a row without setting `finalized_at` in the same statement,
     * so there is no draft state to filter out here — the `finalized_at
     * IS NOT NULL` clause documents that invariant rather than doing real
     * filtering work.
     *
     * Roles: Admin/Secretary/PB, same as `showByIncident()` minus Tanod —
     * a Tanod's only legitimate blotter access is a specific record they
     * reported or were dispatched on (already gated in `show()`/
     * `showByIncident()`), not a browsable ledger of every finalized case
     * in the barangay.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);
        $barangayId = $identity['barangay_id'];

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare(
            'SELECT COUNT(*) FROM blotter_record WHERE barangay_id = :barangay_id AND finalized_at IS NOT NULL'
        );
        $countStmt->execute(['barangay_id' => $barangayId]);
        $total = (int) $countStmt->fetchColumn();

        // officer_name: same "most recent dispatch, any status" join
        // IncidentsController::index() already uses for the same reason —
        // an incident that was dispatched then cancelled still meaningfully
        // "had an officer handle it" for blotter purposes.
        $stmt = $pdo->prepare(
            "SELECT b.blotter_id, b.incident_id, b.recorded_by, b.approved_by, b.finalized_at,
                    b.revision_no, b.amended_at, b.amended_by,
                    i.incident_type, i.latitude, i.longitude,
                    tanod.full_name AS officer_name
             FROM blotter_record b
             JOIN incident i ON i.incident_id = b.incident_id
             LEFT JOIN dispatch d ON d.dispatch_id = (
                 SELECT d2.dispatch_id FROM dispatch d2
                 WHERE d2.incident_id = i.incident_id
                 ORDER BY d2.dispatched_at DESC
                 LIMIT 1
             )
             LEFT JOIN user tanod ON tanod.user_id = d.tanod_id
             WHERE b.barangay_id = :barangay_id AND b.finalized_at IS NOT NULL
             ORDER BY b.finalized_at DESC
             LIMIT :limit OFFSET :offset"
        );
        $stmt->bindValue(':barangay_id', $barangayId, PDO::PARAM_INT);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'blotter_id' => (int) $row['blotter_id'],
                'incident_id' => (int) $row['incident_id'],
                'incident_type' => $row['incident_type'],
                'latitude' => $row['latitude'] !== null ? (float) $row['latitude'] : null,
                'longitude' => $row['longitude'] !== null ? (float) $row['longitude'] : null,
                'officer_name' => $row['officer_name'] ?? null,
                'recorded_by' => (int) $row['recorded_by'],
                'approved_by' => $row['approved_by'] !== null ? (int) $row['approved_by'] : null,
                'finalized_at' => $row['finalized_at'],
                'revision_no' => (int) $row['revision_no'],
                'amended_at' => $row['amended_at'],
                'amended_by' => $row['amended_by'] !== null ? (int) $row['amended_by'] : null,
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /**
     * POST /incidents/:id/finalize — §6: "Secretary only. Requires
     * approved redaction and same-barangay resource. Body
     * {narrative_summary} → {blotter_id,finalized_at,revision_no}. If no
     * record exists, creates and finalizes it. If finalized_at is already
     * set, returns 409."
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function finalize(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        $body = Http::jsonBody();
        $narrativeSummary = $body['narrative_summary'] ?? null;
        if (!is_string($narrativeSummary) || trim($narrativeSummary) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'narrative_summary is required.');
        }

        $pdo->beginTransaction();
        try {
            $incidentStmt = $pdo->prepare(
                'SELECT incident_id, barangay_id, redaction_approved_at
                 FROM incident WHERE incident_id = :incident_id FOR UPDATE'
            );
            $incidentStmt->execute(['incident_id' => $incidentId]);
            $incident = $incidentStmt->fetch(PDO::FETCH_ASSOC);
            if ($incident === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);

            // §6: "Requires approved redaction". §2 Rule 3 makes approval
            // the only gate through which redacted text becomes canonical,
            // so finalizing without it would put unreviewed AI output into
            // a legal record.
            if ($incident['redaction_approved_at'] === null) {
                throw new ApiError(409, 'CONFLICT', 'This incident has no approved redaction yet; approve the AI draft before finalizing.');
            }

            $existingStmt = $pdo->prepare(
                'SELECT blotter_id, finalized_at, revision_no FROM blotter_record
                 WHERE incident_id = :incident_id FOR UPDATE'
            );
            $existingStmt->execute(['incident_id' => $incidentId]);
            $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);

            if ($existing !== false && $existing['finalized_at'] !== null) {
                // §6: "If finalized_at is already set, returns 409; use the
                // amendment endpoint for later changes."
                throw new ApiError(409, 'CONFLICT', 'This blotter record is already finalized; use the amendment endpoint to change it.');
            }

            if ($existing === false) {
                $insertStmt = $pdo->prepare(
                    'INSERT INTO blotter_record
                        (incident_id, barangay_id, recorded_by, approved_by, narrative_summary, finalized_at, revision_no)
                     VALUES
                        (:incident_id, :barangay_id, :recorded_by, :approved_by, :narrative_summary, UTC_TIMESTAMP(), 1)'
                );
                $insertStmt->execute([
                    'incident_id' => $incidentId,
                    'barangay_id' => (int) $incident['barangay_id'],
                    // §6: "recorded_by and approved_by capture the Secretary
                    // actor for the current workflow."
                    'recorded_by' => $identity['user_id'],
                    'approved_by' => $identity['user_id'],
                    'narrative_summary' => $narrativeSummary,
                ]);
                $blotterId = (int) $pdo->lastInsertId();
            } else {
                // A record exists but was never finalized — finalize it in
                // place rather than creating a second one (§5 makes
                // incident_id UNIQUE on this table anyway).
                $blotterId = (int) $existing['blotter_id'];
                $updateStmt = $pdo->prepare(
                    'UPDATE blotter_record
                        SET narrative_summary = :narrative_summary,
                            recorded_by = :recorded_by,
                            approved_by = :approved_by,
                            finalized_at = UTC_TIMESTAMP()
                      WHERE blotter_id = :blotter_id'
                );
                $updateStmt->execute([
                    'narrative_summary' => $narrativeSummary,
                    'recorded_by' => $identity['user_id'],
                    'approved_by' => $identity['user_id'],
                    'blotter_id' => $blotterId,
                ]);
            }

            $readBack = $pdo->prepare('SELECT finalized_at, revision_no FROM blotter_record WHERE blotter_id = :blotter_id');
            $readBack->execute(['blotter_id' => $blotterId]);
            $finalized = $readBack->fetch(PDO::FETCH_ASSOC);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'blotter_finalized', 'blotter_record', $blotterId, [
                'incident_id' => $incidentId,
                'revision_no' => (int) $finalized['revision_no'],
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(201, [
            'blotter_id' => $blotterId,
            'finalized_at' => $finalized['finalized_at'],
            'revision_no' => (int) $finalized['revision_no'],
        ]);
    }

    /**
     * POST /incidents/:id/blotter/amend — §6: "Secretary only. Body
     * {narrative_summary,reason} → {blotter_id,revision_no,amended_at}.
     * Requires finalized record, creates an audited revision, increments
     * revision_no, and never deletes the previous finalized value."
     *
     * The "never deletes" half is why `blotter_revision` exists — the
     * current text is copied there before being overwritten. See the
     * class doc and migration 0004.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function amend(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        $body = Http::jsonBody();
        $narrativeSummary = $body['narrative_summary'] ?? null;
        $reason = $body['reason'] ?? null;
        if (!is_string($narrativeSummary) || trim($narrativeSummary) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'narrative_summary is required.');
        }
        // §6 documents `reason` as part of the body, and an unexplained
        // amendment to a legal record is exactly what the audit trail
        // exists to prevent — so it is required, not optional.
        if (!is_string($reason) || trim($reason) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'reason is required.');
        }

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'SELECT b.blotter_id, b.barangay_id, b.narrative_summary, b.revision_no, b.finalized_at, b.amended_by
                 FROM blotter_record b
                 WHERE b.incident_id = :incident_id
                 FOR UPDATE'
            );
            $stmt->execute(['incident_id' => $incidentId]);
            $record = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($record === false) {
                throw new ApiError(404, 'NOT_FOUND', 'No blotter record exists for this incident.');
            }
            AuthMiddleware::requireTenant($identity, (int) $record['barangay_id']);

            if ($record['finalized_at'] === null) {
                // Not finalized yet — finalize() is the right endpoint, and
                // amending a draft record would create revision history for
                // something that was never an official record.
                throw new ApiError(409, 'CONFLICT', 'This blotter record is not finalized yet; finalize it first.');
            }

            $blotterId = (int) $record['blotter_id'];
            $currentRevision = (int) $record['revision_no'];

            // Preserve the outgoing version BEFORE overwriting it — §6's
            // "never deletes the previous finalized value".
            $revisionStmt = $pdo->prepare(
                'INSERT INTO blotter_revision
                    (blotter_id, revision_no, narrative_summary, reason, amended_by, superseded_at)
                 VALUES
                    (:blotter_id, :revision_no, :narrative_summary, :reason, :amended_by, UTC_TIMESTAMP())'
            );
            $revisionStmt->execute([
                'blotter_id' => $blotterId,
                'revision_no' => $currentRevision,
                'narrative_summary' => (string) $record['narrative_summary'],
                'reason' => $reason,
                'amended_by' => $identity['user_id'],
            ]);

            $newRevision = $currentRevision + 1;
            $updateStmt = $pdo->prepare(
                'UPDATE blotter_record
                    SET narrative_summary = :narrative_summary,
                        revision_no = :revision_no,
                        amended_at = UTC_TIMESTAMP(),
                        amended_by = :amended_by
                  WHERE blotter_id = :blotter_id'
            );
            $updateStmt->execute([
                'narrative_summary' => $narrativeSummary,
                'revision_no' => $newRevision,
                'amended_by' => $identity['user_id'],
                'blotter_id' => $blotterId,
            ]);

            $readBack = $pdo->prepare('SELECT amended_at FROM blotter_record WHERE blotter_id = :blotter_id');
            $readBack->execute(['blotter_id' => $blotterId]);
            $amendedAt = $readBack->fetchColumn();

            // Rule 17 allow-list: the reason is a short operator-supplied
            // justification (identifiers/statuses class), never narrative
            // content — the superseded TEXT goes to blotter_revision, not
            // here.
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'blotter_amended', 'blotter_record', $blotterId, [
                'incident_id' => $incidentId,
                'from_revision' => $currentRevision,
                'to_revision' => $newRevision,
                'reason' => mb_substr($reason, 0, 255),
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, [
            'blotter_id' => $blotterId,
            'revision_no' => $newRevision,
            'amended_at' => $amendedAt,
        ]);
    }

    /**
     * GET /blotter/:id — §6: "same-barangay resource check first; Tanod
     * access additionally requires reporter/assignment relationship →
     * {blotter_id,incident_id,narrative_summary,recorded_by,approved_by,
     * finalized_at,revision_no}."
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function show(PDO $pdo, array $identity, string $blotterIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'tanod', 'punong_barangay']);
        if (!ctype_digit($blotterIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Blotter record not found.');
        }
        $blotterId = (int) $blotterIdParam;

        $stmt = $pdo->prepare(
            'SELECT blotter_id, incident_id, barangay_id, narrative_summary, recorded_by, approved_by,
                    finalized_at, revision_no, amended_at, amended_by
             FROM blotter_record WHERE blotter_id = :blotter_id'
        );
        $stmt->execute(['blotter_id' => $blotterId]);
        $record = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($record === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Blotter record not found.');
        }
        // §6: "same-barangay resource check FIRST" — before the ownership
        // check below, so a cross-tenant caller learns nothing from the
        // difference between the two failures.
        AuthMiddleware::requireTenant($identity, (int) $record['barangay_id']);

        // §6/§7: a Tanod may only read a blotter for an incident they
        // reported or were dispatched to. Same allow-list logic
        // GET /incidents/:id/evidence uses.
        if ($identity['role'] === 'tanod') {
            $relStmt = $pdo->prepare(
                'SELECT 1 FROM incident i
                 WHERE i.incident_id = :incident_id
                   AND (i.reported_by = :user_id
                        OR EXISTS (SELECT 1 FROM dispatch d WHERE d.incident_id = i.incident_id AND d.tanod_id = :user_id2))
                 LIMIT 1'
            );
            $relStmt->execute([
                'incident_id' => (int) $record['incident_id'],
                'user_id' => $identity['user_id'],
                'user_id2' => $identity['user_id'],
            ]);
            if ($relStmt->fetch(PDO::FETCH_ASSOC) === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Blotter record not found.');
            }
        }

        Http::send(200, [
            'blotter_id' => (int) $record['blotter_id'],
            'incident_id' => (int) $record['incident_id'],
            'narrative_summary' => $record['narrative_summary'],
            'recorded_by' => (int) $record['recorded_by'],
            'approved_by' => $record['approved_by'] !== null ? (int) $record['approved_by'] : null,
            'finalized_at' => $record['finalized_at'],
            'revision_no' => (int) $record['revision_no'],
            'amended_at' => $record['amended_at'],
            'amended_by' => $record['amended_by'] !== null ? (int) $record['amended_by'] : null,
        ]);
    }

    /**
     * GET /incidents/:id/blotter — §6: "tenant-scoped convenience lookup →
     * {blotter_id,incident_id,narrative_summary,recorded_by,approved_by,
     * finalized_at,revision_no}; 404 when none exists."
     *
     * Exists because W7 works from an incident id (that's what the blotter
     * list links by) and would otherwise have no way to find the record —
     * `GET /blotter/:id` needs an id the screen doesn't have yet. The 404
     * is an ordinary, expected state here: most incidents have no blotter
     * record until a Secretary finalizes one.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function showByIncident(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'tanod', 'punong_barangay']);
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        // Resolve the incident first so a cross-tenant caller gets the same
        // 404 whether or not a blotter record happens to exist.
        $incidentStmt = $pdo->prepare('SELECT incident_id, barangay_id, reported_by FROM incident WHERE incident_id = :incident_id');
        $incidentStmt->execute(['incident_id' => $incidentId]);
        $incident = $incidentStmt->fetch(PDO::FETCH_ASSOC);
        if ($incident === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);

        if ($identity['role'] === 'tanod') {
            $relStmt = $pdo->prepare(
                'SELECT 1 FROM incident i
                 WHERE i.incident_id = :incident_id
                   AND (i.reported_by = :user_id
                        OR EXISTS (SELECT 1 FROM dispatch d WHERE d.incident_id = i.incident_id AND d.tanod_id = :user_id2))
                 LIMIT 1'
            );
            $relStmt->execute([
                'incident_id' => $incidentId,
                'user_id' => $identity['user_id'],
                'user_id2' => $identity['user_id'],
            ]);
            if ($relStmt->fetch(PDO::FETCH_ASSOC) === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
            }
        }

        $stmt = $pdo->prepare(
            'SELECT blotter_id, incident_id, narrative_summary, recorded_by, approved_by,
                    finalized_at, revision_no, amended_at, amended_by
             FROM blotter_record WHERE incident_id = :incident_id'
        );
        $stmt->execute(['incident_id' => $incidentId]);
        $record = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($record === false) {
            throw new ApiError(404, 'NOT_FOUND', 'No blotter record exists for this incident.');
        }

        Http::send(200, [
            'blotter_id' => (int) $record['blotter_id'],
            'incident_id' => (int) $record['incident_id'],
            'narrative_summary' => $record['narrative_summary'],
            'recorded_by' => (int) $record['recorded_by'],
            'approved_by' => $record['approved_by'] !== null ? (int) $record['approved_by'] : null,
            'finalized_at' => $record['finalized_at'],
            'revision_no' => (int) $record['revision_no'],
            'amended_at' => $record['amended_at'],
            'amended_by' => $record['amended_by'] !== null ? (int) $record['amended_by'] : null,
        ]);
    }

    /**
     * POST /incidents/:id/lupon-packet — §6: "Secretary only; requires
     * approved redaction **and finalized blotter**; generates the case PDF
     * from the approved redaction plus finalized summary → {file_url}."
     *
     * §3 explains who this is for: the Lupon has no system login at all,
     * so the packet is the deliverable — a Secretary-generated document
     * handed over as case materials. That is why the content is drawn from
     * `incident.redacted_narrative` (the APPROVED text) and never from
     * `raw_narrative` or a draft: material leaving the system entirely
     * must be the human-approved version.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function luponPacket(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        $context = self::loadPacketContext($pdo, $identity, $incidentIdParam);

        $pdfBytes = self::buildPacketPdf($context);

        $path = self::packetPath((int) $context['incident_id']);
        $directory = dirname($path);
        if (!is_dir($directory) && !mkdir($directory, 0770, true) && !is_dir($directory)) {
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Packet storage is not writable on this workstation.');
        }
        if (file_put_contents($path, $pdfBytes) === false) {
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Could not write the Lupon packet.');
        }

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'lupon_packet_generated', 'blotter_record', (int) $context['blotter_id'], [
            'incident_id' => (int) $context['incident_id'],
            'revision_no' => (int) $context['revision_no'],
        ]);

        // API-relative, like map packages' download_url: the server has no
        // reliable externally-visible host under Rule 7 (LAN-only), and the
        // client already knows its own API base.
        Http::send(201, [
            'file_url' => '/incidents/' . (int) $context['incident_id'] . '/lupon-packet/download',
        ]);
    }

    /**
     * GET /incidents/:id/lupon-packet/download — streams a generated
     * packet.
     *
     * Not in §6's endpoint list, added for the same reason
     * `GET /map-packages/:id/download` exists: §6 promises a `file_url`
     * but the file must not live in the web root (§5's rule for evidence
     * applies at least as strongly to a document holding the full approved
     * narrative). An authorized endpoint is the only way to honour both.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function luponPacketDownload(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        // Re-runs every prerequisite and the tenant check — authorization
        // is never inherited from whoever generated the file (Rule 30).
        $context = self::loadPacketContext($pdo, $identity, $incidentIdParam);

        $path = self::packetPath((int) $context['incident_id']);
        if (!is_file($path)) {
            throw new ApiError(404, 'NOT_FOUND', 'No packet has been generated for this incident yet.');
        }

        header('Content-Type: application/pdf');
        header('Content-Length: ' . (string) filesize($path));
        header('Content-Disposition: attachment; filename="lupon-packet-incident-' . (int) $context['incident_id'] . '.pdf"');
        readfile($path);
        exit;
    }

    /**
     * Shared prerequisite + authorization check for both packet endpoints.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @return array<string,mixed>
     */
    private static function loadPacketContext(PDO $pdo, array $identity, string $incidentIdParam): array
    {
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        $stmt = $pdo->prepare(
            'SELECT i.incident_id, i.barangay_id, i.incident_type, i.status, i.created_at,
                    i.redacted_narrative, i.redaction_approved_at,
                    b.blotter_id, b.narrative_summary, b.finalized_at, b.revision_no, b.amended_at,
                    bar.name AS barangay_name, bar.municipality, bar.province
             FROM incident i
             JOIN barangay bar ON bar.barangay_id = i.barangay_id
             LEFT JOIN blotter_record b ON b.incident_id = i.incident_id
             WHERE i.incident_id = :incident_id'
        );
        $stmt->execute(['incident_id' => $incidentId]);
        $context = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($context === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $context['barangay_id']);

        // §6's two hard prerequisites, checked separately so the Secretary
        // is told which one is missing.
        if ($context['redaction_approved_at'] === null || $context['redacted_narrative'] === null) {
            throw new ApiError(409, 'CONFLICT', 'This incident has no approved redaction yet.');
        }
        if ($context['blotter_id'] === null || $context['finalized_at'] === null) {
            throw new ApiError(409, 'CONFLICT', 'This incident has no finalized blotter record yet.');
        }

        return $context;
    }

    /** @param array<string,mixed> $context */
    private static function buildPacketPdf(array $context): string
    {
        $incidentId = (int) $context['incident_id'];
        $barangay = (string) $context['barangay_name'];

        $pdf = SimplePdf::create("Lupon Case Packet - Incident #{$incidentId}")
            ->heading('LUPONG TAGAPAMAYAPA — CASE PACKET', 15.0)
            ->paragraph(sprintf(
                'Barangay %s, %s, %s',
                $barangay,
                (string) $context['municipality'],
                (string) $context['province']
            ))
            ->rule()
            ->keyValue('Incident number', '#' . $incidentId)
            ->keyValue('Incident type', str_replace('_', ' ', (string) $context['incident_type']))
            ->keyValue('Reported', self::formatManilaTime((string) $context['created_at']))
            ->keyValue('Blotter record', '#' . (int) $context['blotter_id'])
            ->keyValue('Blotter revision', (string) (int) $context['revision_no'])
            ->keyValue('Finalized', self::formatManilaTime((string) $context['finalized_at']));

        if ($context['amended_at'] !== null) {
            $pdf->keyValue('Last amended', self::formatManilaTime((string) $context['amended_at']));
        }

        $pdf->keyValue('Redaction approved', self::formatManilaTime((string) $context['redaction_approved_at']))
            ->rule()
            ->heading('BLOTTER SUMMARY', 12.0)
            ->paragraph((string) $context['narrative_summary'])
            ->heading('APPROVED INCIDENT NARRATIVE', 12.0)
            ->paragraph((string) $context['redacted_narrative'])
            ->rule()
            ->paragraph(
                'This packet contains the human-approved redacted narrative and the '
                . 'finalized blotter summary for the case above. Personal identifiers have '
                . 'been removed under the Data Privacy Act (RA 10173); placeholders such as '
                . '[NAME] and [ADDRESS] mark where identifying details were withheld.'
            )
            ->paragraph('Generated ' . self::formatManilaTime(gmdate('Y-m-d H:i:s')) . ' (Asia/Manila).');

        return $pdf->render();
    }

    /**
     * §5: timestamps are stored in UTC, displayed in Asia/Manila. A legal
     * document showing UTC would misstate when things happened by 8 hours.
     */
    private static function formatManilaTime(string $utcTimestamp): string
    {
        try {
            $time = new \DateTimeImmutable($utcTimestamp, new \DateTimeZone('UTC'));
            return $time->setTimezone(new \DateTimeZone('Asia/Manila'))->format('d M Y, g:i A');
        } catch (\Throwable) {
            return $utcTimestamp;
        }
    }

    /**
     * Packets live under `backend/storage/lupon-packets/`, outside the web
     * root — the same placement `MAP_PACKAGE_DIR` uses, and required by
     * §5's "files are stored outside the public web root".
     */
    private static function packetPath(int $incidentId): string
    {
        $base = baranguard_env('LUPON_PACKET_DIR');
        $directory = ($base !== false && trim((string) $base) !== '')
            ? rtrim((string) $base, '/\\')
            : dirname(__DIR__) . '/storage/lupon-packets';

        return $directory . '/incident-' . $incidentId . '.pdf';
    }
}
