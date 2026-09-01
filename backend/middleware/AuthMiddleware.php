<?php
declare(strict_types=1);

namespace Baranguard\Middleware;

use Baranguard\Lib\ApiError;
use Baranguard\Services\Auth\Jwt;
use Baranguard\Services\Auth\JwtException;
use PDO;

/**
 * Shared request authentication/authorization. Master Reference §2 Rule 9:
 * "Every authenticated request verifies signature, allowed algorithm,
 * expiry, session existence, session revocation, user activation state,
 * and tenant identity." This is that check, in one place, so every
 * controller Sprint 1+ adds calls the same path instead of re-deriving it
 * — the whole point of this session's "shared middleware" cut.
 *
 * Usage from a controller:
 *   $identity = AuthMiddleware::authenticate($pdo);
 *   AuthMiddleware::requireRole($identity, ['admin']);
 *   AuthMiddleware::requireTenant($identity, $resource['barangay_id']);
 *
 * `authenticate()` never authorizes role/tenant — that's deliberately
 * separate (§2 Rule 6: RBAC and object ownership are enforced server-side,
 * per endpoint) so a controller can't accidentally skip the role/tenant
 * check just because it called authenticate().
 */
final class AuthMiddleware
{
    // Sliding renewal: §6 says a valid session's expiry may be extended;
    // it doesn't say how eagerly. Renewing only once remaining life drops
    // below half the token lifetime avoids a write on every single
    // request while still keeping an active user's session alive
    // indefinitely. Logged as a resolved decision (not stated in the
    // reference) in DEVLOG.md.
    private const RENEW_WHEN_REMAINING_FRACTION = 0.5;

    /**
     * @return array{user_id:int,barangay_id:int,role:string,jti:string,session_id:int,renewedToken:?string}
     */
    public static function authenticate(PDO $pdo): array
    {
        $token = \Baranguard\Lib\Http::bearerToken();
        if ($token === null) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header.');
        }

        $secret = getenv('JWT_SECRET');
        if ($secret === false || $secret === '') {
            // A missing secret is a server misconfiguration, not a client
            // error — never blame the caller's token for this.
            throw new ApiError(500, 'SERVER_ERROR', 'Server authentication is not configured.');
        }

