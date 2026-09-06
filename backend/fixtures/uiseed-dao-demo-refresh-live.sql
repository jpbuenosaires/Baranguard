-- ============================================================
-- uiseed-dao-demo-refresh-live.sql — part 3 of the Barangay Dao demo
-- seed, and the one you may want to RE-RUN before a demo.
--
-- Run AFTER uiseed-dao-demo.sql. DISPOSABLE DB ONLY.
--
-- WHY THIS EXISTS: LiveMap greys a Tanod marker out and labels it
-- "stale" once its last GPS fix is old enough, which is correct
-- behaviour (§9 W4: "A stale location is not visually presented as
-- live"). But a seed file with hardcoded timestamps goes stale the
-- moment the wall clock moves past it — on the first load after
-- seeding, every marker already read "7h ago (stale)".
--
-- So the LIVE signals are pinned relative to UTC_TIMESTAMP() instead of
-- to a literal. Historical rows (incidents, blotter, audit) keep their
-- fixed dates on purpose: they are records, and the trend chart and the
-- 7/30/90-day range presets depend on them being spread over real past
-- weeks.
--
-- THE 2-MINUTE WINDOW: GpsController::STALE_AFTER_SECONDS is 120, so a
-- Tanod goes stale 2 minutes after their last fix. The newest fix for
-- each active Tanod below is therefore only 18-55 SECONDS old, so the
-- map loads with fresh markers. They will legitimately turn stale about
-- two minutes later, because nothing is pushing GPS on this workstation
-- — that is the app telling the truth (§9 W4), not a defect in the seed.
--
-- Re-run this file immediately before a demo to re-freshen the markers.
-- ============================================================

-- ------------------------------------------------------------
-- GPS TRACKS — rebuild the trails ending a couple of minutes ago.
-- Coordinates are unchanged and still inside Barangay Dao
-- (centroid 12.9223 N, 123.6725 E; every point below is <350 m from it).
-- ------------------------------------------------------------
TRUNCATE TABLE gps_track;

INSERT INTO gps_track (user_id, dispatch_id, latitude, longitude, accuracy_m, recorded_at, received_at, client_event_id) VALUES
 -- Jomar Reyes (4) — on duty, patrolling the national road
 (4, NULL,12.9236000,123.6716000, 8.50, UTC_TIMESTAMP() - INTERVAL 18 MINUTE, UTC_TIMESTAMP() - INTERVAL 18 MINUTE, UUID()),
 (4, NULL,12.9240000,123.6722000, 7.20, UTC_TIMESTAMP() - INTERVAL 11 MINUTE, UTC_TIMESTAMP() - INTERVAL 11 MINUTE, UUID()),
 (4, NULL,12.9245000,123.6728000, 6.80, UTC_TIMESTAMP() - INTERVAL 25 SECOND, UTC_TIMESTAMP() - INTERVAL 25 SECOND, UUID()),
 -- Arnel Dela Cruz (5) — responding, en route to incident 18
 (5, 13,  12.9220000,123.6738000, 9.10, UTC_TIMESTAMP() - INTERVAL 16 MINUTE, UTC_TIMESTAMP() - INTERVAL 16 MINUTE, UUID()),
 (5, 13,  12.9218000,123.6740000, 8.00, UTC_TIMESTAMP() - INTERVAL  8 MINUTE, UTC_TIMESTAMP() - INTERVAL  8 MINUTE, UUID()),
 (5, 13,  12.9217000,123.6741000, 7.50, UTC_TIMESTAMP() - INTERVAL 18 SECOND, UTC_TIMESTAMP() - INTERVAL 18 SECOND, UUID()),
 -- Marites Gubaton (6) — responding, assigned to the critical medical call
 (6, 14,  12.9214000,123.6726000,10.20, UTC_TIMESTAMP() - INTERVAL 14 MINUTE, UTC_TIMESTAMP() - INTERVAL 14 MINUTE, UUID()),
 (6, 14,  12.9211000,123.6723000, 9.40, UTC_TIMESTAMP() - INTERVAL  7 MINUTE, UTC_TIMESTAMP() - INTERVAL  7 MINUTE, UUID()),
 (6, 14,  12.9210000,123.6722000, 8.10, UTC_TIMESTAMP() - INTERVAL 40 SECOND, UTC_TIMESTAMP() - INTERVAL 40 SECOND, UUID()),
 -- Nestor Dichoso (7) — on duty, west side
 (7, NULL,12.9228000,123.6706000,11.00, UTC_TIMESTAMP() - INTERVAL 17 MINUTE, UTC_TIMESTAMP() - INTERVAL 17 MINUTE, UUID()),
 (7, NULL,12.9232000,123.6702000, 9.90, UTC_TIMESTAMP() - INTERVAL  9 MINUTE, UTC_TIMESTAMP() - INTERVAL  9 MINUTE, UUID()),
 (7, NULL,12.9235000,123.6700000, 8.70, UTC_TIMESTAMP() - INTERVAL 55 SECOND, UTC_TIMESTAMP() - INTERVAL 55 SECOND, UUID()),
 -- Rowena Espinosa (8) — OFF DUTY, deliberately left hours old so the
 -- map's stale-marker styling is demonstrable rather than absent.
 (8, NULL,12.9204000,123.6731000,12.50, UTC_TIMESTAMP() - INTERVAL 9 HOUR, UTC_TIMESTAMP() - INTERVAL 9 HOUR, UUID()),
 (8, NULL,12.9206000,123.6734000,11.80, UTC_TIMESTAMP() - INTERVAL 8 HOUR, UTC_TIMESTAMP() - INTERVAL 8 HOUR, UUID());

-- ------------------------------------------------------------
-- DUTY STATUS — keep the same states, but stamp them recently so the
-- roster does not read as a day-old snapshot.
-- ------------------------------------------------------------
UPDATE duty_status SET changed_at = UTC_TIMESTAMP() - INTERVAL 6 HOUR  WHERE user_id = 4;
UPDATE duty_status SET changed_at = UTC_TIMESTAMP() - INTERVAL 22 MINUTE WHERE user_id = 5;
UPDATE duty_status SET changed_at = UTC_TIMESTAMP() - INTERVAL 15 MINUTE WHERE user_id = 6;
UPDATE duty_status SET changed_at = UTC_TIMESTAMP() - INTERVAL 6 HOUR  WHERE user_id = 7;
UPDATE duty_status SET changed_at = UTC_TIMESTAMP() - INTERVAL 10 HOUR WHERE user_id = 8;

-- ------------------------------------------------------------
-- THE OPEN SOS — the dashboard's critical attention banner and the
-- map's SOS marker both key off this one. Pin it to a few minutes ago.
-- ------------------------------------------------------------
UPDATE tanod_sos
   SET triggered_at = UTC_TIMESTAMP() - INTERVAL 6 MINUTE,
       received_at  = UTC_TIMESTAMP() - INTERVAL 6 MINUTE
 WHERE status = 'active';

-- ------------------------------------------------------------
-- THE THREE LIVE DISPATCHES — so Dispatch Center's elapsed timers read
-- like an active shift rather than a historical log.
-- ------------------------------------------------------------
UPDATE dispatch SET dispatched_at = UTC_TIMESTAMP() - INTERVAL 52 MINUTE,
                    en_route_at   = UTC_TIMESTAMP() - INTERVAL 50 MINUTE,
                    arrived_at    = UTC_TIMESTAMP() - INTERVAL 36 MINUTE
 WHERE dispatch_id = 12;
UPDATE dispatch SET dispatched_at = UTC_TIMESTAMP() - INTERVAL 27 MINUTE,
                    en_route_at   = UTC_TIMESTAMP() - INTERVAL 24 MINUTE
 WHERE dispatch_id = 13;
UPDATE dispatch SET dispatched_at = UTC_TIMESTAMP() - INTERVAL 9 MINUTE
 WHERE dispatch_id = 14;

-- Keep each live dispatch's parent incident just ahead of its dispatch,
-- so the response-time metric stays coherent and non-negative.
UPDATE incident SET created_at = UTC_TIMESTAMP() - INTERVAL 58 MINUTE, updated_at = UTC_TIMESTAMP() - INTERVAL 36 MINUTE WHERE incident_id = 17;
UPDATE incident SET created_at = UTC_TIMESTAMP() - INTERVAL 33 MINUTE, updated_at = UTC_TIMESTAMP() - INTERVAL 24 MINUTE WHERE incident_id = 18;
UPDATE incident SET created_at = UTC_TIMESTAMP() - INTERVAL 15 MINUTE, updated_at = UTC_TIMESTAMP() - INTERVAL  9 MINUTE WHERE incident_id = 19;

-- The three still-pending incidents: recent enough to look like an
-- unattended queue, staggered so they do not all share one timestamp.
UPDATE incident SET created_at = UTC_TIMESTAMP() - INTERVAL 47 MINUTE, updated_at = UTC_TIMESTAMP() - INTERVAL 47 MINUTE WHERE incident_id = 20;
UPDATE incident SET created_at = UTC_TIMESTAMP() - INTERVAL 21 MINUTE, updated_at = UTC_TIMESTAMP() - INTERVAL 21 MINUTE WHERE incident_id = 21;
UPDATE incident SET created_at = UTC_TIMESTAMP() - INTERVAL  4 MINUTE, updated_at = UTC_TIMESTAMP() - INTERVAL  4 MINUTE WHERE incident_id = 22;

-- Unread inbound SMS should look like it just arrived, so the SMS
-- Monitor unread badge is meaningful.
UPDATE sms_log SET created_at = UTC_TIMESTAMP() - INTERVAL 12 MINUTE, received_at = UTC_TIMESTAMP() - INTERVAL 12 MINUTE
 WHERE direction = 'inbound' AND read_at IS NULL AND log_id = (SELECT * FROM (SELECT MAX(log_id) FROM sms_log WHERE direction='inbound' AND read_at IS NULL) t);
