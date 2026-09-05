<?php
declare(strict_types=1);

/**
 * ai-worker.php — drains the AI job queue (`ai_processing_log`) by running
 * the local SLM. Sprint 5's "job queue that survives Ollama being
 * unreachable".
 *
 * This is the ONLY process in the entire system that calls the model. The
 * API never does (see AiDraftController's class doc): a web request only
 * ever enqueues, so a stopped/missing/still-pulling Ollama can never make
 * `POST /incidents/:id/redact` fail or hang. §2 Rule 15: "AI jobs queue.
 * No external AI fallback exists."
 *
 * Pipeline order is §2 Rule 16's, exactly:
 *     raw narrative  ->  redaction draft  ->  summary DERIVED FROM THE DRAFT
 * The summary step is handed `$draftRedacted`, never the raw text — Rule
 * 16: "Summary generation never reads raw text."
 *
 * OUTPUT DISCIPLINE: this script prints identifiers, statuses, timings and
 * character COUNTS only. It never prints `raw_narrative`, a draft, a
 * summary, or a translation. §2 Rule 1 keeps raw narrative inside the
 * trusted store, and a worker that echoed drafts into a terminal
 * scrollback (or a redirected logfile, or a CI transcript) would leak
 * exactly what the redaction pipeline exists to remove.
 *
 * Usage (from backend/):
 *   php scripts/ai-worker.php               drain every queued job, then exit
 *   php scripts/ai-worker.php --once        run at most one job
 *   php scripts/ai-worker.php --max=5       run at most five
 *   php scripts/ai-worker.php --daemon      keep polling (Ctrl-C to stop)
 *   php scripts/ai-worker.php --status      print queue depth and exit
 *   php scripts/ai-worker.php --recover     requeue jobs stuck in `processing`
 *
 * Run it after starting Ollama:
 *   ollama serve                            (or the desktop app)
 *   ollama run aisingapore/Llama-SEA-LION-v3.5-8B-R
 * See scripts/README-ai.md.
 */

