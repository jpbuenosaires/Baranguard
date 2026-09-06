-- ============================================================
-- uiseed-dao-demo-audit.sql — part 2 of the Barangay Dao demo seed.
-- Fills the Audit Log screen (W17) and the notification tables.
--
-- Run AFTER uiseed-dao-demo.sql. DISPOSABLE DB ONLY.
--
-- Every `action` / `entity_type` pair below is one the application
-- actually emits (taken from the Audit::record() call sites in
-- backend/controllers/), not an invented label — an audit trail that
-- shows actions the system cannot produce would be worse than an empty
-- one.
--
-- metadata_json stays inside the §2 Rule 8 allow-list: identifiers and
-- statuses only. No narrative, no coordinates, no names, no contact
-- numbers, no tokens.
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE audit_log;
TRUNCATE TABLE notification;
TRUNCATE TABLE notification_target;

INSERT INTO audit_log (barangay_id, actor_user_id, action, entity_type, entity_id, metadata_json, ip_address, user_agent, created_at) VALUES
 -- ---- account administration ----
 (1,1,'user_created','user',4,'{"role":"tanod"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-02-03 02:00:00'),
 (1,1,'user_created','user',5,'{"role":"tanod"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-02-03 02:05:00'),
 (1,1,'user_created','user',6,'{"role":"tanod"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-02-03 02:10:00'),
 (1,1,'user_created','user',7,'{"role":"tanod"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-03-11 03:00:00'),
 (1,1,'user_created','user',8,'{"role":"tanod"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-03-11 03:05:00'),
 (1,1,'user_status_changed','user',10,'{"is_active":false}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-07-30 07:00:00'),
 (1,1,'user_status_changed','user',9,'{"is_suspended":true}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-28 05:00:00'),

 -- ---- dispatch operations ----
 (1,1,'dispatch_created','dispatch',1,'{"incident_id":3,"tanod_id":4,"priority":"high"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-01 01:09:00'),
 (1,1,'dispatch_created','dispatch',2,'{"incident_id":4,"tanod_id":5,"priority":"normal"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-03 07:22:00'),
 (1,1,'dispatch_created','dispatch',5,'{"incident_id":9,"tanod_id":7,"priority":"critical"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-16 00:34:00'),
 (1,1,'dispatch_created','dispatch',6,'{"incident_id":10,"tanod_id":5,"priority":"critical"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-18 09:55:00'),
 (1,1,'dispatch_cancelled','dispatch',11,'{"incident_id":12,"reason_code":"complainant_withdrew"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-22 22:05:00'),
 (1,1,'dispatch_created','dispatch',9,'{"incident_id":14,"tanod_id":6,"priority":"critical"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-27 09:04:00'),
 (1,1,'dispatch_created','dispatch',12,'{"incident_id":17,"tanod_id":4,"priority":"normal"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-04 08:36:00'),
 (1,1,'dispatch_created','dispatch',13,'{"incident_id":18,"tanod_id":5,"priority":"normal"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-05 02:26:00'),
 (1,1,'dispatch_created','dispatch',14,'{"incident_id":19,"tanod_id":6,"priority":"critical"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-06 01:10:00'),
 (1,1,'dispatch_status_override','dispatch',12,'{"from":"en_route","to":"arrived"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-04 08:52:00'),

 -- ---- incident corrections (PATCH /incidents/:id — field NAMES only, never values) ----
 (1,1,'incident_updated','incident',11,'{"fields":["location_description"]}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-21 00:40:00'),
 (1,2,'incident_updated','incident',6,'{"fields":["complainant_name","priority"]}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-09 00:30:00'),
 (1,1,'incident_updated','incident',13,'{"fields":["incident_type"]}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-25 07:10:00'),

 -- ---- records custody (Secretary only) ----
 (1,2,'blotter_finalized','blotter_record',1,'{"incident_id":1}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-07-28 01:00:00'),
 (1,2,'blotter_finalized','blotter_record',2,'{"incident_id":2}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-07-29 03:10:00'),
 (1,2,'blotter_finalized','blotter_record',3,'{"incident_id":6}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-09 01:00:00'),
 (1,2,'blotter_amended','blotter_record',3,'{"revision_no":2}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-14 02:00:00'),
 (1,2,'blotter_case_status_changed','blotter_record',3,'{"from":"active","to":"under_investigation"}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-14 02:01:00'),
 (1,2,'blotter_finalized','blotter_record',4,'{"incident_id":7}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-12 01:00:00'),
 (1,2,'blotter_finalized','blotter_record',5,'{"incident_id":8}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-14 02:00:00'),
 (1,2,'blotter_case_status_changed','blotter_record',1,'{"from":"active","to":"settled"}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-15 01:00:00'),
 (1,2,'blotter_finalized','blotter_record',6,'{"incident_id":12}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-23 03:00:00'),
 (1,2,'blotter_finalized','blotter_record',7,'{"incident_id":16}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-02 01:00:00'),
 (1,2,'lupon_packet_generated','blotter_record',3,'{"revision_no":2}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-15 03:20:00'),

 -- ---- AI redaction pipeline (Secretary only) ----
 (1,2,'ai_redaction_queued','incident',1,'{"task_type":"redaction"}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-07-27 01:50:00'),
 (1,2,'ai_redaction_approved','incident',1,'{"draft_version":1}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-07-27 02:10:00'),
 (1,2,'ai_redaction_queued','incident',2,'{"task_type":"redaction"}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-07-29 02:40:00'),
 (1,2,'ai_redaction_approved','incident',2,'{"draft_version":1}','192.168.1.12','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-07-29 03:00:00'),

 -- ---- citizen reports ----
 (1,1,'citizen_report_converted','citizen_report',1,'{"incident_id":4}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-03 07:15:00'),
 (1,1,'citizen_report_converted','citizen_report',2,'{"incident_id":15}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-29 07:10:00'),
 (1,1,'citizen_report_converted','citizen_report',3,'{"incident_id":20}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-06 03:40:00'),

 -- ---- scheduling ----
 (1,1,'shift_created','shift_schedule',7,'{"user_id":4}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-31 02:00:00'),
 (1,1,'shift_created','shift_schedule',8,'{"user_id":5}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-08-31 02:01:00'),
 (1,1,'shift_updated','shift_schedule',11,'{"version":1}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-01 03:00:00'),
 (1,1,'swap_request_resolved','shift_swap_request',2,'{"status":"approved"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-03 09:00:00'),
 (1,1,'swap_request_resolved','shift_swap_request',3,'{"status":"denied"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-02 10:00:00'),
 (1,1,'fatigue_flag_acknowledged','fatigue_flag',3,'{"user_id":6}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-04 08:00:00'),

 -- ---- SOS ----
 (1,6,'tanod_sos_raised','tanod_sos',1,'{"fallback_channel":"app"}',NULL,'Baranguard-Mobile/1.0 (Android)','2026-08-08 13:50:08'),
 (1,5,'tanod_sos_raised','tanod_sos',2,'{"fallback_channel":"app"}',NULL,'Baranguard-Mobile/1.0 (Android)','2026-09-06 05:52:06'),

 -- ---- SMS ----
 (1,1,'sms_manual_sent','sms_log',13,'{"status":"failed","reason_code":"SEMAPHORE_NOT_CONFIGURED"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-06 04:30:00'),
 (1,1,'sms_broadcast_sent','user',NULL,'{"recipient_count":3,"message_type":"priority_alert"}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-06 06:00:00'),

 -- ---- reports / settings ----
 (1,1,'report_exported','report',NULL,'{"format":"pdf","range_days":30}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-05 07:30:00'),
 (1,1,'report_exported','report',NULL,'{"format":"csv","range_days":7}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-06 02:15:00'),
 (1,1,'system_settings_updated','system_settings',NULL,'{"keys":["general.system_name","general.municipality","general.region"]}','192.168.1.10','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','2026-09-06 06:00:00');

