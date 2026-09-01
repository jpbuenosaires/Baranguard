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

## Current status (as of 2026-09-02)

Sprint 0: done, real-XAMPP validated (19/19 checks), committed and pushed.
Sprint 1: Auth backend + middleware done (real-XAMPP validated 22/22),
and W2 Admin Dashboard + GET /reports/summary done (real-XAMPP validated
30/30). Both committed and pushed to `origin/main`.

**Done this session (Claude Code, continuing the prior Claude Desktop
session), not yet committed:** the three-item exception to "pick exactly
ONE" — W4 (GIS Live Tracking / shared LiveMap component), W3a (Dispatch
Center — pending queue + Tanod picker, read-only), and W3b (Dispatch
Center — create/cancel actions) — all built and individually validated:
`backend/scripts/verify-w3-w4-dispatch-gis.sh` 37/37 against real XAMPP,
plus a real Playwright browser walkthrough 23/23 (found and fixed a real
bug along the way — see backend/DEVLOG.md's "W4 GIS Live Tracking +
W3a/W3b" entry for both). Also fixed a real pre-existing bug found before
this cut's own work started: `web/src/styles/base.css` was referenced
everywhere but never actually committed in the W2 commit — recreated.
Added `GET /users?role=` (not originally listed below) as necessary
Tanod-picker plumbing, same precedent as W2's login page.

New backend endpoints now built: `GET /gps/live`, `GET /gps/history`,
`GET /tanod-sos`, `GET /incidents`, `GET /dispatch`, `POST /dispatch`,
`PATCH /dispatch/:id/cancel`, `GET /duty-status`, `GET /users?role=`.
New frontend: `LiveMap` shared component (vendored MapLibre GL JS,
`web/vendor/maplibre-gl/`), `AppShell` shared component, `dispatch-center.js`,
`gis-live-tracking.js`. Not yet in real-XAMPP terms needing a re-run flag
— this session's tests already ran directly against the real local XAMPP
install, not a cloud sandbox.

Still not started: `POST /dispatch/:id/status` (Tanod/Admin transitions),
notification creation on dispatch (Sprint 4), `POST /tanod-sos` +
acknowledge/resolve (Sprint 4), `POST /duty-status` (mobile M2/Sprint 2),
a barangay-metadata endpoint for real boundary polygons, real basemap
tiles for the web map. Full list in DEVLOG.md's "Not yet done" for this
entry.

Two things worth knowing before touching git in this repo:
- Three stray empty files sit in the repo root (`cls`, `git`, `main)`) —
  untracked leftovers from an old mis-pasted command, not part of any
  build. Safe to delete, just don't `git add -A`/`git add .` and sweep
  them in by accident.
- A docs reorganization (11 old fragmented `docs/*.md` files deleted, 2
  new consolidated ones added — the ones imported above) is sitting
  uncommitted in the working tree on purpose. The user wants to redo/
  re-verify it before committing, not commit it as-is — leave it alone
  unless they explicitly ask to commit it.

Git convention: commit messages as `[SprintN] Short description`
(existing repo commits omit the ticket-ID format from §4, just use
`[SprintN] ...`). This session's environment (a linked-desktop cloud
session, no direct shell on the user's machine) had every commit
message end with a `Co-Authored-By`/`Claude-Session` trailer — Claude
Code should follow whatever attribution convention it's configured with
instead, not copy that trailer verbatim.
