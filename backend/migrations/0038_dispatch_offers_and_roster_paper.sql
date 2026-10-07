-- ============================================================
-- 0038_dispatch_offers_and_roster_paper.sql -- night-time dispatch offers and
-- paper-recorded roster approval (Wave 2 review decisions, agent E).
--
-- 1. DISPATCH OFFERS. At night (18:00 inclusive - 06:00 exclusive Asia/Manila)
--    a new pending incident is broadcast as an "offer" to every on-duty Tanod
--    who holds a PUBLISHED shift covering now and has no active dispatch. The
--    first accept the server records wins and becomes a normal `dispatch` row;
--    the other recipients are released. If nobody accepts within 180 s the
--    offer is re-broadcast (up to 3 rounds) and the Admin(s) are alerted; after
--    round 3 it stays `escalated` and keeps alerting Admins only.
--
--      dispatch_offer            one row per incident offer. `round` mutates
--                                in place on re-broadcast (the offer is the
--                                incident's single live offer, not one row per
--                                round); `expires_at` is the next sweeper
--                                deadline. `created_by` NULL = opened by the
--                                system (night auto-trigger). `request_key` is
--                                the Idempotency-Key of a manual open.
--                                `active_incident_id` is a generated column,
--                                non-NULL only while the offer is `open` or
--                                `escalated`, so UNIQUE on it guarantees at most
--                                ONE live offer per incident at the database
--                                level (the controller checks first and returns
--                                409; this is the backstop).
--      dispatch_offer_recipient  who was offered the call and what became of it.
--
-- 2. NOTIFICATIONS. Adds the `dispatch_offer` notification type and a
--    `notification.dispatch_offer_id` link, mirroring how `dispatch` carries
--    `dispatch_id`. The entity-integrity matrix is enforced in PHP
--    (NotificationService), not as a CHECK (ERROR 1901 -- see migration 0001).
--    The Admin escalation reuses `priority_alert`, with incident_id AND
--    dispatch_offer_id set. Alert content is NON-IDENTIFYING by design
--    (incident type, barangay name, time -- never narrative, names, contacts,
--    coordinates or location text).
--
-- 3. ROSTER FROM PAPER. A barangay may approve the roster on paper; an
--    Admin/Secretary records that. Same four columns the 0037 reports got:
--    approval_mode, paper_signed_on, paper_recorded_by, paper_recorded_at.
--
-- New numbered migration (Rule 9). Idempotent (IF NOT EXISTS / MODIFY).
-- No retention rule exists for dispatch_offer rows (Rule 10: open policy
-- decision, same as the 0030-0037 tables).
-- ============================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS dispatch_offer (
  offer_id              BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  incident_id           BIGINT UNSIGNED   NOT NULL,
  barangay_id           SMALLINT UNSIGNED NOT NULL,
  `round`               TINYINT UNSIGNED  NOT NULL DEFAULT 1,
  status                ENUM('open','accepted','escalated','closed','cancelled') NOT NULL DEFAULT 'open',
  created_at            DATETIME          NOT NULL,
  expires_at            DATETIME          NOT NULL,
  accepted_by           BIGINT UNSIGNED   NULL,
  accepted_dispatch_id  BIGINT UNSIGNED   NULL,
  created_by            BIGINT UNSIGNED   NULL,
  closed_at             DATETIME          NULL,
  request_key           CHAR(36)          NULL,
  active_incident_id    BIGINT UNSIGNED
    GENERATED ALWAYS AS (IF(status IN ('open','escalated'), incident_id, NULL)) PERSISTENT,
  PRIMARY KEY (offer_id),
  UNIQUE KEY uq_dispatch_offer_active_incident (active_incident_id),
  UNIQUE KEY uq_dispatch_offer_request_key (barangay_id, request_key),
  KEY idx_dispatch_offer_incident (incident_id),
  KEY idx_dispatch_offer_barangay_status (barangay_id, status, expires_at),
  CONSTRAINT fk_dispatch_offer_incident FOREIGN KEY (incident_id)
    REFERENCES incident(incident_id) ON DELETE CASCADE,
  CONSTRAINT fk_dispatch_offer_barangay FOREIGN KEY (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_offer_accepted_by FOREIGN KEY (accepted_by)
    REFERENCES user(user_id) ON DELETE SET NULL,
  CONSTRAINT fk_dispatch_offer_dispatch FOREIGN KEY (accepted_dispatch_id)
    REFERENCES dispatch(dispatch_id) ON DELETE SET NULL,
  CONSTRAINT fk_dispatch_offer_created_by FOREIGN KEY (created_by)
    REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dispatch_offer_recipient (
  offer_id     BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  status       ENUM('offered','accepted','released','expired') NOT NULL DEFAULT 'offered',
  notified_at  DATETIME        NOT NULL,
  PRIMARY KEY (offer_id, user_id),
  KEY idx_dispatch_offer_recipient_user (user_id, status),
  CONSTRAINT fk_dispatch_offer_recipient_offer FOREIGN KEY (offer_id)
    REFERENCES dispatch_offer(offer_id) ON DELETE CASCADE,
  CONSTRAINT fk_dispatch_offer_recipient_user FOREIGN KEY (user_id)
    REFERENCES user(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notification type + link column.
ALTER TABLE notification
  MODIFY COLUMN notification_type ENUM('dispatch','sos','priority_alert','other','dispatch_offer') NOT NULL;

ALTER TABLE notification
  ADD COLUMN IF NOT EXISTS dispatch_offer_id BIGINT UNSIGNED NULL;

ALTER TABLE notification
  ADD CONSTRAINT fk_notification_dispatch_offer FOREIGN KEY IF NOT EXISTS (dispatch_offer_id)
    REFERENCES dispatch_offer(offer_id) ON DELETE SET NULL;

-- Roster approved on paper (mirrors 0037's report columns).
ALTER TABLE shift_schedule
  ADD COLUMN IF NOT EXISTS approval_mode ENUM('digital','recorded_from_paper') NOT NULL DEFAULT 'digital',
  ADD COLUMN IF NOT EXISTS paper_signed_on DATE NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS paper_recorded_at DATETIME NULL;

ALTER TABLE shift_schedule
  ADD CONSTRAINT fk_shift_paper_recorded_by FOREIGN KEY IF NOT EXISTS (paper_recorded_by)
    REFERENCES user(user_id) ON DELETE SET NULL;
