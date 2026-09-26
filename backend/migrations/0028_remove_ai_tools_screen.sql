-- ============================================================
-- 0028_remove_ai_tools_screen.sql — removes the AI Tools screen
-- entirely. `classification` (the last survivor of 0015's four
-- assistants, after 0027 removed the other three) was retired following
-- a real runaway-generation failure on this workstation: the model blew
-- past the 4096-token context window and hit the 300s timeout on a
-- classification job, which was enough to call it unreliable rather than
-- keep it around for one remaining use case.
--
-- With zero tool types left, 0015's own columns/index/foreign keys have
-- nothing left to serve — no code path can ever produce a NULL-`incident_id`
-- row or a `tool_input`/`tool_output` value any more (AiToolsController.php
-- and routes/ai-tools.php were deleted outright, not just narrowed). This
-- undoes 0015 in full, matching what 0015_ai_tools.down.sql already
-- documents as the correct order, and additionally narrows `task_type`
-- past 0027's already-narrower enum.
--
-- Same guard pattern 0027 uses: refuse rather than silently corrupt real
-- data if a row still needs what's being dropped.
-- ============================================================

DELIMITER $$

CREATE PROCEDURE _0028_refuse_if_classification_or_null_incident_in_use()
BEGIN
  DECLARE row_count INT;
  SELECT COUNT(*) INTO row_count FROM ai_processing_log
   WHERE task_type = 'classification' OR incident_id IS NULL;
  IF row_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Refusing: ai_processing_log has a classification row or a NULL-incident row this migration cannot preserve.';
  END IF;
END$$

DELIMITER ;

CALL _0028_refuse_if_classification_or_null_incident_in_use();
DROP PROCEDURE _0028_refuse_if_classification_or_null_incident_in_use;

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
