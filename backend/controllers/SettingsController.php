<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET/PATCH /system-settings — W21 System Settings, built as a
 * deliberate, user-authorized exception to REFERENCE.md §7's own
 * "blocked — no schema/endpoints; needs an architecture review first"
 * note (see migration 0012_system_settings.sql's own header for the
 * full reasoning and the exact scope of that override — SMS Gateway
 * credentials only, nothing else moves out of `.env`).
 *
 * Deliberately SMALL relative to the mockup that prompted it. Every key
 * here is either (a) pure organizational metadata with no behavioral
 * claim, or (b) genuinely wired into real enforcement elsewhere in this
 * codebase (`sms_gateway.*` -> `SmsGatewayService::resolveSemaphore()`).
 * Several mockup-proposed sections — Notifications toggles, GIS
 * staleness/map-default overrides, Backup & Data, most of "Security"
 * (password/lockout policy) — are deliberately NOT built here: most of
 * those proposed controls have no enforcement point anywhere in this
 * codebase to actually wire into (or, for password policy specifically,
 * wiring it would risk drifting `bootstrap-admin.js`'s Node copy out of
 * sync with PHP's, which `PasswordPolicy.php`'s own docblock already
 * flags as a real risk it was written to avoid). Adding a toggle that
 * doesn't gate anything is precisely the "control that looks functional
 * and does nothing" §2 Rule 6 forbids — see `backend/DEVLOG.md`'s "Full
 * UI/UX overhaul, Phase 6" entry for the itemized reasoning.
 *
 * Admin-only. Settings are GLOBAL, not per-barangay — this workstation
 * serves 4 barangays' worth of accounts off one shared SMS gateway
 * account, so there is exactly one settings row per key, not one per
 * tenant.
 */
final class SettingsController
{
    /** @var array<string, array{default:string, max:int, secret:bool}> */
    private const KEYS = [
        'general.system_name' => ['default' => 'BARANGUARD', 'max' => 100, 'secret' => false],
        'general.municipality' => ['default' => 'Pilar, Sorsogon', 'max' => 100, 'secret' => false],
        'general.region' => ['default' => 'Region V (Bicol)', 'max' => 100, 'secret' => false],
        'sms_gateway.sender_name' => ['default' => '', 'max' => 32, 'secret' => false],
        'sms_gateway.api_key' => ['default' => '', 'max' => 255, 'secret' => true],
    ];

    /** Placeholder echoed back for a secret whose real value is already set — never a real key. */
    private const SECRET_MASK = '••••••••';

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

                // Rule 17 allow-list: identifiers/statuses only — the
                // setting KEYS changed are recorded, never their values
                // (a changed API key must never appear in an audit row).
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
     * Real, UNMASKED single-key lookup for internal (non-HTTP) callers —
     * e.g. `SmsGatewayService::resolveSemaphore()`. Never exposed over
     * HTTP itself; `index()` above is the only HTTP-facing read of this
     * table, and it always masks secrets. Returns the key's default when
     * no row has been saved yet (an Admin who never opened Settings gets
     * the same behavior as before this table existed).
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
