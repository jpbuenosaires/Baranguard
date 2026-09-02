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

**Sprint 1: fully complete** — every "Today's cut" box checked (Auth,
W2, W3a/W3b, W4, W5, W6, W9, W15, W16, W19, and the optional W11/W12/W13
scheduler+fatigue box), committed and pushed to `origin/main` as commit
`7cf8390` ("[Sprint1] Figma reskin + W5/W6/W9/W15/W16/W19 +
W11/W12/W13 scheduler/fatigue"), on top of the three earlier Sprint 1
commits (Auth, W2, W4+W3a/W3b). Full endpoint list, resolved decisions,
bugs found/fixed, and test evidence for every item live in
`backend/DEVLOG.md` — it has one entry per work session; read the
tail of it for the most recent ones rather than assuming this summary
is exhaustive.

Highlights from the last two sessions (both in `backend/DEVLOG.md`):
- A full CSS/markup reskin of the web dashboard against the real Figma
  Make design (icon system in `web/src/components/icons.js`, login
  page's two-column hero panel) — a prior CSS-only pass still looked
  visibly different; the gap turned out to be missing markup (icons,
  hero panel), not tokens.
- W5/W6/W9/W15/W16/W19 (heatmap, blotter list + web incident entry,
  fuller statistical reports, settings/change-password, citizen reports
  inbox, public citizen report intake) — first screens Secretary has
  ever reached in this web app.
- W11/W12/W13 (shift scheduler, swap requests, fatigue flags) — required
  a new migration (`backend/migrations/0003_shift_schedule_nullable_user.sql`)
  making `shift_schedule.user_id` nullable, a schema/spec conflict
  confirmed with the user before coding (§6 requires an approved
  no-target swap to leave a shift "unassigned"; the original schema
  didn't allow that).

All of it validated against real XAMPP (MariaDB 10.4.32 + PHP 8.2.12) via
disposable-DB scripts in `backend/scripts/` and real Chromium browser
walkthroughs via Playwright (throwaway, not committed) — several real
app bugs were caught and fixed by these runs, not just claimed working;
see DEVLOG.md for specifics.

**Since then (post-Sprint-1 polish, see DEVLOG.md's "real search/
system-health, UI-scale knob, Figma pixel-alignment pass" entry):**
`GET /barangays`, `GET /search`, `GET /system/health` built (the topbar
search and status badge are now real, not decorative); `officer_name`
added to `GET /incidents`; a global UI-scale mechanism
(`html{font-size:75%}` + all-rem tokens in `base.css`) replaced ad-hoc
px sizing; every list-style web screen migrated to shared `PageHeader`/
`DataTable`/`StatStrip` components against the actual Figma Make export
(run locally, not inferred from screenshots); a real thread-safety bug
(`DB_HOST` intermittently missing under Apache's threaded MPM) and a
real Apache `Authorization`-header-forwarding bug were found and fixed —
both only surfaced once running through actual Apache/XAMPP rather than
PHP's built-in dev server. **The DataTable/PageHeader page migrations
were not re-verified in a live logged-in browser this pass** (no test
credentials available to that session) — spot-check before trusting.

**Not yet started:** W7, W8, W10, W14, W17, W18, W20 web screens; all
mobile screens (Sprint 2+); `GET /reports/export` (Sprint 7);
`GET /reports/notifications-summary` + the rest of the notification data
model (Sprint 4); `POST /dispatch/:id/status`; `POST /tanod-sos` +
acknowledge/resolve (Sprint 4); `POST /duty-status` (mobile M2/Sprint 2);
a barangay-*metadata* endpoint for real boundary polygons (distinct from
the new `GET /barangays` lookup, which is just id/name); real basemap
tiles for the web map; the admin-editing-another-user half of
`PATCH /users/:id` (W10 proper); Dashboard KPI-deltas/Recent-Incidents
panels and a real axis chart (discussed, deliberately deferred — needs
backend scope nobody's approved yet); Scheduler's list and Dispatch
Center's queue cards still card-based, not `DataTable` (see DEVLOG.md).

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
