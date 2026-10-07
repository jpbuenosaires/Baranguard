-- Rollback for 0037_paper_approvals_and_scans.sql. Drops every document_scan
-- ROW (the files under SCANS_DIR are NOT deleted -- remove them by hand) and
-- the paper-signature columns. Back up first.
DROP TABLE IF EXISTS document_scan;

ALTER TABLE ssz_term_report DROP FOREIGN KEY IF EXISTS fk_ssz_report_paper_recorded_by;
ALTER TABLE ssz_term_report
  DROP COLUMN IF EXISTS paper_recorded_at,
  DROP COLUMN IF EXISTS paper_recorded_by,
  DROP COLUMN IF EXISTS paper_signed_on,
  DROP COLUMN IF EXISTS approval_mode;

ALTER TABLE accomplishment_report DROP FOREIGN KEY IF EXISTS fk_accrep_paper_recorded_by;
ALTER TABLE accomplishment_report
  DROP COLUMN IF EXISTS paper_recorded_at,
  DROP COLUMN IF EXISTS paper_recorded_by,
  DROP COLUMN IF EXISTS paper_signed_on,
  DROP COLUMN IF EXISTS approval_mode;
