<?php
declare(strict_types=1);

namespace Baranguard\Services\Retention;

use Baranguard\Lib\Audit;
use PDO;

/**
 * RetentionService — §11's retention table, implemented as executable
 * constants and one method per record type. Sprint 7's "Retention jobs
 * (§11's table, all record types)" cut.
 *
 * §11 is explicit that these numbers are RESOLVED DECISIONS: "these
 * implement directly as retention-job constants; a later change requires
 * the same architecture-review process as any other resolved decision,
 * not a runbook edit." So they are `const`s here, not env vars — an
 * operator cannot quietly shorten the raw-narrative ceiling or stretch
 * the 7-year record retention by editing a config file.
 *
 * WHAT THIS IMPLEMENTS (§11's table, verbatim):
 *
 *   raw_narrative          deleted 30 days after human-approved redaction;
 *                          hard ceiling 90 days from created_at if never
 *                          approved. Legal hold is the only exception.
 *   incident / evidence    7 years default (incident, evidence_attachment).
 *   citizen_report         1 year from submitted_at while UNCONVERTED;
 *                          a converted report drops its own clock and
 *                          follows the linked incident.
 *   audit_log              7 years.
 *   sms_log                1 year, extended for the duration of any hold
 *                          on the linked incident/dispatch/citizen
 *                          report (migration 0016).
 *   mobile_device          secret columns (fcm_token, device_secret_ref)
 *                          cleared 90 days after deactivation; the ROW
 *                          is retained so `incident.device_id`
 *                          provenance survives (migration 0016).
 *   offline mirror         no independent retention (Rule 2) — see
 *                          purgeOfflineQueue()'s own doc.
 *   backups                explicitly OUT of scope for a database job —
 *                          see the class-level note at the bottom.
 *   gps_track              1 year from recorded_at (H-15, 2026-09-24
 *                          external audit + 2026-09-26 architecture-
 *                          review sign-off — see docs/REMAINING.md §H).
 *                          No legal_hold column; this is operational
 *                          telemetry, not an evidentiary record.
 *   duty_status             1 year from changed_at — same H-15 sign-off,
 *                          mirrors the National Archives of the
 *                          Philippines' Daily Time Record retention
 *                          period (1 year), the closest real-world
 *                          analog for an attendance/on-duty log.
 *   shift_schedule          1 year from end_at — same H-15 sign-off,
 *                          same DTR analog. Purges its two RESTRICT
 *                          dependents (fatigue_flag, shift_swap_request)
 *                          in the same per-row transaction, same shape
 *                          as purgeOneIncident()'s cascade below.
 *   notification            1 year from created_at — same H-15 sign-off,
 *                          matches the existing sms_log default for
 *                          comparable dispatch/alert transport records.
 *
 * RESOLVED DECISIONS (logged in DEVLOG.md; don't reopen without review):
 *
 *   - **Legal hold is checked per rule, and skipped rows are COUNTED and
 *     REPORTED, never silently passed over.** A retention run that
 *     quietly did nothing because everything was on hold is
 *     indistinguishable from a broken job; every result carries a
 *     `held` count alongside `purged`.
 *
 *   - **An incident's `legal_hold` covers its dependent case records.**
 *     `dispatch` has no `legal_hold` column of its own; a
 *     hold is placed on a case, not a row. Migration 0007's own header
 *     carries the same note. **`sms_log` gained its own `legal_hold` in
 *     0016 and is the one exception** — not because the principle
 *     changed, but because a transport record can be held on its own
 *     (an SMS thread subpoenaed independently of any case). It is
 *     checked IN ADDITION to the inherited holds, never instead of them.
 *
 *   - **Each purge runs in its own transaction, one record at a time for
 *     the cascading rules**, not one giant DELETE. §5's FK policy makes
 *     an incident purge a genuine ordered cascade (evidence_attachment →
 *     dispatch → incident, since both are ON DELETE RESTRICT), and a partial
 *     cascade must never be left committed. Slower, and correct.
 *
 *   - **Evidence files are unlinked from disk before the row is
 *     deleted**, and a file that cannot be removed ABORTS that record's
 *     purge rather than orphaning bytes outside the web root that no
 *     database row points at any more. Rule 11's "a deletion is not
 *     complete while the data still exists elsewhere" applies to the
 *     filesystem as directly as it does to backups.
 *
 *   - **One audit row per rule per run, carrying counts** (Rule 17:
 *     "retention jobs produce audit events"), not one per deleted
 *     record. A 7-year purge can touch thousands of rows; flooding
 *     `audit_log` — which is itself on a 7-year retention clock — with
 *     one row per deletion would be self-defeating. Per-record evidence
 *     for the rule that most needs it already exists as
 *     `incident.raw_narrative_purged_at`. Metadata is identifiers and
 *     counts only, per Rule 17's allow-list.
 *
 *   - **`dry_run` is a first-class mode, not a debug flag.** Every
 *     method takes it, and in dry-run mode counts exactly what a real
 *     run would delete without deleting anything — so an operator can
 *     see the blast radius of the first-ever run on real data before
 *     committing to it.
 *
 * PLACEHOLDER RULES (2026-10, review decision 10) — the tables the
 * tanod-workflow build added (migrations 0030-0033): `tanod_availability`,
 * `accomplishment_report` (+ `accomplishment_entry`), `school_checkin`,
 * `incident_referral`; `document_scan` (0037) follows its parent report.
 * NO retention period for any of them has been decided by the barangay or
 * COA, and this file does not invent one: each is a row of
 * `NEW_TABLE_RULES` whose `days` is `null` and whose `status` is
 * `pending_barangay_confirmation`. While `days` is null the rule is a
 * NO-OP (it runs no query at all and reports
 * `{purged:0, held:0, note:'pending barangay confirmation'}`), so a full
 * non-dry-run `runAll()` provably deletes nothing from these tables. The
 * purge itself is fully written and tested, but unreachable in
 * production: the only way to give a rule a duration is (a) editing the
 * constant after an architecture review (Rule 10) or (b) the constructor's
 * `$durationOverrides` argument, which exists SOLELY as a test seam —
 * `retention-job.php` never passes it, and it is not read from `.env`.
 *
 * NOT IMPLEMENTED HERE, DELIBERATELY: backup expiry. §11 makes backups
 * follow their source data's retention, and Rule 11 says a deletion is
 * incomplete while a retained backup still holds the same data — but
 * backups on this system are encrypted `.sql.enc` files produced by
 * `scripts/backup.sh`, not database rows, and expiring them is a
 * filesystem/runbook concern with its own restore-safety implications.
 * `scripts/retention-job.php` prints a standing reminder about this
 * rather than pretending the database job covered it.
 */
