<?php
declare(strict_types=1);

/**
 * Route table for /system/* (§6 "System health" section, §9 W20).
 * Admin only, local-only diagnostics.
 */

use Baranguard\Controllers\SystemHealthController;

return [
    ['GET', '#^/system/health$#', [SystemHealthController::class, 'index'], true],
    // Ordered AFTER the exact-match above deliberately: both patterns are
    // anchored, so they cannot collide, but keeping the more specific
    // path second matches how every other table here reads.
    ['GET', '#^/system/health/history$#', [SystemHealthController::class, 'history'], true],
];
