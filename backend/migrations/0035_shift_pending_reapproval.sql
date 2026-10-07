-- ============================================================
-- 0035_shift_pending_reapproval.sql — "swap approved, roster awaiting
-- re-approval" flag on shifts (review-decision implementation, Wave 1 /
-- Agent A).
--
-- When an Admin/Secretary approves a Tanod's swap request on a PUBLISHED
-- shift, the shift reverts to `draft` (the approver signed off on a
-- different assignee) and this flag is set to 1. A Tanod's GET /shifts
-- then shows (published) OR (pending_reapproval = 1 AND own shift), so the
-- Tanod keeps seeing the shift that is still theirs while it waits for a
-- fresh `approve_roster` publish. Publishing a shift clears the flag. Any
-- other material edit keeps the old behaviour (draft, hidden, flag stays 0).
--
-- Existing rows: 0. New migration (Rule 9). Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================================
SET NAMES utf8mb4;

ALTER TABLE shift_schedule
  ADD COLUMN IF NOT EXISTS pending_reapproval TINYINT(1) NOT NULL DEFAULT 0;
