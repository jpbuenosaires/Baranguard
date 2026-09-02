<?php
declare(strict_types=1);

/**
 * Route table for /devices (§6 "Users & device lifecycle"). Built for
 * Sprint 2's M1 Login box.
 *
 * The `:id` here is a client-generated VARCHAR device id, not the numeric
 * `(\d+)` every other `/:id` route in this app uses — the pattern is kept
 * in sync with DevicesController::DEVICE_ID_PATTERN so a malformed id is
 * a routing miss (404) rather than reaching the controller.
 */

use Baranguard\Controllers\DevicesController;

return [
    ['POST', '#^/devices/register$#', [DevicesController::class, 'register'], true],
    ['PATCH', '#^/devices/([A-Za-z0-9._:-]{8,64})/deactivate$#', [DevicesController::class, 'deactivate'], true],
];
