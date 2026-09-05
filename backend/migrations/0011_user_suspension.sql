-- ============================================================
-- 0011_user_suspension.sql — User Management follow-up: a real
-- "Suspended" account state, distinct from "Inactive".
--
-- `user.is_active` today is a plain boolean — Active or Inactive, full
-- stop. A reference mockup showed a third state, "Suspended" (e.g. a
-- disciplinary hold short of full deactivation). This adds that as its
-- own column rather than overloading `is_active`, so "why" is preserved
-- (`suspended_reason`) and the three states stay mutually exclusive and
-- explicit in queries (`is_active=1 AND is_suspended=0` = Active,
-- `is_active=1 AND is_suspended=1` = Suspended, `is_active=0` = Inactive
-- regardless of the suspension flag — deactivating always wins, see
-- UsersController.php for the exact transition rules).
--
-- `suspended_at` follows the same "when did this actually happen"
-- pattern as `finalized_at`/`amended_at`/`cancelled_at` elsewhere in this
-- schema — a real server timestamp, not inferred from `updated_at`.
--
-- AuthController::login() rejects a suspended user with the same
-- generic failure shape the existing inactive-user rejection already
-- uses — no new way to probe account state from the login endpoint.
--
-- New migration, not an edit to 0001 (this repo's standing convention).
--
-- Idempotent: every statement is guarded, so re-running is a no-op.
-- ============================================================

ALTER TABLE user
  ADD COLUMN IF NOT EXISTS is_suspended TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suspended_reason VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS suspended_at DATETIME NULL;
