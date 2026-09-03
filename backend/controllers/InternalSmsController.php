<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Services\Notifications\SemaphoreClient;
use Baranguard\Services\Sms\EnvelopeException;
use Baranguard\Services\Sms\SmsGatewayService;
use PDO;

/**
 * The six `/internal/sms/*` handlers — §6 "Internal SMS / GSM". Reached
 * ONLY through `backend/public/internal.php`, never through the normal
 * `/api/v1` router: that front controller enforces loopback +
 * `X-Internal-Token` BEFORE any of these methods run, so nothing here
 * repeats an auth check `AuthMiddleware` would normally do — there is no
 * JWT/session identity on this path at all (§2 Rule 22: "Inbound SMS is
 * authenticated ... passed to internal handlers over loopback or an
 * equally protected local service boundary" — the loopback/token check IS
 * that authentication for the CHANNEL; each inbound handler additionally
 * authenticates the SENDER via `SmsGatewayService`'s envelope/device
 * resolution before trusting anything in the payload).
 *
 * Every method here is a thin wrapper: all real logic lives in
 * `SmsGatewayService`, which is what both this controller AND
 * `NotificationDispatcher` (the in-process outbound trigger — see its own
 * class doc) call. Keeping these methods thin is deliberate — it is what
 * makes them safe to expose as real, curl-able endpoints for direct
 * testing without risking two divergent implementations of the same
 * business logic.
 *
 * INBOUND endpoints (incident-fallback, coord-ping, duty-status, sos)
 * accept the envelope FLAT as the request body, per §6: "body
 * {encrypted_envelope}" — the JSON object's own top-level keys ARE the
 * envelope fields (version, message_id, device_id, client_event_id,
 * created_at, expiry, message_type, nonce, ciphertext, tag). One
 * additional field NOT part of the encrypted envelope, `sender_number`, is
 * accepted optionally — it is ingestion-layer metadata (the phone number
 * the modem actually received the SMS FROM), never trusted for identity
 * (Rule 13 already derives that from the device mapping), used only to
 * populate `sms_log.sender_number` for W14's audit trail. Resolved and
 * logged here rather than silently invented, same as every other
 * documented-in-prose-only field gap in this codebase.
 *
 * OUTBOUND endpoints (dispatch-payload, priority-alert) accept a
 * pre-composed `{phone_number,message,incident_id?,dispatch_id?}` rather
 * than re-deriving message text from an id — composing that text is
 * `NotificationDispatcher`'s job (already exercised end-to-end via SOS/
 * dispatch creation); these two endpoints exist so the "send via
 * Semaphore, write sms_log" half of that path is independently curl-able
 * and testable in isolation, per §6 listing them as real endpoints. They
 * are NOT the production trigger for outbound SMS — see `SmsGatewayService`
 * and `NotificationDispatcher`'s own docs for why the actual automation
 * calls the shared service in-process instead of looping back through
 * HTTP to itself.
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

        Http::send($result['status'] === 'sent' ? 200 : 502, $result);
    }
}
