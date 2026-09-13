-- Rollback for 0020_health_check_log_ors.sql.
--
-- Drops the routing status column; `osrm_status` (0017) and everything
-- else on the table are untouched. Same cost note 0017's own rollback
-- gives: the routing-dependency detail in already-recorded rows is not
-- reconstructible after this runs.

ALTER TABLE health_check_log
  DROP COLUMN IF EXISTS ors_status;
