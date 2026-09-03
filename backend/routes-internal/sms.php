<?php
declare(strict_types=1);

/**
 * Route table for the internal-only `/internal/sms/*` surface — §6
 * "Internal SMS / GSM". Loaded ONLY by `backend/public/internal.php`,
 * never by the normal `/api/v1` front controller (`backend/public/index.php`
 * globs `backend/routes/*.php`, a DIFFERENT directory from this one) —
 * that separation is what makes "never exposed on the public API surface"
 * true by construction rather than by convention.
 */

use Baranguard\Controllers\InternalSmsController;

return [
    ['POST', '#^/sms/incident-fallback$#', [InternalSmsController::class, 'incidentFallback']],
    ['POST', '#^/sms/dispatch-payload$#', [InternalSmsController::class, 'dispatchPayload']],
    ['POST', '#^/sms/priority-alert$#', [InternalSmsController::class, 'priorityAlert']],
    ['POST', '#^/sms/coord-ping$#', [InternalSmsController::class, 'coordPing']],
    ['POST', '#^/sms/duty-status$#', [InternalSmsController::class, 'dutyStatus']],
    ['POST', '#^/sms/sos$#', [InternalSmsController::class, 'sos']],
];
