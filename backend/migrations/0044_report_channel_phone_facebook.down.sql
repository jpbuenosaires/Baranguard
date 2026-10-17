-- Rollback for 0044_report_channel_phone_facebook.sql. Rows using the two new
-- values are folded into `other` first (the only lossy step), then the enum
-- returns to its 0036 definition.
UPDATE incident SET report_channel = 'other' WHERE report_channel IN ('phone_call','facebook');
ALTER TABLE incident
  MODIFY COLUMN report_channel ENUM('tanod_alerted','walk_in','sms','other')
  NOT NULL DEFAULT 'other';
