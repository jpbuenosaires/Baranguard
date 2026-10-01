# Baranguard — Session Handoff

**Replaced-in-place snapshot, not a log** — rewrite fresh each session,
never stack banners. Full history: `backend/DEVLOG.md` (grep by
date/keyword, don't read front to back). Everything older than this
snapshot (the 2026-09 audit passes, the C7/M13/GSM-gateway device
sessions, the abandoned React Native rebuild, the PHP 8.3 swap, the
Cloudflare tunnel set-up) lives in DEVLOG; only what is still true and
still actionable is kept here.

**Last updated: 2026-10-01 (after the tanod-workflow build).**

## Current state

**Tanod-workflow build (2026-10-01, DEVLOG 2026-10-01 (3)) is code-complete
and verified on disposable DBs and jsdom ONLY.** It is NOT browser-verified
by an agent (the user is doing the browser test themselves) and NOT
device-verified. Plan: `docs/FEATURE_PLAN_2026-10.md`; binding contract
(amended during review): `docs/FEATURE_CONTRACT_2026-10.md`. What exists:
availability submission and draft -> published rosters approved by an
official with `approve_roster`; monthly accomplishment reports (prepared ->
noted -> approved, with return) as the attendance path; incident referrals
(refer, never handle); Safer School Zones (school inventory = Annex B,
check-ins, per-incident C-1 fields, Annex D term report); a separate
Admin-managed approval-authority attribute on users (not a role); Approvals
inbox, Accomplishment Reports, Referral Log and Safer School Zones web
pages; Fatigue tab removed from nav (endpoints kept); mobile Availability,
Accomplishments, School check-in, Refer and C-1 inputs. Live routes 76 ->
105 (`php backend/scripts/count-routes.php`). Details: REFERENCE.md §3-§5,
§7.

**Migrations 0029, 0030, 0031, 0032, 0033 are NOT applied to `baranguard`
or `baranguard_uiseed`.** Back up first (`backend/scripts/backup.sh`), apply
in numeric order as DBA/root (`baranguard_app` has no ALTER/CREATE/DROP).
0029 drops the blotter/AI tables irreversibly; 0030 also rewrites `user`
authority columns and backfills existing shifts to `published`. Until then
the real DBs lack every new table and the new code paths will 500 against
them.

**Measured 2026-10-01 after the build (disposable DBs / jsdom):**
b2-pentest 59, device-session 20, device-signature 21, devices-map-packages
57, duty-status-map-upload 49, evidence-upload 19, f5 16, f6 8, f8 8, f9 15,
h16 30, public-transparency 17, routing 23, second-responder 25, sprint0
19, sprint1-auth 23, sprint3 43, sprint4-phase2-3 72, sprint7-audit 59,
sprint7-pentest-incidents 56, sprint7-retention 82, w2-reports 31, w3-w4
38, scheduler-fatigue 49; NEW: referrals 147, roster-accomplishment 332,
school-zones 213. sprint1-remaining, sprint4 and (later runs of)
scheduler-fatigue/roster printed `ALL CHECKS PASSED`, count not captured.
`verify-web-wiring.mjs` 733/0, `web/tests` 542/0, mobile
`verify-local-schema.mjs` 230/0 (`tsc` 1 and `lint` 18 errors are
pre-existing).

**Decisions taken (FEATURE_PLAN §2):** (1) accomplishment reports: tanod
prepares, a Chief Tanod/Kagawad/Punong Barangay notes and approves,
configurable per user via authorities, never the preparer; (2)
availability coexists with admin-created shifts, both reach tanods only
after publish; (3) server duty-sum is a suggestion, tanod's confirmed value
is stored beside it, difference > 30 min flagged; (4) Ambulance/EMS is its
own referral value, maps to Other agencies (or DOH via setting) on Annex D;
(5) Secretary kept, redefined as Records & Reports Officer; (6) Fatigue
Flags out of navigation, data kept; (7) `raw_narrative` stays on the 90-day
purge, a separate non-identifying C-1 summary is stored apart. Also: Chief
Tanod is a `official_title`, not a role.

**Open decisions (need the user / the barangay, do not guess):**
- No Kagawad role exists: a Kagawad uses a `secretary` account carrying
  authorities. Confirm that is acceptable.
- Narrative retention: every raw narrative is on the 90-day ceiling
  (no approved redaction ever exists); policy confirmation still owed.
- Retention for the new tables and `c1_*` columns is undecided and NO purge
  job was added (Rule 10; needs an architecture review and a council
  decision). Documented as "pending" in `DATA_INVENTORY.md`.
- Annex A fields and MC 2026-037 deadlines / C-1 filing frequency /
  required deployment days are unknown — needs the circular PDF from
  dilg.gov.ph. Annex B/C-1/D layouts follow the user's own forms.
- Whether an Admin may also hold `approve_*` through another account
  (segregation of duties is only enforced per-account: an Admin cannot edit
  their OWN approving authorities, but a second Admin can grant them).
- What attendance evidence the treasurer/COA actually accepts for
  honoraria, and who approves rosters in practice.

**Unresolved reviewer items NOT fixed / NOT proven:** the 12h/day cap race
and the accomplishment-report-creation deadlock fix are untested because
`php -S` is single-threaded (the user-row lock is reasoned, not
demonstrated under concurrency); the mobile discard SQL has not been run
against SQLCipher; the sync `closes_client_event_id` path and offline
availability/accomplishment flows have never run on a device. One
web/tests map test, 'SOS markers are never clustered', looks
order-sensitive (flaky); one unexplained flaky run was seen once in
`verify-roster-accomplishment.sh` earlier and did not reproduce.

**Electronic Blotter and the local-AI pipeline remain REMOVED (migration
0029, DEVLOG 2026-10-01 (1)).** Barangays keep the blotter and Lupon
records in binders; DILG BIMSS/KPIS stays the case ledger and Baranguard
complements it (REFERENCE.md §1). The Secretary role, `raw_narrative` and
party fields stayed.

**Docs reconciled 2026-10-01:** `CLAUDE.md`, `REFERENCE.md` (post-0033),
`SETUP.md`, `REMAINING.md`, `SPRINTS.md`, `DATA_INVENTORY.md` and
`PRIVACY_IMPACT_ASSESSMENT.md` (new categories only). **Still describing the
old system, not reconciled:** `Baranguard_Master_Reference_FINAL .md`,
`PRIVACY_NOTICES.md` (no notice yet for staff hours / availability /
school check-ins), `Baranguard_Sprint_Prompts.md`, `AI_Evaluation_Dataset_
Guide.md` (history). Thesis drafts: `THESIS_OBJECTIVES_ALIGNMENT.md`,
`ISO25010_EVALUATION_PLAN.md` — nothing measured yet.

**Loose ends on the workstation:** `backend/.env` may still carry
`OLLAMA_*` values, harmless; a `BaranguardAiWorker` Scheduled Task may
still be registered — `Unregister-ScheduledTask -TaskName BaranguardAiWorker
-Confirm:$false`.

## Environment and access (still true)

- **Branch**: commit and push directly to `main` (explicit user
  instruction 2026-09-22); `develop` and `feature/push-body-incident-
  label` are stale, don't build on them.
- **Credentials**: `baranguard_uiseed` password is `Demo@2026`.
  `tanod.olayvar` is seeded suspended — use `tanod.reyes` (user_id 4),
  `tanod.delacruz`, `tanod.gubaton` or `tanod.dichoso`. `admin.dao` is the
  Admin. `backend/.env` points at `baranguard_uiseed`, **not** the real
  `baranguard` DB — check `DB_NAME` before trusting any real-DB claim.
- **Public exposure**: the Cloudflare Named Tunnel `baranguard` (id
  `28c3134b-1a35-4c85-971a-0fb18f262493`, config `~/.cloudflared/
  config.yml`) fronts `https://baranguardph.win` (web) and `https://
  api.baranguardph.win` (API) from THIS machine. Because `.env` points at
  the demo DB, public visitors see demo data. No Cloudflare Access policy
  exists (deferred; if added, scope it to the web host only, never the
  API — REFERENCE.md §1). The tunnel is started by `start-baranguard.ps1`
  as a user process; it is not yet a Windows service here (needs an
  elevated `install-autostart-services.ps1`), so it does not survive a
  reboot until someone logs in and runs the launcher. The `danilyn`
  machine's `baranguard-main` tunnel is orphaned, not deleted — ask first.
- **Single point of failure**: everything assumes the workstation is on;
  only SOS has a device-local SMS fallback (REFERENCE.md Rule 27 of the
  Master Reference). UPS/backup internet is an unsolved resilience
  question.
- **SMS transport**: Semaphore is gone; a tethered Android phone
  (`sms-gateway/`, setup in its README) sends over its own SIM and the
  same phone does inbound ingestion (`gsm-ingest-daemon.php`). Needs
  `GSM_GATEWAY_ENABLED=true` and the app launched once after install.
- **Mobile build**: always set `VITE_API_BASE_URL` explicitly for a
  real-device APK (see the quick reference) — `mobile/.env.local` leaks
  `http://localhost:8081` into every bare `vite build`.

## Outstanding work (all needs a device, a credential, or a decision)

1. **Apply migrations 0029-0033 to the real DBs** (back up first, DBA/root,
   in order) and decide whether `baranguard_uiseed` or `baranguard` should back the public
   tunnel.
2. **Print/PDF visual check**: the shared print-preview modal and the
   server-generated PDFs (statistical report, PB digest) passed static
   checks only; nobody has opened a freshly generated one. (The Lupon
   packet no longer exists.) The new print layouts (accomplishment report,
   Annex B, C-1, D + signature page) are unverified visually too.
2b. **Browser pass of the tanod-workflow pages** across all four roles
   (the user is running this) and a **device pass** of the new mobile
   screens, offline-queue sync of the four new kinds, and the
   `closes_client_event_id` check-out path.
3. **Device verification still owed** (Infinix X6840): M13's `sms_failed`
   path (airplane mode / no SIM) and `SosSmsPlugin` pre-validation; the
   no-GPS SOS change (kill GPS, raise SOS, confirm it still reaches the
   server or queues); H-09 device-signature keys (confirm
   `mobile_device.device_public_key_pem` is populated and signature
   headers are actually sent); the `patrolLocationService` permission
   sequencing; FCM push end-to-end with the real `google-services.json`;
   removal of the on-device workstation-address UI; GPS moving run
   outdoors.
4. **Not done on purpose**: MFA (C-02), Cloudflare Access (above), DND
   bypass for critical alerts, privacy governance actions (DPO
   designation is a barangay-council action).
5. **Decisions/inputs owed** (see Current state): Kagawad-as-secretary
   account, retention for the new tables, narrative-retention policy, the
   MC 2026-037 circular text and Annex A, COA/treasurer attendance
   evidence. No retention purge exists for the new tables.
6. **Thesis evaluation**: run the measurements in
   `docs/ISO25010_EVALUATION_PLAN.md`; nothing is claimed until they exist.

Full ordered backlog with reasoning: `docs/REMAINING.md`.

## Things most likely to bite you

1. A native exception on Capacitor's plugin thread can't be caught by JS
   try/catch — use a native pre-check.
2. Never mount an Ionic tab shell at a root catch-all (`/*`); keep shells
   at a named prefix (`/tabs/*`).
3. Static checks (`node --check`, wiring script, `php -l`, `tsc`) can be
   green on code with a P0 defect; several real bugs only showed up on a
   live device or HTTP call. A "code only, not device-verified" DEVLOG
   entry is not closed.
4. A verify script proves nothing about a route it never calls — grep the
   `.sh` before trusting a green result.
5. `backend/.env` isn't git-tracked and may lack secrets a feature needs
   — compare with `.env.example`.
6. Gradle's daemon JVM follows `JAVA_HOME`, not PATH — `./gradlew --stop`
   then re-export.
7. A named PDO parameter binds only ONE placeholder occurrence under
   native prepares.
8. An already-open browser tab or a Capacitor WebView can run a stale
   bundle; try a new tab or `adb shell pm clear` first. `pm clear` also
   resets runtime permissions.
9. Capacitor's default logging prints plugin results (SQLite rows) to
   logcat; `capacitor.config.ts` sets `loggingBehavior: 'none'` — never
   ship a `CAP_DEBUG_LOGGING=1` build.
10. `adb reverse tcp:8081 tcp:8081` is how the phone reaches this PC's
    backend over USB; the mapping drops on every reconnect.
    `adb reverse --remove tcp:8081` is a clean way to simulate an
    unreachable workstation.
11. `adb shell <cmd>` re-joins arguments with spaces; build the whole
    remote command as one quoted string.
12. PHP `proc_open()` + `stream_set_blocking(false)` is not a subprocess
    timeout on Windows; `LocalGsmOutboundClient` shells out to PowerShell
    `Process.WaitForExit(ms)` instead.
13. A freshly installed Android app is "stopped" and receives no
    broadcast until launched once. This Infinix/XOS build has its own
    background freezer (`Usf_Hiber`) that can delay broadcasts.
14. Git-Bash `/c/...` paths break native `php.exe` and `curl.exe` — use
    `cygpath -m`.
15. `bootstrap-admin.js`'s documented `BARANGUARD_BOOTSTRAP_JSON` is never
    read; pipe answers on stdin in prompt order.
16. `ext-curl` under Apache needs the four `LoadFile` DLL lines in
    `C:\xampp\apache\conf\extra\httpd-xampp.conf` (not git-tracked) —
    re-add them if XAMPP's PHP is swapped (REFERENCE.md §8).

## Operational quick reference

```bash
# Retention (dry-run FIRST on real data — deletion is irreversible by design)
php backend/scripts/retention-job.php --dry-run
php backend/scripts/retention-job.php --list

# Restore drill (records the drill; W20 shows "Never" until you run it)
BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh

# GSM ingestion daemon (once the phone is adb-reachable) — inbound
cd backend && php scripts/gsm-ingest-daemon.php --status
php scripts/gsm-ingest-daemon.php --once   # one poll
php scripts/gsm-ingest-daemon.php --daemon # keep polling

# GSM outbound gateway — one-time setup on a new gateway phone
cd sms-gateway
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
export TMPDIR=C:/gtmp TEMP=C:/gtmp TMP=C:/gtmp
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant ph.baranguard.smsgateway android.permission.SEND_SMS
adb shell monkey -p ph.baranguard.smsgateway -c android.intent.category.LAUNCHER 1
# then set GSM_GATEWAY_ENABLED=true in backend/.env

# Web checks — run after ANY web change
node web/scripts/verify-web-wiring.mjs
cd web/tests && npm test            # one-time `npm install` first

# Mobile static checks — run after ANY mobile change
cd mobile && npx tsc --noEmit && npm run lint && node scripts/verify-local-schema.mjs

# Route count (the number in REFERENCE.md §5 drifts)
php backend/scripts/count-routes.php

# Backend evidence scripts (disposable DB, safe to re-run)
php backend/scripts/verify-json-contracts.php
php backend/scripts/verify-auth-lockout-revocation.php
bash backend/scripts/verify-b2-pentest-remaining-resources.sh
bash backend/scripts/verify-sprint7-pentest-incidents.sh
bash backend/scripts/verify-scheduler-fatigue.sh

# Build + install the mobile Tanod app onto a connected Android device.
# VITE_API_BASE_URL MUST be set explicitly: mobile/.env.local exists on
# this machine for LOCAL dev builds and Vite auto-loads it into EVERY
# `vite build`, silently baking http://localhost:8081 into an APK meant
# for a real device unless this env var overrides it.
cd mobile && VITE_API_BASE_URL=https://api.baranguardph.win/api/v1 npx vite build && npx cap sync android
cd android
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
export TMPDIR=C:/gtmp TEMP=C:/gtmp TMP=C:/gtmp
export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=C:/gtmp"
./gradlew --stop && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p ph.baranguard.tanod -c android.intent.category.LAUNCHER 1
# adb is not on PATH: C:\Users\JAYSON~1\AppData\Local\Android\Sdk\platform-tools\adb.exe

# Cloudflare Named Tunnel set-up (idempotent; needs `cloudflared tunnel login` once)
bash backend/scripts/setup-cloudflare-tunnel.sh yourdomain.win
# One-time backend/.env generation on a fresh machine (docs/SETUP.md 1.4)
bash backend/scripts/setup-env.sh
```

**Day-to-day: double-click `Start Baranguard.bat`** (repo root) to start
Apache, MySQL and the Cloudflare tunnel (whichever isn't already running;
safe to click twice) and open the dashboard. No admin rights needed.

**Zero-click autostart instead** (one-time elevated PowerShell; pick one
of the two approaches):

```powershell
powershell -ExecutionPolicy Bypass -File backend\scripts\install-autostart-services.ps1
```

Installs Apache2.4/MySQL/cloudflared as auto-starting Windows services
(idempotent, prints an uninstall cheat-sheet). Not run on this machine.

**Backup/retention/digest are scheduled** (no elevation needed):

```powershell
powershell -ExecutionPolicy Bypass -File backend\scripts\install-scheduled-backup-jobs.ps1
```

Registers `BaranguardBackupRetention` (daily 02:00), `BaranguardRestoreDrill`
(weekly Sunday 03:00) and `BaranguardPbDigest` (weekly Monday 06:00). The
first two read `BACKUP_ENCRYPTION_PASSPHRASE` from `backend/.env`. Logs:
`backend/backups/scheduled-logs/`.

## Conventions

Commits: `[Tag] Short description`, ending with the `Co-Authored-By:` line
the current session instructions specify. Remote `origin` →
`github.com/jpbuenosaires/Baranguard`; push before ending a session that
adds real work. Rewrite this file — don't append — at the end of any
session that changes the picture. A stale `HANDOFF.md` is treated like a
stale DEVLOG claim: verify against the repo before trusting it.
