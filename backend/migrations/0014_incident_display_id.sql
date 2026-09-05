-- ============================================================
-- 0014_incident_display_id.sql — human-readable case numbers:
-- `INC-YYYY-NNN` on `incident`, `BLT-YYYY-NNN` on `blotter_record`.
--
-- Before this migration, both screens displayed a raw auto-increment
-- integer (`#48`, `#12`) as the case's "ID". A reference mockup showed
-- a formatted logbook-style number instead.
--
-- `display_id` is computed and stored at write time (incident creation /
-- blotter finalization — see IncidentsController.php/BlotterController.php),
-- not derived on every read, so it never changes once assigned even if
-- the counting logic changes later. The counter is PER BARANGAY PER
-- YEAR (`COUNT(*)+1` scoped to `barangay_id` + the current year, in the
-- same transaction as the insert) — matching how a real barangay keeps
-- its own logbook, distinct from the other three barangays' numbering.
--
-- Known, accepted limitation (documented rather than hidden, per this
-- project's own "prove it, don't claim it" standard): under heavy
-- concurrent writes to the SAME barangay in the SAME second, this
-- COUNT-based approach could theoretically skip or (with bad luck on
-- lock timing) collide on a number. No dedicated sequence-per-scope
-- table exists in this schema, and building one is more machinery than
-- a barangay's own paper logbook numbering has ever needed in practice —
-- the `UNIQUE` constraint below means a collision fails loudly (insert
-- error) rather than silently producing a duplicate number.
--
-- Nullable: existing rows created before this migration have no
-- `display_id` and are never backfilled with a fabricated one (§2 Rule
-- 6) — they display their raw ID until the API/UI is extended to fall
-- back to that for pre-migration rows (see the controller changes in
-- the same session's DEVLOG entry).
--
-- New migration, not an edit to 0001/0004 (this repo's standing
-- convention).
--
-- Idempotent: every statement is guarded, so re-running is a no-op.
-- ============================================================

ALTER TABLE incident
  ADD COLUMN IF NOT EXISTS display_id VARCHAR(20) NULL,
  ADD UNIQUE KEY IF NOT EXISTS uq_incident_display_id (display_id);

ALTER TABLE blotter_record
  ADD COLUMN IF NOT EXISTS display_id VARCHAR(20) NULL,
  ADD UNIQUE KEY IF NOT EXISTS uq_blotter_record_display_id (display_id);
