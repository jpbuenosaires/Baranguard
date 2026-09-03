<?php
declare(strict_types=1);

/**
 * TEST/DEV-ONLY router for PHP's built-in server (`php -S host:port
 * public/dev-router.php`) — every `backend/scripts/verify-*.sh` script
 * uses `php -S`, which does NOT read `.htaccess`. Real Apache/XAMPP never
 * uses this file; it reads `public/.htaccess` directly, which is the
 * actual production rewrite configuration. This file exists solely so the
 * `/internal/*` split (see `public/internal.php`'s own doc) can be
 * exercised under the built-in server too, mirroring `.htaccess`'s two
 * rules exactly:
 *   1. `^internal/` -> internal.php
 *   2. everything else -> index.php
 *
 * PHP's built-in server already falls back to `index.php` automatically
 * for any path with no matching static file WHEN NO ROUTER SCRIPT IS
 * GIVEN — that's why every existing verify script's `/api/v1/*` calls
 * already work without one. Supplying a router script (this file)
 * replaces that automatic behaviour entirely, so the index.php fallback
 * has to be re-implemented here explicitly, not just the new /internal/
 * case.
 */

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';

if (str_starts_with($path, '/internal/')) {
    require __DIR__ . '/internal.php';
    return true;
}

// Real static files (none exist in this project's public/ beyond the
// front controllers themselves) would normally be served directly by
// Apache; the built-in server's default behaviour for a router script
// returning false is "try to serve the file as-is", which is fine here
// since nothing under public/ is meant to be served as a static asset.
if (is_file(__DIR__ . $path) && $path !== '/index.php' && $path !== '/internal.php' && $path !== '/dev-router.php') {
    return false;
}

require __DIR__ . '/index.php';
return true;
