<?php
declare(strict_types=1);

/**
 * Route table for the AI processing endpoints (§6 "AI processing").
 *
 * Sprint 5 built the queue-facing three (redact / ai-draft / translate);
 * Sprint 6 adds the review-and-approve pair that closes the pipeline.
 *
 * `approve` is the single endpoint permitted to commit
 * `incident.redacted_narrative` (§2 Rule 3) — treat any future change to
 * its route or authorization as a security change, not a routing tweak.
 */

use Baranguard\Controllers\AiDraftController;

return [
    ['POST', '#^/incidents/(\d+)/redact$#', [AiDraftController::class, 'redact'], true],
    ['GET', '#^/incidents/(\d+)/ai-draft$#', [AiDraftController::class, 'draft'], true],
    ['POST', '#^/incidents/(\d+)/ai-draft/regenerate-summary$#', [AiDraftController::class, 'regenerateSummary'], true],
    ['POST', '#^/incidents/(\d+)/ai-draft/approve$#', [AiDraftController::class, 'approve'], true],
    ['POST', '#^/incidents/(\d+)/ai-draft/translate$#', [AiDraftController::class, 'translate'], true],
];
