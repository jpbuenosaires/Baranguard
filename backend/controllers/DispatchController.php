<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
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
 */
final class DispatchController
{
    private const DISPATCH_STATUSES = ['assigned', 'en_route', 'arrived', 'completed', 'cancelled'];
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

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
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM dispatch d JOIN incident i ON i.incident_id = d.incident_id WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT d.dispatch_id, d.incident_id, d.tanod_id, d.priority, d.route_json, d.route_status,
                    d.status, d.dispatched_at, d.en_route_at, d.arrived_at, d.completed_at, d.cancelled_at
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
}
