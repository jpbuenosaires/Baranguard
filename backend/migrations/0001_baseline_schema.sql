-- Baranguard — Sprint 0 baseline schema
-- Target: MariaDB 10.4+ (via XAMPP), MySQL-compatible
-- Source of truth: Baranguard Master Reference §5
--
-- Dependency order (mandated): barangay -> user -> mobile_device -> incident
-- -> dispatch -> tanod_sos -> notification -> notification_target ->
-- notification_delivery -> remaining dependent tables.
-- auth_session, evidence_attachment, blotter_record, citizen_report are
-- interleaved where their own FK dependencies require it (auth_session only
-- needs `user`; evidence_attachment/blotter_record/citizen_report need
-- `incident`, so they are created right after `incident`/`dispatch`).
--
-- Known trap (documented in Master Reference §16, "One real defect..."):
-- do NOT add a table-level CHECK constraint encoding the notification
-- entity-integrity matrix. MariaDB rejects it with ERROR 1901 because
-- notification.dispatch_id / sos_id / incident_id each carry an
-- ON DELETE SET NULL foreign key, and MariaDB will not allow a CHECK to
-- reference a column whose FK action could silently violate it. That matrix
-- is enforced in application code and a transaction-level check before
-- insert/update instead (see backend/config note in DEVLOG.md).

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- 1. barangay
-- ============================================================
CREATE TABLE barangay (
  barangay_id      SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
  name             VARCHAR(128) NOT NULL,
  municipality     VARCHAR(128) NOT NULL,
  province         VARCHAR(128) NOT NULL,
  population       INT UNSIGNED NULL,
  boundary_geojson JSON NULL,
  created_at       DATETIME NOT NULL,
  UNIQUE KEY uq_barangay_name_muni_prov (name, municipality, province)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 2. user
-- ============================================================
CREATE TABLE user (
  user_id                         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  barangay_id                     SMALLINT UNSIGNED NOT NULL,
  username                        VARCHAR(64) NOT NULL,
  password_hash                   VARCHAR(255) NOT NULL,
  full_name                       VARCHAR(255) NOT NULL,
  role                             ENUM('admin','secretary','tanod','punong_barangay','lupon') NOT NULL,
  contact_number                  VARCHAR(32) NULL,
  is_active                       BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts           INT UNSIGNED NOT NULL DEFAULT 0,
  login_failure_window_started_at DATETIME NULL,
  locked_until                    DATETIME NULL,
  created_at                      DATETIME NOT NULL,
  updated_at                      DATETIME NULL,
  UNIQUE KEY uq_user_username (username),
  KEY idx_user_barangay_role_active (barangay_id, role, is_active),
  CONSTRAINT fk_user_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- auth_session (depends only on `user`; created here per §5 ordering intent)
-- ============================================================
CREATE TABLE auth_session (
  session_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NOT NULL,
  jti             CHAR(36) NOT NULL,
  issued_at       DATETIME NOT NULL,
  expires_at      DATETIME NOT NULL,
  revoked_at      DATETIME NULL,
  ip_address      VARCHAR(45) NULL,
  user_agent      VARCHAR(512) NULL,
  last_seen_at    DATETIME NULL,
  last_renewed_at DATETIME NULL,
  UNIQUE KEY uq_auth_session_jti (jti),
  KEY idx_auth_session_user_expires (user_id, expires_at),
  KEY idx_auth_session_revoked_expires (revoked_at, expires_at),
  CONSTRAINT fk_auth_session_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 3. mobile_device
-- ============================================================
CREATE TABLE mobile_device (
  device_id         VARCHAR(64) NOT NULL PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL,
  platform          ENUM('android') NOT NULL,
  fcm_token         TEXT NOT NULL,
  device_secret_ref VARCHAR(255) NULL,
  app_version       VARCHAR(64) NULL,
  last_seen_at      DATETIME NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        DATETIME NOT NULL,
  KEY idx_mobile_device_user_active (user_id, is_active),
  CONSTRAINT fk_mobile_device_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 4. incident (mobile_device MUST precede incident: incident.device_id FK)
-- ============================================================
CREATE TABLE incident (
  incident_id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  barangay_id               SMALLINT UNSIGNED NOT NULL,
  reported_by               BIGINT UNSIGNED NULL,
  device_id                 VARCHAR(64) NULL,
  incident_type             ENUM('theft','physical_injury','disturbance','domestic_dispute','vandalism','traffic_incident','fire','medical_emergency','missing_person','animal_complaint','other') NOT NULL,
  priority                  ENUM('normal','high','critical') NOT NULL DEFAULT 'normal',
  raw_narrative              TEXT NOT NULL,
  redacted_narrative        TEXT NULL,
  redaction_approved_by     BIGINT UNSIGNED NULL,
  redaction_approved_at     DATETIME NULL,
  status                    ENUM('pending','dispatched','resolved') NOT NULL DEFAULT 'pending',
  source                    ENUM('app','sms','web') NOT NULL,
  latitude                  DECIMAL(10,7) NULL,
  longitude                 DECIMAL(10,7) NULL,
  created_at                DATETIME NOT NULL,
  device_offline_created_at DATETIME NULL,
  client_event_id           CHAR(36) NULL,
  synced_at                 DATETIME NULL,
  updated_at                DATETIME NOT NULL,
  KEY idx_incident_barangay_status_created (barangay_id, status, created_at),
  KEY idx_incident_reported_by_created (reported_by, created_at),
  KEY idx_incident_type_created (incident_type, created_at),
  UNIQUE KEY uq_incident_device_event (device_id, client_event_id),
  CONSTRAINT fk_incident_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_incident_reported_by FOREIGN KEY (reported_by) REFERENCES user(user_id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_device FOREIGN KEY (device_id) REFERENCES mobile_device(device_id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_redaction_approved_by FOREIGN KEY (redaction_approved_by) REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 5. dispatch
-- ============================================================
CREATE TABLE dispatch (
  dispatch_id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  incident_id             BIGINT UNSIGNED NOT NULL,
  dispatched_by           BIGINT UNSIGNED NOT NULL,
  tanod_id                BIGINT UNSIGNED NOT NULL,
  priority                ENUM('normal','high','critical') NOT NULL,
  route_json              JSON NULL,
  route_status            ENUM('available','unavailable','stale') NOT NULL DEFAULT 'unavailable',
  status                  ENUM('assigned','en_route','arrived','completed','cancelled') NOT NULL DEFAULT 'assigned',
  dispatched_at           DATETIME NOT NULL,
  en_route_at             DATETIME NULL,
  arrived_at              DATETIME NULL,
  completed_at            DATETIME NULL,
  cancelled_at            DATETIME NULL,
  cancelled_by            BIGINT UNSIGNED NULL,
  created_client_request_id CHAR(36) NOT NULL,
  UNIQUE KEY uq_dispatch_client_request (created_client_request_id),
  KEY idx_dispatch_incident_status (incident_id, status),
  KEY idx_dispatch_tanod_status_dispatched (tanod_id, status, dispatched_at),
  CONSTRAINT fk_dispatch_incident FOREIGN KEY (incident_id) REFERENCES incident(incident_id) ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_dispatched_by FOREIGN KEY (dispatched_by) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_tanod FOREIGN KEY (tanod_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- evidence_attachment (depends on incident; grouped here to keep incident's
-- dependents together before moving on to tanod_sos/notification)
-- ============================================================
CREATE TABLE evidence_attachment (
  attachment_id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  incident_id          BIGINT UNSIGNED NOT NULL,
  type                 ENUM('photo','voice') NOT NULL,
  file_path            VARCHAR(512) NOT NULL,
  uploaded_by          BIGINT UNSIGNED NOT NULL,
  uploaded_at          DATETIME NOT NULL,
  sha256               CHAR(64) NOT NULL,
  byte_size            BIGINT UNSIGNED NOT NULL,
  mime_type            VARCHAR(100) NOT NULL,
  original_filename    VARCHAR(255) NOT NULL,
  retention_expires_at DATETIME NULL,
  legal_hold           BOOLEAN NOT NULL DEFAULT FALSE,
  client_request_id    CHAR(36) NULL,
  UNIQUE KEY uq_evidence_client_request (client_request_id),
  KEY idx_evidence_incident_uploaded (incident_id, uploaded_at),
  CONSTRAINT fk_evidence_incident FOREIGN KEY (incident_id) REFERENCES incident(incident_id) ON DELETE RESTRICT,
  CONSTRAINT fk_evidence_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- blotter_record (depends on incident)
-- ============================================================
CREATE TABLE blotter_record (
  blotter_id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  incident_id       BIGINT UNSIGNED NOT NULL,
  barangay_id       SMALLINT UNSIGNED NOT NULL,
  recorded_by       BIGINT UNSIGNED NOT NULL,
  approved_by       BIGINT UNSIGNED NULL,
  narrative_summary TEXT NOT NULL,
  finalized_at      DATETIME NULL,
  revision_no       INT UNSIGNED NOT NULL DEFAULT 1,
  amended_at        DATETIME NULL,
  amended_by        BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_blotter_incident (incident_id),
  KEY idx_blotter_barangay_finalized (barangay_id, finalized_at),
  CONSTRAINT fk_blotter_incident FOREIGN KEY (incident_id) REFERENCES incident(incident_id) ON DELETE RESTRICT,
  CONSTRAINT fk_blotter_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_blotter_recorded_by FOREIGN KEY (recorded_by) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_blotter_approved_by FOREIGN KEY (approved_by) REFERENCES user(user_id) ON DELETE SET NULL,
  CONSTRAINT fk_blotter_amended_by FOREIGN KEY (amended_by) REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- citizen_report (depends on barangay, incident)
-- ============================================================
CREATE TABLE citizen_report (
  report_id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  barangay_id          SMALLINT UNSIGNED NOT NULL,
  incident_id          BIGINT UNSIGNED NULL,
  contact_number       VARCHAR(32) NULL,
  description          TEXT NOT NULL,
  latitude             DECIMAL(10,7) NULL,
  longitude            DECIMAL(10,7) NULL,
  submitted_at         DATETIME NOT NULL,
  converted_at         DATETIME NULL,
  retention_expires_at DATETIME NULL,
  legal_hold           BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE KEY uq_citizen_report_incident (incident_id),
  KEY idx_citizen_report_barangay_submitted_incident (barangay_id, submitted_at, incident_id),
  CONSTRAINT fk_citizen_report_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_citizen_report_incident FOREIGN KEY (incident_id) REFERENCES incident(incident_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 6. tanod_sos
-- ============================================================
CREATE TABLE tanod_sos (
  sos_id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id          BIGINT UNSIGNED NOT NULL,
  barangay_id      SMALLINT UNSIGNED NOT NULL,
  dispatch_id      BIGINT UNSIGNED NULL,
  latitude         DECIMAL(10,7) NOT NULL,
  longitude        DECIMAL(10,7) NOT NULL,
  triggered_at     DATETIME NOT NULL,
  received_at      DATETIME NOT NULL,
  status           ENUM('active','acknowledged','resolved') NOT NULL DEFAULT 'active',
  acknowledged_by  BIGINT UNSIGNED NULL,
  acknowledged_at  DATETIME NULL,
  resolved_by      BIGINT UNSIGNED NULL,
  resolved_at      DATETIME NULL,
  client_event_id  CHAR(36) NOT NULL,
  fallback_channel ENUM('app','sms') NOT NULL DEFAULT 'app',
  UNIQUE KEY uq_sos_user_event (user_id, client_event_id),
  KEY idx_sos_barangay_status_triggered (barangay_id, status, triggered_at),
  CONSTRAINT fk_sos_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sos_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sos_dispatch FOREIGN KEY (dispatch_id) REFERENCES dispatch(dispatch_id) ON DELETE SET NULL,
  CONSTRAINT fk_sos_acknowledged_by FOREIGN KEY (acknowledged_by) REFERENCES user(user_id) ON DELETE SET NULL,
  CONSTRAINT fk_sos_resolved_by FOREIGN KEY (resolved_by) REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 7. notification
-- NOTE: entity-integrity matrix (dispatch_id/sos_id/incident_id required
-- per notification_type) is enforced in application code + a
-- transaction-level check, NOT a table-level CHECK. See header comment.
-- ============================================================
CREATE TABLE notification (
  notification_id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  barangay_id       SMALLINT UNSIGNED NOT NULL,
  notification_type ENUM('dispatch','sos','priority_alert','other') NOT NULL,
  dispatch_id       BIGINT UNSIGNED NULL,
  sos_id            BIGINT UNSIGNED NULL,
  incident_id       BIGINT UNSIGNED NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL,
  expires_at        DATETIME NULL,
  KEY idx_notification_barangay_type_created (barangay_id, notification_type, created_at),
  CONSTRAINT fk_notification_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_notification_dispatch FOREIGN KEY (dispatch_id) REFERENCES dispatch(dispatch_id) ON DELETE SET NULL,
  CONSTRAINT fk_notification_sos FOREIGN KEY (sos_id) REFERENCES tanod_sos(sos_id) ON DELETE SET NULL,
  CONSTRAINT fk_notification_incident FOREIGN KEY (incident_id) REFERENCES incident(incident_id) ON DELETE SET NULL,
  CONSTRAINT fk_notification_created_by FOREIGN KEY (created_by) REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 8. notification_target
-- ============================================================
CREATE TABLE notification_target (
  notification_target_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notification_id         BIGINT UNSIGNED NOT NULL,
  user_id                  BIGINT UNSIGNED NOT NULL,
  device_id                VARCHAR(64) NULL,
  targeted_at              DATETIME NOT NULL,
  acknowledged_at          DATETIME NULL,
  ack_status               ENUM('pending','acknowledged','not_required') NOT NULL DEFAULT 'pending',
  UNIQUE KEY uq_notification_target_notification_user (notification_id, user_id),
  CONSTRAINT fk_notification_target_notification FOREIGN KEY (notification_id) REFERENCES notification(notification_id) ON DELETE CASCADE,
  CONSTRAINT fk_notification_target_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_notification_target_device FOREIGN KEY (device_id) REFERENCES mobile_device(device_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 9. notification_delivery
-- ============================================================
CREATE TABLE notification_delivery (
  delivery_id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notification_id         BIGINT UNSIGNED NOT NULL,
  notification_target_id  BIGINT UNSIGNED NOT NULL,
  channel                 ENUM('fcm','sms') NOT NULL,
  attempt_no               TINYINT UNSIGNED NOT NULL,
  status                   ENUM('initiated','sent','failed','ack_timeout') NOT NULL,
  provider_message_id      VARCHAR(128) NULL,
  initiated_at             DATETIME NOT NULL,
  sent_at                  DATETIME NULL,
  ack_timeout_at           DATETIME NULL,
  failure_reason           VARCHAR(255) NULL,
  metadata_json            JSON NULL,
  UNIQUE KEY uq_delivery_target_channel_attempt (notification_target_id, channel, attempt_no),
  KEY idx_delivery_notification_status_initiated (notification_id, status, initiated_at),
  CONSTRAINT fk_delivery_notification FOREIGN KEY (notification_id) REFERENCES notification(notification_id) ON DELETE CASCADE,
  CONSTRAINT fk_delivery_target FOREIGN KEY (notification_target_id) REFERENCES notification_target(notification_target_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- remaining dependent tables
-- ============================================================

CREATE TABLE audit_log (
  audit_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  barangay_id   SMALLINT UNSIGNED NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  action        VARCHAR(128) NOT NULL,
  entity_type   VARCHAR(64) NOT NULL,
  entity_id     BIGINT UNSIGNED NULL,
  metadata_json JSON NULL,
  ip_address    VARCHAR(45) NULL,
  user_agent    VARCHAR(512) NULL,
  created_at    DATETIME NOT NULL,
  KEY idx_audit_barangay_created (barangay_id, created_at),
  KEY idx_audit_actor_created (actor_user_id, created_at),
  KEY idx_audit_action_created (action, created_at),
  CONSTRAINT fk_audit_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE duty_status (
  status_id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id          BIGINT UNSIGNED NOT NULL,
  status           ENUM('on_duty','responding','off_duty') NOT NULL,
  channel          ENUM('app','sms') NOT NULL,
  client_event_id  CHAR(36) NULL,
  changed_at       DATETIME NOT NULL,
  UNIQUE KEY uq_duty_status_user_event (user_id, client_event_id),
  KEY idx_duty_status_user_changed (user_id, changed_at),
  CONSTRAINT fk_duty_status_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE gps_track (
  track_id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL,
  dispatch_id       BIGINT UNSIGNED NULL,
  latitude          DECIMAL(10,7) NOT NULL,
  longitude         DECIMAL(10,7) NOT NULL,
  accuracy_m        DECIMAL(8,2) NOT NULL,
  recorded_at       DATETIME NOT NULL,
  received_at       DATETIME NOT NULL,
  synced_at         DATETIME NULL,
  client_event_id   CHAR(36) NULL,
  UNIQUE KEY uq_gps_track_user_event (user_id, client_event_id),
  KEY idx_gps_track_user_recorded (user_id, recorded_at),
  KEY idx_gps_track_dispatch_recorded (dispatch_id, recorded_at),
  CONSTRAINT fk_gps_track_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gps_track_dispatch FOREIGN KEY (dispatch_id) REFERENCES dispatch(dispatch_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sms_log (
  log_id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  report_id           BIGINT UNSIGNED NULL,
  incident_id         BIGINT UNSIGNED NULL,
  dispatch_id         BIGINT UNSIGNED NULL,
  sender_number       VARCHAR(32) NULL,
  receiver_number     VARCHAR(32) NULL,
  transport            ENUM('gsm_modem','semaphore') NOT NULL,
  message_type         ENUM('incident','dispatch','priority_alert','coord_ping','confirmation','duty_status','sos') NOT NULL,
  direction             ENUM('inbound','outbound') NOT NULL,
  gateway_message_id    VARCHAR(128) NULL,
  modem_message_id      VARCHAR(128) NULL,
  correlation_id        CHAR(36) NULL,
  status                 ENUM('queued','pending','sent','failed','refunded','received','rejected','deduplicated') NOT NULL,
  sent_at                DATETIME NULL,
  received_at            DATETIME NULL,
  failure_reason         VARCHAR(255) NULL,
  created_at              DATETIME NOT NULL,
  KEY idx_sms_log_report (report_id),
  KEY idx_sms_log_incident_created (incident_id, created_at),
  KEY idx_sms_log_dispatch_created (dispatch_id, created_at),
  KEY idx_sms_log_status_created (status, created_at),
  CONSTRAINT fk_sms_log_report FOREIGN KEY (report_id) REFERENCES citizen_report(report_id) ON DELETE SET NULL,
  CONSTRAINT fk_sms_log_incident FOREIGN KEY (incident_id) REFERENCES incident(incident_id) ON DELETE SET NULL,
  CONSTRAINT fk_sms_log_dispatch FOREIGN KEY (dispatch_id) REFERENCES dispatch(dispatch_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_processing_log (
  log_id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  incident_id                 BIGINT UNSIGNED NOT NULL,
  pipeline_run_id              CHAR(36) NOT NULL,
  task_type                    ENUM('summarization','redaction','translation') NOT NULL,
  model_version                 VARCHAR(128) NOT NULL,
  source_language               VARCHAR(16) NULL,
  target_language                VARCHAR(16) NULL,
  draft_redacted_narrative       TEXT NULL,
  draft_summary                  TEXT NULL,
  draft_summary_stale             BOOLEAN NOT NULL DEFAULT FALSE,
  draft_version                   INT UNSIGNED NOT NULL DEFAULT 1,
  translated_text                 TEXT NULL,
  status                           ENUM('queued','processing','completed','failed','superseded') NOT NULL,
  error_code                       VARCHAR(128) NULL,
  processed_at                     DATETIME NULL,
  created_at                        DATETIME NOT NULL,
  KEY idx_ai_log_incident_status_created (incident_id, status, created_at),
  KEY idx_ai_log_pipeline_run (pipeline_run_id),
  CONSTRAINT fk_ai_log_incident FOREIGN KEY (incident_id) REFERENCES incident(incident_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_evaluation_run (
  evaluation_run_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dataset_name        VARCHAR(128) NOT NULL,
  dataset_version      VARCHAR(64) NOT NULL,
  model_version         VARCHAR(128) NOT NULL,
  task_type              VARCHAR(64) NOT NULL,
  sample_count            INT UNSIGNED NOT NULL,
  precision_score          DECIMAL(6,5) NULL,
  recall_score              DECIMAL(6,5) NULL,
  created_at                 DATETIME NOT NULL,
  notes                       TEXT NULL,
  UNIQUE KEY uq_ai_eval_dataset_model_task (dataset_name, dataset_version, model_version, task_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE offline_queue (
  queue_id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id                VARCHAR(64) NOT NULL,
  client_event_id           CHAR(36) NOT NULL,
  payload_type               ENUM('incident','gps','duty_status','sos','dispatch_status') NOT NULL,
  sync_metadata_json          JSON NOT NULL,
  created_offline_at           DATETIME NOT NULL,
  received_at                   DATETIME NULL,
  synced_at                      DATETIME NULL,
  reconciliation_status           ENUM('pending','success','duplicate','failed') NOT NULL DEFAULT 'pending',
  failure_reason                   VARCHAR(255) NULL,
  UNIQUE KEY uq_offline_queue_device_event (device_id, client_event_id),
  KEY idx_offline_queue_status_created (reconciliation_status, created_offline_at),
  CONSTRAINT fk_offline_queue_device FOREIGN KEY (device_id) REFERENCES mobile_device(device_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shift_schedule (
  shift_id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  barangay_id          SMALLINT UNSIGNED NOT NULL,
  user_id                BIGINT UNSIGNED NOT NULL,
  patrol_zone              VARCHAR(128) NULL,
  start_at                  DATETIME NOT NULL,
  end_at                     DATETIME NOT NULL,
  created_by                  BIGINT UNSIGNED NOT NULL,
  version                       INT UNSIGNED NOT NULL DEFAULT 1,
  client_request_id             CHAR(36) NULL,
  updated_at                     DATETIME NULL,
  UNIQUE KEY uq_shift_client_request (client_request_id),
  KEY idx_shift_barangay_start_end (barangay_id, start_at, end_at),
  KEY idx_shift_user_start_end (user_id, start_at, end_at),
  CONSTRAINT fk_shift_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_shift_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_shift_created_by FOREIGN KEY (created_by) REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shift_swap_request (
  request_id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  requesting_user_id     BIGINT UNSIGNED NOT NULL,
  shift_id                 BIGINT UNSIGNED NOT NULL,
  target_user_id             BIGINT UNSIGNED NULL,
  reason                       VARCHAR(1000) NULL,
  status                         ENUM('pending','approved','denied') NOT NULL DEFAULT 'pending',
  requested_at                     DATETIME NOT NULL,
  resolved_at                       DATETIME NULL,
  resolved_by                        BIGINT UNSIGNED NULL,
  version                              INT UNSIGNED NOT NULL DEFAULT 1,
  client_request_id                     CHAR(36) NULL,
  UNIQUE KEY uq_swap_client_request (client_request_id),
  KEY idx_swap_shift_status (shift_id, status),
  CONSTRAINT fk_swap_requesting_user FOREIGN KEY (requesting_user_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_swap_shift FOREIGN KEY (shift_id) REFERENCES shift_schedule(shift_id) ON DELETE RESTRICT,
  CONSTRAINT fk_swap_target_user FOREIGN KEY (target_user_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_swap_resolved_by FOREIGN KEY (resolved_by) REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fatigue_flag (
  flag_id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id                 BIGINT UNSIGNED NOT NULL,
  shift_id                  BIGINT UNSIGNED NOT NULL,
  hours_worked_7day           DECIMAL(5,2) NOT NULL,
  calculation_basis             ENUM('scheduled_hours') NOT NULL DEFAULT 'scheduled_hours',
  flagged_at                     DATETIME NOT NULL,
  acknowledged_by                  BIGINT UNSIGNED NULL,
  acknowledged_at                    DATETIME NULL,
  UNIQUE KEY uq_fatigue_user_shift (user_id, shift_id),
  KEY idx_fatigue_user_flagged (user_id, flagged_at),
  CONSTRAINT fk_fatigue_user FOREIGN KEY (user_id) REFERENCES user(user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_fatigue_shift FOREIGN KEY (shift_id) REFERENCES shift_schedule(shift_id) ON DELETE RESTRICT,
  CONSTRAINT fk_fatigue_acknowledged_by FOREIGN KEY (acknowledged_by) REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE offline_map_package (
  package_id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  barangay_id        SMALLINT UNSIGNED NOT NULL,
  version              VARCHAR(64) NOT NULL,
  file_path             VARCHAR(512) NOT NULL,
  checksum_sha256         CHAR(64) NOT NULL,
  byte_size                BIGINT UNSIGNED NOT NULL,
  created_by                 BIGINT UNSIGNED NOT NULL,
  created_at                   DATETIME NOT NULL,
  is_published                   BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE KEY uq_map_pkg_barangay_version (barangay_id, version),
  KEY idx_map_pkg_barangay_published (barangay_id, is_published),
  CONSTRAINT fk_map_pkg_barangay FOREIGN KEY (barangay_id) REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_map_pkg_created_by FOREIGN KEY (created_by) REFERENCES user(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
