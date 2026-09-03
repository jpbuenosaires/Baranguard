<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Dispatch — Master Reference §6 "Dispatch" section, §5 `dispatch` table,
 * §7 role matrix (create/cancel/override: Admin only; Tanod: own
 * assigned only — not reachable yet, no Tanod app exists), §9 W3
 * Dispatch Center (create/cancel are this session's W3b box; the
 * read-only queue/list side is W3a).
 *
 * Two things §6 describes in prose but doesn't fully pin down, resolved
 * here and logged in DEVLOG.md:
 *   - **Notification creation is explicitly NOT done here.** §6 says
 *     dispatch creation "records notification creation," but the
 *     notification/notification_target/notification_delivery data model
 *     and FCM/SMS transports are their own separate, not-yet-built
 *     Sprint 4 "Today's cut" boxes (see Sprint_Prompts.md). Writing a
 *     bare `notification` row now, with no transport able to attempt
 *     delivery, would jump ahead of that dependency chain and risk
 *     getting the notification entity-integrity matrix (§5) wrong before
 *     Sprint 4 actually designs it. Deliberately deferred, not a silent
 *     gap.
 *   - **OSRM is not wired up.** Every new dispatch gets
 *     `route_status="unavailable"` and `route_json=NULL` — §6 already
 *     documents this as an acceptable outcome ("OSRM failure does not
 *     roll back dispatch creation"), it just doesn't say what to do when
 *     OSRM was never attempted because no self-hosted OSRM instance
 *     exists in this environment yet. Treated identically to an OSRM
 *     failure.
 *   - **Tanod eligibility ("on-duty")** means the Tanod's most recent
 *     `duty_status` row (by `changed_at`) is exactly `on_duty` —
 *     `responding` is excluded (already engaged elsewhere) and so is
 *     `off_duty`. No prior duty_status row at all means not eligible.
 *   - **Validation error shape.** To avoid leaking cross-tenant/role
 *     details through error-message differences, every reason a
 *     `tanod_id` is unusable (doesn't exist, wrong barangay, wrong role,
 *     inactive, not on-duty) collapses into the same generic 422
 *     message. Incident-not-found/wrong-barangay uses the same 404
 *     pattern as `AuthMiddleware::requireTenant()` elsewhere in this
 *     codebase.
 *   - **`GET /dispatch`'s item shape gained `incident_type`/`latitude`/
 *     `longitude`** (Sprint 3 cut) — §6's documented shape doesn't list
 *     them, but M5 Assignments List / M6 Assignment Detail have no other
 *     redacted-safe way to know what/where a cached assignment is. Same
 *     precedent as `GET /incidents`'s own `officer_name` addition; never
 *     raw_narrative, and these two fields are already exposed to a Tanod
 *     via `GET /incidents`'s own list item shape.
 */
final class DispatchController
{
    private const DISPATCH_STATUSES = ['assigned', 'en_route', 'arrived', 'completed', 'cancelled'];
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    // §6 PATCH /dispatch/:id/status: "Allowed transitions only:
    // assigned->en_route, en_route->arrived, arrived->completed." This is
    // the single source of truth for that matrix — M6's mobile status
    // buttons, the direct PATCH endpoint, and SyncController's
    // dispatch_status_updates[] items all defer to applyStatusTransition()
    // below rather than re-deriving this table.
    private const STATUS_TRANSITIONS = [
        'assigned' => 'en_route',
        'en_route' => 'arrived',
        'arrived' => 'completed',
    ];

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $body = Http::jsonBody();
        $incidentId = $body['incident_id'] ?? null;
        $tanodId = $body['tanod_id'] ?? null;
        $requestId = $body['request_id'] ?? null;

        if (!is_int($incidentId) && !(is_string($incidentId) && ctype_digit($incidentId))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'incident_id is required.');
        }
        if (!is_int($tanodId) && !(is_string($tanodId) && ctype_digit($tanodId))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'tanod_id is required.');
        }
        if (!is_string($requestId) || !preg_match(self::UUID_PATTERN, $requestId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'request_id must be a UUID.');
        }
        $incidentId = (int) $incidentId;
        $tanodId = (int) $tanodId;

        // Idempotency: a retry with the same request_id returns the
        // original dispatch instead of creating a duplicate (§6).
        $existingStmt = $pdo->prepare(
            'SELECT d.dispatch_id, d.status, d.incident_id, d.route_status
             FROM dispatch d
             JOIN incident i ON i.incident_id = d.incident_id
             WHERE d.created_client_request_id = :request_id AND i.barangay_id = :barangay_id
             LIMIT 1'
        );
        $existingStmt->execute(['request_id' => $requestId, 'barangay_id' => $identity['barangay_id']]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            Http::send(200, [
                'dispatch_id' => (int) $existing['dispatch_id'],
                'status' => $existing['status'],
                'incident_id' => (int) $existing['incident_id'],
                'route_status' => $existing['route_status'],
            ]);
        }

        $pdo->beginTransaction();
        try {
            // Lock the incident row first — this is what makes "at most
            // one active dispatch per incident" (§5) safe under
            // concurrent requests, not just the status check below.
            $incidentStmt = $pdo->prepare(
                'SELECT incident_id, barangay_id, status, priority FROM incident WHERE incident_id = :incident_id FOR UPDATE'
            );
            $incidentStmt->execute(['incident_id' => $incidentId]);
            $incident = $incidentStmt->fetch(PDO::FETCH_ASSOC);
            if ($incident === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);
            if ($incident['status'] !== 'pending') {
                throw new ApiError(409, 'CONFLICT', 'Incident is not pending — it may already be dispatched or resolved.');
            }

            $tanodStmt = $pdo->prepare(
                "SELECT u.user_id
                 FROM user u
                 WHERE u.user_id = :tanod_id AND u.barangay_id = :barangay_id
                   AND u.role = 'tanod' AND u.is_active = 1
                   AND EXISTS (
                       SELECT 1 FROM duty_status ds
                       WHERE ds.user_id = u.user_id AND ds.status = 'on_duty'
                         AND ds.changed_at = (SELECT MAX(ds2.changed_at) FROM duty_status ds2 WHERE ds2.user_id = u.user_id)
                   )
                 LIMIT 1"
            );
            $tanodStmt->execute(['tanod_id' => $tanodId, 'barangay_id' => $identity['barangay_id']]);
            if ($tanodStmt->fetch(PDO::FETCH_ASSOC) === false) {
                throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'The selected Tanod is not available for assignment.');
            }

            $insertStmt = $pdo->prepare(
                'INSERT INTO dispatch
                    (incident_id, dispatched_by, tanod_id, priority, route_json, route_status, status, dispatched_at, created_client_request_id)
                 VALUES
                    (:incident_id, :dispatched_by, :tanod_id, :priority, NULL, :route_status, :status, UTC_TIMESTAMP(), :request_id)'
            );
            $insertStmt->execute([
                'incident_id' => $incidentId,
                'dispatched_by' => $identity['user_id'],
                'tanod_id' => $tanodId,
                'priority' => $incident['priority'],
                'route_status' => 'unavailable', // No self-hosted OSRM in this environment yet — see class doc.
                'status' => 'assigned',
                'request_id' => $requestId,
            ]);
            $dispatchId = (int) $pdo->lastInsertId();

            $updateIncidentStmt = $pdo->prepare(
                "UPDATE incident SET status = 'dispatched', updated_at = UTC_TIMESTAMP() WHERE incident_id = :incident_id"
            );
            $updateIncidentStmt->execute(['incident_id' => $incidentId]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(201, [
            'dispatch_id' => $dispatchId,
            'status' => 'assigned',
            'incident_id' => $incidentId,
            'route_status' => 'unavailable',
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'tanod', 'punong_barangay']);

        $status = Http::query('status');
        if ($status !== null && !in_array($status, self::DISPATCH_STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: ' . implode(', ', self::DISPATCH_STATUSES) . '.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT);
        if ($limit < 1) {
            $limit = self::DEFAULT_LIMIT;
        }
        $limit = min($limit, self::MAX_LIMIT);
        $offset = ($page - 1) * $limit;

        $where = ['i.barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];

        // §6: Tanod is forced to own tanod_id and same barangay.
        if ($identity['role'] === 'tanod') {
            $where[] = 'd.tanod_id = :tanod_id';
            $params['tanod_id'] = $identity['user_id'];
        }
        if ($status !== null) {
            $where[] = 'd.status = :status';
            $params['status'] = $status;
        }
        // `incident_id` filter (Sprint 6 addition, not in §6's listed query
        // params): W7's timeline needs this incident's dispatched_at and
        // arrived_at, which §9 names as required timeline stages, and W7's
        // Admin resolve button needs to know whether an active dispatch
        // still exists. Filtering an already-tenant-scoped list is strictly
        // narrower than the unfiltered call the caller could already make —
        // it discloses nothing new.
        $incidentIdParam = Http::query('incident_id');
        if ($incidentIdParam !== null) {
            if (!ctype_digit($incidentIdParam)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'incident_id must be numeric.');
            }
            $where[] = 'd.incident_id = :incident_id';
            $params['incident_id'] = (int) $incidentIdParam;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM dispatch d JOIN incident i ON i.incident_id = d.incident_id WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        // incident_type/latitude/longitude: §6's documented GET /dispatch
        // item shape doesn't list these, but without them Sprint 3's M5
        // Assignments List / M6 Assignment Detail have no redacted-safe
        // way to show what/where a cached assignment even is — the same
        // "necessary plumbing beyond the literal spec" precedent as
        // GET /incidents' own officer_name addition. Never raw_narrative;
        // incident_type/coordinates are already exposed to a Tanod via
        // GET /incidents' own list item shape, so this adds no new
        // disclosure, just reaches it from the dispatch side too.
        $stmt = $pdo->prepare(
            "SELECT d.dispatch_id, d.incident_id, d.tanod_id, d.priority, d.route_json, d.route_status,
                    d.status, d.dispatched_at, d.en_route_at, d.arrived_at, d.completed_at, d.cancelled_at,
                    i.incident_type, i.latitude, i.longitude
             FROM dispatch d
             JOIN incident i ON i.incident_id = d.incident_id
             WHERE {$whereSql}
             ORDER BY d.dispatched_at DESC
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
                'dispatch_id' => (int) $row['dispatch_id'],
                'incident_id' => (int) $row['incident_id'],
                'tanod_id' => (int) $row['tanod_id'],
                'priority' => $row['priority'],
                'route_json' => $row['route_json'] !== null ? json_decode((string) $row['route_json'], true) : null,
                'route_status' => $row['route_status'],
                'status' => $row['status'],
                'incident_type' => $row['incident_type'],
                'latitude' => $row['latitude'] !== null ? (float) $row['latitude'] : null,
                'longitude' => $row['longitude'] !== null ? (float) $row['longitude'] : null,
                'dispatched_at' => $row['dispatched_at'],
                'en_route_at' => $row['en_route_at'],
                'arrived_at' => $row['arrived_at'],
                'completed_at' => $row['completed_at'],
                'cancelled_at' => $row['cancelled_at'],
            ];
        }, $rows);

        Http::send(200, [
            'items' => $items,
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function cancel(PDO $pdo, array $identity, string $dispatchIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        if (!ctype_digit($dispatchIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Dispatch not found.');
        }
        $dispatchId = (int) $dispatchIdParam;

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'SELECT d.dispatch_id, d.incident_id, d.status, i.barangay_id
                 FROM dispatch d
                 JOIN incident i ON i.incident_id = d.incident_id
                 WHERE d.dispatch_id = :dispatch_id
                 FOR UPDATE'
            );
            $stmt->execute(['dispatch_id' => $dispatchId]);
            $dispatch = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($dispatch === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Dispatch not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $dispatch['barangay_id']);

            // §6/§5: only assigned/en_route may be cancelled; cannot
            // cancel arrived/completed (§5 Rule 28's non-destructive
            // cancellation, and §5's own "cannot cancel arrived/
            // completed" note).
            if (!in_array($dispatch['status'], ['assigned', 'en_route'], true)) {
                throw new ApiError(409, 'CONFLICT', 'Only an assigned or en-route dispatch can be cancelled.');
            }

            $cancelStmt = $pdo->prepare(
                "UPDATE dispatch
                 SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(), cancelled_by = :cancelled_by
                 WHERE dispatch_id = :dispatch_id"
            );
            $cancelStmt->execute(['cancelled_by' => $identity['user_id'], 'dispatch_id' => $dispatchId]);

            // §5 Rule 21/28: dispatched -> pending only through valid
            // cancellation before arrival — this is that transition.
            $revertStmt = $pdo->prepare(
                "UPDATE incident SET status = 'pending', updated_at = UTC_TIMESTAMP()
                 WHERE incident_id = :incident_id AND status = 'dispatched'"
            );
            $revertStmt->execute(['incident_id' => $dispatch['incident_id']]);

            // Read the server-assigned timestamp back rather than
            // approximating it in PHP (gmdate() could drift a second
            // from the DB's UTC_TIMESTAMP() under load).
            $readBackStmt = $pdo->prepare('SELECT cancelled_at FROM dispatch WHERE dispatch_id = :dispatch_id');
            $readBackStmt->execute(['dispatch_id' => $dispatchId]);
            $cancelledAt = $readBackStmt->fetchColumn();

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, [
            'dispatch_id' => $dispatchId,
            'status' => 'cancelled',
            'incident_id' => (int) $dispatch['incident_id'],
            'incident_status' => 'pending',
            'cancelled_at' => $cancelledAt,
        ]);
    }

    /**
     * PATCH /dispatch/:id/status (Sprint 3 cut) — §6: "Tanod own assigned
     * dispatch or Admin override. Allowed transitions only:
     * assigned->en_route, en_route->arrived, arrived->completed. Admin
     * corrections require explicit override_reason and audit event."
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function updateStatus(PDO $pdo, array $identity, string $dispatchIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'tanod']);
        if (!ctype_digit($dispatchIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Dispatch not found.');
        }
        $dispatchId = (int) $dispatchIdParam;

        $body = Http::jsonBody();
        $newStatus = $body['status'] ?? null;
        $overrideReason = $body['override_reason'] ?? null;

        $result = self::applyStatusTransition($pdo, $identity, $dispatchId, $newStatus, $overrideReason);
        Http::send(200, $result);
    }

    /**
     * Core status-transition logic, shared by the direct PATCH endpoint
     * above and `SyncController::batch()`'s `dispatch_status_updates[]`
     * items (which always call this as the owning Tanod, `$overrideReason`
     * null — a sync item can never carry Admin override authority).
     *
     * §6's transition rule applies identically to both roles — the only
     * difference is WHO may invoke it without extra authority: a Tanod may
     * only move their OWN assigned dispatch through the matrix; an Admin
     * may move ANY same-barangay dispatch through it too, but must supply
     * `override_reason` (audited) since they are not the assigned party.
     * Neither role may reach any state outside `STATUS_TRANSITIONS` from
     * here — `cancelled` and reversing `completed` are deliberately
     * unreachable through this endpoint (§5 Rule 28; use
     * `PATCH /dispatch/:id/cancel` instead, which has its own tighter
     * rules).
     *
     * @return array{dispatch_id:int,status:string,updated_at:string}
     */
    public static function applyStatusTransition(PDO $pdo, array $identity, int $dispatchId, mixed $newStatus, mixed $overrideReason): array
    {
        if (!is_string($newStatus) || !in_array($newStatus, ['en_route', 'arrived', 'completed'], true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: en_route, arrived, completed.');
        }

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'SELECT d.dispatch_id, d.tanod_id, d.status, i.barangay_id
                 FROM dispatch d
                 JOIN incident i ON i.incident_id = d.incident_id
                 WHERE d.dispatch_id = :dispatch_id
                 FOR UPDATE'
            );
            $stmt->execute(['dispatch_id' => $dispatchId]);
            $dispatch = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($dispatch === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Dispatch not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $dispatch['barangay_id']);

            $isAdmin = $identity['role'] === 'admin';
            $isOwnTanod = $identity['role'] === 'tanod' && (int) $dispatch['tanod_id'] === $identity['user_id'];
            if (!$isAdmin && !$isOwnTanod) {
                throw new ApiError(403, 'FORBIDDEN', 'This role cannot perform this action.');
            }

            $currentStatus = $dispatch['status'];
            $expectedNext = self::STATUS_TRANSITIONS[$currentStatus] ?? null;
            if ($expectedNext === null || $newStatus !== $expectedNext) {
                throw new ApiError(409, 'CONFLICT', "Cannot transition from {$currentStatus} to {$newStatus}.");
            }

            if ($isAdmin) {
                // §6: "Admin corrections require explicit override_reason
                // and audit event" — an Admin is never the assigned Tanod,
                // so every Admin-initiated move through this endpoint
                // needs one.
                if (!is_string($overrideReason) || trim($overrideReason) === '') {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'override_reason is required for an Admin-initiated status change.');
                }
            }

            $timestampColumn = [
                'en_route' => 'en_route_at',
                'arrived' => 'arrived_at',
                'completed' => 'completed_at',
            ][$newStatus];

            $updateStmt = $pdo->prepare(
                "UPDATE dispatch SET status = :status, {$timestampColumn} = UTC_TIMESTAMP() WHERE dispatch_id = :dispatch_id"
            );
            $updateStmt->execute(['status' => $newStatus, 'dispatch_id' => $dispatchId]);

            if ($isAdmin) {
                Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'dispatch_status_override', 'dispatch', $dispatchId, [
                    'from' => $currentStatus,
                    'to' => $newStatus,
                    'reason' => $overrideReason,
                ]);
            }

            $readBack = $pdo->prepare("SELECT {$timestampColumn} FROM dispatch WHERE dispatch_id = :dispatch_id");
            $readBack->execute(['dispatch_id' => $dispatchId]);
            $updatedAt = $readBack->fetchColumn();

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        return ['dispatch_id' => $dispatchId, 'status' => $newStatus, 'updated_at' => $updatedAt];
    }
}
