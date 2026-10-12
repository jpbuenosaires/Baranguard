-- ============================================================
-- 0040_report_and_roster_notifications.sql -- tell a tanod when their
-- accomplishment report is returned or approved, and when their duty
-- shifts are published (paper-first follow-up, 2026-10-12).
--
--   * `notification.notification_type` gains 'report_update' and
--     'roster_published'.
--   * `notification.accomplishment_report_id` links a report_update to its
--     report (ON DELETE SET NULL, like the other entity links; the matrix is
--     enforced in PHP, NotificationService, never as a CHECK -- ERROR 1901,
--     see migration 0001).
--
-- Both are ordinary push notifications: no SMS fallback (message_type '' in
-- NotificationDispatcher) and never a full-screen critical alert. Content is
-- the month and the outcome only, never the return reason or entry text.
-- Notification rows keep the existing 1-year retention.
--
-- New numbered migration (Rule 9). Idempotent (IF NOT EXISTS / MODIFY).
-- ============================================================

SET NAMES utf8mb4;

ALTER TABLE notification
  MODIFY COLUMN notification_type ENUM('dispatch','sos','priority_alert','other','dispatch_offer','report_update','roster_published') NOT NULL;

ALTER TABLE notification
  ADD COLUMN IF NOT EXISTS accomplishment_report_id BIGINT UNSIGNED NULL AFTER dispatch_offer_id;

ALTER TABLE notification
  ADD CONSTRAINT fk_notification_accomplishment_report FOREIGN KEY IF NOT EXISTS (accomplishment_report_id)
    REFERENCES accomplishment_report(report_id) ON DELETE SET NULL;
