<?php
declare(strict_types=1);

namespace Baranguard\Services\Ai;

use PDO;

/**
 * AiJobQueue — the AI job queue, which IS the `ai_processing_log` table
 * (§5), not a separate queueing system bolted beside it.
 *
 * That's deliberate and worth stating, because "add a job queue" usually
 * means "add Redis/Beanstalk/a jobs table". §5 already gives
 * `ai_processing_log` a `status` ENUM of exactly
 * `queued|processing|completed|failed|superseded` — that is a queue's
 * state machine, already designed, already migrated in Sprint 0. Adding a
 * second store beside it would mean two sources of truth for "what is the
 * current draft", and §5's own invariant ("one current redaction/summary
 * pipeline row is enforced transactionally per incident") would then be
 * enforceable in neither.
 *
 * §2 Rule 15's requirement — "AI jobs queue. No external AI fallback
 * exists." — is satisfied structurally: `POST /incidents/:id/redact` only
 * ever INSERTs a `queued` row and returns; nothing in the request path
 * calls Ollama at all. A workstation with Ollama stopped, uninstalled, or
 * still pulling the model accepts redaction requests exactly the same way
 * and drains them whenever the worker next runs
 * (`backend/scripts/ai-worker.php`).
 *
 * CLAIMING IS MariaDB-10.4-SAFE. The usual `SELECT ... FOR UPDATE SKIP
 * LOCKED` worker pattern is MariaDB 10.6+/MySQL 8+ only, and §1 pins this
 * deployment to MariaDB 10.4 via XAMPP — this codebase has already been
 * bitten once by assuming a newer engine feature (the `CHECK` constraint
 * trap in Sprint 0's own DEVLOG entry). So claiming uses a conditional
 * compare-and-set UPDATE instead (`SET status='processing' WHERE
 * log_id=? AND status='queued'`) and treats `rowCount()===1` as "this
 * worker won the row". That is atomic on any engine and needs no
 * lock hints at all.
 */
