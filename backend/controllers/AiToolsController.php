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
 * AI Tools — the four assistants on the AI Tools screen (migration 0015).
 *
 * These are DRAFTING AIDS. Nothing here writes to `incident`,
 * `blotter_record`, or `sms_log`; every endpoint enqueues a job whose
 * output a human reads and then chooses to act on by hand. §2 Rule 4
 * keeps `ai-draft/approve` the only writer of `redacted_narrative`, and
 * nothing in this file goes near it.
 *
 * NOTHING HERE CALLS OLLAMA — same structural rule AiDraftController
 * already follows (§2 Rule 5). These endpoints only INSERT a `queued` row;
 * `backend/scripts/ai-worker.php` is the only process that talks to the
 * model.
 *
 * WHY THE FOUR ROLE GATES DIFFER — each follows the data, not a hierarchy:
 *
 *   - **Blotter Assistant, Secretary only.** It reads `raw_narrative`,
 *     and §2 Rule 1 makes the Secretary its only reader. Its output is a
 *     draft to re-key into DILG BIMSS/KPIS, which is the mandated
 *     Katarungang Pambarangay ledger — Baranguard complements that system
 *     rather than replacing it, which is also why the walk-in blotter
 *     endpoint was removed in the same change.
 *
 *   - **Classifier, Admin + Secretary.** It reads only the APPROVED
 *     redacted narrative, which is exactly what makes it safe for an
 *     Admin to see. The prerequisite is enforced twice: refused here if
 *     no approval exists, and rechecked by the worker at write time
 *     (§2 Rule 30) since approval can be revoked while a job waits.
 *
 *   - **SMS Composer, Admin only.** Matches `/sms/send`'s own gate, since
 *     drafting a message the caller could not then send would be a
 *     control that does nothing (§2 Rule 6). Its input is operator-typed
 *     text and NOTHING ELSE — there is deliberately no incident parameter,
 *     because the output is bound for an external gateway and Rule 1 does
 *     not permit narrative text to leave that way.
 *
 *   - **Threat Analyzer, Admin + Punong Barangay.** Aggregate counts only,
 *     which is oversight-shaped work, and PB is the oversight role.
 *
 * Cross-tenant is 404, never 403 (§2 Rule 2) — `AuthMiddleware::
 * requireTenant()` and `jobFor()` below are the two places that holds.
 */
final class AiToolsController
{
    /** Longest operator prompt the SMS Composer accepts. */
    private const MAX_TOOL_INPUT = 2000;

    /** `POST /incidents/:id/ai-tools/blotter-assist` — Secretary only. */
    public static function blotterAssist(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['secretary']);
        $incident = self::loadIncident($pdo, $identity, $incidentIdParam);

