-- Rollback for 0029_remove_blotter_and_ai_pipeline.sql — INTENTIONALLY
-- NOT IMPLEMENTED. The up migration drops tables together with their
-- data, and their final shape is the sum of 0001, 0004, 0008, 0009,
-- 0014, 0015, 0021, 0025, 0027 and 0028 — re-creating an empty copy from
-- this file would silently drift from that. To roll back: restore the
-- pre-0029 backup (backend/scripts/restore-drill.sh documents the
-- procedure), then re-apply code from the commit before this one.
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = '0029 cannot be rolled back in place: restore the pre-0029 backup instead.';
