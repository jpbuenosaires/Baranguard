<?php
declare(strict_types=1);

namespace Baranguard\Services\Auth;

/**
 * Master Reference §5 (`user` table note): "Username normalization is
 * deterministic: trim surrounding whitespace, convert to lowercase using
 * application-defined ASCII username rules, then validate and persist the
 * normalized value before uniqueness/authentication checks." The ASCII
 * shape (3-64 chars: lowercase letters, digits, dot, underscore, hyphen)
 * matches Sprint 0's bootstrap-admin.js exactly, for the same reason as
 * PasswordPolicy — one definition of "valid username" across the system.
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
