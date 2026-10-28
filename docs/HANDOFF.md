# Baranguard — Session Handoff

Purpose: compact current-state snapshot for the next session. Replaced in
place each update, never stacked; history lives in `backend/DEVLOG.md`
(grep by date or keyword, do not read front to back).
Status / Last updated: 2026-10-28.

## Current state

- **Scope:** thesis defense, ISO/IEC 25010 evaluation and UAT. The system is
  not being deployed at a barangay; deployment items are listed as "not
  doing" in `docs/ROADMAP_TO_COMPLETION.md` (the work list, in phases).
- **Code:** 103 routes in 27 route files (`php backend/scripts/count-routes.php`),
  45 migrations (0001-0045). Last full re-measure 2026-10-28 (REFERENCE.md §9):
  `verify-web-wiring.mjs` 938/0, `web/tests` 735 of 736 (known order-sensitive
  map test 'SOS markers are never clustered', passes alone), mobile vitest
  193/193, mobile `verify-local-schema.mjs` 266/0. Nothing from the recent
  builds is device-verified.
- **Databases:** `backend/.env` points at `baranguard_uiseed` (Barangay Dao,
  simulated data, at migration 0045, 11 users). The real `baranguard` has
  migrations only up to 0026 plus whatever was applied earlier; 0029-0045
  are NOT applied to it, and the roadmap says do not migrate it (nothing in
  scope needs it; 0029 and 0042 drop tables permanently). `baranguard_ch4`
  was dropped 2026-10-14. Reset and runbook: `docs/DEFENSE_DB_RUNBOOK.md`,
  `docs/UAT_DATA_REQUIREMENTS.md`.
