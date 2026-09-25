-- 0025: incident lifecycle states + merge linkage — external audit
-- findings H-16/M-03 (2026-09-24, tracked in docs/REMAINING.md §H): the
-- incident.status enum had no way to record a duplicate, an invalid
-- report, a cancellation, or a case reopened after being closed.
--
-- 'duplicate'/'invalid'/'cancelled' are added as new terminal states
-- alongside the existing 'resolved'; 'reopened' is added as a re-entry
-- state a Secretary can move a 'resolved'/'cancelled' incident back into
-- (see IncidentsController::status()'s transition table for the actual
-- rules — this migration only widens the enum and adds the merge
-- columns, it does not enforce which transitions are legal).
--
-- MERGE = LINK, NOT DELETE (user decision, 2026-09-26): marking incident
-- A as a duplicate of incident B never deletes A or moves its
-- dispatch/evidence/blotter rows onto B. Both incidents stay independently
-- queryable and retained on their own clock; `duplicate_of_incident_id`
-- is purely a pointer a human follows. This avoids re-litigating the FK
-- RESTRICT cascade RetentionService::purgeOneIncident() already depends
-- on (§5's "FK trap") for a feature that doesn't need it.
--
-- ON DELETE SET NULL: if the incident being pointed at is ever purged by
-- retention (7-year clock, its own legal_hold), the duplicate marker
-- should not block that purge (RESTRICT) or silently vanish along with
-- unrelated data (CASCADE) — it just stops pointing anywhere.
--
-- New migration, not an edit to 0001 (§2 Rule 9 / repo convention).
-- Idempotent: guarded ADD COLUMN/INDEX, MODIFY COLUMN is naturally
-- idempotent against an identical target (same pattern as 0008/0013's
-- enum widenings).

ALTER TABLE incident
  MODIFY COLUMN status ENUM(
    'pending','dispatched','resolved',
    'duplicate','invalid','cancelled','reopened'
  ) NOT NULL DEFAULT 'pending';

ALTER TABLE incident
  ADD COLUMN IF NOT EXISTS duplicate_of_incident_id BIGINT UNSIGNED NULL AFTER status,
  ADD COLUMN IF NOT EXISTS lifecycle_changed_by BIGINT UNSIGNED NULL AFTER duplicate_of_incident_id,
  ADD COLUMN IF NOT EXISTS lifecycle_changed_at DATETIME NULL AFTER lifecycle_changed_by;

ALTER TABLE incident
  ADD CONSTRAINT fk_incident_duplicate_of FOREIGN KEY IF NOT EXISTS (duplicate_of_incident_id)
    REFERENCES incident(incident_id) ON DELETE SET NULL;

ALTER TABLE incident
  ADD CONSTRAINT fk_incident_lifecycle_changed_by FOREIGN KEY IF NOT EXISTS (lifecycle_changed_by)
    REFERENCES user(user_id) ON DELETE SET NULL;

ALTER TABLE incident
  ADD INDEX IF NOT EXISTS idx_incident_duplicate_of (duplicate_of_incident_id);

-- H-18 (AI evaluation/provenance, same audit): ai_processing_log already
-- records model_version per row but nothing about which PROMPT contract
-- produced the output, so a later prompt change can't be told apart from
-- a model change when reviewing old drafts. NULL for every row written
-- before this column existed — same phased-rollout shape as 0024's
-- device_public_key_pem, not a backfill.
ALTER TABLE ai_processing_log
  ADD COLUMN IF NOT EXISTS prompt_template_version VARCHAR(32) NULL AFTER model_version;