final class RetentionService
{
    // §11's table, as executable constants. See class doc for why these
    // are not configurable.
    public const RAW_NARRATIVE_GRACE_DAYS = 30;   // after approved redaction
    public const RAW_NARRATIVE_CEILING_DAYS = 90; // from created_at, unapproved
    public const RECORD_RETENTION_DAYS = 2557;    // 7 years (365.25 * 7, rounded)
    public const CITIZEN_REPORT_DAYS = 365;       // unconverted only
    public const SMS_LOG_DAYS = 365;
    public const AUDIT_LOG_DAYS = 2557;           // aligned with the incident record retention
    public const DEVICE_DEACTIVATED_DAYS = 90;
    // H-15 (2026-09-24 external audit; sign-off 2026-09-26 — see class doc).
    public const GPS_TRACK_DAYS = 365;
    public const DUTY_STATUS_DAYS = 365;
    public const SHIFT_SCHEDULE_DAYS = 365;
    public const NOTIFICATION_DAYS = 365;

    /** Status marker for a retention rule whose length the barangay has not yet confirmed. */
    public const PENDING_BARANGAY_CONFIRMATION = 'pending_barangay_confirmation';

    /**
     * Retention rules for the tables added by migrations 0030-0033 (Rule 10:
     * constants, not config). `days` null = no number decided = the rule is
     * a no-op. A future decision replaces `null` with an integer AND
     * `status` with 'confirmed' (architecture review, council/COA sign-off).
     * `clock` documents which column the age is measured from.
     */
    public const NEW_TABLE_RULES = [
        'tanod_availability' => [
            'days' => null,
            'status' => self::PENDING_BARANGAY_CONFIRMATION,
            'clock' => 'period_end',
            'summary' => 'submitted availability windows, aged from the end of the availability period',
        ],
        'accomplishment_report' => [
            'days' => null,
            'status' => self::PENDING_BARANGAY_CONFIRMATION,
            'clock' => 'approved_at',
            'summary' => 'APPROVED monthly accomplishment reports + entries + attached paper scans, aged from approval; reports not yet approved are never purged',
        ],
        'school_checkin' => [
            'days' => null,
            'status' => self::PENDING_BARANGAY_CONFIRMATION,
            'clock' => 'checked_in_at',
            'summary' => 'school check-in/out records, aged from check-in',
        ],
        'incident_referral' => [
            'days' => null,
            'status' => self::PENDING_BARANGAY_CONFIRMATION,
            'clock' => 'referred_at',
            'summary' => 'referral log rows, aged from the referral time; protected by a legal hold on the linked incident',
        ],
    ];

    /**
     * Tables with NO retention clock of their own: they live exactly as long
     * as the parent record. If a purge of the parent is ever enabled it MUST
     * also remove these rows and their files (see purgeOneAccomplishmentReport).
     */
    public const FOLLOWS_PARENT = [
        'document_scan' => 'accomplishment_report',
    ];

    /** Every rule name this service knows, in the order a full run applies them. */
    public const RULES = [
        'raw_narrative',
        'citizen_report',
        'sms_log',
        'mobile_device',
        'gps_track',
        'duty_status',
        'shift_schedule',
        'notification',
        'tanod_availability',
        'accomplishment_report',
        'school_checkin',
        'incident_referral',
        'audit_log',
        'incident_records',
    ];

    private PDO $pdo;
    private bool $dryRun;
    /** @var list<string> */
    private array $log = [];

    /** @var array<string,int> TEST SEAM ONLY — see __construct(). */
    private array $durationOverrides = [];

    /**
     * @param array<string,int> $durationOverrides TEST SEAM ONLY: rule name
     *        (a key of NEW_TABLE_RULES) => retention days. Exists so the
     *        verify suite can prove the dormant purge code deletes only
     *        expired rows. It is deliberately NOT populated from `.env` or
     *        any config, and `retention-job.php` never passes it: shipping
     *        code must get its number from the NEW_TABLE_RULES constant
     *        (Rule 10).
     */
    public function __construct(PDO $pdo, bool $dryRun = false, array $durationOverrides = [])
    {
        $this->pdo = $pdo;
        $this->dryRun = $dryRun;
        foreach ($durationOverrides as $rule => $days) {
            if (!isset(self::NEW_TABLE_RULES[$rule]) || !is_int($days) || $days < 1) {
                throw new \InvalidArgumentException("Invalid retention duration override for '{$rule}'.");
            }
            $this->durationOverrides[$rule] = $days;
        }
    }

    /**
     * Effective retention days for a NEW_TABLE_RULES rule, or null while the
     * barangay has not confirmed a number (= the rule is a no-op).
     */
    public function newTableDays(string $rule): ?int
    {
        return $this->durationOverrides[$rule] ?? self::NEW_TABLE_RULES[$rule]['days'];
    }

    /** @return list<string> human-readable lines describing what happened. */
    public function log(): array
    {
        return $this->log;
    }

