<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

use Baranguard\Services\Sms\SmsGatewayService;
use PDO;

/**
 * NotificationDispatcher — Phase 2 of the split `NotificationService` (see
 * that class's own doc). This is where §2 Rule 12's fallback ladder
 * actually lives:
 *
 *   "if no active FCM registration, go straight to SMS with no FCM
 *    attempt; FCM send error/timeout -> retry once, then SMS on second
 *    failure; FCM sent but no client ack within 60s -> record
 *    ack_timeout, do NOT auto-send SMS."
 *
 * The first two clauses happen HERE, synchronously, right after the
 * caller's notification+target transaction commits — §6 says SOS
 * "immediately attempts configured FCM/SMS channels", and the same
 * urgency applies to a dispatch assignment. The third clause (the 60s
 * ack-timeout sweep) CANNOT happen synchronously — nothing should block
 * an HTTP response for a minute — so it is `scripts/notification-worker.php`'s
 * job instead; this class never marks anything `ack_timeout`.
 *
 * Every `notification_delivery` row this class writes follows §5's shape
 * exactly: `attempt_no` is per (target, channel) — an FCM retry is
 * attempt_no=2 on channel='fcm'; the SMS fallback that follows is its OWN
 * attempt_no=1 on channel='sms', a DIFFERENT row, never a continuation of
 * the FCM attempts. Rule 24: "An FCM ack timeout does not automatically
 * become an SMS attempt unless the fallback rule explicitly requires it"
 * — the fallback rule here explicitly requires it only for a SEND
 * failure, never for an ack timeout, which is exactly why this class and
 * the worker never call into each other.
 *
 * A transport failure NEVER throws out of `dispatchAll()` — every branch
 * is caught internally and recorded as a `failed` delivery row. The
 * calling controller (TanodSosController, DispatchController) wraps this
 * in try/catch anyway as a second line of defence, but the intent is that
 * it never needs to: a missing/misconfigured/unreachable transport is a
 * transport fact, not a reason to fail the parent request.
 */
final class NotificationDispatcher
{
    private FcmClient $fcm;
    private SmsGatewayService $smsGateway;

    /**
     * `$smsGateway` is `Baranguard\Services\Sms\SmsGatewayService` — the
     * SAME class the internal `/internal/sms/dispatch-payload` and
     * `/internal/sms/priority-alert` endpoints call, so the SMS-fallback
     * step here and those endpoints share one implementation of "compose,
     * send outbound, write sms_log" rather than two that could drift.
     */
    public function __construct(?FcmClient $fcm = null, ?SmsGatewayService $smsGateway = null)
    {
        $this->fcm = $fcm ?? new FcmClient();
        $this->smsGateway = $smsGateway ?? new SmsGatewayService();
    }

    /**
     * Attempts delivery to every PENDING target of one notification.
     * Idempotent-ish in practice: a target that already has delivery rows
     * from an earlier call (e.g. a retried request that re-ran the
     * caller's whole flow under a different notification, or a manual
     * re-run) simply gets a fresh attempt sequence — §5's
     * UNIQUE(notification_target_id,channel,attempt_no) makes a genuine
     * duplicate attempt_no impossible, so this only ever adds rows,
     * never conflicts with itself under normal operation.
     */
    public function dispatchAll(PDO $pdo, int $notificationId): void
    {
        $notification = $this->loadNotification($pdo, $notificationId);
        if ($notification === null) {
            return; // Nothing to do — caller passed a bad id, which shouldn't happen.
        }

        $message = $this->composeMessage($pdo, $notification);
        if ($message === null) {
            return; // §6's entity-integrity matrix already prevents this in practice.
        }
        $message['sms'] = self::gsm7($message['sms']);

        $targets = $this->loadPendingTargets($pdo, $notificationId);
        foreach ($targets as $target) {
            $this->dispatchToTarget($pdo, $notificationId, $notification, $message, $target);
        }
    }

