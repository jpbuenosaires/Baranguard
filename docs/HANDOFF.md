# Baranguard — Session Handoff

**Last updated: 2026-09-05 (full UI/UX overhaul session).** Read this to
pick the project up cold. The full narrative history lives in
`backend/DEVLOG.md` (7.2k+ lines — `grep` it, don't read it). What's
left is in `docs/REMAINING.md`.

## ⚠️ Migrations now go up to 0014 — NONE of 0008-0014 are applied to the real `baranguard` DB

Only `baranguard_uiseed` (the disposable preview DB on port 8140) has
0001-0014 applied. The real workstation DB still only has 0001-0007.
Before pointing this app back at the real API (see the next section),
apply 0008-0014 in order:
```bash
mysql baranguard < backend/migrations/0008_incident_party_fields.sql
mysql baranguard < backend/migrations/0009_blotter_case_status.sql
mysql baranguard < backend/migrations/0010_incident_location_description.sql
mysql baranguard < backend/migrations/0011_user_suspension.sql
mysql baranguard < backend/migrations/0012_system_settings.sql
mysql baranguard < backend/migrations/0013_sms_manual_send.sql
mysql baranguard < backend/migrations/0014_incident_display_id.sql
```
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

## ⚠️ ACTIVE RIGHT NOW: the web app is pointed at fake data, not the real API

`web/index.html:94` currently reads
`window.BARANGUARD_API_BASE_URL = 'http://127.0.0.1:8140/api/v1'` —
**not** the real vhost (`http://127.0.0.1:8081/api/v1`). This is a
deliberate, temporary state: the user asked to preview the UI with a
week of realistic data, and asking to apply fake records to the real
`baranguard` database was declined (§2 Rule 6 — no fabricated data) in
favor of a disposable database + backend instead. Real `baranguard` was
never touched.

**If you're picking this up and the port is still 8140**: either the
user is still previewing (leave it alone), or it was left on by
mistake. To fully revert: change that one line back to `8081`, drop the
disposable `baranguard_uiseed` database, and kill whatever's listening
on port 8140 (`netstat -ano | grep 8140` → `taskkill //F //PID <pid>`).
Full details: `backend/DEVLOG.md`'s "UI/UX preview" entry (near the end).

**2026-09-05 update:** XAMPP MySQL had stopped (unrelated to this
preview — it just wasn't running), which also silently killed the
port-8140 PHP process since it depends on the DB. Restarted MySQL, and
relaunched `php -S 127.0.0.1:8140 -t backend/public` with
`DB_NAME=baranguard_uiseed DB_USER=uiseed_app` env overrides (still not
touching `backend/.env`). The original `uiseed_app` password from the
first session wasn't recorded anywhere reachable, so it was reset via
root — a throwaway credential on a throwaway DB, no impact on the real
`baranguard_app` user. Verified: `baranguard_uiseed` still has all its
seeded rows (12 users, 30 incidents), login as `admin.dao` /
`DevSeed#2026` returns 200, and the dashboard renders with seeded data
in-browser. **If MySQL or the port-8140 process isn't running when you
pick this up again**, that's just an environment restart, not data
loss — same revert/restart steps apply, and the uiseed_app password may
need resetting again the same way.

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
Web wiring is now **453/453** (was 373/373 at Sprint 7 close; climbed
through 411 → 429 → 439 → 443 → 453 across the sessions since, each
step logged in `backend/DEVLOG.md` — the highest number is always the
current one, earlier counts are superseded, not regressions).
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