- **Reference authority:** `docs/REFERENCE.md` wins for removed features
  (blotter, AI pipeline, Fatigue Flags); the Master Reference wins elsewhere
  (stated in CLAUDE.md, README.md and the Master Reference's closing note).

## What changed 2026-10-28

- **Docs pruned** to what the defense, evaluation and UAT need (CLAUDE.md
  lists what was removed; recover with `git log --diff-filter=D -- docs/`).
  `HANDOFF.md` rewritten from 448 lines; the deployment-only backlog is gone.
  `web/README-serving.md` and `backend/scripts/README-serving.md` were merged
  into `docs/SETUP.md` ("Serving through Apache"). Code comments in
  `backend/.htaccess`, `backend/public/index.php`, `web/index.html` and
  `web/src/api/apiClient.js` still name the old README-serving files (code
  not edited here).
- **Mobile and messaging audit fixes** (commit `3f7cc2d`; Rules 97-106 in
  `docs/WORKFLOWS_AND_RULES.md` Part 8): SOS on every Tanod tab (800 ms hold),
  GPS wait at most 2 s, Silent SOS option, SOS repeat and escalation, honest
  SMS statuses, stored inbound texts and STOP opt-out, queued broadcasts,
  data-only critical pushes. Verified on disposable DBs, vitest and jsdom
  only. **Still owed:** a Gradle debug AND release build and a device pass
  (R8 minify, cleartext config, critical alerts, SOS hold button), re-run
  `install-scheduled-backup-jobs.ps1` so the new tasks register, check
  `GATEWAY_BARANGAY_ID` in `.env`, install a new APK.
- Defense prep: password toggles on web and mobile, web styling fixes,
  `docs/DEFENSE_DB_RUNBOOK.md`, `docs/DEFENSE_QA.md`, manuscript and
  instrument audit (`docs/MANUSCRIPT_AUDIT_2026-10-28.md`), UAT forms matched
  to the build, `docs/SPRINT8_DEVICE_TEST_PLANS.md`.

## Standing decisions to keep in mind

- Electronic Blotter and the local AI pipeline removed (migration 0029);
  Fatigue Flags removed (0042); the 12 h/day scheduled-hours cap stays. Do
  not rebuild without an explicit new decision.
- Reports are printed and signed on paper; the app does not track
  signatures (migration 0041, Rule 80).
- Raw narrative is purged at ONE YEAR (365 days), decided 2026-10-17.
  Retention for the newer tables is provisional (365 days), Rule 10.
- Baranguard complements DILG BIMSS and never replaces it.
- The Chief Tanod is the Admin account (`official_title`), not a role; a
  Kagawad uses a `secretary` account carrying approval authorities.

## Open owner decisions (do not guess)

1. Roadmap Phase 0.6 defaults: Silent SOS on, SOS escalates to Secretary and
   Punong Barangay, emergency numbers 911/160 (Rules 97 and 99).
2. Kagawad-as-secretary account model; whether an Admin may hold `approve_*`
   through a second account.
3. Retention periods for availability, accomplishment reports, school
   check-ins, referrals and Annex D (provisional 365 days, purge job exists
   with the rules set provisionally); needs a council/COA decision, out of
   scope for the defense.
4. Text of MC 2026-037 (deadlines, C-1 filing frequency, Annex A) was never
   readable; Annex B/C-1/D layouts follow the user's own forms and are marked
   draft (Rule 88).
5. From the 2026-10-09 web audit, as recorded in DEVLOG: darker
   warning/success/info colours, idle lock vs the Dispatch screen, SOS bar
   after 'Mark as seen', Secretary incident date/location filters, map
   tiles/fonts being third-party.

## Environment and access

- **Branch:** commit and push directly to `main` (user instruction
  2026-09-22). `git stash@{0}` may still hold a leftover from an agent
  mishap on 2026-10-09; drop it when satisfied. Remote `origin`:
  `github.com/jpbuenosaires/Baranguard`. Commits: `[Tag] Short description`.
- **Credentials:** the demo/UAT seed accounts and their shared password are
  listed in `docs/UAT_DATA_REQUIREMENTS.md`; `tanod.olayvar` is seeded
  suspended. Check `DB_NAME` in `backend/.env` before trusting any DB claim.
- **Public hostnames** `baranguardph.win` / `api.baranguardph.win`: tunnel
  from this machine, demo data only, no Cloudflare Access, started as a user
  process by `start-baranguard.ps1`; out of scope (REFERENCE.md §1). The
  `baranguard-main` tunnel on the `danilyn` machine is orphaned; ask first.
- **Single point of failure:** everything needs the workstation on; only SOS
  has a device-local SMS fallback. Not solved, deployment-only.
- **SMS:** a tethered Android phone (`sms-gateway/`) sends over its own SIM
  and the same phone does inbound (`gsm-ingest-daemon.php`); needs
  `GSM_GATEWAY_ENABLED=true` and the app launched once after install.
- **Mobile build:** always set `VITE_API_BASE_URL` explicitly for a real
  device; `mobile/.env.local` otherwise leaks `http://localhost:8081`.
- **Device/adb:** see the auto-memory notes; `adb` is at
  `C:\Users\JAYSON~1\AppData\Local\Android\Sdk\platform-tools\adb.exe`.

## Quick commands

```bash
# Counts and checks
php backend/scripts/count-routes.php
node web/scripts/verify-web-wiring.mjs            # after ANY web change
cd web/tests && npm test                           # one-time npm install first
cd mobile && npx tsc --noEmit && npm run lint && node scripts/verify-local-schema.mjs

# Backend evidence (disposable DB, safe to re-run)
bash backend/scripts/verify-scheduler.sh
bash backend/scripts/verify-sprint7-pentest-incidents.sh
bash backend/scripts/verify-b2-pentest-remaining-resources.sh
php backend/scripts/verify-json-contracts.php
php backend/scripts/verify-auth-lockout-revocation.php

# Retention (dry-run FIRST; deletion is irreversible by design)
php backend/scripts/retention-job.php --dry-run
# Restore drill
BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh
# GSM inbound daemon
cd backend && php scripts/gsm-ingest-daemon.php --status

# Mobile APK for a real device (VITE_API_BASE_URL MUST be explicit)
cd mobile && VITE_API_BASE_URL=https://api.baranguardph.win/api/v1 npx vite build && npx cap sync android
cd android
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
export TMPDIR=C:/gtmp TEMP=C:/gtmp TMP=C:/gtmp JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=C:/gtmp"
./gradlew --stop && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`Start Baranguard.bat` (repo root) starts Apache, MySQL and the tunnel; scheduled
jobs are registered by `backend/scripts/install-scheduled-backup-jobs.ps1`.
Setup from scratch: `docs/SETUP.md`.

## Things most likely to bite you

1. A native exception on Capacitor's plugin thread cannot be caught by JS
   try/catch; use a native pre-check.
2. Never mount an Ionic tab shell at a root catch-all (`/*`); use `/tabs/*`.
3. Static checks (`node --check`, wiring script, `php -l`, `tsc`) can be green
   on code with a P0 defect. A "code only, not device-verified" DEVLOG entry
   is not closed.
4. A verify script proves nothing about a route it never calls; grep the `.sh`.
5. `backend/.env` is not git-tracked; compare with `.env.example`.
6. Gradle's daemon JVM follows `JAVA_HOME`, not PATH (`./gradlew --stop`).
7. A named PDO parameter binds only ONE placeholder under native prepares.
8. A stale browser tab or Capacitor WebView can run an old bundle; try a new
   tab or `adb shell pm clear` (which also resets runtime permissions).
9. Never ship a `CAP_DEBUG_LOGGING=1` build (it prints SQLite rows to logcat).
10. `adb reverse tcp:8081 tcp:8081` drops on every reconnect.
11. A freshly installed Android app is "stopped" and gets no broadcast until
    launched once; the Infinix/XOS build also has a background freezer.
12. Git-Bash `/c/...` paths break native `php.exe` and `curl.exe`; use
    `cygpath -m`.
13. `ext-curl` under Apache needs four `LoadFile` DLL lines in
    `C:\xampp\apache\conf\extra\httpd-xampp.conf` (not git-tracked); re-add
    them if XAMPP's PHP is swapped (REFERENCE.md §8).
14. XAMPP's MariaDB listens on 3306 here; an unrelated `MySQL80` service may
    also exist, so check `DB_PORT` (REFERENCE.md §8).
