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
 *   php scripts/ai-worker.php --daemon      keep polling forever (Ctrl-C to
 *                                          stop) — including through a
 *                                          stretch where Ollama is down or
 *                                          crash-looping, which is
 *                                          requeue-and-wait here, never
 *                                          exit; a one-shot/--max/--once
 *                                          run still stops on that, since
 *                                          it isn't meant to sit and wait
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
    $taskType = (string) $job['task_type'];
    // Nullable since migration 0015 — the two non-incident AI Tools jobs
    // carry a barangay instead.
    $incidentLabel = $job['incident_id'] === null ? '—' : (string) (int) $job['incident_id'];
    $startedAt = microtime(true);
    $pairedExtraRow = false;
    out("[job {$logId}] claimed — task={$taskType} incident={$incidentLabel}");

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
            // A fresh redaction enqueue always has a same-pipeline_run_id
            // extraction sibling (AiDraftController::redact() enqueues both
            // together) — try to claim it too and run one combined model
            // call. No sibling claimable (legacy row, lost the claim race
            // to another worker, or a standalone enqueue) falls back to
            // today's separate call.
            $extractionJob = AiJobQueue::claimSiblingJob($pdo, (string) $job['pipeline_run_id'], 'extraction');
            if ($extractionJob !== null) {
                runRedactionAndExtractionJob($pdo, $client, $job, $extractionJob);
                $pairedExtraRow = true;
            } else {
                runRedactionJob($pdo, $client, $job);
            }
        }
        $elapsed = round(microtime(true) - $startedAt, 1);
        out("[job {$logId}] completed in {$elapsed}s");
        $processed++;
        // A combined run drained two queued rows (redaction + its
        // extraction sibling) in this one claim cycle — count both so
        // --max/--once mean "rows drained", not "claim cycles run".
        if ($pairedExtraRow) {
            $processed++;
        }
    } catch (OllamaUnavailableException $e) {
        // Rule 15: the service wasn't reachable — the job is fine, the
        // workstation wasn't. Put it back exactly as it was.
        AiJobQueue::requeue($pdo, $logId);
        if ($options['daemon']) {
            // "Daemon mode" has to actually mean "keeps running" — including
            // through a stretch where Ollama is down or crash-looping (this
            // workstation's GPU backend does exactly that intermittently,
            // even after OllamaClient's own retries are exhausted; see
            // DEVLOG 2026-09-26). Breaking here would silently end the one
            // process this system relies on to drain the queue at all,
            // needing a human to notice and restart it — exactly the
            // "why is nothing happening" failure mode this is meant to
            // prevent. Wait longer than the normal empty-queue poll (5s)
            // since hammering a down service is still wasteful, then go
            // back to polling.
            out("[job {$logId}] Ollama unavailable — job requeued, waiting to retry.");
            out('  ' . $e->getMessage());
            sleep(15);
            continue;
        }
        // A one-shot/--max/--once run isn't meant to sit and wait — stop
        // this invocation, leaving the job queued for the next one.
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
 * Combined path: one model call does both TASK 1 (redact) and TASK 2
 * (extract) from `AiPrompts::redactionAndExtraction()`, then the summary
 * step still runs separately from the resulting draft — unchanged from
 * `runRedactionJob()`, since summary must derive from the redaction
 * output, not something a single upfront call can produce ahead of time.
 *
 * Owns failure handling for BOTH rows: an error here must not leave the
 * extraction sibling stuck in 'processing' forever just because the
 * caller's try/catch only knows about the redaction job's log id.
 * `OllamaUnavailableException`/`OllamaException` are rethrown after
 * marking the sibling, so the caller's existing per-exception handling
 * (requeue-and-stop vs. fail) still applies to the redaction row exactly
 * as it does for every other task type.
 *
 * @param array<string,mixed> $job the redaction row
 * @param array<string,mixed> $extractionJob its claimed sibling
 */
function runRedactionAndExtractionJob(PDO $pdo, OllamaClient $client, array $job, array $extractionJob): void
{
    $logId = (int) $job['log_id'];
    $extractionLogId = (int) $extractionJob['log_id'];
    $incidentId = (int) $job['incident_id'];

    $raw = AiJobQueue::rawNarrativeFor($pdo, $incidentId);
    if ($raw === null || trim($raw) === '') {
        AiJobQueue::fail($pdo, $logId, 'INCIDENT_MISSING_RAW');
        AiJobQueue::fail($pdo, $extractionLogId, 'INCIDENT_MISSING_RAW');
        out("[job {$logId}] FAILED — incident {$incidentId} has no raw narrative.");
        return;
    }

    try {
        $combinedResult = $client->generate(AiPrompts::redactionAndExtraction($raw));
    } catch (OllamaUnavailableException $e) {
        AiJobQueue::requeue($pdo, $extractionLogId);
        throw $e;
    } catch (OllamaException $e) {
        AiJobQueue::fail($pdo, $extractionLogId, 'OLLAMA_ERROR');
        throw $e;
    }

    $text = AiPrompts::stripReasoning($combinedResult['text']);
    [$draftRedacted, $entitiesText] = splitCombinedOutput($text);

    if ($draftRedacted === '') {
        AiJobQueue::fail($pdo, $logId, 'REDACTION_EMPTY_AFTER_STRIP');
        AiJobQueue::fail($pdo, $extractionLogId, 'REDACTION_EMPTY_AFTER_STRIP');
        out("[job {$logId}] FAILED — empty redaction after stripping reasoning output.");
        return;
    }
    out("[job {$logId}] redaction draft produced (" . mb_strlen($draftRedacted) . ' chars)');

    if ($entitiesText === null) {
        // The redaction half parsed fine but the ===ENTITIES=== marker
        // never showed up — a malformed response, not "nothing found"
        // (parseExtractionLines() already handles that valid case for a
        // properly-formatted response with blank lines). Failing here is
        // honest; completing with fabricated-looking blank fields would
        // read as "the model checked and found no complainant", which is
        // not what happened.
        AiJobQueue::fail($pdo, $extractionLogId, 'EXTRACTION_MALFORMED_OUTPUT');
        out("[job {$extractionLogId}] FAILED — could not locate ===ENTITIES=== section in combined output.");
    } else {
        [$complainant, $respondent, $contact] = parseExtractionLines($entitiesText);
        out("[job {$extractionLogId}] extraction produced (complainant=" . ($complainant !== null ? 'yes' : 'no')
            . ', respondent=' . ($respondent !== null ? 'yes' : 'no')
            . ', contact=' . ($contact !== null ? 'yes' : 'no') . ')');
        AiJobQueue::completeExtraction($pdo, $extractionLogId, $complainant, $respondent, $contact, $combinedResult['model']);
    }

    // Step 2: summary DERIVED FROM THE DRAFT (Rule 16 — never from $raw).
    // Identical to runRedactionJob()'s own step 2.
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
        $combinedResult['model']
    );
}

