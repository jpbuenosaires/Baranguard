<?php
declare(strict_types=1);

/**
 * Route table for `GET /sms/logs` (§6, §9 W14). Ordinary authenticated
 * `/api/v1` route — NOT the internal-only `/internal/sms/*` surface (see
 * routes-internal/sms.php + public/internal.php for that one).
 */

use Baranguard\Controllers\SmsController;

return [
    ['GET', '#^/sms/logs$#', [SmsController::class, 'index'], true],
];
