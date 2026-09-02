-- Baranguard — Sprint 1 continued (W11/W12/W13 Scheduler + Fatigue) schema
-- change, added as a NEW migration rather than editing the completed 0001
-- baseline, per this project's own convention.
--
-- Source of truth conflict this resolves: Master Reference §5 originally
-- fixed `shift_schedule.user_id` as NOT NULL, but §6's
-- `PATCH /shift-swap-requests/:id` explicitly documents that "an approved
-- open request without target marks requester released but leaves the
-- shift unassigned and visible in W11" — a NOT NULL user_id cannot
-- represent "unassigned" at all. Resolved (user's explicit decision,
-- logged in DEVLOG.md): make the column nullable so an unassigned shift
-- is a real, queryable state, not a workaround.
--
-- Safe to re-run against a schema that already has this applied — MODIFY
-- COLUMN is idempotent in effect (repeating it is a no-op change).

SET NAMES utf8mb4;

ALTER TABLE shift_schedule MODIFY COLUMN user_id BIGINT UNSIGNED NULL;
