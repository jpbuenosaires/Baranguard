<?php
declare(strict_types=1);

/**
 * Route table for /gps: Tanod position broadcast (POST) plus the read endpoints.
 */

use Baranguard\Controllers\GpsController;

return [
    ['GET', '#^/gps/live$#', [GpsController::class, 'live'], true],
    ['GET', '#^/gps/stream$#', [GpsController::class, 'stream'], true],
    ['GET', '#^/gps/history$#', [GpsController::class, 'history'], true],
    ['POST', '#^/gps$#', [GpsController::class, 'create'], true],
];