final class AiJobQueue
{
    /**
     * Creates a new redaction pipeline run for an incident, superseding
     * whatever draft was previously current.
     *
     * §5: "one current redaction/summary pipeline row is enforced
     * transactionally per incident" — that's the lock + bulk supersede +
     * insert below, all inside one transaction.
     *
     * A rerun starts at `draft_version = 1` (the schema default) rather
     * than continuing the superseded row's numbering: Rule 23 ties the
     * version to "every ACTIVE draft", and approval matches against the
     * current draft's version, so a fresh pipeline run is a fresh draft.
     * Continuing the old numbering would imply the new draft is a
     * revision of text it never saw.
     *
     * @return array{log_id:int,pipeline_run_id:string,status:string}
     */
    public static function enqueueRedaction(PDO $pdo, int $incidentId, string $modelVersion): array
    {
        $pipelineRunId = self::uuid();

        $pdo->beginTransaction();
        try {
            $lockStmt = $pdo->prepare(
                "SELECT log_id FROM ai_processing_log
                 WHERE incident_id = :incident_id
                   AND task_type IN ('redaction','summarization')
                   AND status <> 'superseded'
                 FOR UPDATE"
            );
            $lockStmt->execute(['incident_id' => $incidentId]);

            $supersedeStmt = $pdo->prepare(
                "UPDATE ai_processing_log SET status = 'superseded'
                 WHERE incident_id = :incident_id
                   AND task_type IN ('redaction','summarization')
                   AND status <> 'superseded'"
            );
            $supersedeStmt->execute(['incident_id' => $incidentId]);

            $insertStmt = $pdo->prepare(
                "INSERT INTO ai_processing_log
                    (incident_id, pipeline_run_id, task_type, model_version, status, draft_version, created_at)
                 VALUES
                    (:incident_id, :pipeline_run_id, 'redaction', :model_version, 'queued', 1, UTC_TIMESTAMP())"
            );
            $insertStmt->execute([
                'incident_id' => $incidentId,
                'pipeline_run_id' => $pipelineRunId,
                'model_version' => $modelVersion,
            ]);
            $logId = (int) $pdo->lastInsertId();

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        return ['log_id' => $logId, 'pipeline_run_id' => $pipelineRunId, 'status' => 'queued'];
    }

    /**
     * Queues a translation job. §5: "translation rows are independent" —
     * so this neither supersedes nor is superseded by the redaction
     * pipeline, and an incident may accumulate several (one per target
     * language, or several attempts at one).
     *
     * @return array{log_id:int,pipeline_run_id:string,status:string}
     */
    public static function enqueueTranslation(
        PDO $pdo,
        int $incidentId,
        string $targetLanguage,
        string $modelVersion
    ): array {
        $pipelineRunId = self::uuid();

        $stmt = $pdo->prepare(
            "INSERT INTO ai_processing_log
                (incident_id, pipeline_run_id, task_type, model_version, target_language, status, created_at)
             VALUES
                (:incident_id, :pipeline_run_id, 'translation', :model_version, :target_language, 'queued', UTC_TIMESTAMP())"
        );
        $stmt->execute([
            'incident_id' => $incidentId,
            'pipeline_run_id' => $pipelineRunId,
            'model_version' => $modelVersion,
            'target_language' => $targetLanguage,
        ]);

        return ['log_id' => (int) $pdo->lastInsertId(), 'pipeline_run_id' => $pipelineRunId, 'status' => 'queued'];
    }

    /**
     * The incident's CURRENT redaction/summary draft — the one
     * `GET /incidents/:id/ai-draft` returns and the one approval must
     * match. Superseded rows are excluded by definition.
     *
     * @return array<string,mixed>|null
     */
    public static function currentDraft(PDO $pdo, int $incidentId): ?array
    {
        $stmt = $pdo->prepare(
            "SELECT log_id, incident_id, pipeline_run_id, task_type, model_version, source_language, target_language,
                    draft_redacted_narrative, draft_summary, draft_summary_stale, draft_version, status, error_code,
                    processed_at, created_at
             FROM ai_processing_log
             WHERE incident_id = :incident_id
               AND task_type IN ('redaction','summarization')
               AND status <> 'superseded'
             ORDER BY created_at DESC, log_id DESC
             LIMIT 1"
        );
        $stmt->execute(['incident_id' => $incidentId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /**
     * Same as currentDraft() but locks the row for a read-modify-write
     * (regenerate-summary, approve). §2 Rule 30: "Read-modify-write
     * operations that affect ... AI drafts ... use row locking/optimistic
     * concurrency as appropriate" — this is the locking half; the
     * `draft_version` equality check is the optimistic half.
     *
     * MUST be called inside an open transaction.
     *
     * @return array<string,mixed>|null
     */
    public static function currentDraftForUpdate(PDO $pdo, int $incidentId): ?array
    {
        $stmt = $pdo->prepare(
            "SELECT log_id, incident_id, pipeline_run_id, model_version,
                    draft_redacted_narrative, draft_summary, draft_summary_stale, draft_version, status
             FROM ai_processing_log
             WHERE incident_id = :incident_id
               AND task_type IN ('redaction','summarization')
               AND status <> 'superseded'
             ORDER BY created_at DESC, log_id DESC
             LIMIT 1
             FOR UPDATE"
        );
        $stmt->execute(['incident_id' => $incidentId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /**
     * Claims the oldest queued job for this worker, or null when the
     * queue is empty.
     *
     * See the class doc for why this is a compare-and-set UPDATE rather
     * than `SELECT ... FOR UPDATE SKIP LOCKED` (MariaDB 10.4 has no SKIP
     * LOCKED). Oldest-first by `created_at`, with `log_id` as a
     * deterministic tie-break — this codebase has already been bitten
     * once by an untie-broken `ORDER BY created_at` returning rows
     * nondeterministically (see the W3/W4 DEVLOG entry).
     *
     * @return array<string,mixed>|null
     */
    public static function claimNextQueuedJob(PDO $pdo): ?array
    {
        // Bounded: each iteration means another worker beat us to a row.
        for ($attempt = 0; $attempt < 20; $attempt++) {
            $candidateStmt = $pdo->query(
                "SELECT log_id FROM ai_processing_log
                 WHERE status = 'queued'
                 ORDER BY created_at ASC, log_id ASC
                 LIMIT 1"
            );
            $logId = $candidateStmt === false ? false : $candidateStmt->fetchColumn();
            if ($logId === false || $logId === null) {
                return null;
            }

            $claimStmt = $pdo->prepare(
                "UPDATE ai_processing_log SET status = 'processing'
                 WHERE log_id = :log_id AND status = 'queued'"
            );
            $claimStmt->execute(['log_id' => (int) $logId]);
            if ($claimStmt->rowCount() !== 1) {
                continue; // Lost the race — try the next candidate.
            }

            $rowStmt = $pdo->prepare(
                'SELECT log_id, incident_id, pipeline_run_id, task_type, model_version, target_language,
                        draft_redacted_narrative, draft_version, status, created_at
                 FROM ai_processing_log WHERE log_id = :log_id'
            );
            $rowStmt->execute(['log_id' => (int) $logId]);
            $row = $rowStmt->fetch(PDO::FETCH_ASSOC);
            return $row === false ? null : $row;
        }

        return null;
    }

    /**
     * Reads an incident's raw narrative for the redaction step.
     *
     * DELIBERATELY ITS OWN NAMED METHOD so that every read of
     * `raw_narrative` for AI purposes is greppable in one place. §2 Rule 1
     * allows exactly this use ("may be processed only by the local
     * SLM/redaction service") and nothing else — the return value must go
     * straight into `AiPrompts::redaction()` and must never be logged,
     * echoed, or returned in an API response.
     */
    public static function rawNarrativeFor(PDO $pdo, int $incidentId): ?string
    {
        $stmt = $pdo->prepare('SELECT raw_narrative FROM incident WHERE incident_id = :incident_id');
        $stmt->execute(['incident_id' => $incidentId]);
        $value = $stmt->fetchColumn();
        return $value === false || $value === null ? null : (string) $value;
    }

    /**
     * Records a finished redaction run.
     *
     * `$summaryStale === true` is the "redaction succeeded but the SUMMARY
     * step failed" case (e.g. Ollama died between the two calls). The job
     * is still `completed` — the draft narrative is real work worth
     * keeping and showing — but `draft_summary_stale` blocks approval
     * (§6: approval "requires ... draft_summary_stale=false") until the
     * Secretary runs regenerate-summary. Failing the whole job instead
     * would throw away a good redaction because the second call timed out.
     */
    public static function completeRedaction(
        PDO $pdo,
        int $logId,
        string $draftRedactedNarrative,
        ?string $draftSummary,
        bool $summaryStale,
        string $actualModelVersion
    ): void {
        $stmt = $pdo->prepare(
            "UPDATE ai_processing_log
                SET draft_redacted_narrative = :narrative,
                    draft_summary = :summary,
                    draft_summary_stale = :stale,
                    model_version = :model_version,
                    status = 'completed',
                    error_code = NULL,
                    processed_at = UTC_TIMESTAMP()
              WHERE log_id = :log_id"
        );
        $stmt->execute([
            'narrative' => $draftRedactedNarrative,
            'summary' => $draftSummary,
            'stale' => $summaryStale ? 1 : 0,
            // Rule 16: record the model version the run ACTUALLY used, as
            // reported by the server, not merely the one requested.
            'model_version' => $actualModelVersion,
            'log_id' => $logId,
        ]);
    }

    /**
     * Stores the Secretary's edited draft narrative and re-queues the row
     * for a SUMMARY-ONLY regeneration — `POST .../regenerate-summary`.
     *
     * §6: "Generates summary only from supplied draft text; increments
     * draft_version; clears stale flag." The version increment and the
     * stale flag are set HERE (synchronously, inside the caller's
     * version-checked transaction, because they are the concurrency
     * control); the flag is *cleared* later by completeSummary() once the
     * new summary actually exists. Between the two, `draft_summary_stale`
     * is true — which is correct, not a gap: the stored summary really
     * does describe superseded text, and §6 makes that a hard block on
     * approval for exactly that window.
     *
     * `status` goes back to 'queued' so the worker picks it up. The worker
     * distinguishes this from a fresh redaction by the presence of
     * `draft_redacted_narrative` — a summary-only run therefore never
     * touches `raw_narrative` at all (Rule 16).
     */
    public static function saveEditedDraftForSummary(PDO $pdo, int $logId, string $editedNarrative): int
    {
        $stmt = $pdo->prepare(
            "UPDATE ai_processing_log
                SET draft_redacted_narrative = :narrative,
                    draft_version = draft_version + 1,
                    draft_summary_stale = 1,
                    status = 'queued',
                    error_code = NULL,
                    processed_at = NULL
              WHERE log_id = :log_id"
        );
        $stmt->execute(['narrative' => $editedNarrative, 'log_id' => $logId]);

        $readBack = $pdo->prepare('SELECT draft_version FROM ai_processing_log WHERE log_id = :log_id');
        $readBack->execute(['log_id' => $logId]);
        return (int) $readBack->fetchColumn();
    }

    /**
     * Records a completed summary-only regeneration: the new summary
     * lands and `draft_summary_stale` is finally cleared, which is what
     * unblocks approval (§6).
     */
    public static function completeSummary(
        PDO $pdo,
        int $logId,
        string $draftSummary,
        string $actualModelVersion
    ): void {
        $stmt = $pdo->prepare(
            "UPDATE ai_processing_log
                SET draft_summary = :summary,
                    draft_summary_stale = 0,
                    model_version = :model_version,
                    status = 'completed',
                    error_code = NULL,
                    processed_at = UTC_TIMESTAMP()
              WHERE log_id = :log_id"
        );
        $stmt->execute([
            'summary' => $draftSummary,
            'model_version' => $actualModelVersion,
            'log_id' => $logId,
        ]);
    }

    public static function completeTranslation(
        PDO $pdo,
        int $logId,
        string $translatedText,
        string $actualModelVersion
    ): void {
        $stmt = $pdo->prepare(
            "UPDATE ai_processing_log
                SET translated_text = :translated_text,
                    model_version = :model_version,
                    status = 'completed',
                    error_code = NULL,
                    processed_at = UTC_TIMESTAMP()
              WHERE log_id = :log_id"
        );
        $stmt->execute([
            'translated_text' => $translatedText,
            'model_version' => $actualModelVersion,
            'log_id' => $logId,
        ]);
    }

    /** Terminal failure — the service answered but the job cannot succeed as-is. */
    public static function fail(PDO $pdo, int $logId, string $errorCode): void
    {
        $stmt = $pdo->prepare(
            "UPDATE ai_processing_log
                SET status = 'failed', error_code = :error_code, processed_at = UTC_TIMESTAMP()
              WHERE log_id = :log_id"
        );
        $stmt->execute(['error_code' => mb_substr($errorCode, 0, 128), 'log_id' => $logId]);
    }

    /**
     * Puts a claimed job back on the queue untouched — the Ollama-was-
     * unreachable path, per Rule 15. Explicitly NOT `fail()`: nothing is
     * wrong with the job, the workstation just wasn't ready, and the whole
     * point of the queue is that it survives that.
     */
    public static function requeue(PDO $pdo, int $logId): void
    {
        $stmt = $pdo->prepare(
            "UPDATE ai_processing_log SET status = 'queued' WHERE log_id = :log_id AND status = 'processing'"
        );
        $stmt->execute(['log_id' => $logId]);
    }

    /**
     * Re-queues jobs stuck in `processing` — the crash-recovery path. A
     * worker killed mid-job (Ctrl-C, power loss, XAMPP restart) leaves its
     * claimed row in `processing` with nothing left to finish it; without
     * this, that job would never run again.
     *
     * KNOWN LIMITATION, stated rather than hidden: §5's
     * `ai_processing_log` has no `claimed_at` column, so "stuck" is
     * approximated from `created_at` — how long ago the job was ENQUEUED,
     * not how long it has been running. With a single worker (this
     * deployment: one model on one workstation, §1) that is exact enough,
     * because the only row in `processing` at startup is by definition an
     * abandoned one. With TWO workers running concurrently it is not: one
     * could reclaim a job the other is legitimately still running, and
     * both would then write the same row. If a second worker is ever
     * introduced, add a `claimed_at` column in a new migration and key
     * this off that — do not just widen the interval.
     *
     * @return int number of jobs recovered
     */
    public static function requeueStaleProcessing(PDO $pdo, int $olderThanMinutes = 30): int
    {
        $stmt = $pdo->prepare(
            "UPDATE ai_processing_log
                SET status = 'queued'
              WHERE status = 'processing'
                AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :minutes MINUTE)"
        );
        $stmt->bindValue(':minutes', $olderThanMinutes, PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->rowCount();
    }

    /** @return array{queued:int,processing:int,completed:int,failed:int} */
    public static function depth(PDO $pdo): array
    {
        $counts = ['queued' => 0, 'processing' => 0, 'completed' => 0, 'failed' => 0];
        $stmt = $pdo->query(
            "SELECT status, COUNT(*) AS n FROM ai_processing_log
             WHERE status IN ('queued','processing','completed','failed')
             GROUP BY status"
        );
        foreach (($stmt === false ? [] : $stmt->fetchAll(PDO::FETCH_ASSOC)) as $row) {
            $counts[$row['status']] = (int) $row['n'];
        }
        return $counts;
    }

    private static function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
