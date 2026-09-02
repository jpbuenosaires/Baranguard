<?php
declare(strict_types=1);

/**
 * Route table for the bare /fatigue-flags/:id/acknowledge path (§6
 * "Shifts and fatigue" section) — distinct from GET /shifts/fatigue-flags
 * (routes/shifts.php), which is the list endpoint under a different
 * prefix, exactly as §6 documents both.
 */

use Baranguard\Controllers\FatigueFlagsController;

return [
    ['PATCH', '#^/fatigue-flags/(\d+)/acknowledge$#', [FatigueFlagsController::class, 'acknowledge'], true],
];
