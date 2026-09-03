-- Baranguard — Sprint 6 (blotter finalization + amendment) schema
-- addition, added as a NEW migration rather than editing the completed
-- 0001 baseline, per this project's own convention.
--
-- Source of truth gap this resolves: Master Reference §6's
-- `POST /incidents/:id/blotter/amend` says an amendment "creates an
-- audited revision, increments revision_no, and never deletes the
-- previous finalized value" — but §5's `blotter_record` has a SINGLE
-- `narrative_summary` column, so an amendment necessarily overwrites it.
-- The previous finalized text had nowhere to live, which made the "never
-- deletes" guarantee impossible to honour as written.
--
-- Two options were considered (see DEVLOG.md's Sprint 6 entry):
--   (a) store the superseded text in `audit_log.metadata_json` — cheaper,
--       but §2 Rule 17 allow-lists audit metadata to "identifiers and
--       statuses only", and it makes revision history awkward to query;
--   (b) a dedicated revision table — chosen here.
--
-- Each row is one SUPERSEDED version of a blotter record: the amendment
-- endpoint copies the current `narrative_summary`/`revision_no` into this
-- table BEFORE overwriting them, so `blotter_record` always holds the
-- current text and this table holds every prior one. Revision 1 (the
-- original finalization) therefore appears here only once it has been
-- amended at least once, which is the correct semantics — nothing is
-- superseded until something supersedes it.
--
-- `ON DELETE RESTRICT` matches every other blotter-adjacent foreign key in
-- 0001: a finalized blotter record is a legal record (§11 gives it a
-- seven-year retention), so its history must not cascade away.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS blotter_revision (
  revision_id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  blotter_id        BIGINT UNSIGNED NOT NULL,
  revision_no       INT UNSIGNED NOT NULL,
  narrative_summary TEXT NOT NULL,
  reason            VARCHAR(1000) NULL,
  amended_by        BIGINT UNSIGNED NULL,
  superseded_at     DATETIME NOT NULL,
  UNIQUE KEY uq_blotter_revision (blotter_id, revision_no),
  KEY idx_blotter_revision_blotter (blotter_id, revision_no),
  CONSTRAINT fk_blotter_revision_blotter FOREIGN KEY (blotter_id)
    REFERENCES blotter_record(blotter_id) ON DELETE RESTRICT,
  CONSTRAINT fk_blotter_revision_user FOREIGN KEY (amended_by)
    REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
