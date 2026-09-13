-- Rollback for 0019_audit_log_idempotency_index.sql.
--
-- Both changes are additive and derived — the generated column carries
-- no independent data of its own, it is recomputed from metadata_json on
-- every read — so this rolls back cleanly with nothing to preserve
-- first. Rolling back also reverts SmsController::broadcast() to a full
-- unindexed JSON_EXTRACT() scan for its idempotency replay lookup; that
-- code change is not undone by this file alone.

ALTER TABLE audit_log
  DROP INDEX IF EXISTS idx_audit_log_idempotency;

ALTER TABLE audit_log
  DROP COLUMN IF EXISTS idempotency_key;
