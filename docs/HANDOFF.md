# Baranguard — Session Handoff

Purpose: the single "where we are and what is left" doc: current state, then
the roadmap to finish (defense, device evidence, fixes, UAT, ISO 25010,
thesis). Replaced in place each update, never stacked; history lives in
`backend/DEVLOG.md` (grep by date or keyword, do not read front to back).
Status / Last updated: 2026-10-28.

## Current state

- **Scope:** thesis defense, ISO/IEC 25010 evaluation and UAT. The system is
  not being deployed at a barangay; deployment items are under
  "Limitations to state" and the short deployment appendix below.
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
  was dropped 2026-10-14. Reset and runbook: `docs/DEFENSE.md`,
  `docs/EVALUATION.md`.
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
- **Mobile and messaging audit fixes** (commit `9ae5046`; Rules 97-106 in
  `docs/WORKFLOWS_AND_RULES.md` Part 8): SOS on every Tanod tab (800 ms hold),
  GPS wait at most 2 s, Silent SOS option, SOS repeat and escalation, honest
  SMS statuses, stored inbound texts and STOP opt-out, queued broadcasts,
  data-only critical pushes. Verified on disposable DBs, vitest and jsdom
  only. **Still owed:** a Gradle debug AND release build and a device pass
  (R8 minify, cleartext config, critical alerts, SOS hold button), re-run
  `install-scheduled-backup-jobs.ps1` so the new tasks register, check
  `GATEWAY_BARANGAY_ID` in `.env`, install a new APK.
- Defense prep: password toggles on web and mobile, web styling fixes,
  `docs/DEFENSE.md`, `docs/DEFENSE.md`, manuscript and
  instrument audit (`docs/DEFENSE.md`), UAT forms matched
  to the build, `docs/EVALUATION.md`.

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

1. Roadmap Phase 0 step 6 defaults: Silent SOS on, SOS escalates to Secretary and
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

## Roadmap to finish (defense, ISO 25010, UAT)

Only measured numbers go into Chapter 4; a feature not run on a device is
written "implemented, not device-verified". Sources: `docs/SRS.md`,
`docs/EVALUATION.md`, `docs/chapter4-instruments/`,
`docs/EVALUATION.md`, `docs/DEFENSE.md`,
`docs/DEFENSE.md`, `docs/RISKS_AND_DEFECTS.md`. Owner: YOU or AGENT.
Effort: S under half a day, M 1-2 days, L 3-5 days.

Order: Phase 0 -> 1 -> 2 -> 3 (UAT) -> 5; Phase 4 (ISO evidence) is collected
alongside 1 and 3. Phase 1 comes before UAT so testers do not meet bugs we
could have found.

### Phase 0 - Stable demo and test system (2-3 days)

One database for everything: `baranguard_uiseed` (migration 0045, demo data).
Do not migrate the real `baranguard`.

1. Ctrl+F5 on demo browsers; password toggles work on login, Settings, Add User (YOU, S).
2. `.env`: set `GATEWAY_BARANGAY_ID`, `GSM_GATEWAY_ENABLED`, `BACKUP_ENCRYPTION_PASSPHRASE`; keep `DB_NAME=baranguard_uiseed` (YOU, S).
3. Run `install-scheduled-backup-jobs.ps1`; confirm tasks (SMS, SOS escalation, offers) (YOU, S).
4. Seeded shifts end 2026-10-29 22:00: publish a new roster covering demo and UAT days (YOU, S).
5. Install the debug APK on test phone(s); written pass/fail for login eye icon, SOS hold button, alerts, sync (YOU, M).
6. Confirm defaults: Silent SOS on, SOS escalates to Secretary and Punong Barangay, numbers 911/160 (Rules 97, 99) (YOU, S).
7. Timed dry run of the demo script (YOU + AGENT, M); personalise `docs/DEFENSE.md` (YOU, S).

### Phase 1 - Device and field evidence (1-2 weeks)

