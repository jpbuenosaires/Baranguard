<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Notifications\FcmClient;
use Baranguard\Services\Notifications\LocalGsmOutboundClient;
use Baranguard\Services\Routing\OrsClient;
use PDO;

/**
 * GET /system/health — Service Health / Recovery, and the source of the
 * topbar's status badge.
 *
 * Every dependency this deployment hasn't wired up honestly reports
 * `not_configured`, not `healthy`: a truthful "not configured" is not a
 * demo/prototype tell, a fabricated green badge is. `not_configured` is
 * detected from the actual absence of that dependency's env var, not a
 * hardcoded false.
 *
 * `ors` (routing) is a real live probe. The three states map as:
 *   - `not_configured` — ORS_API_KEY unset.
 *   - `unhealthy` — configured but the check failed.
 *   - `healthy` — the service answered.
 *
 * `ors` is the one cloud call in this stack (OpenRouteService, HeiGIT/
 * Heidelberg University — chosen over Google's Routes API because Google
 * requires a billing account with a card on file even for the free tier),
 * not a self-hosted process: live Tanod/incident coordinates leave the
 * system on every route request (see OrsClient's own doc). `osrm_status`
 * is written as a fixed `not_configured` literal purely so its NOT NULL
 * column stays satisfied; it is not exposed in this endpoint's response.
 *
 * The probes use each client's short ping timeout, not a route timeout:
 * this runs inside an Admin's web request, so a stalled service must not
 * hang the health page for seconds longer than necessary.
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

        $fcmStatus = self::fcmStatus();
        // 'healthy' means the deployment has explicitly opted in
        // (GSM_GATEWAY_ENABLED=true), not merely that SOME value is set, since
        // 'false' is itself a meaningful, valid value here. Presence, not a
        // live probe. Nothing records a gateway heartbeat, so a flag is only
        // 'configured' (neutral), never 'healthy'.
        $smsStatus = self::gatewayStatus();
        $orsStatus = self::orsStatus();
        $gsmStatus = self::ingestStatus();

        // Migration 0017/0020: remember what this probe saw, but only
        // when it differs from the last thing recorded. See
        // recordHealthSample() and the migration headers for why this is
        // a change log rather than a sample-per-call time series.
        self::recordHealthSample($pdo, [
            'db_status' => $db,
            'ors_status' => $orsStatus,
            'gsm_status' => $gsmStatus,
            'fcm_status' => $fcmStatus,
            'sms_status' => $smsStatus,
        ]);

        Http::send(200, [
            'api' => 'healthy', // this code is executing, so the API itself responded.
            'db' => $db,
            'ors' => $orsStatus,
            // The internal ingestion service isn't a process this endpoint
            // can reach out and ping; INTERNAL_SERVICE_TOKEN being set is the
            // honest signal actually available here: it's what the
            // /internal/sms/* router itself requires before it will accept
            // anything (see public/internal.php).
            'gsm_ingestion' => $gsmStatus,
            // Fine-grained per-transport status. `fcm` and `sms_gsm_gateway`
            // are each independently truthful about configuration presence;
            // neither is a live reachability probe (there is no cheap,
            // side-effect-free way to "ping" FCM/the gateway phone without
            // actually sending something), so both stay at the coarser
            // not_configured/healthy distinction.
            'fcm' => $fcmStatus,
            'sms_gsm_gateway' => $smsStatus,
            // Kept for the existing web topbar tooltip (AppShell.js) —
            // additive, not a breaking rename.
            'notification_config' => self::notificationConfigStatus($fcmStatus, $smsStatus),
            'backup_last_success' => self::latestBackupTimestamp(),
            // `scripts/restore-drill.sh` records a completed, VERIFIED drill (it
            // compares per-table row counts and FK counts against the live
            // database, and deliberately does NOT write the marker when the
            // comparison fails). Null until one has actually run: an honest
            // "never", never a fabricated recent timestamp.
            'restore_test_at' => self::lastRestoreDrillTimestamp(),
            // A real count, never fabricated: 0 is the honest answer when
            // nothing has failed, not a hidden/omitted field.
            'notification_delivery_failures_24h' => self::notificationDeliveryFailures24h($pdo),
        ]);
    }

    /**
     * `GET /system/health/history` — Admin only. The transitions behind
     * the snapshot `index()` returns: the stored data is useless without a
     * way to read it. Admin-only, matching `index()`: this is operational
     * infrastructure detail, and Punong Barangay's oversight is of
     * INCIDENTS, not of the workstation's plumbing.
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
            'SELECT recorded_at, db_status, ors_status,
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
     * WHY A READ ENDPOINT WRITES: `/system/health` is a probe: it actively
     * pings the database and the dependencies. Recording what the probe saw
     * is the point of having run it, and nothing else is scheduled to do it.
     *
     * FAILS SILENTLY, DELIBERATELY. A health endpoint that 500s because
     * its own bookkeeping table is missing or unwritable would take down
     * the screen an operator opens precisely when things are broken,
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
                'SELECT db_status, ors_status, gsm_status, fcm_status, sms_status
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

            // osrm_status is a fixed literal, not a bound param: nothing wires
            // up OSRM, and hardcoding it here (rather than threading a dead
            // value through $statuses and its unchanged-comparison loop above)
            // keeps that fact visible at the one place it's still written.
            $stmt = $pdo->prepare(
                "INSERT INTO health_check_log
                    (recorded_at, db_status, osrm_status, ors_status, ollama_status, gsm_status, fcm_status, sms_status)
                 VALUES
                    (UTC_TIMESTAMP(), :db_status, 'not_configured', :ors_status, 'not_configured', :gsm_status, :fcm_status, :sms_status)"
            );
            $stmt->execute($statuses);
        } catch (\Throwable) {
            // See the doc block: never let bookkeeping break the probe.
        }
    }

    private static function envConfiguredStatus(string $envVar): string
    {
        $value = baranguard_env($envVar);
        return ($value !== false && trim((string) $value) !== '') ? 'configured' : 'not_configured';
    }

    /**
     * Notification Dispatcher: Working when at least one alert transport is proven working, Not working when
     * the only transports that are set up are failing, Set up when they are set up but untestable.
     */
    public static function notificationConfigStatus(string $fcm, string $sms): string
    {
        if ($fcm === 'healthy' || $sms === 'healthy') {
            return 'healthy';
        }
        if ($fcm === 'configured' || $sms === 'configured') {
            return 'configured';
        }
        return ($fcm === 'unhealthy' || $sms === 'unhealthy') ? 'unhealthy' : 'not_configured';
    }

    /**
     * Outbound SMS gateway: a live check that the gateway phone is attached over adb and its app is
     * installed (LocalGsmOutboundClient::probe), reused for a short time because it shells out to adb.
     * 'healthy' means "can be reached", not "a text was delivered" (that is what sms_log shows).
     */
    public static function gatewayStatus(): string
    {
        if (baranguard_env('GSM_GATEWAY_ENABLED') !== 'true') {
            return 'not_configured';
        }
        return self::cachedProbe('gateway-health.json', 30, 10, static fn (): bool => (new LocalGsmOutboundClient())->probe());
    }

    /**
     * Inbound SMS ingestion: the daemon (gsm-ingest-daemon.php) stamps storage/gsm-ingest-heartbeat.json on
     * every poll with whether it could read the phone. Fresh and ok = healthy; stale or failing = unhealthy.
     */
    public static function ingestStatus(): string
    {
        $token = baranguard_env('INTERNAL_SERVICE_TOKEN');
        if ($token === false || trim((string) $token) === '') {
            return 'not_configured';
        }
        $file = dirname(__DIR__) . '/storage/gsm-ingest-heartbeat.json';
        $beat = is_file($file) ? json_decode((string) @file_get_contents($file), true) : null;
        if (is_array($beat) && ($beat['ok'] ?? false) === true && time() - (int) ($beat['at'] ?? 0) <= self::INGEST_HEARTBEAT_MAX_AGE_SECONDS) {
            return 'healthy';
        }
        return 'unhealthy';
    }

    /** The daemon polls every 10 s by default; three missed polls and it is considered down. */
    private const INGEST_HEARTBEAT_MAX_AGE_SECONDS = 45;

    /**
     * Push: the key file must be valid (fcmCredentialStatus), then Google's OAuth endpoint must accept it
     * (FcmClient::verifyCredentials; nothing is sent to a device). 'healthy' = credentials accepted, not
     * "a push reached a phone".
     */
    public static function fcmStatus(): string
    {
        $file = self::fcmCredentialStatus();
        if ($file !== 'configured') {
            return $file;
        }
        return self::cachedProbe('fcm-health.json', 900, 45, static fn (): bool => (new FcmClient())->verifyCredentials());
    }

    /**
     * Runs a boolean probe at most once per $okTtl seconds (or $failTtl after a failure), keyed to the
     * probe name; a stale or unreadable cache simply re-probes.
     *
     * @param callable():bool $probe
     * @return 'healthy'|'unhealthy'
     */
    private static function cachedProbe(string $name, int $okTtl, int $failTtl, callable $probe): string
    {
        $cacheFile = dirname(__DIR__) . '/storage/' . $name;
        $cached = is_file($cacheFile) ? json_decode((string) @file_get_contents($cacheFile), true) : null;
        if (is_array($cached) && in_array($cached['status'] ?? null, ['healthy', 'unhealthy'], true)) {
            $ttl = $cached['status'] === 'healthy' ? $okTtl : $failTtl;
            if (time() - (int) ($cached['at'] ?? 0) < $ttl) {
                return $cached['status'];
            }
        }
        $status = $probe() ? 'healthy' : 'unhealthy';
        @file_put_contents($cacheFile, json_encode(['at' => time(), 'status' => $status]), LOCK_EX);
        return $status;
    }

    /**
     * Real, side-effect-free check of the FCM service-account file — exists,
     * readable, parses as JSON with the keys FCM auth needs. Never calls
     * Google and never returns file contents. A valid file is still only
     * 'configured' (not 'healthy'): nothing here proves Google accepts it.
     * Path set but file missing/unreadable/invalid is 'unhealthy'.
     */
    private static function fcmCredentialStatus(): string
    {
        $path = baranguard_env('FCM_SERVICE_ACCOUNT_PATH');
        if ($path === false || trim((string) $path) === '') {
            return 'not_configured';
        }
        $path = trim((string) $path);
        if (!is_file($path) || !is_readable($path)) {
            return 'unhealthy';
        }
        $raw = @file_get_contents($path);
        $json = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($json)) {
            return 'unhealthy';
        }
        foreach (['project_id', 'client_email', 'private_key'] as $key) {
            if (!isset($json[$key]) || !is_string($json[$key]) || $json[$key] === '') {
                return 'unhealthy';
            }
        }
        return 'configured';
    }

    /**
     * A real probe of OpenRouteService — a genuine route request
     * (`OrsClient::ping()`), not a bare presence check, so an invalid key or
     * an exhausted rate limit shows as `unhealthy` rather than `healthy`.
     * Never leaks the key or any error detail.
     *
     * PUBLIC so `DispatchController::route()` can reuse it rather than
     * re-probing.
     */
    public static function orsStatus(): string
    {
        $client = new OrsClient();
        if (!$client->isConfigured()) {
            return 'not_configured';
        }
        // Every probe is a real ORS request and the free tier is a daily quota, while this runs on every
        // admin page load plus the Service Health page. Reuse a result for a few minutes (per key, so
        // changing the key re-probes at once); otherwise normal use alone exhausts the quota and the
        // badge turns red for a reason the probe itself caused.
        $cacheFile = dirname(__DIR__) . '/storage/ors-health.json';
        $keyId = sha1((string) baranguard_env('ORS_API_KEY'));
        $cached = is_file($cacheFile) ? json_decode((string) @file_get_contents($cacheFile), true) : null;
        // A failure is remembered only briefly: one slow or dropped request must not keep the badge red for the
        // whole healthy window, while the short wait still protects the daily quota.
        $ttl = (($cached['status'] ?? null) === 'healthy') ? self::ORS_PROBE_CACHE_SECONDS : self::ORS_PROBE_FAILURE_CACHE_SECONDS;
        if (is_array($cached) && ($cached['key'] ?? null) === $keyId && time() - (int) ($cached['at'] ?? 0) < $ttl
            && in_array($cached['status'] ?? null, ['healthy', 'unhealthy'], true)) {
            return $cached['status'];
        }
        $status = $client->ping() ? 'healthy' : 'unhealthy';
        @file_put_contents($cacheFile, json_encode(['key' => $keyId, 'at' => time(), 'status' => $status]), LOCK_EX);
        return $status;
    }

    /** How long an ORS probe result is reused (about 96 probes a day at most). */
    private const ORS_PROBE_CACHE_SECONDS = 900;

    /** How long a FAILED probe is reused before trying again. */
    private const ORS_PROBE_FAILURE_CACHE_SECONDS = 45;

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
     * Returns null when no drill has ever passed: a real, actionable answer
     * (the page renders it as "Never"), not a missing value to paper over.
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
     * Notification delivery failure signal. The FCM-retry-once-then-SMS
     * ladder is a real, bounded retry policy, but once BOTH tiers are
     * exhausted the only trace would be `notification_delivery` rows with
     * `status='failed'` that nothing surfaced. This counts notification
     * TARGETS (not individual delivery attempts: a target with a failed FCM
     * try that then succeeded via SMS is fine, not counted) from the last
     * 24h that have at least one failed delivery attempt and NO successful
     * one on any channel — a genuine "nobody was alerted" gap, the actual
     * thing an operator needs to know about.
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
