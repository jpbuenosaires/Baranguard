<?php
declare(strict_types=1);

namespace Baranguard\Services\Sms;

use Baranguard\Controllers\DutyStatusController;
use Baranguard\Controllers\GpsController;
use Baranguard\Controllers\IncidentsController;
use Baranguard\Controllers\SettingsController;
use Baranguard\Controllers\TanodSosController;
use Baranguard\Lib\Audit;
use Baranguard\Services\Notifications\SemaphoreClient;
use Baranguard\Services\Notifications\SemaphoreException;
use PDO;

/**
 * SmsGatewayService — both halves of §6 "Internal SMS / GSM":
 *
 *   RECEIVING (`receive*` methods, called only from the internal-only
 *   `/internal/sms/*` router): validates an inbound encrypted envelope
 *   (shape, freshness, replay, sender authenticity), then reconstructs
 *   the SAME business event the app itself would have produced online —
 *   by calling the exact same `createMobileItem`/`createItem`/
 *   `applyToggle`/`createItem` core methods `SyncController` already
 *   reuses, never a second copy of that logic. §2 Rule 13: "Sender
 *   identity is derived server-side from a registered Tanod/device
 *   mapping; any user ID included in the SMS payload is ignored for
 *   authorization" — every `receive*` method resolves `$identity` from
 *   the device mapping BEFORE touching the decrypted payload, and never
 *   reads a user id out of that payload at all.
 *
 *   SENDING (`sendOutbound`): the shared core behind
 *   `NotificationDispatcher`'s SMS-fallback step AND the internal
 *   `/internal/sms/dispatch-payload` / `/internal/sms/priority-alert`
 *   endpoints — one implementation, so the two can never drift apart.
 *
 * REJECTIONS ARE DELIBERATELY UNDIFFERENTIATED. Every failure mode below
 * — malformed envelope, unknown device, wrong key, tampered ciphertext,
 * expired envelope, or a replayed message_id — surfaces to the HTTP layer
 * as the same generic 401/422 with no detail that would help an attacker
 * distinguish "this device doesn't exist" from "this envelope's tag
 * failed" from "I already saw this message_id". That mirrors this
 * project's existing pattern for device/dispatch ownership checks
 * (DevicesController, DispatchController) — a more specific error message
 * would let a probing attacker enumerate valid device ids or replay
 * timing.
 */
final class SmsGatewayService
{
    private const MAX_ENVELOPE_LIFETIME_SECONDS = 1800; // 30 minutes: caps how long a captured envelope stays exploitable even before message_id replay-dedup is considered.
    private const CLOCK_SKEW_TOLERANCE_SECONDS = 300; // 5 minutes.
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    private EnvelopeCrypto $crypto;
    private DeviceSecretVault $vault;
    // Null unless explicitly injected (tests only, per a full search of
    // this codebase's own call sites) — the real, default case resolves
    // lazily in `resolveSemaphore()` below, because that's the first
    // point a `$pdo` is available to check `system_settings`.
    private ?SemaphoreClient $semaphoreOverride;

    public function __construct(?EnvelopeCrypto $crypto = null, ?DeviceSecretVault $vault = null, ?SemaphoreClient $semaphore = null)
    {
        $this->crypto = $crypto ?? new EnvelopeCrypto();
        $this->vault = $vault ?? new DeviceSecretVault();
        $this->semaphoreOverride = $semaphore;
    }

    /**
     * 2026-09-05 UX pass — Settings-first, `.env`-fallback resolution of
     * the SMS gateway client. This is the one piece of the deliberate
     * W21-override (migration 0012's own comment) that's actually wired
     * into real behavior rather than just stored: a value saved via
     * `PATCH /system-settings` genuinely changes which Semaphore
     * account/sender name outbound SMS uses, the next call. An unset
     * setting (empty string) falls through to `SemaphoreClient`'s own
     * `.env` default exactly as before this pass existed.
     */
    private function resolveSemaphore(PDO $pdo): SemaphoreClient
    {
        if ($this->semaphoreOverride !== null) {
            return $this->semaphoreOverride;
        }
        $apiKey = SettingsController::get($pdo, 'sms_gateway.api_key');
        $senderName = SettingsController::get($pdo, 'sms_gateway.sender_name');
        return new SemaphoreClient($apiKey !== '' ? $apiKey : null, $senderName !== '' ? $senderName : null);
    }

    // --- Inbound: /internal/sms/incident-fallback -------------------------

