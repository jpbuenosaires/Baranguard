-- ============================================================
-- 0037_paper_approvals_and_scans.sql -- paper-signature tracking for
-- accomplishment reports and Annex D term reports, plus the document-scan
-- store that holds the photographed/scanned signed paper (Wave 1 review
-- decisions, agent C).
--
-- Barangays sign these reports on paper; Baranguard stays the working copy
-- and the system of record for WHO approved WHAT and WHEN, never the legal
-- original. So:
--
--   * `approval_mode`      'digital' (an approver clicked Approve) or
--                          'recorded_from_paper' (an Admin/Secretary recorded
--                          an approval that really happened on paper).
--   * `paper_signed_on`    the date written on the signed paper; NULL until
--                          somebody records it. An approved report with this
--                          still NULL is "paper pending" (computed in PHP,
--                          not stored).
--   * `paper_recorded_by/at` who recorded it and when (UTC).
--   * `document_scan`      one row per uploaded scan (PDF/JPEG/PNG, <= 10 MB,
--                          verified by magic bytes). The file lives outside
--                          the web root (SCANS_DIR, default
--                          backend/storage/scans); `stored_path` is a
--                          server-side relative filename and is NEVER
--                          returned by the API. No original filename is
--                          stored (it could carry a name). `entity_id` is
--                          polymorphic (accomplishment_report.report_id or
--                          ssz_term_report.report_id), so it carries no FK;
--                          the controller validates it. UNIQUE
--                          (entity_type, entity_id, sha256) de-duplicates a
--                          re-upload of identical bytes.
--
-- A scan lives as long as its parent report: there is NO separate purge job
-- and NO retention rule for scans or these reports yet (Rule 10, open policy
-- decision -- see HANDOFF).
--
-- New numbered migration (Rule 9). Idempotent (IF NOT EXISTS everywhere);
-- existing 0030-0033 rows keep approval_mode 'digital' and paper_signed_on NULL.
-- ============================================================

SET NAMES utf8mb4;

ALTER TABLE accomplishment_report
  ADD COLUMN IF NOT EXISTS approval_mode ENUM('digital','recorded_from_paper') NOT NULL DEFAULT 'digital',
  ADD COLUMN IF NOT EXISTS paper_signed_on DATE NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_at DATETIME NULL;

ALTER TABLE accomplishment_report
  ADD CONSTRAINT fk_accrep_paper_recorded_by FOREIGN KEY IF NOT EXISTS (paper_recorded_by)
    REFERENCES user(user_id) ON DELETE SET NULL;

ALTER TABLE ssz_term_report
  ADD COLUMN IF NOT EXISTS approval_mode ENUM('digital','recorded_from_paper') NOT NULL DEFAULT 'digital',
  ADD COLUMN IF NOT EXISTS paper_signed_on DATE NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_at DATETIME NULL;

ALTER TABLE ssz_term_report
  ADD CONSTRAINT fk_ssz_report_paper_recorded_by FOREIGN KEY IF NOT EXISTS (paper_recorded_by)
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
