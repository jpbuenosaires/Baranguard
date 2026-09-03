<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

/**
 * SemaphoreClient — the outbound SMS gateway named in §1: "Semaphore SMS
 * Gateway + tethered phone as GSM modem fallback." Only the Semaphore
 * half of that pairing is implemented here; see .env.example's own note
 * on why GSM-modem OUTBOUND sending is explicitly out of this cut (no
 * serial/AT-command hardware exists to build or test against). GSM modem
 * INBOUND ingestion (a Tanod's phone SENDING to the tethered phone) is a
 * separate concern — see `EnvelopeCrypto`/`SmsGatewayService` and the
 * `/internal/sms/*` router.
 *
 * Two Semaphore endpoints, matching §6's own split:
 *   - `POST /api/v4/messages`  — ordinary send (dispatch payloads, etc).
 *   - `POST /api/v4/priority`  — §6 `/sms/priority-alert`: "sends priority
 *     notification via configured Semaphore priority endpoint." SOS
 *     alerts use this too (Rule 5: "Critical alerts use the configured
 *     Semaphore priority path").
 *
 * Configuration (see .env.example): SEMAPHORE_API_KEY. UNSET means this
 * deployment has no funded Semaphore account — `isConfigured()` is false,
 * `GET /system/health` reports `semaphore: not_configured`, and
 * `NotificationDispatcher` records the SMS attempt as `failed` with an
 * honest reason rather than pretending to have sent anything.
 *
 * NEVER CALLED WITH A REAL API KEY AS OF THIS COMMIT. Written against
 * Semaphore's own documented request/response shape
 * (https://semaphore.co/docs) so it starts working the moment a funded
 * account's key is dropped in.
 */
final class SemaphoreClient
{
    private const MESSAGES_URL = 'https://api.semaphore.co/api/v4/messages';
    private const PRIORITY_URL = 'https://api.semaphore.co/api/v4/priority';
    private const CONNECT_TIMEOUT_SECONDS = 5;
    private const REQUEST_TIMEOUT_SECONDS = 8;
    private const MAX_MESSAGE_LENGTH = 918; // Semaphore's own multi-part SMS ceiling (six 153-char segments).

    private ?string $apiKey;
    private ?string $senderName;

    public function __construct(?string $apiKey = null, ?string $senderName = null)
    {
        $this->apiKey = $apiKey ?? (baranguard_env('SEMAPHORE_API_KEY') ?: null);
        $senderName = $senderName ?? (baranguard_env('SEMAPHORE_SENDER_NAME') ?: null);
        $this->senderName = ($senderName !== null && trim($senderName) !== '') ? $senderName : null;
    }

    public function isConfigured(): bool
    {
        return $this->apiKey !== null && trim($this->apiKey) !== '';
    }

    /**
     * @return array{gateway_message_id:string}
     * @throws SemaphoreException
     */
    public function send(string $phoneNumber, string $message): array
    {
        return $this->post(self::MESSAGES_URL, $phoneNumber, $message);
    }

    /**
     * §6 "sends priority notification via configured Semaphore priority
     * endpoint" — used for `priority_alert` and `sos` notification types.
     *
     * @return array{gateway_message_id:string}
     * @throws SemaphoreException
     */
    public function sendPriority(string $phoneNumber, string $message): array
    {
        return $this->post(self::PRIORITY_URL, $phoneNumber, $message);
    }

    /** @return array{gateway_message_id:string} */
    private function post(string $url, string $phoneNumber, string $message): array
    {
        if (!$this->isConfigured()) {
            throw new SemaphoreException('Semaphore is not configured (set SEMAPHORE_API_KEY).');
        }
        if (mb_strlen($message) > self::MAX_MESSAGE_LENGTH) {
            $message = mb_substr($message, 0, self::MAX_MESSAGE_LENGTH - 1) . '…';
        }

        $body = [
            'apikey' => $this->apiKey,
            'number' => $phoneNumber,
            'message' => $message,
        ];
        if ($this->senderName !== null) {
            $body['sendername'] = $this->senderName;
        }

        if (!function_exists('curl_init')) {
            throw new SemaphoreException('PHP ext-curl is required to reach Semaphore.');
        }

        $handle = curl_init($url);
        if ($handle === false) {
            throw new SemaphoreException('Could not initialise an HTTP request to Semaphore.');
        }

        curl_setopt($handle, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($handle, CURLOPT_TIMEOUT, self::REQUEST_TIMEOUT_SECONDS);
        curl_setopt($handle, CURLOPT_CONNECTTIMEOUT, self::CONNECT_TIMEOUT_SECONDS);
        curl_setopt($handle, CURLOPT_POST, true);
        curl_setopt($handle, CURLOPT_POSTFIELDS, http_build_query($body));
        curl_setopt($handle, CURLOPT_HTTPHEADER, ['Content-Type: application/x-www-form-urlencoded']);

        $raw = curl_exec($handle);
        $errorNo = curl_errno($handle);
        $errorMessage = curl_error($handle);
        $httpStatus = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        if ($raw === false || $errorNo !== 0) {
            throw new SemaphoreException("Could not reach Semaphore: {$errorMessage}");
        }
        if ($httpStatus >= 400) {
            throw new SemaphoreException("Semaphore rejected the request with HTTP {$httpStatus}: " . substr((string) $raw, 0, 300));
        }

        $decoded = json_decode((string) $raw, true);
        // Semaphore returns a JSON ARRAY (one entry per recipient) even for
        // a single-number send.
        $first = is_array($decoded) ? ($decoded[0] ?? $decoded) : null;
        $messageId = is_array($first) ? ($first['message_id'] ?? null) : null;
        if ($messageId === null) {
            throw new SemaphoreException('Semaphore accepted the request but returned no message_id.');
        }

        return ['gateway_message_id' => (string) $messageId];
    }
}
