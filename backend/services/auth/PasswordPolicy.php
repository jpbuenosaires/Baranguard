<?php
declare(strict_types=1);

namespace Baranguard\Services\Auth;

/**
 * Canonical password composition policy: 12+ chars with lower, upper and a
 * digit. Identical to bootstrap-admin.js (Node), so a password that passes
 * bootstrap also passes change-password. The two can't share code across
 * PHP/Node; keep them in sync by hand.
 */
final class PasswordPolicy
{
    /** @return string|null null when the password satisfies the policy, else a user-facing reason. */
    public static function validate(string $password): ?string
    {
        if (strlen($password) < 12) {
            return 'Password must be at least 12 characters.';
        }
        if (!preg_match('/[a-z]/', $password)) {
            return 'Password must include a lowercase letter.';
        }
        if (!preg_match('/[A-Z]/', $password)) {
            return 'Password must include an uppercase letter.';
        }
        if (!preg_match('/[0-9]/', $password)) {
            return 'Password must include a digit.';
        }
        return null;
    }
}
