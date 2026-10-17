-- ============================================================
-- 0044_report_channel_phone_facebook.sql — report channel gets two more values.
--
-- Real barangays receive reports by phone call and Facebook message as well as
-- walk-in and tanod patrol. Staff log those as incidents (the citizen inbox was
-- retired 2026-10-17), so the channel must say how the report really arrived
-- instead of filing everything under `other`.
--
--   phone_call — a resident called the hall or a tanod, staff logged it
--   facebook   — a resident messaged the barangay page, staff logged it
--
-- Additive widening of the enum: existing rows and values are untouched, the
-- default stays `other`. Idempotent (re-running sets the same definition).
-- ============================================================
SET NAMES utf8mb4;

ALTER TABLE incident
  MODIFY COLUMN report_channel ENUM('tanod_alerted','walk_in','sms','phone_call','facebook','other')
  NOT NULL DEFAULT 'other';
