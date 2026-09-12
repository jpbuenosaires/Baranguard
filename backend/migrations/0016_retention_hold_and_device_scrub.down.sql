-- Rollback for 0016_retention_hold_and_device_scrub.sql.
--
-- Both columns are additive and carry no dependent constraints, so this
-- rolls back cleanly with no ordering hazard and no data that has to be
-- dealt with first (unlike 0015's ENUM narrowing).
--
-- WHAT ROLLING BACK ACTUALLY COSTS, stated plainly rather than left for
-- someone to discover:
--
--   * Dropping `sms_log.legal_hold` DISCARDS any hold placed on a
--     transport record directly. The inherited holds are unaffected —
--     those live on `incident`/`citizen_report` and are re-derived by
--     the retention job on every run — but a hold that was placed on an
--     SMS thread on its own is gone and cannot be recovered from this
--     table.
--
--   * Dropping `mobile_device.secrets_scrubbed_at` DISCARDS the record
--     of which devices were already scrubbed. The scrub itself is not
--     undone (the secrets stay cleared, correctly), but the job loses
--     its idempotency marker, so a subsequent run under the old code
--     would see those rows as eligible again. Since the old code
--     DELETED the row, rolling back both this migration and the service
--     change re-arms exactly the provenance-destroying behaviour this
--     migration exists to stop — do not roll back only halfway.

ALTER TABLE mobile_device
  DROP COLUMN IF EXISTS secrets_scrubbed_at;

ALTER TABLE sms_log
  DROP INDEX IF EXISTS idx_sms_log_retention;

ALTER TABLE sms_log
  DROP COLUMN IF EXISTS legal_hold;
