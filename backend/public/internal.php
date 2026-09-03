<?php
declare(strict_types=1);

/**
 * Front controller for the internal-only `/internal/*` surface — §6
 * "Internal SMS / GSM": "Inbound handlers are callable only by the local
 * ingestion service over loopback or a mutually authenticated internal
 * channel; they are never exposed on the public API surface." §2 Rule 22:
 * "Inbound SMS is authenticated ... passed to internal handlers over
 * loopback or an equally protected local service boundary."
 *
 * DELIBERATELY A SEPARATE ENTRY POINT from `index.php`, not a special-cased
 * prefix inside it — that is what makes "never exposed on the public API
 * surface" a structural fact rather than a routing convention someone
 * could accidentally weaken later: `index.php` only ever globs
 * `backend/routes/*.php`, and this file only ever globs
 * `backend/routes-internal/*.php` — the two route-table directories never
 * merge, so a route can never end up reachable from both surfaces by
 * accident.
 *
 * Reached via `backend/public/.htaccess`'s dedicated `^internal/` rewrite
 * rule (checked BEFORE the general catch-all), so `/internal/sms/foo`
 * maps to this script with `/sms/foo` as the path this file itself
 * matches against `routes-internal/*.php`.
 *
 * TWO INDEPENDENT GATES, BOTH REQUIRED (defense in depth — see
 * .env.example's own note on why loopback alone isn't trusted as the only
 * check on this particular XAMPP install):
 *   1. REMOTE_ADDR must be loopback (127.0.0.1 or ::1) — the real GSM
 *      ingestion process runs on this same workstation (§2 Rule 7).
 *   2. The `X-Internal-Token` header must match INTERNAL_SERVICE_TOKEN.
 * Either check failing returns the SAME generic 401 as the other — no
 * detail about which gate failed, so a scan can't learn anything from the
 * response shape.
 */

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();

require dirname(__DIR__) . '/config/autoload.php';

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;

function baranguard_internal_reject(): never
{
    Http::send(401, ['error' => ['code' => 'UNAUTHORIZED', 'message' => 'This endpoint is internal-only.']]);
}

$remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
if (!in_array($remoteAddr, ['127.0.0.1', '::1'], true)) {
    baranguard_internal_reject();
}

$configuredToken = baranguard_env('INTERNAL_SERVICE_TOKEN');
$providedToken = Http::header('X-Internal-Token');
if (
    $configuredToken === false
    || trim($configuredToken) === ''
    || $providedToken === null
    || !hash_equals($configuredToken, $providedToken)
) {
    baranguard_internal_reject();
}

try {
    require dirname(__DIR__) . '/config/db.php';
    $pdo = baranguard_db();

    $requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
    $basePrefix = '/internal';
    if (!str_starts_with($requestPath, $basePrefix)) {
        throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    }
    $path = substr($requestPath, strlen($basePrefix));
    if ($path === '') {
        $path = '/';
    }
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    $routeFiles = glob(dirname(__DIR__) . '/routes-internal/*.php') ?: [];
    $routes = [];
    foreach ($routeFiles as $routeFile) {
        $routes = [...$routes, ...require $routeFile];
    }

    $matchedPathButNotMethod = false;
    foreach ($routes as [$routeMethod, $pattern, $handler]) {
        if (!preg_match($pattern, $path, $matches)) {
            continue;
        }
        $matchedPathButNotMethod = true;
        if ($routeMethod !== $method) {
            continue;
        }
        $routeParams = array_slice($matches, 1);
        $handler($pdo, ...$routeParams);
        exit;
    }

    throw new ApiError($matchedPathButNotMethod ? 405 : 404, $matchedPathButNotMethod ? 'VALIDATION_ERROR' : 'NOT_FOUND', $matchedPathButNotMethod ? 'Method not allowed.' : 'Not found.');
} catch (ApiError $e) {
    Http::sendError($e);
} catch (\Throwable $e) {
    error_log('[baranguard-internal] unhandled error: ' . $e->getMessage() . "\n" . $e->getTraceAsString());
    Http::send(500, ['error' => ['code' => 'SERVER_ERROR', 'message' => 'An unexpected error occurred.']]);
}
