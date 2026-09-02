<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Scheduling\FatigueCalculator;
use PDO;

/**
 * Shift swap requests — Master Reference §6 "Shifts and fatigue" section,
 * §5 `shift_swap_request` table, §9 W12 Shift Swap Requests ("Approvals
 * occur transactionally and revalidate current users, assignment, time
 * overlap, and fatigue. Open approved requests explicitly show
 * 'unassigned — Admin action required.'").
 *
 * Resolved decisions, logged in DEVLOG.md:
 *   - **Wire field is `client_request_id`** (not `request_id`) — §6 says
 *     this endpoint "Uses client_request_id," matching the column name
 *     exactly, unlike `POST /dispatch`/`POST /shifts` which both use
 *     `request_id` in the body for their own `created_client_request_id`/
 *     `client_request_id` columns. Kept as documented rather than
 *     normalized to match the other two, since the reference is explicit
 *     about the name here specifically.
 *   - **shift_swap_request has no barangay_id column** — every tenant
 *     check joins through `shift_schedule` for its `barangay_id`.
 *   - **Re-validation on approve** (§6/§9's own words: "revalidate
 *     current users, assignment, time overlap, and fatigue"): if the
 *     shift's *current* occupant no longer matches `requesting_user_id`
 *     (an Admin reassigned it out from under the pending request via a
 *     normal edit in the meantime), approval is rejected with 409 rather
 *     than silently approving a swap for a shift the requester no longer
 *     holds.
 *   - **Approved, no target -> unassigned.** `shift_schedule.user_id` is
 *     nullable as of migration 0003 specifically so this can set it to
 *     NULL rather than leaving the requester's name on a shift they were
 *     just released from — matches §6's literal "leaves the shift
 *     unassigned" wording. No fatigue recalculation is triggered for the
 *     released user in this path: `fatigue_flag` rows are keyed to a
 *     specific shift the user is still tied to, and there is no new/
 *     changed shift assignment to anchor a flag to for someone being
 *     removed from one — their historical flags (if any) are untouched,
 *     never deleted, per `FatigueCalculator`'s own doc.
 */
final class ShiftSwapRequestsController
{
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const MAX_REASON_LENGTH = 1000;
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $body = Http::jsonBody();
        $shiftId = $body['shift_id'] ?? null;
        $targetUserId = $body['target_user_id'] ?? null;
        $reason = $body['reason'] ?? null;
        $clientRequestId = $body['client_request_id'] ?? null;

