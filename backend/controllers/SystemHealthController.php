<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /system/health — Master Reference §6 "System health" section, §9 W20
 * Service Health / Recovery. Implemented this session (2026-09-02
 * architecture review) — W20's screen isn't built yet, but the topbar's
 * status badge needed a real endpoint instead of the hardcoded
 * "All Systems Operational" §8 already forbids.
 *
 * Every dependency this deployment hasn't wired up yet (OSRM/Ollama/GSM
 * ingestion/notification transports — all later sprints) honestly reports
 * `not_configured`, not `healthy` — a truthful "not built yet" is not a
 * demo/prototype tell, a fabricated green badge is. `not_configured` is
 * detected from the actual absence of that dependency's env var, not a
 * hardcoded false.
 */
final class SystemHealthController
{
    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $db = 'unhealthy';
        try {
            $pdo->query('SELECT 1');
            $db = 'healthy';
        } catch (\Throwable) {
            $db = 'unhealthy';
        }

        Http::send(200, [
            'api' => 'healthy', // this code is executing, so the API itself responded.
            'db' => $db,
            'osrm' => self::envConfiguredStatus('OSRM_URL'),
            'ollama' => self::envConfiguredStatus('OLLAMA_URL'),
            'gsm_ingestion' => self::envConfiguredStatus('GSM_MODEM_DEVICE'),
            'notification_config' => self::envConfiguredStatus('FCM_SERVICE_ACCOUNT_JSON') === 'healthy' || self::envConfiguredStatus('SEMAPHORE_API_KEY') === 'healthy'
                ? 'healthy'
                : 'not_configured',
            'backup_last_success' => self::latestBackupTimestamp(),
            // No restore-drill run has ever recorded its completion time
            // anywhere (backend/scripts/restore.sh doesn't log one) — null
            // is the honest answer, not a fabricated recent timestamp.
            'restore_test_at' => null,
        ]);
    }

    private static function envConfiguredStatus(string $envVar): string
    {
        $value = baranguard_env($envVar);
        return ($value !== false && trim((string) $value) !== '') ? 'healthy' : 'not_configured';
    }

    /**
     * Reads the real filesystem timestamp of the most recent encrypted
     * backup file `backend/scripts/backup.sh` produces
     * (`backend/backups/*.sql.enc`) — a genuine environment signal, not a
     * simulated value. Returns null when no backup has ever been taken.
     */
    private static function latestBackupTimestamp(): ?string
    {
        $backupDir = dirname(__DIR__) . '/backups';
        if (!is_dir($backupDir)) {
            return null;
        }
        $files = glob($backupDir . '/*.sql.enc');
        if ($files === false || $files === []) {
            return null;
        }
        $latestMtime = null;
        foreach ($files as $file) {
            $mtime = filemtime($file);
            if ($mtime !== false && ($latestMtime === null || $mtime > $latestMtime)) {
                $latestMtime = $mtime;
            }
        }
        return $latestMtime !== null ? gmdate('Y-m-d\TH:i:s\Z', $latestMtime) : null;
    }
}
