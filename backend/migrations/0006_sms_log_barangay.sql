-- Baranguard — Sprint 4 (SMS/GSM fallback) schema addition.
--
-- §6 `GET /sms/logs` reads "Admin own barangay", but §5's `sms_log` has no
-- barangay_id column and no reliable way to derive one for every row:
-- report_id/incident_id/dispatch_id are all NULLABLE and a
-- duty_status/coord_ping message (no incident, no dispatch, no citizen
-- report involved at all) can legitimately have all three NULL. Without
-- its own column, those rows would have no tenant to scope against at
-- all, and `GET /sms/logs` could not honestly claim "own barangay" for
-- them. Same convention as 0004/0005: a new migration, not an edit to the
-- completed 0001 baseline. Nullable rather than NOT NULL because this
-- migration only adds the column — it does not (and, since sms_log has
-- never been written to before this sprint, does not need to) backfill
-- historical rows.

SET NAMES utf8mb4;

ALTER TABLE sms_log
  ADD COLUMN barangay_id SMALLINT UNSIGNED NULL AFTER dispatch_id,
  ADD CONSTRAINT fk_sms_log_barangay FOREIGN KEY (barangay_id)
    REFERENCES barangay(barangay_id) ON DELETE RESTRICT,
  ADD INDEX idx_sms_log_barangay (barangay_id, created_at);
