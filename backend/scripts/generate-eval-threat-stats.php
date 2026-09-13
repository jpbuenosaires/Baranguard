<?php
declare(strict_types=1);

/**
 * generate-eval-threat-stats.php — builds the aggregate-count dataset
 * that evaluates AiPrompts::threatAnalysis() (docs/REMAINING.md A6).
 *
 * threatAnalysis() takes ONLY an aggregate incident-count summary — "no
 * names, no households" by its own prompt text — and must describe
 * patterns "by incident type, time of day, and day of week only,"
 * citing "at most three patrol adjustments, each tied to a specific
 * count you were given." That is a grounding claim the scorer CAN check
 * mechanically: every count the model's output cites should trace back
 * to a number that was actually in the input summary. A model that
 * states a pattern using a number NOT present in `counts` has
 * hallucinated, which is the single most safety-relevant failure mode
 * for a patrol-planning tool (a fabricated "spike" could misdirect real
 * patrol resourcing).
 *
 * Every record here is a synthetic aggregate — no real barangay's real
 * incident history is used or approximated.
 *
 * Usage:
 *   php scripts/generate-eval-threat-stats.php
 *   php scripts/generate-eval-threat-stats.php --out=fixtures/eval-threat-stats-v1.json --seed=42 --count=25
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

$options = ['out' => 'fixtures/eval-threat-stats-v1.json', 'seed' => 42, 'count' => 25];
foreach (array_slice($argv, 1) as $arg) {
    if (str_starts_with($arg, '--out=')) {
        $options['out'] = substr($arg, strlen('--out='));
    } elseif (str_starts_with($arg, '--seed=')) {
        $options['seed'] = (int) substr($arg, strlen('--seed='));
    } elseif (str_starts_with($arg, '--count=')) {
        $options['count'] = max(1, (int) substr($arg, strlen('--count=')));
    }
}
$outPath = $options['out'];
if (!str_starts_with($outPath, '/') && !preg_match('/^[A-Za-z]:/', $outPath)) {
    $outPath = dirname(__DIR__) . '/' . ltrim($outPath, '/');
}
mt_srand($options['seed']);

const INCIDENT_TYPES = ['theft', 'physical_injury', 'disturbance', 'domestic_dispute', 'vandalism',
    'traffic_incident', 'fire', 'medical_emergency', 'missing_person', 'animal_complaint', 'other'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TIME_BLOCKS = ['morning (6AM-12NN)', 'afternoon (12NN-6PM)', 'evening (6PM-12MN)', 'late night (12MN-6AM)'];
const PERIODS = ['the last 7 days', 'the last 30 days', 'the last 90 days'];

function pick(array $pool) { return $pool[array_rand($pool)]; }

$records = [];
$count = $options['count'];
for ($i = 0; $i < $count; $i++) {
    $period = pick(PERIODS);

    // A small, plausible set of (type, count) and (day/time, count)
    // breakdowns — few enough entries that every cited number is easy to
    // trace back by hand while writing the checklist scorer, but varied
    // enough to be a real grounding test, not a trivial one.
    $typeCounts = [];
    $numTypes = mt_rand(2, 4);
    $chosenTypes = (array) array_rand(array_flip(INCIDENT_TYPES), $numTypes);
    foreach ($chosenTypes as $type) {
        $typeCounts[$type] = mt_rand(1, 9);
    }

    $dayCounts = [];
    $numDays = mt_rand(2, 3);
    $chosenDays = (array) array_rand(array_flip(DAYS), $numDays);
    foreach ($chosenDays as $day) {
        $dayCounts[$day] = mt_rand(1, 6);
    }

    $timeCounts = [];
    $numBlocks = mt_rand(1, 2);
    $chosenBlocks = (array) array_rand(array_flip(TIME_BLOCKS), $numBlocks);
    foreach ($chosenBlocks as $block) {
        $timeCounts[$block] = mt_rand(1, 6);
    }

    $lines = [];
    foreach ($typeCounts as $type => $n) {
        $lines[] = "{$type}: {$n}";
    }
    foreach ($dayCounts as $day => $n) {
        $lines[] = "{$day}: {$n}";
    }
    foreach ($timeCounts as $block => $n) {
        $lines[] = "{$block}: {$n}";
    }
    $summary = implode("\n", $lines);

    $allCounts = array_merge(
        array_map(fn ($t, $n) => ['label' => $t, 'count' => $n], array_keys($typeCounts), array_values($typeCounts)),
        array_map(fn ($d, $n) => ['label' => $d, 'count' => $n], array_keys($dayCounts), array_values($dayCounts)),
        array_map(fn ($b, $n) => ['label' => $b, 'count' => $n], array_keys($timeCounts), array_values($timeCounts)),
    );

    $id = sprintf('threat-%03d', $i + 1);
    $records[] = [
        'id' => $id,
        'period_label' => $period,
        'aggregate_summary' => $summary,
        'counts' => $allCounts,
    ];
}

// Self-validation: every (label, count) pair really is a "label: count"
// line inside the summary text the model will actually receive.
$errors = [];
foreach ($records as $r) {
    foreach ($r['counts'] as $c) {
        $needle = "{$c['label']}: {$c['count']}";
        if (mb_strpos($r['aggregate_summary'], $needle) === false) {
            $errors[] = "{$r['id']}: expected line '{$needle}' not found in aggregate_summary";
        }
    }
}
if ($errors !== []) {
    fwrite(STDERR, "VALIDATION FAILED (" . count($errors) . " problems):\n");
    foreach ($errors as $e) {
        fwrite(STDERR, "  - {$e}\n");
    }
    exit(1);
}

fwrite(STDOUT, "Validation passed: {$count} records, every (label, count) pair found verbatim in its aggregate_summary.\n");

$output = [
    'dataset_name' => 'eval-threat-stats-v1',
    'dataset_version' => 'v1',
    'generation_method' => 'AI-generated synthetic aggregate incident-count summaries (backend/scripts/generate-eval-threat-stats.php). No real barangay incident history is used or approximated -- every count is invented.',
    'generated_at' => gmdate('c'),
    'record_count' => count($records),
    'records' => $records,
];

if (!is_dir(dirname($outPath))) {
    mkdir(dirname($outPath), 0777, true);
}
file_put_contents($outPath, json_encode($output, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
fwrite(STDOUT, "\nWrote " . count($records) . " records to {$outPath}\n");
