<?php
declare(strict_types=1);

/**
 * Route table for GET /audit-log.
 *
 * ONE route, read-only, deliberately. `audit_log` is write-once except
 * controlled retention deletion, so there is no POST/PATCH/DELETE here and
 * there should never be one: the only path that removes an audit row is
 * `RetentionService::purgeAuditLog()`, a CLI job.
 */

use Baranguard\Controllers\AuditLogController;

return [
    ['GET', '#^/audit-log$#', [AuditLogController::class, 'index'], true],
];
