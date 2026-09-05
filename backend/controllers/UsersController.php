<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Auth\PasswordPolicy;
use Baranguard\Services\Auth\Username;
use PDO;

/**
 * GET /users — Master Reference §6 "Users & device lifecycle" section.
 * Not one of the endpoints CLAUDE.md originally listed as needed for
 * W3/W4, but built here as necessary plumbing: §9 W3's Tanod picker
 * needs Tanod full names, and `GET /duty-status?barangay_id=`'s
 * documented response shape (§6) is fixed to
 * `{user_id,status,channel,changed_at}` — no name. Same precedent as W2
 * building a minimal login page beyond its own checked box.
 *
 * `create` (W10 User Management, built as a follow-up to the
 * deactivate/reactivate cut) is Admin-only account creation, scoped to
 * the admin's own barangay. `reset-password` remains a separate,
 * unbuilt §6 endpoint.
 */
final class UsersController
{
    private const CONTACT_NUMBER_MAX_LENGTH = 32;
    private const ROLES = ['admin', 'secretary', 'tanod', 'punong_barangay', 'lupon'];
    // §3: Lupon has NO system account at all — they receive the generated
    // PDF packet, never a login. Deliberately excluded from what an Admin
    // can create here, even though ROLES above still lists it (used only
    // as a GET /users filter value, which is harmless if it simply never
    // matches any row).
    private const CREATABLE_ROLES = ['admin', 'secretary', 'tanod', 'punong_barangay'];
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $role = Http::query('role');
        if ($role !== null && !in_array($role, self::ROLES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'role must be one of: ' . implode(', ', self::ROLES) . '.');
        }

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($role !== null) {
            $where[] = 'role = :role';
            $params['role'] = $role;
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM user WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        // last_login_at (2026-09-05 UX pass): derived from `auth_session`
        // rather than a new `user` column — `issued_at` is set once per
        // login and never updated again, which is exactly "last login",
        // distinct from `auth_session.last_seen_at` (a rolling activity
        // timestamp touched on every authenticated request via sliding
        // renewal). No migration needed for this one; see
        // AuthController::login()'s own INSERT for where issued_at comes
        // from.
        $stmt = $pdo->prepare(
            "SELECT u.user_id, u.full_name, u.username, u.role, u.contact_number, u.is_active, u.is_suspended, u.created_at,
                    (SELECT MAX(s.issued_at) FROM auth_session s WHERE s.user_id = u.user_id) AS last_login_at
             FROM user u
             WHERE {$whereSql}
             ORDER BY u.full_name ASC
             LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'user_id' => (int) $row['user_id'],
                'full_name' => $row['full_name'],
                'username' => $row['username'],
                'role' => $row['role'],
                'contact_number' => $row['contact_number'],
                'is_active' => (bool) $row['is_active'],
                'is_suspended' => (bool) $row['is_suspended'],
                'created_at' => $row['created_at'],
                'last_login_at' => $row['last_login_at'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /**
     * POST /users — Admin creates a new account in their own barangay.
     * No Idempotency-Key/request_id token (unlike Incidents/Shifts):
     * `username` is globally UNIQUE, so a genuine retry and a real
     * conflict look identical and both correctly return 409 — the same
     * coarser pattern `MapPackagesController::create` already uses for
     * its own natural (barangay_id, version) key, rather than adding a
     * new column to `user` for a low-frequency admin action.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $body = Http::jsonBody();

        $usernameRaw = $body['username'] ?? null;
        if (!is_string($usernameRaw) || trim($usernameRaw) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'username is required.');
        }
        $username = Username::normalize($usernameRaw);
        if (!Username::isValid($username)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'username must be 3-64 characters: lowercase letters, digits, dot, underscore, or hyphen.');
        }

        $password = $body['password'] ?? null;
        if (!is_string($password)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'password is required.');
        }
        $policyError = PasswordPolicy::validate($password);
        if ($policyError !== null) {
            throw new ApiError(400, 'VALIDATION_ERROR', $policyError);
        }

        $fullName = $body['full_name'] ?? null;
        if (!is_string($fullName) || trim($fullName) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'full_name must be a non-empty string.');
        }

        $role = $body['role'] ?? null;
        if (!is_string($role) || !in_array($role, self::CREATABLE_ROLES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'role must be one of: ' . implode(', ', self::CREATABLE_ROLES) . '.');
        }

        $contactNumber = $body['contact_number'] ?? null;
        if ($contactNumber !== null && (!is_string($contactNumber) || strlen($contactNumber) > self::CONTACT_NUMBER_MAX_LENGTH)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'contact_number must be a string of at most ' . self::CONTACT_NUMBER_MAX_LENGTH . ' characters.');
        }

        // Clean 409 rather than a raw UNIQUE-constraint error from the insert.
        $dupStmt = $pdo->prepare('SELECT user_id FROM user WHERE username = :username LIMIT 1');
        $dupStmt->execute(['username' => $username]);
        if ($dupStmt->fetchColumn() !== false) {
            throw new ApiError(409, 'CONFLICT', 'That username is already taken.');
        }

        $passwordHash = password_hash($password, PASSWORD_ARGON2ID);

        $pdo->beginTransaction();
        try {
            $insertStmt = $pdo->prepare(
                'INSERT INTO user (barangay_id, username, password_hash, full_name, role, contact_number, is_active, created_at)
                 VALUES (:barangay_id, :username, :password_hash, :full_name, :role, :contact_number, 1, UTC_TIMESTAMP())'
            );
            $insertStmt->execute([
                'barangay_id' => $identity['barangay_id'],
                'username' => $username,
                'password_hash' => $passwordHash,
                'full_name' => $fullName,
                'role' => $role,
                'contact_number' => $contactNumber,
            ]);
            $newUserId = (int) $pdo->lastInsertId();

            // Rule 17's allow-list is identifiers and statuses only —
            // `username`/`full_name`/`contact_number` stay out of
            // metadata (same conservative call `update()`'s own audit
            // already makes), the new user_id is already the entity_id.
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'user_created', 'user', $newUserId, [
                'role' => $role,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(201, [
            'user_id' => $newUserId,
            'username' => $username,
            'full_name' => $fullName,
            'role' => $role,
            'contact_number' => $contactNumber,
            'is_active' => true,
        ]);
    }

    /**
     * PATCH /users/:id -- serves TWO paths per §6/§7:
     *
     *   1. Self edit (W15 Settings/Account): full_name/contact_number
     *      only, any role, no role gate beyond "must be this account".
     *   2. Admin editing another same-barangay user (W10 User
     *      Management, built this cut): is_active ONLY -- no role
     *      changes and no user creation, per this cut's own scoped
     *      decision (logged in DEVLOG.md). Deactivating revokes every
     *      active session for that user in the same transaction, and is
     *      refused with 409 if the target is the barangay's last active
     *      Admin. An Admin can never reach this path against their OWN
     *      user_id -- that always falls to path 1, which doesn't accept
     *      is_active, so self-deactivation is simply unreachable here.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function update(PDO $pdo, array $identity, string $userIdParam): void
    {
        if (!ctype_digit($userIdParam)) {
            throw new ApiError(403, 'FORBIDDEN', 'You may only edit your own account.');
        }
        $targetUserId = (int) $userIdParam;

        if ($targetUserId !== $identity['user_id']) {
            self::updateOtherUserStatus($pdo, $identity, $targetUserId);
            return;
        }

        $body = Http::jsonBody();
        $fullName = $body['full_name'] ?? null;
        $contactNumber = $body['contact_number'] ?? null;
        $hasFullName = array_key_exists('full_name', $body);
        $hasContactNumber = array_key_exists('contact_number', $body);

        if (!$hasFullName && !$hasContactNumber) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Provide full_name and/or contact_number to update.');
        }
        if ($hasFullName && (!is_string($fullName) || trim($fullName) === '')) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'full_name must be a non-empty string.');
        }
        if ($hasContactNumber && $contactNumber !== null && (!is_string($contactNumber) || strlen($contactNumber) > self::CONTACT_NUMBER_MAX_LENGTH)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'contact_number must be a string of at most ' . self::CONTACT_NUMBER_MAX_LENGTH . ' characters.');
        }

        $sets = [];
        $params = ['user_id' => $identity['user_id']];
        if ($hasFullName) {
            $sets[] = 'full_name = :full_name';
            $params['full_name'] = $fullName;
        }
        if ($hasContactNumber) {
            $sets[] = 'contact_number = :contact_number';
            $params['contact_number'] = $contactNumber;
        }
        $sets[] = 'updated_at = UTC_TIMESTAMP()';

        $stmt = $pdo->prepare('UPDATE user SET ' . implode(', ', $sets) . ' WHERE user_id = :user_id');
        $stmt->execute($params);

        // Rule 17 names "user changes/deactivation". This controller had
        // no audit coverage at all before Sprint 7's audit-completeness
        // cut. Metadata records WHICH fields changed, never the values:
        // `contact_number` is personal data and Rule 17's allow-list is
        // identifiers and statuses only.
        Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'user_updated', 'user', $identity['user_id'], [
            'fields' => implode(',', array_values(array_filter([
                $hasFullName ? 'full_name' : null,
                $hasContactNumber ? 'contact_number' : null,
            ]))),
            'self_edit' => 1,
        ]);

        Http::send(200, ['user_id' => $identity['user_id'], 'updated' => true]);
    }

    /**
     * Admin-editing-another-user path -- W10 User Management. Accepts
     * EXACTLY ONE of `is_active` or `is_suspended` (booleans) per call --
     * two independent state flags, not a single three-way enum, so
     * "reactivate" and "unsuspend" stay distinct actions even though both
     * can leave a user able to log in again. Cross-tenant or missing
     * target is 404, never 403 (§2 Rule 2 -- a 403 would confirm the row
     * exists in another barangay).
     *
     * `is_suspended` (migration 0011, 2026-09-05 UX pass) is a second,
     * independent hold distinct from `is_active` -- e.g. a disciplinary
     * suspension that shouldn't require re-entering the account through
     * full deactivation/reactivation. `AuthController::login()` rejects
     * either condition identically.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    private static function updateOtherUserStatus(PDO $pdo, array $identity, int $targetUserId): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $body = Http::jsonBody();
        $hasActive = array_key_exists('is_active', $body);
        $hasSuspended = array_key_exists('is_suspended', $body);
        if ($hasActive === $hasSuspended) {
            // Both false (neither given) or both true (both given) --
            // either way this request doesn't unambiguously ask for one
            // action.
            throw new ApiError(400, 'VALIDATION_ERROR', 'Provide exactly one of is_active or is_suspended (boolean).');
        }
        if ($hasActive && !is_bool($body['is_active'])) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'is_active must be a boolean.');
        }
        if ($hasSuspended && !is_bool($body['is_suspended'])) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'is_suspended must be a boolean.');
        }
        $suspendedReason = $body['suspended_reason'] ?? null;
        if ($suspendedReason !== null && (!is_string($suspendedReason) || strlen($suspendedReason) > 255)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'suspended_reason must be a string of at most 255 characters.');
        }

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'SELECT user_id, role, is_active, is_suspended FROM user
                 WHERE user_id = :user_id AND barangay_id = :barangay_id
                 FOR UPDATE'
            );
            $stmt->execute(['user_id' => $targetUserId, 'barangay_id' => $identity['barangay_id']]);
            $target = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($target === false) {
                // Rule 2: cross-tenant / nonexistent both read as 404.
                throw new ApiError(404, 'NOT_FOUND', 'User not found.');
            }

            $currentlyUsable = (bool) $target['is_active'] && !(bool) $target['is_suspended'];
            $nextActive = $hasActive ? (bool) $body['is_active'] : (bool) $target['is_active'];
            $nextSuspended = $hasSuspended ? (bool) $body['is_suspended'] : (bool) $target['is_suspended'];
            $nextUsable = $nextActive && !$nextSuspended;

            // "One usable Admin must remain" -- see the pre-existing
            // (is_active-only) version of this comment for why sequential
            // use structurally can't reach zero without this guard ever
            // firing; kept as defense-in-depth the same way, now checked
            // against USABLE (active AND not suspended) rather than just
            // active, since suspending is now an equally effective way to
            // take an Admin's access away.
            if ($target['role'] === 'admin' && $currentlyUsable && !$nextUsable) {
                $countStmt = $pdo->prepare(
                    "SELECT COUNT(*) FROM user
                     WHERE barangay_id = :barangay_id AND role = 'admin' AND is_active = 1 AND is_suspended = 0
                     FOR UPDATE"
                );
                $countStmt->execute(['barangay_id' => $identity['barangay_id']]);
                if ((int) $countStmt->fetchColumn() <= 1) {
                    throw new ApiError(409, 'CONFLICT', 'At least one active, non-suspended Admin must remain in this barangay.');
                }
            }

            if ($hasActive) {
                $pdo->prepare('UPDATE user SET is_active = :is_active, updated_at = UTC_TIMESTAMP() WHERE user_id = :user_id')
                    ->execute(['is_active' => $nextActive ? 1 : 0, 'user_id' => $targetUserId]);
            } else {
                // Two separate statements (suspend vs. unsuspend) rather
                // than one with a CASE expression -- this connection runs
                // with PDO::ATTR_EMULATE_PREPARES=false, which doesn't
                // support binding one named parameter into a query twice;
                // a CASE that reused :is_suspended for both branches would
                // hit the exact bug IncidentsController::index()'s `q=`
                // search did (see this session's DEVLOG entry). This is
                // also just clearer: two real states, two real statements.
                if ($nextSuspended) {
                    $pdo->prepare(
                        'UPDATE user SET is_suspended = 1, suspended_reason = :reason, suspended_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
                         WHERE user_id = :user_id'
                    )->execute(['reason' => $suspendedReason, 'user_id' => $targetUserId]);
                } else {
                    $pdo->prepare(
                        'UPDATE user SET is_suspended = 0, suspended_reason = NULL, suspended_at = NULL, updated_at = UTC_TIMESTAMP()
                         WHERE user_id = :user_id'
                    )->execute(['user_id' => $targetUserId]);
                }
            }

            if ($currentlyUsable && !$nextUsable) {
                // Same revocation statement AuthController uses for
                // password-change -- no "current jti" to exclude here,
                // this is always a different user's session(s). Now fires
                // for a fresh suspension too, not just deactivation --
                // both make the account unusable, and a live session
                // shouldn't outlive either.
                $pdo->prepare(
                    'UPDATE auth_session SET revoked_at = UTC_TIMESTAMP()
                     WHERE user_id = :user_id AND revoked_at IS NULL'
                )->execute(['user_id' => $targetUserId]);
            }

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'user_status_changed', 'user', $targetUserId, [
                'is_active' => $nextActive ? 1 : 0,
                'is_suspended' => $nextSuspended ? 1 : 0,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, ['user_id' => $targetUserId, 'updated' => true, 'is_active' => $nextActive, 'is_suspended' => $nextSuspended]);
    }
}
