<?php
declare(strict_types=1);

/**
 * ai-evaluate.php — scores PII redaction against a ground-truth dataset
 * and records the result in `ai_evaluation_run` (§5).
 *
 * §10's target: **recall >=95% / precision >=90%**, benchmarked against a
 * baseline regex comparator. Sprint 6's own rule is that those numbers are
 * MEASURED, never estimated — this script is what measures them.
 *
 * TWO ENGINES, SCORED IDENTICALLY so they are directly comparable:
 *   --engine=baseline   RegexRedactor — needs NO model, runs anywhere,
 *                       in about a second. This is the comparison point.
 *   --engine=model      the real local SEA-LION via Ollama. Slow (minutes
 *                       per record on CPU) and requires the model pulled.
 *
 * The baseline is EXPECTED to do well on phone/email/ID/plate and badly on
 * names and addresses. That contrast is the finding — it is what justifies
 * running a self-hosted language model instead of a pattern list.
 *
 * SCORING (identical to docs/AI_Evaluation_Dataset_Guide.md — if you change
 * one, change both):
 *   TP  a planted entity's text no longer appears in the output
 *   FN  it is still there            <- a real privacy failure
 *   FP  placeholders emitted beyond the number of planted entities,
 *       plus any `must_keep` word that disappeared (over-redaction)
 *   recall    = TP / (TP + FN)
 *   precision = TP / (TP + FP)
 *
 * The precision measure is an APPROXIMATION and worth understanding before
 * quoting it: without character-level span alignment we cannot say which
 * placeholder corresponds to which entity, so "extra placeholders beyond
 * the planted count" stands in for false positives. It catches the failure
 * that matters (a model that redacts indiscriminately) but would not
 * notice a model that redacts the wrong span while emitting the right
 * NUMBER of placeholders. `must_keep` is the second line of defence
 * against exactly that.
 *
 * Usage (from backend/):
 *   php scripts/ai-evaluate.php --engine=baseline --dry-run
 *   php scripts/ai-evaluate.php --engine=baseline
 *   php scripts/ai-evaluate.php --engine=model --limit=5
 *   php scripts/ai-evaluate.php --engine=model --dataset=fixtures/redaction-eval-v1.json
 *
 * Options:
 *   --engine=baseline|model   which redactor to score (default: baseline)
 *   --dataset=<path>          dataset JSON (default: fixtures/redaction-eval-v1.json)
 *   --limit=N                 score only the first N records (smoke tests)
 *   --dry-run                 print results, write nothing to the database
 *   --verbose                 per-record detail, including which entities leaked
 *
 * OUTPUT DISCIPLINE: `--verbose` prints the ENTITY STRINGS that leaked,
 * because that is the whole point of a failure report — but every record in
 * a legitimate dataset is INVENTED (see the guide; using real narratives is
 * forbidden precisely so this output is safe to read and paste). Never run
 * this against real incident data.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
require dirname(__DIR__) . '/config/autoload.php';

use Baranguard\Services\Ai\AiPrompts;
use Baranguard\Services\Ai\OllamaClient;
use Baranguard\Services\Ai\OllamaException;
use Baranguard\Services\Ai\OllamaUnavailableException;
use Baranguard\Services\Ai\RegexRedactor;

$options = parseArguments($argv);
$datasetPath = $options['dataset'];
if (!str_starts_with($datasetPath, '/') && !preg_match('/^[A-Za-z]:/', $datasetPath)) {
    $datasetPath = dirname(__DIR__) . '/' . ltrim($datasetPath, '/');
}

if (!is_file($datasetPath)) {
    out("Dataset not found: {$datasetPath}");
    out('The 200-record set is built by hand — see docs/AI_Evaluation_Dataset_Guide.md.');
    exit(1);
}

$raw = file_get_contents($datasetPath);
$dataset = json_decode((string) $raw, true);
if (!is_array($dataset)) {
    out("Dataset is not valid JSON: {$datasetPath}");
    exit(1);
}

// A dataset may be a bare array of records, or an object with metadata.
$records = $dataset['records'] ?? $dataset;
$datasetName = is_array($dataset) && isset($dataset['dataset_name']) ? (string) $dataset['dataset_name'] : basename($datasetPath, '.json');
$datasetVersion = is_array($dataset) && isset($dataset['dataset_version']) ? (string) $dataset['dataset_version'] : 'v1';

if (!is_array($records) || $records === []) {
    out('Dataset contains no records.');
    exit(1);
}
if ($options['limit'] !== null) {
    $records = array_slice($records, 0, $options['limit']);
}

$engine = $options['engine'];
$client = null;
$modelVersion = 'baseline:regex';

if ($engine === 'model') {
    $client = new OllamaClient();
    if (!$client->isConfigured()) {
        out('Ollama is not configured — set OLLAMA_URL and OLLAMA_MODEL, or use --engine=baseline.');
        exit(1);
    }
    $modelVersion = $client->model();
}

out(sprintf(
    'Baranguard redaction evaluation — engine=%s dataset=%s (%s) records=%d',
    $engine,
    $datasetName,
    $datasetVersion,
    count($records)
));
if ($engine === 'model') {
    out("Model: {$modelVersion} · prompts: " . AiPrompts::PROMPT_VERSION);
    out('This calls the model once per record and is SLOW on CPU. --limit=N to sample.');
}
out('');

$totalTp = 0;
$totalFn = 0;
$totalFp = 0;
$scored = 0;
$skipped = 0;
$startedAt = microtime(true);

foreach ($records as $index => $record) {
    if (!is_array($record) || !isset($record['narrative'])) {
        $skipped++;
        continue;
    }
    $id = (string) ($record['id'] ?? ('record-' . $index));
    $narrative = (string) $record['narrative'];
    $entities = is_array($record['entities'] ?? null) ? $record['entities'] : [];
    $mustKeep = is_array($record['must_keep'] ?? null) ? $record['must_keep'] : [];

    try {
        $output = $engine === 'model'
            ? AiPrompts::stripReasoning($client->generate(AiPrompts::redaction($narrative))['text'])
            : RegexRedactor::redact($narrative);
    } catch (OllamaUnavailableException $e) {
        out("[{$id}] Ollama unavailable — stopping. Nothing was written.");
        out('  ' . $e->getMessage());
        exit(1);
    } catch (OllamaException $e) {
        out("[{$id}] model error, counting every entity as a miss: " . $e->getMessage());
        $output = '';
    }

    $result = scoreRecord($narrative, $output, $entities, $mustKeep);
    $totalTp += $result['tp'];
    $totalFn += $result['fn'];
    $totalFp += $result['fp'];
    $scored++;

    if ($options['verbose'] || $result['fn'] > 0) {
        $leaked = $result['leaked'] === [] ? '' : ' LEAKED: ' . implode(' | ', $result['leaked']);
        out(sprintf('[%s] tp=%d fn=%d fp=%d%s', $id, $result['tp'], $result['fn'], $result['fp'], $leaked));
    }
}

$elapsed = round(microtime(true) - $startedAt, 1);

// Guard against 0/0: a dataset of only no-PII records has no recall to
// speak of, and reporting 0.0 would read as a total failure rather than
// "not applicable".
$recall = ($totalTp + $totalFn) > 0 ? $totalTp / ($totalTp + $totalFn) : null;
$precision = ($totalTp + $totalFp) > 0 ? $totalTp / ($totalTp + $totalFp) : null;

out('');
out('================ RESULT ================');
out("Engine:      {$engine} ({$modelVersion})");
out("Records:     {$scored} scored" . ($skipped > 0 ? ", {$skipped} skipped (malformed)" : ''));
out("Entities:    TP={$totalTp} FN={$totalFn} FP={$totalFp}");
out('Recall:      ' . formatScore($recall) . '   (target >= 95%)');
out('Precision:   ' . formatScore($precision) . '   (target >= 90%)');
out("Elapsed:     {$elapsed}s");
out('========================================');

if ($recall !== null && $precision !== null) {
    $meets = $recall >= 0.95 && $precision >= 0.90;
    out($meets ? 'MEETS the §10 target.' : 'DOES NOT meet the §10 target.');
}

if ($options['dryRun']) {
    out('');
    out('--dry-run: nothing was written to ai_evaluation_run.');
    exit(0);
}

require dirname(__DIR__) . '/config/db.php';
$pdo = baranguard_db();

// §5 UNIQUE(dataset_name, dataset_version, model_version, task_type) — a
// re-run of the same combination REPLACES its result rather than failing,
// since re-running an evaluation after a prompt change is routine.
$notes = sprintf(
    'engine=%s; prompts=%s; records=%d; tp=%d fn=%d fp=%d; scored in %ss',
    $engine,
    $engine === 'model' ? AiPrompts::PROMPT_VERSION : 'n/a',
    $scored,
    $totalTp,
    $totalFn,
    $totalFp,
    $elapsed
);

$stmt = $pdo->prepare(
    'INSERT INTO ai_evaluation_run
        (dataset_name, dataset_version, model_version, task_type, sample_count,
         precision_score, recall_score, created_at, notes)
     VALUES
        (:dataset_name, :dataset_version, :model_version, :task_type, :sample_count,
         :precision_score, :recall_score, UTC_TIMESTAMP(), :notes)
     ON DUPLICATE KEY UPDATE
        sample_count = VALUES(sample_count),
        precision_score = VALUES(precision_score),
        recall_score = VALUES(recall_score),
        created_at = UTC_TIMESTAMP(),
        notes = VALUES(notes)'
);
$stmt->execute([
    'dataset_name' => $datasetName,
    'dataset_version' => $datasetVersion,
    'model_version' => $modelVersion,
    'task_type' => 'redaction',
    'sample_count' => $scored,
    'precision_score' => $precision !== null ? round($precision, 5) : null,
    'recall_score' => $recall !== null ? round($recall, 5) : null,
    'notes' => $notes,
]);

out('');
out("Recorded in ai_evaluation_run (dataset={$datasetName} {$datasetVersion}, model_version={$modelVersion}).");
exit(0);

// --- Scoring ---------------------------------------------------------------

/**
 * Scores one record. See this file's header for the definitions — they are
 * deliberately identical to the ones in the dataset guide, so a number here
 * means the same thing a human annotator was told it would mean.
 *
 * @param array<int,mixed> $entities
 * @param array<int,mixed> $mustKeep
 * @return array{tp:int,fn:int,fp:int,leaked:string[]}
 */
