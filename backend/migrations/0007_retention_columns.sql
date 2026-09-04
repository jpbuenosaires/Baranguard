-- ============================================================
-- 0007_retention_columns.sql — Sprint 7, "Retention jobs" cut.
--
-- §11's retention table cannot be implemented against the 0001 baseline
-- as-is. Four real gaps, each fixed here in a NEW migration rather than
-- by editing the completed 0001 (this repo's standing convention, same
-- as 0003/0004/0005/0006):
--
--   1. `incident.raw_narrative` is TEXT **NOT NULL**, so the single most
--      important retention rule in the system — "delete raw_narrative 30
--      days after approved redaction, hard ceiling 90 days if never
--      approved" (§11, Rule 11) — is literally unexecutable: there is no
--      value the job could write that means "purged". Made NULL-able.
--      Writing an empty string instead was rejected: '' is
--      indistinguishable from a bug that wrote a blank narrative, and
--      every reader in the codebase already treats the column as
--      "present" when it is a string.
--
--   2. `incident` has **no `legal_hold` column**, yet §11 names legal
--      hold as "the only exception" to both the raw-narrative rule and
--      the 7-year record rule. Without it the job would have no way to
--      honour a hold on the one table that matters most.
--      `evidence_attachment` and `citizen_report` already carry their
--      own `legal_hold`; this brings `incident` in line.
--
--      Resolved decision, logged in DEVLOG.md: an incident's
--      `legal_hold` also covers its dependent case records
--      (`blotter_record`, `blotter_revision`, `dispatch`,
--      `ai_processing_log`), which have no `legal_hold` column of their
--      own. A hold is placed on a CASE, not on a row — holding the
--      incident while its blotter entry could still be purged would be
--      an obviously wrong reading of §11.
--
--   3. `incident` has no way to record that a purge happened.
--      `raw_narrative_purged_at` is the per-record evidence that the
--      retention job ran on that row (Rule 17 asks retention jobs to be
--      auditable) and makes the job idempotent/cheap to re-scan.
--
--   4. `mobile_device` has `is_active` but **no deactivation
--      timestamp**, so §11's "deleted 90 days after deactivation" has no
--      clock to count from. `deactivated_at` added, and
--      `DevicesController::deactivate()` now sets it.
--
--      Backfill choice for rows already inactive when this migration
--      runs: `deactivated_at = UTC_TIMESTAMP()`, i.e. the 90-day clock
--      starts NOW rather than being back-dated. We genuinely do not know
--      when those rows were deactivated, and starting the clock now is
--      the conservative direction — it can only delay a deletion, never
--      cause an early one.
--
-- Idempotent: every statement is guarded, so re-running is a no-op.
-- ============================================================

-- 1 + 2 + 3: incident retention columns.
-- MariaDB 10.4 has no `ADD COLUMN IF NOT EXISTS` for every server build,
-- but it DOES support it for ALTER TABLE ... ADD COLUMN — used here so a
-- re-run is safe. MODIFY is naturally idempotent (same target type).
ALTER TABLE incident
  MODIFY COLUMN raw_narrative TEXT NULL;

ALTER TABLE incident
  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS raw_narrative_purged_at DATETIME NULL;

-- Supports the retention job's two scans (approved-and-past-grace,
-- unapproved-past-ceiling) without a full table scan once the incident
-- table grows. `raw_narrative_purged_at` leads because the job's very
-- first filter is "not already purged".
ALTER TABLE incident
  ADD INDEX IF NOT EXISTS idx_incident_raw_retention
    (raw_narrative_purged_at, redaction_approved_at, created_at);

-- 4: device deactivation clock.
ALTER TABLE mobile_device
  ADD COLUMN IF NOT EXISTS deactivated_at DATETIME NULL;

ALTER TABLE mobile_device
  ADD INDEX IF NOT EXISTS idx_mobile_device_deactivated (is_active, deactivated_at);

-- Backfill: see the note above for why this is "now", not back-dated.
UPDATE mobile_device
   SET deactivated_at = UTC_TIMESTAMP()
 WHERE is_active = 0 AND deactivated_at IS NULL;
