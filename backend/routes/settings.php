<?php
declare(strict_types=1);

/**
 * Route table for /system-settings — W21 System Settings, 2026-09-05 UX
 * pass. See SettingsController.php's own class doc for why this exists
 * now (a deliberate, user-authorized override of a previously-blocked
 * feature) and how small its actual scope is relative to the mockup
 * that prompted it.
 */

use Baranguard\Controllers\SettingsController;

return [
    ['GET', '#^/system-settings$#', [SettingsController::class, 'index'], true],
    ['PATCH', '#^/system-settings$#', [SettingsController::class, 'update'], true],
];
