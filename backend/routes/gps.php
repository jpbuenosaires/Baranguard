<?php
declare(strict_types=1);

/**
 * Route table for /gps (§6 "GPS" section). POST /gps (Sprint 3, Tanod
 * broadcast) added alongside the two Sprint 1 read endpoints.
 */

use Baranguard\Controllers\GpsController;

return [
    ['GET', '#^/gps/live$#', [GpsController::class, 'live'], true],
    ['GET', '#^/gps/history$#', [GpsController::class, 'history'], true],
    ['POST', '#^/gps$#', [GpsController::class, 'create'], true],
];
