<?php
declare(strict_types=1);

/**
 * notification-worker.php — the ONLY process that performs §6's
 * "Notification lifecycle automation" 60-second ack-timeout sweep:
 *
 *   "After an FCM delivery is marked `sent`, a local worker waits 60
 *    seconds for `notification_target.acknowledged_at`. If no
 *    acknowledgement exists, that delivery row becomes `ack_timeout`.
 *    This does not create an SMS row unless the original fallback rule
 *    explicitly calls for SMS because the FCM send itself failed."
 *
 * Everything else in the fallback ladder (no-device -> SMS; FCM error ->
 * retry once -> SMS on 2nd failure) happens SYNCHRONOUSLY inside the web
 * request, in `NotificationDispatcher::dispatchAll()` — §6 says SOS
 * "immediately attempts" its channels, and the same urgency applies to a
 * dispatch assignment. This worker's ONE job is the thing that genuinely
 * cannot happen synchronously: nothing should block an HTTP response for
 * a minute waiting to see if a Tanod taps acknowledge.
 *
 * §2 Rule 24 is the reason this file NEVER does anything else: "Ack
 * timeout never silently changes delivery truth." It flips exactly one
 * status, on exactly one already-`sent` FCM delivery row, based on
 * exactly one fact (whether the target acknowledged within 60s) — it
 * never re-attempts FCM, never sends SMS, and never touches a delivery
 * row that already failed or already timed out.
 *
 * Usage (from backend/):
 *   php scripts/notification-worker.php            sweep once, then exit
 *   php scripts/notification-worker.php --once     same as above (explicit)
 *   php scripts/notification-worker.php --daemon   keep sweeping every 15s (Ctrl-C to stop)
 *   php scripts/notification-worker.php --status   print pending-ack counts and exit
 *
 * Unlike ai-worker.php, this has no external service to be unreachable —
 * it is a pure DB sweep, so there is no "unavailable, requeue" case to
 * handle. Run it via cron/Task Scheduler every 15-30s in production, or
 * `--daemon` for a long-lived local process.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
require dirname(__DIR__) . '/config/autoload.php';
require dirname(__DIR__) . '/config/db.php';

const ACK_TIMEOUT_SECONDS = 60;
const DAEMON_POLL_SECONDS = 15;

$options = parseArguments($argv);
$pdo = baranguard_db();

if ($options['status']) {
    printStatus($pdo);
    exit(0);
}

do {
    $swept = sweepAckTimeouts($pdo);
    if ($swept > 0) {
        out("Swept {$swept} delivery row(s) into ack_timeout.");
    } elseif (!$options['daemon']) {
        out('No FCM deliveries past the 60s ack window. Nothing to do.');
    }
    if ($options['daemon']) {
        sleep(DAEMON_POLL_SECONDS);
    }
} while ($options['daemon']);

exit(0);

/**
 * One sweep pass. Row-locks each candidate before flipping it so a
 * concurrent acknowledge (the Tanod taps "ack" in the exact instant the
 * sweep runs) can't race past this and get silently overwritten — the
 * WHERE clause re-checks `ack_status` inside the same transaction as the
 * UPDATE, not just at SELECT time.
 */
function sweepAckTimeouts(PDO $pdo): int
{
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare(
            "SELECT nd.delivery_id
             FROM notification_delivery nd
             JOIN notification_target nt ON nt.notification_target_id = nd.notification_target_id
             WHERE nd.channel = 'fcm'
               AND nd.status = 'sent'
               AND nd.sent_at <= UTC_TIMESTAMP() - INTERVAL :timeout_seconds SECOND
               AND nt.ack_status != 'acknowledged'
             FOR UPDATE"
        );
        $stmt->bindValue('timeout_seconds', ACK_TIMEOUT_SECONDS, PDO::PARAM_INT);
        $stmt->execute();
        $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

        if ($ids === []) {
            $pdo->commit();
            return 0;
        }

        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $update = $pdo->prepare(
            "UPDATE notification_delivery
                SET status = 'ack_timeout', ack_timeout_at = UTC_TIMESTAMP()
              WHERE delivery_id IN ({$placeholders})"
        );
        $update->execute($ids);

        $pdo->commit();
        return count($ids);
    } catch (\Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function printStatus(PDO $pdo): void
{
    $stmt = $pdo->query(
        "SELECT status, COUNT(*) AS c FROM notification_delivery WHERE channel = 'fcm' GROUP BY status"
    );
    $counts = array_fill_keys(['initiated', 'sent', 'failed', 'ack_timeout'], 0);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $counts[$row['status']] = (int) $row['c'];
    }
    out(sprintf(
        'FCM deliveries — initiated:%d sent:%d failed:%d ack_timeout:%d',
        $counts['initiated'],
        $counts['sent'],
        $counts['failed'],
        $counts['ack_timeout']
    ));

    $pendingStmt = $pdo->query(
        "SELECT COUNT(*) FROM notification_delivery nd
         JOIN notification_target nt ON nt.notification_target_id = nd.notification_target_id
         WHERE nd.channel = 'fcm' AND nd.status = 'sent' AND nt.ack_status != 'acknowledged'
           AND nd.sent_at > UTC_TIMESTAMP() - INTERVAL " . ACK_TIMEOUT_SECONDS . ' SECOND'
    );
    $withinWindow = (int) $pendingStmt->fetchColumn();
    out("{$withinWindow} sent delivery(ies) still inside the 60s ack window (not yet due for a sweep).");
}

/** @param string[] $argv @return array{once:bool,daemon:bool,status:bool} */
function parseArguments(array $argv): array
{
    $options = ['once' => false, 'daemon' => false, 'status' => false];
    foreach (array_slice($argv, 1) as $argument) {
        if ($argument === '--once') {
            $options['once'] = true;
        } elseif ($argument === '--daemon') {
            $options['daemon'] = true;
        } elseif ($argument === '--status') {
            $options['status'] = true;
        }
    }
    return $options;
}

function out(string $message): void
{
    fwrite(STDOUT, $message . PHP_EOL);
}
