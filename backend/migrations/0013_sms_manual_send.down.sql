-- Rollback for 0013_sms_manual_send.sql.
--
-- NOTE: reverting `message_type` will FAIL if any row has already been
-- written with `message_type='manual'` — those rows must be dealt with
-- deliberately (delete or reassign) before this MODIFY can succeed. Left
-- last so the column drops above still apply even if it fails, same
-- pattern 0008's own rollback uses for its ENUM widening.

ALTER TABLE sms_log
  DROP COLUMN IF EXISTS message_body,
  DROP COLUMN IF EXISTS read_at;

ALTER TABLE sms_log
  MODIFY COLUMN message_type ENUM('incident','dispatch','priority_alert','coord_ping','confirmation','duty_status','sos') NOT NULL;
