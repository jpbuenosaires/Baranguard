-- ============================================================
-- 0031_accomplishment_reports.sql -- docs/FEATURE_CONTRACT_2026-10.md section 4.
--
-- `accomplishment_report` (one per Tanod per month, carries the
-- open -> prepared -> noted -> approved / returned state machine) and
-- `accomplishment_entry` (the Tanod's own dated accomplishment lines, with the
-- confirmed duration and the server-suggested duration derived from the
-- existing `duty_status` rows).
--
-- Depends only on tables through 0029 (barangay, user). Idempotent. Not applied
-- to any real database by the session that wrote it. No retention rule is
-- defined for these tables: retention is an open policy decision (contract
-- section 11, Rule 10).
-- ============================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS accomplishment_report (
  report_id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  barangay_id             SMALLINT UNSIGNED NOT NULL,
  user_id                 BIGINT UNSIGNED NOT NULL,
  month                   CHAR(7) NOT NULL,
  status                  ENUM('open','prepared','noted','approved','returned') NOT NULL DEFAULT 'open',
  prepared_at             DATETIME NULL,
  noted_by                BIGINT UNSIGNED NULL,
  noted_at                DATETIME NULL,
  approved_by             BIGINT UNSIGNED NULL,
  approved_at             DATETIME NULL,
  return_reason           VARCHAR(255) NULL,
  total_minutes_confirmed INT UNSIGNED NULL,
  version                 INT UNSIGNED NOT NULL DEFAULT 1,
  created_at              DATETIME NOT NULL,
  updated_at              DATETIME NULL,
  UNIQUE KEY uq_accrep_user_month (user_id, month),
  KEY idx_accrep_barangay_month_status (barangay_id, month, status),
  CONSTRAINT fk_accrep_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_accrep_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_accrep_noted_by FOREIGN KEY (noted_by) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_accrep_approved_by FOREIGN KEY (approved_by) REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS accomplishment_entry (
  entry_id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  report_id                   BIGINT UNSIGNED NOT NULL,
  barangay_id                 SMALLINT UNSIGNED NOT NULL,
  user_id                     BIGINT UNSIGNED NOT NULL,
  work_date                   DATE NOT NULL,
  accomplishment_text         TEXT NOT NULL,
  start_time                  TIME NULL,
  end_time                    TIME NULL,
  duration_minutes            INT UNSIGNED NOT NULL,
  suggested_duration_minutes  INT UNSIGNED NULL,
  duration_flag               TINYINT(1) NOT NULL DEFAULT 0,
  client_event_id             CHAR(36) NOT NULL,
  created_at                  DATETIME NOT NULL,
  updated_at                  DATETIME NULL,
  UNIQUE KEY uq_accentry_user_event (user_id, client_event_id),
  KEY idx_accentry_report_date (report_id, work_date),
  KEY idx_accentry_user_date (user_id, work_date),
  CONSTRAINT fk_accentry_report FOREIGN KEY (report_id) REFERENCES accomplishment_report(report_id) ON DELETE RESTRICT,
  CONSTRAINT fk_accentry_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_accentry_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- sync ledger ----------
-- docs/FEATURE_CONTRACT_2026-10.md section 6 wired four new payload groups into
-- POST /sync/batch, whose idempotency ledger (`offline_queue`) records the group
-- name in `payload_type`. That ENUM (0001) only knew the original five, so every
-- new group would fail its very first INSERT. Extending it needs a migration and
-- the contract assigned none: it is done here, once, for all four kinds
-- (referral / school_checkin included, so the sync path works whichever of
-- 0030-0033 a machine has applied). Re-running the full list is a no-op.
ALTER TABLE offline_queue
  MODIFY COLUMN payload_type
    ENUM('incident','gps','duty_status','sos','dispatch_status',
         'referral','availability','accomplishment_entry','school_checkin') NOT NULL;
