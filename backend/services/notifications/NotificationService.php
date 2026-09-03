<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

use Baranguard\Lib\ApiError;
use PDO;

/**
 * NotificationService — creates LOGICAL notifications and their per-user
 * targets (§5 `notification` / `notification_target`, §2 Rule 12).
 *
 * Rule 12's model is the thing to hold onto: **a notification has one
 * identity; transports are separate attempts against it.** Nothing in this
 * file sends anything. It records who needs to be told and why;
 * `NotificationDispatcher` (Phase 2) decides how, and writes
 * `notification_delivery` rows per attempt. Keeping those apart is what
 * makes §6's reliability reporting able to distinguish "the person was
 * reached" from "a transport succeeded" — Rule 24 requires exactly that
 * separation, and collapsing them would make the metric meaningless.
 *
 * THE ENTITY-INTEGRITY MATRIX IS ENFORCED HERE, IN APPLICATION CODE, and
 * that is deliberate rather than lazy. §5 states the matrix
 * (`dispatch` needs `dispatch_id`; `sos` needs `sos_id`; `priority_alert`
 * needs `incident_id` or `dispatch_id`) and also says a table-level CHECK
 * cannot express it — Sprint 0 confirmed MariaDB rejects that CHECK with
 * ERROR 1901, because all three columns carry `ON DELETE SET NULL`. So the
 * database physically cannot hold this invariant and the application must.
 * `assertEntityIntegrity()` below is that enforcement; every write path
 * goes through it.
 */
final class NotificationService
{
    public const TYPE_DISPATCH = 'dispatch';
    public const TYPE_SOS = 'sos';
    public const TYPE_PRIORITY_ALERT = 'priority_alert';
    public const TYPE_OTHER = 'other';

    private const TYPES = [self::TYPE_DISPATCH, self::TYPE_SOS, self::TYPE_PRIORITY_ALERT, self::TYPE_OTHER];

    /**
     * Creates one logical notification plus a target row per recipient.
     *
     * Runs entirely inside the CALLER's transaction when one is open — SOS
     * and dispatch both create their business row and their notification
     * as a single atomic act, and a notification that survived a rolled
     * back SOS would be worse than none at all.
     *
     * @param int[] $targetUserIds recipients; duplicates are collapsed, and
     *        the empty case is allowed (a notification with nothing to
     *        deliver is still a true record that the event occurred).
     * @param array{dispatch_id?:?int,sos_id?:?int,incident_id?:?int} $entities
     * @return array{notification_id:int,target_count:int}
     */
    public static function create(
        PDO $pdo,
        int $barangayId,
        string $type,
        array $entities,
        ?int $createdBy,
        array $targetUserIds
    ): array {
        if (!in_array($type, self::TYPES, true)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown notification type.');
        }

        $dispatchId = $entities['dispatch_id'] ?? null;
        $sosId = $entities['sos_id'] ?? null;
        $incidentId = $entities['incident_id'] ?? null;
        self::assertEntityIntegrity($type, $dispatchId, $sosId, $incidentId);

        $insert = $pdo->prepare(
            'INSERT INTO notification
                (barangay_id, notification_type, dispatch_id, sos_id, incident_id, created_by, created_at)
             VALUES
                (:barangay_id, :notification_type, :dispatch_id, :sos_id, :incident_id, :created_by, UTC_TIMESTAMP())'
        );
        $insert->execute([
            'barangay_id' => $barangayId,
            'notification_type' => $type,
            'dispatch_id' => $dispatchId,
            'sos_id' => $sosId,
            'incident_id' => $incidentId,
            'created_by' => $createdBy,
        ]);
        $notificationId = (int) $pdo->lastInsertId();

        $targetCount = 0;
        foreach (array_values(array_unique($targetUserIds)) as $userId) {
            if (self::addTarget($pdo, $notificationId, $barangayId, (int) $userId)) {
                $targetCount++;
            }
        }

        return ['notification_id' => $notificationId, 'target_count' => $targetCount];
    }

