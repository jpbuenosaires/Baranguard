<?php
declare(strict_types=1);

/**
 * Env-driven MariaDB PDO connection (PHP side of the backend).
 * Never hardcode credentials here — everything comes from getenv(),
 * loaded from .env by the process entrypoint (e.g. vlucas/phpdotenv).
 */

function baranguard_require_env(string $name): string
{
    $value = getenv($name);
    if ($value === false || $value === '') {
        throw new RuntimeException("Missing required environment variable: {$name}");
    }
    return $value;
}

function baranguard_db(): PDO
{
    static $pdo = null;

    if ($pdo !== null) {
        return $pdo;
    }

    $host = baranguard_require_env('DB_HOST');
    $port = getenv('DB_PORT') ?: '3306';
    $name = baranguard_require_env('DB_NAME');
    $user = baranguard_require_env('DB_USER');
    $pass = baranguard_require_env('DB_PASSWORD');

    $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";

    $pdo = new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
        // Session timezone left server-default (UTC storage per Rule 31);
        // Asia/Manila conversion happens in application/display code.
    ]);

    return $pdo;
}
