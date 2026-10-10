<?php
declare(strict_types=1);

namespace Baranguard\Lib;

use DateTimeImmutable;
use DateTimeZone;
use Throwable;

/**
 * Plausibility rules for a time the PHONE claims for an event (offline sync).
 *
 * Why: a phone that syncs late must not make a Tanod look late. Dispatch step
 * times (`dispatch.en_route_at/arrived_at/completed_at`), SOS `triggered_at`
 * and `duty_status.changed_at` used to be the server's RECEIVE time. A sync
 * item may now carry the optional field `created_offline_at` (ISO-8601 UTC,
 * `Y-m-d\TH:i:s\Z`; the field name the phone's SOS queue already sent).
 * Incidents keep their own older field `device_offline_created_at`; it goes
 * through the same parser (see IncidentsController::createMobileItem).
 *
 * Rule (docs/OFFLINE_SYNC_CONFLICT_RULES.md, gaps 2 and 4):
 *   - the value must be a string in ISO-8601 / "Y-m-d H:i:s" form that really
 *     parses (a bare date-less word such as "now" or "tomorrow" does not);
 *     a value with no zone designator is read as UTC;
 *   - not more than SKEW_SECONDS (300 s, the same tolerance as the SMS
 *     envelope) in the future of the server clock;
 *   - not older than the caller's window (EVENT_MAX_AGE_SECONDS = 7 days for
 *     event times, 30 days for an incident's device_offline_created_at).
 * Anything else is IGNORED, never an error: the caller then keeps its server
 * time (or NULL for the optional incident column). A bad phone clock must
 * never reject an SOS, a status step or an incident report.
 *
 * A plausible time that is up to 300 s ahead of the server is accepted by the
 * parser but event columns are capped at the server's "now" by
 * eventOrServerTime(), so an event never appears to happen after it was
 * received. Audit-style columns (tanod_sos.received_at, gps_track.received_at,
 * offline_queue.received_at) stay server time and never use this class.
 */
final class ClientEventTime
{
    /** Allowed device-ahead-of-server skew, same as the SMS envelope. */
    public const SKEW_SECONDS = 300;

    /** Oldest accepted event time (dispatch step, SOS, duty status). */
    public const EVENT_MAX_AGE_SECONDS = 7 * 86400;

    /** Oldest accepted incident device_offline_created_at. */
    public const INCIDENT_MAX_AGE_SECONDS = 30 * 86400;

    /**
     * Parses and range-checks a client time.
     *
     * @param int|null $now injectable "server now" (unix seconds), for tests
     * @return string|null UTC 'Y-m-d H:i:s', or null when absent or implausible
     */
    public static function parse(mixed $raw, int $maxAgeSeconds = self::EVENT_MAX_AGE_SECONDS, ?int $now = null): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $raw = trim($raw);
        if ($raw === '' || strlen($raw) > 40
            || !preg_match('/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?\s?(Z|[+-]\d{2}:?\d{2})?$/i', $raw)) {
            return null;
        }
        try {
            $dt = new DateTimeImmutable($raw, new DateTimeZone('UTC'));
        } catch (Throwable $e) {
            return null;
        }
        $errors = DateTimeImmutable::getLastErrors();
        if (is_array($errors) && ($errors['warning_count'] > 0 || $errors['error_count'] > 0)) {
            return null; // e.g. 2026-02-31 or hour 25 silently rolling over
        }
        $ts = $dt->getTimestamp();
        $now ??= time();
        if ($ts > $now + self::SKEW_SECONDS || $ts < $now - $maxAgeSeconds) {
            return null;
        }
        return gmdate('Y-m-d H:i:s', $ts);
    }

    /**
     * The value to store in an "event happened" column: the plausible client
     * time (capped at server now, never lower than any floor), else null,
     * which callers turn into UTC_TIMESTAMP().
     *
     * @param array<int,?string> $floors 'Y-m-d H:i:s' UTC values the result must not precede
     *        (for a dispatch step: dispatched_at and the previous step's time); nulls skipped
     * @return string|null 'Y-m-d H:i:s' UTC, or null to use server time
     */
    public static function eventOrServerTime(mixed $raw, array $floors = [], ?int $now = null): ?string
    {
        $now ??= time();
        $t = self::parse($raw, self::EVENT_MAX_AGE_SECONDS, $now);
        if ($t === null) {
            return null;
        }
        $nowStr = gmdate('Y-m-d H:i:s', $now);
        if ($t > $nowStr) {
            $t = $nowStr;
        }
        foreach ($floors as $floor) {
            if (is_string($floor) && $floor !== '' && $floor > $t) {
                // Fixed-width UTC strings compare chronologically.
                $t = $floor;
            }
        }
        return $t;
    }
}
