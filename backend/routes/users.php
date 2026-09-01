<?php
declare(strict_types=1);

/**
 * Route table for /users (§6 "Users & device lifecycle" section). Only
 * GET (list) this session, added as plumbing for W3's Tanod picker (see
 * UsersController.php) — create/edit/reset-password are separate,
 * unbuilt endpoints.
 */

use Baranguard\Controllers\UsersController;

return [
    ['GET', '#^/users$#', [UsersController::class, 'index'], true],
];
