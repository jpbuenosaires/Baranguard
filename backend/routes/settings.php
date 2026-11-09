<?php
declare(strict_types=1);

/**
 * Route table for /system-settings. See SettingsController.php's own class
 * doc for its (deliberately small) scope.
 */

use Baranguard\Controllers\SettingsController;

return [
    ['GET', '#^/system-settings$#', [SettingsController::class, 'index'], true],
    ['PATCH', '#^/system-settings$#', [SettingsController::class, 'update'], true],
];
