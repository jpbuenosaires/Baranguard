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
];