        self::enqueue($pdo, $identity, 'blotter_assist', (int) $incident['incident_id'], null);
    }

    /** `POST /incidents/:id/ai-tools/classify` — Admin + Secretary. */
    public static function classify(PDO $pdo, array $identity, string $incidentIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        $incident = self::loadIncident($pdo, $identity, $incidentIdParam);

        // Refused rather than queued: an Admin may read this output, so a
        // job with no approved redaction to read could only either fail
        // later or reach for raw text. Say so now.
        if ($incident['redaction_approved_at'] === null) {
            throw new ApiError(
                409,
                'CONFLICT',
                'This incident has no approved redaction yet. The classifier reads the redacted narrative, not the original.'
            );
        }

        self::enqueue($pdo, $identity, 'classification', (int) $incident['incident_id'], null);
    }

    /** `POST /ai-tools/sms-compose` — Admin only. Body `{prompt}`. */
    public static function smsCompose(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $body = Http::jsonBody();
        $prompt = $body['prompt'] ?? null;
        if (!is_string($prompt) || trim($prompt) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'prompt is required.');
        }
        if (mb_strlen($prompt) > self::MAX_TOOL_INPUT) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'prompt must be at most ' . self::MAX_TOOL_INPUT . ' characters.');
        }

        self::enqueue($pdo, $identity, 'sms_compose', null, trim($prompt));
    }

    /** `POST /ai-tools/threat-analysis` — Admin + Punong Barangay. */
    public static function threatAnalysis(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);

        // No body: the window is a worker-side constant and the scope is
        // always the caller's own barangay, resolved from the session.
        // Neither is client-supplied, so neither can be widened by one.
        self::enqueue($pdo, $identity, 'threat_analysis', null, null);
    }

    /**
     * `GET /ai-tools/jobs/:id` — poll one job.
     *
     * The AI pipeline is asynchronous by design (§2 Rule 5), so every
     * enqueue above answers `queued` and the screen polls this.
     */
    public static function job(PDO $pdo, array $identity, string $logIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);

        if (!ctype_digit($logIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Job not found.');
        }
        $job = AiJobQueue::toolJobById($pdo, (int) $logIdParam);
        if ($job === null) {
            throw new ApiError(404, 'NOT_FOUND', 'Job not found.');
        }

        // Tenant check off the job's OWN barangay_id — that column exists
        // precisely so a NULL-incident job is still scopeable (0015).
        AuthMiddleware::requireTenant($identity, (int) $job['barangay_id']);

        // A Secretary's Blotter Assistant draft is written from raw
        // narrative; an Admin polling that job id would read text Rule 1
        // reserves to the Secretary. Ownership, not just tenancy.
        if ((int) $job['requested_by_user_id'] !== (int) $identity['user_id']) {
            throw new ApiError(404, 'NOT_FOUND', 'Job not found.');
        }

        Http::send(200, [
            'job_id' => (int) $job['log_id'],
            'task_type' => $job['task_type'],
            'incident_id' => $job['incident_id'] !== null ? (int) $job['incident_id'] : null,
            'status' => $job['status'],
            'output' => $job['tool_output'],
            'error_code' => $job['error_code'],
            'model_version' => $job['model_version'],
            'created_at' => $job['created_at'],
            'processed_at' => $job['processed_at'],
        ]);
    }

    /**
     * `GET /ai-tools/availability` — is there a working model behind these
     * tools right now?
     *
     * EXISTS BECAUSE §2 RULE 6 FORBIDS A CONTROL THAT LOOKS FUNCTIONAL AND
     * DOES NOTHING. Without this the screen would offer four Generate
     * buttons that enqueue jobs no worker can finish, and the operator
     * would learn that only by watching a job sit at `queued` forever.
     *
     * `GET /system/health` already answers this, but it is Admin-only and
     * this screen serves Secretary and Punong Barangay as well — so the
     * probe itself is reused (`SystemHealthController::ollamaStatus()`)
     * rather than reimplemented. Returns the same coarse three states and
     * nothing else: no URL, no model name, no error text.
     *
     * `unhealthy` is NOT an error response. The honest answer to "can I use
     * this right now" is data, so it is a 200 the screen renders as a
     * banner.
     */
    public static function availability(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay']);

        Http::send(200, ['ollama' => SystemHealthController::ollamaStatus()]);
    }

    /**
     * The shared tail of all four enqueue endpoints.
     *
     * `503` when Ollama is unconfigured, matching
     * `AiDraftController::redact()`: `ai_processing_log.model_version` is
     * NOT NULL, so queueing without a configured model would mean
     * inventing a model name. A configured-but-DOWN service still queues
     * normally — that is the whole point of the queue.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    private static function enqueue(
        PDO $pdo,
        array $identity,
        string $taskType,
        ?int $incidentId,
        ?string $toolInput
    ): void {
        $client = new OllamaClient();
        if (!$client->isConfigured()) {
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'No AI model is configured for this deployment.');
        }

        $job = AiJobQueue::enqueueToolJob(
            $pdo,
            $taskType,
            $incidentId,
            (int) $identity['barangay_id'],
            (int) $identity['user_id'],
            $toolInput,
            $client->model()
        );

        // Rule 8: identifiers and statuses only. The operator's prompt and
        // the model's output are both content and neither is recorded here.
        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'ai_tool_queued', 'ai_processing_log', $job['log_id'], [
            'task_type' => $taskType,
            'incident_id' => $incidentId,
            'pipeline_run_id' => $job['pipeline_run_id'],
        ]);

        Http::send(201, [
            'job_id' => $job['log_id'],
            'task_type' => $taskType,
            'status' => $job['status'],
        ]);
    }

    /**
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
        AuthMiddleware::requireTenant($identity, (int) $incident['barangay_id']);

        return $incident;
    }
}
