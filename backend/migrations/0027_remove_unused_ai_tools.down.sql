-- Rollback for 0027_remove_unused_ai_tools.sql — widens task_type back to
-- the original four AI Tools values. No guard needed this direction:
-- widening an ENUM can't strand any existing row.

ALTER TABLE ai_processing_log
  MODIFY COLUMN task_type ENUM(
    'summarization','redaction','translation','extraction',
    'blotter_assist','classification','sms_compose','threat_analysis'
  ) NOT NULL;
