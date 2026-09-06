-- ============================================================
-- uiseed-dao-demo.sql — demo dataset for the DISPOSABLE
-- `baranguard_uiseed` database. Barangay Dao (barangay_id = 1) only.
--
-- PURPOSE: UI review and demo. This file must NEVER be run against the
-- real `baranguard` database — every screen it fills is meant to be
-- looked at, not trusted. The people, phone numbers and narratives below
-- are invented for demonstration.
--
-- COORDINATES ARE REAL. Barangay Dao, Pilar, Sorsogon sits at
-- 12.9223 N, 123.6725 E (PhilAtlas; 2020 census population 2,485,
-- elevation ~10.7 m, bordered by Banuyo, San Antonio, Santa Fe,
-- Marifosque and Guiron). Every latitude/longitude in this file is
-- within ~0.005 degrees (~550 m) of that centroid, which keeps all of
-- them inside the barangay rather than merely inside Pilar. The wider
-- 12.9186 N, 123.6667 E used as LiveMap's DEFAULT_CENTER is the
-- MUNICIPALITY centre, not Dao's — do not copy that for Dao markers.
--
-- Location descriptions are generic barangay features (hall, chapel,
-- national road, purok, riverside) rather than named businesses, so
-- nothing here asserts that a specific real establishment exists.
--
-- TIMESTAMPS ARE UTC, per working reference Rule 11. Asia/Manila is
-- UTC+8, so e.g. 2026-09-05 06:30 UTC displays as 14:30 on the console.
--
-- All demo accounts share the password: Demo@2026
-- (argon2id, matching AuthController's PASSWORD_ARGON2ID.)
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE user;
TRUNCATE TABLE incident;
TRUNCATE TABLE dispatch;
TRUNCATE TABLE blotter_record;
TRUNCATE TABLE citizen_report;
TRUNCATE TABLE duty_status;
TRUNCATE TABLE gps_track;
TRUNCATE TABLE shift_schedule;
TRUNCATE TABLE shift_swap_request;
TRUNCATE TABLE fatigue_flag;
TRUNCATE TABLE sms_log;
TRUNCATE TABLE tanod_sos;
TRUNCATE TABLE audit_log;
TRUNCATE TABLE system_settings;
TRUNCATE TABLE notification;

-- ------------------------------------------------------------
-- USERS — Barangay Dao. Deliberate spread of the three
-- independent status axes (active / suspended / inactive) so
-- Personnel > Users shows all three states.
-- ------------------------------------------------------------
SET @H = '$argon2id$v=19$m=65536,t=4,p=1$ZmYwUTFDWGpDdVhIbWhvQg$JNTncGjMGRrxGskIsG4HC9zTPdDofF/yt9sfVDAR2G8';

INSERT INTO user (user_id, barangay_id, username, password_hash, full_name, role, contact_number, is_active, is_suspended, suspended_reason, suspended_at, created_at, updated_at) VALUES
 (1, 1, 'admin.dao',      @H, 'Ramon Elcano',        'admin',           '09171234501', 1, 0, NULL, NULL, '2026-01-12 01:00:00', NULL),
 (2, 1, 'secretary.dao',  @H, 'Liwayway Ferrer',     'secretary',       '09171234502', 1, 0, NULL, NULL, '2026-01-12 01:05:00', NULL),
 (3, 1, 'kapitan.dao',    @H, 'Eduardo Grafil',      'punong_barangay', '09171234503', 1, 0, NULL, NULL, '2026-01-12 01:10:00', NULL),
 (4, 1, 'tanod.reyes',    @H, 'Jomar Reyes',         'tanod',           '09171234504', 1, 0, NULL, NULL, '2026-02-03 02:00:00', NULL),
 (5, 1, 'tanod.delacruz', @H, 'Arnel Dela Cruz',     'tanod',           '09171234505', 1, 0, NULL, NULL, '2026-02-03 02:05:00', NULL),
 (6, 1, 'tanod.gubaton',  @H, 'Marites Gubaton',     'tanod',           '09171234506', 1, 0, NULL, NULL, '2026-02-03 02:10:00', NULL),
 (7, 1, 'tanod.dichoso',  @H, 'Nestor Dichoso',      'tanod',           '09171234507', 1, 0, NULL, NULL, '2026-03-11 03:00:00', NULL),
 (8, 1, 'tanod.espinosa', @H, 'Rowena Espinosa',     'tanod',           '09171234508', 1, 0, NULL, NULL, '2026-03-11 03:05:00', NULL),
 (9, 1, 'tanod.olayvar',  @H, 'Alfredo Olayvar',     'tanod',           '09171234509', 1, 1, 'Under review following a resident complaint.', '2026-08-28 05:00:00', '2026-04-02 01:00:00', '2026-08-28 05:00:00'),
 (10,1, 'tanod.frasco',   @H, 'Percival Frasco',     'tanod',           '09171234510', 0, 0, NULL, NULL, '2026-02-20 01:00:00', '2026-07-30 07:00:00');

-- ------------------------------------------------------------
-- INCIDENTS — 22 rows spread across ~6 weeks so the 7 / 30 / 90-day
-- range presets each return a visibly different set. Types, priorities
-- and statuses are all exercised. display_id is per-barangay-per-year
-- (migration 0014), so this run is INC-2026-001..022.
-- ------------------------------------------------------------
INSERT INTO incident
 (incident_id, barangay_id, reported_by, incident_type, priority, raw_narrative, redacted_narrative, redaction_approved_by, redaction_approved_at,
  status, source, latitude, longitude, created_at, client_event_id, updated_at, legal_hold,
  complainant_name, respondent_name, complainant_contact_number, location_description, display_id)
VALUES
 (1, 1, 1,'theft','normal',
  'Complainant Rosalinda Ubaldo, 09175550101, reports three laying hens taken from her backyard pen overnight. She suspects a neighbour she named as Dante Villamor.',
  'Complainant reports three laying hens taken from a backyard pen overnight. A neighbour was named as a possible suspect.',
  2,'2026-07-27 02:10:00','resolved','web',12.9231000,123.6718000,'2026-07-26 22:40:00',UUID(),'2026-07-28 01:00:00',0,
  'Rosalinda Ubaldo','Dante Villamor','09175550101','Purok 2, backyard pens behind the chapel','INC-2026-001'),

 (2, 1, 1,'disturbance','normal',
  'Videoke session at a residence running past midnight. Several residents complained about the volume.',
  'Videoke session at a residence running past midnight. Several residents complained about the volume.',
  2,'2026-07-29 03:00:00','resolved','web',12.9215000,123.6733000,'2026-07-28 16:20:00',UUID(),'2026-07-29 03:05:00',0,
  'Benjamin Hamor',NULL,'09175550102','Purok 4, near the basketball court','INC-2026-002'),

 (3, 1, 4,'traffic_incident','high',
  'Tricycle and motorcycle collision along the national road. One rider with a leg injury, conscious and responsive.',
  NULL,NULL,NULL,'resolved','app',12.9240000,123.6729000,'2026-08-01 01:05:00',UUID(),'2026-08-01 02:30:00',0,
  'Editha Jaucian',NULL,'09175550103','National road, Dao junction','INC-2026-003'),

 (4, 1, 1,'animal_complaint','normal',
  'Stray dogs gathering near the elementary school gate at dismissal time. No bites reported.',
  NULL,NULL,NULL,'resolved','web',12.9208000,123.6716000,'2026-08-03 07:15:00',UUID(),'2026-08-04 01:00:00',0,
  'Carmelita Escandor',NULL,'09175550104','Near the elementary school gate','INC-2026-004'),

 (5, 1, 1,'vandalism','normal',
  'Spray paint on the barangay hall perimeter wall, discovered this morning.',
  NULL,NULL,NULL,'resolved','web',12.9223000,123.6725000,'2026-08-05 23:50:00',UUID(),'2026-08-06 06:00:00',0,
  'Liwayway Ferrer',NULL,'09171234502','Barangay hall perimeter wall','INC-2026-005'),

 (6, 1, 5,'physical_injury','high',
  'Fistfight between two men after a drinking session. One sustained a cut above the eye.',
  NULL,NULL,NULL,'resolved','app',12.9226000,123.6742000,'2026-08-08 13:40:00',UUID(),'2026-08-08 15:00:00',0,
  'Gloria Lodovice','Renato Barcelona','09175550105','Purok 5, riverside path','INC-2026-006'),

 (7, 1, 1,'domestic_dispute','high',
  'Loud argument between spouses reported by a neighbour. No weapons mentioned, no injuries reported at the time of the call.',
  NULL,NULL,NULL,'resolved','web',12.9250000,123.6721000,'2026-08-11 11:20:00',UUID(),'2026-08-11 12:40:00',0,
  'Anonymous neighbour',NULL,NULL,'Purok 1, near the water station','INC-2026-007'),

 (8, 1, 1,'theft','normal',
  'Bicycle taken from outside a residence while the owner was inside.',
  NULL,NULL,NULL,'resolved','web',12.9219000,123.6701000,'2026-08-13 08:05:00',UUID(),'2026-08-14 01:00:00',0,
  'Michael Guarin',NULL,'09175550106','Purok 3, along the barangay road','INC-2026-008'),

 (9, 1, 6,'medical_emergency','critical',
  'Elderly resident collapsed at home, breathing but unresponsive. Family requesting immediate transport.',
  NULL,NULL,NULL,'resolved','app',12.9235000,123.6745000,'2026-08-16 00:30:00',UUID(),'2026-08-16 01:15:00',0,
  'Teresita Frasco',NULL,'09175550107','Purok 5, second house from the corner','INC-2026-009'),

 (10,1, 1,'fire','critical',
  'Cooking fire spread to a kitchen wall. Neighbours are helping put it out. No injuries reported so far.',
  NULL,NULL,NULL,'resolved','web',12.9202000,123.6728000,'2026-08-18 09:50:00',UUID(),'2026-08-18 11:00:00',0,
  'Danilo Escandor',NULL,'09175550108','Purok 6, near the creek crossing','INC-2026-010'),

 (11,1, 1,'disturbance','normal',
  'Group drinking and shouting at the waiting shed late at night.',
  NULL,NULL,NULL,'resolved','web',12.9244000,123.6708000,'2026-08-20 15:10:00',UUID(),'2026-08-21 01:00:00',0,
  'Aurora Bonifacio',NULL,'09175550109','Waiting shed, national road','INC-2026-011'),

 (12,1, 1,'theft','normal',
  'Laundry taken from a clothesline overnight.',
  NULL,NULL,NULL,'resolved','web',12.9212000,123.6750000,'2026-08-22 21:40:00',UUID(),'2026-08-23 02:00:00',0,
  'Marilou Dichoso',NULL,'09175550110','Purok 4, riverside','INC-2026-012'),

 (13,1, 4,'traffic_incident','high',
  'Motorcycle skidded on the wet national road. Rider has abrasions, refusing transport.',
  NULL,NULL,NULL,'resolved','app',12.9238000,123.6712000,'2026-08-25 06:25:00',UUID(),'2026-08-25 07:30:00',0,
  'Jonathan Grafil',NULL,'09175550111','National road, near the barangay boundary','INC-2026-013'),

 (14,1, 1,'missing_person','critical',
  'Nine-year-old child did not return home from school. Last seen wearing a white school uniform.',
  NULL,NULL,NULL,'resolved','web',12.9223000,123.6725000,'2026-08-27 09:00:00',UUID(),'2026-08-27 11:20:00',0,
  'Elena Villamor',NULL,'09175550112','Barangay hall (reported in person)','INC-2026-014'),

 (15,1, 1,'other','normal',
  'Street light at the junction has been out for several nights. Residents are asking for repair.',
  NULL,NULL,NULL,'resolved','web',12.9240000,123.6729000,'2026-08-29 07:10:00',UUID(),'2026-08-30 01:00:00',0,
  'Ricardo Olayvar',NULL,'09175550113','Dao junction street light','INC-2026-015'),

 -- ---- recent: still open, so Dispatch Center and the dashboard have live work ----
 (16,1, 1,'domestic_dispute','high',
  'Neighbour reports shouting and the sound of items being thrown inside a residence.',
  NULL,NULL,NULL,'resolved','web',12.9229000,123.6736000,'2026-09-01 10:15:00',UUID(),'2026-09-01 11:40:00',0,
  'Anonymous neighbour',NULL,NULL,'Purok 2, corner house','INC-2026-016'),

 (17,1, 5,'theft','normal',
  'Mobile phone snatched from a resident walking along the national road.',
  NULL,NULL,NULL,'dispatched','app',12.9247000,123.6719000,'2026-09-04 08:30:00',UUID(),'2026-09-04 08:45:00',0,
  'Kristine Hamor',NULL,'09175550114','National road, near the waiting shed','INC-2026-017'),

 (18,1, 1,'disturbance','normal',
  'Ongoing argument between two vendors near the roadside stalls.',
  NULL,NULL,NULL,'dispatched','web',12.9217000,123.6740000,'2026-09-05 02:20:00',UUID(),'2026-09-05 02:35:00',0,
  'Nelia Guarin','Arturo Espino','09175550115','Roadside stalls, Purok 4','INC-2026-018'),

 (19,1, 1,'medical_emergency','critical',
  'Resident with chest pains, conscious. Family requesting assistance to reach the health centre.',
  NULL,NULL,NULL,'dispatched','web',12.9210000,123.6722000,'2026-09-06 01:05:00',UUID(),'2026-09-06 01:12:00',0,
  'Susana Barcelona',NULL,'09175550116','Purok 6, near the chapel','INC-2026-019'),

 (20,1, 1,'animal_complaint','normal',
  'Loose carabao wandering onto the national road, creating a traffic hazard.',
  NULL,NULL,NULL,'pending','web',12.9243000,123.6733000,'2026-09-06 03:40:00',UUID(),'2026-09-06 03:40:00',0,
  'Fernando Jaucian',NULL,'09175550117','National road, near the rice fields','INC-2026-020'),

 (21,1, 1,'vandalism','normal',
  'Broken bottles and damage to the waiting shed bench reported this morning.',
  NULL,NULL,NULL,'pending','web',12.9244000,123.6708000,'2026-09-06 04:25:00',UUID(),'2026-09-06 04:25:00',0,
  'Aurora Bonifacio',NULL,'09175550109','Waiting shed, national road','INC-2026-021'),

 (22,1, 6,'physical_injury','critical',
  'Altercation reported near the riverside path, one person said to be bleeding. Caller could not stay on the line.',
  NULL,NULL,NULL,'pending','app',12.9226000,123.6742000,'2026-09-06 05:50:00',UUID(),'2026-09-06 05:50:00',0,
  'Unidentified caller',NULL,NULL,'Purok 5, riverside path','INC-2026-022');

-- ------------------------------------------------------------
-- DISPATCHES — response times (incident.created_at -> arrived_at)
-- deliberately vary between ~9 and ~34 minutes so the Analytics
-- response-time metric has a real distribution, not one flat number.
-- ------------------------------------------------------------
INSERT INTO dispatch
 (dispatch_id, incident_id, dispatched_by, tanod_id, priority, route_status, status,
  dispatched_at, en_route_at, arrived_at, completed_at, cancelled_at, cancelled_by, created_client_request_id)
VALUES
 (1, 3, 1, 4,'high',    'unavailable','completed','2026-08-01 01:09:00','2026-08-01 01:11:00','2026-08-01 01:22:00','2026-08-01 02:30:00',NULL,NULL,UUID()),
 (2, 4, 1, 5,'normal',  'unavailable','completed','2026-08-03 07:22:00','2026-08-03 07:25:00','2026-08-03 07:48:00','2026-08-03 08:40:00',NULL,NULL,UUID()),
 (3, 6, 1, 6,'high',    'unavailable','completed','2026-08-08 13:46:00','2026-08-08 13:48:00','2026-08-08 13:59:00','2026-08-08 15:00:00',NULL,NULL,UUID()),
 (4, 7, 1, 4,'high',    'unavailable','completed','2026-08-11 11:26:00','2026-08-11 11:28:00','2026-08-11 11:41:00','2026-08-11 12:40:00',NULL,NULL,UUID()),
 (5, 9, 1, 7,'critical','unavailable','completed','2026-08-16 00:34:00','2026-08-16 00:35:00','2026-08-16 00:44:00','2026-08-16 01:15:00',NULL,NULL,UUID()),
 (6, 10,1, 5,'critical','unavailable','completed','2026-08-18 09:55:00','2026-08-18 09:57:00','2026-08-18 10:08:00','2026-08-18 11:00:00',NULL,NULL,UUID()),
 (7, 11,1, 8,'normal',  'unavailable','completed','2026-08-20 15:18:00','2026-08-20 15:22:00','2026-08-20 15:44:00','2026-08-20 16:20:00',NULL,NULL,UUID()),
 (8, 13,1, 4,'high',    'unavailable','completed','2026-08-25 06:31:00','2026-08-25 06:33:00','2026-08-25 06:47:00','2026-08-25 07:30:00',NULL,NULL,UUID()),
 (9, 14,1, 6,'critical','unavailable','completed','2026-08-27 09:04:00','2026-08-27 09:05:00','2026-08-27 09:14:00','2026-08-27 11:20:00',NULL,NULL,UUID()),
 (10,16,1, 7,'high',    'unavailable','completed','2026-09-01 10:21:00','2026-09-01 10:23:00','2026-09-01 10:38:00','2026-09-01 11:40:00',NULL,NULL,UUID()),
 (11,12,1, 8,'normal',  'unavailable','cancelled','2026-08-22 21:50:00',NULL,NULL,NULL,'2026-08-22 22:05:00',1,UUID()),
 -- ---- live: these three are what Dispatch Center should show as active ----
 (12,17,1, 4,'normal',  'unavailable','arrived',  '2026-09-04 08:36:00','2026-09-04 08:38:00','2026-09-04 08:52:00',NULL,NULL,NULL,UUID()),
 (13,18,1, 5,'normal',  'unavailable','en_route', '2026-09-05 02:26:00','2026-09-05 02:29:00',NULL,NULL,NULL,NULL,UUID()),
 (14,19,1, 6,'critical','unavailable','assigned', '2026-09-06 01:10:00',NULL,NULL,NULL,NULL,NULL,UUID());

-- ------------------------------------------------------------
-- BLOTTER — finalized records, case_status spread across all four
-- states. display_id is BLT-2026-NNN (migration 0014).
-- redacted_narrative on the parent incident stays NULL for the
-- walk-in-style rows: only the AI approve endpoint may write it.
-- ------------------------------------------------------------
INSERT INTO blotter_record
 (blotter_id, incident_id, barangay_id, recorded_by, approved_by, narrative_summary, finalized_at, revision_no,
  amended_at, amended_by, complainant_name, respondent_name, complainant_contact_number, case_status, display_id)
VALUES
 (1, 1, 1, 2, 2,'Reported theft of three laying hens from a backyard pen. Parties identified; settled at barangay level.','2026-07-28 01:00:00',1,NULL,NULL,'Rosalinda Ubaldo','Dante Villamor','09175550101','settled','BLT-2026-001'),
 (2, 2, 1, 2, 2,'Noise complaint regarding a videoke session past midnight. Respondent advised on the curfew ordinance.','2026-07-29 03:10:00',1,NULL,NULL,'Benjamin Hamor',NULL,'09175550102','resolved','BLT-2026-002'),
 (3, 6, 1, 2, 2,'Physical injury arising from an altercation after a drinking session. Referred for Lupon mediation.','2026-08-09 01:00:00',2,'2026-08-14 02:00:00',2,'Gloria Lodovice','Renato Barcelona','09175550105','under_investigation','BLT-2026-003'),
 (4, 7, 1, 2, 2,'Domestic dispute reported by a neighbour. Parties counselled; no complaint filed by either spouse.','2026-08-12 01:00:00',1,NULL,NULL,'Anonymous neighbour',NULL,NULL,'settled','BLT-2026-004'),
 (5, 8, 1, 2, 2,'Reported theft of a bicycle from outside a residence. Property not recovered; case remains open.','2026-08-14 02:00:00',1,NULL,NULL,'Michael Guarin',NULL,'09175550106','under_investigation','BLT-2026-005'),
 (6, 12,1, 2, 2,'Reported theft of laundry from a clothesline. Complainant declined to pursue the matter further.','2026-08-23 03:00:00',1,NULL,NULL,'Marilou Dichoso',NULL,'09175550110','settled','BLT-2026-006'),
 (7, 16,1, 2, 2,'Domestic dispute reported by a neighbour. Referred to the Lupon; first mediation scheduled.','2026-09-02 01:00:00',1,NULL,NULL,'Anonymous neighbour',NULL,NULL,'active','BLT-2026-007'),
 (8, 5, 1, 2, 2,'Vandalism of the barangay hall perimeter wall. No suspect identified; case remains open.','2026-08-07 01:00:00',1,NULL,NULL,'Liwayway Ferrer',NULL,'09171234502','active','BLT-2026-008');

-- ------------------------------------------------------------
-- CITIZEN REPORTS — public-form submissions. A mix of already
-- converted (linked to an incident) and still pending triage, so the
-- inbox's All / Pending / Converted tabs each have content.
-- ------------------------------------------------------------
INSERT INTO citizen_report
 (report_id, barangay_id, incident_id, contact_number, description, latitude, longitude, submitted_at, converted_at, retention_expires_at, legal_hold)
VALUES
 (1, 1, 4,   '09175550104','Many stray dogs near the school gate around dismissal. Worried about the children.',12.9208000,123.6716000,'2026-08-03 07:00:00','2026-08-03 07:15:00',NULL,0),
 (2, 1, 15,  '09175550113','The street light at the junction has been broken for almost a week now.',12.9240000,123.6729000,'2026-08-29 06:50:00','2026-08-29 07:10:00',NULL,0),
 (3, 1, 20,  '09175550117','There is a carabao loose on the highway, it is dangerous for motorcycles.',12.9243000,123.6733000,'2026-09-06 03:30:00','2026-09-06 03:40:00',NULL,0),
 (4, 1, NULL,'09175550120','Drainage near our purok is blocked and the water is not draining after the rain.',12.9221000,123.6748000,'2026-09-02 05:10:00',NULL,NULL,0),
 (5, 1, NULL,'09175550121','Some teenagers are drinking at the covered court late at night again.',12.9215000,123.6733000,'2026-09-03 14:20:00',NULL,NULL,0),
 (6, 1, NULL,'09175550122','Request for a copy of a barangay clearance, not sure where to ask.',12.9223000,123.6725000,'2026-09-04 01:15:00',NULL,NULL,0),
 (7, 1, NULL,'09175550123','A tricycle is parked blocking the road near the chapel every afternoon.',12.9210000,123.6722000,'2026-09-05 06:40:00',NULL,NULL,0),
 (8, 1, NULL,NULL,          'Someone is burning garbage close to the houses and the smoke is very strong.',12.9234000,123.6714000,'2026-09-05 09:05:00',NULL,NULL,0),
 (9, 1, NULL,'09175550124','The waiting shed bench was destroyed, there is broken glass around it.',12.9244000,123.6708000,'2026-09-06 04:10:00',NULL,NULL,0);

-- ------------------------------------------------------------
-- DUTY STATUS — current state per tanod. Drives the dashboard's
-- "Tanods on duty" panel and the GIS roster.
-- ------------------------------------------------------------
INSERT INTO duty_status (status_id, user_id, status, channel, client_event_id, changed_at) VALUES
 (1, 4,'on_duty',  'app',UUID(),'2026-09-06 00:00:00'),
 (2, 5,'responding','app',UUID(),'2026-09-05 02:29:00'),
 (3, 6,'responding','app',UUID(),'2026-09-06 01:10:00'),
 (4, 7,'on_duty',  'app',UUID(),'2026-09-06 00:05:00'),
 (5, 8,'off_duty', 'app',UUID(),'2026-09-05 14:00:00');

-- ------------------------------------------------------------
-- GPS TRACKS — recent points so the live map shows FRESH markers
-- (LiveMap greys a marker out once it is stale). Each tanod gets a
-- short trail; all points sit inside Dao.
-- ------------------------------------------------------------
INSERT INTO gps_track (user_id, dispatch_id, latitude, longitude, accuracy_m, recorded_at, received_at, client_event_id) VALUES
 (4, NULL,12.9236000,123.6716000,8.50,'2026-09-06 05:40:00','2026-09-06 05:40:12',UUID()),
 (4, NULL,12.9240000,123.6722000,7.20,'2026-09-06 05:47:00','2026-09-06 05:47:09',UUID()),
 (4, NULL,12.9245000,123.6728000,6.80,'2026-09-06 05:54:00','2026-09-06 05:54:11',UUID()),
 (5, 13,  12.9220000,123.6738000,9.10,'2026-09-06 05:42:00','2026-09-06 05:42:14',UUID()),
 (5, 13,  12.9218000,123.6740000,8.00,'2026-09-06 05:50:00','2026-09-06 05:50:08',UUID()),
 (5, 13,  12.9217000,123.6741000,7.50,'2026-09-06 05:56:00','2026-09-06 05:56:10',UUID()),
 (6, 14,  12.9214000,123.6726000,10.20,'2026-09-06 05:45:00','2026-09-06 05:45:15',UUID()),
 (6, 14,  12.9211000,123.6723000,9.40,'2026-09-06 05:52:00','2026-09-06 05:52:07',UUID()),
 (6, 14,  12.9210000,123.6722000,8.10,'2026-09-06 05:58:00','2026-09-06 05:58:06',UUID()),
 (7, NULL,12.9228000,123.6706000,11.00,'2026-09-06 05:41:00','2026-09-06 05:41:13',UUID()),
 (7, NULL,12.9232000,123.6702000,9.90,'2026-09-06 05:49:00','2026-09-06 05:49:10',UUID()),
 (7, NULL,12.9235000,123.6700000,8.70,'2026-09-06 05:57:00','2026-09-06 05:57:12',UUID()),
 -- an older trail for the off-duty tanod, so a STALE marker is visible too
 (8, NULL,12.9204000,123.6731000,12.50,'2026-09-05 13:40:00','2026-09-05 13:40:20',UUID()),
 (8, NULL,12.9206000,123.6734000,11.80,'2026-09-05 13:52:00','2026-09-05 13:52:18',UUID());

-- ------------------------------------------------------------
-- SHIFTS — a week either side of today, with real patrol zones.
-- One unassigned shift (user_id NULL is allowed since migration 0003)
-- so the scheduler's empty-slot case is visible.
-- ------------------------------------------------------------
INSERT INTO shift_schedule (shift_id, barangay_id, user_id, patrol_zone, start_at, end_at, created_by, version, client_request_id, updated_at) VALUES
 (1, 1, 4,'Purok 1-2 / National Road','2026-09-01 22:00:00','2026-09-02 06:00:00',1,1,UUID(),NULL),
 (2, 1, 5,'Purok 3-4 / Riverside',    '2026-09-01 22:00:00','2026-09-02 06:00:00',1,1,UUID(),NULL),
 (3, 1, 6,'Purok 5-6 / Chapel',       '2026-09-02 22:00:00','2026-09-03 06:00:00',1,1,UUID(),NULL),
 (4, 1, 7,'Purok 1-2 / National Road','2026-09-03 22:00:00','2026-09-04 06:00:00',1,1,UUID(),NULL),
 (5, 1, 8,'Purok 3-4 / Riverside',    '2026-09-04 22:00:00','2026-09-05 06:00:00',1,1,UUID(),NULL),
 (6, 1, 4,'Purok 5-6 / Chapel',       '2026-09-05 22:00:00','2026-09-06 06:00:00',1,1,UUID(),NULL),
 (7, 1, 4,'Purok 1-2 / National Road','2026-09-06 22:00:00','2026-09-07 06:00:00',1,1,UUID(),NULL),
 (8, 1, 5,'Purok 3-4 / Riverside',    '2026-09-07 22:00:00','2026-09-08 06:00:00',1,1,UUID(),NULL),
 (9, 1, 6,'Purok 5-6 / Chapel',       '2026-09-08 22:00:00','2026-09-09 06:00:00',1,1,UUID(),NULL),
 (10,1, 7,'Purok 1-2 / National Road','2026-09-09 22:00:00','2026-09-10 06:00:00',1,1,UUID(),NULL),
 (11,1, NULL,'Purok 3-4 / Riverside', '2026-09-10 22:00:00','2026-09-11 06:00:00',1,1,UUID(),NULL),
 (12,1, 8,'Purok 5-6 / Chapel',       '2026-09-11 22:00:00','2026-09-12 06:00:00',1,1,UUID(),NULL);

-- ------------------------------------------------------------
-- FATIGUE FLAGS — one acknowledged, two outstanding (the outstanding
-- count drives the Personnel tab badge).
-- ------------------------------------------------------------
INSERT INTO fatigue_flag (flag_id, user_id, shift_id, hours_worked_7day, calculation_basis, flagged_at, acknowledged_by, acknowledged_at) VALUES
 (1, 4, 7, 56.00,'scheduled_hours','2026-09-06 06:10:00',NULL,NULL),
 (2, 5, 8, 48.50,'scheduled_hours','2026-09-06 06:10:00',NULL,NULL),
 (3, 6, 9, 52.00,'scheduled_hours','2026-09-04 06:10:00',1,'2026-09-04 08:00:00');

-- ------------------------------------------------------------
-- SWAP REQUESTS — one of each status.
-- ------------------------------------------------------------
INSERT INTO shift_swap_request (request_id, requesting_user_id, shift_id, target_user_id, reason, status, requested_at, resolved_at, resolved_by, version, client_request_id) VALUES
 (1, 4, 7, 7,'Need to accompany a family member to the health centre that evening.','pending', '2026-09-05 07:30:00',NULL,NULL,1,UUID()),
 (2, 8,12, 5,'Prior commitment on that date.','approved','2026-09-03 05:10:00','2026-09-03 09:00:00',1,2,UUID()),
 (3, 6, 9, 4,'Requesting a change of zone.','denied','2026-09-02 04:00:00','2026-09-02 10:00:00',1,2,UUID());

-- ------------------------------------------------------------
-- SMS LOG — five contacts with real threads so SMS Monitor's
-- Conversations view has something to open. Nothing was actually
-- delivered (no Semaphore key on this workstation) — one outbound is
-- deliberately left 'failed' with the honest gateway reason.
-- ------------------------------------------------------------
INSERT INTO sms_log (barangay_id, sender_number, receiver_number, transport, message_type, direction, status, sent_at, received_at, failure_reason, created_at, message_body, read_at) VALUES
 (1,'09175550101','09171234501','gsm_modem','incident','inbound','received',NULL,'2026-09-04 07:55:00',NULL,'2026-09-04 07:55:00','Good morning po, may nakawan po dito sa purok 2 kagabi.','2026-09-04 08:02:00'),
 (1,'09171234501','09175550101','gsm_modem','confirmation','outbound','sent','2026-09-04 08:05:00',NULL,NULL,'2026-09-04 08:05:00','Salamat sa report. Pinadala na po namin ang tanod sa lugar.',NULL),
 (1,'09175550101','09171234501','gsm_modem','incident','inbound','received',NULL,'2026-09-04 08:20:00',NULL,'2026-09-04 08:20:00','Dumating na po sila, salamat po.','2026-09-04 08:25:00'),

 (1,'09175550114','09171234501','gsm_modem','incident','inbound','received',NULL,'2026-09-04 08:28:00',NULL,'2026-09-04 08:28:00','Nasnatch po ang cellphone ko sa may waiting shed, kanina lang po.','2026-09-04 08:31:00'),
 (1,'09171234501','09175550114','gsm_modem','dispatch','outbound','sent','2026-09-04 08:36:00',NULL,NULL,'2026-09-04 08:36:00','May tanod na po papunta sa waiting shed. Manatili po kayo sa ligtas na lugar.',NULL),
 (1,'09175550114','09171234501','gsm_modem','incident','inbound','received',NULL,'2026-09-04 09:02:00',NULL,'2026-09-04 09:02:00','Nakita po nila ako. Nagbigay na po ako ng statement.',NULL),

 (1,'09175550116','09171234501','gsm_modem','incident','inbound','received',NULL,'2026-09-06 01:02:00',NULL,'2026-09-06 01:02:00','Tulong po, masakit ang dibdib ng tatay ko, hindi po namin kayang ihatid sa health center.','2026-09-06 01:04:00'),
 (1,'09171234501','09175550116','gsm_modem','dispatch','outbound','sent','2026-09-06 01:11:00',NULL,NULL,'2026-09-06 01:11:00','Papunta na po ang tanod. Huwag po ninyong iwanan ang pasyente.',NULL),
 (1,'09175550116','09171234501','gsm_modem','incident','inbound','received',NULL,'2026-09-06 01:20:00',NULL,'2026-09-06 01:20:00','Salamat po, andito na po sila.',NULL),

 (1,'09175550117','09171234501','gsm_modem','incident','inbound','received',NULL,'2026-09-06 03:28:00',NULL,'2026-09-06 03:28:00','May kalabaw po na nakawala sa highway, delikado po sa motor.',NULL),
 (1,'09171234501','09175550117','gsm_modem','confirmation','outbound','sent','2026-09-06 03:45:00',NULL,NULL,'2026-09-06 03:45:00','Naitala na po ang report ninyo. Salamat.',NULL),

 (1,'09175550109','09171234501','gsm_modem','incident','inbound','received',NULL,'2026-09-06 04:08:00',NULL,'2026-09-06 04:08:00','Sirang-sira po ang upuan sa waiting shed, may basag na bote sa paligid.',NULL),
 (1,'09171234501','09175550109','semaphore','manual','outbound','failed',NULL,NULL,'SEMAPHORE_NOT_CONFIGURED','2026-09-06 04:30:00','Naitala na po ang report. Ipapaayos po namin ang waiting shed.',NULL),

 (1,'09171234501','09175550102','gsm_modem','priority_alert','outbound','sent','2026-09-06 06:00:00',NULL,NULL,'2026-09-06 06:00:00','PAALALA: Inaasahan ang malakas na ulan ngayong gabi. Mag-ingat po sa mga daanan na madaling bahain.',NULL),
 (1,'09171234501','09175550105','gsm_modem','priority_alert','outbound','sent','2026-09-06 06:00:00',NULL,NULL,'2026-09-06 06:00:00','PAALALA: Inaasahan ang malakas na ulan ngayong gabi. Mag-ingat po sa mga daanan na madaling bahain.',NULL),
 (1,'09171234501','09175550110','gsm_modem','priority_alert','outbound','sent','2026-09-06 06:00:00',NULL,NULL,'2026-09-06 06:00:00','PAALALA: Inaasahan ang malakas na ulan ngayong gabi. Mag-ingat po sa mga daanan na madaling bahain.',NULL);

-- ------------------------------------------------------------
-- SOS — one resolved, one still active so the dashboard's critical
-- attention banner has a reason to fire.
-- ------------------------------------------------------------
INSERT INTO tanod_sos (sos_id, user_id, barangay_id, dispatch_id, latitude, longitude, triggered_at, received_at, status, acknowledged_by, acknowledged_at, resolved_by, resolved_at, client_event_id, fallback_channel) VALUES
 (1, 6, 1, 3, 12.9226000,123.6742000,'2026-08-08 13:50:00','2026-08-08 13:50:08','resolved',1,'2026-08-08 13:51:00',1,'2026-08-08 15:00:00',UUID(),'app'),
 (2, 5, 1, 13,12.9218000,123.6740000,'2026-09-06 05:52:00','2026-09-06 05:52:06','active',NULL,NULL,NULL,NULL,UUID(),'app');

-- ------------------------------------------------------------
-- SYSTEM SETTINGS — the three non-secret general.* display keys.
-- The sms_gateway.api_key is deliberately NOT seeded: this
-- workstation has no Semaphore key, and an invented one would make
-- the Settings screen claim a capability that does not exist.
-- ------------------------------------------------------------
INSERT INTO system_settings (setting_key, setting_value, updated_at, updated_by) VALUES
 ('general.system_name','Baranguard','2026-09-06 06:00:00',1),
 ('general.municipality','Pilar','2026-09-06 06:00:00',1),
 ('general.region','Region V (Bicol)','2026-09-06 06:00:00',1);

SET FOREIGN_KEY_CHECKS = 1;
