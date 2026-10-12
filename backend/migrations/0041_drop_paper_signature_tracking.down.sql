-- Rollback for 0041_drop_paper_signature_tracking.sql. Recreates the dropped
-- columns, enum values and the (empty) document_scan table. The previous
-- noted/approved statuses, signers and scans are NOT restored. Back up first.
SET NAMES utf8mb4;

ALTER TABLE accomplishment_report
  MODIFY COLUMN status ENUM('open','prepared','noted','approved','returned') NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS noted_by BIGINT UNSIGNED NULL AFTER prepared_at,
  ADD COLUMN IF NOT EXISTS noted_at DATETIME NULL AFTER noted_by,
  ADD COLUMN IF NOT EXISTS approved_by BIGINT UNSIGNED NULL AFTER noted_at,
  ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL AFTER approved_by,
  ADD COLUMN IF NOT EXISTS approval_mode ENUM('digital','recorded_from_paper') NOT NULL DEFAULT 'digital',
  ADD COLUMN IF NOT EXISTS paper_signed_on DATE NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_at DATETIME NULL;

ALTER TABLE accomplishment_report
  ADD CONSTRAINT fk_accrep_noted_by FOREIGN KEY IF NOT EXISTS (noted_by) REFERENCES user(user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_accrep_approved_by FOREIGN KEY IF NOT EXISTS (approved_by) REFERENCES user(user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_accrep_paper_recorded_by FOREIGN KEY IF NOT EXISTS (paper_recorded_by) REFERENCES user(user_id) ON DELETE SET NULL;

ALTER TABLE ssz_term_report
  MODIFY COLUMN status ENUM('draft','prepared','approved','submitted') NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS approved_by BIGINT UNSIGNED NULL AFTER prepared_at,
  ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL AFTER approved_by,
  ADD COLUMN IF NOT EXISTS approval_mode ENUM('digital','recorded_from_paper') NOT NULL DEFAULT 'digital',
  ADD COLUMN IF NOT EXISTS paper_signed_on DATE NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_at DATETIME NULL;

ALTER TABLE ssz_term_report
  ADD CONSTRAINT fk_ssz_report_approved_by FOREIGN KEY IF NOT EXISTS (approved_by) REFERENCES user(user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_ssz_report_paper_recorded_by FOREIGN KEY IF NOT EXISTS (paper_recorded_by) REFERENCES user(user_id) ON DELETE SET NULL;

ALTER TABLE shift_schedule
  ADD COLUMN IF NOT EXISTS approval_mode ENUM('digital','recorded_from_paper') NOT NULL DEFAULT 'digital',
  ADD COLUMN IF NOT EXISTS paper_signed_on DATE NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_at DATETIME NULL;

ALTER TABLE shift_schedule
  ADD CONSTRAINT fk_shift_paper_recorded_by FOREIGN KEY IF NOT EXISTS (paper_recorded_by)
    REFERENCES user(user_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS document_scan (
  scan_id      BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  barangay_id  SMALLINT UNSIGNED NOT NULL,
  entity_type  ENUM('accomplishment_report','ssz_term_report') NOT NULL,
  entity_id    BIGINT UNSIGNED   NOT NULL,
  stored_path  VARCHAR(255)      NOT NULL,
  mime_type    VARCHAR(100)      NOT NULL,
  size_bytes   INT UNSIGNED      NOT NULL,
  sha256       CHAR(64)          NOT NULL,
  uploaded_by  BIGINT UNSIGNED   NOT NULL,
  uploaded_at  DATETIME          NOT NULL,
  PRIMARY KEY (scan_id),
  UNIQUE KEY uq_document_scan_entity_sha (entity_type, entity_id, sha256),
  KEY idx_document_scan_entity (entity_type, entity_id),
  KEY idx_document_scan_barangay (barangay_id),
  CONSTRAINT fk_document_scan_barangay FOREIGN KEY (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_document_scan_uploaded_by FOREIGN KEY (uploaded_by)
    REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
