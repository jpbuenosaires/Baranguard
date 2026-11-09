<?php
declare(strict_types=1);

/**
 * Route table for /sync. POST /sync/batch.
 */

use Baranguard\Controllers\SyncController;

return [
    ['POST', '#^/sync/batch$#', [SyncController::class, 'batch'], true],
];