    /**
     * @param array<string,mixed> $envelope
     * @return array{incident_id:int,wasCreated:bool}
     */
    public function receiveIncidentFallback(PDO $pdo, array $envelope): array
    {
        $resolved = $this->resolveAndDecrypt($pdo, $envelope, 'incident_fallback');
        $payload = $resolved['payload'];

        $item = [
            'incident_type' => $payload['incident_type'] ?? null,
            'raw_narrative' => $payload['raw_narrative'] ?? null,
            'latitude' => $payload['latitude'] ?? null,
            'longitude' => $payload['longitude'] ?? null,
            'device_offline_created_at' => $payload['device_offline_created_at'] ?? null,
            'client_event_id' => $resolved['clientEventId'],
        ];

        $result = IncidentsController::createMobileItem($pdo, $resolved['identity'], $resolved['deviceId'], $item, 'sms');

        $this->logInbound($pdo, $resolved, 'incident', $result['incident']['incident_id'], null);

        return ['incident_id' => (int) $result['incident']['incident_id'], 'wasCreated' => $result['wasCreated']];
    }

    // --- Inbound: /internal/sms/coord-ping ---------------------------------

    /**
     * @param array<string,mixed> $envelope
     * @return array{track_id:int,wasCreated:bool}
     */
    public function receiveCoordPing(PDO $pdo, array $envelope): array
    {
        $resolved = $this->resolveAndDecrypt($pdo, $envelope, 'coord_ping');
        $payload = $resolved['payload'];

        $item = [
            'latitude' => $payload['latitude'] ?? null,
            'longitude' => $payload['longitude'] ?? null,
            'accuracy_m' => $payload['accuracy_m'] ?? null,
            'recorded_at' => $payload['recorded_at'] ?? null,
            'dispatch_id' => $payload['dispatch_id'] ?? null,
            'client_event_id' => $resolved['clientEventId'],
        ];

        $result = GpsController::createItem($pdo, $resolved['identity'], $item);

        $this->logInbound($pdo, $resolved, 'coord_ping', null, is_int($item['dispatch_id']) ? $item['dispatch_id'] : null);

        return ['track_id' => $result['track_id'], 'wasCreated' => $result['wasCreated']];
    }

    // --- Inbound: /internal/sms/duty-status --------------------------------

    /**
     * @param array<string,mixed> $envelope
     * @return array{status_id:int,wasCreated:bool}
     */
    public function receiveDutyStatus(PDO $pdo, array $envelope): array
    {
        $resolved = $this->resolveAndDecrypt($pdo, $envelope, 'duty_status');
        $status = $resolved['payload']['status'] ?? null;

        $result = DutyStatusController::applyToggle($pdo, $resolved['identity'], is_string($status) ? $status : '', $resolved['clientEventId'], 'sms');

        if ($result['wasCreated']) {
            Audit::record(
                $pdo,
                $resolved['identity']['barangay_id'],
                $resolved['identity']['user_id'],
                'duty_status_changed',
                'duty_status',
                $result['status_id'],
                ['status' => $result['status'], 'channel' => 'sms']
            );
        }

        $this->logInbound($pdo, $resolved, 'duty_status', null, null);

        return ['status_id' => $result['status_id'], 'wasCreated' => $result['wasCreated']];
    }

    // --- Inbound: /internal/sms/sos -----------------------------------------

    /**
     * §6: "dedicated SOS fallback path; ... creates or correlates the SOS
     * if app submission could not reach the workstation." Reuses
     * `TanodSosController::createItem()` verbatim — including its own
     * Rule 27 fan-out and immediate FCM/SMS dispatch attempt, so an
     * SMS-originated SOS is indistinguishable in every downstream respect
     * from one raised through the app.
     *
     * @param array<string,mixed> $envelope
     * @return array{sos_id:int,wasCreated:bool}
     */
    public function receiveSos(PDO $pdo, array $envelope): array
    {
        $resolved = $this->resolveAndDecrypt($pdo, $envelope, 'sos');
        $payload = $resolved['payload'];

        $item = [
            'latitude' => $payload['latitude'] ?? null,
            'longitude' => $payload['longitude'] ?? null,
            'dispatch_id' => $payload['dispatch_id'] ?? null,
            'client_event_id' => $resolved['clientEventId'],
            'fallback_channel' => 'sms',
        ];

        $result = TanodSosController::createItem($pdo, $resolved['identity'], $item);

        $this->logInbound($pdo, $resolved, 'sos', null, is_int($item['dispatch_id']) ? $item['dispatch_id'] : null);

        return ['sos_id' => $result['sos_id'], 'wasCreated' => $result['wasCreated']];
    }

    // --- Shared inbound plumbing --------------------------------------------

