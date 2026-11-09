<?php
declare(strict_types=1);

/**
 * verify-route-coverage.php — every /api/v1 route must be exercised by at
 * least one verify script (HANDOFF "things most likely to bite you" #4: a
 * verify script proves nothing about a route it never calls).
 *
 * Static check, no server or database: it loads the route tables exactly as
 * `public/index.php` does, turns each route pattern into a path matcher
 * (capture groups become "any path segment", so `$ID`, `${INC}` and literal
 * ids all match), and scans every `scripts/verify-*.{sh,php,mjs}` line.
 *
 * A route FAILS when no line references its path, or when the path is only
 * ever referenced on lines without its HTTP method (GET is assumed when no
 * other method appears on the line). Text matching cannot prove the request
 * succeeded; it proves a suite at least sends it, which is what was missing.
 *
 * Usage: php backend/scripts/verify-route-coverage.php [--list]
 *        --list also prints how many suites reference each route.
 */

$backend = dirname(__DIR__);
$list = in_array('--list', $argv, true);

$routes = [];
foreach (glob($backend . '/routes/*.php') ?: [] as $file) {
    foreach (require $file as $route) {
        $routes[] = ['method' => strtoupper($route[0]), 'pattern' => $route[1], 'file' => basename($file)];
    }
}

$lines = [];
$scripts = array_merge(
    glob($backend . '/scripts/verify-*.sh') ?: [],
    glob($backend . '/scripts/verify-*.php') ?: [],
    glob($backend . '/scripts/verify-*.mjs') ?: []
);
foreach ($scripts as $script) {
    if (basename($script) === basename(__FILE__)) {
        continue;
    }
    foreach (file($script) ?: [] as $line) {
        $lines[] = [basename($script), $line];
    }
}

$group = '/\((?:[^()]|\([^()]*\))*\)/';
$segment = '[^/"\'\s?]+';
$pass = 0;
$fail = 0;

foreach ($routes as $r) {
    $core = substr($r['pattern'], 2, -2); // strip the #^ ... $# delimiters
    $parts = explode('@@', (string) preg_replace($group, '@@', $core));
    $matcher = '#' . implode($segment, array_map(fn (string $p): string => preg_quote(stripslashes($p), '#'), $parts)) . '(?![a-zA-Z0-9_/-])#';
    $label = sprintf('%-6s %s', $r['method'], stripslashes((string) preg_replace($group, ':id', $core)));

    $suites = [];
    $methodSeen = false;
    foreach ($lines as [$suite, $line]) {
        if (!preg_match($matcher, $line)) {
            continue;
        }
        $suites[$suite] = true;
        $otherVerb = preg_match('#\b(POST|PATCH|PUT|DELETE)\b#', $line) === 1;
        if ($r['method'] === 'GET' ? !$otherVerb : preg_match('#\b' . $r['method'] . '\b#', $line) === 1) {
            $methodSeen = true;
        }
    }

    if ($suites === []) {
        echo "[FAIL] {$label} ({$r['file']}) is never called by any verify script\n";
        $fail++;
    } elseif (!$methodSeen) {
        echo "[FAIL] {$label} ({$r['file']}) path appears, but never with {$r['method']}: " . implode(', ', array_keys($suites)) . "\n";
        $fail++;
    } else {
        $pass++;
        if ($list) {
            echo "[PASS] {$label} (" . count($suites) . " suite" . (count($suites) === 1 ? '' : 's') . ")\n";
        }
    }
}

echo "\nRoutes: " . count($routes) . ', verify scripts scanned: ' . (count($scripts) - 1) . "\n";
echo "RESULT: {$pass} passed, {$fail} failed.\n";
exit($fail === 0 ? 0 : 1);
