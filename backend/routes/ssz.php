<?php
declare(strict_types=1);

/**
 * Route table for the Annex D term report (docs/FEATURE_CONTRACT_2026-10.md
 * section 7, migration 0033): draft -> prepared -> approved -> submitted.
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
    ['POST', '#^/ssz-term-reports/(\d+)/approve$#', [SszTermReportsController::class, 'approve'], true],
    ['POST', '#^/ssz-term-reports/(\d+)/mark-submitted$#', [SszTermReportsController::class, 'markSubmitted'], true],
];