        try {
            $claims = Jwt::decode($token, $secret);
        } catch (JwtException) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token.');
        }

        $jti = $claims['jti'] ?? null;
        $userId = $claims['sub'] ?? null;
        if (!is_string($jti) || $jti === '' || !is_int($userId)) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token.');
        }

        // Session existence + revocation, matched against the token's own
        // claims — never trust exp/role/barangay_id from the JWT alone;
        // the database session + user rows are authoritative.
        $stmt = $pdo->prepare(
            'SELECT s.session_id, s.expires_at, s.revoked_at,
                    u.user_id, u.barangay_id, u.role, u.is_active
             FROM auth_session s
             JOIN user u ON u.user_id = s.user_id
             WHERE s.jti = :jti
             LIMIT 1'
        );
        $stmt->execute(['jti' => $jti]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row === false || (int) $row['user_id'] !== $userId) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token.');
        }
        if ($row['revoked_at'] !== null) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token.');
        }
        $expiresAt = strtotime($row['expires_at'] . ' UTC');
        if ($expiresAt === false || $expiresAt <= time()) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token.');
        }
        if ((int) $row['is_active'] !== 1) {
            // Deactivation is supposed to revoke sessions transactionally
            // (§6 PATCH /users/:id) — this is defense in depth for the
            // window between deactivation and that revocation landing.
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token.');
        }

        $renewedToken = self::maybeRenew($pdo, (int) $row['session_id'], $jti, (int) $row['user_id'], (int) $row['barangay_id'], (string) $row['role'], $expiresAt);

        return [
            'user_id' => (int) $row['user_id'],
            'barangay_id' => (int) $row['barangay_id'],
            'role' => (string) $row['role'],
            'jti' => $jti,
            'session_id' => (int) $row['session_id'],
            'renewedToken' => $renewedToken,
        ];
    }

    /**
     * A deliberately looser resolver, for logout only. §6: "The server
     * ignores a second logout safely" — but the strict authenticate()
     * above rejects an already-revoked session with 401, so a repeat
     * logout call (client retry, double-click, race between two tabs)
     * would fail instead of getting the idempotent {success:true} the
     * spec asks for. This still requires a validly-signed, unexpired JWT
     * matching a real session row (so a forged/garbage token still gets
     * 401) — it just doesn't reject an already-revoked or deactivated-user
     * session, since "log out of a session that's already logged out" is
     * a no-op, not an auth failure.
     *
     * @return array{user_id:int,barangay_id:int,role:string,jti:string,session_id:int,alreadyRevoked:bool}
     */
    public static function resolveForLogout(PDO $pdo): array
    {
        $token = \Baranguard\Lib\Http::bearerToken();
        if ($token === null) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header.');
        }

        $secret = getenv('JWT_SECRET');
        if ($secret === false || $secret === '') {
            throw new ApiError(500, 'SERVER_ERROR', 'Server authentication is not configured.');
        }

        try {
            $claims = Jwt::decode($token, $secret);
        } catch (JwtException) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token.');
        }

        $jti = $claims['jti'] ?? null;
        $userId = $claims['sub'] ?? null;
        if (!is_string($jti) || $jti === '' || !is_int($userId)) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token.');
        }

        $stmt = $pdo->prepare(
            'SELECT s.session_id, s.revoked_at, u.user_id, u.barangay_id, u.role
             FROM auth_session s
             JOIN user u ON u.user_id = s.user_id
             WHERE s.jti = :jti
             LIMIT 1'
        );
        $stmt->execute(['jti' => $jti]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($row === false || (int) $row['user_id'] !== $userId) {
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token.');
        }

        return [
            'user_id' => (int) $row['user_id'],
            'barangay_id' => (int) $row['barangay_id'],
            'role' => (string) $row['role'],
            'jti' => $jti,
            'session_id' => (int) $row['session_id'],
            'alreadyRevoked' => $row['revoked_at'] !== null,
        ];
    }

    /** @param string[] $allowedRoles */
    public static function requireRole(array $identity, array $allowedRoles): void
    {
        if (!in_array($identity['role'], $allowedRoles, true)) {
            throw new ApiError(403, 'FORBIDDEN', 'This role cannot perform this action.');
        }
    }

    /**
     * §2 Rule 8: the four barangays are isolated tenants; every
     * resource-scoped endpoint must enforce this, not just role.
     */
    public static function requireTenant(array $identity, int $resourceBarangayId): void
    {
        if ($identity['barangay_id'] !== $resourceBarangayId) {
            // 404, not 403 — existence of another tenant's resource is
            // itself information the caller isn't entitled to.
            throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
        }
    }

    private static function maybeRenew(PDO $pdo, int $sessionId, string $jti, int $userId, int $barangayId, string $role, int $currentExpiresAt): ?string
    {
        $expiresInMinutes = (int) (getenv('JWT_EXPIRES_IN_MINUTES') ?: 15);
        $lifetimeSeconds = $expiresInMinutes * 60;
        $remaining = $currentExpiresAt - time();

        if ($remaining > $lifetimeSeconds * self::RENEW_WHEN_REMAINING_FRACTION) {
            return null; // Still fresh enough — don't write every request.
        }

        $newExpiresAt = time() + $lifetimeSeconds;
        // Non-decreasing per §6: only ever push the expiry forward.
        if ($newExpiresAt <= $currentExpiresAt) {
            return null;
        }

        $stmt = $pdo->prepare(
            'UPDATE auth_session
             SET expires_at = :expires_at, last_renewed_at = UTC_TIMESTAMP(), last_seen_at = UTC_TIMESTAMP()
             WHERE session_id = :session_id AND revoked_at IS NULL'
        );
        $stmt->execute([
            'expires_at' => gmdate('Y-m-d H:i:s', $newExpiresAt),
            'session_id' => $sessionId,
        ]);
        if ($stmt->rowCount() === 0) {
            return null; // Lost a race with a revocation — don't hand out a token for a dead session.
        }

        return Jwt::encode([
            'sub' => $userId,
            'jti' => $jti,
            'role' => $role,
            'barangay_id' => $barangayId,
            'iat' => time(),
            'exp' => $newExpiresAt,
        ], getenv('JWT_SECRET'));
    }
}
