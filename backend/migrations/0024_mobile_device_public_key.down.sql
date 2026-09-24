-- Rollback for 0024_mobile_device_public_key.sql.
ALTER TABLE mobile_device DROP COLUMN device_public_key_pem;
