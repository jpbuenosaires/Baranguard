-- Reverses 0040_report_and_roster_notifications.sql. Idempotent.
SET NAMES utf8mb4;

DELETE FROM notification WHERE notification_type IN ('report_update', 'roster_published');

ALTER TABLE notification DROP FOREIGN KEY IF EXISTS fk_notification_accomplishment_report;
ALTER TABLE notification DROP COLUMN IF EXISTS accomplishment_report_id;

ALTER TABLE notification
  MODIFY COLUMN notification_type ENUM('dispatch','sos','priority_alert','other','dispatch_offer') NOT NULL;
