<?php
declare(strict_types=1);

/**
 * Route table for /availability (docs/FEATURE_CONTRACT_2026-10.md section 3).
 */

use Baranguard\Controllers\AvailabilityController;

return [
    ['POST', '#^/availability$#', [AvailabilityController::class, 'create'], true],
    ['GET', '#^/availability$#', [AvailabilityController::class, 'index'], true],
    ['PATCH', '#^/availability/(\d+)$#', [AvailabilityController::class, 'review'], true],
];
