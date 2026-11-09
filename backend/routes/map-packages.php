<?php
declare(strict_types=1);

/**
 * Route table for /map-packages (version check, download, admin upload).
 *
 * The `/download` route is listed first so it can never be shadowed by
 * the metadata route; the patterns are mutually exclusive anyway (`$`
 * anchors), but order keeps that obvious to the next reader.
 */

use Baranguard\Controllers\MapPackagesController;

return [
    ['GET', '#^/map-packages/(\d+)/download$#', [MapPackagesController::class, 'download'], true],
    ['GET', '#^/map-packages/(\d+)$#', [MapPackagesController::class, 'show'], true],
    ['POST', '#^/map-packages$#', [MapPackagesController::class, 'create'], true],
];
