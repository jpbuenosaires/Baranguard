<?php
declare(strict_types=1);

/**
 * Route table for /duty-status (§6 "Duty status" section). Only
 * GET this session (both ?user_id=me and ?barangay_id= shapes handled
 * inside the controller) — POST /duty-status (Tanod toggle) is mobile
 * M2/Sprint 2 scope.
 */

use Baranguard\Controllers\DutyStatusController;

return [
    ['GET', '#^/duty-status$#', [DutyStatusController::class, 'index'], true],
];
