-- Rollback for 0039_incident_resolve_reason.sql.
-- Drops the stored resolve reasons (the data is lost).
SET NAMES utf8mb4;

ALTER TABLE incident
  DROP COLUMN IF EXISTS resolve_reason;
