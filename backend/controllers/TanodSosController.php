<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /tanod-sos — Master Reference §6 "Tanod SOS" section, §5
 * `tanod_sos` table, §7 ("View/acknowledge/resolve SOS": Admin full, PB
 * read-only), §9 W3 (SOS banner)/W4 (SOS markers).
 *
 * `POST /tanod-sos` (Tanod-only trigger) and the acknowledge/resolve
 * endpoints are Sprint 4 scope (their own "Today's cut" box in
 * Sprint_Prompts.md, alongside the notification/FCM/SMS work SOS
 * delivery depends on) — not built here. Only the read side W3/W4 need.
 */
final class TanodSosController
{
    private const SOS_STATUSES = ['active', 'acknowledged', 'resolved'];
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

        $status = Http::query('status');
        if ($status !== null && !in_array($status, self::SOS_STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: ' . implode(', ', self::SOS_STATUSES) . '.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($status !== null) {
            $where[] = 'status = :status';
            $params['status'] = $status;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM tanod_sos WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT sos_id, user_id, dispatch_id, latitude, longitude, triggered_at, received_at,
                    status, acknowledged_at, resolved_at
             FROM tanod_sos
             WHERE {$whereSql}
             ORDER BY triggered_at DESC
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
                'sos_id' => (int) $row['sos_id'],
                'user_id' => (int) $row['user_id'],
                'dispatch_id' => $row['dispatch_id'] !== null ? (int) $row['dispatch_id'] : null,
                'latitude' => (float) $row['latitude'],
                'longitude' => (float) $row['longitude'],
                'triggered_at' => $row['triggered_at'],
                'received_at' => $row['received_at'],
                'status' => $row['status'],
                'acknowledged_at' => $row['acknowledged_at'],
                'resolved_at' => $row['resolved_at'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }
}
