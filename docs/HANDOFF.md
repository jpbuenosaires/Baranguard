# Baranguard — Session Handoff

**Last updated: 2026-09-05 (Dashboard + Login UX pass: hover tooltips,
"needs attention" banner, less-plain login page — layered on top of the
workflow-audit fixes, the Analytics/Personnel merges, the web CSS
refactor, and the full UI/UX overhaul session, all below).** Read this
to pick the project up cold. The full narrative history lives in
`backend/DEVLOG.md` (7.2k+ lines — `grep` it, don't read it). What's
left is in
`docs/REMAINING.md`.

## ⚠️ Dashboard + Login UX pass (hover tooltips, attention banner, less-plain login)

User-requested, UI/UX-only, scoped to W1 Login and W2 Admin Dashboard.
New shared component `web/src/components/Tooltip.js` (`InfoTip`) — a
CSS-only hover/focus tooltip card, no JS positioning — now annotates
every KPI card and chart/panel header on the dashboard with a one-
sentence definition of what it actually measures. Dashboard also gained
a "needs attention now" banner (pending-incident + open-SOS count, links
to Dispatch Center for Admin), a barangay-name badge next to the page
title, clickable Recent Incidents rows (previously a dead end), "View
all" links, and an empty-state CTA. Login: fixed `.login-form-panel`
painting an opaque fill that hid the body's own decorative wash (the
real cause of it reading "plain"), added a Caps Lock warning, a 4th hero
feature (AI-Assisted Redaction — the system's most distinctive real
capability, previously omitted), and swapped the footer's redundant
tagline for the 4 real barangay names. Full detail:
`backend/DEVLOG.md`'s "Dashboard + Login UX pass" entry.
**Not yet verified in-browser** (static checks only — `verify-web-wiring.mjs`
453/453, `node --check` clean) — the user asked not to use the Browser
pane this session. Worth specifically checking: tooltip panels don't
clip at a viewport edge, the attention banner's critical-vs-warning
tones render correctly in both themes, and the Caps Lock warning
actually toggles.

## ⚠️ New endpoint: `POST /citizen-reports/:id/convert` — was always speced, never built until now

