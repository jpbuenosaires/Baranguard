-- 0026: SOS no-fix fallback — C-01 (2026-09-24 external audit, "Critical":
-- SOS is blocked when GPS fails). `TanodSosController::createItem()` used
-- to hard-reject any SOS with a missing/invalid latitude or longitude
-- because `tanod_sos.latitude/longitude` were NOT NULL — directly
-- contradicting §2 Rule 27 ("SOS must have a local/offline fallback path;
-- a workstation/LAN outage/missing input must never silently suppress a
-- personal-safety emergency"). A GPS-fix failure is exactly that kind of
-- input failure.
--
-- User decision, 2026-09-26: when live coordinates are missing, fall back
-- to the Tanod's most recent `gps_track` fix; when there is no fix at all
-- (a brand-new device, GPS never acquired), still create the SOS with
-- `location_source='no_fix'` and NULL coordinates — the alert itself is
-- NEVER blocked on location, matching this migration's own H-09 sibling
-- decision ("SOS deliberately never rejects on a bad device signature,
-- only audits it — a real emergency must never be lost to a secondary
-- check").
--
-- `location_recorded_at` is SEPARATE from `triggered_at`/`received_at`:
-- for a 'last_known' fallback it is the ORIGINAL gps_track.recorded_at of
-- the fix being reused, not "now" — a dispatcher looking at the SOS must
-- be able to tell a live position from a five-minute-old one, which a
-- single shared timestamp could not express.
--
-- New migration, not an edit to 0001 (§2 Rule 9 / repo convention).
-- Idempotent: guarded ADD COLUMN, MODIFY COLUMN is naturally idempotent
-- against an identical target (same pattern as every prior enum/nullability
-- widening in this repo).

ALTER TABLE tanod_sos
  MODIFY COLUMN latitude DECIMAL(10,7) NULL,
  MODIFY COLUMN longitude DECIMAL(10,7) NULL;

ALTER TABLE tanod_sos
  ADD COLUMN IF NOT EXISTS location_source ENUM('live','last_known','no_fix') NOT NULL DEFAULT 'live' AFTER longitude,
  ADD COLUMN IF NOT EXISTS location_recorded_at DATETIME NULL AFTER location_source;
