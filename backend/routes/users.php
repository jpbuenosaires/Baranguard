<?php
declare(strict_types=1);

/**
 * Route table for /users (§6 "Users & device lifecycle" section). GET
 * (list, W3 Tanod-picker plumbing) and PATCH (self-only edit, W15) —
 * create/reset-password remain separate, unbuilt endpoints.
 */

use Baranguard\Controllers\UsersController;

return [
    ['GET', '#^/users$#', [UsersController::class, 'index'], true],
    ['PATCH', '#^/users/(\d+)$#', [UsersController::class, 'update'], true],
];
