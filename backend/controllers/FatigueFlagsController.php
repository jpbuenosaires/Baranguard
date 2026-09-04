<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Fatigue flags — Master Reference §6 "Shifts and fatigue" section, §5
 * `fatigue_flag` table, §9 W13 Fatigue Flags ("Sorted by over-threshold
 * hours. Acknowledgment never deletes or hides the historical record.").
 *
 * `fatigue_flag` has no `barangay_id` column of its own — every query
 * here joins `user` for tenant scoping, same pattern `GET /gps/live`
 * would use if GPS rows didn't already carry a barangay-scoped join
 * elsewhere. Re-acknowledging an already-acknowledged flag is allowed
 * (just overwrites `acknowledged_at`/`by` again) rather than rejected —
 * §6 doesn't say a second acknowledgment is an error, and treating a
 * retry as a conflict would contradict this codebase's general
 * idempotent-retry stance.
 */
final class FatigueFlagsController
{
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare(
            'SELECT COUNT(*) FROM fatigue_flag ff JOIN user u ON u.user_id = ff.user_id WHERE u.barangay_id = :barangay_id'
        );
        $countStmt->execute(['barangay_id' => $identity['barangay_id']]);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            'SELECT ff.flag_id, ff.user_id, ff.shift_id, ff.hours_worked_7day, ff.calculation_basis, ff.flagged_at, ff.acknowledged_at
             FROM fatigue_flag ff
             JOIN user u ON u.user_id = ff.user_id
             WHERE u.barangay_id = :barangay_id
             ORDER BY ff.hours_worked_7day DESC
             LIMIT :limit OFFSET :offset'
        );
        $stmt->bindValue('barangay_id', $identity['barangay_id']);
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue('offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'flag_id' => (int) $row['flag_id'],
                'user_id' => (int) $row['user_id'],
                'shift_id' => (int) $row['shift_id'],
                'hours_worked_7day' => (float) $row['hours_worked_7day'],
                'calculation_basis' => $row['calculation_basis'],
                'flagged_at' => $row['flagged_at'],
                'acknowledged_at' => $row['acknowledged_at'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function acknowledge(PDO $pdo, array $identity, string $flagIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        if (!ctype_digit($flagIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Fatigue flag not found.');
        }
        $flagId = (int) $flagIdParam;

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'SELECT ff.flag_id, ff.user_id, u.barangay_id
                 FROM fatigue_flag ff JOIN user u ON u.user_id = ff.user_id
                 WHERE ff.flag_id = :flag_id
                 FOR UPDATE'
            );
            $stmt->execute(['flag_id' => $flagId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Fatigue flag not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);

            $pdo->prepare(
                'UPDATE fatigue_flag SET acknowledged_by = :acknowledged_by, acknowledged_at = UTC_TIMESTAMP() WHERE flag_id = :flag_id'
            )->execute(['acknowledged_by' => $identity['user_id'], 'flag_id' => $flagId]);

            // Not named verbatim in Rule 17, but it is a safety decision
            // an Admin makes about a specific Tanod ("I have seen this
            // fatigue flag and accept it"), which is exactly the class of
            // action the rule's "shift changes" clause exists to cover.
            // §9 W13 also requires the record to be permanent, and an
            // acknowledgement with no actor recorded would undercut that.
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'fatigue_flag_acknowledged', 'fatigue_flag', $flagId, [
                'flagged_user_id' => (int) $row['user_id'],
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, ['flag_id' => $flagId, 'acknowledged_by' => $identity['user_id'], 'acknowledged_at' => gmdate('Y-m-d\TH:i:s\Z')]);
    }
}
