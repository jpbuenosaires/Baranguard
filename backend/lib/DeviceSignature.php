<?php
declare(strict_types=1);

namespace Baranguard\Lib;

use PDO;

/**
 * Verifies a per-request device signature against a device's registered
 * hardware-backed public key — code-review finding H-09 (2026-09-24
 * external audit): "X-Device-Id is an identifier, not strong proof of
 * device authenticity."
 *
 * PHASED ROLLOUT, NOT A HARD CUTOVER. Every already-registered device has
 * `mobile_device.device_public_key_pem IS NULL` (migration 0024) until it
 * upgrades and re-registers with a Keystore-generated key — a hard
 * requirement on day one would 401 every existing Tanod session before a
 * single device has the new app build. `verify()` therefore returns
 * `null` ("not upgraded yet, caller keeps doing whatever it did before
 * H-09") rather than `false` when no key is on file — only a device that
 * HAS a key gets held to the new, stronger standard. This is the same
 * "unconfigured is neutral, don't fail closed on a control that was never
 * turned on" principle §2 Rule 6 already applies to Ollama/the SMS
 * gateway, not a security compromise: a device with no key still gets
 * exactly today's protection (the X-Device-Id + ownership DB lookup),
 * never less.
 *
 * Signature scheme: the device signs `METHOD\nPATH\nDEVICE_ID\nTIMESTAMP`
 * (SHA-256, whatever key algorithm the device generated — `openssl_verify`
 * doesn't care whether the stored PEM is EC or RSA) with its
 * non-exportable Android Keystore private key, and sends the result as
 * `X-Device-Signature` (base64) + `X-Device-Timestamp` (unix seconds).
 * PATH is the request's own path with no query string, so client and
 * server always compute the identical string. No request-body hash is
 * included — evidence upload's multipart body and GPS/SOS/dispatch's
 * already-idempotent `client_event_id` make a full body-canonicalization
 * scheme more complexity than the marginal protection is worth; binding
 * the signature to METHOD+PATH+DEVICE_ID+TIMESTAMP already prevents a
 * captured signature being replayed against a different device, route, or
 * time window.
 */
final class DeviceSignature
{
    /** Reject a timestamp more than this far from server time, either direction. */
    private const MAX_CLOCK_SKEW_SECONDS = 300;

    /**
     * @return bool|null true = verified; false = a key is on file but
     *   verification failed (caller MUST reject the request); null = this
     *   device has not upgraded yet (caller falls back to its pre-H-09
     *   check).
     */
    public static function verify(
        PDO $pdo,
        string $deviceId,
        int $userId,
        string $method,
        string $path,
        ?string $timestamp,
        ?string $signatureBase64
    ): ?bool {
        $stmt = $pdo->prepare(
            'SELECT device_public_key_pem FROM mobile_device
              WHERE device_id = :device_id AND user_id = :user_id AND is_active = 1 LIMIT 1'
        );
        $stmt->execute(['device_id' => $deviceId, 'user_id' => $userId]);
        $pem = $stmt->fetchColumn();
        if (!is_string($pem) || $pem === '') {
            return null;
        }

        if (!is_string($timestamp) || !ctype_digit($timestamp)) {
            return false;
        }
        if (abs(time() - (int) $timestamp) > self::MAX_CLOCK_SKEW_SECONDS) {
            return false;
        }
        if (!is_string($signatureBase64) || $signatureBase64 === '') {
            return false;
        }
        $signature = base64_decode($signatureBase64, true);
        if ($signature === false) {
            return false;
        }

        $publicKey = openssl_pkey_get_public($pem);
        if ($publicKey === false) {
            // A malformed stored key is an operator problem, not a client
            // one — but this endpoint must still fail closed rather than
            // silently skip verification.
            error_log('[baranguard] mobile_device.device_public_key_pem is not a valid PEM public key for device_id=' . $deviceId);
            return false;
        }

        $message = self::canonicalMessage($method, $path, $deviceId, $timestamp);
        $result = openssl_verify($message, $signature, $publicKey, OPENSSL_ALGO_SHA256);
        return $result === 1;
    }

    public static function canonicalMessage(string $method, string $path, string $deviceId, string $timestamp): string
    {
        return strtoupper($method) . "\n" . $path . "\n" . $deviceId . "\n" . $timestamp;
    }

    /**
     * Convenience wrapper for the common call-site shape: read the
     * signature headers off the current request, verify against this
     * device, and throw if (and only if) the device HAS a key on file and
     * the signature is missing/invalid. Silently returns for a device
     * that hasn't upgraded yet (`verify()` returned null) — see this
     * class's own doc for why that's a deliberate phased rollout, not a
     * gap.
     */
    public static function verifyOrReject(PDO $pdo, string $deviceId, int $userId): void
    {
        $result = self::verify(
            $pdo,
            $deviceId,
            $userId,
            $_SERVER['REQUEST_METHOD'] ?? '',
            parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?? '',
            Http::header('X-Device-Timestamp'),
            Http::header('X-Device-Signature')
        );
        if ($result === false) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Device signature verification failed.');
        }
    }

    /** Validates a caller-supplied public key is well-formed before it's ever stored. */
    public static function isValidPublicKeyPem(string $pem): bool
    {
        $key = @openssl_pkey_get_public($pem);
        if ($key === false) {
            return false;
        }
        $details = openssl_pkey_get_details($key);
        return $details !== false && in_array($details['type'] ?? null, [OPENSSL_KEYTYPE_EC, OPENSSL_KEYTYPE_RSA], true);
    }
}
