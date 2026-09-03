<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /incidents — Master Reference §6 "Incidents" section, §7 role
 * matrix ("View incident list": Admin/Secretary full, Tanod own only,
 * Punong Barangay read-only), §9 W3 (feeds the Dispatch Center's pending
 * queue via `status=pending`).
 *
 * The reference fixes the response item shape exactly (no raw narrative
 * in the list view — that's only ever returned by
 * `GET /incidents/:id` for Secretary) but leaves the `?...` query
 * params/pagination defaults to the global invariants in §6 (default
 * page size 25, max 100). Resolved decisions, logged in DEVLOG.md:
 *   - `status=` / `priority=` are optional exact-match filters against
 *     the §5 enum values; an unrecognized value is 400 VALIDATION_ERROR
 *     rather than silently matching nothing.
 *   - `page=` / `limit=` follow the same convention as
 *     `ReportsController` would if it paginated: 1-indexed page,
 *     default limit 25, hard cap 100.
 *   - Ordering is `created_at DESC` (newest first) — the reference
 *     doesn't state one, but a dispatch queue needs a stable, useful
 *     default rather than undefined row order.
 *
 * `create()` (W6 Electronic Blotter List's "new-entry form") adds
 * POST /incidents -- Section 6 Incidents, Section 7 role matrix
 * ("Web-side incident entry": Admin/Secretary only). Resolved decisions,
 * logged in DEVLOG.md:
 *   - Idempotency: Section 6 requires the Idempotency-Key UUID header for
 *     trusted web creation, with the server persisting that key and
 *     returning the original incident on replay. Mobile's own idempotency
 *     key is (device_id, client_event_id); a web write has no device_id
 *     (NULL), and MariaDB's nullable UNIQUE KEY (device_id,
 *     client_event_id) does not dedupe across NULL device_id rows (NULL
 *     is never equal to NULL in a unique index) -- Section 5's own schema
 *     note anticipates exactly this ("nullable composite UNIQUE
 *     constraints plus transactional checks are used where a partial
 *     constraint would otherwise be required"). So a web create stores
 *     the Idempotency-Key header value in client_event_id (same column,
 *     device_id stays NULL) and a check-then-insert inside one
 *     transaction supplies the "transactional check" half of that
 *     documented pattern, matching DispatchController::create()'s own
 *     replay-lookup-then-insert shape.
 *   - No priority field: Section 6's POST /incidents body is exactly
 *     {incident_type,raw_narrative,latitude,longitude,source?,
 *     device_offline_created_at?,client_event_id} -- no priority key. The
 *     schema defaults it to 'normal'; this endpoint never accepts one
 *     rather than inventing an unlisted field.
 *   - Response shape: not fixed by Section 6 beyond "creates pending
 *     incident with server created_at" -- returns the same redacted shape
 *     GET /incidents already uses (no raw narrative echoed back), for one
 *     consistent incident-item contract across both endpoints.
 *
 * MOBILE BRANCH (Sprint 3 cut — this was Sprint 2's own deferred "mobile
 * branch of POST /incidents" item; §6 documents the same POST /incidents
 * body/idempotency rule for BOTH web and mobile writers, distinguished by
 * role, not by a separate path). Resolved decisions, logged in DEVLOG.md:
 *   - §6 fixes the mobile idempotency key as "authenticated device_id +
 *     client_event_id" but the documented request body
 *     ({incident_type,raw_narrative,latitude,longitude,source?,
 *     device_offline_created_at?,client_event_id}) has no device_id field
 *     — it must come from somewhere other than the JSON body, since the
 *     JWT itself carries no device identity (AuthMiddleware's claims are
 *     user/role/barangay only). Resolved the same way the web path
 *     resolves its own idempotency key: a request header. A new
 *     `X-Device-Id` header carries it, mirroring the existing
 *     `Idempotency-Key` header precedent exactly. The server then
 *     verifies that device_id actually belongs to the calling Tanod
 *     (`mobile_device.user_id = caller`, `is_active=1`) before trusting
 *     it as part of the idempotency key or attaching it to the new row —
 *     this is the "authenticated" half of "authenticated device_id".
 *   - `createMobileItem()` is `public static` (not private) specifically
 *     so `SyncController::batch()` (POST /sync/batch, same Sprint 3 cut)
 *     can reuse the exact same validation/idempotency/insert logic for
 *     each `incidents[]` item — one incident-creation code path for both
 *     entry points, not two copies that could drift.
 *   - `source` is always written as `'app'` for this branch — §6: "client
 *     `source` is ignored" — matching the web branch's own hardcoded
 *     `'web'`.
 */
final class IncidentsController
{
    private const INCIDENT_STATUSES = ['pending', 'dispatched', 'resolved'];
    private const INCIDENT_PRIORITIES = ['normal', 'high', 'critical'];
    private const INCIDENT_TYPES = [
        'theft', 'physical_injury', 'disturbance', 'domestic_dispute',
        'vandalism', 'traffic_incident', 'fire', 'medical_emergency',
        'missing_person', 'animal_complaint', 'other',
    ];
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    // §6 "radius has a server maximum" for GET /incidents/nearby — not a
    // number the reference states, resolved here (logged in DEVLOG.md):
    // 2km default, 5km hard cap. A barangay is a small area; 5km already
    // spans well beyond one, so this is a safety ceiling, not a realistic
    // default search radius.
    private const NEARBY_DEFAULT_RADIUS_M = 2000;
    private const NEARBY_MAX_RADIUS_M = 5000;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'tanod', 'punong_barangay']);

        $status = Http::query('status');
        if ($status !== null && !in_array($status, self::INCIDENT_STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: ' . implode(', ', self::INCIDENT_STATUSES) . '.');
        }
        $priority = Http::query('priority');
        if ($priority !== null && !in_array($priority, self::INCIDENT_PRIORITIES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'priority must be one of: ' . implode(', ', self::INCIDENT_PRIORITIES) . '.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT);
        if ($limit < 1) {
            $limit = self::DEFAULT_LIMIT;
        }
        $limit = min($limit, self::MAX_LIMIT);
        $offset = ($page - 1) * $limit;

        // Qualified with i. throughout — the officer-name join below adds
        // `dispatch` (also has status/priority columns) and `user` (also
        // has barangay_id), so an unqualified column here would be
        // ambiguous rather than merely wrong.
        $where = ['i.barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];

        // §6: "Tanod forced to reported_by=me" — server-enforced, not a
        // client-supplied filter the caller could override.
        if ($identity['role'] === 'tanod') {
            $where[] = 'i.reported_by = :reported_by';
            $params['reported_by'] = $identity['user_id'];
        }
        if ($status !== null) {
            $where[] = 'i.status = :status';
            $params['status'] = $status;
        }
        if ($priority !== null) {
            $where[] = 'i.priority = :priority';
            $params['priority'] = $priority;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM incident i WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        // officer_name: the Tanod name off this incident's most recent
        // dispatch (any status, including cancelled — an incident that was
        // dispatched then cancelled still meaningfully had "an officer
        // handle it" for blotter purposes; a fresh, never-dispatched
        // incident correctly has none). §6's item shape for GET /incidents
        // doesn't list this field; added as W6 blotter-table plumbing, same
        // precedent as GET /users?role= being added for the Tanod picker.
        $stmt = $pdo->prepare(
            "SELECT i.incident_id, i.barangay_id, i.reported_by, i.incident_type, i.priority, i.status, i.source,
                    i.latitude, i.longitude, i.created_at, i.device_offline_created_at, i.synced_at,
                    tanod.full_name AS officer_name
             FROM incident i
             LEFT JOIN dispatch d ON d.dispatch_id = (
                 SELECT d2.dispatch_id FROM dispatch d2
                 WHERE d2.incident_id = i.incident_id
                 ORDER BY d2.dispatched_at DESC
                 LIMIT 1
             )
             LEFT JOIN user tanod ON tanod.user_id = d.tanod_id
             WHERE {$whereSql}
             ORDER BY i.created_at DESC
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
                'incident_id' => (int) $row['incident_id'],
                'barangay_id' => (int) $row['barangay_id'],
                'reported_by' => $row['reported_by'] !== null ? (int) $row['reported_by'] : null,
                'incident_type' => $row['incident_type'],
                'priority' => $row['priority'],
                'status' => $row['status'],
                'source' => $row['source'],
                'latitude' => $row['latitude'] !== null ? (float) $row['latitude'] : null,
                'longitude' => $row['longitude'] !== null ? (float) $row['longitude'] : null,
                'created_at' => $row['created_at'],
                'device_offline_created_at' => $row['device_offline_created_at'],
                'synced_at' => $row['synced_at'],
                'officer_name' => $row['officer_name'] ?? null,
            ];
        }, $rows);

        Http::send(200, [
            'items' => $items,
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }

    /**
     * GET /incidents/nearby — Tanod only (§6). Never raw narrative/contact
     * data; distance computed with a portable Haversine SQL expression
     * (MariaDB 10.4 has no guaranteed ST_Distance_Sphere), rounded to the
     * nearest metre server-side rather than handed back as a float with
     * spurious precision.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function nearby(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $latParam = Http::query('latitude');
        $lngParam = Http::query('longitude');
        if ($latParam === null || $lngParam === null || !is_numeric($latParam) || !is_numeric($lngParam)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude and longitude are required.');
        }
        $lat = (float) $latParam;
        $lng = (float) $lngParam;
        if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'latitude/longitude are out of range.');
        }

        $radiusParam = Http::query('radius_m');
        $radiusM = self::NEARBY_DEFAULT_RADIUS_M;
        if ($radiusParam !== null) {
            if (!ctype_digit($radiusParam)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'radius_m must be a positive integer.');
            }
            $radiusM = (int) $radiusParam;
        }
        if ($radiusM < 1 || $radiusM > self::NEARBY_MAX_RADIUS_M) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'radius_m must be between 1 and ' . self::NEARBY_MAX_RADIUS_M . '.');
        }

        $stmt = $pdo->prepare(
            'SELECT incident_id, incident_type, priority, status, latitude, longitude, created_at,
                    (6371000 * ACOS(
                        LEAST(1, GREATEST(-1,
                            COS(RADIANS(:lat)) * COS(RADIANS(latitude)) * COS(RADIANS(longitude) - RADIANS(:lng))
                            + SIN(RADIANS(:lat)) * SIN(RADIANS(latitude))
                        ))
                    )) AS distance_m
             FROM incident
             WHERE barangay_id = :barangay_id
               AND status != \'resolved\'
               AND latitude IS NOT NULL AND longitude IS NOT NULL
             HAVING distance_m <= :radius_m
             ORDER BY distance_m ASC
             LIMIT 100'
        );
        $stmt->bindValue(':lat', $lat);
        $stmt->bindValue(':lng', $lng);
        $stmt->bindValue(':barangay_id', $identity['barangay_id'], PDO::PARAM_INT);
        $stmt->bindValue(':radius_m', $radiusM, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $items = array_map(static function (array $row) use ($now): array {
            $createdAt = new \DateTimeImmutable($row['created_at'], new \DateTimeZone('UTC'));
            return [
                'incident_id' => (int) $row['incident_id'],
                'incident_type' => $row['incident_type'],
                'priority' => $row['priority'],
                'status' => $row['status'],
                'latitude' => (float) $row['latitude'],
                'longitude' => (float) $row['longitude'],
                'age_seconds' => $now->getTimestamp() - $createdAt->getTimestamp(),
            ];
        }, $rows);

        Http::send(200, ['items' => $items]);
    }

    /**
     * GET /incidents/:id — §6: "resource must belong to caller's
     * barangay. Secretary receives {incident_id,barangay_id,reported_by,
     * incident_type,raw_narrative,redacted_narrative,priority,status,
     * source,latitude,longitude,created_at,synced_at}; Admin/PB/Tanod
     * receive redacted allow-listed fields only, with Tanod additionally
     * requiring reporter or assigned-dispatch relationship."
     *
     * **This is the only endpoint in the system that returns
     * `raw_narrative`, and only to a Secretary.** §3 explains why the
     * higher-privileged Admin gets less here than the Secretary does: RA
     * 7160 §394(c) makes the Barangay Secretary the statutory custodian
     * of barangay records, so raw-narrative access follows the legal
     * custodian, not the system's privilege ladder. Do not "fix" that by
     * adding admin to the raw-narrative branch.
     *
     * Built in Sprint 6 because W8 (AI Redaction Review) shows raw vs
     * draft side by side and had no way to obtain the raw side.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function show(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'tanod', 'punong_barangay']);
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        // dispatched_at / arrived_at / has_active_dispatch are NOT in §6's
        // listed shape for this endpoint, and are added deliberately.
        //
        // §9 W7 requires a timeline containing `dispatched_at` and
        // `arrived_at`, and W7 is a SECRETARY screen — but §6's
        // `GET /dispatch` is Admin/PB/Tanod only, so a Secretary can never
        // read those timestamps from the dispatch endpoint (verified: it
        // returns 403). Without this the timeline would silently render
        // "Not yet" for stages that actually happened, which is precisely
        // the scripted/fabricated timeline §9 forbids.
        //
        // The alternative — widening `GET /dispatch`'s role list — was
        // rejected: it would hand the Secretary the whole dispatch record
        // (assignments, route, tanod ids) to obtain two timestamps §9 says
        // must be on screen. This is the narrower disclosure, and it is
        // about the caller's own barangay incident. `has_active_dispatch`
        // is derived, never a raw id, and exists so W7's Admin resolve
        // control can reflect §6's real precondition instead of guessing.
        $stmt = $pdo->prepare(
            "SELECT i.incident_id, i.barangay_id, i.reported_by, i.incident_type, i.priority, i.status, i.source,
                    i.latitude, i.longitude, i.created_at, i.device_offline_created_at, i.synced_at,
                    i.raw_narrative, i.redacted_narrative, i.redaction_approved_at, i.redaction_approved_by,
                    d.dispatched_at, d.arrived_at,
                    EXISTS (
                        SELECT 1 FROM dispatch da
                        WHERE da.incident_id = i.incident_id
                          AND da.status IN ('assigned','en_route','arrived')
                    ) AS has_active_dispatch
             FROM incident i
             LEFT JOIN dispatch d ON d.dispatch_id = (
                 SELECT d2.dispatch_id FROM dispatch d2
                 WHERE d2.incident_id = i.incident_id
                 ORDER BY d2.dispatched_at DESC
                 LIMIT 1
             )
             WHERE i.incident_id = :incident_id"
        );
        $stmt->execute(['incident_id' => $incidentId]);
        $incident = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($incident === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        // Tenant check before any disclosure (§2 Rule 6/30).
        AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);

        // §6/§7: a Tanod may only read an incident they reported or were
        // dispatched to. 404 rather than 403 — the existence of another
        // Tanod's incident is itself information they aren't entitled to.
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

        $payload = [
            'incident_id' => (int) $incident['incident_id'],
            'barangay_id' => (int) $incident['barangay_id'],
            'reported_by' => $incident['reported_by'] !== null ? (int) $incident['reported_by'] : null,
            'incident_type' => $incident['incident_type'],
            'priority' => $incident['priority'],
            'status' => $incident['status'],
            'source' => $incident['source'],
            'latitude' => $incident['latitude'] !== null ? (float) $incident['latitude'] : null,
            'longitude' => $incident['longitude'] !== null ? (float) $incident['longitude'] : null,
            'created_at' => $incident['created_at'],
            'device_offline_created_at' => $incident['device_offline_created_at'],
            'synced_at' => $incident['synced_at'],
            // The approved redaction is readable by every role §7 allows
            // to view an incident — approval is what makes it shareable.
            'redacted_narrative' => $incident['redacted_narrative'],
            'redaction_approved_at' => $incident['redaction_approved_at'],
            'redaction_approved_by' => $incident['redaction_approved_by'] !== null
                ? (int) $incident['redaction_approved_by']
                : null,
            // See the query comment above for why these three are here.
            'dispatched_at' => $incident['dispatched_at'],
            'arrived_at' => $incident['arrived_at'],
            'has_active_dispatch' => (bool) $incident['has_active_dispatch'],
        ];

        // The one raw-narrative disclosure in the system. Added LAST and
        // only for the Secretary, so the allow-listed payload above is the
        // default and raw access is the explicit exception.
        if ($identity['role'] === 'secretary') {
            $payload['raw_narrative'] = $incident['raw_narrative'];
        }

        Http::send(200, $payload);
    }

    /**
     * GET /incidents/:id/evidence — §6: "Secretary/Admin same barangay;
     * Tanod only if `incident.reported_by = caller.user_id` OR the caller
     * has/had a dispatch for that incident; same-barangay check applies
     * first. **Never returns filesystem paths.**"
     *
     * That last rule is why `file_path` is absent from the response shape
     * below even though it is the most obvious column on the table: a path
     * is an invitation to fetch the file directly, and §5 keeps evidence
     * outside the web root precisely so that cannot work. Sprint 7's
     * download endpoint will serve bytes through an authorization check,
     * not a path.
     *
     * Punong Barangay is NOT in the role list — §6 names only
     * Secretary/Admin/Tanod for this endpoint, and PB's access elsewhere
     * is "redacted read-only", which evidence files are not.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function evidence(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'tanod']);
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        $incidentStmt = $pdo->prepare('SELECT incident_id, barangay_id FROM incident WHERE incident_id = :incident_id');
        $incidentStmt->execute(['incident_id' => $incidentId]);
        $incident = $incidentStmt->fetch(PDO::FETCH_ASSOC);
        if ($incident === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        // §6: "same-barangay check applies FIRST".
        AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);

        if ($identity['role'] === 'tanod' && !self::tanodMayAccess($pdo, $incidentId, $identity['user_id'])) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }

        $stmt = $pdo->prepare(
            'SELECT attachment_id, incident_id, type, uploaded_by, uploaded_at, sha256,
                    byte_size, mime_type, original_filename
             FROM evidence_attachment
             WHERE incident_id = :incident_id
             ORDER BY uploaded_at ASC'
        );
        $stmt->execute(['incident_id' => $incidentId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'attachment_id' => (int) $row['attachment_id'],
                'incident_id' => (int) $row['incident_id'],
                'type' => $row['type'],
                'uploaded_by' => (int) $row['uploaded_by'],
                'uploaded_at' => $row['uploaded_at'],
                'sha256' => $row['sha256'],
                'byte_size' => (int) $row['byte_size'],
                'mime_type' => $row['mime_type'],
                'original_filename' => $row['original_filename'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items]);
    }

    /**
     * PATCH /incidents/:id/status — §6: "Admin only; resource must be
     * same-barangay. Body is exactly {status:"resolved"}. Returns 409
     * unless current incident is `dispatched` and has no active dispatch
     * (assigned/en_route/arrived). A repeated resolve after the incident is
     * already resolved returns 409 with CONFLICT rather than mutating the
     * record a second time."
     *
     * "Body is exactly {status:'resolved'}" is enforced literally: this is
     * not a general status-setter, and accepting any other target would let
     * an Admin walk an incident backwards out of `dispatched`, which §5's
     * state model does not allow outside dispatch cancellation.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function updateStatus(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        $body = Http::jsonBody();
        $status = $body['status'] ?? null;
        if ($status !== 'resolved') {
            throw new ApiError(400, 'VALIDATION_ERROR', "status must be exactly 'resolved'.");
        }

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'SELECT incident_id, barangay_id, status FROM incident WHERE incident_id = :incident_id FOR UPDATE'
            );
            $stmt->execute(['incident_id' => $incidentId]);
            $incident = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($incident === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);

            // Covers the repeated-resolve case too: an already-resolved
            // incident is not `dispatched`, so it falls here with 409.
            if ($incident['status'] !== 'dispatched') {
                throw new ApiError(409, 'CONFLICT', 'Only a dispatched incident can be resolved.');
            }

            $activeStmt = $pdo->prepare(
                "SELECT dispatch_id FROM dispatch
                 WHERE incident_id = :incident_id AND status IN ('assigned','en_route','arrived')
                 LIMIT 1"
            );
            $activeStmt->execute(['incident_id' => $incidentId]);
            if ($activeStmt->fetch(PDO::FETCH_ASSOC) !== false) {
                throw new ApiError(409, 'CONFLICT', 'This incident still has an active dispatch; complete or cancel it first.');
            }

            $updateStmt = $pdo->prepare(
                "UPDATE incident SET status = 'resolved', updated_at = UTC_TIMESTAMP() WHERE incident_id = :incident_id"
            );
            $updateStmt->execute(['incident_id' => $incidentId]);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'incident_resolved', 'incident', $incidentId, [
                'from_status' => $incident['status'],
                'to_status' => 'resolved',
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, ['incident_id' => $incidentId, 'status' => 'resolved']);
    }

    /**
     * §6/§7's Tanod relationship rule, in one place: a Tanod may reach an
     * incident they reported, or one they have (or had) a dispatch for.
     */
    private static function tanodMayAccess(PDO $pdo, int $incidentId, int $userId): bool
    {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM incident i
             WHERE i.incident_id = :incident_id
               AND (i.reported_by = :user_id
                    OR EXISTS (SELECT 1 FROM dispatch d WHERE d.incident_id = i.incident_id AND d.tanod_id = :user_id2))
             LIMIT 1'
        );
        $stmt->execute(['incident_id' => $incidentId, 'user_id' => $userId, 'user_id2' => $userId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'tanod']);

        if ($identity['role'] === 'tanod') {
            self::createMobile($pdo, $identity);
            return;
        }

        self::createWeb($pdo, $identity);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    private static function createWeb(PDO $pdo, array $identity): void
    {
        $idempotencyKey = Http::header('Idempotency-Key');
        if ($idempotencyKey === null || !preg_match(self::UUID_PATTERN, $idempotencyKey)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID.');
        }

        $body = Http::jsonBody();
        $incidentType = $body['incident_type'] ?? null;
        $rawNarrative = $body['raw_narrative'] ?? null;
        $latitude = $body['latitude'] ?? null;
        $longitude = $body['longitude'] ?? null;

        if (!is_string($incidentType) || !in_array($incidentType, self::INCIDENT_TYPES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'incident_type must be one of: ' . implode(', ', self::INCIDENT_TYPES) . '.');
        }
        if (!is_string($rawNarrative) || trim($rawNarrative) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'raw_narrative is required.');
        }
        [$latitude, $longitude] = self::validateCoordinates($latitude, $longitude);

        // Idempotent replay lookup -- see class doc for why this is keyed
        // on (barangay_id, device_id IS NULL, client_event_id) rather than
        // relying on the nullable UNIQUE KEY alone.
        $existingStmt = $pdo->prepare(
            'SELECT incident_id, barangay_id, reported_by, incident_type, priority, status, source,
                    latitude, longitude, created_at, device_offline_created_at, synced_at
             FROM incident
             WHERE barangay_id = :barangay_id AND device_id IS NULL AND client_event_id = :idempotency_key
             LIMIT 1'
        );
        $existingStmt->execute(['barangay_id' => $identity['barangay_id'], 'idempotency_key' => $idempotencyKey]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            Http::send(200, self::mapIncident($existing));
        }

        $pdo->beginTransaction();
        try {
            // Re-check inside the transaction to close (not eliminate --
            // see class doc's note on the schema's own documented
            // nullable-UNIQUE-plus-transactional-check pattern) the race
            // between the lookup above and this insert.
            $recheckStmt = $pdo->prepare(
                'SELECT incident_id FROM incident
                 WHERE barangay_id = :barangay_id AND device_id IS NULL AND client_event_id = :idempotency_key
                 LIMIT 1 FOR UPDATE'
            );
            $recheckStmt->execute(['barangay_id' => $identity['barangay_id'], 'idempotency_key' => $idempotencyKey]);
            if ($recheckStmt->fetch(PDO::FETCH_ASSOC) !== false) {
                $pdo->rollBack();
                $existingStmt->execute(['barangay_id' => $identity['barangay_id'], 'idempotency_key' => $idempotencyKey]);
                Http::send(200, self::mapIncident($existingStmt->fetch(PDO::FETCH_ASSOC)));
            }

            $insertStmt = $pdo->prepare(
                "INSERT INTO incident
                    (barangay_id, reported_by, device_id, incident_type, priority, raw_narrative, status, source,
                     latitude, longitude, created_at, client_event_id, updated_at)
                 VALUES
                    (:barangay_id, :reported_by, NULL, :incident_type, 'normal', :raw_narrative, 'pending', 'web',
                     :latitude, :longitude, UTC_TIMESTAMP(), :idempotency_key, UTC_TIMESTAMP())"
            );
            $insertStmt->execute([
                'barangay_id' => $identity['barangay_id'],
                'reported_by' => $identity['user_id'],
                'incident_type' => $incidentType,
                'raw_narrative' => $rawNarrative,
                'latitude' => $latitude,
                'longitude' => $longitude,
                'idempotency_key' => $idempotencyKey,
            ]);
            $incidentId = (int) $pdo->lastInsertId();

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $readBackStmt = $pdo->prepare(
            'SELECT incident_id, barangay_id, reported_by, incident_type, priority, status, source,
                    latitude, longitude, created_at, device_offline_created_at, synced_at
             FROM incident WHERE incident_id = :incident_id'
        );
        $readBackStmt->execute(['incident_id' => $incidentId]);
        Http::send(201, self::mapIncident($readBackStmt->fetch(PDO::FETCH_ASSOC)));
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    private static function createMobile(PDO $pdo, array $identity): void
    {
        $deviceId = Http::header('X-Device-Id');
        if ($deviceId === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'X-Device-Id header is required.');
        }

        $body = Http::jsonBody();
        $result = self::createMobileItem($pdo, $identity, $deviceId, $body);
        Http::send($result['wasCreated'] ? 201 : 200, $result['incident']);
    }

    /**
     * Core mobile incident-creation logic. `public` so
     * `SyncController::batch()` (POST /sync/batch's `incidents[]` items)
     * reuses the exact same validation/idempotency/insert path rather than
     * a second copy that could drift — see class doc's "MOBILE BRANCH"
     * note.
     *
     * @param array<string,mixed> $item body fields, same shape §6 documents
     *        for POST /incidents (mobile): {incident_type,raw_narrative,
     *        latitude,longitude,source?,device_offline_created_at?,
     *        client_event_id}.
     * @param string $source §5 `incident.source` ENUM('app','sms','web').
     *        Defaults to 'app' for the direct-POST and /sync/batch callers
     *        (unchanged behaviour); `SmsGatewayService`'s
     *        `/sms/incident-fallback` handler is the one caller that
     *        passes 'sms' — an incident reconstructed from an encrypted
     *        SMS envelope is honestly NOT the same source as one captured
     *        through the app, and §9/§6 elsewhere already distinguish
     *        `source` for exactly this kind of provenance tracking.
     * @return array{incident: array<string,mixed>, wasCreated: bool}
     */
    public static function createMobileItem(PDO $pdo, array $identity, string $deviceId, array $item, string $source = 'app'): array
    {
        self::assertDeviceOwnership($pdo, $identity, $deviceId);

        $incidentType = $item['incident_type'] ?? null;
        $rawNarrative = $item['raw_narrative'] ?? null;
        $latitude = $item['latitude'] ?? null;
        $longitude = $item['longitude'] ?? null;
        $clientEventId = $item['client_event_id'] ?? null;
        $deviceOfflineCreatedAtRaw = $item['device_offline_created_at'] ?? null;

        if (!is_string($clientEventId) || !preg_match(self::UUID_PATTERN, $clientEventId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
        }
        if (!is_string($incidentType) || !in_array($incidentType, self::INCIDENT_TYPES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'incident_type must be one of: ' . implode(', ', self::INCIDENT_TYPES) . '.');
        }
        if (!is_string($rawNarrative) || trim($rawNarrative) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'raw_narrative is required.');
        }
        [$latitude, $longitude] = self::validateCoordinates($latitude, $longitude);

        $deviceOfflineCreatedAt = null;
        if ($deviceOfflineCreatedAtRaw !== null) {
            if (!is_string($deviceOfflineCreatedAtRaw) || strtotime($deviceOfflineCreatedAtRaw) === false) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'device_offline_created_at must be a valid timestamp.');
            }
            $deviceOfflineCreatedAt = gmdate('Y-m-d H:i:s', (int) strtotime($deviceOfflineCreatedAtRaw));
        }

        // §5 UNIQUE(device_id, client_event_id) — same replay-lookup-then-
        // insert shape as the web path's own idempotency check above.
        $existingStmt = $pdo->prepare(
            'SELECT incident_id, barangay_id, reported_by, incident_type, priority, status, source,
                    latitude, longitude, created_at, device_offline_created_at, synced_at
             FROM incident WHERE device_id = :device_id AND client_event_id = :client_event_id LIMIT 1'
        );
        $existingStmt->execute(['device_id' => $deviceId, 'client_event_id' => $clientEventId]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            return ['incident' => self::mapIncident($existing), 'wasCreated' => false];
        }

        $pdo->beginTransaction();
        try {
            $recheckStmt = $pdo->prepare(
                'SELECT incident_id FROM incident WHERE device_id = :device_id AND client_event_id = :client_event_id LIMIT 1 FOR UPDATE'
            );
            $recheckStmt->execute(['device_id' => $deviceId, 'client_event_id' => $clientEventId]);
            if ($recheckStmt->fetch(PDO::FETCH_ASSOC) !== false) {
                $pdo->rollBack();
                $existingStmt->execute(['device_id' => $deviceId, 'client_event_id' => $clientEventId]);
                return ['incident' => self::mapIncident($existingStmt->fetch(PDO::FETCH_ASSOC)), 'wasCreated' => false];
            }

            $insertStmt = $pdo->prepare(
                "INSERT INTO incident
                    (barangay_id, reported_by, device_id, incident_type, priority, raw_narrative, status, source,
                     latitude, longitude, created_at, device_offline_created_at, client_event_id, updated_at)
                 VALUES
                    (:barangay_id, :reported_by, :device_id, :incident_type, 'normal', :raw_narrative, 'pending', :source,
                     :latitude, :longitude, UTC_TIMESTAMP(), :device_offline_created_at, :client_event_id, UTC_TIMESTAMP())"
            );
            $insertStmt->execute([
                'barangay_id' => $identity['barangay_id'],
                'reported_by' => $identity['user_id'],
                'device_id' => $deviceId,
                'incident_type' => $incidentType,
                'raw_narrative' => $rawNarrative,
                'source' => in_array($source, ['app', 'sms', 'web'], true) ? $source : 'app',
                'latitude' => $latitude,
                'longitude' => $longitude,
                'device_offline_created_at' => $deviceOfflineCreatedAt,
                'client_event_id' => $clientEventId,
            ]);
            $incidentId = (int) $pdo->lastInsertId();
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $readBackStmt = $pdo->prepare(
            'SELECT incident_id, barangay_id, reported_by, incident_type, priority, status, source,
                    latitude, longitude, created_at, device_offline_created_at, synced_at
             FROM incident WHERE incident_id = :incident_id'
        );
        $readBackStmt->execute(['incident_id' => $incidentId]);
        return ['incident' => self::mapIncident($readBackStmt->fetch(PDO::FETCH_ASSOC)), 'wasCreated' => true];
    }

    /**
     * The "authenticated" half of "authenticated device_id + client_event_id"
     * (§6) — a caller cannot claim an arbitrary device_id string as its own
     * idempotency namespace without it actually being a device this Tanod
     * registered. Same generic-422 pattern DispatchController uses for a
     * bad tanod_id, so the error message can't be used to enumerate device
     * ids belonging to other accounts.
     */
    private static function assertDeviceOwnership(PDO $pdo, array $identity, string $deviceId): void
    {
        $stmt = $pdo->prepare(
            'SELECT device_id FROM mobile_device WHERE device_id = :device_id AND user_id = :user_id AND is_active = 1 LIMIT 1'
        );
        $stmt->execute(['device_id' => $deviceId, 'user_id' => $identity['user_id']]);
        if ($stmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'Device is not registered or not active for this account.');
        }
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapIncident(array $row): array
    {
        return [
            'incident_id' => (int) $row['incident_id'],
            'barangay_id' => (int) $row['barangay_id'],
            'reported_by' => $row['reported_by'] !== null ? (int) $row['reported_by'] : null,
            'incident_type' => $row['incident_type'],
            'priority' => $row['priority'],
            'status' => $row['status'],
            'source' => $row['source'],
            'latitude' => $row['latitude'] !== null ? (float) $row['latitude'] : null,
            'longitude' => $row['longitude'] !== null ? (float) $row['longitude'] : null,
            'created_at' => $row['created_at'],
            'device_offline_created_at' => $row['device_offline_created_at'],
            'synced_at' => $row['synced_at'],
            // create()'s callers never join dispatch — a just-created
            // incident can't have one yet — so this is always null here,
            // same shape as index()'s items for a one-consistent contract.
            'officer_name' => $row['officer_name'] ?? null,
        ];
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
