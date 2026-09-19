-- Rollback for 0022_auth_session_kind.sql.
--
-- Drops session_kind. Any live device session keeps its already-written
-- expires_at (up to 24h out) but renews on web terms from then on.
ALTER TABLE auth_session DROP COLUMN session_kind;
