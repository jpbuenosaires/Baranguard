<?php
declare(strict_types=1);

/**
 * generate-pb-digest.php — the periodic half of the "Periodic PB digest"
 * backlog item (docs/REMAINING.md section G). The content half already
 * existed (GET /reports/export?format=pdf); this is what makes it
 * periodic, now that C2 (2026-09-26) proved a Scheduled Task can run
 * unattended on this workstation without needing an Administrator
 * prompt.
 *
 * CLI-ONLY, deliberately -- same reasoning as retention-job.php's own
 * header: there is no HTTP endpoint that triggers digest generation
 * (only GET /reports/digest and GET /reports/digest/download exist, both
 * read-only), and there should not be one. This calls
 * ReportsController::generateDigest() directly for every real barangay
 * in the `barangay` table (never a hardcoded 1-4 -- see §1's "four
 * barangays, fixed" note, but this reads the table anyway rather than
 * assuming it matches that note forever).
 *
 * Usage (from `backend/`):
 *   php scripts/generate-pb-digest.php              # last 7 days (default)
 *   php scripts/generate-pb-digest.php --days=30     # last 30 days
 *
 * Scheduling: registered by install-scheduled-backup-jobs.ps1 as
 * BaranguardPbDigest, weekly (matches the 7-day default window so each
 * digest covers exactly the period since the last one, with no gap or
 * overlap). Safe to run more often or miss a week -- each run replaces
 * the previous digest for that barangay, it doesn't append to anything.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
require dirname(__DIR__) . '/config/autoload.php';
require dirname(__DIR__) . '/config/db.php';

use Baranguard\Controllers\ReportsController;

function parseDigestArguments(array $argv): array
{
    $days = 7;
    foreach (array_slice($argv, 1) as $arg) {
        if (preg_match('/^--days=(\d+)$/', $arg, $m)) {
            $days = max(1, (int) $m[1]);
        }
    }
    return ['days' => $days];
}

$options = parseDigestArguments($argv);
$pdo = baranguard_db();

$manila = new DateTimeZone('Asia/Manila');
$to = new DateTimeImmutable('now', $manila);
$from = $to->modify("-{$options['days']} days");

echo "Baranguard PB digest — " . gmdate('Y-m-d\TH:i:s\Z') . "\n";
echo "Range: {$from->format('Y-m-d')} to {$to->format('Y-m-d')} ({$options['days']} days, Asia/Manila)\n\n";

$barangays = $pdo->query('SELECT barangay_id, name FROM barangay ORDER BY barangay_id')->fetchAll(PDO::FETCH_ASSOC);
if (!$barangays) {
    echo "No barangays found — nothing to generate.\n";
    exit(1);
}

$failed = 0;
foreach ($barangays as $row) {
    $barangayId = (int) $row['barangay_id'];
    $name = (string) $row['name'];
    try {
        ReportsController::generateDigest($pdo, $barangayId, $from, $to);
        echo "[OK]   Barangay {$barangayId} ({$name})\n";
    } catch (Throwable $e) {
        $failed++;
        echo "[FAIL] Barangay {$barangayId} ({$name}): {$e->getMessage()}\n";
    }
}

echo "\n" . (count($barangays) - $failed) . " of " . count($barangays) . " digests generated.\n";
exit($failed > 0 ? 1 : 0);
