-- Baranguard — Sprint 4 (SMS/GSM fallback) schema addition.
--
-- §6 "Internal SMS / GSM": every inbound envelope carries a `message_id`
-- and the server must reject "stale/replayed envelopes". `client_event_id`
-- already gives BUSINESS-level idempotency (the resulting incident/gps/
-- duty_status/sos row won't duplicate), but that is a different guarantee
-- from ENVELOPE-level replay protection — a captured-and-replayed envelope
-- should be rejected outright, before its payload is ever decrypted a
-- second time, even for a read that wouldn't itself mutate anything twice.
-- §5 has no existing table shaped for this (sms_log.correlation_id is
-- nullable and shared across many message types/directions, not a clean
-- fit for a dedicated replay index), so — same convention as 0004 — this
-- is a NEW migration rather than editing the completed 0001 baseline.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS sms_envelope_replay (
  message_id  CHAR(36) NOT NULL PRIMARY KEY,
  device_id   VARCHAR(64) NOT NULL,
  received_at DATETIME NOT NULL,
  KEY idx_sms_envelope_replay_device (device_id, received_at),
  CONSTRAINT fk_sms_envelope_replay_device FOREIGN KEY (device_id)
    REFERENCES mobile_device(device_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
