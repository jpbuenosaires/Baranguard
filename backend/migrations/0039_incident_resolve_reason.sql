-- ============================================================
-- 0039_incident_resolve_reason.sql — reason for closing an incident
-- that was never dispatched (WORKFLOWS_AND_RULES Part 5 item 1,
-- decision 2026-10-09).
--
--   resolve_reason : why an Admin resolved a `pending` or `reopened`
--                    incident without any dispatch (for example a phone
--                    call or a walk-in settled it). REQUIRED by
--                    PATCH /incidents/:id/status for those two states,
--                    1-255 chars. Plain operational text, NEVER copied
--                    into audit metadata (Rule 8): the audit row records
--                    only that a reason exists and its length.
--
-- NULL for every existing row and for every incident resolved after a
-- dispatch. New migration (Rule 9). Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================================
SET NAMES utf8mb4;

ALTER TABLE incident
  ADD COLUMN IF NOT EXISTS resolve_reason VARCHAR(255) NULL;
