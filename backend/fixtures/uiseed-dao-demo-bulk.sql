-- ============================================================
-- uiseed-dao-demo-bulk.sql — part 2 of the Barangay Dao demo seed
-- (volume). Run AFTER uiseed-dao-demo.sql, BEFORE uiseed-dao-demo-audit.sql
-- and uiseed-dao-demo-refresh-live.sql. DISPOSABLE DB ONLY.
--
-- PURPOSE: the hand-curated main seed (22 incidents / 14 dispatches,
-- 2026-07-26 to 2026-09-06) is deliberately small so every row can be
-- read and reasoned about. That is too thin to make Analytics/trend
-- screens and the 7/30/90-day range presets look like a real six
-- months of barangay activity. This file ADDS incident_id 23..118 and
-- dispatch_id 15..69, dated 2026-02-05 through 2026-07-25 (just
-- before the hand-curated window begins), at a similar reporting
-- density (~1 incident every 1-3 days). It does not TRUNCATE anything
-- — it assumes uiseed-dao-demo.sql just ran and left incident_id/
-- dispatch_id 1-22/1-14 in place. Re-running this file without
-- re-running the main file first will hit duplicate-key errors.
--
-- These 96 rows are PROCEDURALLY GENERATED from a small set of
-- narrative templates, a fixed name pool (reusing the main file's
-- surnames — realistic for a ~2,485-person barangay where households
-- share family names), and a weighted incident_type distribution
-- matching the schema's actual enum (migrations/0001_baseline_schema.sql).
-- All are status='resolved' (they predate the hand-curated 'still open'
-- tail) so they don't fight the main file's pending/dispatched rows.
-- Coordinates stay within ~550m of the Dao centroid (12.9223, 123.6725),
-- same bound the main file uses. redacted_narrative/redaction_approved_*
-- are left NULL throughout, matching the main file's own pattern (only
-- incidents 1-2 there went through AI redaction — most incidents never
-- do). display_id continues the INC-2026-NNN sequence from the main
-- file numerically, NOT chronologically (these rows are backdated
-- before 001-022) — a cosmetic-only inconsistency, disclosed rather
-- than hidden, since nothing in the schema enforces display_id order.
-- No blotter/citizen_report/sms_log rows are added for these — in a
-- real barangay most incidents never become a formal blotter case or a
-- citizen-report/SMS thread, which is exactly why the main file's own
-- 22 incidents only produced 8 blotter records and 9 citizen reports.
-- ============================================================

INSERT INTO incident
 (incident_id, barangay_id, reported_by, incident_type, priority, raw_narrative, redacted_narrative, redaction_approved_by, redaction_approved_at,
  status, source, latitude, longitude, created_at, client_event_id, updated_at, legal_hold,
  complainant_name, respondent_name, complainant_contact_number, location_description, display_id)
