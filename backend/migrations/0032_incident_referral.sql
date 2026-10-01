-- ============================================================
-- 0032_incident_referral.sql — "Delegated to" referral log
-- (docs/FEATURE_CONTRACT_2026-10.md §5).
--
-- A referral records that an incident was handed to another agency or
-- office (PNP, BFP, ambulance/EMS, VAW desk, ...). It is a DELEGATION
-- LOG, not a case registry: it carries no complainant/respondent data,
-- and `contact_name` is the responder/unit/official on the receiving
-- side, NEVER a citizen. Creating a referral does not change the
-- incident's or any dispatch's status.
--
-- Idempotency: UNIQUE (created_by, client_event_id) — the mobile/sync
-- path supplies the offline client_event_id; the web path stores its
-- Idempotency-Key UUID in the same column (same precedent as
-- IncidentsController::createWeb()).
--
-- Retention: no purge is defined for this table (retention is an open
-- policy decision, Rule 10 — contract §11). NOTE for whoever wires
-- retention: fk_referral_incident is ON DELETE RESTRICT, so
-- RetentionService::purgeOneIncident()'s ordered cascade must delete
-- `incident_referral` rows before the incident row.
--
-- New migration (Rule 9). Idempotent: guarded CREATE. Depends only on
-- tables that exist through 0029 (barangay, user, incident).
-- ============================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS incident_referral (
  referral_id     BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  incident_id     BIGINT UNSIGNED  NOT NULL,
  barangay_id     SMALLINT UNSIGNED NOT NULL,
  referred_to     ENUM('pnp','bfp','ambulance_ems','barangay_official','vaw_desk','social_welfare','higher_lgu','doh','dpwh','other') NOT NULL,
  other_text      VARCHAR(100)     NULL,
  contact_name    VARCHAR(100)     NULL,
  referred_at     DATETIME         NOT NULL,
  reference_no    VARCHAR(64)      NULL,
  created_by      BIGINT UNSIGNED  NOT NULL,
  client_event_id CHAR(36)         NULL,
  created_at      DATETIME         NOT NULL,
  PRIMARY KEY (referral_id),
  UNIQUE KEY uq_referral_creator_event (created_by, client_event_id),
  KEY idx_referral_incident (incident_id),
  KEY idx_referral_barangay_referred_at (barangay_id, referred_at),
  CONSTRAINT fk_referral_incident FOREIGN KEY (incident_id)
    REFERENCES incident(incident_id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_barangay FOREIGN KEY (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_created_by FOREIGN KEY (created_by)
    REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