    /**
     * @return array{notification_type:string,barangay_id:int,dispatch_id:?int,sos_id:?int,incident_id:?int,dispatch_offer_id:?int,accomplishment_report_id:?int}|null
     */
    private function loadNotification(PDO $pdo, int $notificationId): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT notification_type, barangay_id, dispatch_id, sos_id, incident_id, dispatch_offer_id, accomplishment_report_id
             FROM notification WHERE notification_id = :id'
        );
        $stmt->execute(['id' => $notificationId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            return null;
        }
        return [
            'notification_type' => (string) $row['notification_type'],
            'barangay_id' => (int) $row['barangay_id'],
            'dispatch_id' => $row['dispatch_id'] !== null ? (int) $row['dispatch_id'] : null,
            'sos_id' => $row['sos_id'] !== null ? (int) $row['sos_id'] : null,
            'incident_id' => $row['incident_id'] !== null ? (int) $row['incident_id'] : null,
            'dispatch_offer_id' => $row['dispatch_offer_id'] !== null ? (int) $row['dispatch_offer_id'] : null,
            'accomplishment_report_id' => $row['accomplishment_report_id'] !== null ? (int) $row['accomplishment_report_id'] : null,
        ];
    }

    /**
     * @return array<int,array{notification_target_id:int,user_id:int,device_id:?string}>
     */
    private function loadPendingTargets(PDO $pdo, int $notificationId): array
    {
        $stmt = $pdo->prepare(
            "SELECT notification_target_id, user_id, device_id
             FROM notification_target
             WHERE notification_id = :id AND ack_status = 'pending'"
        );
        $stmt->execute(['id' => $notificationId]);
        return array_map(static function (array $row): array {
            return [
                'notification_target_id' => (int) $row['notification_target_id'],
                'user_id' => (int) $row['user_id'],
                'device_id' => $row['device_id'],
            ];
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * §2 Rule 1: raw_narrative never leaves the trusted store — every
     * message below is composed only from redacted-safe fields already
     * exposed elsewhere (incident_type, coordinates, a Tanod's own name),
     * the same allow-list `GET /incidents`/`GET /dispatch` already use.
     *
     * @param array{notification_type:string,barangay_id:int,dispatch_id:?int,sos_id:?int,incident_id:?int} $notification
     * @return array{title:string,body:string,sms:string,message_type:string}|null
     */
    private function composeMessage(PDO $pdo, array $notification): ?array
    {
        switch ($notification['notification_type']) {
            case 'dispatch':
                if ($notification['dispatch_id'] === null) {
                    return null;
                }
                $stmt = $pdo->prepare(
                    'SELECT i.incident_type, i.latitude, i.longitude, i.display_id, i.location_description, d.priority, b.name AS barangay_name
                     FROM dispatch d JOIN incident i ON i.incident_id = d.incident_id
                     JOIN barangay b ON b.barangay_id = i.barangay_id
                     WHERE d.dispatch_id = :id'
                );
                $stmt->execute(['id' => $notification['dispatch_id']]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if ($row === false) {
                    return null;
                }
                // What, where (landmark/barangay), Ref -- urgent facts first. The incident
                // code is an identifier, not personal data. Push bodies carry no raw
                // coordinates (lock screen); the SMS adds them only when there is no
                // landmark, since the SMS may be read with no data/map at all.
                $type = self::typeLabel((string) $row['incident_type']);
                $place = self::placeLabel($row['location_description'], (string) $row['barangay_name']);
                $prio = $row['priority'] === 'normal' ? '' : strtoupper((string) $row['priority']) . ' ';
                $ref = ($row['display_id'] ?? '') !== '' ? " Ref {$row['display_id']}." : '';
                $coords = ($row['location_description'] ?? '') === '' ? self::coordsForSms($row['latitude'], $row['longitude']) : '';
                return [
                    'title' => "Dispatch: {$type}",
                    'body' => "{$prio}{$type} - {$place}.{$ref} Open the app.",
                    'sms' => "DISPATCH {$prio}{$type} - {$place}{$coords}.{$ref} Open app.",
                    'message_type' => 'dispatch',
                ];

            case 'sos':
                if ($notification['sos_id'] === null) {
                    return null;
                }
                $stmt = $pdo->prepare(
                    'SELECT u.full_name, s.latitude, s.longitude, s.location_source, s.triggered_at, b.name AS barangay_name,
                            (SELECT COUNT(*) FROM notification n WHERE n.sos_id = s.sos_id AND n.notification_type = \'sos\') AS rounds
                     FROM tanod_sos s JOIN user u ON u.user_id = s.user_id
                     JOIN barangay b ON b.barangay_id = s.barangay_id
                     WHERE s.sos_id = :id'
                );
                $stmt->execute(['id' => $notification['sos_id']]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if ($row === false) {
                    return null;
                }
                // Push: no name and no coordinates (they show on the lock screen).
                // SMS: keeps the Tanod's name and, when there is a fix, coordinates --
                // it is the fallback for a responder with no data, and says plainly
                // whether the location is live, last known, or missing.
                $source = (string) $row['location_source'];
                $hasFix = $row['latitude'] !== null && $row['longitude'] !== null && $source !== 'no_fix';
                $locPush = $source === 'no_fix' || !$hasFix ? 'Location unknown' : ($source === 'last_known' ? 'Last known location' : 'Live location');
                $locSms = $source === 'no_fix' || !$hasFix ? 'NO LOCATION' : ($source === 'last_known' ? 'LAST KNOWN loc' : 'Live loc');
                $time = (new \DateTimeImmutable((string) $row['triggered_at'], new \DateTimeZone('UTC')))
                    ->setTimezone(new \DateTimeZone('+08:00'))->format('H:i');
                $repeat = (int) $row['rounds'] > 1 ? ' (reminder #' . ((int) $row['rounds'] - 1) . ')' : '';
                $coords = $hasFix ? self::coordsForSms($row['latitude'], $row['longitude']) : '';
                return [
                    'title' => 'SOS ALERT',
                    'body' => "A tanod needs help in {$row['barangay_name']}. {$locPush}. Open the app now.{$repeat}",
                    'sms' => "SOS{$repeat}: {$row['full_name']} needs help, {$row['barangay_name']}. {$locSms}{$coords} at {$time}. Open app.",
                    'message_type' => 'sos',
                ];

            case 'dispatch_offer':
                // Migration 0038. NON-IDENTIFYING by design: incident type,
                // barangay name and time only -- no narrative, names,
                // contacts, coordinates or location text.
                $offer = $notification['dispatch_offer_id'] !== null
                    ? self::loadOfferFacts($pdo, $notification['dispatch_offer_id']) : null;
                if ($offer === null) {
                    return null;
                }
                $what = self::offerWhat($offer);
                return [
                    'title' => 'Dispatch offer',
                    'body' => "{$what}. Open the app to accept.",
                    'sms' => "BARANGUARD DISPATCH OFFER: {$what}. Open the app to accept.",
                    // sms_log's message_type enum has no offer value; an
                    // offer text sent over SMS is a dispatch-class message.
                    'message_type' => 'dispatch',
                ];

            case 'priority_alert':
                if ($notification['dispatch_offer_id'] !== null) {
                    // Admin escalation of an unanswered offer: same
                    // non-identifying content rule as the offer itself.
                    $offer = self::loadOfferFacts($pdo, $notification['dispatch_offer_id']);
                    if ($offer === null) {
                        return null;
                    }
                    $what = self::offerWhat($offer);
                    return [
                        'title' => 'PRIORITY ALERT',
                        'body' => "No Tanod has accepted: {$what}. Assign a responder.",
                        'sms' => "BARANGUARD PRIORITY ALERT: No Tanod has accepted: {$what}. Assign a responder.",
                        'message_type' => 'priority_alert',
                    ];
                }
                $incidentType = null;
                $place = '';
                if ($notification['incident_id'] !== null) {
                    $stmt = $pdo->prepare('SELECT i.incident_type, i.location_description, b.name AS barangay_name FROM incident i JOIN barangay b ON b.barangay_id = i.barangay_id WHERE i.incident_id = :id');
                    $stmt->execute(['id' => $notification['incident_id']]);
                    $row = $stmt->fetch(PDO::FETCH_ASSOC);
                } elseif ($notification['dispatch_id'] !== null) {
                    $stmt = $pdo->prepare(
                        'SELECT i.incident_type, i.location_description, b.name AS barangay_name
                         FROM dispatch d JOIN incident i ON i.incident_id = d.incident_id JOIN barangay b ON b.barangay_id = i.barangay_id WHERE d.dispatch_id = :id'
                    );
                    $stmt->execute(['id' => $notification['dispatch_id']]);
                    $row = $stmt->fetch(PDO::FETCH_ASSOC);
                } else {
                    $row = false;
                }
                if ($row !== false && $row !== null) {
                    $incidentType = $row['incident_type'];
                    $place = self::placeLabel($row['location_description'], (string) $row['barangay_name']);
                }
                $location = $place !== '' ? " at {$place}" : '';
                $what = $incidentType !== null ? self::describeIncidentType($incidentType) : 'an active incident';
                return [
                    'title' => 'PRIORITY ALERT',
                    'body' => "Priority alert for {$what}{$location}. Open the app immediately.",
                    'sms' => "BARANGUARD PRIORITY ALERT: {$what}{$location}. Open the app immediately.",
                    'message_type' => 'priority_alert',
                ];

            // Migration 0040. Ordinary pushes: message_type '' means no SMS
            // fallback (a report outcome is not urgent and SMS costs load).
            // Month and outcome only; never the return reason or entry text.
            case 'report_update':
                if (($notification['accomplishment_report_id'] ?? null) === null) {
                    return null;
                }
                $stmt = $pdo->prepare('SELECT status, month FROM accomplishment_report WHERE report_id = :id');
                $stmt->execute(['id' => $notification['accomplishment_report_id']]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if ($row === false || $row['status'] !== 'returned') {
                    return null;
                }
                $month = self::formatMonth((string) $row['month']);
                return [
                    'title' => 'Accomplishment report returned',
                    'body' => "Your {$month} accomplishment report was returned. Open the app to see what to fix.",
                    'sms' => '',
                    'message_type' => '',
                ];

            case 'roster_published':
                return [
                    'title' => 'Duty schedule published',
                    'body' => 'Your duty schedule was updated. Open the app to see your shifts.',
                    'sms' => '',
                    'message_type' => '',
                ];

            default: // 'other' — no caller in this codebase creates one yet.
                return [
                    'title' => 'Baranguard notification',
                    'body' => 'You have a new notification. Open the app for details.',
                    'sms' => 'BARANGUARD: You have a new notification. Open the app.',
                    'message_type' => '', // Deliberately unmapped — see dispatchToTarget()'s SMS branch.
                ];
        }
    }

    /**
     * Incident type, barangay name and offer time -- the ONLY facts an offer
     * alert may carry.
     *
     * @return array{offer_id:int,incident_type:string,barangay_name:string,created_at:string}|null
     */
    private static function loadOfferFacts(PDO $pdo, int $offerId): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT o.offer_id, o.created_at, i.incident_type, b.name AS barangay_name
               FROM dispatch_offer o
               JOIN incident i ON i.incident_id = o.incident_id
               JOIN barangay b ON b.barangay_id = o.barangay_id
              WHERE o.offer_id = :id'
        );
        $stmt->execute(['id' => $offerId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            return null;
        }
        return [
            'offer_id' => (int) $row['offer_id'],
            'incident_type' => (string) $row['incident_type'],
            'barangay_name' => (string) $row['barangay_name'],
            'created_at' => (string) $row['created_at'],
        ];
    }

    /**
     * "a fire incident reported in Dao at 21:40" -- Manila clock, fixed
     * +08:00 (Rule 11).
     *
     * @param array{incident_type:string,barangay_name:string,created_at:string} $offer
     */
    private static function offerWhat(array $offer): string
    {
        $time = (new \DateTimeImmutable($offer['created_at'], new \DateTimeZone('UTC')))
            ->setTimezone(new \DateTimeZone('+08:00'))->format('H:i');
        $type = $offer['incident_type'] === 'other'
            ? 'an incident'
            : self::describeIncidentType($offer['incident_type']);
        return "{$type} reported in {$offer['barangay_name']} at {$time}";
    }

    /**
     * The FCM `data` map for one notification (every value a string, per
     * FCM). Generic notifications carry only their id and type. A
     * `dispatch_offer` additionally carries EXACTLY {type, offer_id,
     * incident_type, barangay_name, created_at} -- non-identifying, and the
     * keys the mobile app switches on (`data.type === 'dispatch_offer'`).
     * Public and static so the verify suite can assert the key set without
     * a Firebase project.
     *
     * @param array{notification_type:string,dispatch_offer_id?:?int} $notification
     * @return array<string,string>
     */
    public static function buildFcmData(PDO $pdo, int $notificationId, array $notification): array
    {
        $data = [
            'notification_id' => (string) $notificationId,
            'notification_type' => $notification['notification_type'],
        ];
        if ($notification['notification_type'] === 'dispatch_offer' && ($notification['dispatch_offer_id'] ?? null) !== null) {
            $offer = self::loadOfferFacts($pdo, (int) $notification['dispatch_offer_id']);
            if ($offer !== null) {
                $data['type'] = 'dispatch_offer';
                $data['offer_id'] = (string) $offer['offer_id'];
                $data['incident_type'] = $offer['incident_type'];
                $data['barangay_name'] = $offer['barangay_name'];
                $data['created_at'] = (new \DateTimeImmutable($offer['created_at'], new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z');
            }
        }
        return $data;
    }

    /** 'YYYY-MM' -> 'September 2026' for a push body; the raw value if malformed. */
    private static function formatMonth(string $month): string
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m', $month);
        return $date === false ? $month : $date->format('F Y');
    }

    /**
     * Human wording for an `incident.incident_type` enum value in a push/SMS
     * body: `animal_complaint` -> "an animal complaint incident", `theft` ->
     * "a theft incident". Observed on the Infinix 2026-09-19 (HANDOFF
     * "observed, not yet fixed"): the raw enum was being interpolated, so
     * the heads-up read "a animal_complaint incident". `other` stays the
     * generic "an active incident" rather than "an other incident".
     */
    private static function describeIncidentType(string $incidentType): string
    {
        if ($incidentType === 'other') {
            return 'an active incident';
        }
        $words = strtolower(preg_replace('/ incident$/i', '', self::typeLabel($incidentType)) ?? '');
        $article = preg_match('/^[aeiou]/i', $words) === 1 ? 'an' : 'a';
        return "{$article} {$words} incident";
    }

    private const TYPE_LABELS = [
        'theft' => 'Theft', 'physical_injury' => 'Injury', 'disturbance' => 'Disturbance',
        'domestic_dispute' => 'Domestic dispute', 'vandalism' => 'Vandalism', 'traffic_incident' => 'Traffic incident',
        'fire' => 'Fire', 'medical_emergency' => 'Medical emergency', 'missing_person' => 'Missing person',
        'animal_complaint' => 'Animal complaint', 'other' => 'Incident',
    ];

    /** Plain-text label for an `incident.incident_type` enum value. */
    private static function typeLabel(string $incidentType): string
    {
        return self::TYPE_LABELS[$incidentType] ?? ucfirst(str_replace('_', ' ', $incidentType));
    }

    /** Coarse place: the landmark text (<= 40 chars) with the barangay, else the barangay alone. */
    private static function placeLabel(?string $locationDescription, string $barangayName): string
    {
        $desc = trim((string) $locationDescription);
        return $desc === '' ? $barangayName : mb_substr($desc, 0, 40) . ", {$barangayName}";
    }

    private static function coordsForSms($lat, $lng): string
    {
        return $lat === null || $lng === null ? '' : sprintf(' (%.4f,%.4f)', (float) $lat, (float) $lng);
    }

    /** Keeps an SMS in one GSM-7 segment where possible: ASCII fixes for common typographic chars, drops anything else outside GSM-7. */
    public static function gsm7(string $text): string
    {
        $text = strtr($text, ["\u{2018}" => "'", "\u{2019}" => "'", "\u{201C}" => '"', "\u{201D}" => '"',
            "\u{2013}" => '-', "\u{2014}" => '-', "\u{2026}" => '...', "\u{00A0}" => ' ']);
        return preg_replace('/[^\x20-\x7E\n\x{00F1}\x{00D1}]/u', '', $text) ?? '';
    }

    /**
     * @param array{notification_type:string,barangay_id:int,dispatch_id:?int,sos_id:?int,incident_id:?int} $notification
     * @param array{title:string,body:string,sms:string,message_type:string} $message
     * @param array{notification_target_id:int,user_id:int,device_id:?string} $target
     */
    private function dispatchToTarget(PDO $pdo, int $notificationId, array $notification, array $message, array $target): void
    {
        // The FCM token (if any) is re-resolved at SEND time, not trusted
        // from the target row alone — the device could have been
        // deactivated in the (very short) window since the target was
        // created.
        $fcmToken = null;
        if ($target['device_id'] !== null) {
            $stmt = $pdo->prepare(
                'SELECT fcm_token FROM mobile_device WHERE device_id = :device_id AND is_active = 1'
            );
            $stmt->execute(['device_id' => $target['device_id']]);
            $token = $stmt->fetchColumn();
            $fcmToken = is_string($token) && $token !== '' ? $token : null;
        }

        if ($fcmToken === null) {
            // Rule 12: "if no active FCM registration, go straight to SMS
            // with no FCM attempt."
            $this->attemptSms($pdo, $notification, $message, $target, attemptNo: 1);
            return;
        }

        $data = self::buildFcmData($pdo, $notificationId, $notification);

        $sent =$this->attemptFcm($pdo, $target, $fcmToken, $message, attemptNo: 1, data: $data);
        if ($sent) {
            return;
        }

        // Rule 12: "FCM send error/timeout -> retry once".
        $sent = $this->attemptFcm($pdo, $target, $fcmToken, $message, attemptNo: 2, data: $data);
        if ($sent) {
            return;
        }

        // Rule 12: "...then SMS on second failure."
        $this->attemptSms($pdo, $notification, $message, $target, attemptNo: 1);
    }

    /**
     * @param array{notification_target_id:int,user_id:int,device_id:?string} $target
     * @param array{title:string,body:string,sms:string,message_type:string} $message
     * @param array<string,string> $data
     */
    private function attemptFcm(PDO $pdo, array $target, string $fcmToken, array $message, int $attemptNo, array $data): bool
    {
        $deliveryId = $this->insertDeliveryAttempt($pdo, $target['notification_target_id'], 'fcm', $attemptNo);

        if (!$this->fcm->isConfigured()) {
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'failed', null, 'FCM_NOT_CONFIGURED');
            return false;
        }

        try {
            $result = $this->fcm->send($fcmToken, $message['title'], $message['body'], $data);
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'sent', $result['provider_message_id'], null);
            return true;
        } catch (FcmException $e) {
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'failed', null, self::truncateReason($e->getMessage()));
            return false;
        }
    }

    /**
     * @param array{notification_type:string,barangay_id:int,dispatch_id:?int,sos_id:?int,incident_id:?int} $notification
     * @param array{title:string,body:string,sms:string,message_type:string} $message
     * @param array{notification_target_id:int,user_id:int,device_id:?string} $target
     */
    private function attemptSms(PDO $pdo, array $notification, array $message, array $target, int $attemptNo): void
    {
        $deliveryId = $this->insertDeliveryAttempt($pdo, $target['notification_target_id'], 'sms', $attemptNo);

        if ($message['message_type'] === '') {
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'failed', null, 'UNSUPPORTED_NOTIFICATION_TYPE_FOR_SMS');
            return;
        }

        $phoneStmt = $pdo->prepare('SELECT contact_number FROM user WHERE user_id = :user_id');
        $phoneStmt->execute(['user_id' => $target['user_id']]);
        $phone = $phoneStmt->fetchColumn();
        if (!is_string($phone) || trim($phone) === '') {
            $this->finalizeDeliveryAttempt($pdo, $deliveryId, 'failed', null, 'NO_CONTACT_NUMBER');
            return;
        }

        // Rule 5: "Critical alerts use the configured priority SMS
        // path." SOS and priority_alert both count as critical here;
        // ordinary dispatch instructions use the regular endpoint. Delegated
        // to SmsGatewayService — see this class's constructor doc for why.
        $usePriority = in_array($notification['notification_type'], ['sos', 'priority_alert'], true);
        $result = $this->smsGateway->sendOutbound(
            $pdo,
            $message['message_type'],
            $usePriority,
            $notification['incident_id'],
            $notification['dispatch_id'],
            $phone,
            $message['sms'],
            $notification['barangay_id']
        );

        // `pending` = handed to the phone, no confirmation (may have been sent).
        // notification_delivery has no such value; `initiated` is the honest one.
        $this->finalizeDeliveryAttempt(
            $pdo,
            $deliveryId,
            $result['status'] === 'pending' ? 'initiated' : $result['status'],
            $result['gateway_message_id'] ?? null,
            $result['failure_reason'] ?? null
        );
    }

    private function insertDeliveryAttempt(PDO $pdo, int $targetId, string $channel, int $attemptNo): int
    {
        $stmt = $pdo->prepare(
            "INSERT INTO notification_delivery
                (notification_id, notification_target_id, channel, attempt_no, status, initiated_at)
             SELECT notification_id, :target_id, :channel, :attempt_no, 'initiated', UTC_TIMESTAMP()
             FROM notification_target WHERE notification_target_id = :target_id2"
        );
        $stmt->execute([
            'target_id' => $targetId,
            'channel' => $channel,
            'attempt_no' => $attemptNo,
            'target_id2' => $targetId,
        ]);
        return (int) $pdo->lastInsertId();
    }

    private function finalizeDeliveryAttempt(PDO $pdo, int $deliveryId, string $status, ?string $providerMessageId, ?string $failureReason): void
    {
        $stmt = $pdo->prepare(
            "UPDATE notification_delivery
                SET status = :status,
                    provider_message_id = :provider_message_id,
                    sent_at = :sent_at,
                    failure_reason = :failure_reason
              WHERE delivery_id = :delivery_id"
        );
        $stmt->execute([
            'status' => $status,
            'provider_message_id' => $providerMessageId,
            'sent_at' => $status === 'sent' ? gmdate('Y-m-d H:i:s') : null,
            'failure_reason' => $failureReason,
            'delivery_id' => $deliveryId,
        ]);
    }

    private static function truncateReason(string $reason): string
    {
        // §5 notification_delivery.failure_reason / sms_log.failure_reason
        // are both VARCHAR(255).
        return mb_strlen($reason) > 255 ? mb_substr($reason, 0, 254) . '…' : $reason;
    }
}
