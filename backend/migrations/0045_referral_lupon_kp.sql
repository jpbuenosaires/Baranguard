-- ============================================================
-- 0045_referral_lupon_kp.sql — a referral may go to the Lupon / Katarungang Pambarangay.
--
-- Matters between neighbours are referred to the Lupon Tagapamayapa, which is a
-- barangay-level body, not an external agency. The referral log still records
-- only the date, the office and a reference number (no names, no narrative); the
-- case itself stays in the barangay's binders and the DILG BIMS.
--
-- Additive widening of the enum. Annex D treats it as barangay-level, like
-- barangay_official and vaw_desk. Idempotent.
-- ============================================================
SET NAMES utf8mb4;

ALTER TABLE incident_referral
  MODIFY COLUMN referred_to ENUM('pnp','bfp','ambulance_ems','barangay_official','vaw_desk','lupon_kp','social_welfare','higher_lgu','doh','dpwh','other') NOT NULL;
