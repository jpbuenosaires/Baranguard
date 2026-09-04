<?php
declare(strict_types=1);

/**
 * retention-job.php — Sprint 7's retention job runner (§11's retention
 * table; §2 Rules 11, 17 and 25).
 *
 * Usage (from `backend/`):
 *   php scripts/retention-job.php --dry-run     # count only, delete nothing
 *   php scripts/retention-job.php               # apply every rule
 *   php scripts/retention-job.php --only=raw_narrative,sms_log
 *   php scripts/retention-job.php --list        # show the rules + periods
 *
 * **Run `--dry-run` first on any database that has real data in it.**
 * The very first real run on a system that has been collecting for a
 * while can delete a lot at once, and unlike every other operation in
 * this codebase, retention deletion is irreversible by design — that is
 * the entire point of it.
 *
 * Scheduling: this is a plain CLI script, run it from Windows Task
 * Scheduler (or `cron` on a Linux host) once a day. It is safe to run
 * more often — every rule is a time-window scan, so a second run in the
 * same day simply finds nothing new. It is equally safe to MISS days:
 * nothing is keyed to "ran yesterday", so a workstation that was off for
 * a week catches up on the next run.
 *
 * CLI-ONLY, deliberately: there is no HTTP endpoint that triggers
 * retention, and there should not be. §6 documents no such endpoint, and
 * a web-reachable "delete everything past its date" action is a
 * liability with no operational upside on a single-workstation LAN
 * system (Rule 7). Same reasoning that keeps `ai-worker.php` off the API
 * surface.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
require dirname(__DIR__) . '/config/autoload.php';
require dirname(__DIR__) . '/config/db.php';

use Baranguard\Services\Retention\RetentionService;

$options = parseArguments($argv);

if ($options['list']) {
    printRuleTable();
    exit(0);
}

$pdo = baranguard_db();
$service = new RetentionService($pdo, $options['dry_run']);

$mode = $options['dry_run'] ? 'DRY RUN — nothing will be deleted' : 'APPLYING';
out('Baranguard retention job — ' . gmdate('Y-m-d H:i:s') . ' UTC');
out($mode);
if ($options['only'] !== null) {
    out('Rules: ' . implode(', ', $options['only']));
}
out('');

$started = microtime(true);
try {
    $results = $service->runAll($options['only']);
} catch (\Throwable $e) {
    fwrite(STDERR, 'Retention job failed: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}
$elapsed = round(microtime(true) - $started, 2);

foreach ($service->log() as $line) {
    out('  ' . $line);
}

$totalPurged = 0;
$totalHeld = 0;
$totalEligible = 0;
foreach ($results as $result) {
    $totalPurged += $result['purged'] ?? 0;
    $totalHeld += $result['held'] ?? 0;
    $totalEligible += $result['eligible'] ?? 0;
}

out('');
if ($options['dry_run']) {
    out("Would purge {$totalEligible} record(s); {$totalHeld} protected by legal hold. ({$elapsed}s)");
} else {
    out("Purged {$totalPurged} record(s); {$totalHeld} protected by legal hold. ({$elapsed}s)");
}

// Rule 11 / §11: "a database deletion is not considered complete while
// retained backups still contain the same data outside their documented
// backup lifecycle." This job cannot see backup files, so it says so on
// every run rather than letting an operator infer that running it means
// the data is gone everywhere.
out('');
out('Reminder: backups are NOT covered by this job. Per §11 and Rule 11, an');
out('encrypted backup produced by scripts/backup.sh still holds whatever it');
out('captured — expiring those files is a separate runbook step.');

exit(0);

/** @return array{dry_run:bool, only:?list<string>, list:bool} */
function parseArguments(array $argv): array
{
    $options = ['dry_run' => false, 'only' => null, 'list' => false];
    foreach (array_slice($argv, 1) as $arg) {
        if ($arg === '--dry-run') {
            $options['dry_run'] = true;
        } elseif ($arg === '--list') {
            $options['list'] = true;
        } elseif (str_starts_with($arg, '--only=')) {
            $names = array_values(array_filter(array_map('trim', explode(',', substr($arg, 7)))));
            $unknown = array_diff($names, RetentionService::RULES);
            if ($unknown !== []) {
                fwrite(STDERR, 'Unknown rule(s): ' . implode(', ', $unknown) . PHP_EOL);
                fwrite(STDERR, 'Known rules: ' . implode(', ', RetentionService::RULES) . PHP_EOL);
                exit(2);
            }
            $options['only'] = $names;
        } else {
            fwrite(STDERR, "Unknown argument: {$arg}" . PHP_EOL);
            exit(2);
        }
    }
    return $options;
}

function printRuleTable(): void
{
    out('§11 retention periods, as implemented:');
    out('');
    out(sprintf('  %-20s %s', 'raw_narrative', RetentionService::RAW_NARRATIVE_GRACE_DAYS . ' days after approved redaction; ' . RetentionService::RAW_NARRATIVE_CEILING_DAYS . '-day ceiling if never approved'));
    out(sprintf('  %-20s %s', 'citizen_report', RetentionService::CITIZEN_REPORT_DAYS . ' days from submitted_at, UNCONVERTED reports only'));
    out(sprintf('  %-20s %s', 'sms_log', RetentionService::SMS_LOG_DAYS . ' days from created_at'));
    out(sprintf('  %-20s %s', 'ai_processing_log', RetentionService::AI_LOG_DAYS . ' days, or the incident\'s ' . RetentionService::RECORD_RETENTION_DAYS . '-day clock — whichever is longer'));
    out(sprintf('  %-20s %s', 'mobile_device', RetentionService::DEVICE_DEACTIVATED_DAYS . ' days after deactivation'));
    out(sprintf('  %-20s %s', 'audit_log', RetentionService::AUDIT_LOG_DAYS . ' days (7 years)'));
    out(sprintf('  %-20s %s', 'incident_records', RetentionService::RECORD_RETENTION_DAYS . ' days (7 years) — incident + blotter + evidence cascade'));
    out('');
    out('Legal hold (incident.legal_hold, evidence_attachment.legal_hold,');
    out('citizen_report.legal_hold) is the only exception to any of these.');
}

function out(string $line): void
{
    echo $line . PHP_EOL;
}
