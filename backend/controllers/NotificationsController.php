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
    private const DEFAULT_LIMIT = 20;
    private const MAX_LIMIT = 50;

    /**
     * GET /notifications — the caller's OWN notification targets.
     *
     * NOT in §6's documented endpoint list. Added for the topbar
     * notification bell, which otherwise had no data source at all: §6
     * documents only `POST /notifications/:id/ack` (Tanod-only) and
     * `GET /reports/notifications-summary` (aggregate counts, unbuilt), and
     * neither can answer "what should this user look at right now".
     *
     * Same precedent as `GET /barangays`, `GET /search` and
     * `GET /reports/nav-counts` — a real gap filled with a real read over
     * tables that are already populated, rather than inventing a field.
     * The rows exist: Rule 27's SOS fan-out targets the Admin, and
     * dispatch creation targets the assigned Tanod.
     *
     * Scoping is doubly bounded and neither half is client-suppliable: the
     * target row must belong to the caller (`nt.user_id`), AND the parent
     * notification must be in the caller's barangay. Every role may read
     * its own targets — this returns nothing about anyone else.
     *
     * Deliberately returns NO narrative text of any kind. §2 Rule 1: raw
     * narrative never leaves the encrypted store except through the
     * approved redaction workflow, and a notification feed is not that
     * workflow. Callers get identifiers and a type, and follow the link.
     *
     * @param array{user_id:int,barangay_id:int,role:string} $identity
     */
    public static function index(PDO $pdo, array $identity): void
    {
        $unacknowledgedOnly = Http::query('unacknowledged') === '1';
        $limit = min(self::MAX_LIMIT, max(1, (int) (Http::query('limit') ?? (string) self::DEFAULT_LIMIT)));

        $where = ['nt.user_id = :user_id', 'n.barangay_id = :barangay_id'];
        if ($unacknowledgedOnly) {
            $where[] = "nt.ack_status = 'pending'";
        }
        $whereSql = implode(' AND ', $where);
        $params = [
            'user_id' => $identity['user_id'],
            'barangay_id' => $identity['barangay_id'],
        ];

        // The unread count is what the bell's badge shows, and it counts
        // ALL pending targets, not just the page being returned.
        $countStmt = $pdo->prepare(
            "SELECT COUNT(*)
               FROM notification_target nt
               JOIN notification n ON n.notification_id = nt.notification_id
              WHERE nt.user_id = :user_id
                AND n.barangay_id = :barangay_id
                AND nt.ack_status = 'pending'"
        );
        $countStmt->execute($params);
        $unreadCount = (int) $countStmt->fetchColumn();

        $stmt = $pdo->prepare(
            "SELECT n.notification_id, n.notification_type, n.dispatch_id, n.sos_id,
                    n.incident_id, n.created_at,
                    nt.ack_status, nt.acknowledged_at, nt.targeted_at
               FROM notification_target nt
               JOIN notification n ON n.notification_id = nt.notification_id
              WHERE {$whereSql}
              ORDER BY (nt.ack_status = 'pending') DESC, n.created_at DESC
              LIMIT :limit"
        );
        foreach ($params as $key => $value) {
            $stmt->bindValue(':' . $key, $value);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();

        $items = array_map(static function (array $row): array {
            return [
                'notification_id' => (int) $row['notification_id'],
                'notification_type' => $row['notification_type'],
                'dispatch_id' => $row['dispatch_id'] !== null ? (int) $row['dispatch_id'] : null,
                'sos_id' => $row['sos_id'] !== null ? (int) $row['sos_id'] : null,
                'incident_id' => $row['incident_id'] !== null ? (int) $row['incident_id'] : null,
                'created_at' => $row['created_at'],
                'targeted_at' => $row['targeted_at'],
                'ack_status' => $row['ack_status'],
                'acknowledged_at' => $row['acknowledged_at'],
            ];
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));

        Http::send(200, ['items' => $items, 'unread_count' => $unreadCount]);
    }

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
