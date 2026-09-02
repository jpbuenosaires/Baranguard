<?php
declare(strict_types=1);

/**
 * Route table for /duty-status (§6 "Duty status" section). GET handles
 * both ?user_id=me and ?barangay_id= shapes inside the controller.
 * POST /duty-status (Tanod toggle, M2 Home) added for Sprint 2.
 */

use Baranguard\Controllers\DutyStatusController;

return [
    ['GET', '#^/duty-status$#', [DutyStatusController::class, 'index'], true],
    ['POST', '#^/duty-status$#', [DutyStatusController::class, 'create'], true],
];
