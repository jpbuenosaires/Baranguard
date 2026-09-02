<?php
declare(strict_types=1);

/**
 * Minimal .env loader (no Composer dependency — Sprint 0's db.php comment
 * mentioned vlucas/phpdotenv, but nothing was ever added to require it, so
 * getenv() returned nothing under Apache/XAMPP, which doesn't read .env on
 * its own the way `dotenv` does for the Node side). Parses backend/.env
 * into $_ENV/$_SERVER only — never `putenv()` — without overwriting any
 * variable the environment already provides (e.g. Apache SetEnv/vhost
 * config, or a real deployment's process manager).
 *
 * Deliberately NOT using putenv()/getenv() for our own config values
 * (2026-09-02 fix, real bug found in production use): those touch the
 * single OS-level process environment table, which is shared across every
 * thread of the same Apache worker process under a threaded MPM
 * (mpm_winnt on this XAMPP install runs 150 threads per process) — and
 * neither call is documented as thread-safe. Concurrent requests calling
 * baranguard_load_env() (every request does, since $loaded is reset each
 * request) raced on that shared table and intermittently produced
 * "Missing required environment variable: DB_HOST" even though the value
 * was correctly in .env — caught via the real Apache error log, not a
 * hunch. $_ENV/$_SERVER are ordinary per-request PHP superglobals, not
 * shared OS state, so they carry no such race. Every reader in this
 * codebase must go through baranguard_env() below, never raw getenv(),
 * for a value that comes from .env.
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
        if ($name === '' || isset($_ENV[$name]) || isset($_SERVER[$name])) {
            continue; // Already set — never override.
        }
        $_ENV[$name] = $value;
        $_SERVER[$name] = $value;
    }
}

/**
 * The one safe way to read a .env-sourced value anywhere in this
 * codebase — checks the per-request-safe superglobals first, and only
 * falls back to real getenv() for a variable this app's own .env never
 * sets (e.g. something set via Apache SetEnv) — that fallback still
 * carries a theoretical race under concurrent putenv() elsewhere, but
 * nothing in this codebase calls putenv() any more, so in practice it
 * only matters for genuinely external OS-level variables.
 */
function baranguard_env(string $name): string|false
{
    if (isset($_ENV[$name])) {
        return (string) $_ENV[$name];
    }
    if (isset($_SERVER[$name])) {
        return (string) $_SERVER[$name];
    }
    return getenv($name);
}