    /**
     * @param array<string,mixed> $envelope
     * @return array{identity:array{user_id:int,barangay_id:int,role:string},deviceId:string,clientEventId:string,payload:array<string,mixed>}
     * @throws EnvelopeException
     */
    private function resolveAndDecrypt(PDO $pdo, array $envelope, string $expectedMessageType): array
    {
        foreach (['version', 'message_id', 'device_id', 'client_event_id', 'created_at', 'expiry', 'message_type', 'nonce', 'ciphertext', 'tag'] as $field) {
            if (!isset($envelope[$field]) || !is_string($envelope[$field]) || $envelope[$field] === '') {
                throw new EnvelopeException("Envelope is missing required field: {$field}.");
            }
        }
        $messageId = $envelope['message_id'];
        $deviceId = $envelope['device_id'];
        $clientEventId = $envelope['client_event_id'];
        $createdAtRaw = $envelope['created_at'];
        $expiryRaw = $envelope['expiry'];
        $messageType = $envelope['message_type'];

        if (!preg_match(self::UUID_PATTERN, $messageId) || !preg_match(self::UUID_PATTERN, $clientEventId)) {
            throw new EnvelopeException('message_id/client_event_id must be UUIDs.');
        }
        if ($messageType !== $expectedMessageType) {
            throw new EnvelopeException('message_type does not match this endpoint.');
        }

        $createdAt = strtotime($createdAtRaw);
        $expiry = strtotime($expiryRaw);
        if ($createdAt === false || $expiry === false) {
            throw new EnvelopeException('created_at/expiry are not valid timestamps.');
        }
        $now = time();
        if ($expiry - $createdAt > self::MAX_ENVELOPE_LIFETIME_SECONDS) {
            throw new EnvelopeException('Envelope lifetime exceeds the maximum allowed.');
        }
        if ($createdAt > $now + self::CLOCK_SKEW_TOLERANCE_SECONDS) {
            throw new EnvelopeException('Envelope created_at is in the future.');
        }
        if ($now > $expiry) {
            throw new EnvelopeException('Envelope has expired.');
        }

        // Replay dedup FIRST, via the PK's own uniqueness — an attacker
        // replaying a captured envelope twice in quick succession can't
        // both land inside the "not yet recorded" window.
        try {
            $pdo->prepare(
                'INSERT INTO sms_envelope_replay (message_id, device_id, received_at) VALUES (:message_id, :device_id, UTC_TIMESTAMP())'
            )->execute(['message_id' => $messageId, 'device_id' => $deviceId]);
        } catch (\PDOException $e) {
            // 23000 = integrity constraint violation (duplicate PK, or the
            // device_id FK doesn't exist — both are legitimate rejections).
            throw new EnvelopeException('Envelope was already processed, or references an unknown device.');
        }

        $deviceStmt = $pdo->prepare(
            'SELECT md.user_id, md.device_secret_ref, u.barangay_id, u.role, u.is_active
             FROM mobile_device md
             JOIN user u ON u.user_id = md.user_id
             WHERE md.device_id = :device_id AND md.is_active = 1'
        );
        $deviceStmt->execute(['device_id' => $deviceId]);
        $device = $deviceStmt->fetch(PDO::FETCH_ASSOC);
        if (
            $device === false
            || (int) $device['is_active'] !== 1
            || $device['role'] !== 'tanod'
            || $device['device_secret_ref'] === null
        ) {
            throw new EnvelopeException('Device is not registered, inactive, or has no provisioned secret.');
        }

        try {
            $rawSecret = $this->vault->unwrap((string) $device['device_secret_ref']);
        } catch (\RuntimeException $e) {
            throw new EnvelopeException('Device secret could not be unwrapped: ' . $e->getMessage());
        }

        $aad = EnvelopeCrypto::buildAad($envelope['version'], $messageId, $deviceId, $clientEventId, $createdAtRaw, $expiryRaw, $messageType);
        $payload = $this->crypto->decryptPayload($rawSecret, $envelope['nonce'], $envelope['ciphertext'], $envelope['tag'], $aad);

        return [
            'identity' => [
                'user_id' => (int) $device['user_id'],
                'barangay_id' => (int) $device['barangay_id'],
                'role' => 'tanod',
            ],
            'deviceId' => $deviceId,
            'clientEventId' => $clientEventId,
            'payload' => $payload,
        ];
    }

    /**
     * @param array{identity:array{user_id:int,barangay_id:int,role:string},deviceId:string,clientEventId:string,payload:array<string,mixed>} $resolved
     */
    private function logInbound(PDO $pdo, array $resolved, string $messageType, ?int $incidentId, ?int $dispatchId): void
    {
        $stmt = $pdo->prepare(
            "INSERT INTO sms_log
                (incident_id, dispatch_id, barangay_id, transport, message_type, direction, correlation_id, status, received_at, created_at)
             VALUES
                (:incident_id, :dispatch_id, :barangay_id, 'gsm_modem', :message_type, 'inbound', :correlation_id, 'received', UTC_TIMESTAMP(), UTC_TIMESTAMP())"
        );
        $stmt->execute([
            'incident_id' => $incidentId,
            'dispatch_id' => $dispatchId,
            'barangay_id' => $resolved['identity']['barangay_id'],
            'message_type' => $messageType,
            'correlation_id' => $resolved['clientEventId'],
        ]);
    }

