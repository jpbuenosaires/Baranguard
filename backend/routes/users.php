<?php
declare(strict_types=1);

/**
 * Route table for /users: GET (list, and the directory picker feed), POST
 * (Admin creates an account), PATCH (self-only edit; admin editing
 * others' is_active/is_suspended/authorities). There is no reset-password
 * endpoint.
 */

use Baranguard\Controllers\UsersController;

return [
    ['GET', '#^/users$#', [UsersController::class, 'index'], true],
    // Picker feed for admin|secretary: {user_id, full_name, official_title} only.
    ['GET', '#^/users/directory$#', [UsersController::class, 'directory'], true],
    ['POST', '#^/users$#', [UsersController::class, 'create'], true],
    ['GET', '#^/users/(\d+)$#', [UsersController::class, 'show'], true],
    ['PATCH', '#^/users/(\d+)$#', [UsersController::class, 'update'], true],
];
