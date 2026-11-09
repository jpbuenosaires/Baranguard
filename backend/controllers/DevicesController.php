<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\DeviceSignature;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Sms\DeviceSecretVault;
use PDO;

/**
 * Device lifecycle (`mobile_device`); device changes are auditable. The
 * mobile app registers its device immediately after authenticating.
 *
 *   - `POST /devices/register` — tanod (and admin, for the Chief Tanod's
 *     phone); body `{device_id,fcm_token?,platform:"android",app_version?}` →
 *     `{device_id,registered:true}`. Device ownership is validated. Previous
 *     active device registrations for that user are deactivated
 *     transactionally. Returns no FCM token.
 *   - `PATCH /devices/:id/deactivate` — own device only → `{success:true}`.
 *     Deactivates only the target device after the ownership check.
 *
 *   - Re-registering the SAME device_id by its OWN owner is an update, not an
 *     error: this is the ordinary FCM-token-refresh path (tokens rotate). It
 *     refreshes fcm_token/app_version/last_seen_at and re-activates the row.
 *   - A device_id already owned by a DIFFERENT user is rejected 409, never
 *     silently reassigned: moving a device row between users would break the
 *     guarantee that inbound SMS sender identity is derived server-side from
 *     the device→user mapping.
 *   - `deactivate` is idempotent (already-inactive still returns
 *     `{success:true}`).
 *   - Unknown device, or a device owned by someone else, both return 404
 *     rather than 403: a distinct 403 would confirm that a guessed device_id
 *     exists and belongs to another user.
 *   - `fcm_token` is never echoed back in any response, and never written to
 *     audit metadata.
 *   - `device_public_key_pem` (optional) is a hardware-backed device
 *     identity. If the body includes it, it is validated
 *     (`DeviceSignature::isValidPublicKeyPem()`) and stored;
 *     `Baranguard\Lib\DeviceSignature` then verifies a per-request signature
 *     on evidence upload / GPS / SOS / Tanod dispatch-status-update for any
 *     device that has one on file. Omitting it is not an error (see
 *     `DeviceSignature`'s own doc).
 *   - `fcm_token` is OPTIONAL: with no real Firebase project the mobile side
 *     resolves a null token, and requiring it would stop a device from ever
 *     registering (and every `POST /sync/batch` would then fail with "Device
 *     is not registered"). Push being unconfigured must be neutral. A
 *     missing/empty token is stored as `''` (the same convention as
 *     `RetentionService::scrubDeactivatedDevices()`, so the column stays
 *     `NOT NULL`); `NotificationDispatcher` treats an empty `fcm_token` as
 *     "no active registration" and falls through to SMS. A later
 *     re-registration never overwrites a REAL stored token with an empty one
 *     (see the `ON DUPLICATE KEY UPDATE` clause below).
 *
 * SMS envelope key provisioning: the encrypted SMS envelope the internal SMS
 * handlers require is symmetric crypto, so the device and server must share
 * a raw key, and this is the only endpoint where it can be handed over.
 * `register()` generates a 32-byte per-device secret ON THE DEVICE_ID'S
 * FIRST-EVER REGISTRATION ONLY, stores it encrypted at rest
 * (`DeviceSecretVault`, under `DEVICE_SECRET_MASTER_KEY`), and returns the
 * RAW key ONCE in that same response as `message_encryption_key` (base64). A
 * later re-registration of the SAME device_id never regenerates or
 * re-returns it. If `DEVICE_SECRET_MASTER_KEY` is unset this is skipped
 * entirely (device_secret_ref stays NULL, `message_encryption_key` is
 * omitted); every `/internal/sms/*` inbound handler treats a NULL
 * `device_secret_ref` as "reject this envelope", so nothing downstream
 * trusts an unprovisioned device.
 */
