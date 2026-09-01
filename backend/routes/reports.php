<?php
declare(strict_types=1);

/**
 * Route table for /reports/* (§6 "Audit / reports" section). Only
 * GET /reports/summary this session — /reports/heatmap and /reports/export
 * are separate Sprint 1/7 "Today's cut" boxes, not built here.
 */

use Baranguard\Controllers\ReportsController;

return [
    ['GET', '#^/reports/summary$#', [ReportsController::class, 'summary'], true],
];
