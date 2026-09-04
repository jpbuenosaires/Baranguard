<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Ai\OllamaClient;
use Baranguard\Services\Ai\OllamaException;
use Baranguard\Services\Ai\OllamaUnavailableException;
use PDO;

/**
 * GET /system/health — Master Reference §6 "System health" section, §9 W20
 * Service Health / Recovery. Implemented this session (2026-09-02
 * architecture review) — W20's screen isn't built yet, but the topbar's
 * status badge needed a real endpoint instead of the hardcoded
 * "All Systems Operational" §8 already forbids.
 *
 * Every dependency this deployment hasn't wired up yet (OSRM/GSM
 * ingestion/notification transports — all later sprints) honestly reports
 * `not_configured`, not `healthy` — a truthful "not built yet" is not a
 * demo/prototype tell, a fabricated green badge is. `not_configured` is
 * detected from the actual absence of that dependency's env var, not a
 * hardcoded false.
 *
 * `ollama` was UPGRADED from that env-var-presence check to a real live
 * probe in Sprint 5, and it is now the only dependency here that actually
 * talks to its service. §6's three states map onto it as:
 *   - `not_configured` — OLLAMA_URL/OLLAMA_MODEL unset; this deployment
 *     has no AI wired up at all.
 *   - `unhealthy` — configured but the check failed. That covers BOTH
 *     "the service didn't answer" AND "the service answered but the
 *     configured model isn't pulled" — the latter is genuinely unhealthy
 *     rather than healthy, because every AI job on that workstation will
 *     fail until someone runs `ollama pull`. Reporting green there would
 *     be precisely the fabricated badge §8 forbids.
 *   - `healthy` — service answered and the configured model is present.
 *
 * The probe uses OllamaClient's short ping timeout, not its generation
 * timeout: this runs inside an Admin's web request, so a stalled model
 * server must not hang the health page for minutes.
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

        $fcmStatus = self::envConfiguredStatus('FCM_SERVICE_ACCOUNT_PATH');
        $smsStatus = self::envConfiguredStatus('SEMAPHORE_API_KEY');

        Http::send(200, [
            'api' => 'healthy', // this code is executing, so the API itself responded.
            'db' => $db,
            'osrm' => self::envConfiguredStatus('OSRM_URL'),
            'ollama' => self::ollamaStatus(),
            // §2 Rule 22's "internal ingestion service" isn't a process
            // this endpoint can reach out and ping — INTERNAL_SERVICE_TOKEN
            // being set is the honest signal actually available here: it's
            // what the /internal/sms/* router itself requires before it
            // will accept anything (see public/internal.php).
            'gsm_ingestion' => self::envConfiguredStatus('INTERNAL_SERVICE_TOKEN'),
            // Fine-grained per-transport status (Sprint 4). `fcm` and
            // `sms_semaphore` are each independently truthful about
            // configuration presence — NEITHER is a live reachability
            // probe the way `ollama` is: there is no cheap, side-effect-free
            // way to "ping" FCM/Semaphore without actually sending
            // something, so both stay at the coarser not_configured/healthy
            // distinction that `ollama` itself used before Sprint 5's
            // upgrade to a real probe. Same honest-not-fabricated principle,
            // just without a free probe to make it more precise.
            'fcm' => $fcmStatus,
            'sms_semaphore' => $smsStatus,
            // Kept for the existing web topbar tooltip (AppShell.js) —
            // additive, not a breaking rename.
            'notification_config' => ($fcmStatus === 'healthy' || $smsStatus === 'healthy') ? 'healthy' : 'not_configured',
            'backup_last_success' => self::latestBackupTimestamp(),
            // Sprint 7's backup/restore-drill box closed the gap this
            // field used to document: `scripts/restore-drill.sh` now
            // records a completed, VERIFIED drill (it compares per-table
            // row counts and FK counts against the live database, and
            // deliberately does NOT write the marker when the comparison
            // fails). Still null until one has actually run — an honest
            // "never", never a fabricated recent timestamp.
            'restore_test_at' => self::lastRestoreDrillTimestamp(),
        ]);
    }

    /**
     * A real probe of the local model server — see the class doc for how
     * the three states are assigned. Never leaks the URL, the model name,
     * or any error detail into the response (§6: this endpoint "never
     * exposes credentials, tokens, internal filesystem paths, or raw
     * data"); the coarse status is the whole contract.
     */
    private static function ollamaStatus(): string
    {
        $client = new OllamaClient();
        if (!$client->isConfigured()) {
            return 'not_configured';
        }
        try {
            $models = $client->listModels();
        } catch (OllamaUnavailableException | OllamaException) {
            return 'unhealthy';
        }
        // Reachable, but a missing model means every queued job will fail.
        return $client->isModelAvailable($models) ? 'healthy' : 'unhealthy';
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

    /**
     * Reads the completion time of the last SUCCESSFUL restore drill from
     * the marker `scripts/restore-drill.sh` writes. The timestamp comes
     * from the file's own recorded `drill_completed_at` line rather than
     * its mtime, so copying or touching the file cannot silently make a
     * stale drill look recent.
     *
     * Returns null when no drill has ever passed — which is a real,
     * actionable answer (W20 renders it as "Never" and says so), not a
     * missing value to paper over.
     */
    private static function lastRestoreDrillTimestamp(): ?string
    {
        $marker = dirname(__DIR__) . '/backups/.last-restore-drill';
        if (!is_file($marker)) {
            return null;
        }
        $contents = file_get_contents($marker);
        if ($contents === false) {
            return null;
        }
        if (preg_match('/^drill_completed_at=(\S+)$/m', $contents, $matches) !== 1) {
            return null;
        }
        return $matches[1];
    }
}
