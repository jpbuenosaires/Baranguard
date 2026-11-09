<?php
declare(strict_types=1);

namespace Baranguard\Services\Auth;

/**
 * Username normalization is deterministic: trim, lowercase, then validate
 * (3-64 chars: lowercase letters, digits, dot, underscore, hyphen) and
 * persist the normalized value before any uniqueness/authentication check.
 * Matches bootstrap-admin.js exactly.
 */
final class Username
{
    private const PATTERN = '/^[a-z0-9._-]{3,64}$/';

    public static function normalize(string $raw): string
    {
        return strtolower(trim($raw));
    }

    public static function isValid(string $normalized): bool
    {
        return (bool) preg_match(self::PATTERN, $normalized);
    }
}