VALUES
 (23, 1, 1,'theft','normal',
  'A mobile phone reported missing from Farm-to-market road, west side; complainant Marissa Villamor noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','web',12.9241900,123.6743300,'2026-02-08 01:00:00',UUID(),'2026-02-08 12:40:00',0,
  'Marissa Villamor',NULL,'09175550200','Farm-to-market road, west side','INC-2026-023'),

 (24, 1, 6,'medical_emergency','critical',
  'Elderly resident collapsed at Purok 3, market area, family requesting immediate assistance.',
  NULL,NULL,NULL,'resolved','web',12.9174400,123.6680200,'2026-02-10 01:00:00',UUID(),'2026-02-10 21:34:00',0,
  'Feliza Grafil',NULL,'09175550201','Purok 3, market area','INC-2026-024'),

 (25, 1, 1,'traffic_incident','high',
  'Motorcycle skidded along Purok 5, riverside path. Rider has minor injuries, conscious.',
  NULL,NULL,NULL,'resolved','web',12.9250900,123.6760900,'2026-02-11 15:00:00',UUID(),'2026-02-11 21:53:00',0,
  'Remedios Espino',NULL,'09175550202','Purok 5, riverside path','INC-2026-025'),

 (26, 1, 6,'domestic_dispute','high',
  'Family dispute reported at Purok 4, riverside; complainant requesting a Tanod to check on the household.',
  NULL,NULL,NULL,'resolved','web',12.9257700,123.6684300,'2026-02-14 05:00:00',UUID(),'2026-02-14 11:37:00',0,
  'Pacifico Escandor',NULL,'09175550203','Purok 4, riverside','INC-2026-026'),

 (27, 1, 5,'domestic_dispute','high',
  'Neighbour reports a loud argument between spouses at Purok 1, sari-sari store corner. No injuries reported at time of call.',
  NULL,NULL,NULL,'resolved','web',12.9257200,123.6718600,'2026-02-16 17:00:00',UUID(),'2026-02-16 23:22:00',0,
  'Concepcion Grafil','Domingo Barcelona','09175550204','Purok 1, sari-sari store corner','INC-2026-027'),

 (28, 1, 1,'physical_injury','high',
  'Altercation reported at Purok 5, second house from the corner. One party has a minor injury.',
  NULL,NULL,NULL,'resolved','web',12.9188300,123.6748100,'2026-02-18 22:00:00',UUID(),'2026-02-19 05:28:00',0,
  'Anonymous neighbour',NULL,NULL,'Purok 5, second house from the corner','INC-2026-028'),

 (29, 1, 5,'theft','normal',
  'Complainant Herminio Frasco reports a mobile phone taken from Purok 6, near the creek crossing overnight.',
  NULL,NULL,NULL,'resolved','sms',12.9232400,123.6700800,'2026-02-21 01:00:00',UUID(),'2026-02-21 06:40:00',0,
  'Herminio Frasco','Josefina Villamor','09175550206','Purok 6, near the creek crossing','INC-2026-029'),

 (30, 1, 1,'traffic_incident','high',
  'Motorcycle skidded along Footbridge near Purok 6. Rider has minor injuries, conscious.',
  NULL,NULL,NULL,'resolved','web',12.9178000,123.6745000,'2026-02-22 23:00:00',UUID(),'2026-02-23 06:32:00',0,
  'Domingo Hamor',NULL,'09175550207','Footbridge near Purok 6','INC-2026-030'),

 (31, 1, 4,'disturbance','normal',
  'Complainant Ramil Ubaldo reports shouting and loud music at Dao junction street light.',
  NULL,NULL,NULL,'resolved','web',12.9247300,123.6697000,'2026-02-24 10:00:00',UUID(),'2026-02-25 10:31:00',0,
  'Ramil Ubaldo',NULL,'09175550208','Dao junction street light','INC-2026-031'),

 (32, 1, 1,'theft','normal',
  'Complainant Consolacion Guarin reports three laying hens taken from Footbridge near Purok 6 overnight.',
  NULL,NULL,NULL,'resolved','web',12.9250600,123.6711900,'2026-02-25 14:00:00',UUID(),'2026-02-25 20:01:00',0,
  'Consolacion Guarin',NULL,'09175550209','Footbridge near Purok 6','INC-2026-032'),

 (33, 1, 1,'theft','normal',
  'Complainant Pacifico Ferrer reports a motorcycle helmet taken from Covered court, Purok 4 overnight.',
  NULL,NULL,NULL,'resolved','web',12.9226100,123.6755900,'2026-02-26 08:00:00',UUID(),'2026-02-26 14:52:00',0,
  'Pacifico Ferrer',NULL,'09175550210','Covered court, Purok 4','INC-2026-033'),

 (34, 1, 4,'theft','normal',
  'Complainant Armando Elcano reports a bicycle taken from Footbridge near Purok 6 overnight.',
  NULL,NULL,NULL,'resolved','web',12.9209600,123.6697900,'2026-02-28 12:00:00',UUID(),'2026-03-01 09:39:00',0,
  'Armando Elcano','Benedicto Barcelona','09175550211','Footbridge near Purok 6','INC-2026-034'),

 (35, 1, 4,'medical_emergency','critical',
  'Elderly resident collapsed at Dao junction street light, family requesting immediate assistance.',
  NULL,NULL,NULL,'resolved','web',12.9211900,123.6760600,'2026-03-01 14:00:00',UUID(),'2026-03-01 19:25:00',0,
  'Flordeliza Ubaldo',NULL,'09175550212','Dao junction street light','INC-2026-035'),

 (36, 1, 5,'theft','normal',
  'Complainant Nicanor Bonifacio reports a motorcycle helmet taken from Waiting shed, national road overnight.',
  NULL,NULL,NULL,'resolved','web',12.9249700,123.6742300,'2026-03-02 22:00:00',UUID(),'2026-03-03 08:12:00',0,
  'Nicanor Bonifacio',NULL,'09175550213','Waiting shed, national road','INC-2026-036'),

 (37, 1, 4,'animal_complaint','normal',
  'Loose carabao wandering near Dao junction street light, creating a hazard for motorists.',
  NULL,NULL,NULL,'resolved','web',12.9245800,123.6747500,'2026-03-04 11:00:00',UUID(),'2026-03-05 16:42:00',0,
  'Rodel Ferrer',NULL,'09175550214','Dao junction street light','INC-2026-037'),

 (38, 1, 1,'theft','normal',
  'Complainant Remedios Lodovice reports a motorcycle helmet taken from Waiting shed, national road overnight.',
  NULL,NULL,NULL,'resolved','web',12.9220200,123.6704900,'2026-03-06 13:00:00',UUID(),'2026-03-07 10:42:00',0,
  'Remedios Lodovice',NULL,'09175550215','Waiting shed, national road','INC-2026-038'),

 (39, 1, 1,'disturbance','normal',
  'Neighbours reported a loud drinking session at Barangay hall perimeter wall past midnight.',
  NULL,NULL,NULL,'resolved','app',12.9240500,123.6732800,'2026-03-07 23:00:00',UUID(),'2026-03-09 00:14:00',0,
  'Bayani Barcelona',NULL,'09175550216','Barangay hall perimeter wall','INC-2026-039'),

 (40, 1, 6,'domestic_dispute','high',
  'Family dispute reported at Purok 2, corner house; complainant requesting a Tanod to check on the household.',
  NULL,NULL,NULL,'resolved','app',12.9209800,123.6706900,'2026-03-09 13:00:00',UUID(),'2026-03-09 22:17:00',0,
  'Ferdinand Dichoso','Flordeliza Bonifacio','09175550217','Purok 2, corner house','INC-2026-040'),

 (41, 1, 1,'traffic_incident','high',
  'Two vehicles sideswiped near the elementary school gate. No serious injuries reported.',
  NULL,NULL,NULL,'resolved','web',12.9179200,123.6737100,'2026-03-11 08:00:00',UUID(),'2026-03-11 13:48:00',0,
  'Bienvenido Frasco',NULL,'09175550218','Near the elementary school gate','INC-2026-041'),

 (42, 1, 4,'disturbance','normal',
  'Neighbours reported a loud drinking session at Multipurpose hall grounds past midnight.',
  NULL,NULL,NULL,'resolved','web',12.9252900,123.6725300,'2026-03-13 01:00:00',UUID(),'2026-03-13 13:47:00',0,
  'Cielo Barcelona',NULL,'09175550219','Multipurpose hall grounds','INC-2026-042'),

 (43, 1, 5,'disturbance','normal',
  'Neighbours reported a loud drinking session at Purok 4, riverside past midnight.',
  NULL,NULL,NULL,'resolved','app',12.9245600,123.6697400,'2026-03-14 03:00:00',UUID(),'2026-03-14 14:28:00',0,
  'Marissa Dichoso',NULL,'09175550220','Purok 4, riverside','INC-2026-043'),

 (44, 1, 4,'animal_complaint','normal',
  'Loose carabao wandering near Purok 2, corner house, creating a hazard for motorists.',
  NULL,NULL,NULL,'resolved','web',12.9227200,123.6710400,'2026-03-16 03:00:00',UUID(),'2026-03-17 04:46:00',0,
  'Josefina Grafil',NULL,'09175550221','Purok 2, corner house','INC-2026-044'),

 (45, 1, 4,'disturbance','normal',
  'Neighbours reported a loud drinking session at Purok 4, riverside past midnight.',
  NULL,NULL,NULL,'resolved','sms',12.9261900,123.6680000,'2026-03-18 14:00:00',UUID(),'2026-03-19 01:20:00',0,
  'Salvacion Escandor',NULL,'09175550222','Purok 4, riverside','INC-2026-045'),

 (46, 1, 4,'fire','critical',
  'Small cooking fire reported at Day care center, Purok 1. Neighbours helping contain it.',
  NULL,NULL,NULL,'resolved','web',12.9175200,123.6743100,'2026-03-20 16:00:00',UUID(),'2026-03-20 17:53:00',0,
  'Analiza Espino',NULL,'09175550223','Day care center, Purok 1','INC-2026-046'),

 (47, 1, 6,'theft','normal',
  'A mobile phone reported missing from Purok 3, along the barangay road; complainant Angelina Espino noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','app',12.9199100,123.6748800,'2026-03-22 07:00:00',UUID(),'2026-03-22 17:24:00',0,
  'Angelina Espino',NULL,'09175550224','Purok 3, along the barangay road','INC-2026-047'),

 (48, 1, 6,'vandalism','normal',
  'Broken fixtures reported at Dao junction street light; no suspect identified yet.',
  NULL,NULL,NULL,'resolved','web',12.9188400,123.6736000,'2026-03-23 06:00:00',UUID(),'2026-03-24 00:59:00',0,
  'Herminio Ubaldo',NULL,'09175550225','Dao junction street light','INC-2026-048'),

 (49, 1, 1,'physical_injury','high',
  'Fistfight after a drinking session at Day care center, Purok 1. One sustained a cut.',
  NULL,NULL,NULL,'resolved','sms',12.9213100,123.6769700,'2026-03-24 04:00:00',UUID(),'2026-03-24 23:33:00',0,
  'Domingo Elcano','Leopoldo Guarin','09175550226','Day care center, Purok 1','INC-2026-049'),

 (50, 1, 1,'theft','normal',
  'Laundry from a clothesline reported missing from Purok 3, along the barangay road; complainant Reynaldo Lodovice noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','web',12.9228000,123.6749500,'2026-03-26 00:00:00',UUID(),'2026-03-27 03:36:00',0,
  'Reynaldo Lodovice',NULL,'09175550227','Purok 3, along the barangay road','INC-2026-050'),

 (51, 1, 1,'domestic_dispute','high',
  'Neighbour reports a loud argument between spouses at Purok 5, riverside path. No injuries reported at time of call.',
  NULL,NULL,NULL,'resolved','web',12.9238200,123.6760700,'2026-03-27 02:00:00',UUID(),'2026-03-28 02:48:00',0,
  'Cielo Villamor',NULL,'09175550228','Purok 5, riverside path','INC-2026-051'),

 (52, 1, 6,'animal_complaint','normal',
  'Stray dogs gathering at Purok 6, near the creek crossing. No bites reported.',
  NULL,NULL,NULL,'resolved','web',12.9187800,123.6704800,'2026-03-28 05:00:00',UUID(),'2026-03-28 18:44:00',0,
  'Lourdes Escandor',NULL,'09175550229','Purok 6, near the creek crossing','INC-2026-052'),

 (53, 1, 4,'domestic_dispute','high',
  'Neighbour reports a loud argument between spouses at National road, Dao junction. No injuries reported at time of call.',
  NULL,NULL,NULL,'resolved','app',12.9271200,123.6744500,'2026-03-30 03:00:00',UUID(),'2026-03-31 02:00:00',0,
  'Anonymous neighbour','Domingo Barcelona',NULL,'National road, Dao junction','INC-2026-053'),

 (54, 1, 5,'traffic_incident','high',
  'Two vehicles sideswiped near Purok 5, riverside path. No serious injuries reported.',
  NULL,NULL,NULL,'resolved','web',12.9268500,123.6728500,'2026-04-01 19:00:00',UUID(),'2026-04-02 23:47:00',0,
  'Bayani Barcelona',NULL,'09175550231','Purok 5, riverside path','INC-2026-054'),

 (55, 1, 6,'vandalism','normal',
  'Broken fixtures reported at the elementary school gate; no suspect identified yet.',
  NULL,NULL,NULL,'resolved','web',12.9209500,123.6763700,'2026-04-04 09:00:00',UUID(),'2026-04-04 19:49:00',0,
  'Reynaldo Elcano',NULL,'09175550232','Near the elementary school gate','INC-2026-055'),

 (56, 1, 1,'domestic_dispute','high',
  'Family dispute reported at Purok 5, riverside path; complainant requesting a Tanod to check on the household.',
  NULL,NULL,NULL,'resolved','app',12.9205000,123.6730700,'2026-04-05 03:00:00',UUID(),'2026-04-05 09:26:00',0,
  'Ramil Dichoso','Jaime Jaucian','09175550233','Purok 5, riverside path','INC-2026-056'),

 (57, 1, 5,'traffic_incident','high',
  'Two vehicles sideswiped near Dao junction street light. No serious injuries reported.',
  NULL,NULL,NULL,'resolved','web',12.9191000,123.6765400,'2026-04-07 12:00:00',UUID(),'2026-04-08 10:29:00',0,
  'Perlita Olayvar',NULL,'09175550234','Dao junction street light','INC-2026-057'),

 (58, 1, 1,'vandalism','normal',
  'Spray paint / property damage discovered at Purok 2, backyard pens behind the chapel this morning.',
  NULL,NULL,NULL,'resolved','web',12.9215300,123.6721700,'2026-04-10 06:00:00',UUID(),'2026-04-10 09:11:00',0,
  'Josefina Lodovice',NULL,'09175550235','Purok 2, backyard pens behind the chapel','INC-2026-058'),

 (59, 1, 5,'theft','normal',
  'A pair of rubber boots reported missing from Purok 4, riverside; complainant Perlita Bonifacio noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','web',12.9227000,123.6753800,'2026-04-12 10:00:00',UUID(),'2026-04-13 13:37:00',0,
  'Perlita Bonifacio',NULL,'09175550236','Purok 4, riverside','INC-2026-059'),

 (60, 1, 5,'theft','normal',
  'A pair of rubber boots reported missing from Day care center, Purok 1; complainant Concepcion Guarin noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','web',12.9256900,123.6713900,'2026-04-14 23:00:00',UUID(),'2026-04-15 09:45:00',0,
  'Concepcion Guarin',NULL,'09175550237','Day care center, Purok 1','INC-2026-060'),

 (61, 1, 4,'disturbance','normal',
  'Complainant Flordeliza Frasco reports shouting and loud music at Footbridge near Purok 6.',
  NULL,NULL,NULL,'resolved','app',12.9200100,123.6681900,'2026-04-17 05:00:00',UUID(),'2026-04-17 14:18:00',0,
  'Flordeliza Frasco',NULL,'09175550238','Footbridge near Purok 6','INC-2026-061'),

 (62, 1, 4,'theft','normal',
  'A water pump hose reported missing from National road, near the barangay boundary; complainant Feliza Lodovice noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','app',12.9202400,123.6747300,'2026-04-18 06:00:00',UUID(),'2026-04-19 03:43:00',0,
  'Feliza Lodovice','Armando Lodovice','09175550239','National road, near the barangay boundary','INC-2026-062'),

 (63, 1, 1,'traffic_incident','high',
  'Two vehicles sideswiped near Multipurpose hall grounds. No serious injuries reported.',
  NULL,NULL,NULL,'resolved','web',12.9272500,123.6755900,'2026-04-20 08:00:00',UUID(),'2026-04-21 06:17:00',0,
  'Cielo Ferrer',NULL,'09175550240','Multipurpose hall grounds','INC-2026-063'),

 (64, 1, 4,'other','normal',
  'Resident requests barangay assistance regarding a concern at the elementary school gate.',
  NULL,NULL,NULL,'resolved','web',12.9243000,123.6759100,'2026-04-22 12:00:00',UUID(),'2026-04-23 00:49:00',0,
  'Armando Bonifacio',NULL,'09175550241','Near the elementary school gate','INC-2026-064'),

 (65, 1, 5,'theft','normal',
  'Complainant Wilfredo Espino reports laundry from a clothesline taken from Purok 3, market area overnight.',
  NULL,NULL,NULL,'resolved','web',12.9237200,123.6771800,'2026-04-25 03:00:00',UUID(),'2026-04-25 16:26:00',0,
  'Wilfredo Espino',NULL,'09175550242','Purok 3, market area','INC-2026-065'),

 (66, 1, 6,'domestic_dispute','high',
  'Family dispute reported at Day care center, Purok 1; complainant requesting a Tanod to check on the household.',
  NULL,NULL,NULL,'resolved','app',12.9218700,123.6705200,'2026-04-27 02:00:00',UUID(),'2026-04-27 21:24:00',0,
  'Feliza Ferrer',NULL,'09175550243','Day care center, Purok 1','INC-2026-066'),

 (67, 1, 1,'vandalism','normal',
  'Spray paint / property damage discovered at Purok 4, near the basketball court this morning.',
  NULL,NULL,NULL,'resolved','web',12.9242200,123.6726800,'2026-04-28 16:00:00',UUID(),'2026-04-28 18:15:00',0,
  'Bayani Bonifacio',NULL,'09175550244','Purok 4, near the basketball court','INC-2026-067'),

 (68, 1, 1,'vandalism','normal',
  'Spray paint / property damage discovered at Purok 2, corner house this morning.',
  NULL,NULL,NULL,'resolved','sms',12.9263900,123.6681200,'2026-04-30 21:00:00',UUID(),'2026-05-01 22:50:00',0,
  'Ernesto Grafil',NULL,'09175550245','Purok 2, corner house','INC-2026-068'),

 (69, 1, 1,'vandalism','normal',
  'Broken fixtures reported at the elementary school gate; no suspect identified yet.',
  NULL,NULL,NULL,'resolved','web',12.9253300,123.6740800,'2026-05-02 07:00:00',UUID(),'2026-05-02 17:16:00',0,
  'Domingo Elcano',NULL,'09175550246','Near the elementary school gate','INC-2026-069'),

 (70, 1, 5,'traffic_incident','high',
  'Motorcycle skidded along National road, near the barangay boundary. Rider has minor injuries, conscious.',
  NULL,NULL,NULL,'resolved','app',12.9248400,123.6740700,'2026-05-03 11:00:00',UUID(),'2026-05-03 21:49:00',0,
  'Ferdinand Grafil',NULL,'09175550247','National road, near the barangay boundary','INC-2026-070'),

 (71, 1, 6,'vandalism','normal',
  'Spray paint / property damage discovered at Footbridge near Purok 6 this morning.',
  NULL,NULL,NULL,'resolved','web',12.9200000,123.6762800,'2026-05-05 08:00:00',UUID(),'2026-05-06 10:24:00',0,
  'Wilfredo Lodovice',NULL,'09175550248','Footbridge near Purok 6','INC-2026-071'),

 (72, 1, 1,'traffic_incident','high',
  'Motorcycle skidded along Purok 2, corner house. Rider has minor injuries, conscious.',
  NULL,NULL,NULL,'resolved','sms',12.9246700,123.6749400,'2026-05-07 02:00:00',UUID(),'2026-05-08 06:54:00',0,
  'Lourdes Escandor',NULL,'09175550249','Purok 2, corner house','INC-2026-072'),

 (73, 1, 5,'vandalism','normal',
  'Broken fixtures reported at Farm-to-market road, west side; no suspect identified yet.',
  NULL,NULL,NULL,'resolved','web',12.9203200,123.6707100,'2026-05-08 21:00:00',UUID(),'2026-05-09 03:35:00',0,
  'Roberto Escandor',NULL,'09175550250','Farm-to-market road, west side','INC-2026-073'),

 (74, 1, 1,'physical_injury','high',
  'Altercation reported at Multipurpose hall grounds. One party has a minor injury.',
  NULL,NULL,NULL,'resolved','web',12.9267200,123.6752200,'2026-05-10 15:00:00',UUID(),'2026-05-10 17:45:00',0,
  'Bienvenido Olayvar',NULL,'09175550251','Multipurpose hall grounds','INC-2026-074'),

 (75, 1, 1,'medical_emergency','critical',
  'Elderly resident collapsed at Footbridge near Purok 6, family requesting immediate assistance.',
  NULL,NULL,NULL,'resolved','web',12.9226100,123.6740200,'2026-05-12 20:00:00',UUID(),'2026-05-13 05:01:00',0,
  'Lourdes Jaucian',NULL,'09175550252','Footbridge near Purok 6','INC-2026-075'),

 (76, 1, 6,'domestic_dispute','high',
  'Family dispute reported at Covered court, Purok 4; complainant requesting a Tanod to check on the household.',
  NULL,NULL,NULL,'resolved','web',12.9254800,123.6688100,'2026-05-13 14:00:00',UUID(),'2026-05-14 04:32:00',0,
  'Leopoldo Escandor','Roberto Jaucian','09175550253','Covered court, Purok 4','INC-2026-076'),

 (77, 1, 5,'theft','normal',
  'A bicycle reported missing from Purok 2, corner house; complainant Armando Ubaldo noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','web',12.9241700,123.6736500,'2026-05-14 17:00:00',UUID(),'2026-05-15 17:47:00',0,
  'Armando Ubaldo',NULL,'09175550254','Purok 2, corner house','INC-2026-077'),

 (78, 1, 1,'theft','normal',
  'A motorcycle helmet reported missing from Footbridge near Purok 6; complainant Bienvenido Hamor noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','web',12.9254600,123.6767400,'2026-05-17 10:00:00',UUID(),'2026-05-17 19:20:00',0,
  'Bienvenido Hamor',NULL,'09175550255','Footbridge near Purok 6','INC-2026-078'),

 (79, 1, 1,'traffic_incident','high',
  'Motorcycle skidded along National road, Dao junction. Rider has minor injuries, conscious.',
  NULL,NULL,NULL,'resolved','app',12.9257800,123.6725300,'2026-05-20 01:00:00',UUID(),'2026-05-21 03:12:00',0,
  'Remedios Ferrer',NULL,'09175550256','National road, Dao junction','INC-2026-079'),

 (80, 1, 5,'domestic_dispute','high',
  'Neighbour reports a loud argument between spouses at Purok 5, second house from the corner. No injuries reported at time of call.',
  NULL,NULL,NULL,'resolved','web',12.9230900,123.6754900,'2026-05-22 03:00:00',UUID(),'2026-05-22 17:08:00',0,
  'Benedicto Escandor',NULL,'09175550257','Purok 5, second house from the corner','INC-2026-080'),

 (81, 1, 4,'physical_injury','high',
  'Altercation reported at Purok 5, second house from the corner. One party has a minor injury.',
  NULL,NULL,NULL,'resolved','web',12.9232200,123.6707900,'2026-05-24 19:00:00',UUID(),'2026-05-25 10:25:00',0,
  'Armando Hamor',NULL,'09175550258','Purok 5, second house from the corner','INC-2026-081'),

 (82, 1, 6,'disturbance','normal',
  'Complainant Domingo Elcano reports shouting and loud music at Purok 3, along the barangay road.',
  NULL,NULL,NULL,'resolved','app',12.9193500,123.6763100,'2026-05-27 13:00:00',UUID(),'2026-05-28 12:41:00',0,
  'Domingo Elcano',NULL,'09175550259','Purok 3, along the barangay road','INC-2026-082'),

 (83, 1, 1,'physical_injury','high',
  'Altercation reported at Purok 1, sari-sari store corner. One party has a minor injury.',
  NULL,NULL,NULL,'resolved','app',12.9253200,123.6676000,'2026-05-29 11:00:00',UUID(),'2026-05-30 01:41:00',0,
  'Anonymous neighbour',NULL,NULL,'Purok 1, sari-sari store corner','INC-2026-083'),

 (84, 1, 6,'vandalism','normal',
  'Broken fixtures reported at Barangay hall perimeter wall; no suspect identified yet.',
  NULL,NULL,NULL,'resolved','web',12.9252500,123.6686600,'2026-05-30 10:00:00',UUID(),'2026-05-30 15:11:00',0,
  'Benedicto Villamor',NULL,'09175550261','Barangay hall perimeter wall','INC-2026-084'),

 (85, 1, 1,'animal_complaint','normal',
  'Loose carabao wandering near Purok 3, market area, creating a hazard for motorists.',
  NULL,NULL,NULL,'resolved','web',12.9204200,123.6687900,'2026-06-01 06:00:00',UUID(),'2026-06-01 21:15:00',0,
  'Leopoldo Hamor',NULL,'09175550262','Purok 3, market area','INC-2026-085'),

 (86, 1, 1,'physical_injury','high',
  'Fistfight after a drinking session at Purok 4, near the basketball court. One sustained a cut.',
  NULL,NULL,NULL,'resolved','web',12.9272700,123.6743100,'2026-06-02 10:00:00',UUID(),'2026-06-03 06:13:00',0,
  'Marissa Espino','Flordeliza Hamor','09175550263','Purok 4, near the basketball court','INC-2026-086'),

 (87, 1, 4,'domestic_dispute','high',
  'Neighbour reports a loud argument between spouses at Purok 1, sari-sari store corner. No injuries reported at time of call.',
  NULL,NULL,NULL,'resolved','web',12.9214600,123.6766400,'2026-06-03 16:00:00',UUID(),'2026-06-04 05:04:00',0,
  'Feliza Espino',NULL,'09175550264','Purok 1, sari-sari store corner','INC-2026-087'),

 (88, 1, 1,'physical_injury','high',
  'Fistfight after a drinking session at Purok 6, near the creek crossing. One sustained a cut.',
  NULL,NULL,NULL,'resolved','web',12.9236400,123.6727300,'2026-06-04 14:00:00',UUID(),'2026-06-05 18:21:00',0,
  'Adoracion Barcelona',NULL,'09175550265','Purok 6, near the creek crossing','INC-2026-088'),

 (89, 1, 6,'disturbance','normal',
  'Neighbours reported a loud drinking session at Purok 5, second house from the corner past midnight.',
  NULL,NULL,NULL,'resolved','web',12.9236000,123.6721300,'2026-06-06 20:00:00',UUID(),'2026-06-07 21:05:00',0,
  'Feliza Bonifacio',NULL,'09175550266','Purok 5, second house from the corner','INC-2026-089'),

 (90, 1, 4,'traffic_incident','high',
  'Motorcycle skidded along Purok 3, market area. Rider has minor injuries, conscious.',
  NULL,NULL,NULL,'resolved','web',12.9176100,123.6720300,'2026-06-07 15:00:00',UUID(),'2026-06-08 19:57:00',0,
  'Herminio Bonifacio',NULL,'09175550267','Purok 3, market area','INC-2026-090'),

 (91, 1, 1,'domestic_dispute','high',
  'Family dispute reported at Purok 2, corner house; complainant requesting a Tanod to check on the household.',
  NULL,NULL,NULL,'resolved','web',12.9256500,123.6689900,'2026-06-08 13:00:00',UUID(),'2026-06-09 06:18:00',0,
  'Benedicto Grafil','Teofilo Bonifacio','09175550268','Purok 2, corner house','INC-2026-091'),

 (92, 1, 1,'traffic_incident','high',
  'Two vehicles sideswiped near Covered court, Purok 4. No serious injuries reported.',
  NULL,NULL,NULL,'resolved','web',12.9260300,123.6718500,'2026-06-10 23:00:00',UUID(),'2026-06-11 05:42:00',0,
  'Corazon Dichoso',NULL,'09175550269','Covered court, Purok 4','INC-2026-092'),

 (93, 1, 6,'vandalism','normal',
  'Spray paint / property damage discovered at Purok 1, sari-sari store corner this morning.',
  NULL,NULL,NULL,'resolved','web',12.9219200,123.6747900,'2026-06-11 19:00:00',UUID(),'2026-06-12 06:46:00',0,
  'Herminio Barcelona',NULL,'09175550270','Purok 1, sari-sari store corner','INC-2026-093'),

 (94, 1, 5,'vandalism','normal',
  'Broken fixtures reported at Farm-to-market road, west side; no suspect identified yet.',
  NULL,NULL,NULL,'resolved','web',12.9196700,123.6749800,'2026-06-13 14:00:00',UUID(),'2026-06-13 18:10:00',0,
  'Armando Barcelona',NULL,'09175550271','Farm-to-market road, west side','INC-2026-094'),

 (95, 1, 5,'domestic_dispute','high',
  'Neighbour reports a loud argument between spouses at Purok 5, riverside path. No injuries reported at time of call.',
  NULL,NULL,NULL,'resolved','web',12.9220100,123.6682400,'2026-06-14 18:00:00',UUID(),'2026-06-15 02:58:00',0,
  'Angelina Olayvar',NULL,'09175550272','Purok 5, riverside path','INC-2026-095'),

 (96, 1, 1,'fire','critical',
  'Small cooking fire reported at National road, near the barangay boundary. Neighbours helping contain it.',
  NULL,NULL,NULL,'resolved','web',12.9268900,123.6765800,'2026-06-16 11:00:00',UUID(),'2026-06-16 13:10:00',0,
  'Milagros Dichoso',NULL,'09175550273','National road, near the barangay boundary','INC-2026-096'),

 (97, 1, 1,'theft','normal',
  'Complainant Cielo Guarin reports laundry from a clothesline taken from Health centre frontage overnight.',
  NULL,NULL,NULL,'resolved','web',12.9195500,123.6752300,'2026-06-18 16:00:00',UUID(),'2026-06-18 21:21:00',0,
  'Cielo Guarin',NULL,'09175550274','Health centre frontage','INC-2026-097'),

 (98, 1, 1,'medical_emergency','critical',
  'Elderly resident collapsed at Farm-to-market road, west side, family requesting immediate assistance.',
  NULL,NULL,NULL,'resolved','web',12.9181900,123.6686000,'2026-06-19 17:00:00',UUID(),'2026-06-20 12:09:00',0,
  'Consolacion Bonifacio',NULL,'09175550275','Farm-to-market road, west side','INC-2026-098'),

 (99, 1, 1,'theft','normal',
  'Laundry from a clothesline reported missing from Purok 2, corner house; complainant Perlita Escandor noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','web',12.9220600,123.6763400,'2026-06-21 21:00:00',UUID(),'2026-06-22 07:57:00',0,
  'Perlita Escandor',NULL,'09175550276','Purok 2, corner house','INC-2026-099'),

 (100, 1, 4,'disturbance','normal',
  'Complainant Herminio Bonifacio reports shouting and loud music at the elementary school gate.',
  NULL,NULL,NULL,'resolved','app',12.9214200,123.6747600,'2026-06-24 06:00:00',UUID(),'2026-06-24 07:20:00',0,
  'Herminio Bonifacio',NULL,'09175550277','Near the elementary school gate','INC-2026-100'),

 (101, 1, 6,'theft','normal',
  'Laundry from a clothesline reported missing from Purok 3, along the barangay road; complainant Salvacion Lodovice noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','web',12.9263400,123.6749400,'2026-06-25 10:00:00',UUID(),'2026-06-25 14:45:00',0,
  'Salvacion Lodovice','Rosario Guarin','09175550278','Purok 3, along the barangay road','INC-2026-101'),

 (102, 1, 6,'traffic_incident','high',
  'Two vehicles sideswiped near Health centre frontage. No serious injuries reported.',
  NULL,NULL,NULL,'resolved','app',12.9207300,123.6703000,'2026-06-27 10:00:00',UUID(),'2026-06-28 11:57:00',0,
  'Milagros Lodovice',NULL,'09175550279','Health centre frontage','INC-2026-102'),

 (103, 1, 4,'vandalism','normal',
  'Spray paint / property damage discovered at Day care center, Purok 1 this morning.',
  NULL,NULL,NULL,'resolved','web',12.9226200,123.6767900,'2026-06-29 04:00:00',UUID(),'2026-06-29 07:12:00',0,
  'Rosario Elcano',NULL,'09175550280','Day care center, Purok 1','INC-2026-103'),

 (104, 1, 1,'theft','normal',
  'Complainant Marissa Hamor reports a pair of rubber boots taken from Purok 4, riverside overnight.',
  NULL,NULL,NULL,'resolved','web',12.9177900,123.6713200,'2026-06-30 08:00:00',UUID(),'2026-06-30 20:54:00',0,
  'Marissa Hamor',NULL,'09175550281','Purok 4, riverside','INC-2026-104'),

 (105, 1, 1,'other','normal',
  'Drainage / infrastructure concern reported at Purok 2, backyard pens behind the chapel.',
  NULL,NULL,NULL,'resolved','sms',12.9218200,123.6734000,'2026-07-02 22:00:00',UUID(),'2026-07-03 00:26:00',0,
  'Analiza Villamor',NULL,'09175550282','Purok 2, backyard pens behind the chapel','INC-2026-105'),

 (106, 1, 1,'traffic_incident','high',
  'Two vehicles sideswiped near Barangay hall perimeter wall. No serious injuries reported.',
  NULL,NULL,NULL,'resolved','web',12.9219500,123.6741300,'2026-07-04 01:00:00',UUID(),'2026-07-04 23:13:00',0,
  'Analiza Bonifacio',NULL,'09175550283','Barangay hall perimeter wall','INC-2026-106'),

 (107, 1, 4,'animal_complaint','normal',
  'Stray dogs gathering at Purok 2, corner house. No bites reported.',
  NULL,NULL,NULL,'resolved','web',12.9244400,123.6772700,'2026-07-06 09:00:00',UUID(),'2026-07-07 04:49:00',0,
  'Jaime Lodovice',NULL,'09175550284','Purok 2, corner house','INC-2026-107'),

 (108, 1, 5,'theft','normal',
  'A motorcycle helmet reported missing from Purok 3, along the barangay road; complainant Adoracion Barcelona noticed it gone in the morning.',
  NULL,NULL,NULL,'resolved','app',12.9239500,123.6749300,'2026-07-09 00:00:00',UUID(),'2026-07-09 10:18:00',0,
  'Adoracion Barcelona','Cielo Olayvar','09175550285','Purok 3, along the barangay road','INC-2026-108'),

 (109, 1, 1,'animal_complaint','normal',
  'Loose carabao wandering near Footbridge near Purok 6, creating a hazard for motorists.',
  NULL,NULL,NULL,'resolved','app',12.9244900,123.6737000,'2026-07-09 18:00:00',UUID(),'2026-07-10 13:30:00',0,
  'Flordeliza Bonifacio',NULL,'09175550286','Footbridge near Purok 6','INC-2026-109'),

 (110, 1, 4,'disturbance','normal',
  'Neighbours reported a loud drinking session at Farm-to-market road, west side past midnight.',
  NULL,NULL,NULL,'resolved','web',12.9208900,123.6703200,'2026-07-10 18:00:00',UUID(),'2026-07-11 06:27:00',0,
  'Ferdinand Barcelona',NULL,'09175550287','Farm-to-market road, west side','INC-2026-110'),

 (111, 1, 1,'disturbance','normal',
  'Neighbours reported a loud drinking session at Purok 1, sari-sari store corner past midnight.',
  NULL,NULL,NULL,'resolved','web',12.9236800,123.6760300,'2026-07-11 21:00:00',UUID(),'2026-07-12 17:40:00',0,
  'Leopoldo Villamor',NULL,'09175550288','Purok 1, sari-sari store corner','INC-2026-111'),

 (112, 1, 5,'missing_person','critical',
  'Family reports a relative has not returned home; last seen near Barangay hall perimeter wall.',
  NULL,NULL,NULL,'resolved','app',12.9213700,123.6760300,'2026-07-13 23:00:00',UUID(),'2026-07-14 23:52:00',0,
  'Bienvenido Dichoso',NULL,'09175550289','Barangay hall perimeter wall','INC-2026-112'),

 (113, 1, 4,'domestic_dispute','high',
  'Neighbour reports a loud argument between spouses at Multipurpose hall grounds. No injuries reported at time of call.',
  NULL,NULL,NULL,'resolved','web',12.9207200,123.6750400,'2026-07-15 23:00:00',UUID(),'2026-07-16 03:15:00',0,
  'Ramil Barcelona','Salvacion Espino','09175550290','Multipurpose hall grounds','INC-2026-113'),

 (114, 1, 1,'missing_person','critical',
  'Family reports a relative has not returned home; last seen near Dao junction street light.',
  NULL,NULL,NULL,'resolved','web',12.9245400,123.6692600,'2026-07-17 03:00:00',UUID(),'2026-07-17 08:17:00',0,
  'Analiza Elcano',NULL,'09175550291','Dao junction street light','INC-2026-114'),

 (115, 1, 6,'traffic_incident','high',
  'Motorcycle skidded along Day care center, Purok 1. Rider has minor injuries, conscious.',
  NULL,NULL,NULL,'resolved','web',12.9252300,123.6679600,'2026-07-19 08:00:00',UUID(),'2026-07-20 10:16:00',0,
  'Bienvenido Lodovice',NULL,'09175550292','Day care center, Purok 1','INC-2026-115'),

 (116, 1, 4,'theft','normal',
  'Complainant Flordeliza Elcano reports three laying hens taken from Purok 5, second house from the corner overnight.',
  NULL,NULL,NULL,'resolved','app',12.9183300,123.6747800,'2026-07-20 07:00:00',UUID(),'2026-07-20 21:30:00',0,
  'Flordeliza Elcano',NULL,'09175550293','Purok 5, second house from the corner','INC-2026-116'),

 (117, 1, 6,'disturbance','normal',
  'Complainant Ernesto Bonifacio reports shouting and loud music at Purok 4, riverside.',
  NULL,NULL,NULL,'resolved','web',12.9191700,123.6769800,'2026-07-22 15:00:00',UUID(),'2026-07-23 19:58:00',0,
  'Ernesto Bonifacio',NULL,'09175550294','Purok 4, riverside','INC-2026-117'),

 (118, 1, 6,'domestic_dispute','high',
  'Family dispute reported at Waiting shed, national road; complainant requesting a Tanod to check on the household.',
  NULL,NULL,NULL,'resolved','web',12.9183800,123.6773200,'2026-07-25 07:00:00',UUID(),'2026-07-25 23:36:00',0,
  'Anonymous neighbour','Remedios Bonifacio',NULL,'Waiting shed, national road','INC-2026-118');

