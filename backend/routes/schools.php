<?php
declare(strict_types=1);

/**
 * Route table for Safer School Zones' school registry and Tanod school
 * check-ins (docs/FEATURE_CONTRACT_2026-10.md section 7, migration 0033).
 * There is deliberately no DELETE /schools/:id -- deactivate with
 * is_active=false instead.
 */

use Baranguard\Controllers\SchoolCheckinsController;
use Baranguard\Controllers\SchoolsController;

return [
    ['GET', '#^/schools$#', [SchoolsController::class, 'index'], true],
    ['POST', '#^/schools$#', [SchoolsController::class, 'create'], true],
    ['PATCH', '#^/schools/(\d+)$#', [SchoolsController::class, 'update'], true],
    ['GET', '#^/school-checkins$#', [SchoolCheckinsController::class, 'index'], true],
    ['POST', '#^/school-checkins$#', [SchoolCheckinsController::class, 'create'], true],
];
