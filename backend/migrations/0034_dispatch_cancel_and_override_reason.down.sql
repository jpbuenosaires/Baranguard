-- Rollback for 0034_dispatch_cancel_and_override_reason.sql.
-- Drops the stored cancel / override reasons (the data is lost).
SET NAMES utf8mb4;

ALTER TABLE dispatch
  DROP COLUMN IF EXISTS override_reason,
  DROP COLUMN IF EXISTS cancel_reason;
