<?php
declare(strict_types=1);

namespace Baranguard\Services\Dispatch;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Audit;
use Baranguard\Services\Notifications\NotificationDispatcher;
use Baranguard\Services\Notifications\NotificationService;
use PDO;

/**
 * OfferService — night-time dispatch offers (Wave 2 review decision,
 * migration 0038).
 *
 * THE MODEL. From 18:00 (inclusive) to 06:00 (exclusive) Asia/Manila, every
 * newly created PENDING incident automatically opens an *offer*: a broadcast
 * to every Tanod who is on duty (latest `duty_status` = `on_duty`, so not
 * `responding`), holds a PUBLISHED shift covering now, is active and
 * unsuspended, and has no active dispatch. The first accept the server
 * records wins and becomes an ordinary `dispatch` row (via
 * `DispatchController::createWithinTransaction`, the same code path as
 * `POST /dispatch`); the other recipients are released. During the day
 * nothing is broadcast and the Admin assigns as before. An Admin/Secretary
 * may also open an offer manually at any time (`POST /dispatch-offers`).
 *
 * TIMEOUT / ESCALATION. An offer lives 180 s per round. The sweeper
 * (`scripts/dispatch-offer-sweeper.php` -> `sweep()` below) handles every
 * live offer whose `expires_at` has passed: the current recipients become
 * `expired`, the barangay's Admin(s) get a `priority_alert`, and — up to
 * MAX_ROUNDS rounds in total — the offer is re-broadcast to every Tanod who
 * qualifies at that moment. If nobody qualifies, or round 3 has run out, the
 * offer is `escalated`: no Tanod can accept it any more, and the Admin(s)
 * keep being reminded on a backoff (see ESCALATION_REMINDER_DELAYS: +3, +6,
 * +12 min, then every 30 min, max MAX_ESCALATION_REMINDERS = 8 reminders,
 * then silence) until somebody assigns a responder (which closes the
 * offer), cancels it, or the incident stops being pending/dispatched.
 * The offer stays escalated, and visible on the dispatch board, after the cap. `round` is mutated in place: an offer row is the
 * incident's single live offer, not one row per round.
 *
 * ALERT CONTENT IS NON-IDENTIFYING: incident type, barangay name and time.
 * Never narrative, names, contacts, coordinates or location text
 * (NotificationDispatcher composes the text; this class only creates the
 * notification rows).
 *
 * LOCK ORDER (deadlock avoidance): every path that changes an offer locks
 * the INCIDENT row first, then the offer row (`lockOffer()`), the same order
 * `DispatchController::create()` already uses (incident, then — via
 * `closeLiveOffersForIncident()` — offers). Concurrency is reasoned from
 * `SELECT ... FOR UPDATE`, not demonstrated: `php -S` is single-threaded.
 *
 * RULE 7. The auto-trigger runs AFTER the incident's own commit and can
 * never fail or roll back incident creation (`autoOpenForNewIncident()`
 * swallows and logs everything).
 *
 * TEST SEAMS (read ONLY when `APP_ENV` is set to something other than
 * `production`; an unset `APP_ENV` disables them, so a production box that
 * never defines APP_ENV can never honour them):
 *   BARANGUARD_NOW_OVERRIDE       an ISO-8601 instant that replaces "now" for
 *                                 every offer decision (night test, round
 *                                 timing, expiry, shift cover).
 *   BARANGUARD_TEST_OFFER_FAULT=1 makes openForIncident() throw, to prove
 *                                 incident creation survives it.
 */
final class OfferService
{
    /** Night window, Asia/Manila (fixed +08:00): [18:00, 06:00). Constants, not config. */
    public const NIGHT_START_HOUR = 18;
    public const NIGHT_END_HOUR = 6;

    /** Seconds a round stays open before the sweeper escalates/re-broadcasts. */
    public const ACCEPT_TIMEOUT_SECONDS = 180;

    /** Total tanod broadcast rounds before an offer stays `escalated`. */
    public const MAX_ROUNDS = 3;

