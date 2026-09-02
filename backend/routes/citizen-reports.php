<?php
declare(strict_types=1);

/**
 * Route table for /citizen-reports (§6 "Citizen reports" section).
 * `POST /citizen-reports` is public (no auth) — W19. `GET /citizen-reports`
 * is Admin/Secretary — W16 (list only; `POST /citizen-reports/:id/convert`
 * is a separate, unbuilt endpoint).
 */

use Baranguard\Controllers\CitizenReportsController;

return [
    ['POST', '#^/citizen-reports$#', [CitizenReportsController::class, 'submit'], false],
    ['GET', '#^/citizen-reports$#', [CitizenReportsController::class, 'index'], true],
];
