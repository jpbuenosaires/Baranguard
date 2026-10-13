-- ============================================================
-- 0043_display_id_unique_per_barangay.sql
-- Incident display codes (INC-YYYY-NNN) are numbered PER BARANGAY and per
-- year (IncidentsController::nextDisplayId), but migration 0014 made
-- display_id unique across the whole table. The first incident of a year in a
-- second barangay would therefore try to reuse INC-<year>-001, fail the unique
-- key, and the create request would return a server error.
-- The uniqueness rule now matches the numbering scope: (barangay_id, display_id).
-- Idempotent: every statement is guarded, so re-running is a no-op.
-- ============================================================

ALTER TABLE incident
  DROP INDEX IF EXISTS uq_incident_display_id,
  ADD UNIQUE KEY IF NOT EXISTS uq_incident_barangay_display (barangay_id, display_id);
