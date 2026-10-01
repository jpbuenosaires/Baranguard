<?php
declare(strict_types=1);

/**
 * Route table for incident referrals ("Delegated to"), docs/
 * FEATURE_CONTRACT_2026-10.md §5. `/incidents/:id/referrals` never collides
 * with routes/incidents.php's anchored `^/incidents/(\d+)$` patterns.
 */

use Baranguard\Controllers\ReferralsController;

return [
    ['POST', '#^/incidents/(\d+)/referrals$#', [ReferralsController::class, 'create'], true],
    ['GET', '#^/incidents/(\d+)/referrals$#', [ReferralsController::class, 'indexForIncident'], true],
    ['GET', '#^/referrals$#', [ReferralsController::class, 'index'], true],
];
