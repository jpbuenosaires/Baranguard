-- ============================================================
-- 0008_incident_party_fields.sql — Electronic Blotter follow-up:
-- AI-drafted Complainant/Respondent/Contact number.
--
-- A reference mockup for the Electronic Blotter screen showed
-- Complainant/Respondent/Contact fields that don't exist anywhere in
-- this schema — `blotter_record` only ever had free-text
-- `narrative_summary`. User asked for these to be AI-drafted from the
-- incident narrative (same moment redaction is requested), reviewed/
-- edited by the Secretary, then carried into the finalized record —
-- the same three-stage shape `incident.redacted_narrative` already has
-- (draft on `ai_processing_log` -> Secretary review/edit -> approved
-- value on `incident` -> explicitly carried into `blotter_record` at
-- finalize, same as `narrative_summary` already is, never silently
-- auto-copied).
--
-- New migration, not an edit to 0001 (this repo's standing convention).
--
-- 1. `ai_processing_log.task_type` gains `'extraction'` — a fourth,
--    INDEPENDENT task type mirroring how `'translation'` already works
--    (its own rows, doesn't supersede or get superseded by redaction) —
--    not a redaction-adjacent stage, since these fields are reviewed and
--    saved on their own schedule, same as a translation is.
-- 2. `ai_processing_log` gains three nullable DRAFT columns — same
--    "wide table, NULL for whatever task_type doesn't use this column"
--    shape `translated_text`/`draft_summary` already establish.
-- 3. `incident` gains three nullable APPROVED columns — the Secretary-
--    approved home, structurally parallel to `redacted_narrative`.
-- 4. `blotter_record` gains the same three columns — the finalized
--    values, explicitly submitted at finalize/amend time (never
--    mechanically copied from the draft, same rule `narrative_summary`
--    already follows).
-- 5. `blotter_revision` gains the same three columns, so amending them
--    preserves history exactly like `narrative_summary` already does.
--
-- All three fields are OPTIONAL everywhere: not every incident has an
-- identifiable complainant/respondent (a fire, a missing-animal report),
-- and the user specifically asked for contact number to be optional.
--
-- Idempotent: every statement is guarded, so re-running is a no-op.
-- ============================================================

ALTER TABLE ai_processing_log
  MODIFY COLUMN task_type ENUM('summarization','redaction','translation','extraction') NOT NULL;

ALTER TABLE ai_processing_log
  ADD COLUMN IF NOT EXISTS draft_complainant_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS draft_respondent_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS draft_complainant_contact_number VARCHAR(32) NULL;

ALTER TABLE incident
  ADD COLUMN IF NOT EXISTS complainant_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS respondent_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS complainant_contact_number VARCHAR(32) NULL;

ALTER TABLE blotter_record
  ADD COLUMN IF NOT EXISTS complainant_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS respondent_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS complainant_contact_number VARCHAR(32) NULL;

ALTER TABLE blotter_revision
  ADD COLUMN IF NOT EXISTS complainant_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS respondent_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS complainant_contact_number VARCHAR(32) NULL;
