<?php
declare(strict_types=1);

/**
 * Route table for /shifts (§6 "Shifts and fatigue" section). Includes
 * GET /shifts/fatigue-flags here (not fatigue-flags.php) since §6 fixes
 * that exact path under the /shifts prefix, distinct from the bare
 * /fatigue-flags/:id/acknowledge path — `\d+` never matches the literal
 * "fatigue-flags" segment, so no route-ordering conflict with
 * /shifts/:id.
 */

use Baranguard\Controllers\FatigueFlagsController;
use Baranguard\Controllers\ShiftsController;

return [
    ['POST', '#^/shifts$#', [ShiftsController::class, 'create'], true],
    ['GET', '#^/shifts$#', [ShiftsController::class, 'index'], true],
    ['GET', '#^/shifts/fatigue-flags$#', [FatigueFlagsController::class, 'index'], true],
    ['PATCH', '#^/shifts/(\d+)$#', [ShiftsController::class, 'update'], true],
];
