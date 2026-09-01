<?php
declare(strict_types=1);

namespace Baranguard\Services\Auth;

/**
 * Canonical password composition policy. Master Reference §2 Rule 9 says
 * "Passwords use Argon2id with the password policy in §6" — but §6 never
 * actually states composition rules anywhere; this is a gap in the
 * reference, not a rule this file is choosing to ignore. Sprint 0's
 * bootstrap-admin.js (Node) shipped a documented stopgap (12+ chars,
 * upper+lower+digit) specifically flagged as "revisit when
 * POST /auth/login / password-policy enforcement is implemented" — this
 * is that revisit. Kept identical to the Node stopgap rather than
 * inventing a stricter/different rule, so the same password that passes
 * bootstrap also passes change-password later; logged as the now-canonical
 * policy in DEVLOG.md. The two implementations can't literally share code
 * across PHP/Node, so keep them in sync by hand if this ever changes.
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
