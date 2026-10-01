<?php
declare(strict_types=1);

namespace Baranguard\Lib;

use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * Who may note/approve what, independent of the account's `role`
 * (docs/FEATURE_CONTRACT_2026-10.md §2). A barangay official such as a
 * Kagawad or the Chief Tanod has a web account whose role is one of
 * admin / secretary / punong_barangay; what they may SIGN is a separate,
 * Admin-managed attribute (`user.approval_authority`, a MariaDB SET added
 * by migration 0030). Never inferred from role alone, never a client claim.
 *
 * The preparer of a document may never also approve it
 * ({@see self::assertNotPreparer()}), a rule shared by the accomplishment
 * report and the Annex D term report.
 */
final class ApprovalAuthority
{
    public const NOTE_REPORT = 'note_report';
    public const APPROVE_REPORT = 'approve_report';
    public const APPROVE_ROSTER = 'approve_roster';
    public const PREPARE_ANNEX_D = 'prepare_annex_d';
    public const APPROVE_ANNEX_D = 'approve_annex_d';

    public const ALL = [
        self::NOTE_REPORT,
        self::APPROVE_REPORT,
        self::APPROVE_ROSTER,
        self::PREPARE_ANNEX_D,
        self::APPROVE_ANNEX_D,
    ];

    /** Roles that may ever hold an authority (a tanod never signs). */
    public const ELIGIBLE_ROLES = ['admin', 'secretary', 'punong_barangay'];

    /** @return list<string> authorities currently held by this user. */
    public static function listFor(PDO $pdo, int $userId): array
    {
        $stmt = $pdo->prepare('SELECT approval_authority FROM user WHERE user_id = :id AND is_active = 1 LIMIT 1');
        $stmt->execute(['id' => $userId]);
        $value = $stmt->fetchColumn();
        if (!is_string($value) || $value === '') {
            return [];
        }
        return array_values(array_intersect(self::ALL, explode(',', $value)));
    }

    public static function has(PDO $pdo, int $userId, string $authority): bool
    {
        return in_array($authority, self::listFor($pdo, $userId), true);
    }

    /**
     * 403 unless the caller's role is eligible AND they hold the authority.
     * Audited like any other authorization denial.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function require(PDO $pdo, array $identity, string $authority): void
    {
        AuthMiddleware::requireRole($identity, self::ELIGIBLE_ROLES);
        if (!self::has($pdo, $identity['user_id'], $authority)) {
            throw new ApiError(403, 'FORBIDDEN', 'You are not designated to perform this action.');
        }
    }

    /** Segregation of duties: the preparer cannot also note/approve. */
    public static function assertNotPreparer(int $actorUserId, int $preparerUserId): void
    {
        if ($actorUserId === $preparerUserId) {
            throw new ApiError(409, 'CONFLICT', 'The preparer cannot also approve their own document.');
        }
    }

    /** @param mixed $value @return list<string>|null null when invalid */
    public static function normalize(mixed $value): ?array
    {
        if (!is_array($value)) {
            return null;
        }
        $clean = [];
        foreach ($value as $entry) {
            if (!is_string($entry) || !in_array($entry, self::ALL, true)) {
                return null;
            }
            $clean[$entry] = true;
        }
        return array_keys($clean);
    }
}
