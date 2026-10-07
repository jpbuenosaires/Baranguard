<?php
declare(strict_types=1);

/**
 * Route table for night-time dispatch offers (Wave 2, migration 0038).
 * Picked up automatically by public/index.php's glob of routes/*.php.
 * Accept is deliberately online-only: it is NOT a /sync/batch kind.
 */

use Baranguard\Controllers\DispatchOffersController;

return [
    ['GET', '#^/dispatch-offers$#', [DispatchOffersController::class, 'index'], true],
    ['POST', '#^/dispatch-offers$#', [DispatchOffersController::class, 'open'], true],
    ['POST', '#^/dispatch-offers/(\d+)/accept$#', [DispatchOffersController::class, 'accept'], true],
    ['PATCH', '#^/dispatch-offers/(\d+)/cancel$#', [DispatchOffersController::class, 'cancel'], true],
];
