<?php
declare(strict_types=1);

/**
 * Route table for /dispatch: create/list/cancel, PATCH /dispatch/:id/status
 * and the route lookup. There is no GET /dispatch/:id.
 */

use Baranguard\Controllers\DispatchController;

return [
    ['POST', '#^/dispatch$#', [DispatchController::class, 'create'], true],
    ['GET', '#^/dispatch$#', [DispatchController::class, 'index'], true],
    ['PATCH', '#^/dispatch/(\d+)/cancel$#', [DispatchController::class, 'cancel'], true],
    ['PATCH', '#^/dispatch/(\d+)/status$#', [DispatchController::class, 'updateStatus'], true],
    ['GET', '#^/dispatch/(\d+)/route$#', [DispatchController::class, 'route'], true],
];
