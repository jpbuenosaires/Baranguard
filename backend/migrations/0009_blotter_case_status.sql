-- ============================================================
-- 0009_blotter_case_status.sql — Blotter follow-up: a real, stored
-- case-status lifecycle for finalized blotter records.
--
-- Before this migration, `blotter-list.js`'s "Finalized"/"Amended" pill
-- was synthesized client-side from `revision_no > 1` — there was no
-- actual status concept anywhere on `blotter_record`. A reference mockup
-- showed Active/Under Investigation/Settled/Resolved case-status pills;
-- this migration adds the real column those pills need.
--
-- Lifecycle (see BlotterController.php for the enforcement):
--   - `active`               — set automatically on finalize().
--   - `under_investigation`  — set manually by the Secretary via amend().
--   - `settled`              — set manually by the Secretary via amend().
--   - `resolved`             — set automatically when the PARENT incident
--                               is marked resolved (IncidentsController's
--                               status-transition endpoint), never set
--                               directly by amend() — mirrors the
--                               incident's own lifecycle rather than
--                               letting the two drift independently.
--
-- `blotter_revision` gets the same column so an amendment's history
-- preserves what the case status was at that revision, same pattern
-- `complainant_name` etc. already follow there (migration 0008).
--
-- New migration, not an edit to 0004/0008 (this repo's standing
-- convention).
--
-- Idempotent: every statement is guarded, so re-running is a no-op.
-- ============================================================

ALTER TABLE blotter_record
  ADD COLUMN IF NOT EXISTS case_status ENUM('active','under_investigation','settled','resolved') NOT NULL DEFAULT 'active';

ALTER TABLE blotter_revision
  ADD COLUMN IF NOT EXISTS case_status ENUM('active','under_investigation','settled','resolved') NOT NULL DEFAULT 'active';
