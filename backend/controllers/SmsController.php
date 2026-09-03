<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /sms/logs — §6: "Admin own barangay ->
 * {items:[{log_id,report_id,incident_id,dispatch_id,transport,message_type,
 * direction,status,correlation_id,gateway_message_id,modem_message_id,
 * sent_at,received_at,created_at,failure_reason}],page,limit,total};
 * phone numbers are masked in UI." §9 W14 — read-only this sprint (and
 * every sprint after, per Sprint_Prompts.md, unless explicitly rescoped).
 *
 * Note what is DELIBERATELY NOT in the response: `sender_number`/
 * `receiver_number` are not part of §6's own documented item shape at
 * all — not "returned but masked", simply never returned by this
 * endpoint. "Phone numbers are masked in UI" is read as belt-and-braces
 * guidance for a screen that might one day need them, not license to
 * invent an unlisted field on top of an already-exact contract.
 *
 * This is a normal `/api/v1` endpoint (unlike `/internal/sms/*`) —
 * Admin-only, authenticated, tenant-scoped via `barangay_id` (added in
 * migration 0006; see that file's own doc for why sms_log needed its own
 * tenant column rather than deriving one from incident/dispatch/report,
 * which are all optional and can be simultaneously NULL for a
 * duty_status/coord_ping-originated row).
 */
final class SmsController
{
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const MESSAGE_TYPES = ['incident', 'dispatch', 'priority_alert', 'coord_ping', 'confirmation', 'duty_status', 'sos'];
    private const DIRECTIONS = ['inbound', 'outbound'];
    private const STATUSES = ['queued', 'pending', 'sent', 'failed', 'refunded', 'received', 'rejected', 'deduplicated'];

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $messageType = Http::query('message_type');
        if ($messageType !== null && !in_array($messageType, self::MESSAGE_TYPES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'message_type must be one of: ' . implode(', ', self::MESSAGE_TYPES) . '.');
        }
        $direction = Http::query('direction');
        if ($direction !== null && !in_array($direction, self::DIRECTIONS, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'direction must be one of: ' . implode(', ', self::DIRECTIONS) . '.');
        }
        $status = Http::query('status');
        if ($status !== null && !in_array($status, self::STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: ' . implode(', ', self::STATUSES) . '.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($messageType !== null) {
            $where[] = 'message_type = :message_type';
            $params['message_type'] = $messageType;
        }
        if ($direction !== null) {
            $where[] = 'direction = :direction';
            $params['direction'] = $direction;
        }
        if ($status !== null) {
            $where[] = 'status = :status';
            $params['status'] = $status;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM sms_log WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT log_id, report_id, incident_id, dispatch_id, transport, message_type, direction, status,
                    correlation_id, gateway_message_id, modem_message_id, sent_at, received_at, created_at, failure_reason
             FROM sms_log
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

        $items = array_map(static function (array $row): array {
            return [
                'log_id' => (int) $row['log_id'],
                'report_id' => $row['report_id'] !== null ? (int) $row['report_id'] : null,
                'incident_id' => $row['incident_id'] !== null ? (int) $row['incident_id'] : null,
                'dispatch_id' => $row['dispatch_id'] !== null ? (int) $row['dispatch_id'] : null,
                'transport' => $row['transport'],
                'message_type' => $row['message_type'],
                'direction' => $row['direction'],
                'status' => $row['status'],
                'correlation_id' => $row['correlation_id'],
                'gateway_message_id' => $row['gateway_message_id'],
                'modem_message_id' => $row['modem_message_id'],
                'sent_at' => $row['sent_at'],
                'received_at' => $row['received_at'],
                'created_at' => $row['created_at'],
                'failure_reason' => $row['failure_reason'],
            ];
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }
}
