<?php
declare(strict_types=1);

/**
 * Route table for GET /audit-log (§6 "Audit / reports", §9 W17).
 *
 * ONE route, read-only, deliberately. §5 makes `audit_log` write-once
 * except controlled retention deletion, so there is no POST/PATCH/DELETE
 * here and there should never be one — the only path that removes an
 * audit row is `RetentionService::purgeAuditLog()`, a CLI job.
 */

use Baranguard\Controllers\AuditLogController;

return [
    ['GET', '#^/audit-log$#', [AuditLogController::class, 'index'], true],
];
