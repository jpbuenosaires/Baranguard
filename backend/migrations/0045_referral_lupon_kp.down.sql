-- Rollback for 0045_referral_lupon_kp.sql. Rows using lupon_kp are folded into
-- barangay_official (also barangay-level) before the enum returns to its 0032 shape.
UPDATE incident_referral SET referred_to = 'barangay_official' WHERE referred_to = 'lupon_kp';
ALTER TABLE incident_referral
  MODIFY COLUMN referred_to ENUM('pnp','bfp','ambulance_ems','barangay_official','vaw_desk','social_welfare','higher_lgu','doh','dpwh','other') NOT NULL;
