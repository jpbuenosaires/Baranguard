-- ============================================================
-- 0018_sms_subscriber.sql — consented recipients for barangay-wide
-- advisory broadcasts (flood, curfew, suspension of classes).
--
-- WHAT EXISTS TODAY AND WHY IT IS NOT ENOUGH: `/sms/broadcast` already
-- works, but it is STAFF-ONLY — it reads `user.contact_number` for
-- on-duty Tanods or for a role. There is no resident recipient
-- population anywhere in the schema, so a barangay-wide advisory is
-- currently impossible.
--
-- THE OBVIOUS SHORTCUT IS THE ONE THING THIS TABLE EXISTS TO PREVENT.
-- Every resident phone number the system has ever seen is already
-- sitting in `sms_log.sender_number` and `citizen_report.contact_number`,
-- and broadcasting to those would be trivial to implement. It would also
-- be unlawful: those numbers were given for ONE purpose — to report an
-- incident and be contacted about it — and RA 10173 (Data Privacy Act)
-- does not let a controller silently repurpose personal data collected
-- for one declared purpose into a mailing list for another. A resident
-- who texted once about a stray dog did not subscribe to curfew notices.
--
-- So consent is a COLUMN, not an assumption:
--
--   * `consent_at` and `consent_source` are NOT NULL. There is no way to
--     add a subscriber without recording that consent was obtained and
--     how. A row without provenance cannot exist.
--
--   * `opted_out_at` is a timestamp, never a DELETE. Proving you honoured
--     a withdrawal requires keeping the record OF the withdrawal; a
--     deleted row proves nothing, and re-adding the number later would
--     look identical to never having been asked. An opted-out row also
--     blocks silent re-subscription, because re-adding requires a fresh
--     explicit consent entry.
--
--   * UNIQUE (barangay_id, contact_number) — one row per number per
--     barangay, so consent and withdrawal cannot disagree with each
--     other across duplicates.
--
-- TENANT SCOPING: `barangay_id` is NOT NULL and every query filters on
-- it (§2 Rule 2). An advisory is a barangay-level act; there is
-- deliberately no cross-barangay subscriber concept.
--
-- New migration, not an edit to a completed one (§2 Rule 9).
-- Idempotent: guarded CREATE.
-- ============================================================

CREATE TABLE IF NOT EXISTS sms_subscriber (
  subscriber_id       BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  barangay_id         SMALLINT UNSIGNED NOT NULL,
  contact_number      VARCHAR(32)      NOT NULL,
  -- Consent provenance. Both NOT NULL by design — see header.
  consent_at          DATETIME         NOT NULL,
  consent_source      ENUM('walk_in','staff_entry','sms_keyword') NOT NULL,
  -- Free-text provenance detail: which desk, which list, which meeting.
  -- Deliberately NOT a person's name field — it records how consent was
  -- captured, and is shown only to the Admin who manages the list.
  consent_note        VARCHAR(255)     NULL,
  opted_out_at        DATETIME         NULL,
  created_by_user_id  BIGINT UNSIGNED  NULL,
  created_at          DATETIME         NOT NULL,
  PRIMARY KEY (subscriber_id),
  UNIQUE KEY uq_subscriber_barangay_number (barangay_id, contact_number),
  -- The broadcast query is "active subscribers in this barangay", which
  -- this index serves directly.
  KEY idx_subscriber_active (barangay_id, opted_out_at),
  CONSTRAINT fk_subscriber_barangay FOREIGN KEY (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  -- SET NULL, matching 0015's reasoning for `requested_by_user_id`: a
  -- consent record must outlive the staff account that entered it, and
  -- RESTRICT here would block deactivating any user who ever added one.
  CONSTRAINT fk_subscriber_created_by FOREIGN KEY (created_by_user_id)
    REFERENCES user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
