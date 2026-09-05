-- Rollback for 0008_incident_party_fields.sql.
--
-- NOTE: reverting `ai_processing_log.task_type` will FAIL if any row has
-- already been written with `task_type='extraction'` — that value must
-- be dealt with deliberately (delete or reassign those rows) before this
-- MODIFY can succeed. Left last so the column drops above still apply
-- even if it fails, same pattern 0007's own rollback uses.

ALTER TABLE blotter_revision
  DROP COLUMN IF EXISTS complainant_name,
  DROP COLUMN IF EXISTS respondent_name,
  DROP COLUMN IF EXISTS complainant_contact_number;

ALTER TABLE blotter_record
  DROP COLUMN IF EXISTS complainant_name,
  DROP COLUMN IF EXISTS respondent_name,
  DROP COLUMN IF EXISTS complainant_contact_number;

ALTER TABLE incident
  DROP COLUMN IF EXISTS complainant_name,
  DROP COLUMN IF EXISTS respondent_name,
  DROP COLUMN IF EXISTS complainant_contact_number;

ALTER TABLE ai_processing_log
  DROP COLUMN IF EXISTS draft_complainant_name,
  DROP COLUMN IF EXISTS draft_respondent_name,
  DROP COLUMN IF EXISTS draft_complainant_contact_number;

ALTER TABLE ai_processing_log
  MODIFY COLUMN task_type ENUM('summarization','redaction','translation') NOT NULL;
