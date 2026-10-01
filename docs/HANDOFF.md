# Baranguard — Session Handoff

**Replaced-in-place snapshot, not a log** — rewrite fresh each session,
never stack banners. Full history: `backend/DEVLOG.md` (grep by
date/keyword, don't read front to back). Everything older than this
snapshot (the 2026-09 audit passes, the C7/M13/GSM-gateway device
sessions, the abandoned React Native rebuild, the PHP 8.3 swap, the
Cloudflare tunnel set-up) lives in DEVLOG; only what is still true and
still actionable is kept here.

**Last updated: 2026-10-01.**

## Current state

**The Electronic Blotter and the entire local-AI pipeline are REMOVED
(migration 0029, DEVLOG 2026-10-01 (1)).** Barangays keep the blotter and
Lupon records in their own binders; DILG BIMSS/KPIS remains the mandated
case ledger and Baranguard complements it (REFERENCE.md §1). With no
blotter there is no redaction/summary/translation/extraction pipeline, no
Ollama, no AI worker, no `eval-kit/`. What stayed: the Secretary role
(sole `raw_narrative` reader, owns the incident lifecycle),
`incident.raw_narrative` and the party fields, and the now-unwritten
`redacted_narrative`/`redaction_approved_*` columns. The per-incident page
is `web/src/pages/incident-detail.js` (route key `incident-detail`), a
single page with no tabs. Live routes: 92 → 76 (`php
backend/scripts/count-routes.php`). Mobile is untouched.

**Migration 0029 has NOT been run against `baranguard` or
`baranguard_uiseed`.** It drops `blotter_revision`, `blotter_record`,
`ai_processing_log`, `ai_evaluation_run` with their data and has no real
down-migration. Back up first (`backend/scripts/backup.sh`), apply as
DBA/root (`baranguard_app` has no DROP). Until it is applied, the real DBs
still contain the old tables and the code simply ignores them.

**Measured this session (2026-10-01):** `node web/scripts/verify-web-wiring.mjs`
528 passed / 0 failed; `web/tests` `npm test` 389 / 389. The backend
suites were run by the removal session on disposable DBs (counts in
DEVLOG 2026-10-01 (1)); `verify-sprint4-phase2-3.sh` had 2 environmental
failures there (this machine now has real FCM credentials, so
`/system/health` reports `fcm: healthy` where the suite expects
`not_configured`).

**Docs reconciled this session:** `CLAUDE.md`, `docs/REFERENCE.md`,
`docs/SETUP.md`, `docs/REMAINING.md`, `docs/SPRINTS.md` and this file.
**Still describing the old system, not reconciled:** `docs/Baranguard_
Master_Reference_FINAL .md` (predates 0029 — REFERENCE.md wins on
blotter/AI/Lupon), `docs/DATA_INVENTORY.md`, `docs/PRIVACY_IMPACT_
ASSESSMENT.md`, `docs/PRIVACY_NOTICES.md`, `docs/Baranguard_Sprint_
Prompts.md` (history), `docs/AI_Evaluation_Dataset_Guide.md` (history).

**Revision/evaluation docs (new, untracked, written for the thesis
revision):** `docs/THESIS_OBJECTIVES_ALIGNMENT.md` (four objectives, each
with evidence and honest limits, no performance numbers claimed) and
`docs/ISO25010_EVALUATION_PLAN.md`. Status: drafts. Nothing in them has
been measured yet — performance, usability (SUS) and reliability figures
are all still outstanding, and the objective wordings are marked for
verification against the standard.

**Open scope question (not built):** DILG MC 2026-037 (Safer School Zones)
— no school-zone concept exists in the schema; nothing was built for it.
The circular numbers in REFERENCE.md §1 come from secondary sources and
are unverified.

**Policy consequence to confirm (Rule 10):** with no approved redaction
ever existing, every raw narrative now falls under `RetentionService`'s
90-day ceiling.

**Loose ends on the workstation:** `backend/.env` (gitignored) may still
carry `OLLAMA_*` values, harmless; a `BaranguardAiWorker` Scheduled Task
may still be registered if an older `install-autostart-services.ps1` was
run — `Unregister-ScheduledTask -TaskName BaranguardAiWorker
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

1. **Apply migration 0029 to the real DBs** (back up first) and decide
   whether `baranguard_uiseed` or `baranguard` should back the public
   tunnel.
2. **Print/PDF visual check**: the shared print-preview modal and the
   server-generated PDFs (statistical report, PB digest) passed static
   checks only; nobody has opened a freshly generated one. (The Lupon
   packet no longer exists.)
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
5. **Thesis evaluation**: run the measurements in
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
