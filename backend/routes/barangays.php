<?php
declare(strict_types=1);

/**
 * Route table for /barangays (§6 "Reference / lookup" section).
 * Public — needed pre-auth by W19's barangay picker.
 */

use Baranguard\Controllers\BarangaysController;

return [
    ['GET', '#^/barangays$#', [BarangaysController::class, 'index'], false],
];
