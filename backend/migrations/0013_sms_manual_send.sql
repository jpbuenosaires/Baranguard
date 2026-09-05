-- ============================================================
-- 0013_sms_manual_send.sql — SMS Monitor follow-up: support for a real,
-- admin-initiated compose/reply/broadcast capability.
--
-- **This is a deliberate rescoping of a named prior decision, not a bug
-- fix.** `sms-log.js`'s own header comment states this screen "stays
-- READ-ONLY this sprint and every sprint after unless deliberately
-- rescoped" and names this exact chat/reply/broadcast direction as the
-- reason. The user explicitly asked for that rescoping during planning
-- (2026-09-05, see backend/DEVLOG.md's "Full UI/UX overhaul" entry).
--
-- Two real gaps this closes:
--   1. `sms_log` has never stored the actual message TEXT, inbound or
--      outbound, for any message type — only metadata (numbers, gateway
--      ids, status). A conversation-thread UI needs the real text to
--      show, so `message_body` is added. Existing rows stay NULL — this
--      is not backfilled/fabricated (§2 Rule 6); only NEW sends/receives
--      going forward populate it.
--   2. `message_type` had no value for a message an Admin composed
--      directly (every existing value ties to one specific automated
--      business event — a dispatch, an SOS, etc.). `'manual'` is added
--      alongside them, used only by SmsController::send()/broadcast().
--
-- `read_at` backs the SMS Monitor's "Mark Resolved" action (marks a
-- conversation thread's unread inbound rows as read) — same
-- server-timestamp-on-real-action pattern as `finalized_at`/
-- `acknowledged_at` elsewhere in this schema, not a client-set flag.
--
-- New migration, not an edit to 0001/0006 (this repo's standing
-- convention).
--
-- Idempotent: every statement is guarded, so re-running is a no-op. The
-- MODIFY COLUMN below is naturally idempotent (re-running it against an
-- identical target ENUM is a no-op), same as 0008's own ENUM widening.
-- ============================================================

ALTER TABLE sms_log
  ADD COLUMN IF NOT EXISTS message_body TEXT NULL,
  ADD COLUMN IF NOT EXISTS read_at DATETIME NULL;

ALTER TABLE sms_log
  MODIFY COLUMN message_type ENUM('incident','dispatch','priority_alert','coord_ping','confirmation','duty_status','sos','manual') NOT NULL;
