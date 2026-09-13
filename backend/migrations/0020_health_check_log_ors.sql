-- ============================================================
-- 0020_health_check_log_ors.sql — routing dependency column.
--
-- Turn-by-turn routing (docs/REMAINING.md §C4) is OpenRouteService
-- (ORS) — a single cloud dependency behind one API key, not a
-- self-hosted process, so this needs exactly one status column.
--
-- Second design on this column in one day, neither ever applied to a
-- real database (only exercised against disposable verification DBs,
-- so each rewrite replaces the prior draft rather than layering a
-- correction on top of it — see OrsClient.php's own doc block for the
-- full architecture history): an abandoned self-hosted-OSRM design
-- would have needed two columns (one per profile, two separate
-- processes); a Google Routes API design was ruled out immediately
-- after because it requires a billing account with a card on file even
-- to stay in the free tier, which this deployment doesn't have.
--
-- Same VARCHAR(16)-not-ENUM reasoning 0017 already gives for every other
-- status column here: the vocabulary comes from a probe, and widening
-- what a probe can say needs no migration under VARCHAR.
--
-- New migration, not an edit to 0017 (§2 Rule 9).
--
-- Idempotent: every statement is guarded, so re-running is a no-op
-- (this repo's standing convention — see 0011/0016 etc.).
-- ============================================================

ALTER TABLE health_check_log
  ADD COLUMN IF NOT EXISTS ors_status VARCHAR(16) NOT NULL DEFAULT 'not_configured' AFTER osrm_status;
