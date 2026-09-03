<?php
declare(strict_types=1);

namespace Baranguard\Services\Sms;

/**
 * EnvelopeCrypto — AES-256-GCM authenticated encryption for the §6 SMS
 * envelope: "version, message_id, device_id, client_event_id, created_at,
 * nonce, ciphertext, authentication tag, expiry, and message type."
 *
 * §2 Rule 1/4: "Plaintext raw narrative is never transported as ordinary
 * SMS" — everything business-sensitive (an incident's raw_narrative, a
 * GPS point, a duty-status change, an SOS location) travels only inside
 * `ciphertext`, encrypted under the SENDING DEVICE'S OWN symmetric key
 * (see `DeviceSecretVault` for how that key is provisioned/stored).
 *
 * The envelope's own CLEARTEXT header fields (version, message_id,
 * device_id, client_event_id, created_at, expiry, message_type) are bound
 * to the ciphertext as Additional Authenticated Data (AAD) — GCM's own
 * mechanism for "this ciphertext MUST have been produced together with
 * exactly this header, or the tag will not verify." Without that binding,
 * an attacker who intercepts one envelope could splice its ciphertext
 * under a DIFFERENT header (e.g. swap `message_type` from `duty_status`
 * to `sos`, or swap `device_id` to impersonate a different Tanod) while
 * leaving the ciphertext itself untouched — GCM's tag alone doesn't catch
 * that unless the header is part of what got authenticated. This is also
 * what makes device_id itself trustworthy for §2 Rule 13's "sender
 * identity is derived server-side from a registered Tanod/device
 * mapping": device_id has to travel in the clear (the server needs it to
 * know WHICH device's key to try before it can decrypt anything), but
 * because it's AAD, a forged/altered device_id in the header would fail
 * authentication against the real sender's ciphertext.
 */
final class EnvelopeCrypto
{
    private const NONCE_BYTES = 12;
    private const TAG_BYTES = 16;

    /**
     * @param array<string,mixed> $payload the business data — must be
     *        JSON-encodable.
     * @return array{nonce:string,ciphertext:string,tag:string} all base64.
     */
    public function encryptPayload(string $rawDeviceSecret, array $payload, string $aad): array
    {
        $plaintext = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($plaintext === false) {
            throw new EnvelopeException('Envelope payload is not JSON-encodable.');
        }

        $nonce = random_bytes(self::NONCE_BYTES);
        $tag = '';
        $ciphertext = openssl_encrypt(
            $plaintext,
            'aes-256-gcm',
            $rawDeviceSecret,
            OPENSSL_RAW_DATA,
            $nonce,
            $tag,
            $aad,
            self::TAG_BYTES
        );
        if ($ciphertext === false) {
            throw new EnvelopeException('Failed to encrypt envelope payload.');
        }

        return [
            'nonce' => base64_encode($nonce),
            'ciphertext' => base64_encode($ciphertext),
            'tag' => base64_encode($tag),
        ];
    }

    /**
     * @return array<string,mixed> the decoded payload.
     * @throws EnvelopeException on ANY failure — malformed base64, wrong
     *         key, tampered ciphertext/AAD, or non-JSON plaintext. Callers
     *         must not try to distinguish these (see SmsGatewayService's
     *         class doc on why every rejection returns the same generic
     *         outcome).
     */
    public function decryptPayload(string $rawDeviceSecret, string $nonceB64, string $ciphertextB64, string $tagB64, string $aad): array
    {
        $nonce = base64_decode($nonceB64, true);
        $ciphertext = base64_decode($ciphertextB64, true);
        $tag = base64_decode($tagB64, true);
        if ($nonce === false || $ciphertext === false || $tag === false) {
            throw new EnvelopeException('Envelope nonce/ciphertext/tag is not valid base64.');
        }
        if (strlen($nonce) !== self::NONCE_BYTES || strlen($tag) !== self::TAG_BYTES) {
            throw new EnvelopeException('Envelope nonce/tag has an unexpected length.');
        }

        $plaintext = openssl_decrypt($ciphertext, 'aes-256-gcm', $rawDeviceSecret, OPENSSL_RAW_DATA, $nonce, $tag, $aad);
        if ($plaintext === false) {
            throw new EnvelopeException('Envelope failed authentication (wrong key, tampered ciphertext, or mismatched header).');
        }

        $decoded = json_decode($plaintext, true);
        if (!is_array($decoded)) {
            throw new EnvelopeException('Envelope payload did not decode to a JSON object.');
        }
        return $decoded;
    }

    /**
     * Canonical AAD string — a fixed pipe-joined field order, not JSON, so
     * there is no key-ordering ambiguity to worry about between the
     * encrypting device and this server.
     */
    public static function buildAad(string $version, string $messageId, string $deviceId, string $clientEventId, string $createdAt, string $expiresAt, string $messageType): string
    {
        return implode('|', [$version, $messageId, $deviceId, $clientEventId, $createdAt, $expiresAt, $messageType]);
    }
}