/**
 * Splits `AiPrompts::redactionAndExtraction()`'s combined output on its
 * literal `===REDACTED===`/`===ENTITIES===` markers. Returns `[text,
 * null]` for the entities half if `===ENTITIES===` never appears at
 * all — the caller treats that as a malformed response, distinct from
 * `parseExtractionLines()` legitimately finding blank fields in a
 * properly-formatted one.
 *
 * @return array{0:string,1:?string} [redactedNarrative, entitiesTextOrNull]
 */
function splitCombinedOutput(string $text): array
{
    $entitiesMarker = '===ENTITIES===';
    $redactedMarker = '===REDACTED===';

    $entitiesPos = mb_strpos($text, $entitiesMarker);
    if ($entitiesPos === false) {
        return [trim(str_ireplace($redactedMarker, '', $text)), null];
    }

    $redactedPart = str_ireplace($redactedMarker, '', mb_substr($text, 0, $entitiesPos));
    $entitiesPart = mb_substr($text, $entitiesPos + mb_strlen($entitiesMarker));

    return [trim($redactedPart), trim($entitiesPart)];
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

// The AI Tools screen (migration 0015; narrowed to the Incident
// Classifier by migration 0027, then removed entirely by migration 0028
// after a real runaway-generation failure — the model blew past the
// 4096-token context window and hit the 300s timeout — showed
// classification wasn't reliable enough to keep on this workstation) had
// its runners here. None remain.

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
