<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

use PDO;

/**
 * An SOS still `active` (nobody acknowledged it) is re-sent, not forgotten.
 * Run by notification-worker.php. Each repeat is a NEW `sos` notification for
 * the same sos_id, so the round count is simply the number of such rows and no
 * schema is needed. Round 2 re-alerts the Admin(s); from round 3 on the
 * Secretary (back-up dispatcher, Rule 89) and the Punong Barangay are added
 * (they have no phone app, so they get the SMS). Stops after MAX_ROUNDS.
 */
final class SosEscalation
{
    public const REPEAT_AFTER_SECONDS = 120;
    public const MAX_ROUNDS = 5;
    public const WIDEN_FROM_ROUNDS = 2; // existing rounds needed before widening

    /** @return int number of SOS records escalated this pass */
    public static function sweep(PDO $pdo, ?NotificationDispatcher $dispatcher = null): int
    {
        // One escalator at a time (launcher daemon + scheduled task may overlap).
        if ((int) $pdo->query("SELECT GET_LOCK('baranguard_sos_escalation', 0)")->fetchColumn() !== 1) {
            return 0;
        }
        try {
            $due = $pdo->prepare(
                "SELECT s.sos_id, s.barangay_id, COUNT(n.notification_id) AS rounds
                   FROM tanod_sos s
                   JOIN notification n ON n.sos_id = s.sos_id AND n.notification_type = 'sos'
                  WHERE s.status = 'active' AND s.triggered_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR
                  GROUP BY s.sos_id, s.barangay_id
                 HAVING COUNT(n.notification_id) < :max
                    AND MAX(n.created_at) <= UTC_TIMESTAMP() - INTERVAL :after SECOND"
            );
            $due->bindValue('max', self::MAX_ROUNDS, PDO::PARAM_INT);
            $due->bindValue('after', self::REPEAT_AFTER_SECONDS, PDO::PARAM_INT);
            $due->execute();

            $count = 0;
            foreach ($due->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $roles = (int) $row['rounds'] >= self::WIDEN_FROM_ROUNDS ? ['admin', 'secretary', 'punong_barangay'] : ['admin'];
                $in = implode(',', array_fill(0, count($roles), '?'));
                $users = $pdo->prepare("SELECT user_id FROM user WHERE barangay_id = ? AND is_active = 1 AND role IN ({$in})");
                $users->execute([(int) $row['barangay_id'], ...$roles]);
                $created = NotificationService::create(
                    $pdo, (int) $row['barangay_id'], NotificationService::TYPE_SOS,
                    ['sos_id' => (int) $row['sos_id']], null,
                    array_map('intval', $users->fetchAll(PDO::FETCH_COLUMN))
                );
                try {
                    ($dispatcher ?? new NotificationDispatcher())->dispatchAll($pdo, $created['notification_id']);
                } catch (\Throwable $e) {
                    error_log('[baranguard] SOS escalation dispatch failed for sos_id=' . $row['sos_id'] . ': ' . $e->getMessage());
                }
                $count++;
            }
            return $count;
        } finally {
            $pdo->query("SELECT RELEASE_LOCK('baranguard_sos_escalation')")->fetchAll();
        }
    }
}