    // --- Outbound: shared by NotificationDispatcher and the internal
    //     /internal/sms/dispatch-payload + /internal/sms/priority-alert
    //     endpoints — one implementation, so the two can never drift.

    /**
     * @param string $smsLogMessageType one of sms_log's message_type enum
     *        values ('dispatch','priority_alert','sos','confirmation','manual').
     * @param ?int $barangayId see migration 0006's own doc for why this is
     *        a dedicated column rather than derived from incident/dispatch.
     * @param ?string $correlationId (2026-09-05 UX pass) — set by
     *        `SmsController::send()`/`broadcast()` to their
     *        Idempotency-Key, so a retry can be detected by looking this
     *        row up directly rather than guessing "the most recent row
     *        for this phone number" (which would race under concurrent
     *        sends to the same number).
     * @param ?int $reportId links a manual reply back to the citizen
     *        report it's answering, when applicable.
     * @return array{status:'sent'|'failed',log_id:int,gateway_message_id?:string,failure_reason?:string}
     */
    public function sendOutbound(
        PDO $pdo,
        string $smsLogMessageType,
        bool $priority,
        ?int $incidentId,
        ?int $dispatchId,
        string $phoneNumber,
        string $message,
        ?int $barangayId = null,
        ?string $correlationId = null,
        ?int $reportId = null
    ): array {
        $semaphore = $this->resolveSemaphore($pdo);

        if (!$semaphore->isConfigured()) {
            $logId = $this->logOutbound($pdo, $smsLogMessageType, $incidentId, $dispatchId, $reportId, $barangayId, $phoneNumber, $message, 'failed', null, 'SEMAPHORE_NOT_CONFIGURED', $correlationId);
            return ['status' => 'failed', 'log_id' => $logId, 'failure_reason' => 'SEMAPHORE_NOT_CONFIGURED'];
        }

        try {
            $result = $priority ? $semaphore->sendPriority($phoneNumber, $message) : $semaphore->send($phoneNumber, $message);
            $logId = $this->logOutbound($pdo, $smsLogMessageType, $incidentId, $dispatchId, $reportId, $barangayId, $phoneNumber, $message, 'sent', $result['gateway_message_id'], null, $correlationId);
            return ['status' => 'sent', 'log_id' => $logId, 'gateway_message_id' => $result['gateway_message_id']];
        } catch (SemaphoreException $e) {
            $reason = mb_strlen($e->getMessage()) > 255 ? mb_substr($e->getMessage(), 0, 254) . '…' : $e->getMessage();
            $logId = $this->logOutbound($pdo, $smsLogMessageType, $incidentId, $dispatchId, $reportId, $barangayId, $phoneNumber, $message, 'failed', null, $reason, $correlationId);
            return ['status' => 'failed', 'log_id' => $logId, 'failure_reason' => $reason];
        }
    }

    private function logOutbound(PDO $pdo, string $messageType, ?int $incidentId, ?int $dispatchId, ?int $reportId, ?int $barangayId, string $phone, string $messageBody, string $status, ?string $gatewayMessageId, ?string $failureReason, ?string $correlationId = null): int
    {
        // message_body (migration 0013, 2026-09-05 UX pass) — the actual
        // text is now persisted for every NEW outbound send, going
        // forward only (rows from before this migration stay NULL,
        // never backfilled with a guess — §2 Rule 6).
        $stmt = $pdo->prepare(
            "INSERT INTO sms_log
                (incident_id, dispatch_id, report_id, barangay_id, receiver_number, transport, message_type, direction,
                 gateway_message_id, status, sent_at, failure_reason, message_body, correlation_id, created_at)
             VALUES
                (:incident_id, :dispatch_id, :report_id, :barangay_id, :receiver_number, 'semaphore', :message_type, 'outbound',
                 :gateway_message_id, :status, :sent_at, :failure_reason, :message_body, :correlation_id, UTC_TIMESTAMP())"
        );
        $stmt->execute([
            'incident_id' => $incidentId,
            'dispatch_id' => $dispatchId,
            'report_id' => $reportId,
            'barangay_id' => $barangayId,
            'receiver_number' => $phone,
            'message_type' => $messageType,
            'gateway_message_id' => $gatewayMessageId,
            'status' => $status,
            'sent_at' => $status === 'sent' ? gmdate('Y-m-d H:i:s') : null,
            'failure_reason' => $failureReason,
            'message_body' => $messageBody,
            'correlation_id' => $correlationId,
        ]);
        return (int) $pdo->lastInsertId();
    }
}
