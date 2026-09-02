<?php
declare(strict_types=1);

/** Route table for /shift-swap-requests (§6 "Shifts and fatigue" section). */

use Baranguard\Controllers\ShiftSwapRequestsController;

return [
    ['POST', '#^/shift-swap-requests$#', [ShiftSwapRequestsController::class, 'create'], true],
    ['GET', '#^/shift-swap-requests$#', [ShiftSwapRequestsController::class, 'index'], true],
    ['PATCH', '#^/shift-swap-requests/(\d+)$#', [ShiftSwapRequestsController::class, 'update'], true],
];
