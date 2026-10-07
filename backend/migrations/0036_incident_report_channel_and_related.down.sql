-- Rollback for 0036_incident_report_channel_and_related.sql. Drops the
-- report channel and the related-incident links (data loss for both).
ALTER TABLE incident DROP FOREIGN KEY IF EXISTS fk_incident_related;
ALTER TABLE incident DROP INDEX IF EXISTS idx_incident_related;
ALTER TABLE incident
  DROP COLUMN IF EXISTS related_incident_id,
  DROP COLUMN IF EXISTS report_channel;
