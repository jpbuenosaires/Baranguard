-- Rollback for 0033_school_zones.sql. Destroys all school / check-in /
-- Annex D data and the incident school link + C-1 text. Back up first.
DROP TABLE IF EXISTS ssz_term_report;

ALTER TABLE incident DROP FOREIGN KEY IF EXISTS fk_incident_school;
ALTER TABLE incident DROP INDEX IF EXISTS idx_incident_school_created;
ALTER TABLE incident
  DROP COLUMN IF EXISTS c1_status_notes,
  DROP COLUMN IF EXISTS c1_action_taken,
  DROP COLUMN IF EXISTS c1_summary,
  DROP COLUMN IF EXISTS school_id;

DROP TABLE IF EXISTS school_checkin;
DROP TABLE IF EXISTS school;
