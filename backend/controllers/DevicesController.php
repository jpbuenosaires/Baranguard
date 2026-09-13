<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Sms\DeviceSecretVault;
use PDO;

/**
 * Device lifecycle — Master Reference §6 "Users & device lifecycle",
 * §5 `mobile_device`, §2 Rule 17 (device changes are auditable).
 *
 * Built for Sprint 2's M1 Login box, which cannot work without it: the
 * mobile app registers its device immediately after authenticating.
 *
 * §6 fixes both endpoints exactly:
 *   - `POST /devices/register` — tanod only; body
 *     `{device_id,fcm_token,platform:"android",app_version?}` →
 *     `{device_id,registered:true}`. "Device ownership is validated.
 *     Previous active device registrations for that Tanod are deactivated
 *     transactionally. Returns no FCM token."
 *   - `PATCH /devices/:id/deactivate` — tanod own device only →
 *     `{success:true}`. "Deactivates only the target device after
 *     ownership check."
 *
 * Resolved decisions (logged in DEVLOG.md — §6 states the contract but
 * not these specifics):
 *   - **Re-registering the SAME device_id by its OWN owner is an update,
 *     not an error.** This is the ordinary FCM-token-refresh path (tokens
 *     rotate); treating it as a conflict would strand a Tanod whose token
 *     rotated. It refreshes fcm_token/app_version/last_seen_at and
 *     re-activates the row.
 *   - **A device_id already owned by a DIFFERENT user is rejected 409**,
 *     never silently reassigned — that is exactly the "device ownership is
 *     validated" clause, and silently moving a device row between Tanods
 *     would break the §2 Rule 13 guarantee that inbound SMS sender
 *     identity is derived server-side from the device→user mapping.
 *   - **`deactivate` is idempotent** (already-inactive still returns
 *     `{success:true}`), same reasoning as logout's documented
 *     "the server ignores a second logout safely".
 *   - **Unknown device, or a device owned by someone else, both return
 *     404** rather than 403 — a distinct 403 would confirm that a
 *     guessed device_id exists and belongs to another Tanod.
 *   - **`fcm_token` is never echoed back** in any response, and never
 *     written to audit metadata (§6 "Returns no FCM token"; Rule 17
 *     allows identifiers/statuses only).
 *   - **`fcm_token` is OPTIONAL, not required — explicit decision,
 *     2026-09-13.** §6's literal body shape names it, but this deployment
 *     has no real Firebase project (REMAINING.md A4) and never has, so
 *     `getFcmToken()` on the mobile side always resolves `null`. Requiring
 *     it here meant a Tanod's device NEVER actually registered, on any
 *     build, ever — `mobile_device` had no row for it at all, which only
 *     surfaced as `POST /sync/batch`'s "Device is not registered" 422 once
 *     something (the Mobile Improvement Plan's sync scheduler) finally
 *     called that endpoint automatically instead of only on a manual tap.
 *     Push being unconfigured must be as neutral as Ollama or the SMS
 *     gateway being unconfigured elsewhere in this codebase (§2 Rule 6) —
 *     it must never silently block a device from registering at all. A
 *     missing/empty token is stored as `''`, reusing the EXACT convention
 *     `RetentionService::scrubDeactivatedDevices()` already established
 *     for "no token" (that method's own doc explains why the column
 *     stays `NOT NULL` rather than being widened) — `NotificationDispatcher`
 *     already treats an empty `fcm_token` as "no active registration" and
 *     falls through to SMS (Rule 12), so this needed no new dispatcher
 *     logic, only reusing what already existed. A later re-registration
 *     never overwrites a REAL stored token with an empty one — see the
 *     `ON DUPLICATE KEY UPDATE` clause below.
 *
 * Sprint 4 addition — SMS envelope key provisioning (§6 "Internal SMS /
 * GSM", §2 Rule 26): §6 documents no separate key-provisioning endpoint,
 * and neither does its literal response shape for this one
 * (`{device_id,registered:true}`), but the encrypted SMS envelope those
 * internal handlers require is symmetric crypto — the device and server
 * must share a raw key, and there is no other endpoint in this codebase
 * where that key could be handed to the device. Resolved (logged, not
 * silently invented): `register()` generates a 32-byte per-device secret
 * ON THE DEVICE_ID'S FIRST-EVER REGISTRATION ONLY, stores it encrypted at
 * rest (`DeviceSecretVault`, under `DEVICE_SECRET_MASTER_KEY`), and
 * returns the RAW key ONCE in that same response as
 * `message_encryption_key` (base64). A later re-registration of the SAME
 * device_id (the ordinary FCM-token-refresh path above) never regenerates
 * or re-returns it — same "provisioned once, never re-exposed" precedent
 * as this endpoint already sets for `fcm_token`. If `DEVICE_SECRET_MASTER_KEY`
 * is unset, this is skipped entirely (device_secret_ref stays NULL,
 * `message_encryption_key` is omitted) — an honest "SMS envelope crypto
 * isn't configured on this deployment" state, not a broken one; every
 * `/internal/sms/*` inbound handler already treats a NULL
 * `device_secret_ref` as "reject this envelope", so nothing downstream
 * silently trusts an unprovisioned device.
 */
