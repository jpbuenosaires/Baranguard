-- Rollback for 0015_ai_tools.sql.
--
-- NOTE: both trailing statements FAIL while any tool job still exists —
-- restoring `incident_id NOT NULL` cannot succeed with NULL-incident rows
-- present, and narrowing `task_type` cannot succeed with rows on the four
-- new values. Those rows must be dealt with deliberately (delete them
-- first) rather than being silently discarded by the rollback. Left last
-- so the drops above still apply even if they fail — the same pattern
-- 0008's and 0013's rollbacks already use for their ENUM widenings.
--
--   DELETE FROM ai_processing_log WHERE incident_id IS NULL;
--   DELETE FROM ai_processing_log
--    WHERE task_type IN ('blotter_assist','classification','sms_compose','threat_analysis');

ALTER TABLE ai_processing_log
  DROP FOREIGN KEY IF EXISTS fk_ai_log_requested_by;

ALTER TABLE ai_processing_log
  DROP FOREIGN KEY IF EXISTS fk_ai_log_barangay;

ALTER TABLE ai_processing_log
  DROP INDEX IF EXISTS idx_ai_log_barangay_task_created;

ALTER TABLE ai_processing_log
  DROP COLUMN IF EXISTS barangay_id,
  DROP COLUMN IF EXISTS requested_by_user_id,
  DROP COLUMN IF EXISTS tool_input,
  DROP COLUMN IF EXISTS tool_output;

ALTER TABLE ai_processing_log
  MODIFY COLUMN task_type ENUM('summarization','redaction','translation','extraction') NOT NULL;

ALTER TABLE ai_processing_log
  MODIFY COLUMN incident_id BIGINT UNSIGNED NOT NULL;
