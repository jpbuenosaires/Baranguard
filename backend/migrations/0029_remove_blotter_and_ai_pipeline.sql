-- ============================================================
-- 0029_remove_blotter_and_ai_pipeline.sql — removes the Electronic
-- Blotter and the whole local-AI pipeline.
--
-- Why: barangays are directed to keep the Katarungang Pambarangay /
-- blotter record in their own binders (and DILG BIMSS/KPIS is the
-- mandated case ledger, REFERENCE.md §1). Baranguard no longer finalizes,
-- amends or exports blotter entries, and with no blotter to feed there is
-- no redaction/summary/translation/extraction pipeline left to run.
--
-- DESTRUCTIVE AND NOT REVERSIBLE FROM DATA: this DROPs every row in
-- blotter_revision, blotter_record, ai_processing_log and
-- ai_evaluation_run. Take a backup first (`backend/scripts/backup.sh`)
-- and apply as DBA/root — baranguard_app has no DROP (REFERENCE.md §8).
--
-- What is deliberately KEPT:
--   * incident.raw_narrative, redacted_narrative, redaction_approved_at/
--     by, raw_narrative_purged_at, and the party fields from 0008 — they
--     are plain incident columns and RetentionService still reads
--     raw_narrative_purged_at/redaction_approved_at. Nothing writes
--     redacted_narrative or redaction_approved_* any more.
--   * health_check_log.ollama_status — historical rows; new rows write
--     the literal 'not_configured' (the column is NOT NULL).
--   * audit_log rows mentioning blotter/AI actions (write-once).
-- ============================================================

-- RESTRICT FK chain, innermost first.
DROP TABLE IF EXISTS blotter_revision;
DROP TABLE IF EXISTS blotter_record;
DROP TABLE IF EXISTS ai_processing_log;
DROP TABLE IF EXISTS ai_evaluation_run;
