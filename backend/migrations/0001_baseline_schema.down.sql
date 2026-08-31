-- Rollback for 0001_baseline_schema.sql
-- Drop order is the exact reverse of creation order so no FK is ever
-- dropped-against before its dependent table is gone.

DROP TABLE IF EXISTS offline_map_package;
DROP TABLE IF EXISTS fatigue_flag;
DROP TABLE IF EXISTS shift_swap_request;
DROP TABLE IF EXISTS shift_schedule;
DROP TABLE IF EXISTS offline_queue;
DROP TABLE IF EXISTS ai_evaluation_run;
DROP TABLE IF EXISTS ai_processing_log;
DROP TABLE IF EXISTS sms_log;
DROP TABLE IF EXISTS gps_track;
DROP TABLE IF EXISTS duty_status;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS notification_delivery;
DROP TABLE IF EXISTS notification_target;
DROP TABLE IF EXISTS notification;
DROP TABLE IF EXISTS tanod_sos;
DROP TABLE IF EXISTS citizen_report;
DROP TABLE IF EXISTS blotter_record;
DROP TABLE IF EXISTS evidence_attachment;
DROP TABLE IF EXISTS dispatch;
DROP TABLE IF EXISTS incident;
DROP TABLE IF EXISTS mobile_device;
DROP TABLE IF EXISTS auth_session;
DROP TABLE IF EXISTS user;
DROP TABLE IF EXISTS barangay;