final class DevicesController
{
    /** `mobile_device.device_id` is VARCHAR(64); this also bounds the route pattern. */
    private const DEVICE_ID_PATTERN = '/^[A-Za-z0-9._:-]{8,64}$/';

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function register(PDO $pdo, array $identity): void
    {
        // Admin may register a device too (the Chief Tanod's phone) so
        // NotificationService::addTarget()'s "active device of this user"
        // lookup (role-blind) finds a push destination for SOS/dispatch
        // alerts. Same ownership, key and single-active-device rules as a
        // Tanod.
        AuthMiddleware::requireRole($identity, ['tanod', 'admin']);

        $body = Http::jsonBody();
        $deviceId = $body['device_id'] ?? null;
        $fcmToken = $body['fcm_token'] ?? null;
        $platform = $body['platform'] ?? null;
        $appVersion = $body['app_version'] ?? null;
        $devicePublicKeyPem = $body['device_public_key_pem'] ?? null;

        if (!is_string($deviceId) || !preg_match(self::DEVICE_ID_PATTERN, $deviceId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'device_id must be 8-64 characters of A-Z a-z 0-9 . _ : or -.');
        }
        // Optional (see class doc): null/missing/empty all mean "no push
        // registration on this device", stored as ''. Anything else must
        // still be a real string, not some other JSON type.
        if ($fcmToken !== null && !is_string($fcmToken)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'fcm_token must be a string.');
        }
        $fcmToken = is_string($fcmToken) ? trim($fcmToken) : '';
        // `mobile_device.platform` is ENUM('android'), the only value the
        // schema accepts, so anything else is a validation error here rather
        // than a database error later.
        if ($platform !== 'android') {
            throw new ApiError(400, 'VALIDATION_ERROR', "platform must be 'android'.");
        }
        if ($appVersion !== null && (!is_string($appVersion) || strlen($appVersion) > 64)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'app_version must be a string of at most 64 characters.');
        }
        if ($devicePublicKeyPem !== null) {
            if (!is_string($devicePublicKeyPem) || !DeviceSignature::isValidPublicKeyPem($devicePublicKeyPem)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'device_public_key_pem must be a valid PEM-encoded EC or RSA public key.');
            }
        }

        $ownershipStmt = $pdo->prepare('SELECT user_id, device_secret_ref FROM mobile_device WHERE device_id = :device_id LIMIT 1');
        $ownershipStmt->execute(['device_id' => $deviceId]);
        $existingRow = $ownershipStmt->fetch(PDO::FETCH_ASSOC);
        $existingOwner = $existingRow !== false ? $existingRow['user_id'] : false;
        if ($existingOwner !== false && (int) $existingOwner !== $identity['user_id']) {
            throw new ApiError(409, 'CONFLICT', 'This device cannot be registered to this account.');
        }

        // See the class doc's "SMS envelope key provisioning" note. Only
        // generated when this device_id has no secret yet, and only ever
        // returned in THIS response.
        $vault = new DeviceSecretVault();
        $needsSecretProvisioning = $vault->isConfigured()
            && ($existingRow === false || $existingRow['device_secret_ref'] === null);
        $rawMessageEncryptionKey = null;
        $wrappedSecret = null;
        if ($needsSecretProvisioning) {
            $rawMessageEncryptionKey = DeviceSecretVault::generateRawSecret();
            $wrappedSecret = $vault->wrap($rawMessageEncryptionKey);
        }

        $pdo->beginTransaction();
        try {
            // Previous active device registrations for that user are
            // deactivated transactionally. Scoped to this user's OTHER devices
            // so a token refresh on the current device doesn't deactivate the
            // row we are about to write. `deactivated_at` starts the 90-day
            // device-retention clock; without it a retired handset's
            // `device_secret_ref` would sit in the table indefinitely.
            $deactivateStmt = $pdo->prepare(
                'UPDATE mobile_device SET is_active = 0, deactivated_at = UTC_TIMESTAMP()
                 WHERE user_id = :user_id AND device_id <> :device_id AND is_active = 1'
            );
            $deactivateStmt->execute(['user_id' => $identity['user_id'], 'device_id' => $deviceId]);
            $deactivatedCount = $deactivateStmt->rowCount();

            $pdo->prepare(
                "INSERT INTO mobile_device
                    (device_id, user_id, platform, fcm_token, device_secret_ref, device_public_key_pem, app_version, last_seen_at, is_active, created_at)
                 VALUES
                    (:device_id, :user_id, 'android', :fcm_token, :device_secret_ref, :device_public_key_pem, :app_version, UTC_TIMESTAMP(), 1, UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE
                    -- An empty incoming token (push still unconfigured, or
                    -- this attempt just couldn't get one) must never erase
                    -- a REAL token this device registered earlier — same
                    -- 'never clobber a good value with an absent one' care
                    -- as device_secret_ref's COALESCE just below.
                    fcm_token = IF(VALUES(fcm_token) = '', fcm_token, VALUES(fcm_token)),
                    app_version = VALUES(app_version),
                    last_seen_at = UTC_TIMESTAMP(),
                    is_active = 1,
                    -- A device that comes back must not keep a stale
                    -- deactivation timestamp: it is active again, so its
                    -- §11 retention clock is not running.
                    deactivated_at = NULL,
                    device_secret_ref = COALESCE(device_secret_ref, VALUES(device_secret_ref)),
                    -- H-09: a NEW non-null key rotates it (app reinstall
                    -- generates a fresh Keystore key); omitting it on a
                    -- later call never silently strips protection already
                    -- in place, same COALESCE precedent as device_secret_ref.
                    device_public_key_pem = COALESCE(VALUES(device_public_key_pem), device_public_key_pem)"
            )->execute([
                'device_id' => $deviceId,
                'user_id' => $identity['user_id'],
                'fcm_token' => $fcmToken,
                'device_secret_ref' => $wrappedSecret,
                'device_public_key_pem' => $devicePublicKeyPem,
                'app_version' => $appVersion,
            ]);

            Audit::record(
                $pdo,
                $identity['barangay_id'],
                $identity['user_id'],
                'device_registered',
                'mobile_device',
                null, // audit_log.entity_id is BIGINT; device_id is a string, so it goes in metadata.
                [
                    'device_id' => $deviceId,
                    'platform' => 'android',
                    'app_version' => $appVersion,
                    'deactivated_previous_devices' => $deactivatedCount,
                    'message_encryption_key_provisioned' => $needsSecretProvisioning,
                    'device_key_provisioned' => $devicePublicKeyPem !== null,
                ]
            );

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $response = ['device_id' => $deviceId, 'registered' => true];
        if ($needsSecretProvisioning && $rawMessageEncryptionKey !== null) {
            // Never logged, never re-returned on any later call (see the
            // class doc). base64, not hex: it rides in a JSON response body
            // and is ~25% shorter for the same 32 raw bytes.
            $response['message_encryption_key'] = base64_encode($rawMessageEncryptionKey);
        }
        Http::send(200, $response);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function deactivate(PDO $pdo, array $identity, string $deviceId): void
    {
        AuthMiddleware::requireRole($identity, ['tanod', 'admin']); // own device only — see the ownership query below

        if (!preg_match(self::DEVICE_ID_PATTERN, $deviceId)) {
            throw new ApiError(404, 'NOT_FOUND', 'Device not found.');
        }

        // Ownership check and existence check collapse into one 404 — see
        // the class doc for why this deliberately doesn't distinguish them.
        $stmt = $pdo->prepare('SELECT is_active FROM mobile_device WHERE device_id = :device_id AND user_id = :user_id LIMIT 1');
        $stmt->execute(['device_id' => $deviceId, 'user_id' => $identity['user_id']]);
        $device = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($device === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Device not found.');
        }

        $wasActive = (int) $device['is_active'] === 1;
        if ($wasActive) {
            // See register()'s own note: `deactivated_at` starts the 90-day
            // retention clock for this device and its secret.
            $pdo->prepare('UPDATE mobile_device SET is_active = 0, deactivated_at = UTC_TIMESTAMP() WHERE device_id = :device_id')
                ->execute(['device_id' => $deviceId]);

            Audit::record(
                $pdo,
                $identity['barangay_id'],
                $identity['user_id'],
                'device_deactivated',
                'mobile_device',
                null,
                ['device_id' => $deviceId]
            );
        }

        Http::send(200, ['success' => true]);
    }
}
