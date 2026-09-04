<?php
declare(strict_types=1);

/**
 * Route table for /reports/* (§6 "Audit / reports" section).
 * GET /reports/summary and GET /reports/heatmap (W5) came first;
 * /reports/export landed in Sprint 7's own box (W9's Export button),
 * with a download route for the same reason the Lupon packet has one —
 * §6 promises a file_url while the file must live outside the web root. /reports/notifications-summary isn't in Sprint 1's own endpoint
 * list either (its data model — notification/notification_target/
 * notification_delivery — is Sprint 4 scope) and is deliberately not
 * built yet; see W9's page-level doc for why.
 */

use Baranguard\Controllers\ReportsController;

return [
    ['GET', '#^/reports/summary$#', [ReportsController::class, 'summary'], true],
    ['GET', '#^/reports/heatmap$#', [ReportsController::class, 'heatmap'], true],
    // §4.1 of the UI/UX review (sidebar badge counts) — not in §6's
    // original endpoint list, a resolved/logged addition; see
    // ReportsController::navCounts()'s own doc.
    ['GET', '#^/reports/nav-counts$#', [ReportsController::class, 'navCounts'], true],
    ['GET', '#^/reports/export$#', [ReportsController::class, 'export'], true],
    ['GET', '#^/reports/export/download$#', [ReportsController::class, 'exportDownload'], true],
];
