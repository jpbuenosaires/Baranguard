<?php
declare(strict_types=1);

/**
 * Front controller. All /api/v1/* requests are rewritten here by
 * .htaccess (Apache/XAMPP). /public is the Apache document root so that
 * /config, /migrations and /scripts (one level up) are never reachable by
 * direct HTTP request.
 *
 * Point your XAMPP vhost / Apache DocumentRoot at this backend/public folder.
 */

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();

require dirname(__DIR__) . '/config/autoload.php';

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;

// --- CORS -------------------------------------------------------------
// The web dashboard and the mobile app's Capacitor WebView (`http://localhost`)
// are two different origins that both need access. This is a locally hosted,
// LAN-only system, so the default is permissive; override via
// CORS_ALLOWED_ORIGIN in .env. It is either `*` or a comma-separated list of
// exact origins (scheme+host+port); a list is matched against the request's
// `Origin` header and only that exact match is echoed back (`Vary: Origin`).
// An origin not on the list gets no CORS header at all, so the browser
// refuses the response.
$corsConfig = baranguard_env('CORS_ALLOWED_ORIGIN') ?: '*';
if ($corsConfig === '*') {
    header('Access-Control-Allow-Origin: *');
} else {
    $allowedOrigins = array_map('trim', explode(',', $corsConfig));
    $requestOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($requestOrigin !== '' && in_array($requestOrigin, $allowedOrigins, true)) {
        header("Access-Control-Allow-Origin: {$requestOrigin}");
        header('Vary: Origin');
    }
}
header('Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS');
// Every header the mobile client sends (including the device signature pair)
// must be listed here: an unlisted header makes the WebView reject the CORS
// preflight and never send the real request, which looks exactly like
// "server unreachable" client-side.
header('Access-Control-Allow-Headers: Content-Type, Authorization, Idempotency-Key, X-Device-Id, X-Device-Timestamp, X-Device-Signature');
header('Access-Control-Expose-Headers: X-Renewed-Token');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

try {
    require dirname(__DIR__) . '/config/db.php';
    $pdo = baranguard_db();

    $requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
    $basePrefix = '/api/v1';
    if (!str_starts_with($requestPath, $basePrefix)) {
        throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    }
    $path = substr($requestPath, strlen($basePrefix));
    if ($path === '') {
        $path = '/';
    }
    // PHP_URL_PATH is not URL-decoded: a phone-number segment like
    // `+639171234567` arrives as `%2B639171234567`, which the
    // `/sms/conversations/:phone/*` patterns need decoded.
    $path = rawurldecode($path);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // Route tables: one file per resource group under backend/routes/,
    // each returning a list of [method, pattern, handler, requiresAuth].
    $routeFiles = glob(dirname(__DIR__) . '/routes/*.php') ?: [];
    $routes = [];
    foreach ($routeFiles as $routeFile) {
        $routes = [...$routes, ...require $routeFile];
    }

    $matchedPathButNotMethod = false;
    foreach ($routes as [$routeMethod, $pattern, $handler, $requiresAuth]) {
        if (!preg_match($pattern, $path, $matches)) {
            continue;
        }
        $matchedPathButNotMethod = true;
        if ($routeMethod !== $method) {
            continue;
        }

        // Numbered capture groups (e.g. the `(\d+)` in
        // `#^/dispatch/(\d+)/cancel$#`) become trailing handler args, in
        // order, after $pdo/$identity. $matches[0] is the whole match, not
        // a capture, so it's dropped. Extra args are silently ignored by
        // PHP on handlers that don't declare them, so 2-arg handlers work
        // unchanged.
        $routeParams = array_slice($matches, 1);

        if ($requiresAuth) {
            $identity = AuthMiddleware::authenticate($pdo);
            if ($identity['renewedToken'] !== null) {
                header('X-Renewed-Token: ' . $identity['renewedToken']);
            }
            $handler($pdo, $identity, ...$routeParams);
        } else {
            $handler($pdo, ...$routeParams);
        }
        exit; // Handlers call Http::send()/sendError(), which already exit.
    }

    throw new ApiError($matchedPathButNotMethod ? 405 : 404, $matchedPathButNotMethod ? 'VALIDATION_ERROR' : 'NOT_FOUND', $matchedPathButNotMethod ? 'Method not allowed.' : 'Not found.');
} catch (ApiError $e) {
    Http::sendError($e);
} catch (\Throwable $e) {
    // Error messages never reveal security-sensitive implementation
    // details. Log the real error server-side only.
    error_log('[baranguard] unhandled error: ' . $e->getMessage() . "\n" . $e->getTraceAsString());
    Http::send(500, ['error' => ['code' => 'SERVER_ERROR', 'message' => 'An unexpected error occurred.']]);
}
