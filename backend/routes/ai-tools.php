<?php
declare(strict_types=1);

/**
 * Route table for the AI Tools screen's four assistants (migration 0015).
 *
 * Structurally separate from `routes/ai.php`, which carries the redaction
 * PIPELINE — the ordered raw → draft → summary → approve sequence that
 * §2 Rule 4 governs and that ends by committing
 * `incident.redacted_narrative`. Nothing in this file is part of that
 * sequence or may write that column; these are drafting aids whose output
 * a human reads and retypes. Keeping them in separate tables keeps the
 * distinction visible at the routing layer rather than only in prose.
 *
 * The two incident-scoped tools sit under `/incidents/:id/ai-tools/*` and
 * the two that have no incident sit under `/ai-tools/*` — the URL says
 * which kind a job is, matching `ai_processing_log.incident_id`'s
 * nullability since 0015.
 */

use Baranguard\Controllers\AiToolsController;

return [
    ['POST', '#^/incidents/(\d+)/ai-tools/blotter-assist$#', [AiToolsController::class, 'blotterAssist'], true],
    ['POST', '#^/incidents/(\d+)/ai-tools/classify$#', [AiToolsController::class, 'classify'], true],
    ['POST', '#^/ai-tools/sms-compose$#', [AiToolsController::class, 'smsCompose'], true],
    ['POST', '#^/ai-tools/threat-analysis$#', [AiToolsController::class, 'threatAnalysis'], true],
    ['GET', '#^/ai-tools/jobs/(\d+)$#', [AiToolsController::class, 'job'], true],
    ['GET', '#^/ai-tools/availability$#', [AiToolsController::class, 'availability'], true],
];
