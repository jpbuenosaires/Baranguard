-- Rollback for 0030_approval_authority_and_roster.sql.
-- Destroys all availability submissions and every approval authority / title
-- assignment, and the draft/published distinction on shifts (after this every
-- shift is simply a shift again). Back up first.

SET NAMES utf8mb4;

ALTER TABLE shift_schedule DROP INDEX IF EXISTS idx_shift_barangay_approval;
ALTER TABLE shift_schedule DROP FOREIGN KEY IF EXISTS fk_shift_approved_by;
ALTER TABLE shift_schedule DROP FOREIGN KEY IF EXISTS fk_shift_source_availability;
ALTER TABLE shift_schedule
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS source_availability_id,
  DROP COLUMN IF EXISTS approval_status;

DROP TABLE IF EXISTS tanod_availability;

ALTER TABLE user
  DROP COLUMN IF EXISTS approval_authority,
  DROP COLUMN IF EXISTS official_title;
