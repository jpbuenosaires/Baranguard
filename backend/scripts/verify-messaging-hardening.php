<?php
declare(strict_types=1);

/**
 * Service-level checks for the 2026-10-28 messaging audit fixes. Run by
 * verify-messaging-hardening.sh against a DISPOSABLE database (DB_* env);
 * expects users `msg_admin`, `msg_tanod` (+639170000002), `msg_sec`, `msg_pb`
 * to be seeded already. Prints [PASS]/[FAIL] lines; exit 1 on any failure.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}
require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
require dirname(__DIR__) . '/config/autoload.php';
require dirname(__DIR__) . '/config/db.php';

use Baranguard\Services\Notifications\FcmClient;
use Baranguard\Services\Notifications\GsmGatewayException;
use Baranguard\Services\Notifications\GsmUnconfirmedException;
use Baranguard\Services\Notifications\LocalGsmOutboundClient;
use Baranguard\Services\Notifications\NotificationDispatcher;
use Baranguard\Services\Notifications\NotificationService;
use Baranguard\Services\Notifications\SosEscalation;
use Baranguard\Services\Sms\SmsGatewayService;

$pdo = baranguard_db_fresh();
$fail = 0;
function check(bool $ok, string $label): void
{
    global $fail;
    echo ($ok ? '[PASS] ' : '[FAIL] ') . $label . PHP_EOL;
    if (!$ok) {
        $fail++;
    }
}
function one(PDO $pdo, string $sql, array $p = []): mixed
{
    $s = $pdo->prepare($sql);
    $s->execute($p);
    return $s->fetchColumn();
}
function uid(PDO $pdo, string $username): int
{
    return (int) one($pdo, 'SELECT user_id FROM user WHERE username = ?', [$username]);
}
$admin = uid($pdo, 'msg_admin');
$tanod = uid($pdo, 'msg_tanod');
$sec = uid($pdo, 'msg_sec');
$pb = uid($pdo, 'msg_pb');
$svc = new SmsGatewayService();

// ---- 1. Inbound human text -------------------------------------------------
$r = $svc->receiveInboundText($pdo, '+639171112222', 'Help, may sunog sa Purok 2', '10:1', null);
check(!$r['duplicate'], 'inbound text stored');
$row = $pdo->query("SELECT sender_number, direction, status, message_body, message_type FROM sms_log WHERE log_id = {$r['log_id']}")->fetch();
check($row['sender_number'] === '+639171112222' && $row['direction'] === 'inbound' && $row['status'] === 'received'
    && $row['message_body'] === 'Help, may sunog sa Purok 2' && $row['message_type'] === 'manual', 'row has sender_number, body, inbound/received');
$again = $svc->receiveInboundText($pdo, '+639171112222', 'Help, may sunog sa Purok 2', '10:1', null);
check($again['duplicate'] && $again['log_id'] === $r['log_id'], 'same inbox id is not stored twice');
$r2 = $svc->receiveInboundText($pdo, '09170000002', 'on my way', '11:1', null);
check(one($pdo, 'SELECT sender_number FROM sms_log WHERE log_id = ?', [$r2['log_id']]) === '+639170000002', 'registered user number is canonicalised into one thread');
$rej = $svc->receiveInboundText($pdo, '+639170000002', '{"secret":"x"}', '12:1', 'ENVELOPE_REJECTED_SOS');
$rejRow = $pdo->query("SELECT status, message_body, failure_reason FROM sms_log WHERE log_id = {$rej['log_id']}")->fetch();
check($rejRow['status'] === 'rejected' && $rejRow['message_body'] === null && $rejRow['failure_reason'] === 'ENVELOPE_REJECTED_SOS', 'rejected envelope logged as rejected, body never stored');

$pdo->exec("INSERT INTO sms_subscriber (barangay_id, contact_number, consent_at, consent_source, created_at) VALUES (1, '09175550000', UTC_TIMESTAMP(), 'staff_entry', UTC_TIMESTAMP())");
$o = $svc->receiveInboundText($pdo, '+639175550000', ' Stop. ', '13:1', null);
check($o['opted_out'] === true && one($pdo, "SELECT opted_out_at FROM sms_subscriber WHERE contact_number='09175550000'") !== null, 'STOP text opts the subscriber out');
check((int) one($pdo, "SELECT COUNT(*) FROM audit_log WHERE action='sms_subscriber_opted_out'") === 1, 'opt-out audited (no number in metadata)');
check(strpos((string) one($pdo, "SELECT metadata_json FROM audit_log WHERE action='sms_subscriber_opted_out'"), '5550000') === false, 'opt-out audit metadata carries no phone number');

// ---- 2. Outbound honesty ---------------------------------------------------
final class Fake extends LocalGsmOutboundClient
{
    public function __construct(private string $mode)
    {
    }
    public function isConfigured(): bool
    {
        return true;
    }
    public function send(string $p, string $m): array
    {
        return $this->go();
    }
    public function sendPriority(string $p, string $m): array
    {
        return $this->go();
    }
    private function go(): array
    {
        return match ($this->mode) {
            'ok' => ['gateway_message_id' => 'abc'],
            'unconfirmed' => throw new GsmUnconfirmedException('no confirmation'),
            default => throw new GsmGatewayException('adb down'),
        };
    }
}
$mk = static fn (string $mode) => new SmsGatewayService(null, null, new Fake($mode));
$u = $mk('unconfirmed')->sendOutbound($pdo, 'manual', false, null, null, '+639170000002', 'hi', 1);
check($u['status'] === 'pending' && one($pdo, 'SELECT status FROM sms_log WHERE log_id = ?', [$u['log_id']]) === 'pending', 'no confirmation -> pending, NOT failed');
$f = $mk('fail')->sendOutbound($pdo, 'manual', false, null, null, '+639170000002', 'hi', 1);
check($f['status'] === 'failed', 'known failure -> failed');
$s = $mk('ok')->sendOutbound($pdo, 'manual', false, null, null, '+639170000002', 'hi', 1);
check($s['status'] === 'sent', 'confirmed hand-off -> sent');

// outbox
$qId = $svc->queueOutbound($pdo, 'manual', '+639170000002', 'queued msg', 1);
check(one($pdo, 'SELECT status FROM sms_log WHERE log_id = ?', [$qId]) === 'queued', 'queueOutbound writes a queued row and sends nothing');
$cnt = $mk('ok')->drainQueued($pdo);
check($cnt['sent'] >= 1 && one($pdo, 'SELECT status FROM sms_log WHERE log_id = ?', [$qId]) === 'sent', 'drainQueued sends queued rows');
$q2 = $svc->queueOutbound($pdo, 'manual', '+639170000002', 'queued 2', 1);
$mk('unconfirmed')->drainQueued($pdo);
check(one($pdo, 'SELECT status FROM sms_log WHERE log_id = ?', [$q2]) === 'pending', 'drainQueued with no confirmation leaves pending');
check($mk('ok')->drainQueued($pdo) === ['sent' => 0, 'pending' => 0, 'failed' => 0], 'pending rows are never re-sent by the drain');

// ---- 3. Message content ----------------------------------------------------
$pdo->exec("INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, latitude, longitude, location_description, display_id, created_at, updated_at)
            VALUES (1, 'physical_injury', 'high', 'SECRET-NARRATIVE-TEXT', 'pending', 'web', 13.1234567, 123.7654321, 'Purok 3 near the chapel', 'INC-2026-014', UTC_TIMESTAMP(), UTC_TIMESTAMP())");
$incId = (int) $pdo->lastInsertId();
$pdo->exec("INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, route_status, status, dispatched_at, created_client_request_id)
            VALUES ($incId, $admin, $tanod, 'high', 'unavailable', 'assigned', UTC_TIMESTAMP(), UUID())");
$dispId = (int) $pdo->lastInsertId();
$disp = new NotificationDispatcher(null, $mk('ok'));
$n = NotificationService::create($pdo, 1, 'dispatch', ['dispatch_id' => $dispId], $admin, [$tanod]);
$disp->dispatchAll($pdo, $n['notification_id']);
$sms = (string) one($pdo, "SELECT message_body FROM sms_log WHERE dispatch_id = ? AND message_type='dispatch' ORDER BY log_id DESC LIMIT 1", [$dispId]);
echo "  dispatch sms: $sms\n";
check(str_starts_with($sms, 'DISPATCH HIGH Injury - Purok 3 near the chapel, ') && str_contains($sms, 'Ref INC-2026-014'), 'dispatch SMS: human type, place, Ref, urgent facts first');
check(!str_contains($sms, 'physical_injury') && !str_contains($sms, 'SECRET-NARRATIVE') && !preg_match('/\d+\.\d{3}/', $sms), 'dispatch SMS: no raw enum, narrative or coordinates when a landmark exists');
check(strlen($sms) <= 160 && preg_match('/^[\x20-\x7E]*$/', $sms) === 1, 'dispatch SMS fits one GSM-7 segment');
check(one($pdo, "SELECT status FROM notification_delivery WHERE notification_id = ? AND channel='sms'", [$n['notification_id']]) === 'sent', 'delivery row records sent');

$compose = new ReflectionMethod(NotificationDispatcher::class, 'composeMessage');
$compose->setAccessible(true);
$loadN = static fn (int $id) => (function () use ($pdo, $id) {
    $s = $pdo->prepare('SELECT notification_type, barangay_id, dispatch_id, sos_id, incident_id, dispatch_offer_id, accomplishment_report_id FROM notification WHERE notification_id = ?');
    $s->execute([$id]);
    $r = $s->fetch();
    foreach (['barangay_id', 'dispatch_id', 'sos_id', 'incident_id', 'dispatch_offer_id', 'accomplishment_report_id'] as $k) {
        $r[$k] = $r[$k] !== null ? (int) $r[$k] : null;
    }
    return $r;
})();
$push = $compose->invoke($disp, $pdo, $loadN($n['notification_id']));
check(!preg_match('/\d+\.\d{3}/', $push['body']) && str_contains($push['body'], 'Injury'), 'dispatch push body: readable type, no coordinates');

// SOS: last_known, no_fix, live
$ins = $pdo->prepare("INSERT INTO tanod_sos (user_id, barangay_id, latitude, longitude, location_source, triggered_at, received_at, status, client_event_id) VALUES (?, 1, ?, ?, ?, ?, UTC_TIMESTAMP(), 'active', UUID())");
$ins->execute([$tanod, 13.1111111, 123.2222222, 'last_known', '2026-10-28 14:05:00']);
$sosLk = (int) $pdo->lastInsertId();
$ins->execute([$tanod, null, null, 'no_fix', '2026-10-28 14:05:00']);
$sosNf = (int) $pdo->lastInsertId();
$nLk = NotificationService::create($pdo, 1, 'sos', ['sos_id' => $sosLk], $tanod, [$admin]);
$nNf = NotificationService::create($pdo, 1, 'sos', ['sos_id' => $sosNf], $tanod, [$admin]);
$mLk = $compose->invoke($disp, $pdo, $loadN($nLk['notification_id']));
$mNf = $compose->invoke($disp, $pdo, $loadN($nNf['notification_id']));
echo "  sos sms (last known): {$mLk['sms']}\n  sos sms (no fix): {$mNf['sms']}\n";
check(str_contains($mLk['sms'], 'LAST KNOWN') && str_contains($mLk['sms'], '22:05'), 'SOS SMS says LAST KNOWN and uses Manila time (14:05 UTC -> 22:05)');
check(str_contains($mNf['sms'], 'NO LOCATION'), 'SOS SMS says NO LOCATION when there is no fix');
check(!str_contains($mLk['body'], 'Msg Tanod') && !preg_match('/\d+\.\d{3}/', $mLk['body']) && str_contains($mLk['body'], 'Last known location'), 'SOS push body: no name, no coordinates, says last known');
check(strlen($mLk['sms']) <= 160 && strlen($mNf['sms']) <= 160, 'SOS SMS within 160 chars');

// gsm7
check(NotificationDispatcher::gsm7("Caf\u{e9} \u{201C}x\u{201D} \u{2013} ok\u{2026} \u{1F525}") === 'Caf "x" - ok... ', 'gsm7 maps typographic chars and drops emoji/non-GSM');

// ---- 4. SOS escalation -----------------------------------------------------
$pdo->exec("UPDATE tanod_sos SET triggered_at = UTC_TIMESTAMP() WHERE sos_id = $sosLk");
$age = static fn (int $sos) => $pdo->exec("UPDATE notification SET created_at = UTC_TIMESTAMP() - INTERVAL 300 SECOND WHERE sos_id = $sos");
$rounds = static fn (int $sos) => (int) one($pdo, "SELECT COUNT(*) FROM notification WHERE sos_id = ? AND notification_type='sos'", [$sos]);
$pdo->exec("UPDATE tanod_sos SET status='resolved' WHERE sos_id = $sosNf");
check(SosEscalation::sweep($pdo, $disp) === 0, 'escalation: a fresh SOS (notified < 2 min ago) is left alone');
$age($sosLk);
check(SosEscalation::sweep($pdo, $disp) === 1 && $rounds($sosLk) === 2, 'escalation: active SOS unacknowledged after 2 min is re-sent (round 2)');
$r2Targets = (int) one($pdo, "SELECT COUNT(*) FROM notification_target nt JOIN notification n ON n.notification_id = nt.notification_id WHERE n.sos_id = ? AND nt.user_id IN (?, ?)", [$sosLk, $sec, $pb]);
check($r2Targets === 0, 'escalation round 2: Admin only (Secretary and PB not yet)');
$age($sosLk);
check(SosEscalation::sweep($pdo, $disp) === 1 && $rounds($sosLk) === 3, 'escalation: round 3 sent');
$r3Targets = (int) one($pdo, "SELECT COUNT(*) FROM notification_target nt JOIN notification n ON n.notification_id = nt.notification_id WHERE n.sos_id = ? AND nt.user_id IN (?, ?)", [$sosLk, $sec, $pb]);
check($r3Targets === 2, 'escalation round 3: Secretary and Punong Barangay are alerted');
check((int) one($pdo, "SELECT COUNT(*) FROM sms_log WHERE message_type='sos' AND message_body LIKE '%reminder%'") >= 1, 'reminder rounds say they are a reminder');
$pdo->exec("UPDATE tanod_sos SET status='acknowledged' WHERE sos_id = $sosLk");
$age($sosLk);
check(SosEscalation::sweep($pdo, $disp) === 0 && $rounds($sosLk) === 3, 'escalation stops once the SOS is acknowledged');
$pdo->exec("UPDATE tanod_sos SET status='active' WHERE sos_id = $sosLk");
for ($i = 0; $i < 6; $i++) {
    $age($sosLk);
    SosEscalation::sweep($pdo, $disp);
}
check($rounds($sosLk) === SosEscalation::MAX_ROUNDS, 'escalation is capped at MAX_ROUNDS');

// ---- 5. FCM payload --------------------------------------------------------
foreach (['sos', 'priority_alert', 'dispatch', 'dispatch_offer'] as $t) {
    $pl = FcmClient::buildPayload('tok', 'T', 'B', ['notification_type' => $t])['message'];
    check(!isset($pl['notification']) && $pl['data']['title'] === 'T' && $pl['data']['body'] === 'B' && $pl['android']['ttl'] === '300s', "FCM $t is data-only with title/body in data and ttl");
}
$pl = FcmClient::buildPayload('tok', 'T', 'B', ['notification_type' => 'roster_published'])['message'];
check(isset($pl['notification']) && !isset($pl['data']['title']) && !isset($pl['android']['ttl']), 'FCM non-critical type unchanged (notification block, no ttl)');

echo ($fail === 0 ? 'ALL PHP CHECKS PASSED' : "$fail PHP CHECK(S) FAILED") . PHP_EOL;
exit($fail === 0 ? 0 : 1);
