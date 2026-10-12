-- ============================================================
-- 0041_drop_paper_signature_tracking.sql -- product decision 2026-10-12:
-- every report and roster is printed and signed on paper, so the app no
-- longer tracks signatures or approvals at all ("just printed, drop").
--
--   * accomplishment_report.status  open | prepared | returned
--     (`noted` and `approved` rows become `prepared`).
--   * ssz_term_report.status        draft | prepared | submitted
--     (`approved` rows become `prepared`).
--   * Dropped: noted_by/noted_at/approved_by/approved_at/approval_mode/
--     paper_* on accomplishment_report; approved_by/approved_at/
--     approval_mode/paper_* on ssz_term_report; approval_mode/paper_* on
--     shift_schedule (its approved_by/approved_at stay: they record who
--     published the roster).
--   * Dropped: document_scan (rows only; files under SCANS_DIR stay on disk).
--
-- New numbered migration (Rule 9). Idempotent (IF EXISTS everywhere; the
-- UPDATEs match nothing on a second run). The .down.sql recreates the
-- structures empty; the previous statuses and signatures are not restored.
-- ============================================================

SET NAMES utf8mb4;

DROP TABLE IF EXISTS document_scan;

-- accomplishment_report -------------------------------------------------
UPDATE accomplishment_report SET status = 'prepared' WHERE status IN ('noted','approved');

ALTER TABLE accomplishment_report
  MODIFY COLUMN status ENUM('open','prepared','returned') NOT NULL DEFAULT 'open';

ALTER TABLE accomplishment_report DROP FOREIGN KEY IF EXISTS fk_accrep_noted_by;
ALTER TABLE accomplishment_report DROP FOREIGN KEY IF EXISTS fk_accrep_approved_by;
ALTER TABLE accomplishment_report DROP FOREIGN KEY IF EXISTS fk_accrep_paper_recorded_by;
ALTER TABLE accomplishment_report
  DROP COLUMN IF EXISTS noted_by,
  DROP COLUMN IF EXISTS noted_at,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approval_mode,
  DROP COLUMN IF EXISTS paper_signed_on,
  DROP COLUMN IF EXISTS paper_recorded_by,
  DROP COLUMN IF EXISTS paper_recorded_at;

-- ssz_term_report -------------------------------------------------------
UPDATE ssz_term_report SET status = 'prepared' WHERE status = 'approved';

ALTER TABLE ssz_term_report
  MODIFY COLUMN status ENUM('draft','prepared','submitted') NOT NULL DEFAULT 'draft';

ALTER TABLE ssz_term_report DROP FOREIGN KEY IF EXISTS fk_ssz_report_approved_by;
ALTER TABLE ssz_term_report DROP FOREIGN KEY IF EXISTS fk_ssz_report_paper_recorded_by;
ALTER TABLE ssz_term_report
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approval_mode,
  DROP COLUMN IF EXISTS paper_signed_on,
  DROP COLUMN IF EXISTS paper_recorded_by,
  DROP COLUMN IF EXISTS paper_recorded_at;

-- shift_schedule --------------------------------------------------------
ALTER TABLE shift_schedule DROP FOREIGN KEY IF EXISTS fk_shift_paper_recorded_by;
ALTER TABLE shift_schedule
  DROP COLUMN IF EXISTS approval_mode,
  DROP COLUMN IF EXISTS paper_signed_on,
  DROP COLUMN IF EXISTS paper_recorded_by,
  DROP COLUMN IF EXISTS paper_recorded_at;