function scoreRecord(string $narrative, string $output, array $entities, array $mustKeep): array
{
    $tp = 0;
    $fn = 0;
    $leaked = [];

    foreach ($entities as $entity) {
        $text = is_array($entity) ? (string) ($entity['text'] ?? '') : (string) $entity;
        if (trim($text) === '') {
            continue;
        }
        // Case-insensitive: a model that changes capitalisation while
        // leaving the name in place has still leaked it.
        if (mb_stripos($output, $text) === false) {
            $tp++;
        } else {
            $fn++;
            $leaked[] = $text;
        }
    }

    // Over-redaction, half one: more placeholders than there were entities.
    $placeholderCount = 0;
    foreach (AiPrompts::PLACEHOLDERS as $placeholder) {
        $placeholderCount += substr_count($output, $placeholder);
    }
    $fp = max(0, $placeholderCount - count($entities));

    // Over-redaction, half two: ordinary non-PII content that vanished.
    // This is what catches a model that redacts a whole sentence and still
    // emits a plausible number of placeholders.
    foreach ($mustKeep as $keep) {
        $keepText = (string) $keep;
        if (trim($keepText) === '') {
            continue;
        }
        if (mb_stripos($narrative, $keepText) !== false && mb_stripos($output, $keepText) === false) {
            $fp++;
        }
    }

    return ['tp' => $tp, 'fn' => $fn, 'fp' => $fp, 'leaked' => $leaked];
}

