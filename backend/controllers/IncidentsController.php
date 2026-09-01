<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
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
 */
final class IncidentsController
{
    private const INCIDENT_STATUSES = ['pending', 'dispatched', 'resolved'];
    private const INCIDENT_PRIORITIES = ['normal', 'high', 'critical'];
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

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

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];

        // §6: "Tanod forced to reported_by=me" — server-enforced, not a
        // client-supplied filter the caller could override.
        if ($identity['role'] === 'tanod') {
            $where[] = 'reported_by = :reported_by';
            $params['reported_by'] = $identity['user_id'];
        }
        if ($status !== null) {
            $where[] = 'status = :status';
            $params['status'] = $status;
        }
        if ($priority !== null) {
            $where[] = 'priority = :priority';
            $params['priority'] = $priority;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM incident WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT incident_id, barangay_id, reported_by, incident_type, priority, status, source,
                    latitude, longitude, created_at, device_offline_created_at, synced_at
             FROM incident
             WHERE {$whereSql}
             ORDER BY created_at DESC
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
            ];
        }, $rows);

        Http::send(200, [
            'items' => $items,
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }
}
