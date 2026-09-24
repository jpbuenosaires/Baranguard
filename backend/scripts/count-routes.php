<?php
declare(strict_types=1);

/**
 * count-routes.php — code-review finding L-01 (2026-09-24): REFERENCE.md
 * §5 claimed "84 live /api/v1 routes", but a real count came to 91 the
 * day this was checked — a hand-maintained number in a doc will always
 * drift as routes are added. This computes the count the EXACT same way
 * `backend/public/index.php` does (glob `routes/*.php`, count every
 * array entry each file returns), so a session can check REFERENCE.md's
 * claim against reality in one command instead of hand-counting or
 * trusting a stale number.
 *
 * Usage: php backend/scripts/count-routes.php
 *        php backend/scripts/count-routes.php --detail   (per-file breakdown)
 */

$routesDir = dirname(__DIR__) . '/routes';
$routeFiles = glob($routesDir . '/*.php') ?: [];
sort($routeFiles);

$detail = in_array('--detail', $argv, true);
$total = 0;

foreach ($routeFiles as $file) {
    /** @var list<array{0:string,1:string,2:array{0:string,1:string},3:bool}> $routes */
    $routes = require $file;
    $count = count($routes);
    $total += $count;
    if ($detail) {
        printf("%3d  %s\n", $count, basename($file));
    }
}

printf("\n%d live /api/v1 routes across %d files.\n", $total, count($routeFiles));
echo "Compare against docs/REFERENCE.md §5's stated count — update that\n";
echo "doc's number by hand if it no longer matches; this script is not\n";
echo "wired into anything automatically.\n";
