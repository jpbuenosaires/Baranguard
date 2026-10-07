-- ============================================================
-- 0034_dispatch_cancel_and_override_reason.sql — reasons on dispatch
-- (review-decision implementation, Wave 1 / Agent A).
--
--   cancel_reason   : why an Admin cancelled the dispatch. Now REQUIRED by
--                     PATCH /dispatch/:id/cancel (and a dispatch may be
--                     cancelled from `arrived` too). Plain operational text,
--                     NEVER copied into audit metadata (Rule 8); the audit
--                     row records only that a reason exists and its length.
--   override_reason : why an Admin dispatched a Tanod who held no published
--                     shift covering "now" (POST /dispatch, error code
--                     NO_PUBLISHED_SHIFT unless this is supplied). Same
--                     audit rule as above.
--
-- Both NULL for every existing row and for every dispatch that needed
-- neither. New migration (Rule 9). Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================================
SET NAMES utf8mb4;

ALTER TABLE dispatch
  ADD COLUMN IF NOT EXISTS cancel_reason   VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS override_reason VARCHAR(255) NULL;
