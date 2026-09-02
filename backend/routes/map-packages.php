<?php
declare(strict_types=1);

/**
 * Route table for /map-packages (§6 "Map packages"). Built for Sprint 2's
 * M1 Login box (version check + download).
 *
 * `POST /map-packages` (Admin multipart upload + MBTiles validation +
 * atomic publish) is deliberately not registered yet — see
 * MapPackagesController's class doc for why, and the Sprint 2 checklist
 * in docs/Baranguard_Sprint_Prompts.md for it as an open item.
 *
 * The `/download` route is listed first so it can never be shadowed by
 * the metadata route; the patterns are mutually exclusive anyway (`$`
 * anchors), but order keeps that obvious to the next reader.
 */

use Baranguard\Controllers\MapPackagesController;

return [
    ['GET', '#^/map-packages/(\d+)/download$#', [MapPackagesController::class, 'download'], true],
    ['GET', '#^/map-packages/(\d+)$#', [MapPackagesController::class, 'show'], true],
];