Use `docs/EVALUATION.md`; log each result with date and phone
model in `backend/DEVLOG.md`.

- **Objective 2, offline-first app:** airplane-mode durability (incident, evidence, duty, dispatch update; kill app; reconnect; one server row each); replayed `client_event_id` returns the original row; newer sync kinds and `closes_client_event_id` check-out; discard SQL on real SQLCipher; offline map package; 17+ min locked-screen GPS; critical alert queue (SOS before offer); logout stops GPS and hides the first user's data; at least 3 phone models and 2 WebView versions.
- **Objective 3, SMS SOS fallback:** data off then SOS shows `fallback_channel=sms`, backup contact texted, no duplicate after sync; no-GPS SOS records last-known or no-fix; airplane mode / no SIM (`sms_failed`); inbound text stored, STOP opts out; broadcast to 20+ numbers; unacknowledged SOS repeats at 2 min; FCM end to end (foreground, background, killed) with the real `google-services.json`; measure delivery times.
- **Objective 1, GIS command centre:** browser pass of Dashboard, Dispatch, Live Map, Analytics (Admin, Punong Barangay); outdoor moving GPS run vs dashboard track; route accuracy with a real ORS key (`stale`, `unavailable`); response time per Master Reference section 6 (`created_at` to first `arrived_at`); wording "near-real-time, polling".
- **Measurements:** `measure-api-latency.mjs` p50/p95; `metrics-report.php` GPS delay and interval; sync success and duplicate rate from `storage/metrics/sync-*.jsonl`; 12 h/day cap and report-creation concurrency under real Apache.
- **Browser and print:** all four roles through every page; A4 print/PDF of statistical report, PB digest, Annex B, C-1, D, accomplishment report, week roster.

Exit: every item has a dated result; failures become Phase 2 tasks.

### Phase 2 - Fix what Phase 1 finds (1-2 weeks, AGENT)

Always (SOS replay-then-500 and the STOP confirmation reply fixed 2026-10-29): four
open mobile P1s (SOS enqueue ordering, enqueue-before-send, patrol-service,
offline-clear); retry a failed acknowledge on critical alerts; the
order-sensitive web map test; make `verify-sprint1-remaining.sh` and
`verify-sprint4.sh` print counts; unit tests for the alert queue and SOS
escalation timing.

Only if UAT users hit them (ask first): notify on dispatch cancel and swap
outcome (migration); on-duty/nearest tanod in the assign picker; tanod decline
of a dispatch (new state, L); a notification list screen; TalkBack labels,
contrast and font-size cleanup.

Skipped on purpose (state as limitations): Keystore-encrypted login token,
Do-Not-Disturb bypass, phone-built SMS for incident and position,
phone-number masking.

### Phase 3 - UAT (2-3 weeks)

Instruments: `docs/chapter4-instruments/`; data: `docs/EVALUATION.md`.

1. Ethics consent and participant list per role (YOU, M).
2. UAT data: accounts per role, fresh roster, seeded incidents, reset script (AGENT, M).
3. 8-10 scenario tasks per role with pass/fail rules (YOU + AGENT, M).
4. Run sessions: observe, time tasks, count errors (YOU, L); SUS after each (YOU, S).
5. Log defects in `docs/RISKS_AND_DEFECTS.md`; fix P0/P1 between rounds (AGENT, M); short confirmation round (YOU, M).

Exit: every role completed its tasks, SUS scored, P0/P1 fixed or written up as limitations.

### Phase 4 - ISO/IEC 25010:2023 evidence (2 weeks, overlaps 1 and 3)

Confirm characteristic names against the standard first (S). One real piece of
evidence each:

