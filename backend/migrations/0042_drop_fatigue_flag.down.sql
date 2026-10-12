-- Rollback for 0042_drop_fatigue_flag.sql — INTENTIONALLY NOT IMPLEMENTED.
-- The up migration drops the table together with its data. Re-creating an
-- empty copy from this file would silently drift from the original DDL in
-- 0001_baseline_schema.sql. To roll back: restore the pre-0042 backup
-- (backend/scripts/restore-drill.sh documents the procedure), then re-apply the
-- code from the commit before this one.
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = '0042 cannot be rolled back in place: restore the pre-0042 backup instead.';