        if (!is_int($shiftId) && !(is_string($shiftId) && ctype_digit($shiftId))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'shift_id is required.');
        }
        $shiftId = (int) $shiftId;
        if (!is_string($clientRequestId) || !preg_match(self::UUID_PATTERN, $clientRequestId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_request_id must be a UUID.');
        }
        if ($reason !== null && (!is_string($reason) || strlen($reason) > self::MAX_REASON_LENGTH)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'reason must be a string of at most ' . self::MAX_REASON_LENGTH . ' characters.');
        }
        if ($targetUserId !== null) {
            if (!is_int($targetUserId) && !(is_string($targetUserId) && ctype_digit($targetUserId))) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'target_user_id must be an integer.');
            }
            $targetUserId = (int) $targetUserId;
        }

        $existingStmt = $pdo->prepare(
            'SELECT ssr.request_id, ssr.requesting_user_id, ssr.shift_id, ssr.target_user_id, ssr.reason,
                    ssr.status, ssr.requested_at, ssr.resolved_at, ssr.resolved_by, ssr.version
             FROM shift_swap_request ssr
             JOIN shift_schedule ss ON ss.shift_id = ssr.shift_id
             WHERE ssr.client_request_id = :client_request_id AND ss.barangay_id = :barangay_id
             LIMIT 1'
        );
        $existingStmt->execute(['client_request_id' => $clientRequestId, 'barangay_id' => $identity['barangay_id']]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            Http::send(200, self::mapRequest($existing));
        }

        $pdo->beginTransaction();
        try {
            $shiftStmt = $pdo->prepare('SELECT shift_id, user_id, barangay_id FROM shift_schedule WHERE shift_id = :shift_id FOR UPDATE');
            $shiftStmt->execute(['shift_id' => $shiftId]);
            $shift = $shiftStmt->fetch(PDO::FETCH_ASSOC);
            if ($shift === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Shift not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $shift['barangay_id']);
            if ((int) $shift['user_id'] !== $identity['user_id']) {
                throw new ApiError(403, 'FORBIDDEN', 'You may only request a swap for your own shift.');
            }
            if ($targetUserId !== null) {
                ShiftsController::assertTanodEligible($pdo, $targetUserId, $identity['barangay_id']);
            }

            $insertStmt = $pdo->prepare(
                "INSERT INTO shift_swap_request
                    (requesting_user_id, shift_id, target_user_id, reason, status, requested_at, client_request_id)
                 VALUES
                    (:requesting_user_id, :shift_id, :target_user_id, :reason, 'pending', UTC_TIMESTAMP(), :client_request_id)"
            );
            $insertStmt->execute([
                'requesting_user_id' => $identity['user_id'],
                'shift_id' => $shiftId,
                'target_user_id' => $targetUserId,
                'reason' => $reason,
                'client_request_id' => $clientRequestId,
            ]);
            $requestId = (int) $pdo->lastInsertId();

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(201, [
            'request_id' => $requestId,
            'requesting_user_id' => $identity['user_id'],
            'shift_id' => $shiftId,
            'target_user_id' => $targetUserId,
            'reason' => $reason,
            'status' => 'pending',
            'requested_at' => gmdate('Y-m-d\TH:i:s\Z'),
            'resolved_at' => null,
            'resolved_by' => null,
            'version' => 1,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'tanod']);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['ss.barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($identity['role'] === 'tanod') {
            $where[] = 'ssr.requesting_user_id = :requesting_user_id';
            $params['requesting_user_id'] = $identity['user_id'];
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare(
            "SELECT COUNT(*) FROM shift_swap_request ssr JOIN shift_schedule ss ON ss.shift_id = ssr.shift_id WHERE {$whereSql}"
        );
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT ssr.request_id, ssr.requesting_user_id, ssr.shift_id, ssr.target_user_id, ssr.reason,
                    ssr.status, ssr.requested_at, ssr.resolved_at, ssr.resolved_by, ssr.version
             FROM shift_swap_request ssr
             JOIN shift_schedule ss ON ss.shift_id = ssr.shift_id
             WHERE {$whereSql}
             ORDER BY ssr.requested_at DESC
             LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        Http::send(200, [
            'items' => array_map([self::class, 'mapRequest'], $rows),
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function update(PDO $pdo, array $identity, string $requestIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        if (!ctype_digit($requestIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Swap request not found.');
        }
        $requestId = (int) $requestIdParam;

        $body = Http::jsonBody();
        $status = $body['status'] ?? null;
        $version = $body['version'] ?? null;
        if (!in_array($status, ['approved', 'denied'], true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be "approved" or "denied".');
        }
        if (!is_int($version) && !(is_string($version) && ctype_digit($version))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'version is required.');
        }
        $version = (int) $version;

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'SELECT ssr.request_id, ssr.requesting_user_id, ssr.shift_id, ssr.target_user_id, ssr.status, ssr.version,
                        ss.barangay_id, ss.user_id AS shift_current_user_id, ss.start_at, ss.end_at
                 FROM shift_swap_request ssr
                 JOIN shift_schedule ss ON ss.shift_id = ssr.shift_id
                 WHERE ssr.request_id = :request_id
                 FOR UPDATE'
            );
            $stmt->execute(['request_id' => $requestId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Swap request not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);
            if ((int) $row['version'] !== $version) {
                throw new ApiError(409, 'CONFLICT', 'This request was changed by someone else — reload and try again.');
            }
            if ($row['status'] !== 'pending') {
                throw new ApiError(409, 'CONFLICT', 'This swap request has already been resolved.');
            }

            $shiftId = (int) $row['shift_id'];
            $targetUserId = $row['target_user_id'] !== null ? (int) $row['target_user_id'] : null;

            if ($status === 'approved') {
                // Revalidate current assignment — an Admin may have
                // reassigned this shift out from under the request since
                // it was submitted (§9: "revalidate current users,
                // assignment, time overlap, and fatigue").
                if ((int) $row['shift_current_user_id'] !== (int) $row['requesting_user_id']) {
                    throw new ApiError(409, 'CONFLICT', 'The requester is no longer assigned to this shift.');
                }

                if ($targetUserId !== null) {
                    ShiftsController::assertTanodEligible($pdo, $targetUserId, (int) $row['barangay_id']);
                    // Explicit UTC default: these are naive DB round-trip
                    // strings (no offset of their own), same reasoning as
                    // ShiftsController::parseTimestamp()'s own doc.
                    $utc = new \DateTimeZone('UTC');
                    ShiftsController::assertNoOverlap(
                        $pdo,
                        $targetUserId,
                        new \DateTimeImmutable($row['start_at'], $utc),
                        new \DateTimeImmutable($row['end_at'], $utc),
                        $shiftId
                    );
                    $pdo->prepare('UPDATE shift_schedule SET user_id = :user_id, version = version + 1, updated_at = UTC_TIMESTAMP() WHERE shift_id = :shift_id')
                        ->execute(['user_id' => $targetUserId, 'shift_id' => $shiftId]);
                    FatigueCalculator::recalculate($pdo, (int) $row['requesting_user_id'], $shiftId);
                    FatigueCalculator::recalculate($pdo, $targetUserId, $shiftId);
                } else {
                    // No named target: release to unassigned — see class doc.
                    $pdo->prepare('UPDATE shift_schedule SET user_id = NULL, version = version + 1, updated_at = UTC_TIMESTAMP() WHERE shift_id = :shift_id')
                        ->execute(['shift_id' => $shiftId]);
                }
            }

            $pdo->prepare(
                "UPDATE shift_swap_request
                 SET status = :status, resolved_at = UTC_TIMESTAMP(), resolved_by = :resolved_by, version = version + 1
                 WHERE request_id = :request_id"
            )->execute(['status' => $status, 'resolved_by' => $identity['user_id'], 'request_id' => $requestId]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $readBackStmt = $pdo->prepare('SELECT resolved_at FROM shift_swap_request WHERE request_id = :request_id');
        $readBackStmt->execute(['request_id' => $requestId]);

        Http::send(200, [
            'request_id' => $requestId,
            'status' => $status,
            'resolved_at' => $readBackStmt->fetchColumn(),
            'resolved_by' => $identity['user_id'],
            'shift_id' => $shiftId,
            'target_user_id' => $targetUserId,
        ]);
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapRequest(array $row): array
    {
        return [
            'request_id' => (int) $row['request_id'],
            'requesting_user_id' => (int) $row['requesting_user_id'],
            'shift_id' => (int) $row['shift_id'],
            'target_user_id' => $row['target_user_id'] !== null ? (int) $row['target_user_id'] : null,
            'reason' => $row['reason'],
            'status' => $row['status'],
            'requested_at' => $row['requested_at'],
            'resolved_at' => $row['resolved_at'],
            'resolved_by' => $row['resolved_by'] !== null ? (int) $row['resolved_by'] : null,
            'version' => (int) $row['version'],
        ];
    }
}