    /**
     * Adds one recipient.
     *
     * §5: "Target `user_id`, optional `device_id`, and notification
     * `barangay_id` must agree on tenant membership; this is enforced
     * transactionally before target creation." A user outside the
     * notification's barangay is skipped rather than throwing — a fan-out
     * list is assembled from a query that is already tenant-scoped, so a
     * mismatch here means a caller bug, and silently dropping the wrong
     * recipient is safer than aborting an SOS mid-fan-out.
     *
     * The target's `device_id` is the Tanod's currently-active device, if
     * any. A NULL means "no push destination", which is precisely the
     * signal Rule 12 uses to skip FCM and go straight to SMS.
     */
    private static function addTarget(PDO $pdo, int $notificationId, int $barangayId, int $userId): bool
    {
        $userStmt = $pdo->prepare(
            'SELECT u.user_id,
                    (SELECT md.device_id FROM mobile_device md
                      WHERE md.user_id = u.user_id AND md.is_active = 1
                      ORDER BY md.last_seen_at DESC LIMIT 1) AS device_id
             FROM user u
             WHERE u.user_id = :user_id AND u.barangay_id = :barangay_id AND u.is_active = 1'
        );
        $userStmt->execute(['user_id' => $userId, 'barangay_id' => $barangayId]);
        $row = $userStmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            return false;
        }

        // §5 UNIQUE(notification_id,user_id) — a repeated recipient is a
        // no-op rather than a duplicate alert.
        $stmt = $pdo->prepare(
            "INSERT INTO notification_target
                (notification_id, user_id, device_id, targeted_at, ack_status)
             VALUES
                (:notification_id, :user_id, :device_id, UTC_TIMESTAMP(), 'pending')
             ON DUPLICATE KEY UPDATE notification_target_id = notification_target_id"
        );
        $stmt->execute([
            'notification_id' => $notificationId,
            'user_id' => $userId,
            'device_id' => $row['device_id'],
        ]);

        return true;
    }

    /**
     * Recipients for an SOS (§2 Rule 27: "sends alerts to Admin and other
     * eligible on-duty Tanods").
     *
     * "Other" is load-bearing — the Tanod who raised the SOS is excluded;
     * alerting someone to their own emergency is noise at the exact moment
     * noise is most costly. On-duty means the most recent `duty_status` row
     * is `on_duty` or `responding`: unlike dispatch assignment (which needs
     * a free Tanod and so excludes `responding`), an SOS wants every
     * able body nearby, including one already handling something else.
     *
     * @return int[]
     */
    public static function sosRecipients(PDO $pdo, int $barangayId, int $excludeUserId): array
    {
        $stmt = $pdo->prepare(
            "SELECT u.user_id
             FROM user u
             WHERE u.barangay_id = :barangay_id
               AND u.is_active = 1
               AND u.user_id <> :exclude_user_id
               AND (
                     u.role = 'admin'
                     OR (
                          u.role = 'tanod'
                          AND EXISTS (
                              SELECT 1 FROM duty_status ds
                              WHERE ds.user_id = u.user_id
                                AND ds.status IN ('on_duty','responding')
                                AND ds.changed_at = (
                                    SELECT MAX(ds2.changed_at) FROM duty_status ds2 WHERE ds2.user_id = u.user_id
                                )
                          )
                        )
                   )"
        );
        $stmt->execute(['barangay_id' => $barangayId, 'exclude_user_id' => $excludeUserId]);
        return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    }

    /**
     * §5's notification entity-integrity matrix. See the class doc for why
     * this lives in PHP and not in a CHECK constraint.
     */
    private static function assertEntityIntegrity(string $type, ?int $dispatchId, ?int $sosId, ?int $incidentId): void
    {
        $problem = match ($type) {
            self::TYPE_DISPATCH => $dispatchId === null
                ? 'A dispatch notification requires dispatch_id.' : null,
            self::TYPE_SOS => $sosId === null
                ? 'An SOS notification requires sos_id.' : null,
            self::TYPE_PRIORITY_ALERT => ($incidentId === null && $dispatchId === null)
                ? 'A priority alert requires incident_id or dispatch_id.' : null,
            // §5: "'other' may use a documented entity relationship" — no
            // combination is mandated, so nothing to reject.
            default => null,
        };

        if ($problem !== null) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', $problem);
        }

        // The matrix is also exclusive in spirit: §5 says "exactly one
        // relevant target entity relationship is required". An SOS
        // notification carrying a dispatch_id would make the row ambiguous
        // for the reliability report, so reject the obvious cross-wiring.
        if ($type === self::TYPE_SOS && $dispatchId !== null) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'An SOS notification must not carry dispatch_id.');
        }
        if ($type === self::TYPE_DISPATCH && $sosId !== null) {
            throw new ApiError(422, 'UNPROCESSABLE_ENTITY', 'A dispatch notification must not carry sos_id.');
        }
    }
}
