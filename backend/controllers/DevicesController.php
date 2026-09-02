<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
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
        if (!is_string($fcmToken) || trim($fcmToken) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'fcm_token is required.');
        }
        // §5 `mobile_device.platform` is ENUM('android') — the only value
        // the schema accepts, so anything else is a validation error here
        // rather than a database error later.
        if ($platform !== 'android') {
            throw new ApiError(400, 'VALIDATION_ERROR', "platform must be 'android'.");
        }
        if ($appVersion !== null && (!is_string($appVersion) || strlen($appVersion) > 64)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'app_version must be a string of at most 64 characters.');
        }

        $ownershipStmt = $pdo->prepare('SELECT user_id FROM mobile_device WHERE device_id = :device_id LIMIT 1');
        $ownershipStmt->execute(['device_id' => $deviceId]);
        $existingOwner = $ownershipStmt->fetchColumn();
        if ($existingOwner !== false && (int) $existingOwner !== $identity['user_id']) {
            throw new ApiError(409, 'CONFLICT', 'This device cannot be registered to this account.');
        }

        $pdo->beginTransaction();
        try {
            // §6: "Previous active device registrations for that Tanod are
            // deactivated transactionally." Scoped to this user's OTHER
            // devices so a token refresh on the current device doesn't
            // deactivate the row we are about to write.
            $deactivateStmt = $pdo->prepare(
                'UPDATE mobile_device SET is_active = 0
                 WHERE user_id = :user_id AND device_id <> :device_id AND is_active = 1'
            );
            $deactivateStmt->execute(['user_id' => $identity['user_id'], 'device_id' => $deviceId]);
            $deactivatedCount = $deactivateStmt->rowCount();

            $pdo->prepare(
                "INSERT INTO mobile_device
                    (device_id, user_id, platform, fcm_token, app_version, last_seen_at, is_active, created_at)
                 VALUES
                    (:device_id, :user_id, 'android', :fcm_token, :app_version, UTC_TIMESTAMP(), 1, UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE
                    fcm_token = VALUES(fcm_token),
                    app_version = VALUES(app_version),
                    last_seen_at = UTC_TIMESTAMP(),
                    is_active = 1"
            )->execute([
                'device_id' => $deviceId,
                'user_id' => $identity['user_id'],
                'fcm_token' => $fcmToken,
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
                ]
            );

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, ['device_id' => $deviceId, 'registered' => true]);
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
            $pdo->prepare('UPDATE mobile_device SET is_active = 0 WHERE device_id = :device_id')
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