function formatScore(?float $value): string
{
    return $value === null ? 'n/a (no applicable entities)' : sprintf('%.2f%%', $value * 100);
}

/**
 * @param string[] $argv
 * @return array{engine:string,dataset:string,limit:?int,dryRun:bool,verbose:bool}
 */
function parseArguments(array $argv): array
{
    $options = [
        'engine' => 'baseline',
        'dataset' => 'fixtures/redaction-eval-v1.json',
        'limit' => null,
        'dryRun' => false,
        'verbose' => false,
    ];
    foreach (array_slice($argv, 1) as $argument) {
        if (str_starts_with($argument, '--engine=')) {
            $value = substr($argument, strlen('--engine='));
            if (!in_array($value, ['baseline', 'model'], true)) {
                out("Unknown engine '{$value}' — use baseline or model.");
                exit(1);
            }
            $options['engine'] = $value;
        } elseif (str_starts_with($argument, '--dataset=')) {
            $options['dataset'] = substr($argument, strlen('--dataset='));
        } elseif (str_starts_with($argument, '--limit=')) {
            $options['limit'] = max(1, (int) substr($argument, strlen('--limit=')));
        } elseif ($argument === '--dry-run') {
            $options['dryRun'] = true;
        } elseif ($argument === '--verbose') {
            $options['verbose'] = true;
        }
    }
    return $options;
}

function out(string $message): void
{
    fwrite(STDOUT, $message . PHP_EOL);
}
