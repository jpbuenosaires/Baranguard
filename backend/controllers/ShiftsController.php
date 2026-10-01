<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Lib\ApprovalAuthority;
use Baranguard\Services\Scheduling\FatigueCalculator;
use Baranguard\Services\Scheduling\RosterSupport;
use PDO;

/**
 * Shifts — Master Reference §6 "Shifts and fatigue" section, §5
 * `shift_schedule` table, §9 W11 Shift & Roster Scheduler ("Week view
 * uses real start_at/end_at. Overlaps are rejected. Fatigue recalculates
 * on create/edit/reassignment and shows its calculation basis.").
 *
 * Resolved decisions, logged in DEVLOG.md:
 *   - **`barangay_id?` in the POST body is accepted but ignored.** Every
 *     other write endpoint in this codebase derives tenant strictly from
 *     the caller's own session (§2 Rule: never trust request JSON for
 *     identity/tenant) — the `?` marking it optional in §6 doesn't carry
 *     license to trust a client-supplied barangay over the Admin's own
 *     token, so this endpoint does the same as `POST /users`/`POST
 *     /incidents`: barangay always comes from `$identity`.
 *   - **Overlap check is a plain time-range intersection**
 *     (`start_at < :end_at AND end_at > :start_at`) for the *same*
 *     Tanod, locked via `SELECT ... FOR UPDATE` before insert/update so
 *     two concurrent requests can't both pass the check and create
 *     overlapping shifts for the same person.
 *   - **`user_id` is nullable** (migration 0003 — see that file's own
 *     doc) so `PATCH /shift-swap-requests/:id` can actually leave a shift
 *     "unassigned" per §6, and so an Admin can directly unassign a shift
 *     via a normal edit (`user_id: null`) without needing the swap-
 *     request flow. A currently-unassigned shift has no user to validate/
 *     lock against and contributes nothing to anyone's fatigue total.
 *   - **`GET /shifts` ordering**: `start_at ASC` — §6 doesn't state one,
 *     but a week/roster view needs chronological order, not insertion
 *     order.
 *   - version is included in GET /shifts and POST /shifts responses even
 *     though Section 6's documented list item shape omits it. This isn't
 *     an invented field -- version already exists on the table and is
 *     required by the very next endpoint in the same section (PATCH
 *     /shifts/:id's optimistic-concurrency check); a client has no other
 *     way to learn the current version to send back. Treated as a
 *     mechanical spec gap (the paired write endpoint cannot function
 *     without it), not an architectural fork, so fixed without pausing
 *     to ask -- unlike the user_id nullability question, which changed
 *     the schema itself.
 */
final class ShiftsController
{
    private const UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;

    /**
     * docs/FEATURE_CONTRACT_2026-10.md section 8 (replaces H-17's
     * `MIN_REST_HOURS` = 8 and "at least 1 Tanod on duty per shift" hard
     * blocks, both removed): a Tanod may be scheduled for at most this many
     * hours within one Asia/Manila calendar day (hard 422
     * `DAILY_HOURS_EXCEEDED`). Barangay coverage is no longer a block; it is
     * reported as `NO_COVERAGE` warnings by `publish()`.
     */
    public const MAX_DAILY_SCHEDULED_HOURS = 12;

    /** Hard cap on how many shifts one publish call may name (contract section 3). */
    private const MAX_PUBLISH_BATCH = 100;

