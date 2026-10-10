<?php
declare(strict_types=1);

/**
 * metrics-report.php — prints the measured numbers the thesis needs for
 * objectives 1 and 2 and the ISO/IEC 25010 evaluation, from data the system
 * already stores. READ-ONLY: every query is a SELECT; it writes nothing.
 *
 * Usage (from backend/):
 *   php scripts/metrics-report.php                     everything on record
 *   php scripts/metrics-report.php --days=7            only the last 7 days
 *   php scripts/metrics-report.php --since=2026-10-01  only on/after a date (UTC)
 *   php scripts/metrics-report.php --json              machine-readable output
 *
 * Point it at a database with the usual DB_* variables in backend/.env.
 * Check `DB_NAME` first: the demo DB (baranguard_uiseed) is seed data and
 * must NOT be reported as real-world performance.
 *
 * WHAT EACH NUMBER IS, AND ITS LIMIT (say this in the thesis too):
 *  - GPS delivery delay = gps_track.received_at - recorded_at. Small for a
 *    live fix, large when a phone queued the fix offline; it measures
 *    "phone captured it" to "server stored it", NOT the dashboard's 15 s
 *    poll on top. Dashboard staleness is at most delay + 15 s by design.
 *  - Position update interval = gap between consecutive fixes per Tanod
 *    (how often a marker can move at all).
 *  - Offline incident sync delay = incident.synced_at - device_offline_created_at,
 *    only for incidents that were created offline.
 *  - SOS delay = tanod_sos.received_at - triggered_at.
 *  - Dispatch response = incident.created_at to the earliest dispatch.arrived_at
 *    (REFERENCE.md definition, same de-dup as ReportsController / F8).
 *  - Sync batch outcomes come from backend/storage/metrics/sync-*.jsonl, which
 *    exists only for batches processed AFTER the logging was added
 *    (2026-10-10). Duplicates are expected after a retry and are not errors.
 * Clock skew between phone and server inflates or deflates the delay figures;
 * they are only as good as the phones' clocks.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
require dirname(__DIR__) . '/config/db.php';

$opts = [];
foreach (array_slice($argv, 1) as $a) {
    if (str_starts_with($a, '--')) {
        $kv = explode('=', substr($a, 2), 2);
        $opts[$kv[0]] = $kv[1] ?? true;
    }
}
$since = null;
if (isset($opts['since']) && is_string($opts['since'])) {
    $ts = strtotime($opts['since'] . ' 00:00:00 UTC');
    if ($ts === false) {
        fwrite(STDERR, "Bad --since date.\n");
        exit(1);
    }
    $since = gmdate('Y-m-d H:i:s', $ts);
} elseif (isset($opts['days']) && is_string($opts['days']) && ctype_digit($opts['days'])) {
    $since = gmdate('Y-m-d H:i:s', time() - ((int) $opts['days']) * 86400);
}
$asJson = isset($opts['json']);

/** Nearest-rank percentile of an already-sorted list of numbers. */
function pct(array $sorted, float $p): ?float
{
    $n = count($sorted);
    if ($n === 0) {
        return null;
    }
    $rank = (int) ceil($p / 100 * $n);
    return (float) $sorted[max(0, min($n - 1, $rank - 1))];
}

/** @param list<int|float> $values @return array<string,int|float|null> */
function summarize(array $values): array
{
    sort($values);
    $n = count($values);
    return [
        'n' => $n,
        'min' => $n ? (float) $values[0] : null,
        'median' => pct($values, 50),
        'p95' => pct($values, 95),
        'max' => $n ? (float) $values[$n - 1] : null,
    ];
}

$pdo = baranguard_db();
$dbName = (string) $pdo->query('SELECT DATABASE()')->fetchColumn();

/** @return list<int|float> */
function column(PDO $pdo, string $sql, array $params = []): array
{
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return array_map(static fn ($v) => $v + 0, $stmt->fetchAll(PDO::FETCH_COLUMN));
}
$sinceP = $since !== null ? ['s' => $since] : [];

$report = ['database' => $dbName, 'since_utc' => $since, 'generated_utc' => gmdate('Y-m-d\TH:i:s\Z')];

// --- Objective 1: responder tracking ------------------------------------
$report['gps_delivery_delay_s'] = summarize(column(
    $pdo,
    'SELECT GREATEST(0, TIMESTAMPDIFF(SECOND, recorded_at, received_at)) FROM gps_track'
    . ($since !== null ? ' WHERE recorded_at >= :s' : ''),
    $sinceP
));
$report['gps_delivery_delay_live_only_s'] = summarize(column(
    $pdo,
    'SELECT GREATEST(0, TIMESTAMPDIFF(SECOND, recorded_at, received_at)) FROM gps_track WHERE TIMESTAMPDIFF(SECOND, recorded_at, received_at) <= 120'
    . ($since !== null ? ' AND recorded_at >= :s' : ''),
    $sinceP
));
$report['gps_position_interval_s'] = summarize(column(
    $pdo,
    'SELECT gap FROM (
        SELECT TIMESTAMPDIFF(SECOND, LAG(recorded_at) OVER (PARTITION BY user_id ORDER BY recorded_at), recorded_at) AS gap
        FROM gps_track' . ($since !== null ? ' WHERE recorded_at >= :s' : '') . '
     ) t WHERE gap IS NOT NULL AND gap > 0 AND gap <= 600',
    $sinceP
));
$report['dispatch_response_min'] = summarize(column(
    $pdo,
    'SELECT TIMESTAMPDIFF(SECOND, i.created_at, a.first_arrived) / 60 FROM incident i
     JOIN (SELECT incident_id, MIN(arrived_at) AS first_arrived FROM dispatch WHERE arrived_at IS NOT NULL GROUP BY incident_id) a
       ON a.incident_id = i.incident_id
     WHERE a.first_arrived >= i.created_at' . ($since !== null ? ' AND i.created_at >= :s' : ''),
    $sinceP
));