A user-requested workflow audit found that Citizen Reports had **no way
to become an Incident** — a real dead end, not a known/tracked gap (it
wasn't in `docs/REMAINING.md`). The Master Reference always fully
specified this endpoint (§6) and the schema always had
`citizen_report.incident_id`/`converted_at` — it just never got
implemented, and the "list only" comments in `CitizenReportsController.php`/
`citizen-reports-inbox.js` read as an intentional boundary rather than a
gap until the audit actually checked the spec. Built now: **75 live
routes** (was 74). `incident_type` has no citizen-report equivalent, so
converting requires the Admin/Secretary to pick one via a dialog — not
defaulted silently. **Verified end-to-end against the real running
disposable preview backend via curl** (happy path, idempotent retry,
validation error, 404, cross-tenant 404 — then reverted the test data).
Full detail: `backend/DEVLOG.md`'s "Workflow audit findings #1-3" entry.

Same entry also fixed two smaller findings from the same audit: SMS
Monitor's "Linked to" column had a dead, unclickable incident reference
(now links to Blotter Detail, same destination every other incident
cross-reference in the app uses); and the Citizen Reports Inbox never
surfaced captured GPS coordinates even though the API already returned
them (added a Location column).

**Not yet verified in-browser** (frontend only — the backend endpoint
itself was curl-verified for real): the Convert dialog, the Location
column, and the SMS Monitor link are static-checked only
(`verify-web-wiring.mjs` 445/445, `node --check` clean). The user asked
not to use the Browser pane this session — open the Citizen Reports
Inbox and try converting a real report, and check the SMS Monitor link,
before assuming they render correctly.

## ⚠️ Two more screen merges this session: "Personnel" and "Analytics"

Same tabbed-screen pattern applied twice, both user-requested (not
Sprint 8 items):

- **Personnel** — the four separate W10-W13 sidebar entries (User
  Management/Shift Scheduler/Swap Requests/Fatigue Flags) are gone;
  `AppShell.js`'s `NAV_ITEMS` now has one `personnel` entry, rendering
  into `web/src/pages/personnel.js`'s own tab bar. Admin sees all four
  tabs; Punong Barangay sees only Fatigue flags, same role split each
  screen always had standalone. The two sidebar badges those items used
  to carry (`pendingSwapRequests`/`unacknowledgedFatigueFlags`) now live
  on the matching tab chip instead. **User-confirmed working** in their
  own browser check.
- **Analytics** — W5 Historical Heatmap + W9 Statistical Reports merged
  into `web/src/pages/analytics.js` (Reports/Heatmap tabs). Same role
  pair both already had (Admin, Punong Barangay read-only), so no
  per-tab gating needed, unlike Personnel. One real content change, not
  just a rename: Heatmap's "historical only, not predictive" disclosure
  (a real §9 requirement) moved from its old standalone `PageHeader`
  subtitle into a `.note` paragraph in the tab body, since the subtitle
  is now shared with Reports. **Not yet verified in-browser** — static
  checks only (`verify-web-wiring.mjs` 440/440, `node --check` on every
  touched file); the user asked not to use the Browser pane this
  session, so open the Analytics screen yourself before assuming it
  renders correctly, and specifically confirm the disclosure note shows
  above the Heatmap tab's date controls.

Two merges considered and declined, with reasoning logged in
`backend/DEVLOG.md`'s two merge entries: Incident Management + Heatmap
(different roles/intent), and the "System" group screens (SMS Monitor/
Audit Log/Service Health/Map Packages — all Admin-only but no shared
domain, would make a kitchen-sink page).

## ⚠️ Web CSS moved: `web/src/{styles,components,pages}/*.css` → `web/css/`

If you're looking for `AppShell.css`, `base.css`, etc. under `web/src/`,
they're gone — a user-requested pass moved every stylesheet into a
dedicated `web/css/` folder (`web/css/base.css`,
`web/css/components/*.css`, `web/css/pages/*.css`), `git mv`'d so
history is intact, with `web/index.html`'s `<link>` tags updated to
match. Same session also fixed a real spacing-inconsistency bug (several
near-duplicate controls — e.g. the sidebar nav item vs the Settings rail
item — were each hand-tuned to a different one-off padding instead of
sharing a token) and turned on the glassmorphism token system that
`base.css` already had defined but barely used (moderate scope: chrome/
containers only — sidebar, topbar, cards, KPI tiles, modals, dropdowns,
toasts, login hero — never tables/forms/status pills). Full detail:
`backend/DEVLOG.md`'s "Web CSS refactor" entry (the one right after this
file's last update before this).
**Not yet verified**: the authenticated dashboard's sidebar/topbar/card
glass — at the time this pass was done, the disposable preview backend
wasn't running and the real DB had no seeded users, so it was verified
by code review + a login-page browser pass only. Since then, the same
session pointed the app back at the real API and applied migrations
0008-0014 (see the banners above), so a real login is now possible —
open the dashboard and eyeball it before assuming the glass rendering
is correct.

## ✅ RESOLVED 2026-09-05: migrations 0008-0014 are now applied to the real `baranguard` DB

Both `baranguard_uiseed` (the disposable preview DB) and the real
workstation `baranguard` DB now have 0001-0014 applied — verified by
`DESCRIBE`ing `incident`/`blotter_record`/`user`/`sms_log` and confirming
`system_settings` exists (0 rows, as expected — nothing has saved a
setting through the UI yet). **Gotcha hit along the way**: the app's own
`baranguard_app` DB user has no `ALTER`/`CREATE TABLE` privilege
(`ERROR 1142`) — migrations had to run as `root` (no password on this
XAMPP install), same DBA-credentials pattern the restore drill already
uses. Now recorded in `docs/REFERENCE.md` §8. The exact commands used
(for the next machine that needs this):
```bash
mysql -uroot baranguard < backend/migrations/0008_incident_party_fields.sql
mysql -uroot baranguard < backend/migrations/0009_blotter_case_status.sql
mysql -uroot baranguard < backend/migrations/0010_incident_location_description.sql
mysql -uroot baranguard < backend/migrations/0011_user_suspension.sql
mysql -uroot baranguard < backend/migrations/0012_system_settings.sql
mysql -uroot baranguard < backend/migrations/0013_sms_manual_send.sql
mysql -uroot baranguard < backend/migrations/0014_incident_display_id.sql
```
Every statement in these files is `ADD COLUMN IF NOT EXISTS`-guarded, so
re-running any of them is a safe no-op — confirmed by the first attempt
(as `baranguard_app`) failing on migration 0008's very first statement,
i.e. before anything was written, so the retry as `root` started clean.
Each migration also has a matching `.down.sql` if a rollback is ever
needed.

**0012 (`system_settings`) is a deliberate, user-authorized override**
of `docs/REFERENCE.md` §7's W21 blocker ("no schema/endpoints for system
settings; gateway credentials must never live in a settings row") —
narrowly scoped to `sms_gateway.api_key`/`sms_gateway.sender_name` only.
It does NOT extend to `DEVICE_SECRET_MASTER_KEY`, `INTERNAL_SERVICE_TOKEN`,
`JWT_SECRET`, or `FCM_SERVICE_ACCOUNT_PATH` — those stay in `.env`. See
migration 0012's own header comment and `backend/DEVLOG.md`'s Phase 6-7
entry for the full reasoning. **`docs/REFERENCE.md` §7 has not yet been
edited to reflect this override** — do that before Sprint 8 sign-off, or
flag it as an open reference/implementation mismatch.

---

## ⚠️ `web/.htaccess` now exists — disables JS/CSS caching

Added this session (see DEVLOG's "Dispatch/Incident Management/GIS UX
pass" entry) after this app's total lack of `Cache-Control` headers made
edited `.js`/`.css` files silently keep serving pre-edit content for
hours in-browser, surviving even a reload. If you ever want normal
caching back for a real deployment, this is the file to reconsider —
it's a dev-experience fix, not something the plan that added it
originally asked for.

---

## ✅ RESOLVED 2026-09-05: web app reverted to the real API, migrations now applied

`web/index.html` again reads
`window.BARANGUARD_API_BASE_URL = 'http://127.0.0.1:8081/api/v1'` — the
real vhost, not the disposable preview backend. The UI/UX-preview
arc that used a fake week of data on a disposable `baranguard_uiseed`
DB (port 8140) is over; that disposable DB may still exist on this
workstation but the app no longer points at it. Real `baranguard` was
never touched by the preview itself, and now has migrations 0008-0014
applied for real (see the banner above) — so logging in against it
exercises the actual production schema, not seeded fake data.
**If `baranguard_uiseed` and its port-8140 PHP process are still
lingering and nobody needs them anymore**, they're safe to drop/kill;
full history of how that preview was set up is in `backend/DEVLOG.md`'s
"UI/UX preview" entries, kept for context, not as a live instruction.

---

## Where things stand

**Sprints 0–7 are complete and pushed** (`main`, latest `95c27ec`).
Working tree currently has substantial uncommitted changes — nothing
from this multi-session UI/UX arc has been committed yet. In
chronological order: a Live Map real-tiles wiring pass, a W10 follow-up
adding user creation, the temporary `web/index.html` fake-data-preview
override (see above), a sidebar redesign, the Electronic Blotter
party-fields feature (migration 0008), a Dispatch Center/Incident
Management/GIS Live Tracking UX pass (inline detail+dispatch pane,
dispatch-from-map), and — this session's main body — a **25-gap full
UI/UX overhaul** covering Incident Management, Dispatch Center,
Electronic Blotter, SMS Monitor, User Management, and Settings
(migrations 0009-0014; see `backend/DEVLOG.md`'s "Full UI/UX overhaul,
Phase 1-3/4-5/6-7/8-9" entries for the complete per-phase detail). Note:
the user is also concurrently editing web UI files via a separate tool
(Antigravity) in some sessions — re-check a file's current state before
editing it further.

Sprint 7 closed on 2026-09-04 with the most thorough verification in the
project's history: **446 checks across seven suites against real XAMPP,
zero failures**, plus a 12/12 restore drill against the real database.
Web wiring is now **457/457** (was 373/373 at Sprint 7 close; climbed
through 411 → 429 → 439 → 443 → 453 → 457 across the sessions since,
each step logged in `backend/DEVLOG.md` — the highest number is always
the current one, earlier counts are superseded, not regressions).
**Migrations now go up to `0014`** — see the warning banner above; only
the disposable `baranguard_uiseed` DB has all of them applied.

### What's new this session (25-gap overhaul), by screen

- **Incident Management**: server-side search (`q=`), status-label
  mapping (pending→Active, dispatched→Responding), Admin-only Resolve
  button, `location_description` field, complainant/respondent/contact
  fields on the creation form (ported from the AI-extraction pipeline's
  own widget).
- **Dispatch Center**: incident markers on the live map with an
  Assign-from-map popup, a map legend, real Tanod names in the Active
  Dispatches table (was `Tanod #{id}`).
- **Electronic Blotter**: real `case_status` (active/under_investigation/
  settled/resolved — migration 0009) replacing a synthesized pill, a
  forward-only transition control on the amend form (added and verified
  at the very end of this session — see the Phase 8-9 DEVLOG entry for
  why it was a late-caught gap), `BLT-YYYY-NNN`/`INC-YYYY-NNN` display
  IDs (migration 0014, new finalizes/creates only — existing seeded
  rows keep showing `#N`, never backfilled), server-side search, Export
  CSV wire-up.
- **SMS Monitor** (renamed from "SMS Activity Log", Admin-only):
  rescoped from read-only to a 3-column Conversations view (contact
  list / thread with compose / Live Feed) alongside the original
  Activity Log as a second tab. Manual send and broadcast both work
  end-to-end through the real `SmsGatewayService` pipeline and log a
  real `sms_log` row — but nothing is actually delivered, since this
  workstation has no Semaphore API key configured (`failed`/
  `SEMAPHORE_NOT_CONFIGURED` is the honest, expected outcome, surfaced
  in the UI, not hidden).
- **User Management**: 3-way status (Active/Suspended/Inactive,
  migration 0011) with independent Suspend/Deactivate actions, real
  Last Login column (`MAX(auth_session.issued_at)`, no new column
  needed), `StatStrip` role summary, search. Also fixed a **pre-existing
  bug** (not introduced this session): the Name/Username columns were
  silently blank in production due to a missing `switch` case in
  `renderUserCell()`.
- **Settings**: two new Admin-only sections, General and SMS Gateway
  (migration 0012 — see the override warning above), alongside the
  existing Profile/Password/Appearance sections unchanged.

**Deliberately dropped from the original 25-gap plan** (each disclosed
in DEVLOG at the time, not silently applied): a decorative "Barangay"
column on User Management (every row would show the same value — the
list is already tenant-scoped); a cross-tenant "All Barangays" SMS
broadcast scope (would be the only tenant-isolation hole in the app);
accepting an arbitrary client-supplied phone number for manual SMS send
(recipient must resolve to a real in-tenant contact); Settings sections
beyond General/SMS Gateway (Notifications/Security/GIS/Backup — no
backing schema or endpoints exist for these, and §2 Rule 6 forbids a
control that looks functional and does nothing); mobile auto
reverse-geocoding for `location_description` (separate Ionic/React
stack, device-unverified, out of scope for a web-only session).

| Sprint | State |
|---|---|
| 0 Schema/bootstrap/backup | ✅ verified |
| 1 Web command center | ✅ verified |
| 2 Mobile core | ✅ code + browser; **device-unverified** |
| 3 GPS/sync | ⚠️ coded, **no dedicated verify script** |
| 4 Notifications/SMS/SOS | ✅ backend verified; mobile SOS now wired, all mobile device-unverified |
| 5 AI queue/health | ⚠️ coded; **model never called** |
| 6 Redaction/blotter/Lupon | ✅ 112/112; dataset + model run outstanding |
| 7 Retention/audit/pen-test/backup/W17-W20-W9 | ✅ 446 checks |
| 8 UAT | not started |

---

## The three things most likely to bite you

1. **Migrations 0007 through 0014 must all be applied before this
   session's features will work against the real DB.** None of 0008-0014
   have touched the real `baranguard` database — only `baranguard_uiseed`.
   `DevicesController` 500s without 0007 alone. The full 25-gap overhaul
   (case_status, location_description, user suspension, system_settings,
   sms manual send, display_id) will 500 or silently no-op against the
   real DB until 0008-0014 are applied in order — see the warning banner
   at the top of this file for the exact commands.

2. **The model has never been called.** Every AI claim is verified
   against SQL-seeded rows and a deliberately dead Ollama port. Whether
   the redaction is any *good* is completely unmeasured — that needs the
   200-record dataset (`docs/AI_Evaluation_Dataset_Guide.md`) and a
   machine that can run SEA-LION. `backend/.env` also needs the
   `OLLAMA_*` keys added by hand on any new machine.

3. **SOS is now wired (this session) but still device-unverified.** M2's
   button calls `POST /tanod-sos` online-first and falls back to the
   offline queue on a network failure, draining via `/sync/batch` — code
   compiles clean (`tsc --noEmit`) but has never run on a real device or
   emulator. Same A1 blocker as the rest of mobile.

---

## Recommended next step

1. **Commit this session's work** (nothing from the entire UI/UX arc is
   committed yet — see "Where things stand" above) — or explicitly
   decide to keep iterating uncommitted first. Review `git status`/`git
   diff` before doing so; this session touched a large number of files
   across backend and frontend.
2. **Apply migrations 0008-0014 to the real `baranguard` DB** (see the
   warning banner at the top) once ready to point the app back at the
   real API — required before any of this session's features work
   outside the disposable preview.
3. **Reconcile `docs/REFERENCE.md` §7's W21 blocker** with migration
   0012's deliberate override (system_settings now exists, narrowly for
   SMS Gateway credentials) — the reference doc hasn't been edited to
   reflect this yet.
4. Independently and in parallel: **the 200-record AI evaluation
   dataset** (needs people, not machines, blocks the longest chain in
   the project), and **mobile auto reverse-geocoding** for
   `location_description` (deferred this session — needs a real Android
   device, see `docs/REMAINING.md`).

Full ordered list with reasoning: **`docs/REMAINING.md`**.

---

## Operational quick reference

```bash
# Retention (dry-run FIRST on real data — deletion is irreversible by design)
php backend/scripts/retention-job.php --dry-run
php backend/scripts/retention-job.php --list

# Restore drill (records the drill; W20 shows "Never" until you run it)
BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh

# AI worker
cd backend && php scripts/ai-worker.php --status

# Web wiring check — run after ANY web change
node web/scripts/verify-web-wiring.mjs
```

Neither the retention job nor the restore drill is **scheduled** — both
are CLI-only by design; wiring them to Task Scheduler is an outstanding
runbook step.

---

## Environment notes

- Real working directory is `C:\xampp\htdocs\baranguard` — an NTFS
  junction onto this repo (same physical files, no sync step). Prefer
  that path in anything shown to the user.
- Web dashboard: `http://localhost/baranguard/web/` (Apache, port 80).
  API: separate vhost on port 8081 (DocumentRoot = `backend/public`).
- XAMPP MySQL isn't always running —
  `tasklist //FI "IMAGENAME eq mysqld.exe"`, start with
  `cmd //c "C:\xampp\mysql_start.bat"`.
- The rest (Apache `Authorization` header, `.env` precedence, empty
  `DB_PASSWORD`, `cygpath`, Windows short paths) is in
  `docs/REFERENCE.md` §8.

---

## Conventions

Commits: `[SprintN] Short description`, ending with the
`Co-Authored-By:` line the current session instructions specify.

Update this file at the end of any session that changes the picture it
describes — a stale HANDOFF is treated as a stale DEVLOG claim: verify
against the repo before trusting it.
