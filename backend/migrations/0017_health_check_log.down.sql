-- Rollback for 0017_health_check_log.sql.
--
-- Drops the table and every observation in it. Nothing else references
-- it — no foreign keys point at `health_check_log` and nothing points
-- out of it — so this is a clean drop with no ordering hazard.
--
-- WHAT ROLLING BACK COSTS: the dependency-outage history is not
-- reconstructible. It is a record of things observed at moments that
-- have passed; unlike every other table here, re-running the system
-- does not regenerate it. Export it first if the outage record matters.

DROP TABLE IF EXISTS health_check_log;
