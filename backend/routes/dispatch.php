<?php
declare(strict_types=1);

/**
 * Route table for /dispatch (§6 "Dispatch" section). This session builds
 * create/list/cancel (W3a/W3b) plus PATCH /dispatch/:id/status (Sprint 3,
 * M6 Assignment Detail/Navigation); detail (GET /dispatch/:id) is a
 * separate box not built here.
 */

use Baranguard\Controllers\DispatchController;

return [
    ['POST', '#^/dispatch$#', [DispatchController::class, 'create'], true],
    ['GET', '#^/dispatch$#', [DispatchController::class, 'index'], true],
    ['PATCH', '#^/dispatch/(\d+)/cancel$#', [DispatchController::class, 'cancel'], true],
    ['PATCH', '#^/dispatch/(\d+)/status$#', [DispatchController::class, 'updateStatus'], true],
];
