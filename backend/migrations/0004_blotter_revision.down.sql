-- Rollback for 0004_blotter_revision.sql.
--
-- WARNING: this discards blotter amendment history permanently. §11 gives
-- blotter records a seven-year retention and §6 requires that an amendment
-- "never deletes the previous finalized value" — so running this against a
-- deployment that has real amendments destroys records the retention
-- policy says must be kept. Intended for development rollback of an
-- unused migration only, never as an operational cleanup step.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS blotter_revision;
