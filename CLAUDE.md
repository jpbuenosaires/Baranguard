# Baranguard — Project Context

This file auto-loads into every Claude Code session opened in this repo.
Read the imported files below before doing anything — they are the
source of truth for schema, API, roles, screens, and this project's own
build discipline (pick exactly ONE "Today's cut" item per session, confirm
architectural decisions before writing code, never invent fields/routes/
roles not listed).

@docs/Baranguard_Master_Reference_FINAL .md
@docs/Baranguard_Sprint_Prompts.md
@backend/DEVLOG.md
@docs/HANDOFF.md

## Working directory

The user's actual working environment is **`C:\xampp\htdocs\baranguard`**,
not `Videos\Baranguard` directly. As of 2026-09-03 that path is a real
NTFS junction (`mklink /J`) pointing at
`C:\Users\Jayson Buenosaires\Videos\Baranguard` — confirmed via `fsutil
reparsepoint query` (reparse tag Mount Point) and a full recursive diff
(299 files on both sides, zero differences). It is the SAME physical
files under two paths, not a copy — there is no sync step and no risk of
drift between them.

Practical consequences:
- Prefer `C:\xampp\htdocs\baranguard\...` in anything shown to the user
  (paths, URLs, instructions) — that's the location they think in terms
  of. A session's actual shell `cwd` may still open at `Videos\Baranguard`
  (set by however Claude Code was launched, which nothing in this file
  controls) — that's fine, both roots resolve to identical files, so it
  doesn't matter which one a command is run from.
- `http://localhost/baranguard/web/` (Apache, port 80) serves the web
  dashboard through this same junction. `mobile/` and `docs/` are
  browsable there too but do NOT run as a served app — `mobile/` needs
  Vite's dev server (`npm run dev` inside `mobile/`) or a real device
  build; see `backend/DEVLOG.md`'s "htdocs" session for why (its
  `<base href="/">` and raw `.tsx` entry point break under plain static
  serving).
- A repo-root `.htaccess` blocks `.git`, `.claude`, and any dotfile from
  ever being served — do not remove it if this junction still exists.
- `backend/` is a separate Apache vhost on port 8081 (DocumentRoot =
  `backend/public` directly) — unrelated to the htdocs junction, unaffected
  by any of the above.

## Current status

See `docs/HANDOFF.md` — it is the up-to-date, single-page snapshot of
where the project stands (what's done, what's blocked, what the
recommended next step is) and is updated at the end of every session.
`backend/DEVLOG.md` remains the full narrative history behind every
decision; `docs/Baranguard_Sprint_Prompts.md` remains the per-sprint
"Today's cut" menus. Treat a stale `HANDOFF.md` the same as a stale
DEVLOG claim per this project's own rule: verify against the actual repo
state before trusting it, and update it before ending a session that
changed the picture it describes.
