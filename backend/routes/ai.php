<?php
declare(strict_types=1);

/**
 * Route table for the AI processing endpoints (§6 "AI processing").
 *
 * Sprint 5 builds the queue-facing three. `regenerate-summary` and
 * `approve` are Sprint 6's own box and are deliberately absent — a route
 * registered here with no controller behind it would 500 rather than 404,
 * which is a worse answer than "not built yet".
 */

use Baranguard\Controllers\AiDraftController;

return [
    ['POST', '#^/incidents/(\d+)/redact$#', [AiDraftController::class, 'redact'], true],
    ['GET', '#^/incidents/(\d+)/ai-draft$#', [AiDraftController::class, 'draft'], true],
    ['POST', '#^/incidents/(\d+)/ai-draft/translate$#', [AiDraftController::class, 'translate'], true],
];
