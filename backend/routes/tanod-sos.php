<?php
declare(strict_types=1);

/**
 * Route table for /tanod-sos: list, Tanod trigger, acknowledge/resolve and
 * the SMS fallback contact.
 */

use Baranguard\Controllers\TanodSosController;

return [
    // Listed before the numeric-id routes for readability, same as other
    // route tables' "nearby"/literal-segment convention — `(\d+)` never
    // matches the literal "fallback-contact" segment anyway.
    ['GET', '#^/tanod-sos/fallback-contact$#', [TanodSosController::class, 'fallbackContact'], true],
    ['GET', '#^/tanod-sos$#', [TanodSosController::class, 'index'], true],
    ['POST', '#^/tanod-sos$#', [TanodSosController::class, 'create'], true],
    ['PATCH', '#^/tanod-sos/(\d+)/acknowledge$#', [TanodSosController::class, 'acknowledge'], true],
    ['PATCH', '#^/tanod-sos/(\d+)/resolve$#', [TanodSosController::class, 'resolve'], true],
];
