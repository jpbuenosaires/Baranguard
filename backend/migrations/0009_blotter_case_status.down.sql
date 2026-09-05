-- Rollback for 0009_blotter_case_status.sql.

ALTER TABLE blotter_revision
  DROP COLUMN IF EXISTS case_status;

ALTER TABLE blotter_record
  DROP COLUMN IF EXISTS case_status;
