<?php
declare(strict_types=1);

/**
 * Route table for /incidents (§6 "Incidents" section). GET (list) and
 * POST (web-path create, W6) this session — detail, status, evidence,
 * redaction etc. are separate boxes not built here.
 */

use Baranguard\Controllers\IncidentsController;

return [
    ['GET', '#^/incidents$#', [IncidentsController::class, 'index'], true],
    ['POST', '#^/incidents$#', [IncidentsController::class, 'create'], true],
];
