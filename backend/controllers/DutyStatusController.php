<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Lib\ClientEventTime;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * GET /duty-status — Master Reference §6 "Duty status" section, §5
 * `duty_status` table, §9 W3 (Tanod picker only offers currently
 * eligible/on-duty Tanods).
 *
 * §6 documents two distinct query shapes on the same path:
 * `?user_id=me` (Tanod, own history) and `?barangay_id=` (Admin/PB,
 * current status per active user).
 *
 * `POST /duty-status` — added for Sprint 2's M2 Home box. §6: "Tanod
 * only; body `{status,client_event_id}` -> `{status_id,status,
 * channel:"app",changed_at}`. Valid statuses are on_duty|responding|
 * off_duty; server writes channel=app."
 *
 * Resolved decision (logged in DEVLOG.md — §6 states the contract but not
 * this specific): **idempotent retry via `client_event_id`.** §5's
 * `duty_status` table has `UNIQUE(user_id,client_event_id)` specifically
 * so a retried toggle (e.g. a Tanod double-tapping on a slow connection)
 * returns the original row instead of erroring or creating a second
 * status change — same pattern already used by `POST /dispatch`'s
 * `request_id` and `POST /shifts`'s `request_id`.
 *
 * `applyToggle()` (Sprint 3 cut) is `public` so `SyncController::batch()`
 * (POST /sync/batch's `duty_status_updates[]` items) reuses the exact same
 * lookup-then-insert logic `create()` already used inline.
 *
 * OFFLINE OFF-DUTY (closes the A4 / Rule 49 gap): going OFF duty may be
 * queued on the device while offline and arrive later through
 * `/sync/batch`'s `duty_status_updates[]` carrying the device's real tap
 * time as `changed_at`. `applyToggle()` then records the row AT THAT TIME
 * (not the arrival time), so the suggested duty duration
 * (`AccomplishmentController::computeSuggestedMinutes()`) ends the on-duty
 * interval when the Tanod actually went off duty. Going ON duty stays
 * online-only: a client `changed_at` is refused for any status other than
 * off_duty. Validation of the client time: not more than
 * FUTURE_SKEW_SECONDS ahead of the server clock, not older than
 * MAX_BACKDATE_DAYS, and not before the Tanod's latest on_duty/responding
 * row (the off-duty must close the shift it belongs to). The active-
 * dispatch block (H-02) applies exactly as for a live toggle, so a queued
 * off-duty is rejected while the server still sees an active dispatch.
 */
final class DutyStatusController
{
    private const DEFAULT_LIMIT = 25;
    private const MAX_LIMIT = 100;
    private const VALID_STATUSES = ['on_duty', 'responding', 'off_duty'];
    /** Tolerated device-clock skew for a client changed_at (matches GpsController / SchoolCheckinsController). */
    private const FUTURE_SKEW_SECONDS = 300;
    /** Oldest client changed_at accepted (matches the other offline-queued kinds' 62-day window). */
    private const MAX_BACKDATE_DAYS = 62;

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function index(PDO $pdo, array $identity): void
    {
        $userIdParam = Http::query('user_id');
        $barangayIdParam = Http::query('barangay_id');

        if ($userIdParam !== null && $barangayIdParam !== null) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Provide either user_id or barangay_id, not both.');
        }

        if ($userIdParam !== null) {
            if ($userIdParam !== 'me') {
                throw new ApiError(400, 'VALIDATION_ERROR', "user_id only supports the literal value 'me'.");
            }
            AuthMiddleware::requireRole($identity, ['tanod']);
            self::ownHistory($pdo, $identity);
            return;
        }

        if ($barangayIdParam !== null) {
            if (!ctype_digit($barangayIdParam)) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'barangay_id must be numeric.');
            }
            AuthMiddleware::requireRole($identity, ['admin', 'punong_barangay']);
            AuthMiddleware::requireTenant($identity, (int) $barangayIdParam);
            self::currentByBarangay($pdo, $identity);
            return;
        }

        throw new ApiError(400, 'VALIDATION_ERROR', 'Provide either user_id=me or barangay_id.');
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function create(PDO $pdo, array $identity): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);

        $body = Http::jsonBody();
        $status = $body['status'] ?? null;
        $clientEventId = $body['client_event_id'] ?? null;

        if (!is_string($status) || !in_array($status, self::VALID_STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of on_duty, responding, off_duty.');
        }
        if (!is_string($clientEventId) || !preg_match('/^[0-9a-fA-F-]{36}$/', $clientEventId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
        }

        $result = self::applyToggle($pdo, $identity, $status, $clientEventId);

        if ($result['wasCreated']) {
            Audit::record(
                $pdo,
                $identity['barangay_id'],
                $identity['user_id'],
                'duty_status_changed',
                'duty_status',
                $result['status_id'],
                ['status' => $result['status'], 'channel' => $result['channel']]
            );
        }

        Http::send($result['wasCreated'] ? 201 : 200, [
            'status_id' => $result['status_id'],
            'status' => $result['status'],
            'channel' => $result['channel'],
            'changed_at' => $result['changed_at'],
        ]);
    }

    /**
     * Core duty-status-toggle logic, shared by the direct POST /duty-status
     * path and `SyncController::batch()`'s `duty_status_updates[]` items.
     *
     * @param string $channel §5 `duty_status.channel` ENUM('app','sms').
     *        Defaults to 'app'. §2 Rule 13: "`duty_status.channel = 'sms'`
     *        is written only by the validated internal SMS handler" —
     *        `SmsGatewayService`'s `/sms/duty-status` handler is the one
     *        caller that passes 'sms', and only after resolving the
     *        caller's identity server-side from the device mapping, never
     *        from anything embedded in the SMS payload.
     * @param mixed $clientChangedAt Optional device time (ISO-8601 with Z or
     *        offset) of a queued OFF-duty toggle — see the class doc. Only
     *        `SyncController` passes it; null keeps the server-time behaviour.
     * @return array{status_id:int,status:string,channel:string,changed_at:string,wasCreated:bool}
     */
    public static function applyToggle(
        PDO $pdo,
        array $identity,
        string $status,
        mixed $clientEventId,
        string $channel = 'app',
        mixed $clientChangedAt = null
    ): array {
        if (!in_array($status, self::VALID_STATUSES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'status must be one of on_duty, responding, off_duty.');
        }
        if (!is_string($clientEventId) || !preg_match('/^[0-9a-fA-F-]{36}$/', $clientEventId)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'client_event_id must be a UUID.');
        }

        // Idempotent retry: the same (user_id, client_event_id) pair returns
        // the row already written instead of erroring on the UNIQUE
        // constraint or creating a duplicate status change.
        $existingStmt = $pdo->prepare(
            'SELECT status_id, status, channel, changed_at FROM duty_status
             WHERE user_id = :user_id AND client_event_id = :client_event_id LIMIT 1'
        );
        $existingStmt->execute(['user_id' => $identity['user_id'], 'client_event_id' => $clientEventId]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if ($existing !== false) {
            return [
                'status_id' => (int) $existing['status_id'],
                'status' => $existing['status'],
                'channel' => $existing['channel'],
                'changed_at' => $existing['changed_at'],
                'wasCreated' => false,
            ];
        }

        // Client-timestamped (queued offline) toggle: validated AFTER the
        // idempotent-retry return above, so a replay of an already-recorded
        // event still short-circuits to the original row even once its
        // changed_at has aged out of the window.
        $changedAt = null;
        if ($clientChangedAt !== null) {
            if ($status !== 'off_duty') {
                throw new ApiError(400, 'VALIDATION_ERROR', 'changed_at is only accepted for off_duty; going on duty is online-only.');
            }
            $changedAt = self::validateClientChangedAt($pdo, (int) $identity['user_id'], $clientChangedAt);
        }

        // Code-review finding H-02 (2026-09-24): nothing here checked
        // whether the caller had an active dispatch before letting them go
        // off_duty, so live rosters and actual field coverage could
        // silently diverge. Checked only for a genuinely NEW status change
        // (after the idempotent-retry return above), so replaying an
        // already-recorded off_duty transition via the same client_event_id
        // still short-circuits to the original success rather than
        // re-running this check.
        if ($status === 'off_duty') {
            $activeDispatchStmt = $pdo->prepare(
                "SELECT 1 FROM dispatch
                 WHERE tanod_id = :tanod_id AND status IN ('assigned','en_route','arrived')
                 LIMIT 1"
            );
            $activeDispatchStmt->execute(['tanod_id' => $identity['user_id']]);
            if ($activeDispatchStmt->fetch(PDO::FETCH_ASSOC) !== false) {
                throw new ApiError(409, 'CONFLICT', 'Cannot go off duty while a dispatch is still active.');
            }
        }

        $insertStmt = $pdo->prepare(
            "INSERT INTO duty_status (user_id, status, channel, client_event_id, changed_at)
             VALUES (:user_id, :status, :channel, :client_event_id, COALESCE(:changed_at, UTC_TIMESTAMP()))"
        );
        $insertStmt->execute([
            'user_id' => $identity['user_id'],
            'status' => $status,
            'channel' => in_array($channel, ['app', 'sms'], true) ? $channel : 'app',
            'client_event_id' => $clientEventId,
            'changed_at' => $changedAt?->format('Y-m-d H:i:s'),
        ]);
        $statusId = (int) $pdo->lastInsertId();

        // Accomplishment entries already written for the days this back-dated
        // off-duty now cuts short carry a suggested duration computed while
        // the shift still looked open; refresh them (editable months only).
        if ($changedAt !== null) {
            AccomplishmentController::refreshSuggestedSince($pdo, (int) $identity['user_id'], $changedAt);
        }

        $readBack = $pdo->prepare('SELECT status, channel, changed_at FROM duty_status WHERE status_id = :id');
        $readBack->execute(['id' => $statusId]);
        $created = $readBack->fetch(PDO::FETCH_ASSOC);

        return [
            'status_id' => $statusId,
            'status' => $created['status'],
            'channel' => $created['channel'],
            'changed_at' => $created['changed_at'],
            'wasCreated' => true,
        ];
    }

    /**
     * Parses and range-checks a queued off-duty's device time. Returns it
     * in UTC, truncated to whole seconds (`duty_status.changed_at` is a
     * DATETIME).
     */
    private static function validateClientChangedAt(PDO $pdo, int $userId, mixed $value): \DateTimeImmutable
    {
        if (!is_string($value)
            || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/', $value)
        ) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'changed_at must be an ISO-8601 timestamp with a Z or UTC offset.');
        }
        try {
            $parsed = (new \DateTimeImmutable($value))->setTimezone(new \DateTimeZone('UTC'));
        } catch (\Exception) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'changed_at must be an ISO-8601 timestamp with a Z or UTC offset.');
        }
        $parsed = $parsed->setTime((int) $parsed->format('H'), (int) $parsed->format('i'), (int) $parsed->format('s'));

        $now = time();
        if ($parsed->getTimestamp() > $now + self::FUTURE_SKEW_SECONDS) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'changed_at cannot be in the future.');
        }
        if ($parsed->getTimestamp() < $now - self::MAX_BACKDATE_DAYS * 86400) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'changed_at cannot be more than ' . self::MAX_BACKDATE_DAYS . ' days in the past.');
        }

        $lastOnStmt = $pdo->prepare(
            "SELECT MAX(changed_at) FROM duty_status WHERE user_id = :user_id AND status IN ('on_duty','responding')"
        );
        $lastOnStmt->execute(['user_id' => $userId]);
        $lastOn = $lastOnStmt->fetchColumn();
        if (is_string($lastOn) && $lastOn !== '') {
            $lastOnAt = new \DateTimeImmutable($lastOn, new \DateTimeZone('UTC'));
            if ($parsed < $lastOnAt) {
                throw new ApiError(409, 'CONFLICT', 'changed_at is before your last on-duty record; this off-duty cannot be recorded.');
            }
        }

        // A future-skewed (but tolerated) device time is clamped to the
        // server clock so no duty_status row is ever dated in the future.
        $serverNow = new \DateTimeImmutable('@' . $now);
        return $parsed > $serverNow ? $serverNow : $parsed;
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    private static function ownHistory(PDO $pdo, array $identity): void
    {
        $page = max(1, (int) (Http::query('page') ?? '1'));
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));
        $offset = ($page - 1) * $limit;

        $countStmt = $pdo->prepare('SELECT COUNT(*) FROM duty_status WHERE user_id = :user_id');
        $countStmt->execute(['user_id' => $identity['user_id']]);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            'SELECT status_id, status, channel, changed_at
             FROM duty_status
             WHERE user_id = :user_id
             ORDER BY changed_at DESC
             LIMIT :limit OFFSET :offset'
        );
        $stmt->bindValue(':user_id', $identity['user_id'], PDO::PARAM_INT);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static fn (array $row): array => [
            'status_id' => (int) $row['status_id'],
            'status' => $row['status'],
            'channel' => $row['channel'],
            'changed_at' => $row['changed_at'],
        ], $rows);

        Http::send(200, ['items' => $items, 'page' => $page, 'limit' => $limit, 'total' => $total]);
    }

    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    private static function currentByBarangay(PDO $pdo, array $identity): void
    {
        // "Current" = latest row by changed_at per active Tanod (§6).
        $stmt = $pdo->prepare(
            "SELECT ds.user_id, ds.status, ds.channel, ds.changed_at
             FROM duty_status ds
             JOIN user u ON u.user_id = ds.user_id
             WHERE u.barangay_id = :barangay_id AND u.role = 'tanod' AND u.is_active = 1
               AND ds.changed_at = (
                   SELECT MAX(ds2.changed_at) FROM duty_status ds2 WHERE ds2.user_id = ds.user_id
               )
             ORDER BY ds.changed_at DESC"
        );
        $stmt->execute(['barangay_id' => $identity['barangay_id']]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static fn (array $row): array => [
            'user_id' => (int) $row['user_id'],
            'status' => $row['status'],
            'channel' => $row['channel'],
            'changed_at' => $row['changed_at'],
        ], $rows);

        Http::send(200, ['items' => $items]);
    }
}
