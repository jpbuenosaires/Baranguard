-- Rollback for 0014_incident_display_id.sql.

ALTER TABLE blotter_record
  DROP KEY IF EXISTS uq_blotter_record_display_id,
  DROP COLUMN IF EXISTS display_id;

ALTER TABLE incident
  DROP KEY IF EXISTS uq_incident_display_id,
  DROP COLUMN IF EXISTS display_id;
