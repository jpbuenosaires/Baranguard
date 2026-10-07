-- ============================================================
-- 0036_incident_report_channel_and_related.sql — Wave 1 review decisions
-- (docs/WORKFLOWS_AND_RULES.md review, incident intake).
--
-- 1. incident.report_channel: HOW the report reached the barangay, as a
--    record of intake, separate from the technical `source` (app/sms/web)
--    which says which system path wrote the row. Values:
--      tanod_alerted — a Tanod on patrol raised it (mobile app / sync)
--      walk_in       — logged by an Admin/Secretary at the desk (web),
--                      including a converted citizen report
--      sms           — reconstructed from an inbound SMS envelope
--      other         — anything else (default)
--    Backfill from `source`: app -> tanod_alerted, sms -> sms,
--    web -> walk_in. Re-run safety: the backfill runs ONLY when this run
--    added the column (a session variable records whether it already
--    existed), so a re-run can never overwrite a value an operator chose.
--
-- 2. incident.related_incident_id: a soft "this is related to that
--    incident" link (same barangay, enforced in PHP). Unlike
--    `duplicate_of_incident_id` it implies no lifecycle change and no
--    dispatch restriction. ON DELETE SET NULL so the retention cascade
--    (RetentionService::purgeOneIncident) never trips over it.
--
-- New migration (Rule 9). Idempotent: guarded ADD COLUMN / ADD INDEX /
-- ADD CONSTRAINT. Depends only on `incident` (columns through 0033).
-- ============================================================
SET NAMES utf8mb4;

SET @bg_had_report_channel := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'incident' AND COLUMN_NAME = 'report_channel'
);

ALTER TABLE incident
  ADD COLUMN IF NOT EXISTS report_channel
    ENUM('tanod_alerted','walk_in','sms','other') NOT NULL DEFAULT 'other' AFTER source;

UPDATE incident
   SET report_channel = CASE source
         WHEN 'app' THEN 'tanod_alerted'
         WHEN 'sms' THEN 'sms'
         WHEN 'web' THEN 'walk_in'
         ELSE 'other'
       END
 WHERE @bg_had_report_channel = 0;

ALTER TABLE incident
  ADD COLUMN IF NOT EXISTS related_incident_id BIGINT UNSIGNED NULL AFTER duplicate_of_incident_id;

ALTER TABLE incident
  ADD INDEX IF NOT EXISTS idx_incident_related (related_incident_id);

ALTER TABLE incident
  ADD CONSTRAINT fk_incident_related FOREIGN KEY IF NOT EXISTS (related_incident_id)
    REFERENCES incident(incident_id) ON DELETE SET NULL;
