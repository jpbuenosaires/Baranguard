<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Ai\OllamaClient;
use Baranguard\Services\Ai\OllamaException;
use Baranguard\Services\Ai\OllamaUnavailableException;
use Baranguard\Services\Routing\OrsClient;
use PDO;

/**
 * GET /system/health — Master Reference §6 "System health" section, §9 W20
 * Service Health / Recovery. Implemented this session (2026-09-02
 * architecture review) — W20's screen isn't built yet, but the topbar's
 * status badge needed a real endpoint instead of the hardcoded
 * "All Systems Operational" §8 already forbids.
 *
 * Every dependency this deployment hasn't wired up yet (GSM ingestion/
 * notification transports — all later sprints) honestly reports
 * `not_configured`, not `healthy` — a truthful "not built yet" is not a
 * demo/prototype tell, a fabricated green badge is. `not_configured` is
 * detected from the actual absence of that dependency's env var, not a
 * hardcoded false.
 *
 * `ollama` and `ors` are both UPGRADED from that env-var-
 * presence check to a real live probe (Ollama in Sprint 5; routing when
 * turn-by-turn was built — docs/REMAINING.md §C4). §6's three states map
 * onto both as:
 *   - `not_configured` — OLLAMA_URL/OLLAMA_MODEL (or ORS_API_KEY)
 *     unset; this deployment has no AI (or routing) wired up at all.
 *   - `unhealthy` — configured but the check failed. For Ollama that
 *     covers BOTH "the service didn't answer" AND "the service answered
 *     but the configured model isn't pulled" — the latter is genuinely
 *     unhealthy rather than healthy, because every AI job on that
 *     workstation will fail until someone runs `ollama pull`. Reporting
 *     green there would be precisely the fabricated badge §8 forbids.
 *   - `healthy` — service answered (and, for Ollama, the configured
 *     model is present).
 *
 * `ors` is a REAL DEPARTURE from every other dependency here: it is the
 * one cloud call in this stack (OpenRouteService, HeiGIT/Heidelberg
 * University — chosen over Google's Routes API specifically because
 * Google requires a billing account with a card on file even to stay in
 * the free tier, which this deployment doesn't have), not a self-hosted
 * process — see OrsClient's own doc block for why, and for what that
 * trade actually costs (live Tanod/incident coordinates leave the
 * system on every route request). `osrm_status` (migration 0017) is no
 * longer read from any env var — this deployment never wires up OSRM —
 * and is written as a fixed `not_configured` literal purely so the
 * already-applied migration's NOT NULL column stays satisfied; it is
 * deliberately NOT exposed in this endpoint's response any more (see
 * `ors` instead).
 *
 * The probes use each client's short ping timeout, not a
 * generation/route timeout: this runs inside an Admin's web request, so
 * a stalled service must not hang the health page for seconds longer
 * than necessary.
 */
final class SystemHealthController
{
    /** Most transitions `history()` will return. See that method for why
     *  it is a hard cap rather than pagination. */
    private const HISTORY_LIMIT = 100;

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
        // 2026-09-23: Semaphore removed, replaced by the local GSM
        // gateway (`LocalGsmOutboundClient`) — 'healthy' means the
        // deployment has explicitly opted in (GSM_GATEWAY_ENABLED=true),
        // not merely that SOME value is set, since 'false' is itself a
        // meaningful, valid value here (unlike an API key, where any
        // non-empty string was a real key). Same fcm/sms "presence, not a
        // live probe" pattern as before — see this class's own doc block.
        $smsStatus = baranguard_env('GSM_GATEWAY_ENABLED') === 'true' ? 'healthy' : 'not_configured';
        $orsStatus = self::orsStatus();
        $ollamaStatus = self::ollamaStatus();
        $gsmStatus = self::envConfiguredStatus('INTERNAL_SERVICE_TOKEN');

        // Migration 0017/0020: remember what this probe saw, but only
        // when it differs from the last thing recorded. See
        // recordHealthSample() and the migration headers for why this is
        // a change log rather than a sample-per-call time series.
        self::recordHealthSample($pdo, [
            'db_status' => $db,
            'ors_status' => $orsStatus,
            'ollama_status' => $ollamaStatus,
            'gsm_status' => $gsmStatus,
            'fcm_status' => $fcmStatus,
            'sms_status' => $smsStatus,
        ]);

