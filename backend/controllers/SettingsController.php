<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET/PATCH /system-settings. Admin-only. Settings are GLOBAL, not
 * per-barangay: one row per key, not one per tenant.
 *
 * Deliberately SMALL. Every key is either (a) pure organizational metadata
 * with no behavioral claim, or (b) genuinely wired into enforcement
 * elsewhere (the SOS fallback contact numbers). Notifications toggles, GIS
 * overrides, Backup & Data and password/lockout policy are deliberately NOT
 * here: they would have no enforcement point to wire into (and password
 * policy would risk drifting `bootstrap-admin.js`'s Node copy out of sync
 * with `PasswordPolicy.php`), so they would be controls that look
 * functional and do nothing. The SMS gateway has no cloud credential or
 * configurable sender name, so there is no key for those either. Secrets
 * (`DEVICE_SECRET_MASTER_KEY`, `INTERNAL_SERVICE_TOKEN`, `JWT_SECRET`, FCM
 * credentials) stay in `.env`.
 */
final class SettingsController
{
    /** @var array<string, array{default:string, max:int, secret:bool}> */
    private const KEYS = [
        'general.system_name' => ['default' => 'BARANGUARD', 'max' => 100, 'secret' => false],
        'general.municipality' => ['default' => 'Pilar, Sorsogon', 'max' => 100, 'secret' => false],
        'general.region' => ['default' => 'Region V (Bicol)', 'max' => 100, 'secret' => false],
        // The third SOS fallback tier's destination: a human backup contact
        // the mobile app SMSes DIRECTLY (own SIM, no gateway) when both the
        // direct app POST and the workstation are unreachable. Non-secret.
        // Never returned to any other role by the Admin-only GET above; see
        // TanodSosController::fallbackContact() for the one narrow,
        // tanod-readable path to this value.
        'sos_fallback.backup_contact_number' => ['default' => '', 'max' => 32, 'secret' => false],
        // The SIM number of the GSM gateway phone (sms-gateway/). The Tanod
        // app sends its encrypted `sos` envelope here when the workstation API
        // is unreachable but cellular SMS still works, so the gateway's
        // inbound ingestion (gsm-ingest-daemon.php -> /internal/sms/sos)
        // turns it into a real SOS record. Non-secret, same exposure rule as
        // the backup contact.
        'sos_fallback.gateway_number' => ['default' => '', 'max' => 32, 'secret' => false],
    ];

    /** Placeholder echoed back for a secret whose real value is already set — never a real key. */
    private const SECRET_MASK = '••••••••';

    /**
     * PH mobile-number shape for `sos_fallback.backup_contact_number`. A
     * malformed value makes `SmsManager` on the phone silently drop the SOS
     * fallback send while the app still reports `sent_by_sms`.
     * `SosSmsPlugin.java` enforces the same shape independently; keep the
     * two in sync by hand.
     */
    private const PH_MOBILE_NUMBER_PATTERN = '/^(\+63|0)9\d{9}$/';

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $rows = self::loadAll($pdo);
        $settings = [];
        foreach (self::KEYS as $key => $meta) {
            $value = $rows[$key] ?? $meta['default'];
            // Secrets are masked in the response — write-only from the
            // UI's perspective, same convention as a password input.
            // Never echo a real API key back over HTTP, even to the
            // Admin who is allowed to set it.
            $settings[$key] = ($meta['secret'] && $value !== '') ? self::SECRET_MASK : $value;
        }

        Http::send(200, ['settings' => $settings]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function update(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $body = Http::jsonBody();
        $incoming = $body['settings'] ?? null;
        if (!is_array($incoming) || $incoming === []) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'settings (object) is required.');
        }

        $writes = [];
        foreach ($incoming as $key => $value) {
            if (!is_string($key) || !array_key_exists($key, self::KEYS)) {
                throw new ApiError(400, 'VALIDATION_ERROR', "Unknown setting: {$key}.");
            }
            if (!is_string($value)) {
                throw new ApiError(400, 'VALIDATION_ERROR', "{$key} must be a string.");
            }
            $meta = self::KEYS[$key];
            $trimmed = trim($value);
            // The masked placeholder coming back means "leave it alone"
            // — the UI never has the real secret to resubmit, so treating
            // the mask as a literal new value would overwrite a real key
            // with eight bullet characters.
            if ($meta['secret'] && $trimmed === self::SECRET_MASK) {
                continue;
            }
            if (mb_strlen($trimmed) > $meta['max']) {
                throw new ApiError(400, 'VALIDATION_ERROR', "{$key} must be at most {$meta['max']} characters.");
            }
            if (in_array($key, ['sos_fallback.backup_contact_number', 'sos_fallback.gateway_number'], true) && $trimmed !== '' && !preg_match(self::PH_MOBILE_NUMBER_PATTERN, $trimmed)) {
                throw new ApiError(400, 'VALIDATION_ERROR', "{$key} must be a PH mobile number in 09XXXXXXXXX or +639XXXXXXXXX format.");
            }
            $writes[$key] = $trimmed;
        }

        if ($writes !== []) {
            $pdo->beginTransaction();
            try {
                $stmt = $pdo->prepare(
                    'INSERT INTO system_settings (setting_key, setting_value, updated_at, updated_by)
                     VALUES (:setting_key, :setting_value, UTC_TIMESTAMP(), :updated_by)
                     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)'
                );
                foreach ($writes as $key => $value) {
                    $stmt->execute(['setting_key' => $key, 'setting_value' => $value, 'updated_by' => $identity['user_id']]);
                }

                // Allow-listed: the setting KEYS changed are recorded, never
                // their values (a changed secret must never appear in an audit row).
                Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'system_settings_updated', 'system_settings', null, [
                    'keys' => implode(',', array_keys($writes)),
                ]);

                $pdo->commit();
            } catch (\Throwable $e) {
                $pdo->rollBack();
                throw $e;
            }
        }

        self::index($pdo, $identity);
    }

    /** @return array<string,string> */
    private static function loadAll(PDO $pdo): array
    {
        $stmt = $pdo->query('SELECT setting_key, setting_value FROM system_settings');
        /** @var array<string,string> $rows */
        $rows = $stmt->fetchAll(PDO::FETCH_KEY_PAIR);
        return $rows;
    }

    /**
     * Real, UNMASKED single-key lookup for internal (non-HTTP) callers, e.g.
     * `TanodSosController::fallbackContact()`. Never exposed over HTTP
     * itself; `index()` above is the only HTTP-facing read and it masks
     * secrets. Returns the key's default when no row has been saved yet.
     */
    public static function get(PDO $pdo, string $key): string
    {
        if (!array_key_exists($key, self::KEYS)) {
            return '';
        }
        $stmt = $pdo->prepare('SELECT setting_value FROM system_settings WHERE setting_key = :setting_key');
        $stmt->execute(['setting_key' => $key]);
        $value = $stmt->fetchColumn();
        return $value !== false ? (string) $value : self::KEYS[$key]['default'];
    }
}
