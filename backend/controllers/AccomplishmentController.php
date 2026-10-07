<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\ApprovalAuthority;
use Baranguard\Lib\Audit;
use Baranguard\Lib\DeviceSignature;
use Baranguard\Lib\Http;
use Baranguard\Lib\PaperApproval;
use Baranguard\Middleware\AuthMiddleware;
use Baranguard\Services\Scheduling\RosterSupport;
use PDO;

/**
 * Monthly accomplishment report — docs/FEATURE_CONTRACT_2026-10.md section 4
 * (migration 0031: `accomplishment_report`, `accomplishment_entry`).
 *
 * A Tanod writes dated entries (their own words plus a CONFIRMED duration);
 * the server records, at write time, the duration it would have suggested
 * from the Tanod's own `duty_status` rows and flags a mismatch larger than
 * `DURATION_FLAG_MARGIN_MINUTES`. The month's report then walks
 * open -> prepared (Tanod submits, online only) -> noted -> approved, or is
 * `returned` (entries editable again). Who may note / approve is an
 * authority (`ApprovalAuthority`), never a role, and the preparer can never
 * note or approve their own report (segregation of duties).
 *
 * Resolved decisions where the contract is silent (logged in DEVLOG.md):
 *   - Suggested duration counts ONLY `on_duty` intervals (literal reading of
 *     the contract: a `responding` interval is not summed). The interval
 *     state at the start of the Manila day is carried in from the last
 *     status row before it; a still-open `on_duty` interval is closed at the
 *     day's end, or "now" if the day has not ended. When the Tanod has no
 *     duty_status row at or before the end of that day at all there is
 *     nothing to suggest: `suggested_duration_minutes` is NULL and the flag
 *     is 0 (no basis to compare). A day with history but no on_duty time
 *     suggests 0 minutes.
 *   - Submitting with no entries is a 422 (not a transition conflict).
 *   - `return` clears `noted_by`/`noted_at` so a resubmission is noted
 *     afresh; `submit` clears `return_reason`.
 *   - Report text visibility: the owning Tanod sees their own text; other
 *     roles see `accomplishment_text` only if they hold the note_report or
 *     approve_report authority (otherwise null + `text_visible: false`).
 *   - No audit row for entry writes (volume / text); the four report
 *     transitions are audited with identifiers and statuses only.
 */
final class AccomplishmentController
{
    /** |confirmed - suggested| above this many minutes sets `duration_flag`. */
    public const DURATION_FLAG_MARGIN_MINUTES = 30;
    /** A work_date may be at most this many days in the past. */
    private const MAX_BACKDATE_DAYS = 62;
    private const TEXT_MAX = 2000;
    private const REASON_MAX = 255;
    private const TIME_PATTERN = '/^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/';
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const STATUSES = ['open', 'prepared', 'noted', 'approved', 'returned'];

