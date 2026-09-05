-- Rollback for 0010_incident_location_description.sql.

ALTER TABLE incident
  DROP COLUMN IF EXISTS location_description;
