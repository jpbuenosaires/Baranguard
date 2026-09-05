-- Rollback for 0011_user_suspension.sql.

ALTER TABLE user
  DROP COLUMN IF EXISTS is_suspended,
  DROP COLUMN IF EXISTS suspended_reason,
  DROP COLUMN IF EXISTS suspended_at;