        Http::send(200, [
            'api' => 'healthy', // this code is executing, so the API itself responded.
            'db' => $db,
            'ors' => $orsStatus,
            'ollama' => $ollamaStatus,
            // §2 Rule 22's "internal ingestion service" isn't a process
            // this endpoint can reach out and ping — INTERNAL_SERVICE_TOKEN
            // being set is the honest signal actually available here: it's
            // what the /internal/sms/* router itself requires before it
            // will accept anything (see public/internal.php).
            'gsm_ingestion' => $gsmStatus,
            // Fine-grained per-transport status (Sprint 4). `fcm` and
            // `sms_gsm_gateway` are each independently truthful about
            // configuration presence — NEITHER is a live reachability
            // probe the way `ollama` is: there is no cheap, side-effect-free
            // way to "ping" FCM/the gateway phone without actually sending
            // something, so both stay at the coarser not_configured/healthy
            // distinction that `ollama` itself used before Sprint 5's
            // upgrade to a real probe. Same honest-not-fabricated principle,
            // just without a free probe to make it more precise.
            // RENAMED 2026-09-23 (was `sms_semaphore`) when Semaphore was
            // replaced by the local GSM gateway — a real rename, not
            // additive, since calling this "semaphore" would now be false.
            // Every consumer (web/src/pages/service-health.js,
            // web/tests/harness/fixtures.mjs) was updated in the same pass.
            'fcm' => $fcmStatus,
            'sms_gsm_gateway' => $smsStatus,
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
            // H-20: a real count, never fabricated — 0 is the honest
            // answer when nothing has failed, not a hidden/omitted field.
            'notification_delivery_failures_24h' => self::notificationDeliveryFailures24h($pdo),
        ]);
    }

    /**
     * `GET /system/health/history` — Admin only. The transitions behind
     * the snapshot `index()` returns.
     *
     * NOT IN §6's ENDPOINT LIST, added deliberately (2026-09-12), same
     * justification `BlotterController::luponPacketDownload()` records
     * for itself: the stored data is useless without a way to read it,
     * and §2 Rule 15 explicitly names the risk this answers. Admin-only,
     * matching `index()` — this is operational infrastructure detail,
     * and §3 gives Punong Barangay oversight of INCIDENTS, not of the
     * workstation's plumbing.
     *
     * Returns transitions newest-first, capped. No pagination: this is a
     * change log an operator scans, not a dataset they page through, and
     * an unbounded one would be a footgun on a table that grows from
     * outages.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function history(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $stmt = $pdo->query(
            'SELECT recorded_at, db_status, ors_status, ollama_status,
                    gsm_status, fcm_status, sms_status
               FROM health_check_log
              ORDER BY recorded_at DESC, log_id DESC
              LIMIT ' . self::HISTORY_LIMIT
        );
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        Http::send(200, [
            'items' => array_map(static fn (array $r): array => [
                'recorded_at' => $r['recorded_at'],
                'db' => $r['db_status'],
                'ors' => $r['ors_status'],
                'ollama' => $r['ollama_status'],
                'gsm_ingestion' => $r['gsm_status'],
                'fcm' => $r['fcm_status'],
                'sms_gsm_gateway' => $r['sms_status'],
            ], $rows),
            // Said in the payload, not just in the UI, so any consumer of
            // this endpoint inherits the caveat rather than having to
            // know it: these are observations, not a continuous record.
            'sampling' => 'change_only_on_probe',
        ]);
    }

    /**
     * Writes one row only when the observed statuses differ from the
     * newest recorded row (or when there is no row at all).
     *
     * WHY A READ ENDPOINT WRITES: `/system/health` is not a plain read,
     * it is a probe — it actively pings the model server and the
     * database. Recording what the probe saw is the point of having run
     * it, and no other caller exists to do the recording (nothing on
     * this system is scheduled — `docs/REMAINING.md` C2).
     *
     * FAILS SILENTLY, DELIBERATELY. A health endpoint that 500s because
     * its own bookkeeping table is missing or unwritable would take down
     * the screen an operator opens precisely when things are broken —
     * turning a partial outage into a blind one. History is strictly
     * less important than the answer, so any failure here is swallowed
     * and the snapshot still returns.
     *
     * @param array<string,string> $statuses column => status
     */
    private static function recordHealthSample(PDO $pdo, array $statuses): void
    {
        try {
            $latest = $pdo->query(
                'SELECT db_status, ors_status, ollama_status, gsm_status, fcm_status, sms_status
                   FROM health_check_log ORDER BY log_id DESC LIMIT 1'
            )->fetch(PDO::FETCH_ASSOC);

            // Same states as last time — nothing changed, nothing to say.
            if ($latest !== false && $latest !== null) {
                $unchanged = true;
                foreach ($statuses as $column => $value) {
                    if ((string) ($latest[$column] ?? '') !== $value) {
                        $unchanged = false;
                        break;
                    }
                }
                if ($unchanged) {
                    return;
                }
            }

            // osrm_status (migration 0017) is a fixed literal, not a bound
            // param: this deployment never wires up OSRM any more (see
            // class doc), so there is nothing to check, and hardcoding it
            // here — rather than threading a dead value through $statuses
            // and its unchanged-comparison loop above — keeps that fact
            // visible at the one place it's still written.
            $stmt = $pdo->prepare(
                "INSERT INTO health_check_log
                    (recorded_at, db_status, osrm_status, ors_status, ollama_status, gsm_status, fcm_status, sms_status)
                 VALUES
                    (UTC_TIMESTAMP(), :db_status, 'not_configured', :ors_status, :ollama_status, :gsm_status, :fcm_status, :sms_status)"
            );
            $stmt->execute($statuses);
        } catch (\Throwable) {
            // See the doc block: never let bookkeeping break the probe.
        }
    }

    /**
     * A real probe of the local model server — see the class doc for how
     * the three states are assigned. Never leaks the URL, the model name,
     * or any error detail into the response (§6: this endpoint "never
     * exposes credentials, tokens, internal filesystem paths, or raw
     * data"); the coarse status is the whole contract.
     *
     * PUBLIC so `AiToolsController::availability()` can reuse it. This
     * endpoint is Admin-only but the AI Tools screen serves Secretary and
     * Punong Barangay too, and those roles need the same honest answer to
     * avoid offering a Generate button that cannot work (§2 Rule 6).
     * Sharing the probe keeps one implementation rather than a second copy
     * that can drift; the coarse status is safe for any authenticated role
     * precisely because it carries no detail.
     */
    public static function ollamaStatus(): string
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
     * A real probe of OpenRouteService — a genuine route request
     * (`OrsClient::ping()`), not a bare presence check, so an invalid
     * key or an exhausted rate limit shows as `unhealthy` rather than
     * `healthy`. Never leaks the key or any error detail (same contract
     * `ollamaStatus()` already documents).
     *
     * PUBLIC for the same reason `ollamaStatus()` is: Phase 3's
     * `DispatchController::route()` reuses it rather than re-probing.
     */
    public static function orsStatus(): string
    {
        $client = new OrsClient();
        if (!$client->isConfigured()) {
            return 'not_configured';
        }
        return $client->ping() ? 'healthy' : 'unhealthy';
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

    /**
     * Code-review finding H-20 (2026-09-24): notification delivery had no
     * operator-visible failure signal at all — Rule 12's FCM-retry-once-
     * then-SMS ladder is a real, bounded retry policy (not a gap), but
     * once BOTH tiers are exhausted, the only trace was a handful of
     * `notification_delivery` rows with `status='failed'` that nothing
     * ever surfaced. This counts notification TARGETS (not individual
     * delivery attempts — a target with a failed FCM try that then
     * succeeded via SMS is fine, not counted) from the last 24h that have
     * at least one failed delivery attempt and NO successful one on any
     * channel — a genuine "nobody was alerted" gap, the actual thing an
     * operator needs to know about.
     */
    private static function notificationDeliveryFailures24h(PDO $pdo): int
    {
        $stmt = $pdo->query(
            "SELECT COUNT(DISTINCT nt.notification_target_id)
               FROM notification_target nt
               JOIN notification n ON n.notification_id = nt.notification_id
              WHERE n.created_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)
                AND EXISTS (
                    SELECT 1 FROM notification_delivery nd
                     WHERE nd.notification_target_id = nt.notification_target_id AND nd.status = 'failed'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM notification_delivery nd2
                     WHERE nd2.notification_target_id = nt.notification_target_id AND nd2.status = 'sent'
                )"
        );
        return (int) $stmt->fetchColumn();
    }
}
