-- ============================================================
-- 0027_remove_unused_ai_tools.sql — narrows the AI Tools screen from
-- four assistants (0015) to one: the Incident Classifier.
--
-- REMOVED: blotter_assist, sms_compose, threat_analysis.
--   * blotter_assist drafted a copy-paste entry for DILG BIMSS/KPIS — a
--     system §1 says Baranguard "may never be positioned as replacing",
--     which this tool was in real tension with by duplicating a BIMSS
--     records function.
--   * sms_compose and threat_analysis were low-usage helper tools not
--     tied to the statutory redaction pipeline (which is Baranguard's
--     actual legal reason to exist alongside BIMSS — see docs/REFERENCE.md
--     §1). `threat_analysis` in particular had zero real jobs ever
--     queued as of this decision.
-- KEPT: classification — used in routine Admin+Secretary incident
-- triage, reads only the already-approved redacted narrative.
--
-- Guarded rather than a bare MODIFY COLUMN: narrowing an ENUM against a
-- row that still holds a removed value truncates it to '' silently on
-- MariaDB's default sql_mode, which would corrupt real data rather than
-- fail loudly. Refusing up front (matching bootstrap-db.sh's own
-- "refuse rather than risk touching real data" convention) is safer than
-- a migration that might not be re-run carefully. The guard is a
-- throwaway stored procedure (SIGNAL is only usable inside one) — applied
-- via the `mysql` CLI client per bootstrap-db.sh, which supports DELIMITER.
--
-- New migration, not an edit to 0015 (§2 Rule 9 — migrations are
-- append-only history, never rewritten after the fact).
-- ============================================================

DELIMITER $$

CREATE PROCEDURE _0027_refuse_if_removed_task_types_in_use()
BEGIN
  DECLARE row_count INT;
  SELECT COUNT(*) INTO row_count FROM ai_processing_log
   WHERE task_type IN ('blotter_assist', 'sms_compose', 'threat_analysis');
  IF row_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Refusing: ai_processing_log has rows using a task_type this migration removes.';
  END IF;
END$$

DELIMITER ;

CALL _0027_refuse_if_removed_task_types_in_use();
DROP PROCEDURE _0027_refuse_if_removed_task_types_in_use;

ALTER TABLE ai_processing_log
  MODIFY COLUMN task_type ENUM(
    'summarization','redaction','translation','extraction','classification'
  ) NOT NULL;
