-- ============================================================
-- 0019_audit_log_idempotency_index.sql — indexes the idempotency-key
-- replay lookup pattern first introduced by F5 (`PATCH /incidents/:id`,
-- closed 2026-09-12) and reused as-is by `SmsController::broadcast()`
-- (docs/REMAINING.md §F9's last open item).
--
-- Both endpoints replay idempotency off `audit_log.metadata_json`'s JSON
-- field — an UPDATE/fan-out action has no natural unique column to
-- dedupe on the way a CREATE dedupes on `client_event_id` — and both
-- match it with `JSON_UNQUOTE(JSON_EXTRACT(metadata_json,
-- '$.idempotency_key'))` in the WHERE clause. `audit_log` is append-only
-- and grows without bound, so that expression runs a full scan of every
-- row matching (barangay_id, action) on every single call to either
-- endpoint, including the common case where no prior call exists at all.
--
-- Fix: a VIRTUAL generated column that extracts the same value, plus an
-- index on it. MariaDB 10.4 (this stack's target) does not rewrite a
-- bare JSON_EXTRACT() expression in a WHERE clause to use an index on a
-- generated column with a matching expression the way MySQL 8's
-- functional indexes do — the query has to reference the generated
-- column directly, which is why SmsController.php's query changes
-- alongside this migration.
--
-- SCOPE: this migration only touches audit_log's schema; only
-- SmsController::broadcast() is updated to use the new column, since
-- that is the specific endpoint docs/REMAINING.md's F9 item named.
-- IncidentsController.php's PATCH idempotency replay (F5) has the
-- identical shape and would benefit the same way — left as a follow-up,
-- not folded into this fix.
--
-- New migration, not an edit to 0001 (§2 Rule 9). Idempotent: every
-- statement is guarded, so re-running is a no-op.
-- ============================================================

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64)
    GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.idempotency_key'))) VIRTUAL;

ALTER TABLE audit_log
  ADD INDEX IF NOT EXISTS idx_audit_log_idempotency (barangay_id, action, idempotency_key);
