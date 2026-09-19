-- 0022: auth_session.session_kind — web vs registered-device sessions.
--
-- Architecture decision 2026-09-19 (DEVLOG 2026-09-19 (7), user-confirmed):
-- the Tanod app gets shift-friendly sessions (24h sliding, 7-day absolute
-- cap from issued_at) while the web dashboard keeps its 15-minute sliding
-- token. Which policy applies is fixed at login and recorded here — never
-- inferred later from the JWT alone (AuthMiddleware treats the DB row as
-- authoritative, same as expires_at/revoked_at). Existing rows are web:
-- every session issued before this migration was a 15-minute one.
ALTER TABLE auth_session
    ADD COLUMN session_kind ENUM('web','device') NOT NULL DEFAULT 'web' AFTER user_agent;
