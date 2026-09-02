<?php
declare(strict_types=1);

namespace Baranguard\Services\Scheduling;

use PDO;

/**
 * Shared fatigue-recalculation logic for W11/W12 (`ShiftsController`,
 * `ShiftSwapRequestsController`) — Master Reference §6: "fatigue
 * recalculated for affected user" on shift create/edit/reassignment,
 * §9 W11: "Fatigue recalculates on create/edit/reassignment and shows its
 * calculation basis."
 *
 * Resolved decisions, logged in DEVLOG.md (§10: "Fatigue threshold is a
 * project safety rule, not a statutory claim about tanods" — the
 * reference deliberately leaves the actual number and window semantics
 * unstated, same situation `PasswordPolicy` documents for password
 * composition rules):
 *   - **Threshold: 56 scheduled hours in a rolling 7-day window** (~8h/day
 *     average sustained) — a project safety default, not a labor-law
 *     citation, same spirit as the login-lockout numbers `AuthController`
 *     picked.
 *   - **Window: the 7 days ending at the triggering shift's own
 *     `end_at`**, not "the 7 days ending right now." A scheduler mostly
 *     assigns *future* shifts — anchoring strictly to "now" would never
 *     count a newly-created week-from-now shift at all. Anchoring to the
 *     shift's own end_at correctly covers both a retrospective edit (its
 *     end_at is in the past) and a prospective assignment (its end_at is
 *     next week), which is what "does this new shift overload this
 *     person's week" actually needs to ask.
 *   - Hours are summed by `start_at` falling inside `[end_at - 7 days,
 *     end_at)` — a shift's start, not full interval overlap — a
 *     deliberate simplification for patrol-length shifts (hours or a
 *     single day, never spanning a full week themselves).
 *   - **A flag once raised is never deleted or un-raised** by a later
 *     recalculation that drops back under threshold — only an explicit
 *     `PATCH /fatigue-flags/:id/acknowledge` touches an existing row
 *     (§9 W13: "Acknowledgment never deletes or hides the historical
 *     record" — extended here to recalculation too, so the audit trail
 *     §10's evaluation hooks call for isn't silently rewritten).
 *     `hours_worked_7day`/`flagged_at` DO update in place on the SAME
 *     triggering shift if it's edited again while still over threshold
 *     (`UNIQUE(user_id, shift_id)` — a second raise for the same shift
 *     updates, not duplicates); a *different* shift crossing the
 *     threshold later creates its own separate flag row.
 */
final class FatigueCalculator
{
    private const THRESHOLD_HOURS = 56.0;

    /**
     * Recomputes the given user's rolling 7-day scheduled hours (anchored
     * to `$triggeringShiftId`'s own end_at) and raises/updates a
     * `fatigue_flag` row keyed to that shift if the total is over
     * threshold. No-op if the shift no longer exists (e.g. it was deleted
     * out from under a caller — not possible via any endpoint this sprint
     * builds, but defensive rather than assumed).
     */
    public static function recalculate(PDO $pdo, int $userId, int $triggeringShiftId): void
    {
        $shiftStmt = $pdo->prepare('SELECT end_at FROM shift_schedule WHERE shift_id = :shift_id');
        $shiftStmt->execute(['shift_id' => $triggeringShiftId]);
        $endAtRaw = $shiftStmt->fetchColumn();
        if ($endAtRaw === false) {
            return;
        }

        $utc = new \DateTimeZone('UTC');
        $windowEnd = new \DateTimeImmutable($endAtRaw, $utc);
        $windowStart = $windowEnd->modify('-7 days');

        $sumStmt = $pdo->prepare(
            'SELECT COALESCE(SUM(TIMESTAMPDIFF(MINUTE, start_at, end_at)), 0) / 60 AS total_hours
             FROM shift_schedule
             WHERE user_id = :user_id AND start_at >= :window_start AND start_at < :window_end'
        );
        $sumStmt->execute([
            'user_id' => $userId,
            'window_start' => $windowStart->format('Y-m-d H:i:s'),
            'window_end' => $windowEnd->format('Y-m-d H:i:s'),
        ]);
        $hours = round((float) $sumStmt->fetchColumn(), 2);

        if ($hours > self::THRESHOLD_HOURS) {
            $pdo->prepare(
                "INSERT INTO fatigue_flag (user_id, shift_id, hours_worked_7day, calculation_basis, flagged_at)
                 VALUES (:user_id, :shift_id, :hours, 'scheduled_hours', UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE hours_worked_7day = VALUES(hours_worked_7day), flagged_at = UTC_TIMESTAMP()"
            )->execute(['user_id' => $userId, 'shift_id' => $triggeringShiftId, 'hours' => $hours]);
        }
    }
}
