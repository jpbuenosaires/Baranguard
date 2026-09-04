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
 *   redacted incident /    7 years default (incident, blotter_record +
 *   blotter / evidence     blotter_revision, evidence_attachment).
 *   citizen_report         1 year from submitted_at while UNCONVERTED;
 *                          a converted report drops its own clock and
 *                          follows the linked incident.
 *   audit_log              7 years.
 *   sms_log                1 year, independent of the linked incident.
 *   ai_processing_log      1 year, OR until the linked incident's own
 *                          retention expires, whichever is LONGER.
 *   mobile_device          deleted 90 days after deactivation.
 *   offline mirror         no independent retention (Rule 2) — see
 *                          purgeOfflineQueue()'s own doc.
 *   backups                explicitly OUT of scope for a database job —
 *                          see the class-level note at the bottom.
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
 *     `blotter_record`, `blotter_revision`, `dispatch` and
 *     `ai_processing_log` have no `legal_hold` column of their own; a
 *     hold is placed on a case, not a row. Migration 0007's own header
 *     carries the same note.
 *
 *   - **Each purge runs in its own transaction, one record at a time for
 *     the cascading rules**, not one giant DELETE. §5's FK policy makes
 *     an incident purge a genuine ordered cascade (ai_processing_log →
 *     blotter_revision → blotter_record → evidence_attachment → dispatch
 *     → incident, since all five are ON DELETE RESTRICT), and a partial
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
    public const AI_LOG_DAYS = 365;               // or the incident's, whichever is longer
    public const AUDIT_LOG_DAYS = 2557;           // aligned with blotter retention
    public const DEVICE_DEACTIVATED_DAYS = 90;

    /** Every rule name this service knows, in the order a full run applies them. */
    public const RULES = [
        'raw_narrative',
        'citizen_report',
        'sms_log',
        'ai_processing_log',
        'mobile_device',
        'audit_log',
        'incident_records',
    ];

    private PDO $pdo;
    private bool $dryRun;
    /** @var list<string> */
    private array $log = [];

    public function __construct(PDO $pdo, bool $dryRun = false)
    {
        $this->pdo = $pdo;
        $this->dryRun = $dryRun;
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
                'ai_processing_log' => $this->purgeAiProcessingLogs(),
                'mobile_device' => $this->purgeDeactivatedDevices(),
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
    // Rule 3 — sms_log (§11: "1 year default, independent of the linked
    // incident's own retention")
    // ------------------------------------------------------------------

    /** @return array{purged:int, held:int} */
    public function purgeSmsLogs(): array
    {
        // "Independent of the linked incident" is why there is no join
        // here and no legal-hold check: §11 gives sms_log a flat clock,
        // and `sms_log` carries no legal_hold column precisely because
        // the transport record is not the evidentiary record.
        $where = 'created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $params = ['days' => self::SMS_LOG_DAYS];

        $eligible = $this->countWhere('sms_log', $where, $params);
        if ($this->dryRun || $eligible === 0) {
            $this->note("sms_log: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM sms_log WHERE {$where}");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_sms_log_purged', 'sms_log', ['purged' => $purged]);
        $this->note("sms_log: purged {$purged}");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible];
    }

    // ------------------------------------------------------------------
    // Rule 4 — ai_processing_log (§11: "1 year default, OR until the
    // linked incident's retention expires, whichever is LONGER")
    // ------------------------------------------------------------------

    /**
     * "Whichever is longer" is implemented literally as an AND of both
     * clocks: a row goes only when it is BOTH more than a year old AND
     * its incident is past its own 7-year mark. In practice the
     * incident's clock dominates (a draft is created after its
     * incident), which is exactly what §11's "superseded draft rows
     * follow the same rule as the current row" implies — superseded and
     * current rows share an incident, so they expire together.
     *
     * An incident on legal hold protects its drafts too (see class doc).
     *
     * @return array{purged:int, held:int}
     */
    public function purgeAiProcessingLogs(): array
    {
        $from = 'ai_processing_log a JOIN incident i ON i.incident_id = a.incident_id';
        $where =
            "a.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :ai_days DAY)
             AND i.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :record_days DAY)";
        $params = ['ai_days' => self::AI_LOG_DAYS, 'record_days' => self::RECORD_RETENTION_DAYS];

        $held = $this->countWhere($from, "{$where} AND i.legal_hold = 1", $params);
        $eligible = $this->countWhere($from, "{$where} AND i.legal_hold = 0", $params);

        if ($this->dryRun || $eligible === 0) {
            $this->note("ai_processing_log: {$eligible} eligible, {$held} on legal hold");
            return ['purged' => 0, 'held' => $held, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare(
            "DELETE a FROM ai_processing_log a
               JOIN incident i ON i.incident_id = a.incident_id
              WHERE {$where} AND i.legal_hold = 0"
        );
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_ai_log_purged', 'ai_processing_log', ['purged' => $purged, 'held' => $held]);
        $this->note("ai_processing_log: purged {$purged}, {$held} on legal hold");
        return ['purged' => $purged, 'held' => $held, 'eligible' => $eligible];
    }

    // ------------------------------------------------------------------
    // Rule 5 — mobile_device (§11: "deleted 90 days after deactivation",
    // matching Rule 9's auth_session purge window)
    // ------------------------------------------------------------------

    /**
     * Deletes the device row, which takes `device_secret_ref` with it —
     * §11 says "`mobile_device` / device secrets", and Rule 26 wants the
     * secret gone, not merely orphaned.
     *
     * FK-safe with no ordering work: every reference to `mobile_device`
     * is ON DELETE SET NULL (`incident.device_id`,
     * `notification_target.device_id`), so an old incident keeps its row
     * and simply forgets which retired handset filed it.
     *
     * A device with `deactivated_at IS NULL` is never touched, even if
     * `is_active = 0` — migration 0007 backfills that column precisely so
     * no row is stuck in an unpurgeable state.
     *
     * @return array{purged:int, held:int}
     */
    public function purgeDeactivatedDevices(): array
    {
        $where =
            'is_active = 0
             AND deactivated_at IS NOT NULL
             AND deactivated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)';
        $params = ['days' => self::DEVICE_DEACTIVATED_DAYS];

        $eligible = $this->countWhere('mobile_device', $where, $params);
        if ($this->dryRun || $eligible === 0) {
            $this->note("mobile_device: {$eligible} eligible");
            return ['purged' => 0, 'held' => 0, 'eligible' => $eligible];
        }

        $stmt = $this->pdo->prepare("DELETE FROM mobile_device WHERE {$where}");
        $stmt->execute($params);
        $purged = $stmt->rowCount();

        $this->audit('retention_device_purged', 'mobile_device', ['purged' => $purged]);
        $this->note("mobile_device: purged {$purged}");
        return ['purged' => $purged, 'held' => 0, 'eligible' => $eligible];
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
     * `ai_processing_log`, `evidence_attachment`, `blotter_record`
     * (and `blotter_revision` behind it) and `dispatch` are all
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
            $this->exec('DELETE FROM ai_processing_log WHERE incident_id = :id', $incidentId);
            $this->exec(
                'DELETE br FROM blotter_revision br
                   JOIN blotter_record b ON b.blotter_id = br.blotter_id
                  WHERE b.incident_id = :id',
                $incidentId
            );
            $this->exec('DELETE FROM blotter_record WHERE incident_id = :id', $incidentId);
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
