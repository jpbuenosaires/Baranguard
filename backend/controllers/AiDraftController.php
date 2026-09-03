<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Ai\AiJobQueue;
use Baranguard\Services\Ai\OllamaClient;
use PDO;

/**
 * AI draft endpoints — Master Reference §6 "AI processing", §5
 * `ai_processing_log`, §7 role matrix ("Trigger/rerun AI redaction" and
 * "Approve AI redaction": Secretary ✓, every other role ✗), §9 W8 AI
 * Redaction Review.
 *
 * Sprint 5 built the queue-facing half:
 *   - `POST /incidents/:id/redact`      — enqueue a redaction pipeline run
 *   - `GET  /incidents/:id/ai-draft`    — read the current draft
 *   - `POST /incidents/:id/ai-draft/translate` — post-approval translation
 *
 * Sprint 6 closes the loop with the review/approval half:
 *   - `POST /incidents/:id/ai-draft/regenerate-summary`
 *   - `POST /incidents/:id/ai-draft/approve`
 *
 * Until `approve()` existed, this pipeline was a dead end: nothing could
 * write `incident.redacted_narrative`, so translation's prerequisite was
 * unsatisfiable, no blotter could be finalized, and §11's post-approval
 * retention clock could never start.
 *
 * NOTHING IN THIS FILE CALLS OLLAMA. Every endpoint here only reads or
 * writes `ai_processing_log`. §2 Rule 15 requires AI jobs to queue when
 * the workstation's services are unavailable, so the request path must
 * never block on — or fail because of — a model that is stopped, missing,
 * or still being pulled. `backend/scripts/ai-worker.php` is what actually
 * runs the model, out of band.
 *
 * Resolved decisions (logged in DEVLOG.md — §6 states the contracts but
 * not these specifics):
 *
 *   - **Unconfigured vs. unavailable are answered differently.** If
 *     `OLLAMA_MODEL`/`OLLAMA_URL` are unset, this deployment has no AI at
 *     all and `POST .../redact` returns `503 SERVICE_UNAVAILABLE` — we
 *     cannot even record which model was *intended*, and `§5
 *     ai_processing_log.model_version` is NOT NULL, so queueing would
 *     mean inventing a model name. If they ARE set but the service is
 *     merely down, the job queues normally — that is exactly the case
 *     Rule 15 exists for.
 *   - **`model_version` at enqueue time is the INTENDED model**; the
 *     worker overwrites it with the model the server reports it actually
 *     ran (Rule 16: "Every AI run records ... model version"). Intent is
 *     the best available answer while a job is still queued.
 *   - **`GET .../ai-draft` also returns `error_code`**, which §6's listed
 *     shape omits. A Secretary looking at `status:"failed"` with no
 *     reason has a dead end, and §9's Loading/Empty/Error/Populated rule
 *     exists precisely to prevent that. Same "necessary field beyond the
 *     literal spec" precedent as `officer_name` on `GET /incidents`.
 *   - **Translation responses carry `language_validated`.** Rule 16:
 *     "Bikol is treated as unvalidated until empirical testing is
 *     completed", and Sprint 5's own prompt says not to let the UI imply
 *     Bikol output is production-quality. A boolean the UI can actually
 *     read is the only way that survives contact with a real screen; a
 *     comment in a doc would not.
 */
final class AiDraftController
{
    /** §6 translate body: `{target_language:"en"|"fil"|"bcl"}`. */
    private const TRANSLATION_LANGUAGES = ['en', 'fil', 'bcl'];

    /**
     * Languages whose output quality has been empirically validated for
     * this deployment. Rule 16 puts Bikol outside this set until an
     * evaluation run says otherwise — do not add `bcl` here without a
     * real `ai_evaluation_run` backing it.
     */
    private const VALIDATED_LANGUAGES = ['en', 'fil'];

