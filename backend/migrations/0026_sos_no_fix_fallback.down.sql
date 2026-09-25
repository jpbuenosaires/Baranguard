-- Rollback for 0026_sos_no_fix_fallback.sql.
-- NOTE: rolling back after any 'last_known'/'no_fix' row has been written
-- will fail the NOT NULL restore below until those rows are backfilled or
-- removed — same caveat as any nullability tightening.
ALTER TABLE tanod_sos DROP COLUMN location_recorded_at;
ALTER TABLE tanod_sos DROP COLUMN location_source;

ALTER TABLE tanod_sos
  MODIFY COLUMN latitude DECIMAL(10,7) NOT NULL,
  MODIFY COLUMN longitude DECIMAL(10,7) NOT NULL;
