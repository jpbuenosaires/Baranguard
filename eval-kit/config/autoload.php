<?php
declare(strict_types=1);

/**
 * Minimal PSR-4-ish autoloader for the `Baranguard\` namespace — no
 * Composer dependency (consistent with Jwt.php's reasoning: nothing else
 * in backend/ uses Composer yet, so adding it just for autoloading felt
 * like more setup friction than one small autoloader function).
 *
 * Maps Baranguard\Services\Auth\Jwt -> backend/services/auth/Jwt.php:
 * every namespace segment except the class name itself is lowercased to
 * match this repo's lowercase folder convention (§4: /routes /controllers
 * /middleware /services /config /migrations); the class name is kept
 * verbatim as the filename, one class per file.
 */
spl_autoload_register(static function (string $class): void {
    $prefix = 'Baranguard\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $segments = explode('\\', $relative);
    $className = array_pop($segments);
    $dirSegments = array_map('strtolower', $segments);

    $path = dirname(__DIR__) . '/' . implode('/', $dirSegments) . '/' . $className . '.php';
    if (is_file($path)) {
        require_once $path;
    }
});