    /**
     * POST /incidents/:id/redact — §6: "Secretary manual rerun or trusted
     * system worker → {incident_id,pipeline_run_id,status}. Same-barangay
     * resource check. Creates/replaces the active pipeline only when no
     * finalized blotter exists."
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function redact(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        $incident = self::loadIncident($pdo, $identity, $incidentIdParam);
        $incidentId = (int) $incident['incident_id'];

        // §6: "Creates/replaces the active pipeline only when no finalized
        // blotter exists; rerun after approval requires explicit revision
        // workflow." A finalized blotter is the hard stop — re-running
        // redaction under it would let the draft drift away from the
        // finalized record without the audited amendment path (§2 Rule 24
        // / POST /incidents/:id/blotter/amend).
        $blotterStmt = $pdo->prepare(
            'SELECT blotter_id FROM blotter_record WHERE incident_id = :incident_id AND finalized_at IS NOT NULL LIMIT 1'
        );
        $blotterStmt->execute(['incident_id' => $incidentId]);
        if ($blotterStmt->fetch(PDO::FETCH_ASSOC) !== false) {
            throw new ApiError(409, 'CONFLICT', 'This incident has a finalized blotter record; use the amendment workflow instead.');
        }

        $client = new OllamaClient();
        if (!$client->isConfigured()) {
            // See class doc: unconfigured is a different answer from
            // unavailable. We cannot record an intended model that does
            // not exist.
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'AI processing is not configured on this workstation.');
        }

        $job = AiJobQueue::enqueueRedaction($pdo, $incidentId, $client->model());

        // Rule 17 audit metadata is allow-listed: identifiers/statuses
        // only. Never the narrative, never any draft text.
        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ai_redaction_queued', 'incident', $incidentId, [
            'pipeline_run_id' => $job['pipeline_run_id'],
            'log_id' => $job['log_id'],
        ]);

        Http::send(201, [
            'incident_id' => $incidentId,
            'pipeline_run_id' => $job['pipeline_run_id'],
            'status' => $job['status'],
        ]);
    }

    /**
     * GET /incidents/:id/ai-draft — §6: "Secretary only, same barangay →
     * {log_id,incident_id,pipeline_run_id,task_type,model_version,
     * draft_redacted_narrative,draft_summary,draft_summary_stale,
     * draft_version,status}".
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function draft(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        $incident = self::loadIncident($pdo, $identity, $incidentIdParam);

        $draft = AiJobQueue::currentDraft($pdo, (int) $incident['incident_id']);
        if ($draft === null) {
            throw new ApiError(404, 'NOT_FOUND', 'No AI draft exists for this incident yet.');
        }

        Http::send(200, [
            'log_id' => (int) $draft['log_id'],
            'incident_id' => (int) $draft['incident_id'],
            'pipeline_run_id' => $draft['pipeline_run_id'],
            'task_type' => $draft['task_type'],
            'model_version' => $draft['model_version'],
            'draft_redacted_narrative' => $draft['draft_redacted_narrative'],
            'draft_summary' => $draft['draft_summary'],
            'draft_summary_stale' => (bool) $draft['draft_summary_stale'],
            'draft_version' => (int) $draft['draft_version'],
            'status' => $draft['status'],
            // Beyond §6's listed shape — see class doc.
            'error_code' => $draft['error_code'],
        ]);
    }

    /**
     * POST /incidents/:id/ai-draft/translate — §6: "Secretary only;
     * requires approved redaction. Body {target_language:"en"|"fil"|"bcl"}
     * → {log_id,translated_text,source_language,target_language,status}.
     * Runs locally against approved redacted narrative and creates a new
     * translation log row. Translation never modifies the canonical
     * incident narrative."
     *
     * The prerequisite check is REAL even though nothing can satisfy it
     * yet — `POST /incidents/:id/ai-draft/approve` is Sprint 6's box, so
     * no incident can have `redaction_approved_at` set through the normal
     * path today. That is exactly what Sprint 5's prompt asks for
     * ("Secretary-only gate + prerequisite check must be real even if the
     * translation call itself is stubbed"), and it means this endpoint
     * starts working the moment approval lands, with no change here.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function translate(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        $incident = self::loadIncident($pdo, $identity, $incidentIdParam);
        $incidentId = (int) $incident['incident_id'];

        $body = Http::jsonBody();
        $targetLanguage = $body['target_language'] ?? null;
        if (!is_string($targetLanguage) || !in_array($targetLanguage, self::TRANSLATION_LANGUAGES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'target_language must be one of: ' . implode(', ', self::TRANSLATION_LANGUAGES) . '.');
        }

        // Rule 16: "Translation is a separate post-approval job against
        // the approved redacted text only." No approval, no translation —
        // and the approval signal is `redaction_approved_at IS NOT NULL`
        // (§5's own note on the incident table).
        if ($incident['redaction_approved_at'] === null) {
            throw new ApiError(409, 'CONFLICT', 'This incident has no approved redaction yet; translation runs only on approved text.');
        }

        $client = new OllamaClient();
        if (!$client->isConfigured()) {
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'AI processing is not configured on this workstation.');
        }

        $job = AiJobQueue::enqueueTranslation($pdo, $incidentId, $targetLanguage, $client->model());

        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ai_translation_queued', 'incident', $incidentId, [
            'pipeline_run_id' => $job['pipeline_run_id'],
            'log_id' => $job['log_id'],
            'target_language' => $targetLanguage,
        ]);

        Http::send(201, [
            'log_id' => $job['log_id'],
            // Null until the worker runs it — never a placeholder string
            // that would read as a finished translation.
            'translated_text' => null,
            // No language detection is performed; §5 allows NULL and an
            // invented value would be worse than an honest absence.
            'source_language' => null,
            'target_language' => $targetLanguage,
            'status' => $job['status'],
            // See class doc / Rule 16 — false for Bikol until a real
            // evaluation run says otherwise.
            'language_validated' => in_array($targetLanguage, self::VALIDATED_LANGUAGES, true),
        ]);
    }

    /**
     * POST /incidents/:id/ai-draft/regenerate-summary — §6: "body
     * {draft_redacted_narrative,draft_version} ... Requires matching
     * current version. Generates summary only from supplied draft text;
     * increments draft_version; clears stale flag."
     *
     * Resolved decision (logged in DEVLOG.md): **this queues, it does not
     * generate inline.** §6's response shape reads as though a finished
     * summary comes back, but generating one takes minutes on an 8B CPU
     * model and Sprint 5 made "the API never calls Ollama" structural
     * (Rule 15). So the version check, the Secretary's edited text, and
     * the `draft_version` increment all land synchronously inside one
     * transaction — they are the concurrency control and must be atomic —
     * while the summary itself is regenerated by the worker.
     *
     * `draft_summary_stale` is therefore TRUE from this call until the
     * worker finishes, which is exactly right: the stored summary really
     * does describe superseded text in that window, and §6 makes stale a
     * hard block on approval.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function regenerateSummary(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        $incident = self::loadIncident($pdo, $identity, $incidentIdParam);
        $incidentId = (int) $incident['incident_id'];

        $body = Http::jsonBody();
        $editedNarrative = $body['draft_redacted_narrative'] ?? null;
        $draftVersionRaw = $body['draft_version'] ?? null;

        if (!is_string($editedNarrative) || trim($editedNarrative) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'draft_redacted_narrative is required.');
        }
        if (!is_int($draftVersionRaw) && !(is_string($draftVersionRaw) && ctype_digit($draftVersionRaw))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'draft_version is required.');
        }
        $draftVersion = (int) $draftVersionRaw;

        $client = new OllamaClient();
        if (!$client->isConfigured()) {
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'AI processing is not configured on this workstation.');
        }

        $pdo->beginTransaction();
        try {
            $draft = AiJobQueue::currentDraftForUpdate($pdo, $incidentId);
            if ($draft === null) {
                throw new ApiError(404, 'NOT_FOUND', 'No AI draft exists for this incident yet.');
            }
            // §2 Rule 23: "Approval must identify the exact current
            // version; stale tabs receive 409 and must reload." The same
            // applies to editing — a stale tab must never silently
            // overwrite a newer draft.
            if ((int) $draft['draft_version'] !== $draftVersion) {
                throw new ApiError(409, 'CONFLICT', 'This draft has changed since it was loaded; reload and try again.');
            }
            // Editing a draft the worker is still generating would race it.
            if (!in_array($draft['status'], ['completed', 'failed'], true)) {
                throw new ApiError(409, 'CONFLICT', 'This draft is still being generated; wait for it to finish.');
            }

            $logId = (int) $draft['log_id'];
            $previousSummary = $draft['draft_summary'];
            $newVersion = AiJobQueue::saveEditedDraftForSummary($pdo, $logId, $editedNarrative);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ai_summary_regeneration_queued', 'incident', $incidentId, [
                'log_id' => $logId,
                'draft_version' => $newVersion,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, [
            'log_id' => $logId,
            'draft_redacted_narrative' => $editedNarrative,
            // The PREVIOUS summary, still stored and now explicitly stale
            // — the same thing GET /ai-draft would show. Returning null
            // here would imply the old summary had been discarded.
            'draft_summary' => $previousSummary,
            'draft_summary_stale' => true,
            'draft_version' => $newVersion,
            'status' => 'queued',
        ]);
    }

    /**
     * POST /incidents/:id/ai-draft/approve — §6: "Requires current draft
     * version, status=completed, draft_summary_stale=false, text equality
     * against current draft, and same-barangay Secretary authorization.
     * This is the sole normal endpoint allowed to commit
     * incident.redacted_narrative and approval metadata."
     *
     * §2 Rule 3 makes that exclusivity a hard rule — no import, sync,
     * citizen conversion, SMS handler or other service may write that
     * field. This is that one endpoint, and every check below runs inside
     * a single transaction with both the incident row and the draft row
     * locked (Rule 30), so nothing can change between validation and write.
     *
     * Resolved decision (logged in DEVLOG.md): **a repeat approval with
     * identical text replays idempotently (200) rather than 409-ing.** A
     * Secretary double-clicking Approve, or a retried request, otherwise
     * gets a scary conflict for an operation that already succeeded —
     * same replay-lookup pattern POST /dispatch and POST /incidents
     * already use. A repeat with DIFFERENT text is a real 409: changing an
     * approved redaction is the amendment/revision workflow's job, not
     * this endpoint's.
     *
     * Deliberately NOT done here: deleting `raw_narrative`. §11 gives a
     * 30-day post-approval grace period and that deletion belongs to
     * Sprint 7's retention jobs, not to the approval transaction.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function approve(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        $incidentId = (int) $incidentIdParam;

        $body = Http::jsonBody();
        $approvedNarrative = $body['approved_narrative'] ?? null;
        $draftVersionRaw = $body['draft_version'] ?? null;

        if (!is_string($approvedNarrative) || trim($approvedNarrative) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'approved_narrative is required.');
        }
        if (!is_int($draftVersionRaw) && !(is_string($draftVersionRaw) && ctype_digit($draftVersionRaw))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'draft_version is required.');
        }
        $draftVersion = (int) $draftVersionRaw;

        $pdo->beginTransaction();
        try {
            // Lock the row we are about to write, before authorising
            // against it (Rule 30: never authorise on stale tenant data).
            $incidentStmt = $pdo->prepare(
                'SELECT incident_id, barangay_id, redacted_narrative, redaction_approved_at, redaction_approved_by
                 FROM incident WHERE incident_id = :incident_id FOR UPDATE'
            );
            $incidentStmt->execute(['incident_id' => $incidentId]);
            $incident = $incidentStmt->fetch(PDO::FETCH_ASSOC);
            if ($incident === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);

            // Idempotent replay of an approval that already happened.
            if ($incident['redaction_approved_at'] !== null) {
                if ((string) $incident['redacted_narrative'] === $approvedNarrative) {
                    $replay = [
                        'incident_id' => $incidentId,
                        'redaction_approved_at' => $incident['redaction_approved_at'],
                        'approved_by' => $incident['redaction_approved_by'] !== null
                            ? (int) $incident['redaction_approved_by']
                            : null,
                    ];
                    $pdo->commit();
                    Http::send(200, $replay);
                }
                throw new ApiError(409, 'CONFLICT', 'This incident already has an approved redaction; changing it requires the amendment workflow.');
            }

            $draft = AiJobQueue::currentDraftForUpdate($pdo, $incidentId);
            if ($draft === null) {
                throw new ApiError(404, 'NOT_FOUND', 'No AI draft exists for this incident yet.');
            }
            if ($draft['status'] !== 'completed') {
                throw new ApiError(409, 'CONFLICT', 'The AI draft is not complete; it cannot be approved yet.');
            }
            if ((int) $draft['draft_summary_stale'] === 1) {
                throw new ApiError(409, 'CONFLICT', 'The summary is stale for the current draft; regenerate it before approving.');
            }
            if ((int) $draft['draft_version'] !== $draftVersion) {
                throw new ApiError(409, 'CONFLICT', 'This draft has changed since it was loaded; reload and try again.');
            }
            // §6's "text equality against current draft" — the Secretary
            // approves exactly what they were shown, byte for byte. Any
            // divergence means the tab is out of date or the text was
            // edited without regenerating.
            if ((string) $draft['draft_redacted_narrative'] !== $approvedNarrative) {
                throw new ApiError(409, 'CONFLICT', 'The submitted text does not match the current draft; reload and try again.');
            }

            $updateStmt = $pdo->prepare(
                'UPDATE incident
                    SET redacted_narrative = :narrative,
                        redaction_approved_by = :approved_by,
                        redaction_approved_at = UTC_TIMESTAMP(),
                        updated_at = UTC_TIMESTAMP()
                  WHERE incident_id = :incident_id'
            );
            $updateStmt->execute([
                'narrative' => $approvedNarrative,
                'approved_by' => $identity['user_id'],
                'incident_id' => $incidentId,
            ]);

            $readBack = $pdo->prepare('SELECT redaction_approved_at FROM incident WHERE incident_id = :incident_id');
            $readBack->execute(['incident_id' => $incidentId]);
            $approvedAt = $readBack->fetchColumn();

            // Rule 17 allow-list: identifiers and statuses only. The
            // approved text itself never goes into audit metadata.
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ai_redaction_approved', 'incident', $incidentId, [
                'log_id' => (int) $draft['log_id'],
                'draft_version' => $draftVersion,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, [
            'incident_id' => $incidentId,
            'redaction_approved_at' => $approvedAt,
            'approved_by' => $identity['user_id'],
        ]);
    }

    /**
     * Shared lookup + tenant check for all three endpoints.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @return array<string,mixed>
     */
    private static function loadIncident(PDO $pdo, array $identity, string $incidentIdParam): array
    {
        if (!ctype_digit($incidentIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }

        $stmt = $pdo->prepare(
            'SELECT incident_id, barangay_id, redaction_approved_at FROM incident WHERE incident_id = :incident_id'
        );
        $stmt->execute(['incident_id' => (int) $incidentIdParam]);
        $incident = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($incident === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
        }
        // §2 Rule 6/30: tenant authorization before any disclosure or
        // mutation, never after.
        AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);

        return $incident;
    }
}
