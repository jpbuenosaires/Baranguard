<?php
declare(strict_types=1);

/**
 * route-table.php — prints every /api/v1 route as one tab-separated line for
 * the verify suites: METHOD, a concrete sample path, auth flag (1/0), and
 * the roles the handler passes to its first AuthMiddleware::requireRole()
 * call (comma-separated, empty when the handler has no direct role check).
 *
 * Sample paths fill each capture group with a value of the right shape, so
 * the request reaches the handler instead of a 404 route miss.
 *
 * Usage: php backend/scripts/lib/route-table.php
 */

$backend = dirname(__DIR__, 2);
$group = '/\((?:[^()]|\([^()]*\))*\)/';

foreach (glob($backend . '/routes/*.php') ?: [] as $file) {
    foreach (require $file as $route) {
        [$method, $pattern, $handler, $auth] = $route;
        $core = substr($pattern, 2, -2);
        $path = (string) preg_replace_callback($group, static function (array $m): string {
            if (str_contains($m[0], '\d')) {
                return '1';
            }
            if (str_contains($m[0], '0-9+')) {
                return '639170000000';
            }
            return 'sweep-device-0001';
        }, $core);
        $path = stripslashes($path);

        $roles = '';
        $short = substr((string) strrchr('\\' . $handler[0], '\\'), 1);
        $source = @file_get_contents($backend . '/controllers/' . $short . '.php');
        if ($source !== false && preg_match('/function\s+' . preg_quote($handler[1], '/') . '\s*\(/', $source, $m, PREG_OFFSET_CAPTURE)) {
            $body = substr($source, $m[0][1]);
            $next = preg_match('/\n\s*(public|private|protected)\s+static\s+function\s/', $body, $n, PREG_OFFSET_CAPTURE, 10) ? $n[0][1] : strlen($body);
            $body = substr($body, 0, $next);
            if (preg_match('/requireRole\(\s*\$identity\s*,\s*\[([^\]]*)\]/', $body, $r)) {
                $roles = implode(',', array_map(static fn (string $x): string => trim($x, " '\""), explode(',', $r[1])));
            }
        }
        echo strtoupper($method), "\t", $path, "\t", $auth ? '1' : '0', "\t", $roles, "\n";
    }
}