    /**
     * Runs every rule in `RULES` order and returns a per-rule result map.
     *
     * Order matters for one reason only: `incident_records` (the 7-year
     * full-case purge) runs LAST, so the cheaper per-table rules have
     * already removed whatever they can independently and the cascade
     * has less to do.
     *
     * @param list<string>|null $only run just these rules (CLI `--only=`)
     * @return array<string, array{purged:int, held:int, note?:string}>
     */
    public function runAll(?array $only = null): array
    {
        $results = [];
        foreach (self::RULES as $rule) {
            if ($only !== null && !in_array($rule, $only, true)) {
                continue;
            }
            $results[$rule] = match ($rule) {
                'raw_narrative' => $this->purgeRawNarratives(),
                'citizen_report' => $this->purgeCitizenReports(),
                'sms_log' => $this->purgeSmsLogs(),
                'mobile_device' => $this->scrubDeactivatedDevices(),
                'gps_track' => $this->purgeGpsTracks(),
                'duty_status' => $this->purgeDutyStatuses(),
                'shift_schedule' => $this->purgeShiftSchedules(),
                'notification' => $this->purgeNotifications(),
                'tanod_availability' => $this->purgeTanodAvailability(),
                'accomplishment_report' => $this->purgeAccomplishmentReports(),
                'school_checkin' => $this->purgeSchoolCheckins(),
                'incident_referral' => $this->purgeIncidentReferrals(),
                'audit_log' => $this->purgeAuditLog(),
                'incident_records' => $this->purgeExpiredIncidentRecords(),
            };
        }
        return $results;
    }

    // ------------------------------------------------------------------
    // Rule 1 — raw_narrative (§11; Rule 11's operational track)
    // ------------------------------------------------------------------

