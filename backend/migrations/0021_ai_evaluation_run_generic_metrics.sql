-- ============================================================
-- 0021_ai_evaluation_run_generic_metrics.sql — generic metric columns
-- for ai_evaluation_run.
--
-- docs/REMAINING.md A6 (2026-09-14): the model backs 8 prompt types, but
-- ai_evaluation_run (0001) only ever had precision_score/recall_score --
-- a shape that fits redaction (and extraction, which is genuinely
-- precision/recall over planted fields) but not the other 6 tasks:
-- classification is accuracy-shaped, summary/blotter-assist/sms-compose/
-- threat-analysis are constraint-compliance-rate-shaped, and translation
-- is a human-rated average. Overloading precision_score/recall_score for
-- those would make a stored number mean something different per row
-- without saying so.
--
-- Two generic, self-describing columns instead of a single JSON blob:
-- keeps the common "what's the headline number" query
-- (`ORDER BY metric_a_value`) doable in plain SQL, and a NAME column next
-- to each VALUE means a row never needs its task_type looked up
-- elsewhere just to know what the number in it means.
-- precision_score/recall_score are UNTOUCHED -- redaction and extraction
-- keep writing those exactly as before; metric_a/b are for the other
-- six task_types only.
--
-- New migration, not an edit to 0001 (§2 Rule 9).
--
-- Idempotent: every statement is guarded, so re-running is a no-op
-- (this repo's standing convention -- see 0011/0016/0020 etc.). Verified
-- against a disposable MariaDB 10.4 first, same as every prior migration,
-- before the real databases.
-- ============================================================

ALTER TABLE ai_evaluation_run
  ADD COLUMN IF NOT EXISTS metric_a_name VARCHAR(32) NULL AFTER recall_score,
  ADD COLUMN IF NOT EXISTS metric_a_value DECIMAL(8,5) NULL AFTER metric_a_name,
  ADD COLUMN IF NOT EXISTS metric_b_name VARCHAR(32) NULL AFTER metric_a_value,
  ADD COLUMN IF NOT EXISTS metric_b_value DECIMAL(8,5) NULL AFTER metric_b_name;
