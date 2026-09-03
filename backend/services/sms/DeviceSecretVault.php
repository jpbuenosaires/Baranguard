<?php
declare(strict_types=1);

namespace Baranguard\Services\Sms;

/**
 * DeviceSecretVault — encrypts/decrypts `mobile_device.device_secret_ref`
 * at rest (§5's own column doc: "protected at rest"; §2 Rule 26: "message-
 * encryption keys ... are never exposed through ordinary API payloads,
 * audit logs, debug logs, or UI").
 *
 * WHAT THIS SECRET IS: a per-device 32-byte symmetric key, generated once
 * at that device's FIRST registration (`DevicesController::register()`),
 * used by `EnvelopeCrypto` to authenticate-and-encrypt/decrypt the SMS
 * envelope §6 documents for `/sms/*`. Both the server and the device must
 * hold the same raw key — this is symmetric crypto, not a hash — so the
 * server cannot simply hash-and-forget it the way it does a password. The
 * `DEVICE_SECRET_MASTER_KEY` env var wraps it before it ever touches the
 * database: an attacker with read access to the `mobile_device` table
 * alone gets nothing usable without also having the server's own master
 * key from .env.
 *
 * The raw key is handed to the DEVICE exactly once, in the
 * `POST /devices/register` response, on the device_id's first-ever
 * registration only — see that controller's own doc for why re-
 * registration (an FCM-token refresh on the same device_id) never
 * re-issues or rotates it.
 */
final class DeviceSecretVault
{
    private const KEY_BYTES = 32; // AES-256
    private const NONCE_BYTES = 12; // AES-GCM standard nonce length
    private const TAG_BYTES = 16;

    public static function generateRawSecret(): string
    {
        return random_bytes(self::KEY_BYTES);
    }

    public function isConfigured(): bool
    {
        return $this->masterKey() !== null;
    }

    /** @throws \RuntimeException if DEVICE_SECRET_MASTER_KEY is unset. */
    public function wrap(string $rawDeviceSecret): string
    {
        $masterKey = $this->requireMasterKey();
        $nonce = random_bytes(self::NONCE_BYTES);
        $tag = '';
        $ciphertext = openssl_encrypt(
            $rawDeviceSecret,
            'aes-256-gcm',
            $masterKey,
            OPENSSL_RAW_DATA,
            $nonce,
            $tag,
            '',
            self::TAG_BYTES
        );
        if ($ciphertext === false) {
            throw new \RuntimeException('Failed to encrypt device secret for storage.');
        }
        // nonce(12) || tag(16) || ciphertext(32) — fixed-length prefix, so
        // unwrap() never has to guess where one segment ends and the next
        // begins. base64 keeps this comfortably inside device_secret_ref's
        // VARCHAR(255).
        return base64_encode($nonce . $tag . $ciphertext);
    }

    /** @throws \RuntimeException if DEVICE_SECRET_MASTER_KEY is unset or the value is corrupt/tampered. */
    public function unwrap(string $wrapped): string
    {
        $masterKey = $this->requireMasterKey();
        $raw = base64_decode($wrapped, true);
        if ($raw === false || strlen($raw) <= self::NONCE_BYTES + self::TAG_BYTES) {
            throw new \RuntimeException('Stored device secret is malformed.');
        }
        $nonce = substr($raw, 0, self::NONCE_BYTES);
        $tag = substr($raw, self::NONCE_BYTES, self::TAG_BYTES);
        $ciphertext = substr($raw, self::NONCE_BYTES + self::TAG_BYTES);

        $plaintext = openssl_decrypt($ciphertext, 'aes-256-gcm', $masterKey, OPENSSL_RAW_DATA, $nonce, $tag);
        if ($plaintext === false) {
            throw new \RuntimeException('Device secret failed authentication — wrong master key or corrupted value.');
        }
        return $plaintext;
    }

    private function masterKey(): ?string
    {
        $hex = baranguard_env('DEVICE_SECRET_MASTER_KEY');
        if ($hex === false || trim($hex) === '') {
            return null;
        }
        $bytes = @hex2bin(trim($hex));
        return (is_string($bytes) && strlen($bytes) === self::KEY_BYTES) ? $bytes : null;
    }

    private function requireMasterKey(): string
    {
        $key = $this->masterKey();
        if ($key === null) {
            throw new \RuntimeException('DEVICE_SECRET_MASTER_KEY is not configured (or is not a 32-byte hex string).');
        }
        return $key;
    }
}
