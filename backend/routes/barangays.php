<?php
declare(strict_types=1);

/**
 * Route table for /barangays. Public: needed pre-auth by the barangay picker.
 */

use Baranguard\Controllers\BarangaysController;

return [
    ['GET', '#^/barangays$#', [BarangaysController::class, 'index'], false],
];
