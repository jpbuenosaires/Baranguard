<?php
declare(strict_types=1);

namespace Baranguard\Lib;

use Baranguard\Services\Scheduling\RosterSupport;
use PDO;

/**
 * Shared pieces of the paper-signature flow used by the accomplishment
 * report and the Annex D term report (migration 0037):
 *
 *   POST .../paper-signature        record/overwrite the date written on the
 *                                   signed paper of an APPROVED report
 *   POST .../record-paper-approval  record an approval that happened on paper,
 *                                   advancing noted/prepared -> approved
 *
 * Baranguard is the working copy, not the legal original: the paper stays
 * the signed record, and this only tracks that it exists, who recorded it
 * and when. Both endpoints are admin|secretary and need an Idempotency-Key.
 */
final class PaperApproval
{
    public const MODE_DIGITAL = 'digital';
    public const MODE_PAPER = 'recorded_from_paper';

    /** A paper date may not be a future Manila date. Strict YYYY-MM-DD, else 400. */
    public static function requirePastOrTodayDate(mixed $value, string $field): string
    {
        $date = RosterSupport::parseDate($value, $field);
        if ($date > RosterSupport::manilaToday()) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} cannot be in the future.");
        }
        return $date;
    }

    /** @return int a positive integer id (int or all-digit string), else 400. */
    public static function requirePositiveInt(mixed $value, string $field): int
    {
        if (is_string($value) && ctype_digit($value) && strlen($value) <= 18) {
            $value = (int) $value;
        }
        if (!is_int($value) || $value < 1) {
            throw new ApiError(400, 'VALIDATION_ERROR', "{$field} must be a positive integer.");
        }
        return $value;
    }

    /**
     * Resolves the person who signed on paper. They must be an active,
     * unsuspended user of the SAME barangay with an eligible role holding
     * `$authority`.
     *
     *  - another barangay's user / unknown id  -> 404 (cross-tenant never
     *    confirms existence)
     *  - same barangay but not able to sign    -> 422
     *
     * @return array{user_id:int,barangay_id:int,role:string}
     */
    public static function requireSigner(PDO $pdo, int $barangayId, int $signerUserId, string $authority): array
    {
        $stmt = $pdo->prepare(
            'SELECT user_id, barangay_id, role, is_active, is_suspended, approval_authority
             FROM user WHERE user_id = :id AND barangay_id = :b LIMIT 1'
        );
        $stmt->execute(['id' => $signerUserId, 'b' => $barangayId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Signer not found.');
        }
        $held = $row['approval_authority'] === null || $row['approval_authority'] === ''
            ? []
            : explode(',', (string) $row['approval_authority']);
        if ((int) $row['is_active'] !== 1
            || (int) $row['is_suspended'] === 1
            || !in_array($row['role'], ApprovalAuthority::ELIGIBLE_ROLES, true)
            || !in_array($authority, $held, true)
        ) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'The named signer is not designated to approve this document.');
        }
        return ['user_id' => (int) $row['user_id'], 'barangay_id' => (int) $row['barangay_id'], 'role' => (string) $row['role']];
    }

    /**
     * Has this Idempotency-Key already produced `$action` for this entity?
     * Scoped by entity type as well (an accomplishment report and a term
     * report can share a numeric id).
     */
    public static function isReplay(PDO $pdo, int $barangayId, string $action, string $entityType, int $entityId, string $key): bool
    {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM audit_log
              WHERE barangay_id = :b AND action = :a AND entity_type = :t AND entity_id = :e AND idempotency_key = :k
              LIMIT 1'
        );
        $stmt->execute(['b' => $barangayId, 'a' => $action, 't' => $entityType, 'e' => $entityId, 'k' => $key]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * The four paper fields every report object carries.
     *
     * `paper_pending` is true when the report is `approved` and nobody has
     * recorded the date of the signed paper yet. It is computed here, never
     * stored.
     *
     * @param array<string,mixed> $row            report row (needs status, approval_mode, paper_*)
     * @param string|null         $recorderName   full name of paper_recorded_by, when known
     * @return array<string,mixed>
     */
    public static function fields(array $row, ?string $recorderName): array
    {
        $signedOn = $row['paper_signed_on'] ?? null;
        $recordedAt = $row['paper_recorded_at'] ?? null;
        return [
            'approval_mode' => $row['approval_mode'] ?? self::MODE_DIGITAL,
            'paper_signed_on' => $signedOn,
            'paper_recorded_by_name' => $recorderName,
            'paper_recorded_at' => $recordedAt === null
                ? null
                : (new \DateTimeImmutable((string) $recordedAt, new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z'),
            'paper_pending' => ($row['status'] ?? null) === 'approved' && $signedOn === null,
        ];
    }
}
