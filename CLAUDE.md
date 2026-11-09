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
outside the repo). Comments in code that mention `docs/...` or DEVLOG are
historical. The
schema, API, role and rule references lived there: don't invent a field,
route, role or state transition from memory; read the code (`backend/routes/*.php`,
`backend/migrations/`) or ask the user for the external docs folder. Recover
the old files with `git log --diff-filter=D -- docs/ backend/DEVLOG.md`.

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
