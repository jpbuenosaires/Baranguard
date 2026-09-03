<?php
declare(strict_types=1);

/**
 * Route table for /tanod-sos (§6 "Tanod SOS" section). Only the
 * read-only list this session — POST /tanod-sos (Tanod trigger) and the
 * acknowledge/resolve endpoints are Sprint 4 scope.
 */

use Baranguard\Controllers\TanodSosController;

return [
    ['GET', '#^/tanod-sos$#', [TanodSosController::class, 'index'], true],
    ['POST', '#^/tanod-sos$#', [TanodSosController::class, 'create'], true],
    ['PATCH', '#^/tanod-sos/(\d+)/acknowledge$#', [TanodSosController::class, 'acknowledge'], true],
    ['PATCH', '#^/tanod-sos/(\d+)/resolve$#', [TanodSosController::class, 'resolve'], true],
];
