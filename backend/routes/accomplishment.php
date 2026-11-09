<?php
declare(strict_types=1);

/**
 * Route table for the monthly accomplishment report.
 */

use Baranguard\Controllers\AccomplishmentController;

return [
    ['POST', '#^/accomplishment-entries$#', [AccomplishmentController::class, 'createEntry'], true],
    ['PATCH', '#^/accomplishment-entries/(\d+)$#', [AccomplishmentController::class, 'updateEntry'], true],
    ['GET', '#^/accomplishment-reports$#', [AccomplishmentController::class, 'index'], true],
    ['GET', '#^/accomplishment-reports/(\d+)$#', [AccomplishmentController::class, 'show'], true],
    ['POST', '#^/accomplishment-reports/(\d+)/submit$#', [AccomplishmentController::class, 'submit'], true],
    ['POST', '#^/accomplishment-reports/(\d+)/return$#', [AccomplishmentController::class, 'returnReport'], true],
];
