<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Sms\SmsGatewayService;
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
    private const MAX_RANGE_DAYS = 366;

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

        // Phase 8 (mockup-driven UI round 2): date_from/date_to, same
        // contract as GET /reports/summary (Asia/Manila calendar days,
        // 366-day cap) — reused rather than a bespoke convention for the
        // one other date-ranged endpoint in this codebase. Filters on
        // COALESCE(sent_at, received_at, created_at): an outbound row's
        // meaningful moment is when it was sent, an inbound row's is when
        // it was received, and a row that never got that far (still
        // queued/failed before either happened) still has created_at.
        $dateFromRaw = Http::query('date_from');
        $dateToRaw = Http::query('date_to');
        if ($dateFromRaw !== null || $dateToRaw !== null) {
            $manila = new \DateTimeZone('Asia/Manila');
            $utc = new \DateTimeZone('UTC');
            $today = new \DateTimeImmutable('now', $manila);
            $to = $dateToRaw !== null ? self::parseDate($dateToRaw, $manila, 'date_to') : $today;
            $from = $dateFromRaw !== null ? self::parseDate($dateFromRaw, $manila, 'date_from') : $to->modify('-29 days');
            if ($from > $to) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'date_from must not be after date_to.');
            }
            if ($from->diff($to)->days > self::MAX_RANGE_DAYS) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'date_from/date_to range cannot exceed ' . self::MAX_RANGE_DAYS . ' days.');
            }
            $rangeStartUtc = $from->setTime(0, 0, 0)->setTimezone($utc);
            $rangeEndUtc = $to->setTime(0, 0, 0)->modify('+1 day')->setTimezone($utc);
            $where[] = 'COALESCE(sent_at, received_at, created_at) >= :range_start AND COALESCE(sent_at, received_at, created_at) < :range_end';
            $params['range_start'] = $rangeStartUtc->format('Y-m-d H:i:s');
            $params['range_end'] = $rangeEndUtc->format('Y-m-d H:i:s');
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

    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const MAX_MESSAGE_LENGTH = 918; // matches SemaphoreClient's own multi-part SMS ceiling.

    /**
     * GET /sms/conversations — 2026-09-05 UX pass, deliberate rescoping of
     * `sms-log.js`'s (now `sms-monitor.js`) own "read-only this sprint and
     * every sprint after unless deliberately rescoped" note (see that
     * file's header). Groups `sms_log` rows by whichever phone number is
     * set (`COALESCE(sender_number, receiver_number)`) within the caller's
     * barangay, returning the most recent message per contact plus a real
     * unread count. Phone numbers are returned here — a genuine, disclosed
     * contract change from `index()` above, needed specifically to power a
     * per-contact view; `index()` itself is UNCHANGED (still never returns
     * a phone number), so the plain SMS Activity Log table this class
     * doc's own §6 contract describes keeps behaving exactly as before.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function conversations(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $stmt = $pdo->prepare(
            "SELECT phone,
                    MAX(created_at) AS last_at,
                    SUM(CASE WHEN direction = 'inbound' AND read_at IS NULL THEN 1 ELSE 0 END) AS unread_count
             FROM (
                 SELECT COALESCE(sender_number, receiver_number) AS phone, created_at, direction, read_at
                 FROM sms_log
                 WHERE barangay_id = :barangay_id AND COALESCE(sender_number, receiver_number) IS NOT NULL
             ) t
             GROUP BY phone
             ORDER BY last_at DESC
             LIMIT 100"
        );
        $stmt->execute(['barangay_id' => $identity['barangay_id']]);
        $threads = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = [];
        foreach ($threads as $thread) {
            $phone = $thread['phone'];
            $lastStmt = $pdo->prepare(
                "SELECT log_id, direction, message_type, message_body, status, created_at, sent_at, received_at
                 FROM sms_log
                 WHERE barangay_id = :barangay_id AND COALESCE(sender_number, receiver_number) = :phone
                 ORDER BY created_at DESC
                 LIMIT 1"
            );
            $lastStmt->execute(['barangay_id' => $identity['barangay_id'], 'phone' => $phone]);
            $last = $lastStmt->fetch(PDO::FETCH_ASSOC);

            // Best-effort display name: a registered user (Tanod/staff)
            // with this contact number, same-barangay, else null (the UI
            // falls back to showing the raw number).
            $nameStmt = $pdo->prepare('SELECT full_name FROM user WHERE contact_number = :phone AND barangay_id = :barangay_id LIMIT 1');
            $nameStmt->execute(['phone' => $phone, 'barangay_id' => $identity['barangay_id']]);
            $displayName = $nameStmt->fetchColumn();

            $items[] = [
                'phone_number' => $phone,
                'display_name' => $displayName !== false ? $displayName : null,
                'unread_count' => (int) $thread['unread_count'],
                'last_message' => $last === false ? null : [
                    'log_id' => (int) $last['log_id'],
                    'direction' => $last['direction'],
                    'message_type' => $last['message_type'],
                    'message_body' => $last['message_body'],
                    'status' => $last['status'],
                    'created_at' => $last['created_at'],
                    'sent_at' => $last['sent_at'],
                    'received_at' => $last['received_at'],
                ],
            ];
        }

        Http::send(200, ['items' => $items]);
    }

    /**
     * GET /sms/conversations/:phone/messages — the full thread for one
     * contact, tenant-scoped. Admin-only, same as every other SMS
     * endpoint.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function conversationMessages(PDO $pdo, array $identity, string $phone): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $stmt = $pdo->prepare(
            "SELECT log_id, direction, message_type, message_body, status, failure_reason,
                    incident_id, dispatch_id, report_id, created_at, sent_at, received_at
             FROM sms_log
             WHERE barangay_id = :barangay_id AND COALESCE(sender_number, receiver_number) = :phone
             ORDER BY created_at ASC
             LIMIT 200"
        );
        $stmt->execute(['barangay_id' => $identity['barangay_id'], 'phone' => $phone]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'log_id' => (int) $row['log_id'],
                'direction' => $row['direction'],
                'message_type' => $row['message_type'],
                'message_body' => $row['message_body'],
                'status' => $row['status'],
                'failure_reason' => $row['failure_reason'],
                'incident_id' => $row['incident_id'] !== null ? (int) $row['incident_id'] : null,
                'dispatch_id' => $row['dispatch_id'] !== null ? (int) $row['dispatch_id'] : null,
                'report_id' => $row['report_id'] !== null ? (int) $row['report_id'] : null,
                'created_at' => $row['created_at'],
                'sent_at' => $row['sent_at'],
                'received_at' => $row['received_at'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'phone_number' => $phone]);
    }

    /**
     * PATCH /sms/conversations/:phone/resolve — marks every unread inbound
     * row in this thread as read. "Mark Resolved" in the mockup's center
     * panel.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function resolveConversation(PDO $pdo, array $identity, string $phone): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $stmt = $pdo->prepare(
            "UPDATE sms_log SET read_at = UTC_TIMESTAMP()
             WHERE barangay_id = :barangay_id AND COALESCE(sender_number, receiver_number) = :phone
               AND direction = 'inbound' AND read_at IS NULL"
        );
        $stmt->execute(['barangay_id' => $identity['barangay_id'], 'phone' => $phone]);

        Http::send(200, ['phone_number' => $phone, 'resolved_count' => $stmt->rowCount()]);
    }

    /**
     * POST /sms/send — 2026-09-05 UX pass, the manual compose action.
     * Admin-only, Idempotency-Key required (§2 Rule 3 — every web write
     * needs one; a retried send must not double-text someone).
     *
     * Body: {recipient_user_id?, phone_number?, message, incident_id?,
     * dispatch_id?, report_id?} — exactly one of recipient_user_id/
     * phone_number.
     *
     * SECURITY NOTE (deliberately stricter than the mockup's implied
     * "type any number" flow): a raw `phone_number` is only accepted if
     * it matches a REAL in-tenant contact already on file (a citizen
     * report's contact number, or a number that has appeared in this
     * barangay's own `sms_log` before) — never an arbitrary client-
     * supplied number. Otherwise an Admin session would be an open
     * SMS-to-anyone relay, which nothing else in this codebase allows
     * (every other write is scoped to a real in-tenant recipient). A
     * `recipient_user_id` resolves the phone server-side from that
     * user's own record — the client-supplied number for that path (if
     * any) is ignored entirely.
     *
     * Uses `SmsGatewayService::sendOutbound()` — the exact same shared
     * path every automated send already uses, with
     * `message_type='manual'` (migration 0013).
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function send(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $idempotencyKey = Http::header('Idempotency-Key');
        if ($idempotencyKey === null || !preg_match(self::UUID_PATTERN, $idempotencyKey)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID.');
        }

        $body = Http::jsonBody();
        $message = $body['message'] ?? null;
        if (!is_string($message) || trim($message) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'message is required.');
        }
        if (mb_strlen($message) > self::MAX_MESSAGE_LENGTH) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'message is too long (max ' . self::MAX_MESSAGE_LENGTH . ' characters).');
        }

        $recipientUserId = $body['recipient_user_id'] ?? null;
        $phoneNumberRaw = $body['phone_number'] ?? null;
        $hasUserId = $recipientUserId !== null;
        $hasPhone = $phoneNumberRaw !== null;
        if ($hasUserId === $hasPhone) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Provide exactly one of recipient_user_id or phone_number.');
        }

        $incidentId = self::optionalInt($body['incident_id'] ?? null, 'incident_id');
        $dispatchId = self::optionalInt($body['dispatch_id'] ?? null, 'dispatch_id');
        $reportId = self::optionalInt($body['report_id'] ?? null, 'report_id');

        // Idempotency: a retry with the same key returns the original
        // send's outcome rather than sending a second text. `correlation_id`
        // (already a column, §5) is the natural home for this — no schema
        // change needed.
        $existingStmt = $pdo->prepare('SELECT log_id, status, failure_reason, message_body FROM sms_log WHERE barangay_id = :barangay_id AND correlation_id = :correlation_id LIMIT 1');
        $existingStmt->execute(['barangay_id' => $identity['barangay_id'], 'correlation_id' => $idempotencyKey]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            Http::send(200, [
                'log_id' => (int) $existing['log_id'],
                'status' => $existing['status'],
                'failure_reason' => $existing['failure_reason'],
            ]);
        }

        if ($hasUserId) {
            if (!is_int($recipientUserId) && !(is_string($recipientUserId) && ctype_digit($recipientUserId))) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'recipient_user_id must be an integer.');
            }
            $userStmt = $pdo->prepare('SELECT contact_number FROM user WHERE user_id = :user_id AND barangay_id = :barangay_id LIMIT 1');
            $userStmt->execute(['user_id' => (int) $recipientUserId, 'barangay_id' => $identity['barangay_id']]);
            $contact = $userStmt->fetchColumn();
            if ($contact === false || trim((string) $contact) === '') {
                // Same generic-422 shape DispatchController uses for a bad
                // tanod_id — no detail that would let a caller enumerate
                // which user ids exist in another barangay.
                throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'The selected recipient is not available.');
            }
            $phoneNumber = (string) $contact;
        } else {
            if (!is_string($phoneNumberRaw) || trim($phoneNumberRaw) === '') {
                throw new ApiError(400, 'VALIDATION_ERROR', 'phone_number must be a non-empty string.');
            }
            $phoneNumber = trim($phoneNumberRaw);
            $knownStmt = $pdo->prepare(
                "SELECT 1 FROM (
                     SELECT contact_number AS phone FROM citizen_report WHERE barangay_id = :b1
                     UNION SELECT sender_number AS phone FROM sms_log WHERE barangay_id = :b2 AND sender_number IS NOT NULL
                     UNION SELECT receiver_number AS phone FROM sms_log WHERE barangay_id = :b3 AND receiver_number IS NOT NULL
                 ) known WHERE phone = :phone LIMIT 1"
            );
            $knownStmt->execute(['b1' => $identity['barangay_id'], 'b2' => $identity['barangay_id'], 'b3' => $identity['barangay_id'], 'phone' => $phoneNumber]);
            if ($knownStmt->fetchColumn() === false) {
                throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'This phone number has no prior contact on record in your barangay.');
            }
        }

        $gateway = new SmsGatewayService();
        $result = $gateway->sendOutbound(
            $pdo, 'manual', false, $incidentId, $dispatchId, $phoneNumber, $message,
            $identity['barangay_id'], $idempotencyKey, $reportId
        );

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'sms_manual_sent', 'sms_log', $result['log_id'], [
            'status' => $result['status'],
        ]);

        Http::send(201, [
            'log_id' => $result['log_id'],
            'status' => $result['status'],
            'failure_reason' => $result['failure_reason'] ?? null,
        ]);
    }

    /**
     * POST /sms/broadcast — fans out to `send()`'s same core per
     * recipient. Admin-only. Scope is ALWAYS the caller's own barangay —
     * deliberately dropping the mockup's "All Barangays" option, which
     * would be the one cross-tenant broadcast capability in a system
     * where every other write is barangay-scoped (§3).
     *
     * Body: {message, scope: 'on_duty_tanods'|'role', role?}.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function broadcast(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $idempotencyKey = Http::header('Idempotency-Key');
        if ($idempotencyKey === null || !preg_match(self::UUID_PATTERN, $idempotencyKey)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID.');
        }

        $body = Http::jsonBody();
        $message = $body['message'] ?? null;
        if (!is_string($message) || trim($message) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'message is required.');
        }
        if (mb_strlen($message) > self::MAX_MESSAGE_LENGTH) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'message is too long (max ' . self::MAX_MESSAGE_LENGTH . ' characters).');
        }
        $scope = $body['scope'] ?? null;
        if (!in_array($scope, ['on_duty_tanods', 'role'], true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', "scope must be one of: on_duty_tanods, role.");
        }
        $role = $body['role'] ?? null;
        if ($scope === 'role' && (!is_string($role) || !in_array($role, ['admin', 'secretary', 'tanod', 'punong_barangay'], true))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'role must be one of: admin, secretary, tanod, punong_barangay.');
        }

        // Idempotency for the WHOLE broadcast action (not per-recipient —
        // `sms_log.correlation_id` is CHAR(36), a single UUID, and a
        // broadcast fans out to N recipients with no natural per-row key
        // to derive N distinct ones from). A retry with the same header
        // finds this exact prior broadcast in `audit_log` and returns its
        // recorded outcome instead of sending everything a second time.
        $auditStmt = $pdo->prepare(
            "SELECT metadata_json FROM audit_log
             WHERE barangay_id = :barangay_id AND action = 'sms_broadcast_sent'
               AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.idempotency_key')) = :idempotency_key
             LIMIT 1"
        );
        $auditStmt->execute(['barangay_id' => $identity['barangay_id'], 'idempotency_key' => $idempotencyKey]);
        $priorMetadataJson = $auditStmt->fetchColumn();
        if ($priorMetadataJson !== false) {
            $prior = json_decode((string) $priorMetadataJson, true);
            Http::send(200, [
                'recipient_count' => $prior['recipient_count'] ?? 0,
                'sent' => $prior['sent'] ?? 0,
                'failed' => $prior['failed'] ?? 0,
            ]);
        }

        if ($scope === 'on_duty_tanods') {
            $recipientsStmt = $pdo->prepare(
                "SELECT u.user_id, u.contact_number FROM user u
                 WHERE u.barangay_id = :barangay_id AND u.role = 'tanod' AND u.is_active = 1
                   AND EXISTS (
                       SELECT 1 FROM duty_status ds
                       WHERE ds.user_id = u.user_id AND ds.status = 'on_duty'
                         AND ds.changed_at = (SELECT MAX(ds2.changed_at) FROM duty_status ds2 WHERE ds2.user_id = u.user_id)
                   )
                   AND u.contact_number IS NOT NULL AND u.contact_number != ''"
            );
            $recipientsStmt->execute(['barangay_id' => $identity['barangay_id']]);
        } else {
            $recipientsStmt = $pdo->prepare(
                "SELECT user_id, contact_number FROM user
                 WHERE barangay_id = :barangay_id AND role = :role AND is_active = 1
                   AND contact_number IS NOT NULL AND contact_number != ''"
            );
            $recipientsStmt->execute(['barangay_id' => $identity['barangay_id'], 'role' => $role]);
        }
        $recipients = $recipientsStmt->fetchAll(PDO::FETCH_ASSOC);

        $gateway = new SmsGatewayService();
        $sent = 0;
        $failed = 0;
        foreach ($recipients as $recipient) {
            $result = $gateway->sendOutbound(
                $pdo, 'manual', false, null, null,
                (string) $recipient['contact_number'], $message, $identity['barangay_id']
            );
            if ($result['status'] === 'sent') {
                $sent++;
            } else {
                $failed++;
            }
        }

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'sms_broadcast_sent', 'user', null, [
            'scope' => $scope,
            'role' => $role,
            'recipient_count' => count($recipients),
            'sent' => $sent,
            'failed' => $failed,
            'idempotency_key' => $idempotencyKey,
        ]);

        Http::send(201, ['recipient_count' => count($recipients), 'sent' => $sent, 'failed' => $failed]);
    }

    private static function optionalInt(mixed $value, string $field): ?int
    {
        if ($value === null) {
            return null;
        }
        if (!is_int($value) && !(is_string($value) && ctype_digit($value))) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be an integer.");
        }
        return (int) $value;
    }

    private static function parseDate(string $raw, \DateTimeZone $tz, string $field): \DateTimeImmutable
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $raw, $tz);
        $errors = \DateTimeImmutable::getLastErrors();
        $hasErrors = $errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0);
        if ($date === false || $hasErrors) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be in YYYY-MM-DD format.");
        }
        return $date;
    }
}
