# Baranguard — Project Context

Purpose: short project context, auto-loaded each session.
Status / Last updated: 2026-11-09.

Baranguard is an offline-first barangay dispatch, GPS and SOS system
(PHP 8.2 API in `backend/`, vanilla-JS dashboard in `web/`, Ionic React +
Capacitor app in `mobile/`). Scope is the thesis defense, ISO/IEC 25010
evaluation and UAT; it is not deployed at a barangay. Confirm architectural
decisions with the user before writing code.

**The `docs/` folder and `backend/DEVLOG.md` were removed from the repo
2026-11-09** (manuscript is in Google Docs; the rest was moved to a folder
outside the repo). Code comments were cleaned of citations to them on the
same date; any that remain are historical. The schema, API, role and rule
references lived there: don't invent a field,
route, role or state transition from memory; read the code (`backend/routes/*.php`,
`backend/migrations/`) or ask the user for the external docs folder. Recover
the old files with `git log --diff-filter=D -- docs/ backend/DEVLOG.md`.

## Key facts and rules (condensed from the removed reference)

**Fixed:** four barangays, Dao=1, Binanuahan=2, Marifosque=3, Banuyo=4.
Stack: PHP 8.2 API under `/api/v1/*`, MariaDB 10.4 (XAMPP), vanilla-JS web
with no bundler, Ionic React 9 + Capacitor 8.5 mobile with encrypted SQLite.
No AI anywhere.

**Roles:** Admin = the Chief Tanod (dispatch, GPS, scheduler, users, audit).
Secretary = records custodian and back-up dispatcher. Punong Barangay =
oversight plus approvals. Tanod = mobile only. Lupon = no account. Approval
authority is an Admin-managed attribute on the user, not a role.

**Removed — do not rebuild without an explicit new decision:** the Electronic
Blotter and the whole AI/Ollama pipeline (migration 0029), Fatigue Flags
(0042; the 12 h/day scheduled-hours cap stays), the Citizen Reports inbox,
and in-app signature tracking (reports are printed and signed on paper,
0041). Baranguard keeps no case registry or blotter and is not integrated
with DILG BIMS.

**Rules that bite:**

1. `raw_narrative` never leaves the system: not in FCM, SMS, logs or audit
   metadata. Only `GET /incidents/:id` returns it, to the Secretary or to an
   Admin on a web session (never the Admin phone device session).
2. Every protected endpoint checks role + tenant + ownership server-side.
   Cross-tenant is 404, never 403.
3. Idempotency: web writes send an `Idempotency-Key` header; mobile writes
   send `client_event_id` + `X-Device-Id`. A retry returns the original row.
4. Offline capture is durable: a mobile write persists to encrypted SQLite
   before the user leaves the screen, and is never shown as synced until the
   server confirms.
5. Audit metadata is allow-listed: ids and statuses only, never narrative,
   reason text, credentials, tokens, coordinates or personal data.
6. Never edit a completed migration; add a new numbered one. Migrations need
   DBA credentials (the app DB user has no ALTER/CREATE).
7. Retention periods are constants, not config; changing one needs an
   architecture review.
8. Timestamps are stored UTC and shown in Asia/Manila. Bucket days in PHP at a
   fixed +08:00, never `CONVERT_TZ()`.
9. Sessions: web is a 15-minute sliding JWT; a Tanod device session is 24 h
   sliding with a 7-day cap. `AuthMiddleware` checks `auth_session` on every
   request, so revocation is immediate.
10. No demo tells: no fabricated statistics, hardcoded identities, or
    controls that look functional and do nothing.
11. Never put server data into `innerHTML`; use `textContent` or
    `web/src/utils/escapeHtml.js`. Web styling uses design tokens only. Run
    `node web/scripts/verify-web-wiring.mjs` after any web change.

## Skills and token-saving defaults

Use ONE skill per task; don't load several that overlap.

- **Before building:** a feature or change touching more than one file →
  `/plan`, then `/build` (add `auto` only if the user says so). Bugs →
  `/test` (reproduce first). Before finishing → `/review`; for bloat
  checks `/ponytail-review`. Keep changes minimal (ponytail).
- **Mobile/web UI work:** use `impeccable` (read `.impeccable.md` if it
  exists; run `/teach-impeccable` once if not). `design-taste-frontend` is
  for public marketing pages only — not the dashboard or the mobile app.
- **Finding code:** read `C:\Users\Jayson Buenosaires\Documents\graphify-mobile-app\GRAPH_REPORT.md`
  before exploring `mobile/src`. If stale (commit differs from `git rev-parse HEAD`),
  refresh with `graphify update mobile/src` and move the new `graphify-out/`
  out of the repo. Otherwise `grep` before opening files.
- **Notes/memory:** the user's Obsidian vault is `C:\Users\Jayson Buenosaires\Documents\SecondBrain`;
  read its `Index.md` first, never the whole vault.

## Working directory

`C:\xampp\htdocs\baranguard` is an NTFS junction onto this repo (same
files, two paths, no sync step) — prefer that path in anything shown to
the user; a session's shell `cwd` may open at `Videos\Baranguard` instead,
which is fine, both resolve identically. `http://localhost/baranguard/web/`
(Apache :80) serves the web dashboard through the junction; `backend/` is
a separate vhost on :8081 (DocumentRoot `backend/public`). `mobile/` does
**not** run as a static-served app — it needs `npm run dev` or a device
build. A repo-root `.htaccess` blocks `.git`/`.claude`/dotfiles from ever
being served — don't remove it.
