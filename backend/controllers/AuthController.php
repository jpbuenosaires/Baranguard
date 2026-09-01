<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Auth\Jwt;
use Baranguard\Services\Auth\Username;
use PDO;

/**
 * POST /auth/login and POST /auth/logout — Master Reference §6 "Auth"
 * section, plus §2 Rule 9's session-lifecycle rules.
 */
final class AuthController
{
    // §2 Rule 9: "Failed-login handling is externally indistinguishable
    // for unknown, invalid-password, and locked-account cases." This is a
    // pre-computed Argon2id hash of an arbitrary string, used ONLY so an
    // unknown username still pays the same password_verify() cost as a
    // known one — it is not a real credential and never matches any real
    // password.
    private const DUMMY_HASH = '$argon2id$v=19$m=65536,t=4,p=1$NTQuTlJtUnhaVHBjMHlHVw$jiM71tWhw5bBkHF+pbZndSERQcgNlimNT6C6jmdptaI';

    // Lockout numbers: the schema (§5 `user` table: failed_login_attempts,
    // login_failure_window_started_at, locked_until) clearly expects a
    // lockout policy to exist, but no section of the reference states the
    // actual thresholds. Resolved decision, logged in DEVLOG.md: 5 failed
    // attempts inside a rolling 15-minute window locks the account for 15
    // minutes.
    private const MAX_FAILED_ATTEMPTS = 5;
    private const FAILURE_WINDOW_MINUTES = 15;
    private const LOCKOUT_MINUTES = 15;

    public static function login(PDO $pdo): void
    {
        $body = Http::jsonBody();
        $usernameRaw = $body['username'] ?? null;
        $password = $body['password'] ?? null;

        if (!is_string($usernameRaw) || trim($usernameRaw) === '' || !is_string($password) || $password === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'username and password are required.');
        }

        $username = Username::normalize($usernameRaw);

