<?php
declare(strict_types=1);

/**
 * Route table for /duty-status. GET handles both ?user_id=me and
 * ?barangay_id= shapes inside the controller; POST is the Tanod toggle.
 */

use Baranguard\Controllers\DutyStatusController;

return [
    ['GET', '#^/duty-status$#', [DutyStatusController::class, 'index'], true],
    ['POST', '#^/duty-status$#', [DutyStatusController::class, 'create'], true],
];
