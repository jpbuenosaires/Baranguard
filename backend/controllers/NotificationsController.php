<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\ApiError;
use Baranguard\Lib\Http;
use Baranguard\Middleware\AuthMiddleware;
use PDO;

/**
 * POST /notifications/:id/ack — §6 "Notification acknowledgment".
 *
 * "Tanod only for a target notification assigned to that user. Server
 * resolves the caller's own `notification_target`, verifies same-barangay
 * ownership, records `ack_status=acknowledged` and `acknowledged_at`, and
 * returns `{success:true,notification_id,acknowledged_at}`. The endpoint is
 * idempotent for an already-acknowledged target. This acknowledgment is
 * distinct from transport delivery and does not force a transport attempt
 * to become `sent`."
 *
 * THE LAST SENTENCE IS THE WHOLE DESIGN. §2 Rule 24: "Notification delivery
 * has separate logical and transport records ... Ack timeout never silently
 * changes delivery truth." So this endpoint touches `notification_target`
 * and **never** `notification_delivery`. A Tanod acknowledging on their
 * phone does not retroactively make a failed SMS attempt look successful;
 * conversely a delivery marked `ack_timeout` is a statement about that
 * transport, not about whether the human eventually saw it.
 *
 * The caller is resolved from the session — `:id` is the NOTIFICATION id,
 * and the target row is looked up by (notification, caller). A Tanod
 * therefore cannot acknowledge on someone else's behalf even by guessing a
 * `notification_target_id`, because they never supply one.
 */
final class NotificationsController
{
    /** @param array{user_id:int,barangay_id:int,role:string} $identity */
    public static function acknowledge(PDO $pdo, array $identity, string $notificationIdParam): void
    {
        AuthMiddleware::requireRole($identity, ['tanod']);
        if (!ctype_digit($notificationIdParam)) {
            throw new ApiError(404, 'NOT_FOUND', 'Notification not found.');
        }
        $notificationId = (int) $notificationIdParam;

        $pdo->beginTransaction();
        try {
            // One query resolves existence, ownership AND tenancy: the row
            // must be this caller's target on a notification in this
            // caller's barangay. Anything else is an undifferentiated 404,
            // so a Tanod cannot probe for notifications aimed at others.
            $stmt = $pdo->prepare(
                'SELECT nt.notification_target_id, nt.ack_status, nt.acknowledged_at
                 FROM notification_target nt
                 JOIN notification n ON n.notification_id = nt.notification_id
                 WHERE nt.notification_id = :notification_id
                   AND nt.user_id = :user_id
                   AND n.barangay_id = :barangay_id
                 FOR UPDATE'
            );
            $stmt->execute([
                'notification_id' => $notificationId,
                'user_id' => $identity['user_id'],
                'barangay_id' => $identity['barangay_id'],
            ]);
            $target = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($target === false) {
                throw new ApiError(404, 'NOT_FOUND', 'Notification not found.');
            }

            // Idempotent (§6): a second ack keeps the ORIGINAL timestamp.
            // Overwriting it would corrupt `avg_ack_seconds` in §6's
            // reliability report by rewarding a duplicate tap.
            if ($target['ack_status'] !== 'acknowledged') {
                $update = $pdo->prepare(
                    "UPDATE notification_target
                        SET ack_status = 'acknowledged', acknowledged_at = UTC_TIMESTAMP()
                      WHERE notification_target_id = :target_id"
                );
                $update->execute(['target_id' => (int) $target['notification_target_id']]);
            }

            $readBack = $pdo->prepare(
                'SELECT acknowledged_at FROM notification_target WHERE notification_target_id = :target_id'
            );
            $readBack->execute(['target_id' => (int) $target['notification_target_id']]);
            $acknowledgedAt = $readBack->fetchColumn();

            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        Http::send(200, [
            'success' => true,
            'notification_id' => $notificationId,
            'acknowledged_at' => $acknowledgedAt,
        ]);
    }
}
