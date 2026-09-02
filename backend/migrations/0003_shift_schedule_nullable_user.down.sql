-- Rollback for 0003_shift_schedule_nullable_user.sql.
-- Requires no NULL user_id rows to exist first (an unassigned shift must
-- be reassigned or deleted before downgrading), otherwise this fails with
-- a NOT NULL constraint violation rather than silently dropping data.

SET NAMES utf8mb4;

ALTER TABLE shift_schedule MODIFY COLUMN user_id BIGINT UNSIGNED NOT NULL;