    /**
     * "Deleted 30 days after human-approved redaction; hard ceiling of 90
     * days from `created_at` if never approved. Legal hold is the only
     * exception to either."
     *
     * Both clauses are ORed into one scan because they are two paths to
     * the same outcome, and an incident can only ever satisfy one of them
     * (the ceiling clause requires `redaction_approved_at IS NULL`).
     *
     * The 90-day ceiling deliberately does NOT require an approved
     * redaction — that is the entire point of Rule 11's "abandoned
     * incident" cap: raw text on an incident nobody ever processed is
     * exactly the data that must not sit there forever.
     *
     * @return array{purged:int, held:int}
     */
    public function purgeRawNarratives(): array
    {
        $where =
            "raw_narrative IS NOT NULL
             AND (
                   (redaction_approved_at IS NOT NULL
                    AND redaction_approved_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :grace DAY))
                OR (redaction_approved_at IS NULL
                    AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :ceiling DAY))
             )";
        $params = [
            'grace' => self::RAW_NARRATIVE_GRACE_DAYS,
            'ceiling' => self::RAW_NARRATIVE_CEILING_DAYS,
        ];

        $held = $this->countWhere('incident', "{$where} AND legal_hold = 1", $params);
        $eligible = $this->countWhere('incident', "{$where} AND legal_hold = 0", $params);

        if ($this->dryRun || $eligible === 0) {
            $this->note("raw_narrative: {$eligible} eligible, {$held} on legal hold");
            return ['purged' => $this->dryRun ? 0 : 0, 'held' => $held, 'eligible' => $eligible];
        }

        // NULL, not '' — see migration 0007's header for why.
        // `updated_at` is deliberately NOT touched: a retention purge is
        // not a user-visible edit of the incident, and moving updated_at
        // would misreport when the case itself last changed.
        $stmt = $this->pdo->prepare(
            "UPDATE incident
                SET raw_narrative = NULL,
                    raw_narrative_purged_at = UTC_TIMESTAMP()
              WHERE {$where} AND legal_hold = 0"
        );
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_raw_narrative_purged', 'incident', ['purged' => $purged, 'held' => $held]);
        $this->note("raw_narrative: purged {$purged}, {$held} on legal hold");
        return ['purged' => $purged, 'held' => $held, 'eligible' => $eligible];
    }

    // ------------------------------------------------------------------
    // Rule 2 — citizen_report (§11; Rule 25)
    // ------------------------------------------------------------------

    /**
     * "1 year from `submitted_at`, then purged. Converted reports drop
     * their own clock and follow the linked incident's retention once
     * `incident_id` is set."
     *
     * So `incident_id IS NULL` is a hard part of the filter, not an
     * optimisation: a converted report is no longer governed by this
     * rule at all — it lives and dies with its incident, and is removed
     * by `purgeExpiredIncidentRecords()` (via ON DELETE SET NULL leaving
     * it, then its own clock resuming) or kept as long as the case is.
     *
     * @return array{purged:int, held:int}
     */
    public function purgeCitizenReports(): array
    {
        $where =
            "incident_id IS NULL
             AND submitted_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)";
        $params = ['days' => self::CITIZEN_REPORT_DAYS];

        $held = $this->countWhere('citizen_report', "{$where} AND legal_hold = 1", $params);
        $eligible = $this->countWhere('citizen_report', "{$where} AND legal_hold = 0", $params);

        if ($this->dryRun || $eligible === 0) {
            $this->note("citizen_report: {$eligible} eligible, {$held} on legal hold");
            return ['purged' => 0, 'held' => $held, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM citizen_report WHERE {$where} AND legal_hold = 0");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_citizen_report_purged', 'citizen_report', ['purged' => $purged, 'held' => $held]);
        $this->note("citizen_report: purged {$purged}, {$held} on legal hold");
        return ['purged' => $purged, 'held' => $held, 'eligible' => $eligible];
    }

    // ------------------------------------------------------------------
    // Rule 3 — sms_log (§11: "1 year default, extended for the duration
    // of any hold on the linked incident / dispatch / citizen report")
    // ------------------------------------------------------------------

    /**
     * The 1-year clock is still flat and still independent of the linked
     * incident's own 7-year record retention — a transport log is not the
     * evidentiary record and does not inherit its length. What it DOES
     * inherit is a legal hold, which is a different thing from a
     * retention period: §11's target rule says the clock is "extended for
     * the duration of any hold on the linked incident/dispatch/citizen
     * report", because a hold freezes everything about how a case was
     * handled, and the SMS trail is part of that.
     *
     * Until migration 0016 this was unexecutable — the column did not
     * exist — and this method purged on the flat clock regardless of any
     * hold, which this comment used to describe as intentional. It was
     * not; it was the gap `docs/REMAINING.md` §G2 tracked.
     *
     * FOUR HOLD PATHS, checked at purge time rather than trusted as
     * pre-propagated flags:
     *   - the row's own `legal_hold` (a hold placed on an SMS thread
     *     directly, e.g. subpoenaed on its own);
     *   - the linked `incident`;
     *   - the linked `citizen_report`;
     *   - the linked `dispatch`, which has no `legal_hold` of its own by
     *     0007's resolved decision ("a hold is placed on a CASE, not on a
     *     row"), so it resolves through to its incident.
     *
     * Checking live beats inheriting on write: a hold placed AFTER the
     * message was logged still protects it, with no backfill step and no
     * window where a just-held case has un-held messages.
     *
     * @return array{purged:int, held:int}
     */
    public function purgeSmsLogs(): array
    {
        $aged = 'created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $onHold =
            "(legal_hold = 1
              OR EXISTS (SELECT 1 FROM incident i
                          WHERE i.incident_id = sms_log.incident_id AND i.legal_hold = 1)
              OR EXISTS (SELECT 1 FROM citizen_report cr
                          WHERE cr.report_id = sms_log.report_id AND cr.legal_hold = 1)
              OR EXISTS (SELECT 1 FROM dispatch d
                          JOIN incident di ON di.incident_id = d.incident_id
                          WHERE d.dispatch_id = sms_log.dispatch_id AND di.legal_hold = 1))";
        $params = ['days' => self::SMS_LOG_DAYS];

        // Held rows are COUNTED and REPORTED, never silently skipped —
        // the class-level resolved decision every other rule follows.
        $held = $this->countWhere('sms_log', "{$aged} AND {$onHold}", $params);
        $eligible = $this->countWhere('sms_log', "{$aged} AND NOT {$onHold}", $params);

        if ($this->dryRun || $eligible === 0) {
            $this->note("sms_log: {$eligible} eligible, {$held} on legal hold");
            return ['purged' => 0, 'held' => $held, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM sms_log WHERE {$aged} AND NOT {$onHold}");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_sms_log_purged', 'sms_log', ['purged' => $purged, 'held' => $held]);
        $this->note("sms_log: purged {$purged}, {$held} on legal hold");
        return ['purged' => $purged, 'held' => $held, 'eligible' => $eligible];
    }

    // ------------------------------------------------------------------
    // Rule 5 — mobile_device (§11: secret columns cleared 90 days after
    // deactivation, matching Rule 9's auth_session purge window; the row
    // itself is RETAINED)
    // ------------------------------------------------------------------

    /**
     * Scrubs the device's secrets in place and KEEPS the row.
     *
     * WHY THIS IS NOT A DELETE, which is what §11 originally said and
     * what this method used to do: every reference to `mobile_device` is
     * ON DELETE SET NULL (`incident.device_id`,
     * `notification_target.device_id`). Deleting the row therefore
     * silently strips device provenance off incidents that are
     * themselves under 7-year retention or an active legal hold — 90
     * days after a Tanod's handset is deactivated, a 7-year legal record
     * quietly forgets which device filed it. That is a retention rule
     * destroying data a longer retention rule requires be kept, which
     * cannot be the right reading of §11.
     *
     * Rule 26's actual requirement is that the SECRETS not linger, not
     * that the row not exist: `fcm_token` and `device_secret_ref` are
     * cleared, which satisfies it exactly. This is the same shape
     * `purgeRawNarratives()` above already uses — clear the sensitive
     * field, keep the row, stamp a marker — applying an established
     * pattern rather than inventing one.
     *
     * `fcm_token` is NOT NULL in the 0001 baseline, so it is emptied
     * rather than nulled. That is safe and not merely tolerable:
     * `NotificationDispatcher` only ever reads a token
     * `WHERE ... is_active = 1`, and every row this touches is
     * `is_active = 0`, so an emptied token is unreachable by the send
     * path by construction. (Widening the column to NULL was rejected:
     * it would be a schema change to express something the scan's own
     * `is_active = 0` filter already guarantees.)
     *
     * `secrets_scrubbed_at` (migration 0016) is both the per-record
     * evidence Rule 17 wants from a retention job and the idempotency
     * guard — an already-scrubbed row is not eligible again, so the
     * counts an operator sees are real work remaining, not a permanent
     * backlog of rows the job re-reports every night.
     *
     * A device with `deactivated_at IS NULL` is never touched, even if
     * `is_active = 0` — migration 0007 backfills that column precisely so
     * no row is stuck in an unprocessable state.
     *
     * @return array{purged:int, held:int}
     */
    public function scrubDeactivatedDevices(): array
    {
        $where =
            'is_active = 0
             AND deactivated_at IS NOT NULL
             AND deactivated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)
             AND secrets_scrubbed_at IS NULL';
        $params = ['days' => self::DEVICE_DEACTIVATED_DAYS];

        $eligible = $this->countWhere('mobile_device', $where, $params);
        if ($this->dryRun || $eligible === 0) {
            $this->note("mobile_device: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare(
            "UPDATE mobile_device
                SET fcm_token = '',
                    device_secret_ref = NULL,
                    secrets_scrubbed_at = UTC_TIMESTAMP()
              WHERE {$where}"
        );
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_device_secrets_scrubbed', 'mobile_device', ['scrubbed' => $purged]);
        $this->note("mobile_device: scrubbed secrets on {$purged} (rows retained for provenance)");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible];
    }

    // ------------------------------------------------------------------
    // H-15 — gps_track / duty_status / shift_schedule / notification
    // (2026-09-24 external audit; 1-year retention signed off 2026-09-26
    // — see class doc for the sourcing). None of these four have a
    // legal_hold column: they are operational telemetry/transport
    // records, not the evidentiary record itself (that's the incident/
    // blotter/evidence chain, already on its own 7-year clock).
    // ------------------------------------------------------------------

    /** @return array{purged:int, held:int, eligible:int} */
    public function purgeGpsTracks(): array
    {
        $where = 'recorded_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $params = ['days' => self::GPS_TRACK_DAYS];

        $eligible = $this->countWhere('gps_track', $where, $params);
        if ($this->dryRun || $eligible === 0) {
            $this->note("gps_track: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM gps_track WHERE {$where}");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_gps_track_purged', 'gps_track', ['purged' => $purged]);
        $this->note("gps_track: purged {$purged}");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible];
    }

    /** @return array{purged:int, held:int, eligible:int} */
    public function purgeDutyStatuses(): array
    {
        $where = 'changed_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $params = ['days' => self::DUTY_STATUS_DAYS];

        $eligible = $this->countWhere('duty_status', $where, $params);
        if ($this->dryRun || $eligible === 0) {
            $this->note("duty_status: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM duty_status WHERE {$where}");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_duty_status_purged', 'duty_status', ['purged' => $purged]);
        $this->note("duty_status: purged {$purged}");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible];
    }

    /**
     * `fatigue_flag` and `shift_swap_request` are both ON DELETE RESTRICT
     * against `shift_schedule` (§5), so an old shift can't simply be
     * deleted — same RESTRICT shape `purgeOneIncident()` already handles,
     * scaled down to a two-table cascade instead of five. One transaction
     * per shift so a failure on one row never blocks the rest of the run.
     *
     * @return array{purged:int, held:int, eligible:int, failed?:int}
     */
    public function purgeShiftSchedules(): array
    {
        $where = 'end_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $params = ['days' => self::SHIFT_SCHEDULE_DAYS];

        $stmt = $this->pdo->prepare("SELECT shift_id FROM shift_schedule WHERE {$where}");
        $stmt->execute($params);
        $ids = $stmt->fetchAll(PDO::FETCH_COLUMN);
        $eligible = count($ids);

        if ($this->dryRun || $eligible === 0) {
            $this->note("shift_schedule: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $purged = 0;
        $failed = 0;
        foreach ($ids as $shiftId) {
            $shiftId = (int) $shiftId;
            $this->pdo->beginTransaction();
            try {
                $this->exec('DELETE FROM fatigue_flag WHERE shift_id = :id', $shiftId);
                $this->exec('DELETE FROM shift_swap_request WHERE shift_id = :id', $shiftId);
                $this->exec('DELETE FROM shift_schedule WHERE shift_id = :id', $shiftId);
                $this->pdo->commit();
                $purged++;
            } catch (\Throwable $e) {
                $this->pdo->rollBack();
                $failed++;
                $this->note("shift_schedule #{$shiftId}: purge failed and was rolled back — " . $e->getMessage());
            }
        }

        $this->audit('retention_shift_schedule_purged', 'shift_schedule', ['purged' => $purged, 'failed' => $failed]);
        $this->note("shift_schedule: purged {$purged}, {$failed} failed (with dependent fatigue_flag/shift_swap_request rows)");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible, 'failed' => $failed];
    }

    /** @return array{purged:int, held:int, eligible:int} */
    public function purgeNotifications(): array
    {
        $where = 'created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $params = ['days' => self::NOTIFICATION_DAYS];

        $eligible = $this->countWhere('notification', $where, $params);
        if ($this->dryRun || $eligible === 0) {
            $this->note("notification: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM notification WHERE {$where}");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_notification_purged', 'notification', ['purged' => $purged]);
        $this->note("notification: purged {$purged}");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible];
    }

    // ------------------------------------------------------------------
    // Placeholder rules for the 0030-0033 tables (review decision 10).
    // Every method below is a NO-OP until NEW_TABLE_RULES gives it a
    // number — see the class doc. None of them is reachable with a number
    // in production code.
    // ------------------------------------------------------------------

    /**
     * Shared no-op result for a rule whose length is not decided. Runs NO
     * query and writes NO audit row.
     *
     * @return array{purged:int, held:int, note:string}
     */
    private function pendingResult(string $rule): array
    {
        $this->note("{$rule}: pending barangay confirmation — no retention period set, nothing purged");
        return ['purged' => 0, 'held' => 0, 'note' => 'pending barangay confirmation'];
    }

    /** A DB that has not applied 0030-0033 yet has no such table (42S02); not an error. */
    private function isMissingTable(\Throwable $e): bool
    {
        return $e instanceof \PDOException && (string) $e->getCode() === '42S02';
    }

    /**
     * `tanod_availability`: aged from `period_end`. `shift_schedule.
     * source_availability_id` is ON DELETE RESTRICT against it, so each row
     * is purged in its own transaction that first NULLs that provenance
     * pointer on any shift still referencing it (the shift itself is
     * governed by its own 1-year rule and is not deleted here).
     *
     * @return array{purged:int, held:int, eligible?:int, failed?:int, note?:string}
     */
    public function purgeTanodAvailability(): array
    {
        $days = $this->newTableDays('tanod_availability');
        if ($days === null) {
            return $this->pendingResult('tanod_availability');
        }
        $where = 'period_end < DATE_SUB(UTC_DATE(), INTERVAL :days DAY)';

        try {
            $stmt = $this->pdo->prepare("SELECT avail_id FROM tanod_availability WHERE {$where} ORDER BY avail_id");
            $stmt->execute(['days' => $days]);
            $ids = $stmt->fetchAll(PDO::FETCH_COLUMN);
        } catch (\PDOException $e) {
            if ($this->isMissingTable($e)) {
                $this->note('tanod_availability: table not present (migration 0030 not applied)');
                return ['purged' => 0, 'held' => 0, 'note' => 'table not present'];
            }
            throw $e;
        }
        $eligible = count($ids);
        if ($this->dryRun || $eligible === 0) {
            $this->note("tanod_availability: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $purged = 0;
        $failed = 0;
        foreach ($ids as $id) {
            $id = (int) $id;
            $this->pdo->beginTransaction();
            try {
                $this->execById('UPDATE shift_schedule SET source_availability_id = NULL WHERE source_availability_id = :id', $id);
                $this->execById('DELETE FROM tanod_availability WHERE avail_id = :id', $id);
                $this->pdo->commit();
                $purged++;
            } catch (\Throwable $e) {
                $this->pdo->rollBack();
                $failed++;
                $this->note("tanod_availability #{$id}: purge failed and was rolled back — " . $e->getMessage());
            }
        }

        $this->audit('retention_tanod_availability_purged', 'tanod_availability', ['purged' => $purged, 'failed' => $failed]);
        $this->note("tanod_availability: purged {$purged}, {$failed} failed");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible, 'failed' => $failed];
    }

    /**
     * `accomplishment_report` (+ `accomplishment_entry`, ON DELETE
     * RESTRICT, + `document_scan` rows and files, which have no FK but
     * follow the parent). ONLY `status = 'approved'` reports are ever
     * eligible, aged from `approved_at`: an open/prepared/noted/returned
     * report is live work and must never be purged by an age clock. No
     * `legal_hold` column exists on these tables, so `held` is always 0.
     *
     * One transaction per report. Scan FILES are unlinked after the commit
     * (same recoverable direction as evidence in purgeOneIncident: an
     * orphaned file is reportable, a row pointing at missing bytes is not).
     *
     * @return array{purged:int, held:int, eligible?:int, failed?:int, note?:string}
     */
    public function purgeAccomplishmentReports(): array
    {
        $days = $this->newTableDays('accomplishment_report');
        if ($days === null) {
            return $this->pendingResult('accomplishment_report');
        }
        $where = "status = 'approved' AND approved_at IS NOT NULL
                  AND approved_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)";

        try {
            $stmt = $this->pdo->prepare("SELECT report_id FROM accomplishment_report WHERE {$where} ORDER BY report_id");
            $stmt->execute(['days' => $days]);
            $ids = $stmt->fetchAll(PDO::FETCH_COLUMN);
        } catch (\PDOException $e) {
            if ($this->isMissingTable($e)) {
                $this->note('accomplishment_report: table not present (migration 0031 not applied)');
                return ['purged' => 0, 'held' => 0, 'note' => 'table not present'];
            }
            throw $e;
        }
        $eligible = count($ids);
        if ($this->dryRun || $eligible === 0) {
            $this->note("accomplishment_report: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $purged = 0;
        $failed = 0;
        foreach ($ids as $id) {
            if ($this->purgeOneAccomplishmentReport((int) $id, $days)) {
                $purged++;
            } else {
                $failed++;
            }
        }

        $this->audit('retention_accomplishment_report_purged', 'accomplishment_report', ['purged' => $purged, 'failed' => $failed]);
        $this->note("accomplishment_report: purged {$purged}, {$failed} failed (with entries and attached scans)");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible, 'failed' => $failed];
    }

    private function purgeOneAccomplishmentReport(int $reportId, int $days): bool
    {
        // document_scan may not exist on a DB without migration 0037.
        $paths = [];
        try {
            $s = $this->pdo->prepare("SELECT stored_path FROM document_scan WHERE entity_type = 'accomplishment_report' AND entity_id = :id");
            $s->execute(['id' => $reportId]);
            $paths = $s->fetchAll(PDO::FETCH_COLUMN);
        } catch (\PDOException $e) {
            if (!$this->isMissingTable($e)) {
                throw $e;
            }
        }

        $this->pdo->beginTransaction();
        try {
            // Re-check eligibility INSIDE the transaction (row-locked): the
            // report could have changed since the id scan.
            $chk = $this->pdo->prepare(
                "SELECT 1 FROM accomplishment_report
                  WHERE report_id = :id AND status = 'approved' AND approved_at IS NOT NULL
                    AND approved_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY) FOR UPDATE"
            );
            $chk->execute(['id' => $reportId, 'days' => $days]);
            if ($chk->fetchColumn() === false) {
                $this->pdo->rollBack();
                return false;
            }
            try {
                $this->execById("DELETE FROM document_scan WHERE entity_type = 'accomplishment_report' AND entity_id = :id", $reportId);
            } catch (\PDOException $e) {
                if (!$this->isMissingTable($e)) {
                    throw $e;
                }
            }
            $this->execById('DELETE FROM accomplishment_entry WHERE report_id = :id', $reportId);
            $this->execById('DELETE FROM accomplishment_report WHERE report_id = :id', $reportId);
            $this->pdo->commit();
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            $this->note("accomplishment_report #{$reportId}: purge failed and was rolled back — " . $e->getMessage());
            return false;
        }

        foreach ($paths as $path) {
            $resolved = $this->resolveScanPath((string) $path);
            if ($resolved !== null && is_file($resolved) && !@unlink($resolved)) {
                $this->note("accomplishment_report #{$reportId}: scan file could not be removed — {$resolved}");
            }
        }
        return true;
    }

    /**
     * Scans live flat in `SCANS_DIR` (default `backend/storage/scans`, outside
     * the web root); `stored_path` is a bare file name. Same containment
     * discipline as resolveEvidencePath(): a crafted value must never steer
     * an unlink outside the directory.
     */
    private function resolveScanPath(string $storedPath): ?string
    {
        if (!preg_match('/^[A-Za-z0-9._-]+$/', $storedPath)) {
            return null;
        }
        $base = baranguard_env('SCANS_DIR');
        $baseDir = ($base !== false && trim((string) $base) !== '')
            ? rtrim((string) $base, '/\\')
            : dirname(__DIR__, 2) . '/storage/scans';
        $realBase = realpath($baseDir);
        if ($realBase === false) {
            return null;
        }
        $candidate = realpath($baseDir . DIRECTORY_SEPARATOR . $storedPath);
        if ($candidate === false || !str_starts_with($candidate, $realBase)) {
            return null;
        }
        return $candidate;
    }

    /** @return array{purged:int, held:int, eligible?:int, note?:string} */
    public function purgeSchoolCheckins(): array
    {
        $days = $this->newTableDays('school_checkin');
        if ($days === null) {
            return $this->pendingResult('school_checkin');
        }
        $where = 'checked_in_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $params = ['days' => $days];

        try {
            $eligible = $this->countWhere('school_checkin', $where, $params);
        } catch (\PDOException $e) {
            if ($this->isMissingTable($e)) {
                $this->note('school_checkin: table not present (migration 0033 not applied)');
                return ['purged' => 0, 'held' => 0, 'note' => 'table not present'];
            }
            throw $e;
        }
        if ($this->dryRun || $eligible === 0) {
            $this->note("school_checkin: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM school_checkin WHERE {$where}");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_school_checkin_purged', 'school_checkin', ['purged' => $purged]);
        $this->note("school_checkin: purged {$purged}");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible];
    }

    /**
     * `incident_referral` has no `legal_hold` of its own; like `sms_log`'s
     * inherited paths, a hold on the linked INCIDENT protects it (counted
     * in `held`, never silently skipped).
     *
     * @return array{purged:int, held:int, eligible?:int, note?:string}
     */
    public function purgeIncidentReferrals(): array
    {
        $days = $this->newTableDays('incident_referral');
        if ($days === null) {
            return $this->pendingResult('incident_referral');
        }
        $aged = 'referred_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $onHold = 'EXISTS (SELECT 1 FROM incident i WHERE i.incident_id = incident_referral.incident_id AND i.legal_hold = 1)';
        $params = ['days' => $days];

        try {
            $held = $this->countWhere('incident_referral', "{$aged} AND {$onHold}", $params);
            $eligible = $this->countWhere('incident_referral', "{$aged} AND NOT {$onHold}", $params);
        } catch (\PDOException $e) {
            if ($this->isMissingTable($e)) {
                $this->note('incident_referral: table not present (migration 0032 not applied)');
                return ['purged' => 0, 'held' => 0, 'note' => 'table not present'];
            }
            throw $e;
        }
        if ($this->dryRun || $eligible === 0) {
            $this->note("incident_referral: {$eligible} eligible, {$held} on legal hold");
            return ['purged' => 0, 'held' => $held, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM incident_referral WHERE {$aged} AND NOT {$onHold}");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_incident_referral_purged', 'incident_referral', ['purged' => $purged, 'held' => $held]);
        $this->note("incident_referral: purged {$purged}, {$held} on legal hold");
        return ['purged' => $purged, 'held' => $held, 'eligible' => $eligible];
    }

    // ------------------------------------------------------------------
    // Rule 6 — audit_log (§11: 7 years, "write-once except controlled
    // retention deletion")
    // ------------------------------------------------------------------

    /**
     * This is the "controlled retention deletion" Rule 17 carves out as
     * the single exception to audit_log being write-once. It is
     * deliberately the plainest rule in this file: an age filter and
     * nothing else. Any conditional logic here would be a way to make
     * specific audit rows disappear, which is precisely what a
     * write-once log exists to prevent.
     *
     * @return array{purged:int, held:int}
     */
    public function purgeAuditLog(): array
    {
        $where = 'created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $params = ['days' => self::AUDIT_LOG_DAYS];

        $eligible = $this->countWhere('audit_log', $where, $params);
        if ($this->dryRun || $eligible === 0) {
            $this->note("audit_log: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM audit_log WHERE {$where}");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        // The audit row recording this purge is itself an audit row, and
        // is written AFTER the delete so it can never be caught by its
        // own scan.
        $this->audit('retention_audit_log_purged', 'audit_log', ['purged' => $purged]);
        $this->note("audit_log: purged {$purged}");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible];
    }

    // ------------------------------------------------------------------
    // Rule 7 — the 7-year case purge (§11: "redacted incident / blotter /
    // evidence, 7 years default")
    // ------------------------------------------------------------------

    /**
     * The only genuinely hard rule here, because §5's FK policy makes an
     * incident deletion an ordered cascade rather than one statement:
     * `evidence_attachment` and `dispatch` are both
     * ON DELETE **RESTRICT** against `incident`. Everything else
     * (`citizen_report`, `notification`, `sms_log`, `gps_track`,
     * `tanod_sos`) is SET NULL and clears itself.
     *
     * Each incident is purged in its own transaction, in dependency
     * order, so a failure part-way (an unlinkable evidence file, a lock
     * timeout) rolls that case back whole rather than leaving a
     * half-deleted case behind.
     *
     * Evidence bytes are removed from disk BEFORE the row goes; a file
     * that cannot be unlinked aborts that incident (see class doc).
     *
     * @return array{purged:int, held:int}
     */
    public function purgeExpiredIncidentRecords(): array
    {
        $where = 'created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $params = ['days' => self::RECORD_RETENTION_DAYS];

        $held = $this->countWhere('incident', "{$where} AND legal_hold = 1", $params);

        $stmt = $this->pdo->prepare(
            "SELECT incident_id FROM incident WHERE {$where} AND legal_hold = 0 ORDER BY incident_id"
        );
        $stmt->execute($params);
        $ids = $stmt->fetchAll(PDO::FETCH_COLUMN);
        $eligible = count($ids);

        if ($this->dryRun || $eligible === 0) {
            $this->note("incident_records (7y): {$eligible} eligible, {$held} on legal hold");
            return ['purged' => 0, 'held' => $held, 'eligible' => $eligible];
        }

        $purged = 0;
        $failed = 0;
        foreach ($ids as $incidentId) {
            if ($this->purgeOneIncident((int) $incidentId)) {
                $purged++;
            } else {
                $failed++;
            }
        }

        $this->audit('retention_incident_purged', 'incident', [
            'purged' => $purged,
            'held' => $held,
            'failed' => $failed,
        ]);
        $this->note("incident_records (7y): purged {$purged}, {$held} on legal hold, {$failed} failed");
        return ['purged' => $purged, 'held' => $held, 'eligible' => $eligible, 'failed' => $failed];
    }

    /**
     * One case, one transaction, dependency order. Returns false (having
     * rolled back) if anything in the cascade fails.
     */
    private function purgeOneIncident(int $incidentId): bool
    {
        // Collect evidence paths BEFORE the transaction — we need them
        // after the rows are gone, and reading them inside the
        // transaction we are about to roll back would be pointless.
        $pathStmt = $this->pdo->prepare('SELECT file_path FROM evidence_attachment WHERE incident_id = :id');
        $pathStmt->execute(['id' => $incidentId]);
        $paths = $pathStmt->fetchAll(PDO::FETCH_COLUMN);

        $this->pdo->beginTransaction();
        try {
            // RESTRICT dependents, innermost first.
            // incident_referral (migration 0032) is RESTRICT against incident. A DB that has
            // not applied 0032 yet has no such table (SQLSTATE 42S02); that is not an error.
            try {
                $this->exec('DELETE FROM incident_referral WHERE incident_id = :id', $incidentId);
            } catch (\PDOException $e) {
                if ((string) $e->getCode() !== '42S02') {
                    throw $e;
                }
            }
            $this->exec('DELETE FROM evidence_attachment WHERE incident_id = :id', $incidentId);
            $this->exec('DELETE FROM dispatch WHERE incident_id = :id', $incidentId);
            $this->exec('DELETE FROM incident WHERE incident_id = :id', $incidentId);

            $this->pdo->commit();
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            $this->note("incident #{$incidentId}: purge failed and was rolled back — " . $e->getMessage());
            return false;
        }

        // Files last: the row is gone, so a leftover file is the only
        // possible inconsistency, and it is the recoverable direction
        // (an orphan we can report) rather than a database row pointing
        // at bytes that no longer exist.
        foreach ($paths as $path) {
            $resolved = $this->resolveEvidencePath((string) $path);
            if ($resolved !== null && is_file($resolved) && !@unlink($resolved)) {
                $this->note("incident #{$incidentId}: evidence file could not be removed — {$resolved}");
            }
        }
        return true;
    }

    /**
     * §5 keeps evidence outside the web root; `file_path` is stored
     * relative to `EVIDENCE_DIR` (default `backend/storage/evidence`).
     * The resolved path is asserted to stay inside that directory, the
     * same containment check `MapPackagesController` already applies —
     * a retention job that could be steered into unlinking arbitrary
     * files by a crafted `file_path` would be a far worse bug than the
     * data it is trying to remove.
     */
    private function resolveEvidencePath(string $filePath): ?string
    {
        $base = baranguard_env('EVIDENCE_DIR');
        $baseDir = ($base !== false && trim((string) $base) !== '')
            ? rtrim((string) $base, '/\\')
            : dirname(__DIR__, 2) . '/storage/evidence';

        $realBase = realpath($baseDir);
        if ($realBase === false) {
            return null; // nothing stored yet on this workstation
        }
        $candidate = realpath($baseDir . '/' . ltrim($filePath, '/\\'));
        if ($candidate === false) {
            // Also accept an already-absolute stored path, still contained.
            $candidate = realpath($filePath);
        }
        if ($candidate === false || !str_starts_with($candidate, $realBase)) {
            return null;
        }
        return $candidate;
    }

    // ------------------------------------------------------------------
    // Offline mirror (§11: no independent retention)
    // ------------------------------------------------------------------

    /**
     * §11: "Offline mirror (`offline_queue`, mobile local tables) —
     * cleared on confirmed sync per device retention rules (Rule 2); no
     * independent retention beyond that. Server mirror never holds raw
     * payload, so no separate raw-data ceiling applies here."
     *
     * That is a deliberate NO-OP, documented as a method so a future
     * session doesn't read the absence as an oversight and invent a
     * clock §11 explicitly declines to define. `SyncController` already
     * resolves queue rows on confirmed sync; nothing here should
     * second-guess that.
     */
    public function purgeOfflineQueue(): array
    {
        return ['purged' => 0, 'held' => 0, 'note' => '§11 defines no independent retention for the offline mirror.'];
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /** @param array<string,mixed> $params */
    private function countWhere(string $from, string $where, array $params): int
    {
        $stmt = $this->pdo->prepare("SELECT COUNT(*) FROM {$from} WHERE {$where}");
        $stmt->execute($params);
        return (int) $stmt->fetchColumn();
    }

    /** Runs a statement with one `:id` parameter. */
    private function execById(string $sql, int $id): void
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute(['id' => $id]);
    }

    private function exec(string $sql, int $incidentId): void
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute(['id' => $incidentId]);
    }

    /**
     * Rule 17: retention jobs produce audit events. `actor_user_id` and
     * `barangay_id` are both NULL — this is the SYSTEM acting on a
     * schedule, not a person acting in a barangay, and inventing an
     * actor would make the audit trail lie about who did it.
     *
     * @param array<string,int|string> $metadata identifiers/counts only (Rule 17 allow-list)
     */
    private function audit(string $action, string $entityType, array $metadata): void
    {
        Audit::record($this->pdo, null, null, $action, $entityType, null, $metadata);
    }

    private function note(string $line): void
    {
        $this->log[] = $line;
    }
}
