<?php
declare(strict_types=1);

/**
 * verify-retention-new-tables-seam.php — TEST SEAM DRIVER for
 * verify-retention-new-tables.sh. NOT a production script.
 *
 * Drives RetentionService for the four placeholder rules of the 0030-0033
 * tables, optionally handing the constructor's TEST-ONLY duration override
 * (the one and only way to give those rules a number outside a reviewed
 * constant change — Rule 10). Prints one JSON document on stdout.
 *
 * Usage (from backend/, DB_* + SCANS_DIR in the environment):
 *   php scripts/verify-retention-new-tables-seam.php shipped
 *   php scripts/verify-retention-new-tables-seam.php override <days> [--dry-run]
 *   php scripts/verify-retention-new-tables-seam.php bad-override <rule> <days>
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

$mode = $argv[1] ?? '';
$pdo = baranguard_db();
$only = ['tanod_availability', 'accomplishment_report', 'school_checkin', 'incident_referral', 'ssz_term_report'];

if ($mode === 'shipped') {
    // The shipped constants, no override: what production runs.
    $service = new RetentionService($pdo, false);
    $results = $service->runAll();
    echo json_encode(['results' => $results, 'log' => $service->log()], JSON_UNESCAPED_SLASHES), PHP_EOL;
    exit(0);
}

if ($mode === 'override') {
    $days = (int) ($argv[2] ?? 0);
    $dry = in_array('--dry-run', $argv, true);
    $overrides = array_fill_keys($only, $days);
    $service = new RetentionService($pdo, $dry, $overrides);
    $results = $service->runAll($only);
    echo json_encode(['results' => $results, 'log' => $service->log()], JSON_UNESCAPED_SLASHES), PHP_EOL;
    exit(0);
}

if ($mode === 'bad-override') {
    try {
        $rule = (string) ($argv[2] ?? '');
        $raw = $argv[3] ?? '';
        $days = ctype_digit($raw) || $raw === '-1' ? (int) $raw : $raw; // non-numeric stays a string
        new RetentionService($pdo, false, [$rule => $days]);
        echo json_encode(['rejected' => false]), PHP_EOL;
    } catch (\InvalidArgumentException $e) {
        echo json_encode(['rejected' => true]), PHP_EOL;
    }
    exit(0);
}

fwrite(STDERR, "unknown mode\n");
exit(2);
