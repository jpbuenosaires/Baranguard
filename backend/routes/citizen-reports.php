<?php
declare(strict_types=1);

/**
 * Route table for /citizen-reports (§6 "Citizen reports" section).
 * `POST /citizen-reports` is public (no auth) — W19. `GET /citizen-reports`
 * and `POST /citizen-reports/:id/convert` are Admin/Secretary — W16.
 */

use Baranguard\Controllers\CitizenReportsController;

return [
    ['POST', '#^/citizen-reports$#', [CitizenReportsController::class, 'submit'], false],
    ['GET', '#^/citizen-reports$#', [CitizenReportsController::class, 'index'], true],
    ['POST', '#^/citizen-reports/(\d+)/convert$#', [CitizenReportsController::class, 'convert'], true],
];