// --- Objective 2: offline-first / sync ----------------------------------
$report['incidents'] = [
    'created_offline' => (int) column($pdo, 'SELECT COUNT(*) FROM incident WHERE device_offline_created_at IS NOT NULL' . ($since !== null ? ' AND created_at >= :s' : ''), $sinceP)[0],
    'created_total' => (int) column($pdo, 'SELECT COUNT(*) FROM incident' . ($since !== null ? ' WHERE created_at >= :s' : ''), $sinceP)[0],
];
$report['offline_incident_sync_delay_s'] = summarize(column(
    $pdo,
    'SELECT GREATEST(0, TIMESTAMPDIFF(SECOND, device_offline_created_at, synced_at)) FROM incident
     WHERE device_offline_created_at IS NOT NULL AND synced_at IS NOT NULL' . ($since !== null ? ' AND created_at >= :s' : ''),
    $sinceP
));
$report['sos_delay_s'] = summarize(column(
    $pdo,
    'SELECT GREATEST(0, TIMESTAMPDIFF(SECOND, triggered_at, received_at)) FROM tanod_sos' . ($since !== null ? ' WHERE triggered_at >= :s' : ''),
    $sinceP
));
$sosStmt = $pdo->prepare('SELECT fallback_channel, COUNT(*) c FROM tanod_sos' . ($since !== null ? ' WHERE triggered_at >= :s' : '') . ' GROUP BY fallback_channel');
$sosStmt->execute($sinceP);
$report['sos_by_channel'] = array_column($sosStmt->fetchAll(), 'c', 'fallback_channel');

// Sync batch outcomes (file log, added 2026-10-10).
$kinds = [];
$serverMs = [];
$batches = 0;
foreach (glob(dirname(__DIR__) . '/storage/metrics/sync-*.jsonl') ?: [] as $file) {
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $row = json_decode($line, true);
        if (!is_array($row) || !isset($row['ts'], $row['results']) || !is_array($row['results'])) {
            continue;
        }
        if ($since !== null && strtotime((string) $row['ts']) < strtotime($since . ' UTC')) {
            continue;
        }
        $batches++;
        $serverMs[] = (int) ($row['server_ms'] ?? 0);
        foreach ($row['results'] as $kind => $statuses) {
            foreach ((array) $statuses as $status => $count) {
                $kinds[$kind][$status] = ($kinds[$kind][$status] ?? 0) + (int) $count;
            }
        }
    }
}
$totals = ['success' => 0, 'duplicate' => 0, 'failed' => 0];
foreach ($kinds as $statuses) {
    foreach ($statuses as $s => $c) {
        $totals[$s] = ($totals[$s] ?? 0) + $c;
    }
}
$items = array_sum($totals);
$report['sync'] = [
    'batches' => $batches,
    'items' => $items,
    'by_kind' => $kinds,
    'success_rate' => $items ? round($totals['success'] / $items, 4) : null,
    'duplicate_rate' => $items ? round($totals['duplicate'] / $items, 4) : null,
    'failed_rate' => $items ? round($totals['failed'] / $items, 4) : null,
    'server_ms' => summarize($serverMs),
    'note' => $batches === 0 ? 'No sync-*.jsonl found: no batch processed since logging was added, or storage/metrics is not writable.' : null,
];

if ($asJson) {
    echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    exit(0);
}

function line(string $label, array $s, string $unit): void
{
    if (($s['n'] ?? 0) === 0) {
        printf("  %-38s no data\n", $label);
        return;
    }
    printf("  %-38s n=%-6d median=%s p95=%s max=%s %s\n", $label, $s['n'], round($s['median'], 1), round($s['p95'], 1), round($s['max'], 1), $unit);
}

echo "Baranguard metrics report — database: {$dbName}" . ($since ? " — since {$since} UTC" : ' — all data') . PHP_EOL;
if (str_contains($dbName, 'uiseed')) {
    echo "  WARNING: this is the demo/seed database; do not cite these numbers as real-world results." . PHP_EOL;
}
echo PHP_EOL . "Objective 1 — responder tracking" . PHP_EOL;
line('GPS fix delivery delay (all)', $report['gps_delivery_delay_s'], 's');
line('GPS fix delivery delay (live, <=120 s)', $report['gps_delivery_delay_live_only_s'], 's');
line('Interval between fixes per Tanod', $report['gps_position_interval_s'], 's');
line('Dispatch response (created -> arrived)', $report['dispatch_response_min'], 'min');
echo PHP_EOL . "Objective 2 — offline-first and sync" . PHP_EOL;
printf("  Incidents created offline: %d of %d\n", $report['incidents']['created_offline'], $report['incidents']['created_total']);
line('Offline incident -> server delay', $report['offline_incident_sync_delay_s'], 's');
line('SOS trigger -> server delay', $report['sos_delay_s'], 's');
echo '  SOS by channel: ' . json_encode($report['sos_by_channel']) . PHP_EOL;
$sy = $report['sync'];
if ($sy['batches'] === 0) {
    echo '  Sync batches: none logged. ' . $sy['note'] . PHP_EOL;
} else {
    printf("  Sync: %d batches, %d items — success %.1f%%, duplicate %.1f%%, failed %.1f%%\n", $sy['batches'], $sy['items'], $sy['success_rate'] * 100, $sy['duplicate_rate'] * 100, $sy['failed_rate'] * 100);
    line('Server time per sync batch', $sy['server_ms'], 'ms');
}
echo PHP_EOL . "Not measured here: API response times (use scripts/measure-api-latency.mjs), battery, SUS, uptime." . PHP_EOL;
