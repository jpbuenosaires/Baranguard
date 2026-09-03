<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

use Baranguard\Services\Sms\SmsGatewayService;
use PDO;

/**
 * NotificationDispatcher — Phase 2 of the split `NotificationService` (see
 * that class's own doc). This is where §2 Rule 12's fallback ladder
 * actually lives:
 *
 *   "if no active FCM registration, go straight to SMS with no FCM
 *    attempt; FCM send error/timeout -> retry once, then SMS on second
 *    failure; FCM sent but no client ack within 60s -> record
 *    ack_timeout, do NOT auto-send SMS."
 *
 * The first two clauses happen HERE, synchronously, right after the
 * caller's notification+target transaction commits — §6 says SOS
 * "immediately attempts configured FCM/SMS channels", and the same
 * urgency applies to a dispatch assignment. The third clause (the 60s
 * ack-timeout sweep) CANNOT happen synchronously — nothing should block
 * an HTTP response for a minute — so it is `scripts/notification-worker.php`'s
 * job instead; this class never marks anything `ack_timeout`.
 *
 * Every `notification_delivery` row this class writes follows §5's shape
 * exactly: `attempt_no` is per (target, channel) — an FCM retry is
 * attempt_no=2 on channel='fcm'; the SMS fallback that follows is its OWN
 * attempt_no=1 on channel='sms', a DIFFERENT row, never a continuation of
 * the FCM attempts. Rule 24: "An FCM ack timeout does not automatically
 * become an SMS attempt unless the fallback rule explicitly requires it"
 * — the fallback rule here explicitly requires it only for a SEND
 * failure, never for an ack timeout, which is exactly why this class and
 * the worker never call into each other.
 *
 * A transport failure NEVER throws out of `dispatchAll()` — every branch
 * is caught internally and recorded as a `failed` delivery row. The
 * calling controller (TanodSosController, DispatchController) wraps this
 * in try/catch anyway as a second line of defence, but the intent is that
 * it never needs to: a missing/misconfigured/unreachable transport is a
 * transport fact, not a reason to fail the parent request.
 */
final class NotificationDispatcher
{
    private FcmClient $fcm;
    private SmsGatewayService $smsGateway;

    /**
     * `$smsGateway` is `Baranguard\Services\Sms\SmsGatewayService` — the
     * SAME class the internal `/internal/sms/dispatch-payload` and
     * `/internal/sms/priority-alert` endpoints call, so the SMS-fallback
     * step here and those endpoints share one implementation of "compose,
     * send via Semaphore, write sms_log" rather than two that could drift.
     */
    public function __construct(?FcmClient $fcm = null, ?SmsGatewayService $smsGateway = null)
    {
        $this->fcm = $fcm ?? new FcmClient();
        $this->smsGateway = $smsGateway ?? new SmsGatewayService();
    }

    /**
     * Attempts delivery to every PENDING target of one notification.
     * Idempotent-ish in practice: a target that already has delivery rows
     * from an earlier call (e.g. a retried request that re-ran the
     * caller's whole flow under a different notification, or a manual
     * re-run) simply gets a fresh attempt sequence — §5's
     * UNIQUE(notification_target_id,channel,attempt_no) makes a genuine
     * duplicate attempt_no impossible, so this only ever adds rows,
     * never conflicts with itself under normal operation.
     */
    public function dispatchAll(PDO $pdo, int $notificationId): void
    {
        $notification = $this->loadNotification($pdo, $notificationId);
        if ($notification === null) {
            return; // Nothing to do — caller passed a bad id, which shouldn't happen.
        }

        $message = $this->composeMessage($pdo, $notification);
        if ($message === null) {
            return; // §6's entity-integrity matrix already prevents this in practice.
        }

        $targets = $this->loadPendingTargets($pdo, $notificationId);
        foreach ($targets as $target) {
            $this->dispatchToTarget($pdo, $notificationId, $notification, $message, $target);
        }
    }

