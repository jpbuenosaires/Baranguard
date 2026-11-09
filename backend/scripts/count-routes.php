<?php
declare(strict_types=1);

/**
 * count-routes.php — counts live /api/v1 routes the EXACT same way
 * `backend/public/index.php` does (glob `routes/*.php`, count every array
 * entry each file returns), so a hand-maintained route count in a doc can
 * be checked against reality in one command.
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
echo "Update any hand-kept route count if it no longer matches; this script is
";
echo "not wired into anything automatically.
";
