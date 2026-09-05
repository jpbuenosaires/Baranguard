<?php
declare(strict_types=1);

/**
 * Front controller. All /api/v1/* requests are rewritten here by
 * .htaccess (Apache/XAMPP). §4 folder conventions don't list a /public
 * folder explicitly, but serving PHP directly out of backend/ (which also
 * holds /config, /migrations, /scripts) from the web root would expose
 * those to direct HTTP requests — /public as the actual Apache document
 * root, with everything else one level up and outside it, is the standard
 * fix. Logged as a deliberate addition in DEVLOG.md, not an oversight.
 *
 * Point your XAMPP vhost / Apache DocumentRoot at this backend/public
 * folder (see backend/scripts/README-serving.md for the concrete steps).
 */

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();

require dirname(__DIR__) . '/config/autoload.php';

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;

// --- CORS -------------------------------------------------------------
// Sprint 1's web dashboard will call this API from a different dev-server
// origin/port. §2 Rule 7: this is a locally hosted, LAN-only system (no
// public internet exposure assumed), so a permissive default is a
// reasonable dev convenience here — override via CORS_ALLOWED_ORIGIN in
// .env for anything stricter. Logged as a resolved decision in
// DEVLOG.md since the reference doesn't specify CORS policy.
$corsOrigin = baranguard_env('CORS_ALLOWED_ORIGIN') ?: '*';
header("Access-Control-Allow-Origin: {$corsOrigin}");
header('Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, Idempotency-Key, X-Device-Id');
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
    // 2026-09-05 UX pass: `parse_url()`'s PHP_URL_PATH does NOT
    // URL-decode — a phone-number path segment like `+639171234567`
    // arrives percent-encoded (`%2B639171234567`) and none of this
    // file's route patterns (all plain digits/literals until now) had
    // ever needed decoding to match correctly. Every existing route's
    // pattern is unaffected (they contain no percent-encodable
    // characters), so this only changes behavior for the new
    // `/sms/conversations/:phone/*` routes that actually need it.
    $path = rawurldecode($path);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // Route tables: one file per resource group under backend/routes/,
    // each returning a list of [method, pattern, handler, requiresAuth].
    // Only auth.php exists so far — this session's scope.
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
        // order, after $pdo/$identity — the first route needing this is
        // PATCH /dispatch/:id/cancel. $matches[0] is the whole match, not
        // a capture, so it's dropped. Extra args are silently ignored by
        // PHP on handlers that don't declare them, so every existing
        // 2-arg handler (auth.php/reports.php) keeps working unchanged.
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
    // §6: "Error messages never reveal ... security-sensitive
    // implementation details." Log the real error server-side only.
    error_log('[baranguard] unhandled error: ' . $e->getMessage() . "\n" . $e->getTraceAsString());
    Http::send(500, ['error' => ['code' => 'SERVER_ERROR', 'message' => 'An unexpected error occurred.']]);
}
