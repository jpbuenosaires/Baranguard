<?php
declare(strict_types=1);

/**
 * Minimal .env loader (no Composer dependency — Sprint 0's db.php comment
 * mentioned vlucas/phpdotenv, but nothing was ever added to require it, so
 * getenv() returned nothing under Apache/XAMPP, which doesn't read .env on
 * its own the way `dotenv` does for the Node side). This parses
 * backend/.env into getenv()/$_ENV/$_SERVER without overwriting any
 * variable the environment already provides (e.g. set via Apache
 * SetEnv/vhost config, or a real deployment's process manager) — same
 * "don't override what's already set" precedence dotenv uses on the Node
 * side, kept consistent across both runtimes on purpose.
 *
 * Include this once, first, from backend/public/index.php (or any PHP
 * entrypoint/CLI script) before reading any env var.
 */

function baranguard_load_env(?string $path = null): void
{
    static $loaded = false;
    if ($loaded) {
        return;
    }
    $loaded = true;

    $path = $path ?? dirname(__DIR__) . '/.env';
    if (!is_readable($path)) {
        return; // Real deployments may set env vars another way — not fatal.
    }

    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        $eq = strpos($line, '=');
        if ($eq === false) {
            continue;
        }
        $name = trim(substr($line, 0, $eq));
        $value = trim(substr($line, $eq + 1));
        // Strip one layer of matching quotes, same as dotenv.
        if (strlen($value) >= 2) {
            $first = $value[0];
            $last = $value[strlen($value) - 1];
            if (($first === '"' && $last === '"') || ($first === "'" && $last === "'")) {
                $value = substr($value, 1, -1);
            }
        }
        if ($name === '' || getenv($name) !== false) {
            continue; // Already set — never override.
        }
        putenv("{$name}={$value}");
        $_ENV[$name] = $value;
        $_SERVER[$name] = $value;
    }
}
