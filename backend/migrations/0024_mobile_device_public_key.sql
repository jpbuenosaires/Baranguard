-- 0024: mobile_device.device_public_key_pem — code-review finding H-09
-- (2026-09-24 external audit): X-Device-Id is a self-generated string, not
-- proof of device identity. A device that generates a hardware-backed
-- (Android Keystore) EC keypair and registers its PUBLIC key here lets the
-- server verify a per-request signature instead of trusting a bare header
-- match. NULL for every device that has not upgraded yet — this is a
-- phased rollout, not a hard cutover (see AuthMiddleware/DeviceSignature's
-- own doc comments for how a NULL key is handled at request time).
--
-- PEM text, not a fixed-length binary column: EC P-256 SPKI DER is small
-- (~91 bytes) but PEM-armored + whitespace comfortably fits well under
-- TEXT's limits, and PEM is what PHP's openssl_pkey_get_public() expects
-- directly, avoiding an extra encode/decode step on every verification.
ALTER TABLE mobile_device
    ADD COLUMN device_public_key_pem TEXT NULL AFTER device_secret_ref;
