-- Rollback for 0035_shift_pending_reapproval.sql.
SET NAMES utf8mb4;

ALTER TABLE shift_schedule
  DROP COLUMN IF EXISTS pending_reapproval;
