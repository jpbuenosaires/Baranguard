-- ============================================================
-- 0016_retention_hold_and_device_scrub.sql — closes two §11 retention
-- gaps that the Master Reference has carried as "target rule, not yet
-- built" since 2026-09-07 (`docs/REMAINING.md` §G2 and §G3).
--
-- Both are the SAME KIND of gap: §11 already states the correct rule,
-- the schema just never gained the column needed to execute it, so
-- `RetentionService` implemented the under-protective behaviour instead
-- and said so in its own comments. This migration adds the two columns;
-- the service changes land with it.
--
--   1. `sms_log` has **no `legal_hold` column**, so §11's target rule —
--      "extended for the duration of any hold on the linked incident /
--      dispatch / citizen report" — is unexecutable. The table is
--      currently purged on a flat 1-year clock regardless of a hold on
--      the case the message belongs to, which means a legal hold on an
--      incident does NOT protect the SMS trail that is part of how that
--      incident was handled.
--
--      `incident`, `citizen_report` and `evidence_attachment` all carry
--      their own `legal_hold` already (0001 for the latter two, 0007 for
--      `incident`); this brings `sms_log` in line with the pattern
--      rather than inventing a new one.
--
--      NOTE ON SCOPE — this column is the table's own flag, and the
--      retention job ALSO checks the linked case records directly. That
--      is deliberate and follows 0007's own resolved decision: "a hold
--      is placed on a CASE, not on a row." `dispatch` has no
--      `legal_hold` of its own by that same decision, so a message
--      linked to a dispatch inherits the hold from that dispatch's
--      incident. The column exists so a hold can also be placed on a
--      transport record directly (e.g. an SMS thread subpoenaed on its
--      own), without which the inheritance path would be the only one.
--
--   2. `mobile_device` has no way to record that its secrets were
--      scrubbed, because the rule used to be "delete the row after 90
--      days" and a deleted row needs no marker.
--
--      That rule was found to be wrong: every reference to
--      `mobile_device` is ON DELETE SET NULL (`incident.device_id`,
--      `notification_target.device_id`), so deleting the row silently
--      strips device provenance from incidents under 7-year retention or
--      active legal hold, 90 days after a Tanod's handset is
--      deactivated. §11's revised target rule keeps the row and clears
--      only the secret columns (`fcm_token`, `device_secret_ref`) —
--      satisfying Rule 26 (device secrets must not linger) without
--      destroying attribution Rule 11 requires be kept for years.
--
--      `secrets_scrubbed_at` is the per-record evidence that the job ran
--      on that row, and the guard that makes the scan idempotent and
--      cheap to re-run. This is exactly the shape 0007 already gave
--      `incident.raw_narrative_purged_at` for the same reason — an
--      existing pattern applied, not a new one.
--
-- New migration, not an edit to 0001/0007 (this repo's standing
-- convention — §2 Rule 9).
--
-- Idempotent: every statement is guarded, so re-running is a no-op.
-- ============================================================

-- 1: sms_log legal hold.
ALTER TABLE sms_log
  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT FALSE;

-- The retention scan's first two filters, in the order it applies them:
-- "not held" then "older than the window". Mirrors 0007's
-- `idx_incident_raw_retention` reasoning — the cheapest discriminator
-- leads.
ALTER TABLE sms_log
  ADD INDEX IF NOT EXISTS idx_sms_log_retention (legal_hold, created_at);

-- 2: mobile_device scrub marker.
--
-- No new index: `idx_mobile_device_deactivated (is_active, deactivated_at)`
-- from 0007 already narrows this scan to deactivated rows, and the
-- additional `secrets_scrubbed_at IS NULL` filter runs against that much
-- smaller set.
ALTER TABLE mobile_device
  ADD COLUMN IF NOT EXISTS secrets_scrubbed_at DATETIME NULL;
