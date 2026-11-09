<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Services\Sms\EnvelopeException;
use Baranguard\Services\Sms\SmsGatewayService;
use PDO;

/**
 * The `/internal/sms/*` handlers. Reached ONLY through
 * `backend/public/internal.php`, never through the normal `/api/v1` router:
 * that front controller enforces loopback + `X-Internal-Token` BEFORE any of
 * these methods run, so nothing here repeats an auth check and there is no
 * JWT/session identity on this path. Each inbound handler additionally
 * authenticates the SENDER via `SmsGatewayService`'s envelope/device
 * resolution before trusting anything in the payload.
 *
 * Every method is a thin wrapper: all real logic lives in
 * `SmsGatewayService`, which both this controller AND
 * `NotificationDispatcher` (the in-process outbound trigger) call, so there
 * is never a second implementation of the same business logic.
 *
 * INBOUND endpoints (incident-fallback, coord-ping, duty-status, sos)
 * accept the encrypted envelope FLAT as the request body (version,
 * message_id, device_id, client_event_id, created_at, expiry, message_type,
 * nonce, ciphertext, tag). One optional field outside the envelope,
 * `sender_number` (the number the modem received the SMS from), is never
 * trusted for identity (that comes from the device mapping); it only
 * populates `sms_log.sender_number`.
 *
 * OUTBOUND endpoints (dispatch-payload, priority-alert) accept a
 * pre-composed `{phone_number,message,incident_id?,dispatch_id?}`; composing
 * the text is `NotificationDispatcher`'s job. They exist so the "send
 * outbound, write sms_log" half can be exercised in isolation; they are NOT
 * the production trigger for outbound SMS, which calls the shared service
 * in-process.
 */
final class InternalSmsController
{
    public static function incidentFallback(PDO $pdo): void
    {
        self::handleInbound($pdo, static fn (SmsGatewayService $svc, array $envelope) => [
            'incident_id' => $svc->receiveIncidentFallback($pdo, $envelope)['incident_id'],
        ]);
    }

    public static function coordPing(PDO $pdo): void
    {
        self::handleInbound($pdo, static fn (SmsGatewayService $svc, array $envelope) => [
            'track_id' => $svc->receiveCoordPing($pdo, $envelope)['track_id'],
        ]);
    }

    public static function dutyStatus(PDO $pdo): void
    {
        self::handleInbound($pdo, static fn (SmsGatewayService $svc, array $envelope) => [
            'status_id' => $svc->receiveDutyStatus($pdo, $envelope)['status_id'],
        ]);
    }

    public static function sos(PDO $pdo): void
    {
        self::handleInbound($pdo, static fn (SmsGatewayService $svc, array $envelope) => [
            'sos_id' => $svc->receiveSos($pdo, $envelope)['sos_id'],
        ]);
    }

    /**
     * Free-text inbound SMS (not an envelope), or a daemon-reported rejected
     * envelope (`rejected_reason` set; the body is then never stored).
     * Body: {sender_number, body, sms_key, rejected_reason?}.
     */
    public static function inboundText(PDO $pdo): void
    {
        $b = Http::jsonBody();
        $sender = $b['sender_number'] ?? null;
        $text = $b['body'] ?? '';
        $key = $b['sms_key'] ?? null;
        $reason = $b['rejected_reason'] ?? null;
        if (!is_string($sender) || $sender === '' || !is_string($text) || !is_string($key) || $key === ''
            || ($reason !== null && !is_string($reason))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'sender_number, body and sms_key are required.');
        }
        try {
            $r = (new SmsGatewayService())->receiveInboundText($pdo, $sender, $text, $key, $reason);
        } catch (EnvelopeException $e) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', $e->getMessage());
        }
        Http::send(200, $r);
    }

    /** @param callable(SmsGatewayService,array<string,mixed>):array<string,mixed> $handle */
    private static function handleInbound(PDO $pdo, callable $handle): void
    {
        $envelope = Http::jsonBody();
        $svc = new SmsGatewayService();
        try {
            $result = $handle($svc, $envelope);
        } catch (EnvelopeException $e) {
            // Deliberately generic — see the class doc: no detail that
            // would help distinguish WHY an envelope was rejected.
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'Envelope could not be processed.');
        }
        Http::send(200, $result);
    }

    public static function dispatchPayload(PDO $pdo): void
    {
        self::handleOutbound($pdo, 'dispatch', priority: false);
    }

    public static function priorityAlert(PDO $pdo): void
    {
        self::handleOutbound($pdo, 'priority_alert', priority: true);
    }

    private static function handleOutbound(PDO $pdo, string $messageType, bool $priority): void
    {
        $body = Http::jsonBody();
        $phone = $body['phone_number'] ?? null;
        $message = $body['message'] ?? null;
        $incidentId = $body['incident_id'] ?? null;
        $dispatchId = $body['dispatch_id'] ?? null;
        // No caller identity exists on this router (see class doc) to
        // derive a tenant from, so it must be supplied explicitly — these
        // two endpoints are the direct-testing path, not the production
        // trigger, which always goes through NotificationDispatcher and
        // already knows barangay_id from the notification row itself.
        $barangayId = $body['barangay_id'] ?? null;

        if (!is_string($phone) || trim($phone) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'phone_number is required.');
        }
        if (!is_string($message) || trim($message) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'message is required.');
        }
        if (!is_int($barangayId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id is required.');
        }

        $svc = new SmsGatewayService();
        $result = $svc->sendOutbound(
            $pdo,
            $messageType,
            $priority,
            is_int($incidentId) ? $incidentId : null,
            is_int($dispatchId) ? $dispatchId : null,
            $phone,
            $message,
            $barangayId
        );

        Http::send($result['status'] === 'failed' ? 502 : 200, $result);
    }
}
