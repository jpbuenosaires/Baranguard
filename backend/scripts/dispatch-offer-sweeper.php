<?php
declare(strict_types=1);

/**
 * dispatch-offer-sweeper.php — the timeout half of the night-time dispatch
 * offers (Wave 2, migration 0038). Every live offer (`open`/`escalated`)
 * whose `expires_at` has passed is processed by
 * `OfferService::sweep()`: current recipients become `expired`, the
 * barangay's Admin(s) get a `priority_alert`, and the offer is re-broadcast
 * to whoever qualifies now (rounds 2 and 3) or left `escalated`. An offer on
 * an incident that is no longer pending/dispatched is closed instead. All of
 * that logic lives in `OfferService` so the verify suite exercises the very
 * same code; this file is only the CLI wrapper, same shape as
 * gsm-ingest-daemon.php.
 *
 * CLI-ONLY: there is deliberately no HTTP endpoint that runs the sweep.
 *
 * Usage (from backend/):
 *   php scripts/dispatch-offer-sweeper.php --once       one sweep, then exit
 *   php scripts/dispatch-offer-sweeper.php --daemon      sweep every 60 s until stopped
 *   php scripts/dispatch-offer-sweeper.php --interval=30 seconds between sweeps in --daemon (default 60)
 *
 * Production runs it as the Windows Scheduled Task `BaranguardDispatchOfferSweeper`
 * (every minute, `--once`; see install-scheduled-backup-jobs.ps1). A sweep
 * that finds nothing due prints nothing (the task would otherwise write a
 * line a minute, all night). Output is identifiers and counts only.
 *
 * Exit code: 0 normally, 1 when any offer failed to process (the others
 * were still processed; the failure is also in the PHP error log).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
require dirname(__DIR__) . '/config/autoload.php';
require dirname(__DIR__) . '/config/db.php';

use Baranguard\Services\Dispatch\OfferService;

$once = false;
$daemon = false;
$interval = 60;
foreach (array_slice($argv, 1) as $argument) {
    if ($argument === '--once') {
        $once = true;
    } elseif ($argument === '--daemon') {
        $daemon = true;
    } elseif (preg_match('/^--interval=(\d+)$/', $argument, $m)) {
        $interval = max(5, (int) $m[1]);
    }
}
if (!$once && !$daemon) {
    fwrite(STDERR, "Specify --once or --daemon. See this script's own header for usage.\n");
    exit(2);
}

$exit = 0;
do {
    try {
        // A fresh connection per sweep: a --daemon process must survive the
        // DB restarting or an idle connection being dropped.
        $pdo = baranguard_db_fresh();
        $summary = OfferService::sweep($pdo);
        if ($summary['processed'] > 0 || $summary['errors'] > 0) {
            echo gmdate('Y-m-d\TH:i:s\Z')
                . " dispatch-offer sweep: processed={$summary['processed']}"
                . " rebroadcast={$summary['rebroadcast']} escalated={$summary['escalated']}"
                . " closed={$summary['closed']} errors={$summary['errors']}\n";
        }
        if ($summary['errors'] > 0) {
            $exit = 1;
        }
    } catch (Throwable $e) {
        // A DB blip must not kill the daemon; a --once run reports it.
        fwrite(STDERR, gmdate('Y-m-d\TH:i:s\Z') . ' dispatch-offer sweep failed: ' . $e->getMessage() . "\n");
        $exit = 1;
    }
    if ($daemon) {
        sleep($interval);
    }
} while ($daemon);

exit($exit);