        $stmt = $pdo->prepare(
            "SELECT user_id, barangay_id, username, password_hash, full_name, role, is_active,
                    failed_login_attempts, login_failure_window_started_at, locked_until
             FROM user
             WHERE username = :username
             LIMIT 1"
        );
        $stmt->execute(['username' => $username]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $isLocked = $user !== false
            && $user['locked_until'] !== null
            && new \DateTimeImmutable($user['locked_until'] . ' UTC') > $now;

        // Always run password_verify — even for an unknown user (against
        // the dummy hash) and even for a locked account — so response
        // timing doesn't leak which case this was.
        $hashToCheck = $user !== false ? $user['password_hash'] : self::DUMMY_HASH;
        $passwordMatches = password_verify($password, $hashToCheck);

        $genericDenied = static function () use ($pdo, $user, $username): never {
            self::recordFailure($pdo, $user, $username);
            throw new ApiError(401, 'UNAUTHORIZED', 'Invalid username or password.');
        };

        if ($user === false) {
            $genericDenied();
        }
        // `lupon` is DB-enum-only, never an active login role (§3, §5 note).
        if ($user['role'] === 'lupon' || (int) $user['is_active'] !== 1) {
            $genericDenied();
        }
        if ($isLocked || !$passwordMatches) {
            $genericDenied();
        }

        // Success: reset lockout state, issue a session.
        $expiresInMinutes = (int) (getenv('JWT_EXPIRES_IN_MINUTES') ?: 15);
        $expiresAt = $now->add(new \DateInterval("PT{$expiresInMinutes}M"));
        $jti = self::generateUuidV4();

        $pdo->beginTransaction();
        try {
            $pdo->prepare(
                'UPDATE user
                 SET failed_login_attempts = 0, login_failure_window_started_at = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP()
                 WHERE user_id = :user_id'
            )->execute(['user_id' => $user['user_id']]);

            $pdo->prepare(
                'INSERT INTO auth_session (user_id, jti, issued_at, expires_at, ip_address, user_agent, last_seen_at)
                 VALUES (:user_id, :jti, UTC_TIMESTAMP(), :expires_at, :ip, :ua, UTC_TIMESTAMP())'
            )->execute([
                'user_id' => $user['user_id'],
                'jti' => $jti,
                'expires_at' => $expiresAt->format('Y-m-d H:i:s'),
                'ip' => $_SERVER['REMOTE_ADDR'] ?? null,
                'ua' => Http::header('User-Agent'),
            ]);

            self::audit($pdo, (int) $user['barangay_id'], (int) $user['user_id'], 'login_success', 'user', (int) $user['user_id'], ['username' => $username]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $token = Jwt::encode([
            'sub' => (int) $user['user_id'],
            'jti' => $jti,
            'role' => $user['role'],
            'barangay_id' => (int) $user['barangay_id'],
            'iat' => $now->getTimestamp(),
            'exp' => $expiresAt->getTimestamp(),
        ], (string) getenv('JWT_SECRET'));

        Http::send(200, [
            'token' => $token,
            'user' => [
                'user_id' => (int) $user['user_id'],
                'full_name' => $user['full_name'],
                'role' => $user['role'],
                'barangay_id' => (int) $user['barangay_id'],
            ],
            'expires_at' => $expiresAt->format('Y-m-d\TH:i:s\Z'),
        ]);
    }

    public static function logout(PDO $pdo): void
    {
        // Deliberately NOT AuthMiddleware::authenticate() — that rejects
        // an already-revoked session with 401, which would break §6's
        // "server ignores a second logout safely" on any repeat call.
        // resolveForLogout() only requires a validly-signed, unexpired
        // token tied to a real session row; it tolerates the session
        // already being revoked.
        $identity = AuthMiddleware::resolveForLogout($pdo);

        if (!$identity['alreadyRevoked']) {
            $stmt = $pdo->prepare(
                'UPDATE auth_session SET revoked_at = UTC_TIMESTAMP() WHERE jti = :jti AND revoked_at IS NULL'
            );
            $stmt->execute(['jti' => $identity['jti']]);
            self::audit($pdo, $identity['barangay_id'], $identity['user_id'], 'logout', 'auth_session', $identity['session_id'], []);
        }

        Http::send(200, ['success' => true]);
    }

    /** @param array<string,mixed>|false $user */
    private static function recordFailure(PDO $pdo, array|false $user, string $attemptedUsername): void
    {
        self::audit(
            $pdo,
            $user !== false ? (int) $user['barangay_id'] : null,
            $user !== false ? (int) $user['user_id'] : null,
            'login_failure',
            'user',
            $user !== false ? (int) $user['user_id'] : null,
            ['username' => $attemptedUsername]
        );

        if ($user === false) {
            return; // Nothing to lock — no account to charge the attempt against.
        }

        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $windowStart = $user['login_failure_window_started_at'] !== null
            ? new \DateTimeImmutable($user['login_failure_window_started_at'] . ' UTC')
            : null;
        $windowExpired = $windowStart === null
            || $windowStart->add(new \DateInterval('PT' . self::FAILURE_WINDOW_MINUTES . 'M')) <= $now;

        $newCount = $windowExpired ? 1 : ((int) $user['failed_login_attempts'] + 1);
        $newWindowStart = $windowExpired ? $now : $windowStart;
        $lockedUntil = $newCount >= self::MAX_FAILED_ATTEMPTS
            ? $now->add(new \DateInterval('PT' . self::LOCKOUT_MINUTES . 'M'))
            : null;

        $stmt = $pdo->prepare(
            'UPDATE user
             SET failed_login_attempts = :count,
                 login_failure_window_started_at = :window_start,
                 locked_until = :locked_until,
                 updated_at = UTC_TIMESTAMP()
             WHERE user_id = :user_id'
        );
        $stmt->execute([
            'count' => $newCount,
            'window_start' => $newWindowStart->format('Y-m-d H:i:s'),
            'locked_until' => $lockedUntil?->format('Y-m-d H:i:s'),
            'user_id' => $user['user_id'],
        ]);
    }

    /** @param array<string,mixed> $metadata allow-listed only — never raw narrative or credentials (§2 Rule 17). */
    private static function audit(PDO $pdo, ?int $barangayId, ?int $actorUserId, string $action, string $entityType, ?int $entityId, array $metadata): void
    {
        $stmt = $pdo->prepare(
            'INSERT INTO audit_log (barangay_id, actor_user_id, action, entity_type, entity_id, metadata_json, ip_address, user_agent, created_at)
             VALUES (:barangay_id, :actor_user_id, :action, :entity_type, :entity_id, :metadata_json, :ip, :ua, UTC_TIMESTAMP())'
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'actor_user_id' => $actorUserId,
            'action' => $action,
            'entity_type' => $entityType,
            'entity_id' => $entityId,
            'metadata_json' => json_encode($metadata, JSON_UNESCAPED_SLASHES),
            'ip' => $_SERVER['REMOTE_ADDR'] ?? null,
            'ua' => Http::header('User-Agent'),
        ]);
    }

    private static function generateUuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
