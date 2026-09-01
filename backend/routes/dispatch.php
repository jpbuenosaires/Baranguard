<?php
declare(strict_types=1);

/**
 * Route table for /dispatch (§6 "Dispatch" section). This session builds
 * create/list/cancel (W3a/W3b); detail and status-transition/override are
 * separate boxes not built here.
 */

use Baranguard\Controllers\DispatchController;

return [
    ['POST', '#^/dispatch$#', [DispatchController::class, 'create'], true],
    ['GET', '#^/dispatch$#', [DispatchController::class, 'index'], true],
    ['PATCH', '#^/dispatch/(\d+)/cancel$#', [DispatchController::class, 'cancel'], true],
];
