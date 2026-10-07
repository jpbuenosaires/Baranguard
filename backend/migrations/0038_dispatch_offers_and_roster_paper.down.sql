-- Rollback for 0038_dispatch_offers_and_roster_paper.sql. Back up first.
-- Deletes every dispatch_offer / dispatch_offer_recipient ROW, every
-- `dispatch_offer` notification (its targets and deliveries cascade), and the
-- paper-approval columns on shift_schedule. Dispatches created by an accepted
-- offer are ordinary dispatch rows and are KEPT.
ALTER TABLE shift_schedule DROP FOREIGN KEY IF EXISTS fk_shift_paper_recorded_by;
ALTER TABLE shift_schedule
  DROP COLUMN IF EXISTS paper_recorded_at,
  DROP COLUMN IF EXISTS paper_recorded_by,
  DROP COLUMN IF EXISTS paper_signed_on,
  DROP COLUMN IF EXISTS approval_mode;

-- The ENUM can only shrink once no row uses the value (and the offer-linked
-- priority_alert rows lose their link below, then stay as plain alerts).
DELETE FROM notification WHERE notification_type = 'dispatch_offer';
ALTER TABLE notification DROP FOREIGN KEY IF EXISTS fk_notification_dispatch_offer;
ALTER TABLE notification DROP COLUMN IF EXISTS dispatch_offer_id;
ALTER TABLE notification
  MODIFY COLUMN notification_type ENUM('dispatch','sos','priority_alert','other') NOT NULL;

DROP TABLE IF EXISTS dispatch_offer_recipient;
DROP TABLE IF EXISTS dispatch_offer;