    /**
     * Admin reminder backoff for an `escalated` offer (constants, not config).
     * The alert sent at the moment of escalation is not a reminder. Each entry
     * is the wait, in seconds, after the previous alert before the NEXT
     * reminder: first reminder +3 min after escalation, second +6 min after
     * the first, third +12 min after the second, every later one +30 min.
     * At most MAX_ESCALATION_REMINDERS reminders per offer, then the sweeper
     * stops alerting (the offer stays escalated and visible on the board).
     */
    public const ESCALATION_REMINDER_DELAYS = [180, 360, 720, 1800];
    public const MAX_ESCALATION_REMINDERS = 8;

    private const MANILA_OFFSET = '+08:00';
    private const SWEEP_BATCH = 100;

    // ------------------------------------------------------------------ clock

    /** True only when a non-production APP_ENV is set explicitly. */
    private static function testSeamsEnabled(): bool
    {
        $appEnv = baranguard_env('APP_ENV');
        return is_string($appEnv) && $appEnv !== '' && strtolower($appEnv) !== 'production';
    }

    /** "Now" in UTC — real clock unless the (guarded) test override is set. */
    public static function now(): \DateTimeImmutable
    {
        $utc = new \DateTimeZone('UTC');
        if (self::testSeamsEnabled()) {
            $override = baranguard_env('BARANGUARD_NOW_OVERRIDE');
            if (is_string($override) && $override !== '') {
                try {
                    return (new \DateTimeImmutable($override))->setTimezone($utc);
                } catch (\Exception) {
                    // fall through to the real clock
                }
            }
        }
        return new \DateTimeImmutable('now', $utc);
    }

    /** Is this instant inside the night window in Manila? */
    public static function isNight(\DateTimeImmutable $instant): bool
    {
        $hour = (int) $instant->setTimezone(new \DateTimeZone(self::MANILA_OFFSET))->format('G');
        return $hour >= self::NIGHT_START_HOUR || $hour < self::NIGHT_END_HOUR;
    }

    private static function fmt(\DateTimeImmutable $instant): string
    {
        return $instant->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    }

    // ------------------------------------------------------------- recipients

    /**
     * Tanods who may be offered a call right now: same barangay, active,
     * unsuspended, latest duty status exactly `on_duty`, a PUBLISHED shift
     * covering `$now`, and no active dispatch anywhere.
     *
     * @return int[]
     */
    public static function qualifyingTanods(PDO $pdo, int $barangayId, \DateTimeImmutable $now): array
    {
        $stmt = $pdo->prepare(
            "SELECT u.user_id
               FROM user u
              WHERE u.barangay_id = :barangay_id
                AND u.role = 'tanod' AND u.is_active = 1 AND u.is_suspended = 0
                AND EXISTS (
                    SELECT 1 FROM duty_status ds
                     WHERE ds.user_id = u.user_id AND ds.status = 'on_duty'
                       AND ds.changed_at = (SELECT MAX(ds2.changed_at) FROM duty_status ds2 WHERE ds2.user_id = u.user_id)
                )
                AND EXISTS (
                    SELECT 1 FROM shift_schedule s
                     WHERE s.user_id = u.user_id AND s.barangay_id = u.barangay_id
                       AND s.approval_status = 'published'
                       AND s.start_at <= :now_start AND s.end_at > :now_end
                )
                AND NOT EXISTS (
                    SELECT 1 FROM dispatch d
                     WHERE d.tanod_id = u.user_id AND d.status IN ('assigned','en_route','arrived')
                )
              ORDER BY u.user_id"
        );
        $stmt->execute([
            'barangay_id' => $barangayId,
            'now_start' => self::fmt($now),
            'now_end' => self::fmt($now),
        ]);
        return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    }

    /**
     * Chief Tanod seat: the barangay's active, unsuspended Admin accounts.
     * (Not the Secretary — an escalation is a dispatch problem for the
     * person who can assign a responder.)
     *
     * @return int[]
     */
    public static function adminIds(PDO $pdo, int $barangayId): array
    {
        $stmt = $pdo->prepare(
            "SELECT user_id FROM user
              WHERE barangay_id = :barangay_id AND role = 'admin' AND is_active = 1 AND is_suspended = 0
              ORDER BY user_id"
        );
        $stmt->execute(['barangay_id' => $barangayId]);
        return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    }

    // ------------------------------------------------------------------ locks

