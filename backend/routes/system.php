<?php
declare(strict_types=1);

/**
 * Route table for /system/* (§6 "System health" section, §9 W20).
 * Admin only, local-only diagnostics.
 */

use Baranguard\Controllers\SystemHealthController;

return [
    ['GET', '#^/system/health$#', [SystemHealthController::class, 'index'], true],
];
