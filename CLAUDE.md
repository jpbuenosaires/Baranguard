# Baranguard — Project Context

This file auto-loads into every Claude Code session opened in this repo.
Read the imported files below before doing anything — they carry the
schema, API, roles, screens, and this project's own build discipline
(pick exactly ONE "Today's cut" item per session, confirm architectural
decisions before writing code, never invent fields/routes/roles not
listed).

@docs/REFERENCE.md
@docs/SPRINTS.md
@docs/HANDOFF.md
@docs/REMAINING.md

## Reading the archives (NOT auto-loaded — open deliberately)

The four files above are compact working documents, rewritten 2026-09-04
to stop every session paying ~103k tokens before doing any work. The
full originals are still in the repo and are still the authority:

- **`docs/Baranguard_Master_Reference_FINAL .md`** (16.8k words) — the
  real source of truth. `REFERENCE.md` summarises it and cites section
  numbers; open the section you need for exact wording. **If the two ever
  disagree, this file wins** and `REFERENCE.md` should be corrected.
- **`backend/DEVLOG.md`** (5.9k lines) — every decision and why, plus the
  evidence behind every claim. Still append-only: **log new work here.**
  Never read it front to back — `grep` for the feature you're touching.
- **`docs/Baranguard_Sprint_Prompts.md`** — Sprints 0–7 verbatim with
  their completion notes. `SPRINTS.md` carries only Sprint 8, the one
  still open.

Rule of thumb: `REFERENCE.md` tells you the constraint; the archives tell
you why it exists and what it cost to learn.

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

**Sprints 0–7 are complete.** Only Sprint 8 (UAT/evaluation) is open.

`docs/HANDOFF.md` is the single-page snapshot of where things stand and
what to do next; `docs/REMAINING.md` is the full ordered list of what's
left before Sprint 8, including the items blocked on hardware or accounts
the user has to provide. Both are auto-loaded above.

Treat a stale `HANDOFF.md` the same as a stale DEVLOG claim per this
project's own rule: verify against the actual repo state before trusting
it, and update it before ending a session that changed the picture it
describes. New work still gets logged in `backend/DEVLOG.md` — it stays
append-only, it just isn't auto-loaded any more.
