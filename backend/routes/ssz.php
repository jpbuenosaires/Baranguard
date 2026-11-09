<?php
declare(strict_types=1);

/**
 * Route table for the Annex D term report: draft -> prepared -> submitted.
 * The live, non-persisted computation is GET /reports/school-term
 * (routes/reports.php).
 */

use Baranguard\Controllers\SszTermReportsController;

return [
    ['GET', '#^/ssz-term-reports$#', [SszTermReportsController::class, 'index'], true],
    ['POST', '#^/ssz-term-reports$#', [SszTermReportsController::class, 'create'], true],
    ['GET', '#^/ssz-term-reports/(\d+)$#', [SszTermReportsController::class, 'show'], true],
    ['PATCH', '#^/ssz-term-reports/(\d+)$#', [SszTermReportsController::class, 'update'], true],
    ['POST', '#^/ssz-term-reports/(\d+)/prepare$#', [SszTermReportsController::class, 'prepare'], true],
    ['POST', '#^/ssz-term-reports/(\d+)/mark-submitted$#', [SszTermReportsController::class, 'markSubmitted'], true],
];