-- ------------------------------------------------------------
-- DISPATCHES for the incidents above (55 of 96 got one —
-- matches the main file's own ~64% dispatch rate; not every
-- resolved incident goes through a formal Tanod dispatch).
-- ------------------------------------------------------------
INSERT INTO dispatch
 (dispatch_id, incident_id, dispatched_by, tanod_id, priority, route_status, status,
  dispatched_at, en_route_at, arrived_at, completed_at, cancelled_at, cancelled_by, created_client_request_id)
VALUES
 (15, 24, 1, 4,'critical','unavailable','completed','2026-02-10 01:07:00','2026-02-10 01:08:00','2026-02-10 01:31:00','2026-02-10 01:51:00',NULL,NULL,UUID()),
 (16, 25, 1, 6,'high','unavailable','completed','2026-02-11 15:08:00','2026-02-11 15:10:00','2026-02-11 15:37:00','2026-02-11 16:00:00',NULL,NULL,UUID()),
 (17, 26, 1, 5,'high','unavailable','completed','2026-02-14 05:02:00','2026-02-14 05:05:00','2026-02-14 05:12:00','2026-02-14 06:36:00',NULL,NULL,UUID()),
 (18, 27, 1, 6,'high','unavailable','completed','2026-02-16 17:07:00','2026-02-16 17:08:00','2026-02-16 17:20:00','2026-02-16 17:54:00',NULL,NULL,UUID()),
 (19, 29, 1, 6,'normal','unavailable','completed','2026-02-21 01:04:00','2026-02-21 01:06:00','2026-02-21 01:28:00','2026-02-21 02:27:00',NULL,NULL,UUID()),
 (20, 31, 1, 4,'normal','unavailable','completed','2026-02-24 10:08:00','2026-02-24 10:09:00','2026-02-24 10:19:00','2026-02-24 10:45:00',NULL,NULL,UUID()),
 (21, 34, 1, 10,'normal','unavailable','completed','2026-02-28 12:04:00','2026-02-28 12:07:00','2026-02-28 12:24:00','2026-02-28 13:04:00',NULL,NULL,UUID()),
 (22, 35, 1, 4,'critical','unavailable','completed','2026-03-01 14:05:00','2026-03-01 14:07:00','2026-03-01 14:16:00','2026-03-01 15:27:00',NULL,NULL,UUID()),
 (23, 38, 1, 5,'normal','unavailable','completed','2026-03-06 13:04:00','2026-03-06 13:07:00','2026-03-06 13:18:00','2026-03-06 14:24:00',NULL,NULL,UUID()),
 (24, 39, 1, 5,'normal','unavailable','completed','2026-03-07 23:08:00','2026-03-07 23:09:00','2026-03-07 23:20:00','2026-03-07 23:47:00',NULL,NULL,UUID()),
 (25, 40, 1, 4,'high','unavailable','completed','2026-03-09 13:07:00','2026-03-09 13:10:00','2026-03-09 13:31:00','2026-03-09 14:56:00',NULL,NULL,UUID()),
 (26, 41, 1, 7,'high','unavailable','completed','2026-03-11 08:03:00','2026-03-11 08:05:00','2026-03-11 08:24:00','2026-03-11 09:50:00',NULL,NULL,UUID()),
 (27, 46, 1, 5,'critical','unavailable','completed','2026-03-20 16:07:00','2026-03-20 16:10:00','2026-03-20 16:25:00','2026-03-20 16:45:00',NULL,NULL,UUID()),
 (28, 48, 1, 8,'normal','unavailable','completed','2026-03-23 06:03:00','2026-03-23 06:04:00','2026-03-23 06:28:00','2026-03-23 06:57:00',NULL,NULL,UUID()),
 (29, 49, 1, 8,'high','unavailable','completed','2026-03-24 04:04:00','2026-03-24 04:05:00','2026-03-24 04:28:00','2026-03-24 05:45:00',NULL,NULL,UUID()),
 (30, 50, 1, 8,'normal','unavailable','completed','2026-03-26 00:05:00','2026-03-26 00:07:00','2026-03-26 00:12:00','2026-03-26 01:41:00',NULL,NULL,UUID()),
 (31, 51, 1, 8,'high','unavailable','completed','2026-03-27 02:02:00','2026-03-27 02:04:00','2026-03-27 02:23:00','2026-03-27 02:48:00',NULL,NULL,UUID()),
 (32, 54, 1, 10,'high','unavailable','completed','2026-04-01 19:05:00','2026-04-01 19:06:00','2026-04-01 19:19:00','2026-04-01 19:46:00',NULL,NULL,UUID()),
 (33, 56, 1, 4,'high','unavailable','completed','2026-04-05 03:06:00','2026-04-05 03:09:00','2026-04-05 03:18:00','2026-04-05 04:11:00',NULL,NULL,UUID()),
 (34, 58, 1, 4,'normal','unavailable','completed','2026-04-10 06:07:00','2026-04-10 06:10:00','2026-04-10 06:34:00','2026-04-10 07:55:00',NULL,NULL,UUID()),
 (35, 59, 1, 8,'normal','unavailable','completed','2026-04-12 10:08:00','2026-04-12 10:09:00','2026-04-12 10:18:00','2026-04-12 11:18:00',NULL,NULL,UUID()),
 (36, 60, 1, 4,'normal','unavailable','completed','2026-04-14 23:05:00','2026-04-14 23:06:00','2026-04-14 23:13:00','2026-04-14 23:54:00',NULL,NULL,UUID()),
 (37, 64, 1, 10,'normal','unavailable','completed','2026-04-22 12:05:00','2026-04-22 12:08:00','2026-04-22 12:30:00','2026-04-22 13:26:00',NULL,NULL,UUID()),
 (38, 66, 1, 9,'high','unavailable','completed','2026-04-27 02:07:00','2026-04-27 02:08:00','2026-04-27 02:17:00','2026-04-27 02:46:00',NULL,NULL,UUID()),
 (39, 67, 1, 10,'normal','unavailable','completed','2026-04-28 16:02:00','2026-04-28 16:05:00','2026-04-28 16:33:00','2026-04-28 17:53:00',NULL,NULL,UUID()),
 (40, 69, 1, 9,'normal','unavailable','completed','2026-05-02 07:08:00','2026-05-02 07:10:00','2026-05-02 07:24:00','2026-05-02 07:51:00',NULL,NULL,UUID()),
 (41, 70, 1, 4,'high','unavailable','completed','2026-05-03 11:06:00','2026-05-03 11:09:00','2026-05-03 11:33:00','2026-05-03 12:19:00',NULL,NULL,UUID()),
 (42, 74, 1, 9,'high','unavailable','completed','2026-05-10 15:02:00','2026-05-10 15:05:00','2026-05-10 15:17:00','2026-05-10 16:19:00',NULL,NULL,UUID()),
 (43, 75, 1, 4,'critical','unavailable','completed','2026-05-12 20:04:00','2026-05-12 20:06:00','2026-05-12 20:16:00','2026-05-12 21:25:00',NULL,NULL,UUID()),
 (44, 78, 1, 5,'normal','unavailable','completed','2026-05-17 10:02:00','2026-05-17 10:04:00','2026-05-17 10:31:00','2026-05-17 11:48:00',NULL,NULL,UUID()),
 (45, 80, 1, 7,'high','unavailable','completed','2026-05-22 03:08:00','2026-05-22 03:11:00','2026-05-22 03:17:00','2026-05-22 03:43:00',NULL,NULL,UUID()),
 (46, 81, 1, 4,'high','unavailable','completed','2026-05-24 19:06:00','2026-05-24 19:08:00','2026-05-24 19:18:00','2026-05-24 19:51:00',NULL,NULL,UUID()),
 (47, 82, 1, 5,'normal','unavailable','completed','2026-05-27 13:04:00','2026-05-27 13:06:00','2026-05-27 13:20:00','2026-05-27 13:51:00',NULL,NULL,UUID()),
 (48, 84, 1, 10,'normal','unavailable','completed','2026-05-30 10:08:00','2026-05-30 10:09:00','2026-05-30 10:34:00','2026-05-30 11:54:00',NULL,NULL,UUID()),
 (49, 86, 1, 5,'high','unavailable','completed','2026-06-02 10:06:00','2026-06-02 10:08:00','2026-06-02 10:23:00','2026-06-02 11:35:00',NULL,NULL,UUID()),
 (50, 87, 1, 6,'high','unavailable','completed','2026-06-03 16:03:00','2026-06-03 16:05:00','2026-06-03 16:27:00','2026-06-03 16:48:00',NULL,NULL,UUID()),
 (51, 88, 1, 6,'high','unavailable','completed','2026-06-04 14:07:00','2026-06-04 14:09:00','2026-06-04 14:36:00','2026-06-04 15:56:00',NULL,NULL,UUID()),
 (52, 90, 1, 6,'high','unavailable','completed','2026-06-07 15:07:00','2026-06-07 15:10:00','2026-06-07 15:26:00','2026-06-07 15:52:00',NULL,NULL,UUID()),
 (53, 91, 1, 5,'high','unavailable','completed','2026-06-08 13:02:00','2026-06-08 13:03:00','2026-06-08 13:20:00','2026-06-08 14:07:00',NULL,NULL,UUID()),
 (54, 92, 1, 9,'high','unavailable','completed','2026-06-10 23:08:00','2026-06-10 23:09:00','2026-06-10 23:37:00','2026-06-11 00:16:00',NULL,NULL,UUID()),
 (55, 94, 1, 7,'normal','unavailable','completed','2026-06-13 14:07:00','2026-06-13 14:09:00','2026-06-13 14:19:00','2026-06-13 14:34:00',NULL,NULL,UUID()),
 (56, 95, 1, 8,'high','unavailable','completed','2026-06-14 18:07:00','2026-06-14 18:10:00','2026-06-14 18:26:00','2026-06-14 18:48:00',NULL,NULL,UUID()),
 (57, 96, 1, 6,'critical','unavailable','completed','2026-06-16 11:03:00','2026-06-16 11:06:00','2026-06-16 11:24:00','2026-06-16 11:54:00',NULL,NULL,UUID()),
 (58, 97, 1, 5,'normal','unavailable','completed','2026-06-18 16:03:00','2026-06-18 16:04:00','2026-06-18 16:11:00','2026-06-18 17:21:00',NULL,NULL,UUID()),
 (59, 98, 1, 8,'critical','unavailable','completed','2026-06-19 17:06:00','2026-06-19 17:08:00','2026-06-19 17:25:00','2026-06-19 17:40:00',NULL,NULL,UUID()),
 (60, 102, 1, 10,'high','unavailable','completed','2026-06-27 10:06:00','2026-06-27 10:08:00','2026-06-27 10:22:00','2026-06-27 11:05:00',NULL,NULL,UUID()),
 (61, 105, 1, 7,'normal','unavailable','completed','2026-07-02 22:06:00','2026-07-02 22:09:00','2026-07-02 22:20:00','2026-07-02 23:34:00',NULL,NULL,UUID()),
 (62, 106, 1, 7,'high','unavailable','completed','2026-07-04 01:02:00','2026-07-04 01:04:00','2026-07-04 01:25:00','2026-07-04 02:06:00',NULL,NULL,UUID()),
 (63, 107, 1, 10,'normal','unavailable','completed','2026-07-06 09:06:00','2026-07-06 09:08:00','2026-07-06 09:34:00','2026-07-06 09:54:00',NULL,NULL,UUID()),
 (64, 112, 1, 6,'critical','unavailable','completed','2026-07-13 23:08:00','2026-07-13 23:11:00','2026-07-13 23:20:00','2026-07-14 00:47:00',NULL,NULL,UUID()),
 (65, 113, 1, 4,'high','unavailable','completed','2026-07-15 23:06:00','2026-07-15 23:07:00','2026-07-15 23:34:00','2026-07-16 00:35:00',NULL,NULL,UUID()),
 (66, 114, 1, 9,'critical','unavailable','completed','2026-07-17 03:05:00','2026-07-17 03:08:00','2026-07-17 03:20:00','2026-07-17 04:40:00',NULL,NULL,UUID()),
 (67, 115, 1, 7,'high','unavailable','completed','2026-07-19 08:02:00','2026-07-19 08:05:00','2026-07-19 08:24:00','2026-07-19 09:05:00',NULL,NULL,UUID()),
 (68, 117, 1, 6,'normal','unavailable','completed','2026-07-22 15:02:00','2026-07-22 15:05:00','2026-07-22 15:29:00','2026-07-22 16:22:00',NULL,NULL,UUID()),
 (69, 118, 1, 8,'high','unavailable','completed','2026-07-25 07:07:00','2026-07-25 07:09:00','2026-07-25 07:18:00','2026-07-25 08:43:00',NULL,NULL,UUID());
