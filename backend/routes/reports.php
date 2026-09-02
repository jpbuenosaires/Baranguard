<?php
declare(strict_types=1);

/**
 * Route table for /reports/* (§6 "Audit / reports" section).
 * GET /reports/summary and GET /reports/heatmap (W5) this session —
 * /reports/export is a separate Sprint 7 "Today's cut" box, not built
 * here. /reports/notifications-summary isn't in Sprint 1's own endpoint
 * list either (its data model — notification/notification_target/
 * notification_delivery — is Sprint 4 scope) and is deliberately not
 * built yet; see W9's page-level doc for why.
 */

use Baranguard\Controllers\ReportsController;

return [
    ['GET', '#^/reports/summary$#', [ReportsController::class, 'summary'], true],
    ['GET', '#^/reports/heatmap$#', [ReportsController::class, 'heatmap'], true],
];