    /** Upper bound on how many calendar dates `publish()` scans for coverage warnings. */
    private const MAX_COVERAGE_SCAN_DAYS = 366;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);

        $body = Http::jsonBody();
        $userId = $body['user_id'] ?? null;
        $patrolZone = $body['patrol_zone'] ?? null;
        $requestId = $body['request_id'] ?? null;

        if (!is_int($userId) && !(is_string($userId) && ctype_digit($userId))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'user_id is required.');
        }
        $userId = (int) $userId;
        if (!is_string($requestId) || !preg_match(self::UUID_PATTERN, $requestId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'request_id must be a UUID.');
        }
        [$startAt, $endAt] = self::parseTimeRange($body['start_at'] ?? null, $body['end_at'] ?? null);
        if ($patrolZone !== null && !is_string($patrolZone)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'patrol_zone must be a string.');
        }
        $sourceAvailabilityId = $body['source_availability_id'] ?? null;
        if ($sourceAvailabilityId !== null) {
            if (!is_int($sourceAvailabilityId) && !(is_string($sourceAvailabilityId) && ctype_digit($sourceAvailabilityId))) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'source_availability_id must be an integer.');
            }
            $sourceAvailabilityId = (int) $sourceAvailabilityId;
        }

        // Idempotency: a retry with the same request_id returns the
        // original shift instead of creating a duplicate (§6).
        $existingStmt = $pdo->prepare(
            'SELECT shift_id, user_id, patrol_zone, start_at, end_at, version,
                    approval_status, approved_by, approved_at, source_availability_id
             FROM shift_schedule WHERE client_request_id = :request_id AND barangay_id = :barangay_id LIMIT 1'
        );
        $existingStmt->execute(['request_id' => $requestId, 'barangay_id' => $identity['barangay_id']]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            Http::send(200, self::mapShift($existing));
        }

        $pdo->beginTransaction();
        try {
            self::assertTanodEligible($pdo, $userId, $identity['barangay_id']);
            self::assertNoOverlap($pdo, $userId, $startAt, $endAt, null);
            self::assertDailyHoursCap($pdo, $userId, $startAt, $endAt, null);
            if ($sourceAvailabilityId !== null) {
                self::assertSourceAvailability($pdo, $sourceAvailabilityId, $userId, $identity['barangay_id']);
            }

            // approval_status is left to its column default ('draft'):
            // a new shift is never visible to the Tanod until published.
            $insertStmt = $pdo->prepare(
                'INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, client_request_id, source_availability_id)
                 VALUES (:barangay_id, :user_id, :patrol_zone, :start_at, :end_at, :created_by, :request_id, :source_availability_id)'
            );
            $insertStmt->execute([
                'barangay_id' => $identity['barangay_id'],
                'user_id' => $userId,
                'patrol_zone' => $patrolZone,
                'start_at' => $startAt->format('Y-m-d H:i:s'),
                'end_at' => $endAt->format('Y-m-d H:i:s'),
                'created_by' => $identity['user_id'],
                'request_id' => $requestId,
                'source_availability_id' => $sourceAvailabilityId,
            ]);
            $shiftId = (int) $pdo->lastInsertId();

            FatigueCalculator::recalculate($pdo, $userId, $shiftId);

            // Rule 17 names "shift changes" explicitly. This controller
            // had no audit coverage at all before Sprint 7's
            // audit-completeness cut.
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'shift_created', 'shift_schedule', $shiftId, [
                'user_id' => $userId,
                'patrol_zone' => $patrolZone,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(201, [
            'shift_id' => $shiftId,
            'user_id' => $userId,
            'patrol_zone' => $patrolZone,
            'start_at' => $startAt->format('Y-m-d\TH:i:s\Z'),
            'end_at' => $endAt->format('Y-m-d\TH:i:s\Z'),
            'version' => 1,
            'approval_status' => 'draft',
            'approved_by' => null,
            'approved_at' => null,
            'source_availability_id' => $sourceAvailabilityId,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        // Contract section 3: a Tanod sees ONLY their own published shifts;
        // admin / secretary / punong_barangay (the approver of a roster is
        // usually the Punong Barangay) see every shift in the barangay and
        // may filter on approval_status.
        AuthMiddleware::requireRole($identity, ['admin', 'secretary', 'punong_barangay', 'tanod']);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $where = ['barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($identity['role'] === 'tanod') {
            $where[] = 'user_id = :user_id';
            $params['user_id'] = $identity['user_id'];
            $where[] = "approval_status = 'published'";
        } else {
            $approvalFilter = Http::query('approval_status');
            if ($approvalFilter !== null) {
                if (!in_array($approvalFilter, ['draft', 'published'], true)) {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'approval_status must be draft or published.');
                }
                $where[] = 'approval_status = :approval_status';
                $params['approval_status'] = $approvalFilter;
            }
        }
        $whereSql = implode(' AND ', $where);

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM shift_schedule WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT shift_id, user_id, patrol_zone, start_at, end_at, version,
                    approval_status, approved_by, approved_at, source_availability_id
             FROM shift_schedule
             WHERE {$whereSql}
             ORDER BY start_at ASC
             LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        Http::send(200, [
            'items' => array_map([self::class, 'mapShift'], $rows),
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function update(PDO $pdo, array $identity, string $shiftIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin']);
        if (!ctype_digit($shiftIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Shift not found.');
        }
        $shiftId = (int) $shiftIdParam;

        $body = Http::jsonBody();
        $version = $body['version'] ?? null;
        if (!is_int($version) && !(is_string($version) && ctype_digit($version))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'version is required.');
        }
        $version = (int) $version;

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT * FROM shift_schedule WHERE shift_id = :shift_id FOR UPDATE');
            $stmt->execute(['shift_id' => $shiftId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Shift not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);
            if ((int) $row['version'] !== $version) {
                throw new ApiError(409, 'CONFLICT', 'This shift was changed by someone else — reload and try again.');
            }

            $hasUserId = array_key_exists('user_id', $body);
            $newUserId = $hasUserId ? $body['user_id'] : (int) $row['user_id'];
            if ($hasUserId && $newUserId !== null) {
                if (!is_int($newUserId) && !(is_string($newUserId) && ctype_digit($newUserId))) {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'user_id must be an integer or null.');
                }
                $newUserId = (int) $newUserId;
            }
            $newPatrolZone = array_key_exists('patrol_zone', $body) ? $body['patrol_zone'] : $row['patrol_zone'];
            if ($newPatrolZone !== null && !is_string($newPatrolZone)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'patrol_zone must be a string.');
            }
            // A field the caller didn't touch falls back to the DB's own
            // naive-UTC value (default timezone UTC for that one); a
            // field the caller did supply is a fresh client string
            // (default timezone Asia/Manila) — see parseTimestamp()'s doc.
            $utc = new \DateTimeZone('UTC');
            $manila = new \DateTimeZone('Asia/Manila');
            $newStartAt = array_key_exists('start_at', $body)
                ? self::parseTimestamp($body['start_at'], $manila)
                : self::parseTimestamp($row['start_at'], $utc);
            $newEndAt = array_key_exists('end_at', $body)
                ? self::parseTimestamp($body['end_at'], $manila)
                : self::parseTimestamp($row['end_at'], $utc);
            if ($newStartAt >= $newEndAt) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'start_at must be before end_at.');
            }

            $oldUserId = $row['user_id'] !== null ? (int) $row['user_id'] : null;
            if ($newUserId !== null) {
                self::assertTanodEligible($pdo, $newUserId, $identity['barangay_id']);
                self::assertNoOverlap($pdo, $newUserId, $newStartAt, $newEndAt, $shiftId);
                self::assertDailyHoursCap($pdo, $newUserId, $newStartAt, $newEndAt, $shiftId);
            }
            // Unassigning (user_id -> null) is no longer blocked on coverage
            // grounds (contract section 8): zero coverage is surfaced as a
            // NO_COVERAGE warning when the roster is published instead.

            // A published shift is the roster an approver signed off on. If its
            // assignee or its times change, that approval no longer describes the
            // shift: revert to draft and clear the approval (needs a fresh
            // approve_roster publish). A patrol_zone-only edit keeps it published.
            $startChanged = $newStartAt->format('Y-m-d H:i:s') !== (string) $row['start_at'];
            $endChanged = $newEndAt->format('Y-m-d H:i:s') !== (string) $row['end_at'];
            $materialChange = $newUserId !== $oldUserId || $startChanged || $endChanged;
            $approvalReset = $materialChange && ($row['approval_status'] ?? 'draft') === 'published';
            $approvalSql = $approvalReset
                ? ", approval_status = 'draft', approved_by = NULL, approved_at = NULL"
                : '';

            $pdo->prepare(
                'UPDATE shift_schedule
                 SET user_id = :user_id, patrol_zone = :patrol_zone, start_at = :start_at, end_at = :end_at,
                     version = version + 1, updated_at = UTC_TIMESTAMP()' . $approvalSql . '
                 WHERE shift_id = :shift_id AND version = :version'
            )->execute([
                'user_id' => $newUserId,
                'patrol_zone' => $newPatrolZone,
                'start_at' => $newStartAt->format('Y-m-d H:i:s'),
                'end_at' => $newEndAt->format('Y-m-d H:i:s'),
                'shift_id' => $shiftId,
                'version' => $version,
            ]);

            // Recalculate for whoever is affected: the previous assignee
            // (their load just changed/dropped), and the new assignee if
            // this is a reassignment.
            if ($oldUserId !== null) {
                FatigueCalculator::recalculate($pdo, $oldUserId, $shiftId);
            }
            if ($newUserId !== null && $newUserId !== $oldUserId) {
                FatigueCalculator::recalculate($pdo, $newUserId, $shiftId);
            }

            // Rule 17: "shift changes". A reassignment is the audit event
            // that actually matters here, so both sides of it are
            // recorded — identifiers only.
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'shift_updated', 'shift_schedule', $shiftId, [
                'from_user_id' => $oldUserId,
                'to_user_id' => $newUserId,
                'version' => $version + 1,
                'approval_reset' => $approvalReset,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, ['shift_id' => $shiftId, 'updated_at' => gmdate('Y-m-d\TH:i:s\Z'), 'version' => $version + 1]);
    }

    /**
     * Same-barangay, active Tanod check shared by create()/update() and the swap
     * approval. Takes a row lock on the user row (FOR UPDATE) so every
     * overlap / daily-hours check that follows is serialized per Tanod: two
     * concurrent schedule writes for one Tanod cannot both pass the cap.
     * Must therefore be called inside a transaction.
     */
    public static function assertTanodEligible(PDO $pdo, int $userId, int $barangayId): void
    {
        $stmt = $pdo->prepare(
            "SELECT user_id FROM user WHERE user_id = :user_id AND barangay_id = :barangay_id AND role = 'tanod' AND is_active = 1 LIMIT 1 FOR UPDATE"
        );
        $stmt->execute(['user_id' => $userId, 'barangay_id' => $barangayId]);
        if ($stmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'The selected Tanod is not available for scheduling.');
        }
    }

    /**
     * Locks (FOR UPDATE) and checks for a time-overlapping shift already
     * assigned to $userId. $excludeShiftId omits the row being edited
     * (so a no-op time-range submit on the same shift doesn't conflict
     * with itself).
     */
    public static function assertNoOverlap(PDO $pdo, int $userId, \DateTimeImmutable $startAt, \DateTimeImmutable $endAt, ?int $excludeShiftId): void
    {
        $sql = 'SELECT shift_id FROM shift_schedule
                WHERE user_id = :user_id AND start_at < :end_at AND end_at > :start_at';
        $params = [
            'user_id' => $userId,
            'start_at' => $startAt->format('Y-m-d H:i:s'),
            'end_at' => $endAt->format('Y-m-d H:i:s'),
        ];
        if ($excludeShiftId !== null) {
            $sql .= ' AND shift_id != :exclude_id';
            $params['exclude_id'] = $excludeShiftId;
        }
        $stmt = $pdo->prepare($sql . ' FOR UPDATE');
        $stmt->execute($params);
        if ($stmt->fetch(PDO::FETCH_ASSOC) !== false) {
            throw new ApiError(409, 'CONFLICT', 'This Tanod already has an overlapping shift.');
        }
    }

    /**
     * Contract section 8: rejects an assignment that would put this Tanod
     * above `MAX_DAILY_SCHEDULED_HOURS` of scheduled time inside any single
     * Asia/Manila calendar day (422 `DAILY_HOURS_EXCEEDED`). A shift that
     * crosses midnight is split at the Manila day boundary and each part
     * counts toward its own day. Every other shift of the Tanod (draft or
     * published) counts; `$excludeShiftId` omits the row being edited. Call
     * AFTER `assertNoOverlap()` (which also takes the row lock).
     */
    public static function assertDailyHoursCap(PDO $pdo, int $userId, \DateTimeImmutable $startAt, \DateTimeImmutable $endAt, ?int $excludeShiftId): void
    {
        $firstDay = RosterSupport::manilaDateOf($startAt);
        $lastDay = RosterSupport::manilaDateOf($endAt->modify('-1 second'));
        $rangeStart = RosterSupport::manilaDayBoundsUtc($firstDay)[0];
        $rangeEnd = RosterSupport::manilaDayBoundsUtc($lastDay)[1];

        // FOR UPDATE: a locking read always sees the latest committed rows (not
        // this transaction's older snapshot), so a concurrent create that
        // committed while we waited on the user-row lock is counted.
        $sql = 'SELECT start_at, end_at FROM shift_schedule
                WHERE user_id = :user_id AND start_at < :range_end AND end_at > :range_start';
        $params = [
            'user_id' => $userId,
            'range_start' => $rangeStart->format('Y-m-d H:i:s'),
            'range_end' => $rangeEnd->format('Y-m-d H:i:s'),
        ];
        if ($excludeShiftId !== null) {
            $sql .= ' AND shift_id != :exclude_id';
            $params['exclude_id'] = $excludeShiftId;
        }
        $stmt = $pdo->prepare($sql . ' FOR UPDATE');
        $stmt->execute($params);
        $utc = new \DateTimeZone('UTC');
        $others = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $other) {
            $others[] = [new \DateTimeImmutable($other['start_at'], $utc), new \DateTimeImmutable($other['end_at'], $utc)];
        }

        $capSeconds = self::MAX_DAILY_SCHEDULED_HOURS * 3600;
        $day = $firstDay;
        while ($day <= $lastDay) {
            [$dayStart, $dayEnd] = RosterSupport::manilaDayBoundsUtc($day);
            $seconds = self::overlapSeconds($startAt, $endAt, $dayStart, $dayEnd);
            foreach ($others as [$otherStart, $otherEnd]) {
                $seconds += self::overlapSeconds($otherStart, $otherEnd, $dayStart, $dayEnd);
            }
            if ($seconds > $capSeconds) {
                throw new ApiError(
                    422,
                    'DAILY_HOURS_EXCEEDED',
                    'This would schedule the Tanod for more than ' . self::MAX_DAILY_SCHEDULED_HOURS . ' hours on ' . $day . '.'
                );
            }
            $day = (new \DateTimeImmutable($day, $utc))->modify('+1 day')->format('Y-m-d');
        }
    }

    private static function overlapSeconds(\DateTimeImmutable $aStart, \DateTimeImmutable $aEnd, \DateTimeImmutable $bStart, \DateTimeImmutable $bEnd): int
    {
        $start = max($aStart->getTimestamp(), $bStart->getTimestamp());
        $end = min($aEnd->getTimestamp(), $bEnd->getTimestamp());
        return $end > $start ? $end - $start : 0;
    }

    /** `source_availability_id` must be an availability row of the same barangay AND the same Tanod. */
    private static function assertSourceAvailability(PDO $pdo, int $availabilityId, int $userId, int $barangayId): void
    {
        $stmt = $pdo->prepare('SELECT avail_id FROM tanod_availability WHERE avail_id = :id AND barangay_id = :barangay_id AND user_id = :user_id LIMIT 1');
        $stmt->execute(['id' => $availabilityId, 'barangay_id' => $barangayId, 'user_id' => $userId]);
        if ($stmt->fetch(PDO::FETCH_ASSOC) === false) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'source_availability_id must reference an availability submission by the same Tanod in this barangay.');
        }
    }

    /**
     * POST /shifts/publish — contract section 3. Requires the
     * `approve_roster` authority (not just a role). Moves the named draft
     * shifts to `published`; already-published ids are reported, not
     * errors. Any id that is missing or belongs to another barangay makes
     * the WHOLE call a 404 (existence is never confirmed). Coverage is
     * reported, never blocked: a `NO_COVERAGE` warning is returned for each
     * Manila date, within the date span of the named shifts, on which no
     * published shift with an assigned Tanod overlaps any part of the day.
     *
     * Idempotency-Key replay is served off `audit_log` like the other
     * non-creating writes; the stored metadata is a superset of the
     * contract's `{count}` (also the id lists and warning dates, all
     * identifiers/dates, nothing personal) so the replay can return the
     * ORIGINAL outcome rather than a recomputed one.
     *
     * No notification is sent: `NotificationService` has no roster type and
     * the contract forbids inventing one.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function publish(PDO $pdo, array $identity): void
    {
        ApprovalAuthority::require($pdo, $identity, ApprovalAuthority::APPROVE_ROSTER);
        $idempotencyKey = RosterSupport::requireIdempotencyKey();

        $body = Http::jsonBody();
        $rawIds = $body['shift_ids'] ?? null;
        if (!is_array($rawIds) || count($rawIds) < 1 || count($rawIds) > self::MAX_PUBLISH_BATCH) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'shift_ids must be an array of 1 to ' . self::MAX_PUBLISH_BATCH . ' shift ids.');
        }
        $ids = [];
        foreach ($rawIds as $rawId) {
            if (!is_int($rawId) && !(is_string($rawId) && ctype_digit($rawId))) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'shift_ids must contain integers only.');
            }
            if ((int) $rawId < 1) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'shift_ids must contain positive integers.');
            }
            $ids[(int) $rawId] = true;
        }
        $ids = array_keys($ids);

        $replay = RosterSupport::findAuditReplay($pdo, $identity['barangay_id'], 'roster_published', null, $idempotencyKey);
        if ($replay !== null) {
            Http::send(200, [
                'published' => array_values(array_map('intval', $replay['published'] ?? [])),
                'already_published' => array_values(array_map('intval', $replay['already_published'] ?? [])),
                'warnings' => array_values(array_map(
                    static fn ($date): array => ['code' => 'NO_COVERAGE', 'date' => (string) $date],
                    $replay['warning_dates'] ?? []
                )),
            ]);
        }

        $pdo->beginTransaction();
        try {
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $stmt = $pdo->prepare(
                "SELECT shift_id, barangay_id, start_at, end_at, approval_status FROM shift_schedule
                 WHERE shift_id IN ({$placeholders}) ORDER BY shift_id FOR UPDATE"
            );
            $stmt->execute($ids);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            if (count($rows) !== count($ids)) {
                throw new ApiError(404, 'NOT_FOUND', 'Shift not found.');
            }
            foreach ($rows as $row) {
                // Cross-tenant is 404 for the whole call (Rule 2).
                AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);
            }

            $published = [];
            $alreadyPublished = [];
            foreach ($rows as $row) {
                if ($row['approval_status'] === 'published') {
                    $alreadyPublished[] = (int) $row['shift_id'];
                } else {
                    $published[] = (int) $row['shift_id'];
                }
            }
            if ($published !== []) {
                $pubPlaceholders = implode(',', array_fill(0, count($published), '?'));
                $update = $pdo->prepare(
                    "UPDATE shift_schedule
                        SET approval_status = 'published', approved_by = ?, approved_at = UTC_TIMESTAMP(),
                            version = version + 1, updated_at = UTC_TIMESTAMP()
                      WHERE shift_id IN ({$pubPlaceholders}) AND approval_status = 'draft'"
                );
                $update->execute([$identity['user_id'], ...$published]);
            }

            $warningDates = self::coverageWarningDates($pdo, $identity['barangay_id'], $rows);

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'roster_published', 'shift_schedule', null, [
                'count' => count($published),
                'published' => $published,
                'already_published' => $alreadyPublished,
                'warning_dates' => $warningDates,
                'idempotency_key' => $idempotencyKey,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, [
            'published' => $published,
            'already_published' => $alreadyPublished,
            'warnings' => array_map(static fn (string $date): array => ['code' => 'NO_COVERAGE', 'date' => $date], $warningDates),
        ]);
    }

    /**
     * Manila dates inside [earliest, latest] of the named shifts with no
     * published, assigned shift overlapping any part of the day. Evaluated
     * after the publish UPDATE (same transaction), so it already counts the
     * shifts just published.
     *
     * @param list<array<string,mixed>> $shiftRows
     * @return list<string>
     */
    private static function coverageWarningDates(PDO $pdo, int $barangayId, array $shiftRows): array
    {
        $utc = new \DateTimeZone('UTC');
        $firstDay = null;
        $lastDay = null;
        foreach ($shiftRows as $row) {
            $start = RosterSupport::manilaDateOf(new \DateTimeImmutable($row['start_at'], $utc));
            $end = RosterSupport::manilaDateOf((new \DateTimeImmutable($row['end_at'], $utc))->modify('-1 second'));
            if ($firstDay === null || $start < $firstDay) {
                $firstDay = $start;
            }
            if ($lastDay === null || $end > $lastDay) {
                $lastDay = $end;
            }
        }
        if ($firstDay === null || $lastDay === null) {
            return [];
        }
        $rangeStart = RosterSupport::manilaDayBoundsUtc($firstDay)[0];
        $rangeEnd = RosterSupport::manilaDayBoundsUtc($lastDay)[1];

        $stmt = $pdo->prepare(
            "SELECT start_at, end_at FROM shift_schedule
             WHERE barangay_id = :barangay_id AND approval_status = 'published' AND user_id IS NOT NULL
               AND start_at < :range_end AND end_at > :range_start"
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'range_start' => $rangeStart->format('Y-m-d H:i:s'),
            'range_end' => $rangeEnd->format('Y-m-d H:i:s'),
        ]);
        $covered = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $shift) {
            $d = RosterSupport::manilaDateOf(new \DateTimeImmutable($shift['start_at'], $utc));
            $last = RosterSupport::manilaDateOf((new \DateTimeImmutable($shift['end_at'], $utc))->modify('-1 second'));
            $guard = 0;
            while ($d <= $last && $guard++ < self::MAX_COVERAGE_SCAN_DAYS + 2) {
                $covered[$d] = true;
                $d = (new \DateTimeImmutable($d, $utc))->modify('+1 day')->format('Y-m-d');
            }
        }

        $warnings = [];
        $day = $firstDay;
        $scanned = 0;
        while ($day <= $lastDay && $scanned++ < self::MAX_COVERAGE_SCAN_DAYS) {
            if (!isset($covered[$day])) {
                $warnings[] = $day;
            }
            $day = (new \DateTimeImmutable($day, $utc))->modify('+1 day')->format('Y-m-d');
        }
        return $warnings;
    }

    /**
     * Parses one timestamp and normalizes it to UTC for storage.
     * `$defaultTimezone` matters only for a string with NO explicit
     * offset/zone of its own: a client-supplied "2026-09-10T14:30:00"
     * from an HTML `datetime-local` input carries no offset at all, and
     * §5 says operational shift times are entered/interpreted in
     * Asia/Manila — so a fresh client value is parsed with Asia/Manila as
     * the default. A DB round-trip value (`update()`'s fallback for a
     * field the caller didn't touch) is already a naive UTC string with
     * no offset either, so `update()` passes UTC as the default there
     * instead — same parser, different default per source, per PHP's own
     * DateTimeImmutable rule that an explicit offset in the string always
     * wins over the constructor's default timezone regardless of which
     * default was passed in.
     */
    public static function parseTimestamp(mixed $raw, \DateTimeZone $defaultTimezone): \DateTimeImmutable
    {
        if (!is_string($raw)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'start_at and end_at are required.');
        }
        try {
            return (new \DateTimeImmutable($raw, $defaultTimezone))->setTimezone(new \DateTimeZone('UTC'));
        } catch (\Exception) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'start_at/end_at must be valid ISO 8601 timestamps.');
        }
    }

    /**
     * Parses a fresh client-supplied start_at/end_at pair (Asia/Manila
     * default — see parseTimestamp()) and validates the ordering.
     *
     * @return array{0:\DateTimeImmutable,1:\DateTimeImmutable}
     */
    public static function parseTimeRange(mixed $startAtRaw, mixed $endAtRaw): array
    {
        $manila = new \DateTimeZone('Asia/Manila');
        $startAt = self::parseTimestamp($startAtRaw, $manila);
        $endAt = self::parseTimestamp($endAtRaw, $manila);
        if ($startAt >= $endAt) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'start_at must be before end_at.');
        }
        return [$startAt, $endAt];
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    public static function mapShift(array $row): array
    {
        return [
            'shift_id' => (int) $row['shift_id'],
            'user_id' => $row['user_id'] !== null ? (int) $row['user_id'] : null,
            'patrol_zone' => $row['patrol_zone'],
            'start_at' => $row['start_at'],
            'end_at' => $row['end_at'],
            'version' => (int) $row['version'],
            'approval_status' => $row['approval_status'] ?? 'draft',
            'approved_by' => isset($row['approved_by']) ? (int) $row['approved_by'] : null,
            'approved_at' => $row['approved_at'] ?? null,
            'source_availability_id' => isset($row['source_availability_id']) ? (int) $row['source_availability_id'] : null,
        ];
    }
}
