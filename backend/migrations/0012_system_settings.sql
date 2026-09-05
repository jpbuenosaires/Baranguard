-- ============================================================
-- 0012_system_settings.sql — new `system_settings` key-value table,
-- backing the Settings screen's expansion from personal-profile-only
-- into a 7-section system configuration page.
--
-- **This is a deliberate, user-authorized override of an existing rule.**
-- `docs/Baranguard_Master_Reference_FINAL .md` §7 / `docs/REFERENCE.md`
-- §7 documents W21 System Settings as: "blocked — no schema/endpoints;
-- needs an architecture review first, and gateway credentials must
-- never live in a settings row." That blocker existed because no review
-- had happened yet, not because storing settings in a table is
-- inherently wrong. The user explicitly reviewed this tradeoff during
-- planning (2026-09-05, see backend/DEVLOG.md's "Full UI/UX overhaul"
-- entry and .claude/plans/fancy-crafting-lark.md) and chose to override
-- it specifically for the SMS Gateway API key/sender ID, accepting that
-- tradeoff. The override does NOT extend past what was explicitly
-- discussed: `DEVICE_SECRET_MASTER_KEY`, `INTERNAL_SERVICE_TOKEN`,
-- `JWT_SECRET`, and `FCM_SERVICE_ACCOUNT_PATH` all stay in `backend/.env`
-- exactly as before — nothing about those changes here. See
-- `SettingsController.php` for the exact key allow-list this table is
-- permitted to hold.
--
-- Plain key-value rather than one column per setting (unlike every other
-- table in this schema) because the set of settings is expected to grow
-- across Settings' 7 sections without a migration per new toggle —
-- `setting_value` is a string (numbers/booleans stored as their string
-- form, parsed by SettingsController against a known schema per key,
-- same "the server owns the shape" principle applied elsewhere in this
-- API rather than trusting an arbitrary JSON blob).
--
-- New migration, not an edit to 0001 (this repo's standing convention).
--
-- Idempotent: every statement is guarded, so re-running is a no-op.
-- ============================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key   VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value TEXT NULL,
  updated_at    DATETIME NOT NULL,
  updated_by    BIGINT UNSIGNED NULL,
  CONSTRAINT fk_system_settings_user FOREIGN KEY (updated_by)
    REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
