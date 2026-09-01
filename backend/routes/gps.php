<?php
declare(strict_types=1);

/**
 * Route table for /gps (§6 "GPS" section). Only the two read endpoints
 * this session — POST /gps (Tanod broadcast) is Sprint 3 mobile scope.
 */

use Baranguard\Controllers\GpsController;

return [
    ['GET', '#^/gps/live$#', [GpsController::class, 'live'], true],
    ['GET', '#^/gps/history$#', [GpsController::class, 'history'], true],
];
