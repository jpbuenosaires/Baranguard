<?php
declare(strict_types=1);

/**
 * Route table for /reports/*: summary, heatmap, nav-counts, export (with a
 * download route, because the file must live outside the web root), the PB
 * digest and the live Annex D computation.
 */

use Baranguard\Controllers\ReportsController;

return [
    ['GET', '#^/reports/summary$#', [ReportsController::class, 'summary'], true],
    ['GET', '#^/reports/heatmap$#', [ReportsController::class, 'heatmap'], true],
    // Sidebar badge counts; see ReportsController::navCounts()'s own doc.
    ['GET', '#^/reports/nav-counts$#', [ReportsController::class, 'navCounts'], true],
    ['GET', '#^/reports/export$#', [ReportsController::class, 'export'], true],
    ['GET', '#^/reports/export/download$#', [ReportsController::class, 'exportDownload'], true],
    // Periodic PB digest: read-only meta + download for whatever
    // scripts/generate-pb-digest.php last produced on its own schedule. No
    // generate route on purpose: generation is CLI-only
    // (ReportsController::generateDigest()'s own doc explains why), same as
    // retention-job.php having no HTTP trigger.
    ['GET', '#^/reports/digest$#', [ReportsController::class, 'digestMeta'], true],
    ['GET', '#^/reports/digest/download$#', [ReportsController::class, 'digestDownload'], true],
    // Safer School Zones Annex D, live-computed; the persisted snapshot is
    // /ssz-term-reports.
    ['GET', '#^/reports/school-term$#', [ReportsController::class, 'schoolTerm'], true],
];