    /**
     * Locks the offer's incident row, then the offer row, and returns the
     * offer (or null when it does not exist). See the class doc's lock
     * order. Must be called inside a transaction.
     *
     * @return array<string,mixed>|null
     */
    public static function lockOffer(PDO $pdo, int $offerId): ?array
    {
        $peek = $pdo->prepare('SELECT incident_id FROM dispatch_offer WHERE offer_id = :id');
        $peek->execute(['id' => $offerId]);
        $incidentId = $peek->fetchColumn();
        if ($incidentId === false) {
            return null;
        }
        $pdo->prepare('SELECT incident_id FROM incident WHERE incident_id = :id FOR UPDATE')
            ->execute(['id' => (int) $incidentId]);
        $stmt = $pdo->prepare('SELECT * FROM dispatch_offer WHERE offer_id = :id FOR UPDATE');
        $stmt->execute(['id' => $offerId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    // ------------------------------------------------------------------- open

    /**
     * Night auto-trigger, called by every incident-create path AFTER its own
     * commit. At night, opens an offer for the new pending incident; by day
     * does nothing. NEVER throws (Rule 7): any failure is logged and
     * swallowed so incident creation is unaffected.
     */
    public static function autoOpenForNewIncident(PDO $pdo, int $incidentId, int $barangayId): void
    {
        try {
            if (!self::isNight(self::now())) {
                return;
            }
            if ($pdo->inTransaction()) {
                // A caller's transaction is still open: refuse rather than
                // commit or roll back something that is not ours.
                error_log('[baranguard] dispatch offer skipped for incident_id=' . $incidentId . ': caller transaction still open');
                return;
            }
            self::openForIncident($pdo, $incidentId, $barangayId, null, null, true);
        } catch (\Throwable $e) {
            error_log('[baranguard] dispatch offer auto-open failed for incident_id=' . $incidentId . ': ' . $e->getMessage());
        }
    }

    /**
     * Opens a round-1 offer for an incident. Runs its own transaction
     * (the caller must not have one open) and sends the notifications after
     * commit.
     *
     * With nobody qualifying the offer is created already `escalated` (zero
     * recipients) and the Admin(s) are alerted straight away.
     *
     * @param ?int    $createdBy  NULL = opened by the system (night auto-trigger)
     * @param ?string $requestKey Idempotency-Key of a manual open
     * @return array{offer_id:int,incident_id:int,round:int,status:string,recipient_count:int,expires_at:string}
     * @throws ApiError 404 unknown/other-tenant incident, 409 not pending/dispatched or an offer is already live
     */
    public static function openForIncident(
        PDO $pdo,
        int $incidentId,
        int $barangayId,
        ?int $createdBy,
        ?string $requestKey,
        bool $auto
    ): array {
        if (self::testSeamsEnabled() && baranguard_env('BARANGUARD_TEST_OFFER_FAULT') === '1') {
            throw new \RuntimeException('Test fault injected into OfferService::openForIncident.');
        }

        $notificationIds = [];
        $pdo->beginTransaction();
        try {
            $incStmt = $pdo->prepare('SELECT incident_id, barangay_id, status FROM incident WHERE incident_id = :id FOR UPDATE');
            $incStmt->execute(['id' => $incidentId]);
            $incident = $incStmt->fetch(PDO::FETCH_ASSOC);
            if ($incident === false || (int) $incident['barangay_id'] !== $barangayId) {
                throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
            }
            if (!in_array($incident['status'], ['pending', 'dispatched', 'reopened'], true)) {
                throw new ApiError(409, 'CONFLICT', 'Incident is not pending, reopened or dispatched.');
            }
            $liveStmt = $pdo->prepare("SELECT 1 FROM dispatch_offer WHERE incident_id = :id AND status IN ('open','escalated') LIMIT 1");
            $liveStmt->execute(['id' => $incidentId]);
            if ($liveStmt->fetchColumn() !== false) {
                throw new ApiError(409, 'CONFLICT', 'This incident already has a live dispatch offer.');
            }

            $now = self::now();
            $recipients = self::qualifyingTanods($pdo, $barangayId, $now);
            $status = $recipients === [] ? 'escalated' : 'open';
            $expires = $now->modify('+' . self::ACCEPT_TIMEOUT_SECONDS . ' seconds');

            $pdo->prepare(
                'INSERT INTO dispatch_offer
                    (incident_id, barangay_id, `round`, status, created_at, expires_at, created_by, request_key)
                 VALUES (:incident_id, :barangay_id, 1, :status, :created_at, :expires_at, :created_by, :request_key)'
            )->execute([
                'incident_id' => $incidentId,
                'barangay_id' => $barangayId,
                'status' => $status,
                'created_at' => self::fmt($now),
                'expires_at' => self::fmt($expires),
                'created_by' => $createdBy,
                'request_key' => $requestKey,
            ]);
            $offerId = (int) $pdo->lastInsertId();

            if ($recipients !== []) {
                $notificationIds[] = self::broadcast($pdo, $offerId, $incidentId, $barangayId, $createdBy, $recipients, $now);
            } else {
                $alertId = self::alertAdmins($pdo, $offerId, $incidentId, $barangayId);
                if ($alertId !== null) {
                    $notificationIds[] = $alertId;
                }
            }

            Audit::record($pdo, $barangayId, $createdBy, 'dispatch_offer_opened', 'dispatch_offer', $offerId, [
                'incident_id' => $incidentId,
                'round' => 1,
                'status' => $status,
                'recipient_count' => count($recipients),
                'auto' => $auto,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        self::deliver($pdo, $notificationIds);

        return [
            'offer_id' => $offerId,
            'incident_id' => $incidentId,
            'round' => 1,
            'status' => $status,
            'recipient_count' => count($recipients),
            'expires_at' => self::fmt($expires),
        ];
    }

    // -------------------------------------------------------------- recipients

    /**
     * Inserts/refreshes the recipient rows as `offered` and creates the one
     * `dispatch_offer` notification (with a target per recipient). Inside the
     * caller's transaction. Returns the notification id.
     *
     * @param int[] $recipients
     */
    private static function broadcast(PDO $pdo, int $offerId, int $incidentId, int $barangayId, ?int $createdBy, array $recipients, \DateTimeImmutable $now): int
    {
        $upsert = $pdo->prepare(
            "INSERT INTO dispatch_offer_recipient (offer_id, user_id, status, notified_at)
             VALUES (:offer_id, :user_id, 'offered', :notified_at)
             ON DUPLICATE KEY UPDATE status = 'offered', notified_at = :notified_at2"
        );
        foreach ($recipients as $userId) {
            $upsert->execute([
                'offer_id' => $offerId,
                'user_id' => $userId,
                'notified_at' => self::fmt($now),
                'notified_at2' => self::fmt($now),
            ]);
        }
        $result = NotificationService::create(
            $pdo,
            $barangayId,
            NotificationService::TYPE_DISPATCH_OFFER,
            ['dispatch_offer_id' => $offerId, 'incident_id' => $incidentId],
            $createdBy,
            $recipients
        );
        return $result['notification_id'];
    }

    /**
     * `priority_alert` to the barangay's Admin(s) for an unanswered offer.
     * Returns the notification id, or null when the barangay has no Admin.
     */
    private static function alertAdmins(PDO $pdo, int $offerId, int $incidentId, int $barangayId): ?int
    {
        $admins = self::adminIds($pdo, $barangayId);
        if ($admins === []) {
            return null;
        }
        $result = NotificationService::create(
            $pdo,
            $barangayId,
            NotificationService::TYPE_PRIORITY_ALERT,
            ['incident_id' => $incidentId, 'dispatch_offer_id' => $offerId],
            null,
            $admins
        );
        return $result['notification_id'];
    }

    /** Releases every still-`offered` recipient (optionally sparing one). */
    public static function releaseRecipients(PDO $pdo, int $offerId, ?int $exceptUserId = null): void
    {
        $sql = "UPDATE dispatch_offer_recipient SET status = 'released' WHERE offer_id = :offer_id AND status = 'offered'";
        $params = ['offer_id' => $offerId];
        if ($exceptUserId !== null) {
            $sql .= ' AND user_id <> :except_id';
            $params['except_id'] = $exceptUserId;
        }
        $pdo->prepare($sql)->execute($params);
    }

    /**
     * An Admin assigning a responder (POST /dispatch) settles every live
     * offer on that incident: status `closed`, recipients released. Runs
     * inside the caller's transaction with the incident row already locked.
     * Audited only when something was actually closed.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function closeLiveOffersForIncident(PDO $pdo, array $identity, int $incidentId, string $reason): void
    {
        $stmt = $pdo->prepare("SELECT offer_id, `round` FROM dispatch_offer WHERE incident_id = :id AND status IN ('open','escalated') FOR UPDATE");
        $stmt->execute(['id' => $incidentId]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $offer) {
            $pdo->prepare("UPDATE dispatch_offer SET status = 'closed', closed_at = UTC_TIMESTAMP() WHERE offer_id = :id")
                ->execute(['id' => (int) $offer['offer_id']]);
            self::releaseRecipients($pdo, (int) $offer['offer_id']);
            Audit::record($pdo, (int) $identity['barangay_id'], (int) $identity['user_id'], 'dispatch_offer_closed', 'dispatch_offer', (int) $offer['offer_id'], [
                'incident_id' => $incidentId,
                'round' => (int) $offer['round'],
                'reason' => $reason,
            ]);
        }
    }

    // ------------------------------------------------------------------ sweep

    /**
     * Handles every live offer whose deadline has passed (see the class doc).
     * Safe to run from several processes at once: each offer is re-checked
     * under its lock. `$now` is injectable for tests.
     *
     * @return array{processed:int,rebroadcast:int,escalated:int,closed:int,errors:int}
     */
    public static function sweep(PDO $pdo, ?\DateTimeImmutable $now = null): array
    {
        $now ??= self::now();
        $summary = ['processed' => 0, 'rebroadcast' => 0, 'escalated' => 0, 'closed' => 0, 'errors' => 0];

        $stmt = $pdo->prepare(
            "SELECT offer_id FROM dispatch_offer
              WHERE status IN ('open','escalated') AND expires_at <= :now
              ORDER BY expires_at, offer_id
              LIMIT " . self::SWEEP_BATCH
        );
        $stmt->execute(['now' => self::fmt($now)]);
        foreach (array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN)) as $offerId) {
            try {
                self::processDue($pdo, $offerId, $now, $summary);
            } catch (\Throwable $e) {
                $summary['errors']++;
                error_log('[baranguard] dispatch offer sweep failed for offer_id=' . $offerId . ': ' . $e->getMessage());
            }
        }
        return $summary;
    }

    /** @param array{processed:int,rebroadcast:int,escalated:int,closed:int,errors:int} $summary */
    private static function processDue(PDO $pdo, int $offerId, \DateTimeImmutable $now, array &$summary): void
    {
        $notificationIds = [];
        $pdo->beginTransaction();
        try {
            $offer = self::lockOffer($pdo, $offerId);
            if ($offer === null
                || !in_array($offer['status'], ['open', 'escalated'], true)
                || (string) $offer['expires_at'] > self::fmt($now)
            ) {
                $pdo->rollBack();
                return;
            }
            $barangayId = (int) $offer['barangay_id'];
            $incidentId = (int) $offer['incident_id'];
            $roundBefore = (int) $offer['round'];

            $incStmt = $pdo->prepare('SELECT status FROM incident WHERE incident_id = :id');
            $incStmt->execute(['id' => $incidentId]);
            $incidentStatus = $incStmt->fetchColumn();

            if (!in_array($incidentStatus, ['pending', 'dispatched', 'reopened'], true)) {
                // The incident was resolved/cancelled/merged meanwhile: the
                // offer has nothing left to ask anyone.
                $pdo->prepare("UPDATE dispatch_offer SET status = 'closed', closed_at = UTC_TIMESTAMP() WHERE offer_id = :id")
                    ->execute(['id' => $offerId]);
                self::releaseRecipients($pdo, $offerId);
                Audit::record($pdo, $barangayId, null, 'dispatch_offer_closed', 'dispatch_offer', $offerId, [
                    'incident_id' => $incidentId,
                    'round' => $roundBefore,
                    'reason' => 'incident_not_actionable',
                ]);
                $pdo->commit();
                $summary['processed']++;
                $summary['closed']++;
                return;
            }

            if ($offer['status'] === 'escalated' && $roundBefore >= self::MAX_ROUNDS) {
                // Escalated with no tanod rounds left: a reminder tick, not a new
                // round. (An offer that escalated early, with zero recipients at
                // round < MAX_ROUNDS, still takes the round path below so it
                // re-broadcasts once a Tanod qualifies.)
                $countStmt = $pdo->prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'dispatch_offer_reminder' AND entity_type = 'dispatch_offer' AND entity_id = :id");
                $countStmt->execute(['id' => $offerId]);
                $sent = (int) $countStmt->fetchColumn();
                $alertId = null;
                if ($sent < self::MAX_ESCALATION_REMINDERS) {
                    $alertId = self::alertAdmins($pdo, $offerId, $incidentId, $barangayId);
                    if ($alertId !== null) {
                        $notificationIds[] = $alertId;
                    }
                    $reminderNo = $sent + 1;
                    Audit::record($pdo, $barangayId, null, 'dispatch_offer_reminder', 'dispatch_offer', $offerId, [
                        'incident_id' => $incidentId,
                        'reminder_no' => $reminderNo,
                        'admin_alerted' => $alertId !== null,
                    ]);
                    $delays = self::ESCALATION_REMINDER_DELAYS;
                    $wait = $delays[min($reminderNo, count($delays) - 1)];
                } else {
                    // Cap reached: no alert, no audit noise; keep a slow
                    // housekeeping tick so the offer still closes when the
                    // incident stops being actionable.
                    $wait = self::ESCALATION_REMINDER_DELAYS[count(self::ESCALATION_REMINDER_DELAYS) - 1];
                }
                $pdo->prepare('UPDATE dispatch_offer SET expires_at = :expires_at WHERE offer_id = :id')->execute([
                    'expires_at' => self::fmt($now->modify('+' . $wait . ' seconds')),
                    'id' => $offerId,
                ]);
                $pdo->commit();
                $summary['processed']++;
                $summary['escalated']++;
                self::deliver($pdo, $notificationIds);
                return;
            }

            // Nobody answered this round.
            $pdo->prepare("UPDATE dispatch_offer_recipient SET status = 'expired' WHERE offer_id = :id AND status = 'offered'")
                ->execute(['id' => $offerId]);

            $alertId = self::alertAdmins($pdo, $offerId, $incidentId, $barangayId);
            if ($alertId !== null) {
                $notificationIds[] = $alertId;
            }

            $roundAfter = $roundBefore;
            $recipientCount = 0;
            $statusAfter = 'escalated';
            if ($roundBefore < self::MAX_ROUNDS) {
                $roundAfter = $roundBefore + 1;
                $recipients = self::qualifyingTanods($pdo, $barangayId, $now);
                $recipientCount = count($recipients);
                if ($recipients !== []) {
                    $notificationIds[] = self::broadcast($pdo, $offerId, $incidentId, $barangayId, null, $recipients, $now);
                    $statusAfter = 'open';
                }
            }

            $pdo->prepare(
                'UPDATE dispatch_offer SET `round` = :round, status = :status, expires_at = :expires_at WHERE offer_id = :id'
            )->execute([
                'round' => $roundAfter,
                'status' => $statusAfter,
                'expires_at' => self::fmt($now->modify('+' . self::ACCEPT_TIMEOUT_SECONDS . ' seconds')),
                'id' => $offerId,
            ]);

            Audit::record($pdo, $barangayId, null, 'dispatch_offer_expired', 'dispatch_offer', $offerId, [
                'incident_id' => $incidentId,
                'round_before' => $roundBefore,
                'round_after' => $roundAfter,
                'status_after' => $statusAfter,
                'recipient_count' => $recipientCount,
                'admin_alerted' => $alertId !== null,
            ]);

            $pdo->commit();
            $summary['processed']++;
            if ($statusAfter === 'open') {
                $summary['rebroadcast']++;
            } else {
                $summary['escalated']++;
            }
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        self::deliver($pdo, $notificationIds);
    }

    // --------------------------------------------------------------- delivery

    /**
     * Sends the notifications created by a committed transaction. A
     * transport failure is a transport fact, never an error here.
     *
     * @param int[] $notificationIds
     */
    public static function deliver(PDO $pdo, array $notificationIds): void
    {
        foreach ($notificationIds as $notificationId) {
            try {
                (new NotificationDispatcher())->dispatchAll($pdo, $notificationId);
            } catch (\Throwable $e) {
                error_log('[baranguard] dispatch offer notification failed for notification_id=' . $notificationId . ': ' . $e->getMessage());
            }
        }
    }
}
