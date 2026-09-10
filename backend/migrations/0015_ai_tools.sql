-- ============================================================
-- 0015_ai_tools.sql — the AI Tools screen's four assistants.
--
-- Two of the four tools are NOT incident-scoped:
--   * SMS Composer   — drafts alert text from an operator-typed prompt
--   * Threat Analyzer — reads aggregate incident counts, not one case
-- and `ai_processing_log.incident_id` has been NOT NULL since 0001. That
-- column is how every existing AI job inherits its tenant, so a job with
-- no incident had neither a parent nor a barangay — unscopeable, and §2
-- Rule 2 requires every endpoint to verify tenant server-side.
--
-- Hence: `incident_id` becomes nullable, and `barangay_id` +
-- `requested_by_user_id` are added so a tool job carries its own tenant
-- and requester.
--
-- THE INVARIANT ("an incident task has incident_id; a tool task has
-- barangay_id") IS ENFORCED IN PHP, NOT AS A TABLE CHECK. §5 already
-- records that a table-level CHECK on `notification`'s entity matrix
-- fails with ERROR 1901 on MariaDB 10.4 — the same engine limit applies
-- here, so this repeats that resolved decision rather than rediscovering
-- it. See AiJobQueue::enqueueToolJob().
--
-- RETENTION: tool jobs are unreachable from the incident purge
-- (`RetentionService::purgeAiProcessingLogs()` INNER JOINs `incident`),
-- so they get their own 90-day window — `AI_TOOL_JOB_DAYS`, matching the
-- existing `DEVICE_DEACTIVATED_DAYS`. That number was signed off
-- explicitly (§2 Rule 10 makes retention windows an architecture
-- decision, not a runbook edit), 2026-09-10.
--
-- Nullable `incident_id` does NOT disturb the ordered cascade in
-- `purgeOneIncident()`: FK RESTRICT still applies to every non-null
-- value, so incident-scoped rows behave exactly as before.
--
-- New migration, not an edit to 0001/0008 (this repo's standing
-- convention — §2 Rule 9).
--
-- Idempotent: columns/indexes/constraints are guarded, and the two
-- MODIFY COLUMN statements are naturally idempotent against an identical
-- target, same as 0008's and 0013's ENUM widenings.
-- ============================================================

ALTER TABLE ai_processing_log
  MODIFY COLUMN incident_id BIGINT UNSIGNED NULL;

ALTER TABLE ai_processing_log
  ADD COLUMN IF NOT EXISTS barangay_id SMALLINT UNSIGNED NULL AFTER incident_id,
  ADD COLUMN IF NOT EXISTS requested_by_user_id BIGINT UNSIGNED NULL AFTER barangay_id,
  ADD COLUMN IF NOT EXISTS tool_input TEXT NULL,
  ADD COLUMN IF NOT EXISTS tool_output TEXT NULL;

ALTER TABLE ai_processing_log
  MODIFY COLUMN task_type ENUM(
    'summarization','redaction','translation','extraction',
    'blotter_assist','classification','sms_compose','threat_analysis'
  ) NOT NULL;

-- Tool jobs are listed per barangay and aged out on their own clock;
-- both queries filter on these.
ALTER TABLE ai_processing_log
  ADD INDEX IF NOT EXISTS idx_ai_log_barangay_task_created (barangay_id, task_type, created_at);

ALTER TABLE ai_processing_log
  ADD CONSTRAINT fk_ai_log_barangay FOREIGN KEY IF NOT EXISTS (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT;

-- SET NULL, not RESTRICT: a tool job outliving the account that ran it is
-- fine (the audit_log row keeps the actor), and RESTRICT here would block
-- deleting any user who had ever used an AI tool.
ALTER TABLE ai_processing_log
  ADD CONSTRAINT fk_ai_log_requested_by FOREIGN KEY IF NOT EXISTS (requested_by_user_id)
    REFERENCES user(user_id) ON DELETE SET NULL;
