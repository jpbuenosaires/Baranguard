<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /users — Master Reference §6 "Users & device lifecycle" section.
 * Not one of the endpoints CLAUDE.md originally listed as needed for
 * W3/W4, but built here as necessary plumbing: §9 W3's Tanod picker
 * needs Tanod full names, and `GET /duty-status?barangay_id=`'s
 * documented response shape (§6) is fixed to
 * `{user_id,status,channel,changed_at}` — no name. Same precedent as W2
 * building a minimal login page beyond its own checked box. Only `index`
 * (list) is built; create/edit/reset-password are separate, unbuilt §6
 * endpoints.
 */
final class UsersController
{
    private const ROLES = ['admin', 'secretary', 'tanod', 'punong_barangay', 'lupon'];
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $role = Http::query('role');
        if ($role !== null && !in_array($role, self::ROLES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'role must be one of: ' . implode(', ', self::ROLES) . '.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($role !== null) {
            $where[] = 'role = :role';
            $params['role'] = $role;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM user WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT user_id, full_name, username, role, contact_number, is_active, created_at
             FROM user
             WHERE {$whereSql}
             ORDER BY full_name ASC
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
                'user_id' => (int) $row['user_id'],
                'full_name' => $row['full_name'],
                'username' => $row['username'],
                'role' => $row['role'],
                'contact_number' => $row['contact_number'],
                'is_active' => (bool) $row['is_active'],
                'created_at' => $row['created_at'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }
}
