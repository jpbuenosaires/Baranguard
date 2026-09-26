-- Rollback for 0028_remove_ai_tools_screen.sql — restores 0015's AI
-- Tools columns/index/foreign keys and widens task_type back to include
-- 'classification'. Mirrors 0015_ai_tools.sql exactly; does not restore
-- 'blotter_assist'/'sms_compose'/'threat_analysis' — that's 0027's own
-- rollback's job, applied separately if ever needed.
--
-- NOTE: `incident_id NOT NULL` -> nullable is always safe (widening).
-- `task_type` -> wider ENUM is always safe (widening). Neither statement
-- below can fail on existing data.

ALTER TABLE ai_processing_log
  MODIFY COLUMN incident_id BIGINT UNSIGNED NULL;

ALTER TABLE ai_processing_log
  ADD COLUMN IF NOT EXISTS barangay_id SMALLINT UNSIGNED NULL AFTER incident_id,
  ADD COLUMN IF NOT EXISTS requested_by_user_id BIGINT UNSIGNED NULL AFTER barangay_id,
  ADD COLUMN IF NOT EXISTS tool_input TEXT NULL,
  ADD COLUMN IF NOT EXISTS tool_output TEXT NULL;

ALTER TABLE ai_processing_log
  MODIFY COLUMN task_type ENUM('summarization','redaction','translation','extraction','classification') NOT NULL;

ALTER TABLE ai_processing_log
  ADD INDEX IF NOT EXISTS idx_ai_log_barangay_task_created (barangay_id, task_type, created_at);

ALTER TABLE ai_processing_log
  ADD CONSTRAINT fk_ai_log_barangay FOREIGN KEY IF NOT EXISTS (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT;

ALTER TABLE ai_processing_log
  ADD CONSTRAINT fk_ai_log_requested_by FOREIGN KEY IF NOT EXISTS (requested_by_user_id)
    REFERENCES user(user_id) ON DELETE SET NULL;