    /**
     * @return array{notification_type:string,barangay_id:int,dispatch_id:?int,sos_id:?int,incident_id:?int}|null
     */
    private function loadNotification(PDO $pdo, int $notificationId): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT notification_type, barangay_id, dispatch_id, sos_id, incident_id
             FROM notification WHERE notification_id = :id'
        );
        $stmt->execute(['id' => $notificationId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            return null;
        }
        return [
            'notification_type' => (string) $row['notification_type'],
            'barangay_id' => (int) $row['barangay_id'],
            'dispatch_id' => $row['dispatch_id'] !== null ? (int) $row['dispatch_id'] : null,
            'sos_id' => $row['sos_id'] !== null ? (int) $row['sos_id'] : null,
            'incident_id' => $row['incident_id'] !== null ? (int) $row['incident_id'] : null,
        ];
    }

    /**
     * @return array<int,array{notification_target_id:int,user_id:int,device_id:?string}>
     */
    private function loadPendingTargets(PDO $pdo, int $notificationId): array
    {
        $stmt = $pdo->prepare(
            "SELECT notification_target_id, user_id, device_id
             FROM notification_target
             WHERE notification_id = :id AND ack_status = 'pending'"
        );
        $stmt->execute(['id' => $notificationId]);
        return array_map(static function (array $row): array {
            return [
                'notification_target_id' => (int) $row['notification_target_id'],
                'user_id' => (int) $row['user_id'],
                'device_id' => $row['device_id'],
            ];
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * §2 Rule 1: raw_narrative never leaves the trusted store — every
     * message below is composed only from redacted-safe fields already
     * exposed elsewhere (incident_type, coordinates, a Tanod's own name),
     * the same allow-list `GET /incidents`/`GET /dispatch` already use.
     *
     * @param array{notification_type:string,barangay_id:int,dispatch_id:?int,sos_id:?int,incident_id:?int} $notification
     * @return array{title:string,body:string,sms:string,message_type:string}|null
     */
    private function composeMessage(PDO $pdo, array $notification): ?array
    {
        switch ($notification['notification_type']) {
            case 'dispatch':
                if ($notification['dispatch_id'] === null) {
                    return null;
                }
                $stmt = $pdo->prepare(
                    'SELECT i.incident_type, i.latitude, i.longitude, d.priority
                     FROM dispatch d JOIN incident i ON i.incident_id = d.incident_id
                     WHERE d.dispatch_id = :id'
                );
                $stmt->execute(['id' => $notification['dispatch_id']]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if ($row === false) {
                    return null;
                }
                $location = self::formatLocation($row['latitude'], $row['longitude']);
                return [
                    'title' => 'New dispatch assigned',
                    'body' => "You've been assigned a {$row['incident_type']} incident{$location}. Open the app for details.",
                    'sms' => "BARANGUARD DISPATCH: You've been assigned a {$row['incident_type']} incident{$location}. Priority: {$row['priority']}. Open the app.",
                    'message_type' => 'dispatch',
                ];

            case 'sos':
                if ($notification['sos_id'] === null) {
                    return null;
                }
                $stmt = $pdo->prepare(
                    'SELECT u.full_name, s.latitude, s.longitude
                     FROM tanod_sos s JOIN user u ON u.user_id = s.user_id
                     WHERE s.sos_id = :id'
                );
                $stmt->execute(['id' => $notification['sos_id']]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if ($row === false) {
                    return null;
                }
                $location = self::formatLocation($row['latitude'], $row['longitude']);
                return [
                    'title' => 'SOS ALERT',
                    'body' => "{$row['full_name']} needs help{$location}. Open the app immediately.",
                    'sms' => "BARANGUARD SOS: {$row['full_name']} needs help{$location}. Respond immediately.",
                    'message_type' => 'sos',
                ];

            case 'priority_alert':
                $incidentType = null;
                $lat = $lng = null;
                if ($notification['incident_id'] !== null) {
                    $stmt = $pdo->prepare('SELECT incident_type, latitude, longitude FROM incident WHERE incident_id = :id');
                    $stmt->execute(['id' => $notification['incident_id']]);
                    $row = $stmt->fetch(PDO::FETCH_ASSOC);
                } elseif ($notification['dispatch_id'] !== null) {
                    $stmt = $pdo->prepare(
                        'SELECT i.incident_type, i.latitude, i.longitude
                         FROM dispatch d JOIN incident i ON i.incident_id = d.incident_id WHERE d.dispatch_id = :id'
                    );
                    $stmt->execute(['id' => $notification['dispatch_id']]);
                    $row = $stmt->fetch(PDO::FETCH_ASSOC);
                } else {
                    $row = false;
                }
                if ($row !== false && $row !== null) {
                    $incidentType = $row['incident_type'];
                    $lat = $row['latitude'];
                    $lng = $row['longitude'];
                }
                $location = self::formatLocation($lat, $lng);
                $what = $incidentType !== null ? "a {$incidentType} incident" : 'an active incident';
                return [
                    'title' => 'PRIORITY ALERT',
                    'body' => "Priority alert for {$what}{$location}. Open the app immediately.",
                    'sms' => "BARANGUARD PRIORITY ALERT: {$what}{$location}. Open the app immediately.",
                    'message_type' => 'priority_alert',
                ];

            default: // 'other' — no caller in this codebase creates one yet.
                return [
                    'title' => 'Baranguard notification',
                    'body' => 'You have a new notification. Open the app for details.',
                    'sms' => 'BARANGUARD: You have a new notification. Open the app.',
                    'message_type' => '', // Deliberately unmapped — see dispatchToTarget()'s SMS branch.
                ];
        }
    }

    private static function formatLocation($lat, $lng): string
    {
        if ($lat === null || $lng === null) {
            return '';
        }
        return sprintf(' near %.5f, %.5f', (float) $lat, (float) $lng);
    }

    /**
     * @param array{notification_type:string,barangay_id:int,dispatch_id:?int,sos_id:?int,incident_id:?int} $notification
     * @param array{title:string,body:string,sms:string,message_type:string} $message
     * @param array{notification_target_id:int,user_id:int,device_id:?string} $target
     */
    private function dispatchToTarget(PDO $pdo, int $notificationId, array $notification, array $message, array $target): void
    {
        // The FCM token (if any) is re-resolved at SEND time, not trusted
        // from the target row alone — the device could have been
        // deactivated in the (very short) window since the target was
        // created.
        $fcmToken = null;
        if ($target['device_id'] !== null) {
            $stmt = $pdo->prepare(
                'SELECT fcm_token FROM mobile_device WHERE device_id = :device_id AND is_active = 1'
            );
            $stmt->execute(['device_id' => $target['device_id']]);
            $token = $stmt->fetchColumn();
            $fcmToken = is_string($token) && $token !== '' ? $token : null;
        }

        if ($fcmToken === null) {
            // Rule 12: "if no active FCM registration, go straight to SMS
            // with no FCM attempt."
            $this->attemptSms($pdo, $notification, $message, $target, attemptNo: 1);
            return;
        }

        $data = [
            'notification_id' => (string) $notificationId,
            'notification_type' => $notification['notification_type'],
        ];

        $sent = $this->attemptFcm($pdo, $target, $fcmToken, $message, attemptNo: 1, data: $data);
        if ($sent) {
            return;
        }

        // Rule 12: "FCM send error/timeout -> retry once".
        $sent = $this->attemptFcm($pdo, $target, $fcmToken, $message, attemptNo: 2, data: $data);
        if ($sent) {
            return;
        }

        // Rule 12: "...then SMS on second failure."
        $this->attemptSms($pdo, $notification, $message, $target, attemptNo: 1);
    }

    /**
     * @param array{notification_target_id:int,user_id:int,device_id:?string} $target
     * @param array{title:string,body:string,sms:string,message_type:string} $message
     * @param array<string,string> $data
     */
    private function attemptFcm(PDO $pdo, array $target, string $fcmToken, array $message, int $attemptNo, array $data): bool
    {
        $deliveryId = $this->insertDeliveryAttempt($pdo, $target['notification_target_id'], 'fcm', $attemptNo);

        if (!$this->fcm->isConfigured()) {
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'failed', null, 'FCM_NOT_CONFIGURED');
            return false;
        }

        try {
            $result = $this->fcm->send($fcmToken, $message['title'], $message['body'], $data);
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'sent', $result['provider_message_id'], null);
            return true;
        } catch (FcmException $e) {
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'failed', null, self::truncateReason($e->getMessage()));
            return false;
        }
    }

    /**
     * @param array{notification_type:string,barangay_id:int,dispatch_id:?int,sos_id:?int,incident_id:?int} $notification
     * @param array{title:string,body:string,sms:string,message_type:string} $message
     * @param array{notification_target_id:int,user_id:int,device_id:?string} $target
     */
    private function attemptSms(PDO $pdo, array $notification, array $message, array $target, int $attemptNo): void
    {
        $deliveryId = $this->insertDeliveryAttempt($pdo, $target['notification_target_id'], 'sms', $attemptNo);

        if ($message['message_type'] === '') {
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'failed', null, 'UNSUPPORTED_NOTIFICATION_TYPE_FOR_SMS');
            return;
        }

        $phoneStmt = $pdo->prepare('SELECT contact_number FROM user WHERE user_id = :user_id');
        $phoneStmt->execute(['user_id' => $target['user_id']]);
        $phone = $phoneStmt->fetchColumn();
        if (!is_string($phone) || trim($phone) === '') {
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'failed', null, 'NO_CONTACT_NUMBER');
            return;
        }

        // Rule 5: "Critical alerts use the configured Semaphore priority
        // path." SOS and priority_alert both count as critical here;
        // ordinary dispatch instructions use the regular endpoint. Delegated
        // to SmsGatewayService — see this class's constructor doc for why.
        $usePriority = in_array($notification['notification_type'], ['sos', 'priority_alert'], true);
        $result = $this->smsGateway->sendOutbound(
            $pdo,
            $message['message_type'],
            $usePriority,
            $notification['incident_id'],
            $notification['dispatch_id'],
            $phone,
            $message['sms'],
            $notification['barangay_id']
        );

        $this->finalizeDeliveryAttempt(
            $pdo,
            $deliveryId,
            $result['status'],
            $result['gateway_message_id'] ?? null,
            $result['failure_reason'] ?? null
        );
    }

    private function insertDeliveryAttempt(PDO $pdo, int $targetId, string $channel, int $attemptNo): int
    {
        $stmt = $pdo->prepare(
            "INSERT INTO notification_delivery
                (notification_id, notification_target_id, channel, attempt_no, status, initiated_at)
             SELECT notification_id, :target_id, :channel, :attempt_no, 'initiated', UTC_TIMESTAMP()
             FROM notification_target WHERE notification_target_id = :target_id2"
        );
        $stmt->execute([
            'target_id' => $targetId,
            'channel' => $channel,
            'attempt_no' => $attemptNo,
            'target_id2' => $targetId,
        ]);
        return (int) $pdo->lastInsertId();
    }

    private function finalizeDeliveryAttempt(PDO $pdo, int $deliveryId, string $status, ?string $providerMessageId, ?string $failureReason): void
    {
        $stmt = $pdo->prepare(
            "UPDATE notification_delivery
                SET status = :status,
                    provider_message_id = :provider_message_id,
                    sent_at = :sent_at,
                    failure_reason = :failure_reason
              WHERE delivery_id = :delivery_id"
        );
        $stmt->execute([
            'status' => $status,
            'provider_message_id' => $providerMessageId,
            'sent_at' => $status === 'sent' ? gmdate('Y-m-d H:i:s') : null,
            'failure_reason' => $failureReason,
            'delivery_id' => $deliveryId,
        ]);
    }

    private static function truncateReason(string $reason): string
    {
        // §5 notification_delivery.failure_reason / sms_log.failure_reason
        // are both VARCHAR(255).
        return mb_strlen($reason) > 255 ? mb_substr($reason, 0, 254) . '…' : $reason;
    }
}
