-- Rollback for 0031_accomplishment_reports.sql. Destroys every accomplishment
-- report and entry. Back up first.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS accomplishment_entry;
DROP TABLE IF EXISTS accomplishment_report;

-- Restore the original ENUM; ledger rows of the four newer kinds cannot survive it.
DELETE FROM offline_queue WHERE payload_type IN ('referral','availability','accomplishment_entry','school_checkin');
ALTER TABLE offline_queue
  MODIFY COLUMN payload_type ENUM('incident','gps','duty_status','sos','dispatch_status') NOT NULL;
