<?php
declare(strict_types=1);

/**
 * Route table for /incidents (§6 "Incidents" section). Only
 * GET /incidents this session — creation, detail, status, evidence,
 * redaction etc. are separate boxes not built here.
 */

use Baranguard\Controllers\IncidentsController;

return [
    ['GET', '#^/incidents$#', [IncidentsController::class, 'index'], true],
];
