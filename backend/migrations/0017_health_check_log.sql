-- ============================================================
-- 0017_health_check_log.sql — dependency-status history for W20.
--
-- §2 Rule 15 already names the unified workstation as an infrastructure
-- single point of failure, and `GET /system/health` already answers "is
-- it up RIGHT NOW" honestly. What neither does is answer "how often has
-- it NOT been", which is the question that decides whether Rule 15's
-- risk is theoretical or is happening weekly — and the one an operator
-- cannot reconstruct after the fact from a snapshot.
--
-- THIS IS A STATE-CHANGE LOG, NOT A TIME SERIES. A row is written only
-- when the observed dependency states DIFFER from the newest row (plus
-- the very first observation). Rationale:
--
--   * W20 polls `/system/health` on a timer. Writing a row per probe
--     would put thousands of near-identical rows a day into a table
--     nobody would then read, and `audit_log`'s own retention comment
--     already records what that mistake costs.
--   * The useful facts are the transitions — "Ollama went unhealthy at
--     14:02 and came back at 14:31" — and a change log stores exactly
--     those, losslessly, at a tiny fraction of the rows.
--   * It needs no scheduler, which matters because nothing on this
--     system is scheduled yet (`docs/REMAINING.md` C2). History
--     accumulates from real use rather than waiting on a Task Scheduler
--     entry that does not exist.
--
-- HONEST LIMITATION, recorded here rather than discovered later: because
-- samples are taken when the endpoint is CALLED, this history knows only
-- what was observed while someone was looking. A dependency that failed
-- and recovered overnight with nobody on the screen leaves no row. That
-- is a real gap and is deliberately not papered over in the UI — it is
-- also exactly what C2's scheduler wiring would close, by giving the
-- probe a caller that never sleeps.
--
-- Columns mirror `SystemHealthController::index()`'s dependency fields
-- one-for-one. `api` is deliberately NOT stored: that field is the
-- constant 'healthy' (the code returning it is, by definition, running),
-- so a column for it would record nothing.
--
-- VARCHAR(16), not ENUM: these statuses come from a probe whose
-- vocabulary has already widened once (`ollama` gained a real
-- reachability probe in Sprint 5), and widening an ENUM needs a
-- migration while widening this does not. Every writer is server-side
-- and the set is checked in PHP, same enforcement-in-PHP decision 0015
-- made for its own invariant.
--
-- New migration, not an edit to a completed one (§2 Rule 9).
-- Idempotent: both statements are guarded.
-- ============================================================

CREATE TABLE IF NOT EXISTS health_check_log (
  log_id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recorded_at         DATETIME        NOT NULL,
  db_status           VARCHAR(16)     NOT NULL,
  osrm_status         VARCHAR(16)     NOT NULL,
  ollama_status       VARCHAR(16)     NOT NULL,
  gsm_status          VARCHAR(16)     NOT NULL,
  fcm_status          VARCHAR(16)     NOT NULL,
  sms_status          VARCHAR(16)     NOT NULL,
  PRIMARY KEY (log_id),
  -- The only two queries this table has: "newest row" (to compare
  -- against before writing) and "most recent N, newest first" (to
  -- render). Both are served by this one index.
  INDEX idx_health_recorded (recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
