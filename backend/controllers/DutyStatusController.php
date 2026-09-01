<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /duty-status — Master Reference §6 "Duty status" section, §5
 * `duty_status` table, §9 W3 (Tanod picker only offers currently
 * eligible/on-duty Tanods).
 *
 * §6 documents two distinct query shapes on the same path:
 * `?user_id=me` (Tanod, own history) and `?barangay_id=` (Admin/PB,
 * current status per active user). `POST /duty-status` (Tanod-only
 * toggle) is mobile M2/Sprint 2 scope, not built here — this session's
 * Dispatch Center only needs to *read* who is currently on duty.
 */
final class DutyStatusController
{
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        $userIdParam = Http::query('user_id');
        $barangayIdParam = Http::query('barangay_id');

        if ($userIdParam !== null && $barangayIdParam !== null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Provide either user_id or barangay_id, not both.');
        }

        if ($userIdParam !== null) {
            if ($userIdParam !== 'me') {
                throw new ApiError(400, 'VALIDATION_ERROR', "user_id only supports the literal value 'me'.");
            }
            AuthMiddleware::requireRole($identity, ['tanod']);
            self::ownHistory($pdo, $identity);
            return;
        }

        if ($barangayIdParam !== null) {
            if (!ctype_digit($barangayIdParam)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id must be numeric.');
            }
            AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);
            AuthMiddleware::requireTenant($identity, (int) $barangayIdParam);
            self::currentByBarangay($pdo, $identity);
            return;
        }

        throw new ApiError(400, 'VALIDATION_ERROR', 'Provide either user_id=me or barangay_id.');
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    private static function ownHistory(PDO $pdo, array $identity): void
    {
        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare('SELECT COUNT(*) FROM duty_status WHERE user_id = :user_id');
        $countStmt->execute(['user_id' => $identity['user_id']]);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            'SELECT status_id, status, channel, changed_at
             FROM duty_status
             WHERE user_id = :user_id
             ORDER BY changed_at DESC
             LIMIT :limit OFFSET :offset'
        );
        $stmt->bindValue(':user_id', $identity['user_id'], PDO::PARAM_INT);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static fn (array $row): array => [
            'status_id' => (int) $row['status_id'],
            'status' => $row['status'],
            'channel' => $row['channel'],
            'changed_at' => $row['changed_at'],
        ], $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    private static function currentByBarangay(PDO $pdo, array $identity): void
    {
        // "Current" = latest row by changed_at per active Tanod (§6).
        $stmt = $pdo->prepare(
            "SELECT ds.user_id, ds.status, ds.channel, ds.changed_at
             FROM duty_status ds
             JOIN user u ON u.user_id = ds.user_id
             WHERE u.barangay_id = :barangay_id AND u.role = 'tanod' AND u.is_active = 1
               AND ds.changed_at = (
                   SELECT MAX(ds2.changed_at) FROM duty_status ds2 WHERE ds2.user_id = ds.user_id
               )
             ORDER BY ds.changed_at DESC"
        );
        $stmt->execute(['barangay_id' => $identity['barangay_id']]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static fn (array $row): array => [
            'user_id' => (int) $row['user_id'],
            'status' => $row['status'],
            'channel' => $row['channel'],
            'changed_at' => $row['changed_at'],
        ], $rows);

        Http::send(200, ['items' => $items]);
    }
}