if (PHP_SAPI !== 'cli') {
    // Never reachable over HTTP: this process reads raw_narrative, and
    // backend/.htaccess denies everything outside public/ anyway — this is
    // defence in depth, not the only guard.
    http_response_code(404);
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
require dirname(__DIR__) . '/config/autoload.php';
require dirname(__DIR__) . '/config/db.php';

use Baranguard\Services\Ai\AiJobQueue;
use Baranguard\Services\Ai\AiPrompts;
use Baranguard\Services\Ai\OllamaClient;
use Baranguard\Services\Ai\OllamaException;
use Baranguard\Services\Ai\OllamaUnavailableException;

$options = parseArguments($argv);

$pdo = baranguard_db();
$client = new OllamaClient();

if ($options['status']) {
    printQueueStatus($pdo, $client);
    exit(0);
}

if ($options['recover']) {
    $recovered = AiJobQueue::requeueStaleProcessing($pdo);
    out("Requeued {$recovered} job(s) stuck in 'processing'.");
    exit(0);
}

if (!$client->isConfigured()) {
    out('Ollama is not configured — set OLLAMA_URL and OLLAMA_MODEL in backend/.env.');
    out('Queued jobs stay queued; nothing was lost. (§2 Rule 15)');
    exit(1);
}

// A worker starting up is the natural moment to reclaim jobs abandoned by
// a previous run that was killed mid-job (Ctrl-C, power cut, XAMPP
// restart) — otherwise those rows sit in `processing` forever with no
// process left to finish them.
$recovered = AiJobQueue::requeueStaleProcessing($pdo);
if ($recovered > 0) {
    out("Recovered {$recovered} job(s) left in 'processing' by an earlier run.");
}

$processed = 0;
$limit = $options['max'];

do {
    $job = AiJobQueue::claimNextQueuedJob($pdo);

    if ($job === null) {
        if (!$options['daemon']) {
            break;
        }
        sleep(5);
        continue;
    }

    $logId = (int) $job['log_id'];
    $incidentId = (int) $job['incident_id'];
    $taskType = (string) $job['task_type'];
    $startedAt = microtime(true);
    out("[job {$logId}] claimed — task={$taskType} incident={$incidentId}");

    try {
        if ($taskType === 'translation') {
            runTranslationJob($pdo, $client, $job);
        } elseif ($taskType === 'extraction') {
            runExtractionJob($pdo, $client, $job);
        } elseif (trim((string) ($job['draft_redacted_narrative'] ?? '')) !== '') {
            // A queued row that ALREADY has a draft narrative can only be a
            // summary regeneration (POST .../regenerate-summary saved the
            // Secretary's edited text and re-queued it). A fresh redaction
            // enqueue always has this column NULL. Distinguishing on the
            // data rather than on a flag means the summary-only path
            // structurally cannot re-read raw_narrative or overwrite the
            // Secretary's edits.
            runSummaryOnlyJob($pdo, $client, $job);
        } else {
            runRedactionJob($pdo, $client, $job);
        }
        $elapsed = round(microtime(true) - $startedAt, 1);
        out("[job {$logId}] completed in {$elapsed}s");
        $processed++;
    } catch (OllamaUnavailableException $e) {
        // Rule 15: the service wasn't reachable — the job is fine, the
        // workstation wasn't. Put it back exactly as it was and stop;
        // hammering a down service just burns the queue's ordering.
        AiJobQueue::requeue($pdo, $logId);
        out("[job {$logId}] Ollama unavailable — job requeued, worker stopping.");
        out('  ' . $e->getMessage());
        break;
    } catch (OllamaException $e) {
        AiJobQueue::fail($pdo, $logId, 'OLLAMA_ERROR');
        out("[job {$logId}] FAILED — " . $e->getMessage());
        $processed++;
    } catch (\Throwable $e) {
        AiJobQueue::fail($pdo, $logId, 'WORKER_ERROR');
        // The message may describe a DB/PHP fault; it never contains
        // narrative text, because nothing above puts narrative text into
        // an exception message.
        out("[job {$logId}] FAILED — " . $e->getMessage());
        $processed++;
    }
} while ($options['daemon'] || $limit === null || $processed < $limit);

out("Done. {$processed} job(s) processed this run.");
printQueueStatus($pdo, $client);
exit(0);

// --- Job runners -----------------------------------------------------------

/**
 * Rule 16's two ordered steps on one pipeline row.
 *
 * @param array<string,mixed> $job
 */
function runRedactionJob(PDO $pdo, OllamaClient $client, array $job): void
{
    $logId = (int) $job['log_id'];
    $incidentId = (int) $job['incident_id'];

    $raw = AiJobQueue::rawNarrativeFor($pdo, $incidentId);
    if ($raw === null || trim($raw) === '') {
        AiJobQueue::fail($pdo, $logId, 'INCIDENT_MISSING_RAW');
        out("[job {$logId}] FAILED — incident {$incidentId} has no raw narrative.");
        return;
    }

    // Step 1: raw -> redaction draft. The only place raw text meets the model.
    $redactionResult = $client->generate(AiPrompts::redaction($raw));
    $draftRedacted = AiPrompts::stripReasoning($redactionResult['text']);

    if ($draftRedacted === '') {
        // The model answered but produced nothing usable after the
        // reasoning trace was stripped. Failing is correct — storing an
        // empty draft would look like "successfully redacted to nothing".
        AiJobQueue::fail($pdo, $logId, 'REDACTION_EMPTY_AFTER_STRIP');
        out("[job {$logId}] FAILED — empty redaction after stripping reasoning output.");
        return;
    }
    out("[job {$logId}] redaction draft produced (" . mb_strlen($draftRedacted) . ' chars)');

    // Step 2: summary DERIVED FROM THE DRAFT (Rule 16 — never from $raw).
    $draftSummary = null;
    $summaryStale = false;
    try {
        $summaryResult = $client->generate(AiPrompts::summary($draftRedacted));
        $draftSummary = AiPrompts::stripReasoning($summaryResult['text']);
        if ($draftSummary === '') {
            $draftSummary = null;
            $summaryStale = true;
        }
    } catch (OllamaUnavailableException | OllamaException $e) {
        // Keep the redaction work. The row completes with
        // draft_summary_stale=true, which §6 makes a hard block on
        // approval — so this is visible and correctable (via
        // regenerate-summary), never silently approvable.
        $summaryStale = true;
        out("[job {$logId}] summary step failed — draft kept, marked stale: " . $e->getMessage());
    }

    if ($draftSummary !== null) {
        out("[job {$logId}] summary produced (" . mb_strlen($draftSummary) . ' chars)');
    }

    AiJobQueue::completeRedaction(
        $pdo,
        $logId,
        $draftRedacted,
        $draftSummary,
        $summaryStale,
        $redactionResult['model']
    );
}

/**
 * Regenerates ONLY the summary, from the draft the Secretary edited
 * (POST /incidents/:id/ai-draft/regenerate-summary).
 *
 * Rule 16: "Generates summary only from supplied draft text." This
 * function never touches `raw_narrative` — it works purely from the
 * `draft_redacted_narrative` already on the row, which is what makes that
 * rule structural here rather than merely intended. It also must not
 * re-run redaction: doing so would silently discard the Secretary's edits.
 *
 * @param array<string,mixed> $job
 */
function runSummaryOnlyJob(PDO $pdo, OllamaClient $client, array $job): void
{
    $logId = (int) $job['log_id'];
    $draftRedacted = (string) $job['draft_redacted_narrative'];

    $result = $client->generate(AiPrompts::summary($draftRedacted));
    $summary = AiPrompts::stripReasoning($result['text']);

    if ($summary === '') {
        // Leave draft_summary_stale set — approval stays blocked, which is
        // the correct outcome for a summary that could not be produced.
        AiJobQueue::fail($pdo, $logId, 'SUMMARY_EMPTY_AFTER_STRIP');
        out("[job {$logId}] FAILED — empty summary after stripping reasoning output.");
        return;
    }

    out("[job {$logId}] summary regenerated (" . mb_strlen($summary) . ' chars)');
    AiJobQueue::completeSummary($pdo, $logId, $summary, $result['model']);
}

/**
 * Electronic Blotter follow-up (migration 0008): drafts complainant/
 * respondent/contact-number as structured fields. Independent of the
 * redaction pipeline — reads `raw_narrative` directly, same as
 * `runRedactionJob()` does, since these are exactly the identifiers
 * redaction is designed to strip out of the narrative text.
 *
 * @param array<string,mixed> $job
 */
function runExtractionJob(PDO $pdo, OllamaClient $client, array $job): void
{
    $logId = (int) $job['log_id'];
    $incidentId = (int) $job['incident_id'];

    $raw = AiJobQueue::rawNarrativeFor($pdo, $incidentId);
    if ($raw === null || trim($raw) === '') {
        AiJobQueue::fail($pdo, $logId, 'INCIDENT_MISSING_RAW');
        out("[job {$logId}] FAILED — incident {$incidentId} has no raw narrative.");
        return;
    }

    $result = $client->generate(AiPrompts::extraction($raw));
    $text = AiPrompts::stripReasoning($result['text']);

    [$complainant, $respondent, $contact] = parseExtractionLines($text);

    out("[job {$logId}] extraction produced (complainant=" . ($complainant !== null ? 'yes' : 'no')
        . ', respondent=' . ($respondent !== null ? 'yes' : 'no')
        . ', contact=' . ($contact !== null ? 'yes' : 'no') . ')');

    AiJobQueue::completeExtraction($pdo, $logId, $complainant, $respondent, $contact, $result['model']);
}

/**
 * Parses the three `Label: value` lines `AiPrompts::extraction()` asks
 * for. Tolerant of case and a missing line (the model may drop a blank
 * one instead of writing "Label:" with nothing after it) — a field the
 * model didn't produce simply stays null, same as "not mentioned" would.
 *
 * @return array{0:?string,1:?string,2:?string} [complainant, respondent, contact]
 */
function parseExtractionLines(string $text): array
{
    $fields = ['complainant' => null, 'respondent' => null, 'contact' => null];
    $labels = ['complainant' => 'complainant', 'respondent' => 'respondent', 'contact' => 'contact'];

    foreach (preg_split('/\R/', $text) ?: [] as $line) {
        if (!str_contains($line, ':')) {
            continue;
        }
        [$label, $value] = array_map('trim', explode(':', $line, 2));
        $key = strtolower($label);
        foreach ($labels as $fieldKey => $matchLabel) {
            if ($key === $matchLabel && $value !== '') {
                $fields[$fieldKey] = mb_substr($value, 0, $fieldKey === 'contact' ? 32 : 255);
            }
        }
    }

    return [$fields['complainant'], $fields['respondent'], $fields['contact']];
}

/**
 * Post-approval translation (Rule 16). Reads the APPROVED redacted
 * narrative, never the raw text and never the draft.
 *
 * @param array<string,mixed> $job
 */
function runTranslationJob(PDO $pdo, OllamaClient $client, array $job): void
{
    $logId = (int) $job['log_id'];
    $incidentId = (int) $job['incident_id'];
    $targetLanguage = (string) ($job['target_language'] ?? '');

    // §2 Rule 30: recheck authorisation/prerequisite state at WRITE time,
    // not only when the job was queued. Approval could have been absent
    // all along, or the record could have changed while this sat in the
    // queue.
    $stmt = $pdo->prepare(
        'SELECT redacted_narrative, redaction_approved_at FROM incident WHERE incident_id = :incident_id'
    );
    $stmt->execute(['incident_id' => $incidentId]);
    $incident = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($incident === false || $incident['redaction_approved_at'] === null || $incident['redacted_narrative'] === null) {
        AiJobQueue::fail($pdo, $logId, 'TRANSLATION_NOT_APPROVED');
        out("[job {$logId}] FAILED — incident {$incidentId} has no approved redaction.");
        return;
    }

    $result = $client->generate(AiPrompts::translation((string) $incident['redacted_narrative'], $targetLanguage));
    $translated = AiPrompts::stripReasoning($result['text']);

    if ($translated === '') {
        AiJobQueue::fail($pdo, $logId, 'TRANSLATION_EMPTY_AFTER_STRIP');
        out("[job {$logId}] FAILED — empty translation after stripping reasoning output.");
        return;
    }

    out("[job {$logId}] translation produced (" . mb_strlen($translated) . " chars, target={$targetLanguage})");
    AiJobQueue::completeTranslation($pdo, $logId, $translated, $result['model']);
}

// --- Helpers ---------------------------------------------------------------

function printQueueStatus(PDO $pdo, OllamaClient $client): void
{
    $depth = AiJobQueue::depth($pdo);
    out(sprintf(
        'Queue: %d queued, %d processing, %d completed, %d failed.',
        $depth['queued'],
        $depth['processing'],
        $depth['completed'],
        $depth['failed']
    ));

    if (!$client->isConfigured()) {
        out('Ollama: not configured (OLLAMA_URL / OLLAMA_MODEL unset).');
        return;
    }
    try {
        $models = $client->listModels();
        $present = $client->isModelAvailable($models) ? 'present' : 'NOT PULLED';
        out("Ollama: reachable, model '{$client->model()}' {$present}.");
    } catch (OllamaUnavailableException) {
        out('Ollama: unreachable. Queued jobs will wait (§2 Rule 15).');
    } catch (OllamaException $e) {
        out('Ollama: responded with an error — ' . $e->getMessage());
    }
}

/**
 * @param string[] $argv
 * @return array{once:bool,daemon:bool,status:bool,recover:bool,max:?int}
 */
function parseArguments(array $argv): array
{
    $options = ['once' => false, 'daemon' => false, 'status' => false, 'recover' => false, 'max' => null];
    foreach (array_slice($argv, 1) as $argument) {
        if ($argument === '--once') {
            $options['once'] = true;
            $options['max'] = 1;
        } elseif ($argument === '--daemon') {
            $options['daemon'] = true;
        } elseif ($argument === '--status') {
            $options['status'] = true;
        } elseif ($argument === '--recover') {
            $options['recover'] = true;
        } elseif (str_starts_with($argument, '--max=')) {
            $options['max'] = max(1, (int) substr($argument, strlen('--max=')));
        }
    }
    return $options;
}

function out(string $message): void
{
    // Identifiers, statuses, timings, character counts. Never content.
    fwrite(STDOUT, $message . PHP_EOL);
}
