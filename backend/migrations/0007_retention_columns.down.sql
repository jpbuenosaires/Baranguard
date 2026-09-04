-- Rollback for 0007_retention_columns.sql.
--
-- NOTE: reverting `raw_narrative` to NOT NULL will FAIL if the retention
-- job has already purged any row (that is the whole point of the
-- column being nullable). Those rows must be resolved deliberately —
-- there is no correct automatic answer, since the original text is
-- irrecoverable by design. The MODIFY is therefore left LAST so the
-- column drops above still apply if it fails.

ALTER TABLE mobile_device
  DROP INDEX IF EXISTS idx_mobile_device_deactivated;
ALTER TABLE mobile_device
  DROP COLUMN IF EXISTS deactivated_at;

ALTER TABLE incident
  DROP INDEX IF EXISTS idx_incident_raw_retention;
ALTER TABLE incident
  DROP COLUMN IF EXISTS legal_hold,
  DROP COLUMN IF EXISTS raw_narrative_purged_at;

ALTER TABLE incident
  MODIFY COLUMN raw_narrative TEXT NOT NULL;
