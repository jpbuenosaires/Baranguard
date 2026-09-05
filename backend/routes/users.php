<?php
declare(strict_types=1);

/**
 * Route table for /users (§6 "Users & device lifecycle" section). GET
 * (list, W3 Tanod-picker plumbing), POST (Admin creates an account, W10),
 * and PATCH (self-only edit, W15; admin-editing-others is_active, W10) —
 * reset-password remains a separate, unbuilt endpoint.
 */

use Baranguard\Controllers\UsersController;

return [
    ['GET', '#^/users$#', [UsersController::class, 'index'], true],
    ['POST', '#^/users$#', [UsersController::class, 'create'], true],
    ['PATCH', '#^/users/(\d+)$#', [UsersController::class, 'update'], true],
];
