-- ============================================================
-- 0030_approval_authority_and_roster.sql -- docs/FEATURE_CONTRACT_2026-10.md
-- sections 2 and 3.
--
--   1. `user.official_title` / `user.approval_authority` (who may note/approve
--      a document, independent of role) + the documented backfill.
--   2. `tanod_availability` (a Tanod's declared availability windows).
--   3. `shift_schedule` gains the draft/published lifecycle. Every
--      pre-existing shift is backfilled to 'published' (they were already
--      live rosters), new shifts default to 'draft'.
--
-- Depends only on tables through 0029. Idempotent (IF NOT EXISTS guards). The
-- shift backfill deliberately has NO `UPDATE ... SET approval_status =
-- 'published'` statement: the column is first added with DEFAULT 'published'
-- (so every existing row receives it as part of the ADD COLUMN) and the
-- default is then switched to 'draft' by MODIFY, which touches no rows. A
-- re-run after new draft shifts exist therefore cannot silently publish them.
--
-- New numbered migration, never an edit to a completed one (Rule 9). Not applied
-- to any real database by the session that wrote it.
-- ============================================================

SET NAMES utf8mb4;

-- ---------- 1. approval authority ----------
ALTER TABLE user
  ADD COLUMN IF NOT EXISTS official_title VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS approval_authority
    SET('note_report','approve_report','approve_roster','prepare_annex_d','approve_annex_d')
    NOT NULL DEFAULT '';

-- Backfill (only rows nobody has configured yet, so a re-run never undoes an
-- Admin's later edit): Punong Barangay and Admin accounts.
UPDATE user
   SET official_title = 'Punong Barangay',
       approval_authority = 'note_report,approve_report,approve_roster,approve_annex_d'
 WHERE role = 'punong_barangay' AND official_title IS NULL AND approval_authority = '';

UPDATE user
   SET official_title = 'Chief Tanod',
       approval_authority = 'note_report,prepare_annex_d'
 WHERE role = 'admin' AND official_title IS NULL AND approval_authority = '';

-- ---------- 2. tanod_availability ----------
CREATE TABLE IF NOT EXISTS tanod_availability (
  avail_id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  barangay_id     SMALLINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  windows_json    JSON NOT NULL,
  status          ENUM('submitted','accepted','revised') NOT NULL DEFAULT 'submitted',
  reviewed_by     BIGINT UNSIGNED NULL,
  reviewed_at     DATETIME NULL,
  review_note     VARCHAR(255) NULL,
  version         INT UNSIGNED NOT NULL DEFAULT 1,
  client_event_id CHAR(36) NOT NULL,
  created_at      DATETIME NOT NULL,
  updated_at      DATETIME NULL,
  UNIQUE KEY uq_avail_user_event (user_id, client_event_id),
  UNIQUE KEY uq_avail_user_period (user_id, period_start, period_end),
  KEY idx_avail_barangay_status (barangay_id, status, period_start),
  CONSTRAINT fk_avail_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_avail_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_avail_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 3. shift_schedule draft/published ----------
ALTER TABLE shift_schedule
  ADD COLUMN IF NOT EXISTS approval_status ENUM('draft','published') NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS source_availability_id BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS approved_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;

-- Existing rows now carry 'published'; from here on a new shift starts as a draft.
ALTER TABLE shift_schedule
  MODIFY COLUMN approval_status ENUM('draft','published') NOT NULL DEFAULT 'draft';

ALTER TABLE shift_schedule
  ADD CONSTRAINT fk_shift_source_availability FOREIGN KEY IF NOT EXISTS (source_availability_id)
    REFERENCES tanod_availability(avail_id) ON DELETE RESTRICT;

ALTER TABLE shift_schedule
  ADD CONSTRAINT fk_shift_approved_by FOREIGN KEY IF NOT EXISTS (approved_by)
    REFERENCES user(user_id) ON DELETE RESTRICT;

ALTER TABLE shift_schedule
  ADD INDEX IF NOT EXISTS idx_shift_barangay_approval (barangay_id, approval_status, start_at);
