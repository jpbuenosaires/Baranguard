-- ============================================================
-- 0033_school_zones.sql -- Safer School Zones (docs/FEATURE_CONTRACT_2026-10.md
-- section 7, DILG Annex B / C-1 / D support).
--
--   * school            -- per-barangay school registry (Annex B). NO student
--                          data of any kind; the focal person is school STAFF.
--   * school_checkin    -- a Tanod's presence at a school (check-in/out). No
--                          coordinates are stored. UNIQUE(user_id,
--                          client_event_id) so an offline retry is idempotent;
--                          re-sending the same client_event_id with
--                          checked_out_at set closes the check-in.
--   * incident          -- gains nullable school_id (FK RESTRICT) and three
--                          short, NON-identifying Annex C-1 text fields,
--                          separate from raw_narrative. Never victim/student
--                          names.
--   * ssz_term_report   -- Annex D term report snapshot + approval state
--                          (draft -> prepared -> approved -> submitted).
--                          preparer/approver authority lives in
--                          user.approval_authority (migration 0030), NOT here.
--
-- Retention for these tables / the c1_* columns is an OPEN policy decision
-- (REFERENCE.md Rule 10); no purge job is added by this migration.
--
-- New numbered migration (Rule 9). Idempotent: every statement is guarded.
-- All timestamps are UTC.
-- ============================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS school (
  school_id         BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  barangay_id       SMALLINT UNSIGNED NOT NULL,
  name              VARCHAR(160)      NOT NULL,
  school_type       ENUM('public','private') NOT NULL,
  level             ENUM('preschool_daycare_eccd','primary_elementary','secondary_high_school','integrated','higher_education_tertiary','all_through','tvet','sned') NOT NULL,
  address           VARCHAR(255)      NOT NULL,
  focal_person      VARCHAR(120)      NULL,
  focal_contact     VARCHAR(32)       NULL,
  remarks           VARCHAR(500)      NULL,
  latitude          DECIMAL(10,7)     NULL,
  longitude         DECIMAL(10,7)     NULL,
  is_active         TINYINT(1)        NOT NULL DEFAULT 1,
  created_by        BIGINT UNSIGNED   NULL,
  client_request_id CHAR(36)          NULL,
  created_at        DATETIME          NOT NULL,
  updated_at        DATETIME          NOT NULL,
  PRIMARY KEY (school_id),
  UNIQUE KEY uq_school_client_request (client_request_id),
  KEY idx_school_barangay_active (barangay_id, is_active),
  CONSTRAINT fk_school_barangay FOREIGN KEY (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_school_created_by FOREIGN KEY (created_by)
    REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS school_checkin (
  checkin_id      BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  school_id       BIGINT UNSIGNED   NOT NULL,
  barangay_id     SMALLINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED   NOT NULL,
  checked_in_at   DATETIME          NOT NULL,
  checked_out_at  DATETIME          NULL,
  client_event_id CHAR(36)          NOT NULL,
  created_at      DATETIME          NOT NULL,
  PRIMARY KEY (checkin_id),
  UNIQUE KEY uq_school_checkin_user_event (user_id, client_event_id),
  KEY idx_school_checkin_barangay_in (barangay_id, checked_in_at),
  KEY idx_school_checkin_school_in (school_id, checked_in_at),
  CONSTRAINT fk_school_checkin_school FOREIGN KEY (school_id)
    REFERENCES school(school_id) ON DELETE RESTRICT,
  CONSTRAINT fk_school_checkin_barangay FOREIGN KEY (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_school_checkin_user FOREIGN KEY (user_id)
    REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE incident
  ADD COLUMN IF NOT EXISTS school_id BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS c1_summary VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS c1_action_taken VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS c1_status_notes VARCHAR(500) NULL;

ALTER TABLE incident
  ADD INDEX IF NOT EXISTS idx_incident_school_created (school_id, created_at);

ALTER TABLE incident
  ADD CONSTRAINT fk_incident_school FOREIGN KEY IF NOT EXISTS (school_id)
    REFERENCES school(school_id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS ssz_term_report (
  report_id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  barangay_id              SMALLINT UNSIGNED NOT NULL,
  term_label               VARCHAR(40)       NOT NULL,
  term_start               DATE              NOT NULL,
  term_end                 DATE              NOT NULL,
  status                   ENUM('draft','prepared','approved','submitted') NOT NULL DEFAULT 'draft',
  total_tanods             INT               NOT NULL DEFAULT 0,
  total_schools            INT               NOT NULL DEFAULT 0,
  total_deployment_days    INT               NOT NULL DEFAULT 0,
  total_incidents          INT               NOT NULL DEFAULT 0,
  incidents_barangay_only  INT               NOT NULL DEFAULT 0,
  incidents_pnp            INT               NOT NULL DEFAULT 0,
  incidents_bfp            INT               NOT NULL DEFAULT 0,
  incidents_higher_lgu     INT               NOT NULL DEFAULT 0,
  incidents_doh            INT               NOT NULL DEFAULT 0,
  incidents_dpwh           INT               NOT NULL DEFAULT 0,
  incidents_other_agencies INT               NOT NULL DEFAULT 0,
  other_institutions       VARCHAR(500)      NULL,
  remarks                  VARCHAR(1000)     NULL,
  prepared_by              BIGINT UNSIGNED   NULL,
  prepared_at              DATETIME          NULL,
  approved_by              BIGINT UNSIGNED   NULL,
  approved_at              DATETIME          NULL,
  mayor_office_received_by VARCHAR(120)      NULL,
  mayor_office_received_at DATE              NULL,
  dilg_received_by         VARCHAR(120)      NULL,
  dilg_date_received       DATE              NULL,
  version                  INT               NOT NULL DEFAULT 1,
  created_by               BIGINT UNSIGNED   NULL,
  client_request_id        CHAR(36)          NULL,
  created_at               DATETIME          NOT NULL,
  updated_at               DATETIME          NOT NULL,
  PRIMARY KEY (report_id),
  UNIQUE KEY uq_ssz_report_client_request (client_request_id),
  KEY idx_ssz_report_barangay_status (barangay_id, status, term_start),
  CONSTRAINT fk_ssz_report_barangay FOREIGN KEY (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ssz_report_prepared_by FOREIGN KEY (prepared_by)
    REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ssz_report_approved_by FOREIGN KEY (approved_by)
    REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ssz_report_created_by FOREIGN KEY (created_by)
    REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
