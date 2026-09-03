SET NAMES utf8mb4;

ALTER TABLE sms_log
  DROP FOREIGN KEY fk_sms_log_barangay,
  DROP INDEX idx_sms_log_barangay,
  DROP COLUMN barangay_id;
