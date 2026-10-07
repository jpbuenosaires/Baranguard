<?php
declare(strict_types=1);

/**
 * Route table for /citizen-reports (§6 "Citizen reports" section).
 * `GET /citizen-reports` and `POST /citizen-reports/:id/convert` are
 * Admin/Secretary — W16. The public `POST /citizen-reports` (W19) was
 * REMOVED in Wave 1 (2026-10-07 review decisions): walk-ins are logged by
 * staff from Incident Management; rows that already exist stay readable.
 */

use Baranguard\Controllers\CitizenReportsController;

return [
    ['GET', '#^/citizen-reports$#', [CitizenReportsController::class, 'index'], true],
    ['POST', '#^/citizen-reports/(\d+)/convert$#', [CitizenReportsController::class, 'convert'], true],
];
