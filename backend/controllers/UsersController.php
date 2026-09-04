<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /users — Master Reference §6 "Users & device lifecycle" section.
 * Not one of the endpoints CLAUDE.md originally listed as needed for
 * W3/W4, but built here as necessary plumbing: §9 W3's Tanod picker
 * needs Tanod full names, and `GET /duty-status?barangay_id=`'s
 * documented response shape (§6) is fixed to
 * `{user_id,status,channel,changed_at}` — no name. Same precedent as W2
 * building a minimal login page beyond its own checked box. Only `index`
 * (list) is built; create/edit/reset-password are separate, unbuilt §6
 * endpoints.
 */
final class UsersController
{
    private const CONTACT_NUMBER_MAX_LENGTH = 32;
    private const ROLES = ['admin', 'secretary', 'tanod', 'punong_barangay', 'lupon'];
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

        $stmt = $pdo->prepare(
            "SELECT user_id, full_name, username, role, contact_number, is_active, created_at
             FROM user
             WHERE {$whereSql}
             ORDER BY full_name ASC
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
                'created_at' => $row['created_at'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /**
     * PATCH /users/:id -- W15 Settings/Account's "edit my name/contact"
     * action. Section 6/Section 7 describe this endpoint as serving TWO
     * paths (Admin editing same-barangay others, with a role/is_active/
     * session-revocation cascade; and self editing only
     * full_name/contact_number) -- only the self path is built here. W10
     * User Management (admin-editing-others) is a separate, unbuilt
     * screen with its own design needs (which fields toggle is_active,
     * the device/session revocation transaction, "at least one active
     * Admin must remain"); half-building that risked getting it wrong, so
     * a caller here may only ever edit their own row and only ever change
     * full_name/contact_number -- any other user_id is rejected with 403.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function update(PDO $pdo, array $identity, string $userIdParam): void
    {
        if (!ctype_digit($userIdParam) || (int) $userIdParam !== $identity['user_id']) {
            throw new ApiError(403, 'FORBIDDEN', 'You may only edit your own account.');
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
}