| Characteristic | Evidence |
|---|---|
| Functional suitability | `verify-json-contracts.php` for every section 6 response; UAT task completion |
| Performance efficiency | p50/p95 latency, GPS delay, response time (Phase 1) |
| Compatibility | Browsers and Android models/WebViews actually tested |
| Interaction capability | SUS, task time, error counts, accessibility pass |
| Reliability | Sync success/duplicate rate, `restore-drill.sh`, outage behaviour |
| Security | Pentest suites, lockout/revocation, raw-PII audit, `docs/RISKS_AND_DEFECTS.md` |
| Maintainability | Test counts, `count-routes.php`, migrations, docs reconciled |
| Flexibility | Offline operation, per-barangay scoping, settings |
| Safety | SOS and critical-alert behaviour, no false "synced" claims |

Also run every verify suite on a disposable DB, record counts in
`REFERENCE.md` section 9, and log reference/implementation gaps in DEVLOG.

### Phase 5 - Thesis and defense (1-2 weeks)

Update the manuscript tables with new measured numbers, each pointing to a
file; state limitations first; keep "complements DILG BIMSS, never replaces
it"; state the removals (blotter and AI, 0029; Fatigue Flags, 0042);
rehearse with `docs/DEFENSE.md` and run the demo twice.

## Limitations to state

- Not deployed; evaluated on a demo database, test phones and one workstation; real `baranguard` DB not migrated.
- No MFA, no Cloudflare Access; the public tunnel shows demo data only.
- No UPS or backup internet; a workstation outage stops everything except the SOS SMS fallback.
- SMS fallback covers SOS only, one gateway number, carrier delivery not guaranteed.
- Retention for newer tables is provisional; no DPO designation or NPC registration.
- MC 2026-037 text unavailable; annex layouts follow the forms supplied.
- Release APK not signed for distribution; login token has no Keystore encryption.
- Anything not run on a device: "implemented, not device-verified".

## Biggest risks

| Risk | Reduce it by |
|---|---|
| Nothing from 2026-10-28 has run on a phone; hidden Android bug in UAT | Phase 0 step 5 and Phase 1 first |
| UAT users meet a bug on camera | Dry run, fix between rounds |
| Chapter 4 numbers not backed by files | Phase 4 table; one evidence file per number |
| Seeded shifts expire, dispatch asks for an override reason | Phase 0 step 4, reset script |
| Panel asks about deployment, privacy or MFA | Limitations and `DEFENSE.md` |

## Definition of done

- Phases 0-5 complete with dated evidence in `backend/DEVLOG.md`; no open P0/P1 in `docs/RISKS_AND_DEFECTS.md`.
- Wiring check 0 failed; web, mobile and every verify suite green on a disposable DB, counts recorded.
- Every UAT role finished; SUS scored; one evidence item per ISO 25010 characteristic.
- Chapter 4 holds only measured numbers, each traceable to a file.

## Appendix - if Baranguard is ever deployed (not part of this thesis)

Detailed deployment docs were removed 2026-10-28 (recover with
`git log --diff-filter=D -- docs/`). Still needed: UPS and backup internet;
Apache/MySQL/cloudflared as Windows services (`install-autostart-services.ps1`,
elevated) and a firewall rule for port 80; backed-up migration of the real
`baranguard` DB (0029 and 0042 drop tables) and a choice of which DB backs the
public address; Cloudflare Access on the web host only (never the API) and an
MFA decision (C-02); release signing key, Keystore token, DND bypass; a DPO,
NPC registration, 72-hour breach practice; council/COA decisions on retention,
attendance evidence and the Kagawad model; verifying MC 2026-037; role
training, a two-week one-barangay pilot, then the other three.

## Environment and access

- **Branch:** commit and push directly to `main` (user instruction
  2026-09-22). `git stash@{0}` may still hold a leftover from an agent
  mishap on 2026-10-09; drop it when satisfied. Remote `origin`:
  `github.com/jpbuenosaires/Baranguard`. Commits: `[Tag] Short description`.
- **Credentials:** the demo/UAT seed accounts and their shared password are
  listed in `docs/EVALUATION.md`; `tanod.olayvar` is seeded
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
