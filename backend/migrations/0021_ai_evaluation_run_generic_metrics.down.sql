-- Rollback for 0021_ai_evaluation_run_generic_metrics.sql.
--
-- Drops the four generic metric columns; precision_score/recall_score and
-- everything else on the table are untouched. Any non-redaction/
-- extraction evaluation numbers already recorded in metric_a/b are lost
-- after this runs (same cost note every prior migration's rollback gives).

ALTER TABLE ai_evaluation_run
  DROP COLUMN IF EXISTS metric_a_name,
  DROP COLUMN IF EXISTS metric_a_value,
  DROP COLUMN IF EXISTS metric_b_name,
  DROP COLUMN IF EXISTS metric_b_value;