final class DevicesController
{
    /** §5 `mobile_device.device_id` is VARCHAR(64); this also bounds the route pattern. */
    private const DEVICE_ID_PATTERN = '/^[A-Za-z0-9._:-]{8,64}$/';

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function register(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $body = Http::jsonBody();
        $deviceId = $body['device_id'] ?? null;
        $fcmToken = $body['fcm_token'] ?? null;
        $platform = $body['platform'] ?? null;
        $appVersion = $body['app_version'] ?? null;

        if (!is_string($deviceId) || !preg_match(self::DEVICE_ID_PATTERN, $deviceId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'device_id must be 8-64 characters of A-Z a-z 0-9 . _ : or -.');
        }
        // Optional (see class doc, 2026-09-13) — null/missing/empty all mean
        // "no push registration on this device", stored as ''. Anything
        // else must still be a real string, not some other JSON type.
        if ($fcmToken !== null && !is_string($fcmToken)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'fcm_token must be a string.');
        }
        $fcmToken = is_string($fcmToken) ? trim($fcmToken) : '';
        // §5 `mobile_device.platform` is ENUM('android') — the only value
        // the schema accepts, so anything else is a validation error here
        // rather than a database error later.
        if ($platform !== 'android') {
            throw new ApiError(400, 'VALIDATION_ERROR', "platform must be 'android'.");
        }
        if ($appVersion !== null && (!is_string($appVersion) || strlen($appVersion) > 64)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'app_version must be a string of at most 64 characters.');
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
            // §6: "Previous active device registrations for that Tanod are
            // deactivated transactionally." Scoped to this user's OTHER
            // devices so a token refresh on the current device doesn't
            // deactivate the row we are about to write.
            // `deactivated_at` (migration 0007) starts §11's 90-day
            // device-retention clock. Without it the retention job has
            // nothing to count from and a retired handset's
            // `device_secret_ref` would sit in the table indefinitely.
            $deactivateStmt = $pdo->prepare(
                'UPDATE mobile_device SET is_active = 0, deactivated_at = UTC_TIMESTAMP()
                 WHERE user_id = :user_id AND device_id <> :device_id AND is_active = 1'
            );
            $deactivateStmt->execute(['user_id' => $identity['user_id'], 'device_id' => $deviceId]);
            $deactivatedCount = $deactivateStmt->rowCount();

            $pdo->prepare(
                "INSERT INTO mobile_device
                    (device_id, user_id, platform, fcm_token, device_secret_ref, app_version, last_seen_at, is_active, created_at)
                 VALUES
                    (:device_id, :user_id, 'android', :fcm_token, :device_secret_ref, :app_version, UTC_TIMESTAMP(), 1, UTC_TIMESTAMP())
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
                    device_secret_ref = COALESCE(device_secret_ref, VALUES(device_secret_ref))"
            )->execute([
                'device_id' => $deviceId,
                'user_id' => $identity['user_id'],
                'fcm_token' => $fcmToken,
                'device_secret_ref' => $wrappedSecret,
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
                ]
            );

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $response = ['device_id' => $deviceId, 'registered' => true];
        if ($needsSecretProvisioning && $rawMessageEncryptionKey !== null) {
            // Never logged, never re-returned on any later call — see the
            // class doc. base64, not hex: this rides in a JSON response
            // body next to other string fields, and base64 is ~25%
            // shorter for the same 32 raw bytes.
            $response['message_encryption_key'] = base64_encode($rawMessageEncryptionKey);
        }
        Http::send(200, $response);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function deactivate(PDO $pdo, array $identity, string $deviceId): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

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
            // See register()'s own note: `deactivated_at` starts §11's
            // 90-day retention clock for this device and its secret.
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
