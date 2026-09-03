<?php
declare(strict_types=1);

/**
 * Route table for /incidents (§6 "Incidents" section). GET (list), POST
 * (create — branches web/mobile by role, see IncidentsController), and
 * GET /incidents/nearby (Sprint 3, M7 Live Map) this cut — detail, status,
 * evidence, redaction etc. are separate boxes not built here.
 */

use Baranguard\Controllers\IncidentsController;

return [
    // `nearby` is listed before the numeric-id route for readability; the
    // two cannot collide anyway since `(\d+)` never matches "nearby".
    ['GET', '#^/incidents/nearby$#', [IncidentsController::class, 'nearby'], true],
    ['GET', '#^/incidents/(\d+)$#', [IncidentsController::class, 'show'], true],
    ['GET', '#^/incidents/(\d+)/evidence$#', [IncidentsController::class, 'evidence'], true],
    ['PATCH', '#^/incidents/(\d+)/status$#', [IncidentsController::class, 'updateStatus'], true],
    ['GET', '#^/incidents$#', [IncidentsController::class, 'index'], true],
    ['POST', '#^/incidents$#', [IncidentsController::class, 'create'], true],
];
