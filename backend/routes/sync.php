<?php
declare(strict_types=1);

/**
 * Route table for /sync (§6 "Sync" section). POST /sync/batch — Sprint 3.
 */

use Baranguard\Controllers\SyncController;

return [
    ['POST', '#^/sync/batch$#', [SyncController::class, 'batch'], true],
];
