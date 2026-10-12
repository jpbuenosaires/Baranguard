<?php
declare(strict_types=1);

/**
 * Route table for /shifts (§6 "Shifts" section).
 */

use Baranguard\Controllers\ShiftsController;

return [
    ['POST', '#^/shifts$#', [ShiftsController::class, 'create'], true],
    ['GET', '#^/shifts$#', [ShiftsController::class, 'index'], true],
    ['POST', '#^/shifts/publish$#', [ShiftsController::class, 'publish'], true],
    ['PATCH', '#^/shifts/(\d+)$#', [ShiftsController::class, 'update'], true],
];
