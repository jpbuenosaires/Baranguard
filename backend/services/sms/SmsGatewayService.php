<?php
declare(strict_types=1);

namespace Baranguard\Services\Sms;

use Baranguard\Controllers\DutyStatusController;
use Baranguard\Controllers\GpsController;
use Baranguard\Controllers\IncidentsController;
use Baranguard\Controllers\TanodSosController;
use Baranguard\Lib\Audit;
use Baranguard\Services\Notifications\GsmGatewayException;
use Baranguard\Services\Notifications\GsmUnconfirmedException;
use Baranguard\Services\Notifications\LocalGsmOutboundClient;
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
    // lazily in `resolveOutboundClient()` below.
    private ?LocalGsmOutboundClient $outboundClientOverride;

    public function __construct(?EnvelopeCrypto $crypto = null, ?DeviceSecretVault $vault = null, ?LocalGsmOutboundClient $outboundClient = null)
    {
        $this->crypto = $crypto ?? new EnvelopeCrypto();
        $this->vault = $vault ?? new DeviceSecretVault();
        $this->outboundClientOverride = $outboundClient;
    }

    /**
     * 2026-09-23: Semaphore removed (explicit user decision — a paid
     * per-SMS aggregator cost too much for this project's actual volume;
     * see DEVLOG.md). Outbound now goes through the same tethered phone
     * `gsm-ingest-daemon.php` already reads INBOUND SMS off —
     * `LocalGsmOutboundClient`'s own doc block has the full mechanism.
     * `system_settings`' former `sms_gateway.api_key`/`sender_name` keys
     * are gone with it: this transport has no cloud credential and no
     * configurable sender name (messages come from the gateway phone's
     * own number), so there was nothing left for that Settings card to
     * hold — `GSM_GATEWAY_ENABLED`/`GSM_GATEWAY_ADB_PATH` are `.env`-only
     * ops configuration, not something an Admin toggles per barangay.
     */
    private function resolveOutboundClient(): LocalGsmOutboundClient
    {
        return $this->outboundClientOverride ?? new LocalGsmOutboundClient();
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
        // A replayed SOS envelope returns the original SOS (createItem is
        // idempotent on client_event_id) instead of a 422 the daemon would drop.
        $resolved = $this->resolveAndDecrypt($pdo, $envelope, 'sos', true);
        $payload = $resolved['payload'];

        $item = [
            'latitude' => $payload['latitude'] ?? null,
            'longitude' => $payload['longitude'] ?? null,
            'dispatch_id' => $payload['dispatch_id'] ?? null,
            'client_event_id' => $resolved['clientEventId'],
            'fallback_channel' => 'sms',
        ];

        $result = TanodSosController::createItem($pdo, $resolved['identity'], $item);

        if (!$resolved['replayed']) {
            $this->logInbound($pdo, $resolved, 'sos', null, is_int($item['dispatch_id']) ? $item['dispatch_id'] : null);
        }

        return ['sos_id' => $result['sos_id'], 'wasCreated' => $result['wasCreated']];
    }

    // --- Shared inbound plumbing --------------------------------------------

    /**
     * @param array<string,mixed> $envelope
     * @return array{replayed:bool,identity:array{user_id:int,barangay_id:int,role:string},deviceId:string,clientEventId:string,payload:array<string,mixed>}
     * @throws EnvelopeException
     */
    private function resolveAndDecrypt(PDO $pdo, array $envelope, string $expectedMessageType, bool $replayReturnsOriginal = false): array
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

        // Replay dedup after the device is known and the envelope authenticated,
        // via the PK's own uniqueness (two concurrent replays cannot both pass).
        $replayed = false;
        try {
            $pdo->prepare(
                'INSERT INTO sms_envelope_replay (message_id, device_id, received_at) VALUES (:message_id, :device_id, UTC_TIMESTAMP())'
            )->execute(['message_id' => $messageId, 'device_id' => $deviceId]);
        } catch (\PDOException $e) {
            if (!$replayReturnsOriginal) {
                throw new EnvelopeException('Envelope was already processed.');
            }
            // SOS only: the row may be left by an attempt that failed before the
            // SOS was stored, so let the client_event_id idempotency answer instead.
            $replayed = true;
        }

        return [
            'replayed' => $replayed,
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
     * @return array{status:'sent'|'pending'|'failed',log_id:int,gateway_message_id?:string,failure_reason?:string}
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
        $r = $this->attemptSend($priority, $phoneNumber, $message);
        $logId = $this->logOutbound($pdo, $smsLogMessageType, $incidentId, $dispatchId, $reportId, $barangayId, $phoneNumber, $message, $r['status'], $r['gateway_message_id'] ?? null, $r['failure_reason'] ?? null, $correlationId);
        return ['log_id' => $logId] + $r;
    }

    /**
     * One real send attempt. `sent` = the phone confirmed the hand-off to its
     * SIM (NOT carrier delivery); `pending` = handed to adb but no confirmation
     * in time, it MAY have gone out; `failed` = known not sent.
     *
     * @return array{status:'sent'|'pending'|'failed',gateway_message_id?:string,failure_reason?:string}
     */
    private function attemptSend(bool $priority, string $phoneNumber, string $message): array
    {
        $gateway = $this->resolveOutboundClient();
        if (!$gateway->isConfigured()) {
            return ['status' => 'failed', 'failure_reason' => 'GSM_GATEWAY_NOT_CONFIGURED'];
        }
        try {
            $result = $priority ? $gateway->sendPriority($phoneNumber, $message) : $gateway->send($phoneNumber, $message);
            return ['status' => 'sent', 'gateway_message_id' => $result['gateway_message_id']];
        } catch (GsmGatewayException $e) {
            $reason = mb_strlen($e->getMessage()) > 255 ? mb_substr($e->getMessage(), 0, 254) . '...' : $e->getMessage();
            return ['status' => $e instanceof GsmUnconfirmedException ? 'pending' : 'failed', 'failure_reason' => $reason];
        }
    }

    /**
     * Outbox: records a `queued` outbound row WITHOUT sending (used by
     * broadcasts so no HTTP request blocks on serial adb sends). `drainQueued()`
     * (run by notification-worker.php) sends them.
     */
    public function queueOutbound(PDO $pdo, string $smsLogMessageType, string $phoneNumber, string $message, int $barangayId): int
    {
        return $this->logOutbound($pdo, $smsLogMessageType, null, null, null, $barangayId, $phoneNumber, $message, 'queued', null, null, null);
    }

    /**
     * Sends up to $limit `queued` rows. Each row is claimed with an atomic
     * queued->pending UPDATE first, so a crash mid-send leaves an honest
     * `pending` (may or may not have gone out), never a silent resend.
     *
     * @return array{sent:int,pending:int,failed:int}
     */
    public function drainQueued(PDO $pdo, int $limit = 60): array
    {
        $rows = $pdo->query(
            "SELECT log_id, message_type, receiver_number, message_body FROM sms_log
              WHERE direction = 'outbound' AND status = 'queued' ORDER BY log_id LIMIT " . (int) $limit
        )->fetchAll(PDO::FETCH_ASSOC);
        $count = ['sent' => 0, 'pending' => 0, 'failed' => 0];
        $claim = $pdo->prepare("UPDATE sms_log SET status = 'pending' WHERE log_id = :id AND status = 'queued'");
        $done = $pdo->prepare(
            'UPDATE sms_log SET status = :status, sent_at = :sent_at, gateway_message_id = :gw, failure_reason = :reason WHERE log_id = :id'
        );
        foreach ($rows as $row) {
            $claim->execute(['id' => $row['log_id']]);
            if ($claim->rowCount() !== 1) {
                continue;
            }
            $r = $this->attemptSend($row['message_type'] === 'priority_alert', (string) $row['receiver_number'], (string) $row['message_body']);
            $done->execute([
                'status' => $r['status'], 'sent_at' => $r['status'] === 'sent' ? gmdate('Y-m-d H:i:s') : null,
                'gw' => $r['gateway_message_id'] ?? null, 'reason' => $r['failure_reason'] ?? null, 'id' => $row['log_id'],
            ]);
            $count[$r['status']]++;
        }
        return $count;
    }

    // --- Inbound free-text (not an envelope) -------------------------------

    private const OPT_OUT_WORDS = ['STOP', 'STOP ALL', 'UNSUBSCRIBE', 'TIGIL', 'HUWAG NA'];
    // GSM-7 only, one SMS, no personal data.
    private const OPT_OUT_CONFIRMATION = 'You will no longer receive barangay advisories. Hindi na kayo padadalhan ng abiso ng barangay.';

    /**
     * Stores a human text (or a daemon-reported rejected envelope) so SMS
     * Monitor's Conversations can show it. Barangay: GATEWAY_BARANGAY_ID, else
     * the only barangay in the DB (Rule 92: one workstation per barangay).
     * A STOP-style keyword opts the sender out of the advisory list (0018).
     * `message_body` of a rejected envelope is NEVER stored.
     *
     * @return array{log_id:int,duplicate:bool,opted_out:bool}
     * @throws EnvelopeException when no barangay can be resolved
     */
    public function receiveInboundText(PDO $pdo, string $sender, string $body, string $smsKey, ?string $rejectedReason): array
    {
        $configured = baranguard_env('GATEWAY_BARANGAY_ID');
        $barangayId = is_string($configured) && ctype_digit($configured) ? (int) $configured : 0;
        if ($barangayId === 0) {
            $ids = $pdo->query('SELECT barangay_id FROM barangay')->fetchAll(PDO::FETCH_COLUMN);
            if (count($ids) !== 1) {
                throw new EnvelopeException('Cannot tell which barangay this gateway serves (set GATEWAY_BARANGAY_ID).');
            }
            $barangayId = (int) $ids[0];
        }

        $h = md5('inbound-text:' . $smsKey);
        $correlation = substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20, 12);
        $dup = $pdo->prepare("SELECT log_id FROM sms_log WHERE barangay_id = :b AND direction = 'inbound' AND correlation_id = :c LIMIT 1");
        $dup->execute(['b' => $barangayId, 'c' => $correlation]);
        $existing = $dup->fetchColumn();
        if ($existing !== false) {
            return ['log_id' => (int) $existing, 'duplicate' => true, 'opted_out' => false];
        }

        // Canonical thread key: a registered user's own contact_number (so
        // 0917... and +63917... are one thread), else the raw sender.
        $digits = substr(preg_replace('/\D/', '', $sender) ?? '', -10);
        $canonical = mb_substr($sender, 0, 32);
        if (strlen($digits) === 10) {
            $u = $pdo->prepare("SELECT contact_number FROM user WHERE barangay_id = :b AND RIGHT(REGEXP_REPLACE(contact_number, '[^0-9]', ''), 10) = :d LIMIT 1");
            $u->execute(['b' => $barangayId, 'd' => $digits]);
            $match = $u->fetchColumn();
            if (is_string($match) && $match !== '') {
                $canonical = $match;
            }
        }

        $optedOut = false;
        if ($rejectedReason === null && strlen($digits) === 10
            && in_array(strtoupper(trim(preg_replace('/[^A-Za-z ]/', '', $body) ?? '')), self::OPT_OUT_WORDS, true)) {
            $o = $pdo->prepare(
                "UPDATE sms_subscriber SET opted_out_at = UTC_TIMESTAMP()
                  WHERE barangay_id = :b AND opted_out_at IS NULL AND RIGHT(REGEXP_REPLACE(contact_number, '[^0-9]', ''), 10) = :d"
            );
            $o->execute(['b' => $barangayId, 'd' => $digits]);
            $optedOut = $o->rowCount() > 0;
            if ($optedOut) {
                Audit::record($pdo, $barangayId, null, 'sms_subscriber_opted_out', 'sms_subscriber', null, ['channel' => 'sms']);
                // One confirmation, only on a new opt-out; queued so the worker sends it.
                $this->queueOutbound($pdo, 'confirmation', mb_substr($sender, 0, 32), self::OPT_OUT_CONFIRMATION, $barangayId);
            }
        }

        $stmt = $pdo->prepare(
            "INSERT INTO sms_log
                (barangay_id, sender_number, transport, message_type, direction, correlation_id, status, received_at, failure_reason, message_body, created_at)
             VALUES
                (:b, :sender, 'gsm_modem', 'manual', 'inbound', :c, :status, UTC_TIMESTAMP(), :reason, :body, UTC_TIMESTAMP())"
        );
        $stmt->execute([
            'b' => $barangayId, 'sender' => $canonical, 'c' => $correlation,
            'status' => $rejectedReason === null ? 'received' : 'rejected',
            'reason' => $rejectedReason !== null ? mb_substr($rejectedReason, 0, 255) : null,
            'body' => $rejectedReason === null ? mb_substr($body, 0, 480) : null,
        ]);
        return ['log_id' => (int) $pdo->lastInsertId(), 'duplicate' => false, 'opted_out' => $optedOut];
    }

    private function logOutbound(PDO $pdo, string $messageType, ?int $incidentId, ?int $dispatchId, ?int $reportId, ?int $barangayId, string $phone, string $messageBody, string $status, ?string $gatewayMessageId, ?string $failureReason, ?string $correlationId = null): int
    {
        // message_body (migration 0013, 2026-09-05 UX pass) — the actual
        // text is now persisted for every NEW outbound send, going
        // forward only (rows from before this migration stay NULL,
        // never backfilled with a guess — §2 Rule 6).
        // transport is 'gsm_modem' for every outbound row since 2026-09-23
        // (Semaphore removed) — the SAME tethered phone `gsm-ingest-daemon.php`
        // reads inbound SMS off, now sending too. Older rows with
        // transport='semaphore' are historical only; that enum value is
        // deliberately left in place rather than migrated (§2 Rule 9 — no
        // new numbered migration was worth it just to rename a retired
        // value on rows nothing writes anymore).
        $stmt = $pdo->prepare(
            "INSERT INTO sms_log
                (incident_id, dispatch_id, report_id, barangay_id, receiver_number, transport, message_type, direction,
                 gateway_message_id, status, sent_at, failure_reason, message_body, correlation_id, created_at)
             VALUES
                (:incident_id, :dispatch_id, :report_id, :barangay_id, :receiver_number, 'gsm_modem', :message_type, 'outbound',
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