    // ------------------------------------------------------------------
    // Entries
    // ------------------------------------------------------------------

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function createEntry(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $deviceId = Http::header('X-Device-Id');
        if ($deviceId === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'X-Device-Id header is required.');
        }
        RosterSupport::assertDeviceOwnership($pdo, $identity, $deviceId);
        // H-09: no-op for a device that has not upgraded to a Keystore key yet.
        DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);

        $result = self::createEntryItem($pdo, $identity, $deviceId, Http::jsonBody());
        Http::send($result['wasCreated'] ? 201 : 200, [
            'entry' => $result['entry'],
            'report' => $result['report'],
        ]);
    }

    /**
     * Shared by POST /accomplishment-entries and POST /sync/batch (contract
     * section 6).
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @param array<string,mixed> $item
     * @return array{id:int,wasCreated:bool,entry:array<string,mixed>,report:array<string,mixed>}
     */
    public static function createEntryItem(PDO $pdo, array $identity, string $deviceId, array $item): array
    {
        RosterSupport::assertDeviceOwnership($pdo, $identity, $deviceId);
        // H-09, per item (the sync batch carries one signature for the whole
        // request; each item is held to it exactly like GpsController::createItem).
        // No-op for a device with no registered Keystore key.
        DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);

        $clientEventId = $item['client_event_id'] ?? null;
        if (!is_string($clientEventId) || !preg_match(RosterSupport::UUID_PATTERN, $clientEventId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
        }

        // Replay BEFORE validation: a late retry of an entry that was already
        // stored (even one whose work_date has since aged out of the 62-day
        // window) returns the original row, never a 400.
        $replay = self::findEntryByClientEvent($pdo, $identity['user_id'], $clientEventId);
        if ($replay !== null) {
            return self::entryResult($pdo, $replay, false);
        }

        $workDate = RosterSupport::parseDate($item['work_date'] ?? null, 'work_date');
        $today = RosterSupport::manilaToday();
        if ($workDate > $today) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'work_date cannot be in the future.');
        }
        $earliest = (new \DateTimeImmutable($today, new \DateTimeZone('UTC')))->modify('-' . self::MAX_BACKDATE_DAYS . ' days')->format('Y-m-d');
        if ($workDate < $earliest) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'work_date cannot be more than ' . self::MAX_BACKDATE_DAYS . ' days in the past.');
        }

        $text = self::validateText($item['accomplishment_text'] ?? null);
        [$startTime, $endTime] = self::validateTimes($item['start_time'] ?? null, $item['end_time'] ?? null);
        $duration = self::validateDuration($item['duration_minutes'] ?? null);

        $month = substr($workDate, 0, 7);
        $suggested = self::computeSuggestedMinutes($pdo, $identity['user_id'], $workDate);
        $flag = self::computeFlag($duration, $suggested);

        $pdo->beginTransaction();
        try {
            $report = self::lockOrCreateReport($pdo, $identity, $month);
            if (!in_array($report['status'], ['open', 'returned'], true)) {
                throw new ApiError(409, 'CONFLICT', "This month's report is '{$report['status']}' and no longer accepts entries.");
            }
            $pdo->prepare(
                'INSERT INTO accomplishment_entry
                    (report_id, barangay_id, user_id, work_date, accomplishment_text, start_time, end_time,
                     duration_minutes, suggested_duration_minutes, duration_flag, client_event_id, created_at, updated_at)
                 VALUES
                    (:report_id, :barangay_id, :user_id, :work_date, :text, :start_time, :end_time,
                     :duration, :suggested, :flag, :client_event_id, UTC_TIMESTAMP(), UTC_TIMESTAMP())'
            )->execute([
                'report_id' => (int) $report['report_id'],
                'barangay_id' => $identity['barangay_id'],
                'user_id' => $identity['user_id'],
                'work_date' => $workDate,
                'text' => $text,
                'start_time' => $startTime,
                'end_time' => $endTime,
                'duration' => $duration,
                'suggested' => $suggested,
                'flag' => $flag,
                'client_event_id' => $clientEventId,
            ]);
            $entryId = (int) $pdo->lastInsertId();
            $pdo->prepare('UPDATE accomplishment_report SET updated_at = UTC_TIMESTAMP() WHERE report_id = :id')
                ->execute(['id' => (int) $report['report_id']]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            // Lost a race against a concurrent identical request (UNIQUE
            // user_id + client_event_id): the winner's row is the answer.
            if ($e instanceof \PDOException && (string) $e->getCode() === '23000') {
                $winner = self::findEntryByClientEvent($pdo, $identity['user_id'], $clientEventId);
                if ($winner !== null) {
                    return self::entryResult($pdo, $winner, false);
                }
            }
            throw $e;
        }

        $row = self::findEntryById($pdo, $entryId);
        return self::entryResult($pdo, $row ?? [], true);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function updateEntry(PDO $pdo, array $identity, string $entryIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);
        if (!ctype_digit($entryIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
        }
        $entryId = (int) $entryIdParam;

        // The mobile device header is optional on this online-only edit; when
        // present it is held to the same ownership + signature checks.
        $deviceId = Http::header('X-Device-Id');
        if ($deviceId !== null) {
            RosterSupport::assertDeviceOwnership($pdo, $identity, $deviceId);
            DeviceSignature::verifyOrReject($pdo, $deviceId, $identity['user_id']);
        }

        $body = Http::jsonBody();
        $hasText = array_key_exists('accomplishment_text', $body);
        $hasStart = array_key_exists('start_time', $body);
        $hasEnd = array_key_exists('end_time', $body);
        $hasDuration = array_key_exists('duration_minutes', $body);
        if (!$hasText && !$hasStart && !$hasEnd && !$hasDuration) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Provide accomplishment_text, start_time, end_time and/or duration_minutes.');
        }
        $newText = $hasText ? self::validateText($body['accomplishment_text']) : null;
        $newDuration = $hasDuration ? self::validateDuration($body['duration_minutes']) : null;

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                'SELECT e.*, r.status AS report_status FROM accomplishment_entry e
                 JOIN accomplishment_report r ON r.report_id = e.report_id
                 WHERE e.entry_id = :id FOR UPDATE'
            );
            $stmt->execute(['id' => $entryId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false || (int) $row['user_id'] !== $identity['user_id'] || (int) $row['barangay_id'] !== $identity['barangay_id']) {
                // Another user's entry, another tenant's entry and a missing one all read as 404.
                throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
            }
            if (!in_array($row['report_status'], ['open', 'returned'], true)) {
                throw new ApiError(409, 'CONFLICT', "This month's report is '{$row['report_status']}' and its entries can no longer be edited.");
            }

            $start = $hasStart ? $body['start_time'] : $row['start_time'];
            $end = $hasEnd ? $body['end_time'] : $row['end_time'];
            [$startTime, $endTime] = self::validateTimes($start, $end);
            $duration = $newDuration ?? (int) $row['duration_minutes'];
            $text = $newText ?? (string) $row['accomplishment_text'];

            $suggested = self::computeSuggestedMinutes($pdo, $identity['user_id'], (string) $row['work_date']);
            $flag = self::computeFlag($duration, $suggested);

            $pdo->prepare(
                'UPDATE accomplishment_entry
                    SET accomplishment_text = :text, start_time = :start_time, end_time = :end_time,
                        duration_minutes = :duration, suggested_duration_minutes = :suggested, duration_flag = :flag,
                        updated_at = UTC_TIMESTAMP()
                  WHERE entry_id = :id'
            )->execute([
                'text' => $text,
                'start_time' => $startTime,
                'end_time' => $endTime,
                'duration' => $duration,
                'suggested' => $suggested,
                'flag' => $flag,
                'id' => $entryId,
            ]);
            $pdo->prepare('UPDATE accomplishment_report SET updated_at = UTC_TIMESTAMP() WHERE report_id = :id')
                ->execute(['id' => (int) $row['report_id']]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $updated = self::findEntryById($pdo, $entryId) ?? [];
        Http::send(200, ['entry' => self::mapEntry($updated, true)]);
    }

    // ------------------------------------------------------------------
    // Reports: read
    // ------------------------------------------------------------------

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod', 'admin', 'secretary', 'punong_barangay']);

        $month = Http::query('month');
        if ($month !== null && !preg_match('/^[0-9]{4}-(0[1-9]|1[0-2])$/', $month)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'month must be YYYY-MM.');
        }
        $status = Http::query('status');
        if ($status !== null && !in_array($status, self::STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of: ' . implode(', ', self::STATUSES) . '.');
        }
        $userIdParam = Http::query('user_id');
        if ($userIdParam !== null && !ctype_digit($userIdParam)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'user_id must be numeric.');
        }

        $where = ['r.barangay_id = :barangay_id'];
        $params = ['barangay_id' => $identity['barangay_id']];
        if ($identity['role'] === 'tanod') {
            if ($userIdParam !== null && (int) $userIdParam !== $identity['user_id']) {
                throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
            }
            $where[] = 'r.user_id = :user_id';
            $params['user_id'] = $identity['user_id'];
        } elseif ($userIdParam !== null) {
            $where[] = 'r.user_id = :user_id';
            $params['user_id'] = (int) $userIdParam;
        }
        if ($month !== null) {
            $where[] = 'r.month = :month';
            $params['month'] = $month;
        }
        if ($status !== null) {
            $where[] = 'r.status = :status';
            $params['status'] = $status;
        }
        $whereSql = implode(' AND ', $where);

        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM accomplishment_report r WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT r.*, u.full_name, u.official_title, pr.full_name AS paper_recorded_by_name,
                    (SELECT COUNT(*) FROM accomplishment_entry e WHERE e.report_id = r.report_id) AS entry_count,
                    (SELECT COALESCE(SUM(e2.duration_minutes), 0) FROM accomplishment_entry e2 WHERE e2.report_id = r.report_id) AS total_minutes,
                    (SELECT COUNT(*) FROM accomplishment_entry e3 WHERE e3.report_id = r.report_id AND e3.duration_flag = 1) AS flagged_entries
             FROM accomplishment_report r
             JOIN user u ON u.user_id = r.user_id
             LEFT JOIN user pr ON pr.user_id = r.paper_recorded_by
             WHERE {$whereSql}
             ORDER BY r.month DESC, u.full_name ASC, r.report_id DESC
             LIMIT :limit OFFSET :offset"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        $items = array_map(static function (array $row): array {
            $mapped = self::mapReport($row);
            $mapped['full_name'] = $row['full_name'];
            $mapped['official_title'] = $row['official_title'];
            $mapped['entry_count'] = (int) $row['entry_count'];
            $mapped['total_minutes'] = (int) $row['total_minutes'];
            $mapped['flagged_entries'] = (int) $row['flagged_entries'];
            return $mapped;
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function show(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['tanod', 'admin', 'secretary', 'punong_barangay']);
        if (!ctype_digit($reportIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
        }
        $reportId = (int) $reportIdParam;

        $stmt = $pdo->prepare(
            'SELECT r.*, u.full_name, u.official_title,
                    nb.full_name AS noted_by_name, nb.official_title AS noted_by_title,
                    ab.full_name AS approved_by_name, ab.official_title AS approved_by_title,
                    pr.full_name AS paper_recorded_by_name
             FROM accomplishment_report r
             JOIN user u ON u.user_id = r.user_id
             LEFT JOIN user nb ON nb.user_id = r.noted_by
             LEFT JOIN user ab ON ab.user_id = r.approved_by
             LEFT JOIN user pr ON pr.user_id = r.paper_recorded_by
             WHERE r.report_id = :id'
        );
        $stmt->execute(['id' => $reportId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $row['barangay_id']);
        if ($identity['role'] === 'tanod' && (int) $row['user_id'] !== $identity['user_id']) {
            throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
        }

        $textVisible = $identity['role'] === 'tanod'
            || ApprovalAuthority::has($pdo, $identity['user_id'], ApprovalAuthority::NOTE_REPORT)
            || ApprovalAuthority::has($pdo, $identity['user_id'], ApprovalAuthority::APPROVE_REPORT);

        $entryStmt = $pdo->prepare('SELECT * FROM accomplishment_entry WHERE report_id = :id ORDER BY work_date ASC, entry_id ASC');
        $entryStmt->execute(['id' => $reportId]);
        $entries = array_map(
            static fn (array $e): array => self::mapEntry($e, $textVisible),
            $entryStmt->fetchAll(PDO::FETCH_ASSOC)
        );

        $total = 0;
        $flagged = 0;
        foreach ($entries as $entry) {
            $total += $entry['duration_minutes'];
            $flagged += $entry['duration_flag'] ? 1 : 0;
        }

        $report = self::mapReport($row);
        $report['full_name'] = $row['full_name'];
        $report['official_title'] = $row['official_title'];
        $report['noted_by_name'] = $row['noted_by_name'];
        $report['noted_by_title'] = $row['noted_by_title'];
        $report['approved_by_name'] = $row['approved_by_name'];
        $report['approved_by_title'] = $row['approved_by_title'];
        $report['entry_count'] = count($entries);
        $report['total_minutes'] = $total;
        $report['flagged_entries'] = $flagged;
        $report['text_visible'] = $textVisible;
        $report['entries'] = $entries;

        Http::send(200, $report);
    }

    // ------------------------------------------------------------------
    // Reports: state machine
    // ------------------------------------------------------------------

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function submit(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);
        self::transition($pdo, $identity, $reportIdParam, 'submitted');
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function note(PDO $pdo, array $identity, string $reportIdParam): void
    {
        ApprovalAuthority::require($pdo, $identity, ApprovalAuthority::NOTE_REPORT);
        self::transition($pdo, $identity, $reportIdParam, 'noted');
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function approve(PDO $pdo, array $identity, string $reportIdParam): void
    {
        ApprovalAuthority::require($pdo, $identity, ApprovalAuthority::APPROVE_REPORT);
        self::transition($pdo, $identity, $reportIdParam, 'approved');
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function returnReport(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ApprovalAuthority::ELIGIBLE_ROLES);
        if (!ApprovalAuthority::has($pdo, $identity['user_id'], ApprovalAuthority::NOTE_REPORT)
            && !ApprovalAuthority::has($pdo, $identity['user_id'], ApprovalAuthority::APPROVE_REPORT)
        ) {
            throw new ApiError(403, 'FORBIDDEN', 'You are not designated to perform this action.');
        }
        self::transition($pdo, $identity, $reportIdParam, 'returned');
    }

    /**
     * One implementation of the four state changes. Order of checks: 403
     * (caller, done by the wrappers) -> 400 (key/body) -> 404 (missing,
     * cross-tenant, other Tanod's) -> idempotent replay (the original
     * outcome) -> 409 illegal transition -> 409 segregation of duties.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    private static function transition(PDO $pdo, array $identity, string $reportIdParam, string $action): void
    {
        if (!ctype_digit($reportIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
        }
        $reportId = (int) $reportIdParam;
        $idempotencyKey = RosterSupport::requireIdempotencyKey();

        $reason = null;
        if ($action === 'returned') {
            $body = Http::jsonBody();
            $reason = $body['reason'] ?? null;
            if (!is_string($reason) || trim($reason) === '' || mb_strlen(trim($reason)) > self::REASON_MAX) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'reason is required (1 to ' . self::REASON_MAX . ' characters).');
            }
            $reason = trim($reason);
        }

        $auditAction = 'accomplishment_report_' . $action;

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT * FROM accomplishment_report WHERE report_id = :id FOR UPDATE');
            $stmt->execute(['id' => $reportId]);
            $report = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($report === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
            }
            AuthMiddleware::requireTenant($identity, (int) $report['barangay_id']);
            if ($action === 'submitted' && (int) $report['user_id'] !== $identity['user_id']) {
                throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
            }

            if (RosterSupport::findAuditReplay($pdo, $identity['barangay_id'], $auditAction, $reportId, $idempotencyKey) !== null) {
                $pdo->commit();
                Http::send(200, self::mapReport(self::fetchReportRow($pdo, $reportId) ?? $report));
            }

            $status = (string) $report['status'];
            $legalFrom = match ($action) {
                'submitted' => ['open', 'returned'],
                'noted' => ['prepared'],
                'approved' => ['noted'],
                'returned' => ['prepared', 'noted'],
            };
            if (!in_array($status, $legalFrom, true)) {
                throw new ApiError(409, 'CONFLICT', "A report in '{$status}' status cannot be {$action}.");
            }
            if ($action === 'noted' || $action === 'approved') {
                ApprovalAuthority::assertNotPreparer($identity['user_id'], (int) $report['user_id']);
            }

            if ($action === 'submitted') {
                $sumStmt = $pdo->prepare('SELECT COUNT(*) AS n, COALESCE(SUM(duration_minutes), 0) AS minutes FROM accomplishment_entry WHERE report_id = :id');
                $sumStmt->execute(['id' => $reportId]);
                $sum = $sumStmt->fetch(PDO::FETCH_ASSOC);
                if ((int) $sum['n'] < 1) {
                    throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'A report needs at least one entry before it can be submitted.');
                }
                $pdo->prepare(
                    "UPDATE accomplishment_report
                        SET status = 'prepared', prepared_at = UTC_TIMESTAMP(), total_minutes_confirmed = :minutes,
                            return_reason = NULL, version = version + 1, updated_at = UTC_TIMESTAMP()
                      WHERE report_id = :id"
                )->execute(['minutes' => (int) $sum['minutes'], 'id' => $reportId]);
                $newStatus = 'prepared';
            } elseif ($action === 'noted') {
                $pdo->prepare(
                    "UPDATE accomplishment_report
                        SET status = 'noted', noted_by = :actor, noted_at = UTC_TIMESTAMP(),
                            version = version + 1, updated_at = UTC_TIMESTAMP()
                      WHERE report_id = :id"
                )->execute(['actor' => $identity['user_id'], 'id' => $reportId]);
                $newStatus = 'noted';
            } elseif ($action === 'approved') {
                $pdo->prepare(
                    "UPDATE accomplishment_report
                        SET status = 'approved', approved_by = :actor, approved_at = UTC_TIMESTAMP(),
                            version = version + 1, updated_at = UTC_TIMESTAMP()
                      WHERE report_id = :id"
                )->execute(['actor' => $identity['user_id'], 'id' => $reportId]);
                $newStatus = 'approved';
            } else {
                $pdo->prepare(
                    "UPDATE accomplishment_report
                        SET status = 'returned', return_reason = :reason, noted_by = NULL, noted_at = NULL,
                            version = version + 1, updated_at = UTC_TIMESTAMP()
                      WHERE report_id = :id"
                )->execute(['reason' => $reason, 'id' => $reportId]);
                $newStatus = 'returned';
            }

            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], $auditAction, 'accomplishment_report', $reportId, [
                'report_id' => $reportId,
                'month' => $report['month'],
                'status' => $newStatus,
                'idempotency_key' => $idempotencyKey,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Http::send(200, self::mapReport(self::fetchReportRow($pdo, $reportId) ?? []));
    }

    // ------------------------------------------------------------------
    // Reports: paper signature (migration 0037)
    // ------------------------------------------------------------------

    /**
     * POST /accomplishment-reports/:id/paper-signature - admin|secretary.
     * Records (or overwrites) the date written on the signed paper of an
     * APPROVED report. It never changes status or any report content, so it
     * does not reopen the lock on an approved report; it is the one write an
     * approved report accepts. Order: 403 -> 400 (key/body) -> 404 (missing /
     * cross-tenant) -> idempotent replay -> 409 (not approved).
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function paperSignature(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        if (!ctype_digit($reportIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
        }
        $reportId = (int) $reportIdParam;
        $key = RosterSupport::requireIdempotencyKey();
        $body = Http::jsonBody();
        $signedOn = PaperApproval::requirePastOrTodayDate($body['paper_signed_on'] ?? null, 'paper_signed_on');

        $pdo->beginTransaction();
        try {
            $report = self::lockReport($pdo, $identity, $reportId);
            if (PaperApproval::isReplay($pdo, $identity['barangay_id'], 'paper_signature_recorded', 'accomplishment_report', $reportId, $key)) {
                $pdo->commit();
                Http::send(200, self::mapReport(self::fetchReportRow($pdo, $reportId) ?? $report));
            }
            if ($report['status'] !== 'approved') {
                throw new ApiError(409, 'CONFLICT', "A paper signature can only be recorded on an approved report (this one is '{$report['status']}').");
            }
            $pdo->prepare(
                'UPDATE accomplishment_report
                    SET paper_signed_on = :signed_on, paper_recorded_by = :actor, paper_recorded_at = UTC_TIMESTAMP(),
                        version = version + 1, updated_at = UTC_TIMESTAMP()
                  WHERE report_id = :id'
            )->execute(['signed_on' => $signedOn, 'actor' => $identity['user_id'], 'id' => $reportId]);
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'paper_signature_recorded', 'accomplishment_report', $reportId, [
                'report_id' => $reportId,
                'status' => 'approved',
                'idempotency_key' => $key,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        Http::send(200, self::mapReport(self::fetchReportRow($pdo, $reportId) ?? []));
    }

    /**
     * POST /accomplishment-reports/:id/record-paper-approval - admin|secretary.
     * Body {"signer_user_id", "signed_on"}. Records an approval that
     * happened on paper: `noted` -> `approved`, `approved_by` = the signer
     * (an active same-barangay user holding `approve_report`, never the
     * preparer), `approval_mode` = 'recorded_from_paper'. The recorder may
     * be the signer (a Secretary can hold the authority). Order: 403 -> 400
     * -> 404 (report / cross-tenant) -> idempotent replay -> 409 (not noted)
     * -> 409 (signer is the preparer) -> 404 (signer in another barangay)
     * -> 422 (signer cannot approve).
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function recordPaperApproval(PDO $pdo, array $identity, string $reportIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['admin', 'secretary']);
        if (!ctype_digit($reportIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
        }
        $reportId = (int) $reportIdParam;
        $key = RosterSupport::requireIdempotencyKey();
        $body = Http::jsonBody();
        $signerId = PaperApproval::requirePositiveInt($body['signer_user_id'] ?? null, 'signer_user_id');
        $signedOn = PaperApproval::requirePastOrTodayDate($body['signed_on'] ?? null, 'signed_on');

        $pdo->beginTransaction();
        try {
            $report = self::lockReport($pdo, $identity, $reportId);
            if (PaperApproval::isReplay($pdo, $identity['barangay_id'], 'approval_recorded_from_paper', 'accomplishment_report', $reportId, $key)) {
                $pdo->commit();
                Http::send(200, self::mapReport(self::fetchReportRow($pdo, $reportId) ?? $report));
            }
            if ($report['status'] !== 'noted') {
                throw new ApiError(409, 'CONFLICT', "A report in '{$report['status']}' status cannot have a paper approval recorded.");
            }
            ApprovalAuthority::assertNotPreparer($signerId, (int) $report['user_id']);
            PaperApproval::requireSigner($pdo, $identity['barangay_id'], $signerId, ApprovalAuthority::APPROVE_REPORT);

            $pdo->prepare(
                "UPDATE accomplishment_report
                    SET status = 'approved', approved_by = :signer, approved_at = UTC_TIMESTAMP(),
                        approval_mode = 'recorded_from_paper', paper_signed_on = :signed_on,
                        paper_recorded_by = :actor, paper_recorded_at = UTC_TIMESTAMP(),
                        version = version + 1, updated_at = UTC_TIMESTAMP()
                  WHERE report_id = :id"
            )->execute(['signer' => $signerId, 'signed_on' => $signedOn, 'actor' => $identity['user_id'], 'id' => $reportId]);
            Audit::record($pdo, $identity['barangay_id'], $identity['user_id'], 'approval_recorded_from_paper', 'accomplishment_report', $reportId, [
                'report_id' => $reportId,
                'month' => $report['month'],
                'status' => 'approved',
                'signer_user_id' => $signerId,
                'idempotency_key' => $key,
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        Http::send(200, self::mapReport(self::fetchReportRow($pdo, $reportId) ?? []));
    }

    /**
     * Loads one report FOR UPDATE inside the caller's transaction; 404 for a
     * missing row and another barangay's row alike.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @return array<string,mixed>
     */
    private static function lockReport(PDO $pdo, array $identity, int $reportId): array
    {
        $stmt = $pdo->prepare('SELECT * FROM accomplishment_report WHERE report_id = :id FOR UPDATE');
        $stmt->execute(['id' => $reportId]);
        $report = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($report === false) {
            throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
        }
        AuthMiddleware::requireTenant($identity, (int) $report['barangay_id']);
        return $report;
    }

    /** @return array<string,mixed>|null the report row plus `paper_recorded_by_name` */
    private static function fetchReportRow(PDO $pdo, int $reportId): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT r.*, pr.full_name AS paper_recorded_by_name
               FROM accomplishment_report r
               LEFT JOIN user pr ON pr.user_id = r.paper_recorded_by
              WHERE r.report_id = :id'
        );
        $stmt->execute(['id' => $reportId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    // ------------------------------------------------------------------
    // Suggested duration
    // ------------------------------------------------------------------

    /**
     * Sum, in minutes, of the Tanod's `on_duty` intervals inside one
     * Asia/Manila calendar day, derived from existing `duty_status` rows
     * (see the class doc for the exact rules). NULL when there is no
     * duty_status history at all up to the end of that day.
     */
    public static function computeSuggestedMinutes(PDO $pdo, int $userId, string $workDate): ?int
    {
        [$dayStart, $dayEnd] = RosterSupport::manilaDayBoundsUtc($workDate);
        $utc = new \DateTimeZone('UTC');

        $initialStmt = $pdo->prepare(
            'SELECT status FROM duty_status WHERE user_id = :user_id AND changed_at <= :day_start
             ORDER BY changed_at DESC, status_id DESC LIMIT 1'
        );
        $initialStmt->execute(['user_id' => $userId, 'day_start' => $dayStart->format('Y-m-d H:i:s')]);
        $initialStatus = $initialStmt->fetchColumn();

        $inDayStmt = $pdo->prepare(
            'SELECT status, changed_at FROM duty_status
             WHERE user_id = :user_id AND changed_at > :day_start AND changed_at < :day_end
             ORDER BY changed_at ASC, status_id ASC'
        );
        $inDayStmt->execute([
            'user_id' => $userId,
            'day_start' => $dayStart->format('Y-m-d H:i:s'),
            'day_end' => $dayEnd->format('Y-m-d H:i:s'),
        ]);
        $rows = $inDayStmt->fetchAll(PDO::FETCH_ASSOC);

        if ($initialStatus === false && $rows === []) {
            return null;
        }

        $now = new \DateTimeImmutable('now', $utc);
        $limit = $now < $dayEnd ? $now : $dayEnd;
        $state = $initialStatus === false ? 'off_duty' : (string) $initialStatus;
        $cursor = $dayStart;
        $seconds = 0;
        foreach ($rows as $row) {
            $at = new \DateTimeImmutable($row['changed_at'], $utc);
            if ($state === 'on_duty' && $at > $cursor) {
                $seconds += $at->getTimestamp() - $cursor->getTimestamp();
            }
            $state = (string) $row['status'];
            $cursor = $at;
        }
        if ($state === 'on_duty' && $limit > $cursor) {
            $seconds += $limit->getTimestamp() - $cursor->getTimestamp();
        }
        return (int) round($seconds / 60);
    }

    private static function computeFlag(int $confirmed, ?int $suggested): int
    {
        if ($suggested === null) {
            return 0;
        }
        return abs($confirmed - $suggested) > self::DURATION_FLAG_MARGIN_MINUTES ? 1 : 0;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /**
     * Locks the month's report row, creating it (open) when missing.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     * @return array<string,mixed>
     */
    private static function lockOrCreateReport(PDO $pdo, array $identity, string $month): array
    {
        // INSERT IGNORE first, THEN lock-read: two concurrent first entries of a
        // month both run the (no-op for the loser) insert, then queue on the
        // row lock in the SELECT ... FOR UPDATE - no read-then-insert gap lock
        // upgrade, so no deadlock.
        $pdo->prepare(
            "INSERT IGNORE INTO accomplishment_report (barangay_id, user_id, month, status, version, created_at, updated_at)
             VALUES (:barangay_id, :user_id, :month, 'open', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())"
        )->execute(['barangay_id' => $identity['barangay_id'], 'user_id' => $identity['user_id'], 'month' => $month]);
        $select = $pdo->prepare('SELECT * FROM accomplishment_report WHERE user_id = :user_id AND month = :month FOR UPDATE');
        $select->execute(['user_id' => $identity['user_id'], 'month' => $month]);
        $report = $select->fetch(PDO::FETCH_ASSOC);
        if ($report === false) {
            throw new ApiError(500, 'SERVER_ERROR', 'Could not open the monthly report.');
        }
        return $report;
    }

    private static function validateText(mixed $raw): string
    {
        if (!is_string($raw) || trim($raw) === '') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'accomplishment_text is required.');
        }
        $text = trim($raw);
        if (mb_strlen($text) > self::TEXT_MAX) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'accomplishment_text must be at most ' . self::TEXT_MAX . ' characters.');
        }
        return $text;
    }

    /** @return array{0:?string,1:?string} start/end as HH:MM:SS, both or neither */
    private static function validateTimes(mixed $start, mixed $end): array
    {
        if ($start === null && $end === null) {
            return [null, null];
        }
        if ($start === null || $end === null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'start_time and end_time must be provided together or not at all.');
        }
        foreach ([$start, $end] as $value) {
            if (!is_string($value) || !preg_match(self::TIME_PATTERN, $value)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'start_time and end_time must be HH:MM (or HH:MM:SS).');
            }
        }
        $normalize = static fn (string $t): string => strlen($t) === 5 ? $t . ':00' : $t;
        return [$normalize($start), $normalize($end)];
    }

    private static function validateDuration(mixed $raw): int
    {
        if (!is_int($raw) && !(is_string($raw) && ctype_digit($raw))) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'duration_minutes must be an integer between 1 and 1440.');
        }
        $minutes = (int) $raw;
        if ($minutes < 1 || $minutes > 1440) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'duration_minutes must be an integer between 1 and 1440.');
        }
        return $minutes;
    }

    /** @return array<string,mixed>|null */
    private static function findEntryByClientEvent(PDO $pdo, int $userId, string $clientEventId): ?array
    {
        $stmt = $pdo->prepare('SELECT * FROM accomplishment_entry WHERE user_id = :user_id AND client_event_id = :cid LIMIT 1');
        $stmt->execute(['user_id' => $userId, 'cid' => $clientEventId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /** @return array<string,mixed>|null */
    private static function findEntryById(PDO $pdo, int $entryId): ?array
    {
        $stmt = $pdo->prepare('SELECT * FROM accomplishment_entry WHERE entry_id = :id LIMIT 1');
        $stmt->execute(['id' => $entryId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /**
     * @param array<string,mixed> $entryRow
     * @return array{id:int,wasCreated:bool,entry:array<string,mixed>,report:array<string,mixed>}
     */
    private static function entryResult(PDO $pdo, array $entryRow, bool $wasCreated): array
    {
        $report = self::fetchReportRow($pdo, (int) ($entryRow['report_id'] ?? 0));
        return [
            'id' => (int) ($entryRow['entry_id'] ?? 0),
            'wasCreated' => $wasCreated,
            'entry' => self::mapEntry($entryRow, true),
            'report' => self::mapReport($report ?? []),
        ];
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapEntry(array $row, bool $includeText): array
    {
        return [
            'entry_id' => (int) ($row['entry_id'] ?? 0),
            'report_id' => (int) ($row['report_id'] ?? 0),
            'user_id' => (int) ($row['user_id'] ?? 0),
            'work_date' => $row['work_date'] ?? null,
            'accomplishment_text' => $includeText ? ($row['accomplishment_text'] ?? null) : null,
            'start_time' => $row['start_time'] ?? null,
            'end_time' => $row['end_time'] ?? null,
            'duration_minutes' => (int) ($row['duration_minutes'] ?? 0),
            'suggested_duration_minutes' => isset($row['suggested_duration_minutes']) ? (int) $row['suggested_duration_minutes'] : null,
            'duration_flag' => (int) ($row['duration_flag'] ?? 0) === 1,
            'client_event_id' => $row['client_event_id'] ?? null,
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function mapReport(array $row): array
    {
        return [
            'report_id' => (int) ($row['report_id'] ?? 0),
            'barangay_id' => (int) ($row['barangay_id'] ?? 0),
            'user_id' => (int) ($row['user_id'] ?? 0),
            'month' => $row['month'] ?? null,
            'status' => $row['status'] ?? null,
            'prepared_at' => $row['prepared_at'] ?? null,
            'noted_by' => isset($row['noted_by']) ? (int) $row['noted_by'] : null,
            'noted_at' => $row['noted_at'] ?? null,
            'approved_by' => isset($row['approved_by']) ? (int) $row['approved_by'] : null,
            'approved_at' => $row['approved_at'] ?? null,
            'return_reason' => $row['return_reason'] ?? null,
            'total_minutes_confirmed' => isset($row['total_minutes_confirmed']) ? (int) $row['total_minutes_confirmed'] : null,
            'version' => (int) ($row['version'] ?? 1),
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ] + PaperApproval::fields($row, isset($row['paper_recorded_by_name']) ? (string) $row['paper_recorded_by_name'] : null);
    }
}
