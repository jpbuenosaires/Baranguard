<?php
declare(strict_types=1);

/**
 * Route table for the /auth/* endpoints (§6 "Auth" section). Loaded by
 * public/index.php's router. Each entry:
 *   [HTTP method, path regex (matched against the URI after /api/v1),
 *    [ControllerClass, 'methodName'], requiresAuth]
 *
 * A handler receiving requiresAuth=false is called as $handler($pdo);
 * one receiving requiresAuth=true is called as $handler($pdo, $identity)
 * with $identity resolved by AuthMiddleware::authenticate() first.
 *
 * /auth/logout is requiresAuth=false here on purpose even though it's an
 * authenticated action — AuthMiddleware::authenticate()'s strict gate
 * would reject an already-revoked session with 401, breaking §6's "server
 * ignores a second logout safely". AuthController::logout() resolves its
 * own auth via the looser AuthMiddleware::resolveForLogout() instead.
 */

use Baranguard\Controllers\AuthController;

return [
    ['POST', '#^/auth/login$#', [AuthController::class, 'login'], false],
    ['POST', '#^/auth/logout$#', [AuthController::class, 'logout'], false],
];