-- ------------------------------------------------------------
-- NOTIFICATIONS — one per live dispatch plus the open SOS, with
-- per-tanod targets. Mirrors what the dispatch/SOS flows would have
-- fanned out. No FCM delivery rows: nothing was actually pushed.
-- ------------------------------------------------------------
INSERT INTO notification (notification_id, barangay_id, notification_type, dispatch_id, sos_id, incident_id, created_by, created_at, expires_at) VALUES
 (1, 1,'dispatch',12,  NULL,17,  1,'2026-09-04 08:36:00',NULL),
 (2, 1,'dispatch',13,  NULL,18,  1,'2026-09-05 02:26:00',NULL),
 (3, 1,'dispatch',14,  NULL,19,  1,'2026-09-06 01:10:00',NULL),
 (4, 1,'sos',    NULL, 2,  NULL,NULL,'2026-09-06 05:52:06',NULL),
 (5, 1,'priority_alert',NULL,NULL,NULL,1,'2026-09-06 06:00:00','2026-09-07 06:00:00');

INSERT INTO notification_target (notification_id, user_id, device_id, targeted_at, acknowledged_at, ack_status) VALUES
 (1, 4,NULL,'2026-09-04 08:36:02','2026-09-04 08:37:10','acknowledged'),
 (2, 5,NULL,'2026-09-05 02:26:02','2026-09-05 02:27:40','acknowledged'),
 (3, 6,NULL,'2026-09-06 01:10:02',NULL,'pending'),
 (4, 1,NULL,'2026-09-06 05:52:08',NULL,'pending'),
 (4, 4,NULL,'2026-09-06 05:52:08',NULL,'pending'),
 (4, 7,NULL,'2026-09-06 05:52:08',NULL,'pending'),
 (5, 4,NULL,'2026-09-06 06:00:02',NULL,'not_required'),
 (5, 5,NULL,'2026-09-06 06:00:02',NULL,'not_required'),
 (5, 6,NULL,'2026-09-06 06:00:02',NULL,'not_required'),
 (5, 7,NULL,'2026-09-06 06:00:02',NULL,'not_required'),
 (5, 8,NULL,'2026-09-06 06:00:02',NULL,'not_required');

SET FOREIGN_KEY_CHECKS = 1;
