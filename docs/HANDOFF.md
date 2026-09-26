# Baranguard — Session Handoff

**Replaced-in-place snapshot, not a log** — rewrite fresh each session,
never stack banners. Full history: `backend/DEVLOG.md` (grep by
date/keyword, don't read front to back).

**Last updated: 2026-09-26.**

**2026-09-26, latest — W21 web UI for the incident lifecycle endpoint
(H-16/M-03) CLOSED.** Backend/policy for `PATCH /incidents/:id/lifecycle`
existed since an earlier session (migration 0025), but nothing in the
web app called it. `blotter-detail.js` now has a Secretary-only "Case
lifecycle" card — duplicate/invalid/cancelled/reopened, forward-only per
the server's own transition table, disabled while a dispatch is active
(except reopening), a "Mark as duplicate" flow that asks for the target
incident id inline with real validation, and a cross-navigation link to
whatever it's linked as a duplicate of. **A real backend gap found while
wiring this**: `IncidentsController::show()` had never returned
`duplicate_of_incident_id`/`lifecycle_changed_by`/`lifecycle_changed_at`
— the endpoint's own immediate response after a lifecycle change carried
them, but reloading the page lost them entirely. Fixed. **A second real
gap found live-testing in the browser**: the Incident List had no label/
icon/color/filter-option for any of the 4 new statuses — they rendered
as raw lowercase text with a misleading alert-triangle icon, and
couldn't be filtered to at all. Fixed alongside. New reusable
`ConfirmDialog.promptText()` primitive (free-text input in a dialog,
alongside the existing `promptSelect()`). Verified live in the browser
as `secretary.dao` against real disposable `baranguard_uiseed` data —
cancelled a real incident, marked a second as a duplicate of a third,
confirmed the "merge means link, not delete" contract by clicking
through to the target and finding it completely untouched.
`verify-h16-incident-lifecycle.sh` 30/30, `verify-json-contracts.php`
50/50, `verify-web-wiring.mjs` 564/564 (up from 562, same 2 pre-existing
unrelated failures), `web/tests` 399/399 (one test's own `SCHEMA_STATUSES`
constant was stale — fixed to match the real schema, not weakened). Full
detail: `backend/DEVLOG.md` 2026-09-26 (36).

**2026-09-26, earlier — C2 (backup/retention scheduling) and B3 (real
restore drill) both CLOSED.** `docs/REMAINING.md`'s "Current priority"
item 2. Generated a real `BACKUP_ENCRYPTION_PASSPHRASE` (added to
`backend/.env`, gitignored, plus a placeholder + explanation in
`.env.example`) — nothing had one before this session. **B3**: ran
`restore-drill.sh` for real, 12/12, confirmed via a live `GET
/system/health` call that `restore_test_at`/`backup_last_success` are
now populated (W20 no longer shows "Never"). **C2**: turned out NOT to
need an Administrator prompt after all — confirmed a bare
`Register-ScheduledTask` succeeds under this session's ordinary user for
a task that only needs to run while logged on, which this workstation
already must be per the existing "must never sleep" requirement. Two new
tasks, both verified firing for real via `Start-ScheduledTask`
(`LastTaskResult`=0): `BaranguardBackupRetention` (daily 02:00) and
`BaranguardRestoreDrill` (weekly Sunday 03:00). **Found and fixed a real
bug along the way**: `backup.sh`'s legal-hold pruning query referenced
`citizen_report.created_at`, a column that table has never had (it's
`submitted_at`) — every prune had silently failed closed since the
script was written; also added `sms_log` (has its own `legal_hold`) to
the hold-floor query, which never covered it. The scheduled
`retention-job.php` run purged 82 `raw_narrative` rows for real against
the demo `baranguard_uiseed` DB (not production), matching what a
`--dry-run` read by hand first had predicted. Full detail:
`backend/DEVLOG.md` 2026-09-26 (35).

**2026-09-26, earlier — "why is AI offline?": (32)'s PHP upgrade had
silently broken `ext-curl` under Apache, fixed.** Real, user-reported
symptom right after the PHP-8.3.13 swap: dashboard AI badge said
offline, `GET /system/ollama-status` returned `unhealthy`, while
`ai-worker.php --status` (CLI) correctly said Ollama was reachable —
the two disagreed because Apache's `mod_php` genuinely had no `curl`
extension loaded (`function_exists('curl_init')` false under
`apache2handler`, confirmed with a temporary diagnostic script, never
committed), even though the same `php.ini` and CLI `php.exe` load it
fine. Cause: `php_curl.dll`'s real dependency DLLs live in
`C:\xampp\php` (where CLI runs from), but Apache is `httpd.exe` in
`C:\xampp\apache\bin`, which has same-named-but-incompatible copies of
those same four DLLs — Windows resolves against the wrong ones and the
load fails silently (real error only in `C:\xampp\php\logs\
php_error_log`, not Apache's own error.log). Fixed with four `LoadFile`
directives in `C:\xampp\apache\conf\extra\httpd-xampp.conf` (**not
git-tracked — lives outside the repo, re-add if PHP is ever swapped
again**), same pattern already used there for `php8ts.dll`. Verified for
real: `GET /system/ollama-status` → `{"ollama":"healthy"}`,
`verify-json-contracts.php` 50/50, `verify-web-wiring.mjs` 562/562 (same
2 pre-existing unrelated failures) after an Apache restart. Full detail:
`backend/DEVLOG.md` 2026-09-26 (34).

**2026-09-26, earlier — the mysql-client PATH/port gap noted below is now
fixed, not just documented.** All 29 `backend/scripts/*.sh` that talk to
MariaDB directly (every `verify-*.sh` plus `bootstrap-db.sh`/`restore-
drill.sh`) shared one copy-pasted `find_bin()` that checked `command -v
mysql` before the explicit `/c/xampp/mysql/bin/` path, so on this
machine (an unrelated MySQL Server 8.0 client sits earlier on PATH) they
silently used the wrong client; separately they all defaulted
`XAMPP_MYSQL_PORT` to the stock 3306 instead of this machine's real 3307
(same fact 2026-09-26 (31) found for the launcher). Fixed identically
across all 29 (Python-scripted, not by hand — verified byte-identical
first): `find_bin()` now tries the XAMPP path first, port now defaults
from `backend/.env`'s own `DB_PORT`. Verified for real: `verify-sprint1-
auth.sh` (23/23) and `verify-sprint0.sh` (19/19) both pass with **zero
env var overrides**, first time either has on this machine, logs
confirming `Using mysql: /c/xampp/mysql/bin/mysql.exe`. The other 27
patched scripts share the identical fix but weren't individually re-run
this session. Full detail: `backend/DEVLOG.md` 2026-09-26 (33).

**2026-09-26, earlier — XAMPP's Apache PHP upgraded 8.0.30 → 8.3.13; API
now served by Apache on :8081 for real, not a standalone `php -S`
workaround.** Prompted by "Could not reach the Baranguard server" after
running `Start Baranguard.bat`: the launcher had never actually started
anything on :8081 (real gap, fixed first with a standalone-PHP
workaround since Apache's own PHP was 8.0 and can't load the backend's
8.1+ `readonly` properties), and separately a `MySQL80` Windows service
on this machine's port 3306 was tricking the launcher's process-name
check into skipping XAMPP's own MariaDB on 3307. Both fixed in
`start-baranguard.ps1` first, then user asked for the PHP version itself
fixed rather than kept worked around: `C:\xampp\php` is now a copy of
`C:\php-8.3.13` (user's choice — already proven on this machine, over
downloading a separate 8.2 build), XAMPP's own `php.ini` carried over
onto it, old PHP kept at `C:\xampp\php-8.0.30-backup` for rollback. New
`Listen 8081`/`<VirtualHost *:8081>` vhost added to
`httpd-vhosts.conf` (DocumentRoot `backend/public`), matching what
`backend/scripts/README-serving.md` Option A already described as "how
this will actually run." Verified for real: `Server: Apache/2.4.58 ...
PHP/8.3.13` in the error log, real 200s with real barangay data at both
`localhost:8081` and `https://api.baranguardph.win`,
`verify-json-contracts.php` 50/50 live through Apache,
`verify-web-wiring.mjs` 562/562 (same 2 pre-existing unrelated
failures). Not re-run: the `mysql`-root-DBA verify suites (`verify-
sprint1-auth.sh` etc.) — this shell's `mysql` client resolution is a
pre-existing, separate environment gap (an unrelated `MySQL Server 8.0`
install ahead on PATH; XAMPP's own `mysql.exe` client is too old for
root's `caching_sha2_password` plugin) unrelated to this PHP swap. Full
detail: `backend/DEVLOG.md` 2026-09-26 (31), (32).

**2026-09-26, earlier — Secretary blotter workflow UX pass (web only).**
W7/W8 now share a 4-stage progress bar (`BlotterWorkflow.js`) with one
"Next step"; finalize has a GOV.UK-style check-your-entry step; amend is
collapsed behind "Amend this entry"; W8's Lupon packet no longer offers
itself before the entry is finalized (it could only fail). No backend
change. `web/tests` 399/399. Not browser-verified: the finalize check
step on a real approved-but-unfinalized incident (jsdom only). Full
detail: `backend/DEVLOG.md` 2026-09-26 (30).

**2026-09-26, later still — a real bug in the AI Tools removal commit
found and fixed, plus AI queue visibility added.** After the AI Tools
removal (migrations 0027/0028) was committed, the user reported the AI
queue was invisible and jobs seemed to take too long. Running the worker
for real (not just `php -l`) immediately surfaced a genuine break:
`AiJobQueue::claimNextQueuedJob()`/`claimSiblingJob()` still selected
`barangay_id`/`tool_input`, both dropped by 0028 — the worker could not
claim a single job. Fixed. Separately, `%LOCALAPPDATA%\Ollama\
server.log` showed the REAL cause of the slowness: this workstation's
Ollama GPU backend crashes on roughly half of cold model loads (`CUDA
error: shared object initialization failed`), which `OllamaClient.php`
correctly treats as "unavailable" and the worker requeues-and-stops on —
so one flaky crash silently halted the whole queue until someone noticed
and reran it by hand, which is what let a job's elapsed time balloon to
as long as an hour even though no single generation call ever took more
than ~24s. User declined touching the GPU driver; `OllamaClient::
generate()` now retries a crashed load up to 3 times (4s apart) inside
one job before falling back to the existing requeue-and-stop. New `GET
/system/ai-queue` (Admin+Secretary) plus a Service Health panel and a
Secretary topbar tooltip give real queue visibility for the first time —
previously the only way to see `ai_processing_log` at all was
`ai-worker.php --status`/`--daemon` in a terminal. Full detail,
including the real Ollama log timestamps and a second real bug found
during browser verification (a `NaNm ago` date-parsing double-`Z` bug):
`backend/DEVLOG.md` 2026-09-26 (24). GPU/CUDA driver instability itself
remains unresolved — the retry only papers over it, by explicit user
choice this session.

**2026-09-26, same day, later — C-03 (remote access) IN PROGRESS, real
requirement change.** User needs Tanod/Secretary/PB to reach the system
off the barangay LAN — reverses the "stay LAN-only" assumption C-03 was
scoped under earlier the same day. Registered `baranguardph.win`
(Cloudflare Registrar, informed of and accepting the TLD's spam-
reputation risk) and stood up a Cloudflare Named Tunnel, verified LIVE
with real HTTP calls (real barangay data returned, real dashboard HTML
served, real browser screenshot) — not just configured and assumed
working. `web/index.html` auto-detects its API base from whatever
hostname it's opened on; `mobile/src/services/apiService.ts`'s default
now points at the real domain, with a new gitignored `mobile/.env.local`
keeping local dev pointed at the workstation. **Two things still need
YOU specifically** — see the F1/C-03 section below for exactly what.
Also, in the same stretch: removed Profile's "Test Chimes"/"Critical
Alert" test buttons and a stray debug log from `mobile/` (user request,
unrelated to C-03 itself). **A real, important question got asked and
answered**: does any of this help if the workstation itself is off?
No — cloud/redundant hosting was floated as the fix and explicitly
rejected by the user after real tradeoffs were surfaced (cost, the GSM
gateway's physical-phone dependency, RA 7160 data-sovereignty). That
risk is accepted and disclosed, not solved. Full detail:
`backend/DEVLOG.md` 2026-09-26 (20).

**2026-09-26 — seventh audit pass: 5 of the 7 remaining `docs/REMAINING.md`
§H items + M-03 closed in one session** (user explicitly picked "all the
H items and M-03," decisions gathered up front via AskUserQuestion, same
pattern as the fifth/sixth passes). H-15 (retention for gps_track/
duty_status/shift_schedule/notification — 1 year each, researched
against the National Archives of the Philippines' Daily Time Record
schedule, not guessed), H-16/M-03 (new Secretary-only `PATCH
/incidents/:id/lifecycle` — duplicate/invalid/cancelled/reopened states,
merge-as-link-not-delete, migration 0025), H-17 (shift minimum-staffing +
8h rest, hard-blocked per explicit user decision), H-19 (contact-number
consent — scope clarification, no code change needed), and H-21 (offline
tile licensing — already ODbL-compliant, no code change needed) are all
CLOSED, each with real disposable-DB verification (85/85, 30/30, 47/47
across three suites — see `backend/DEVLOG.md` 2026-09-26 (17) for the
full breakdown). H-14 (privacy governance) got three new docs
(`docs/DATA_INVENTORY.md`, `docs/PRIVACY_IMPACT_ASSESSMENT.md`,
`docs/PRIVACY_NOTICES.md`) with DPO designation explicitly flagged as a
barangay-council action no coding session can complete. H-18 (AI
provenance) got a real `prompt_template_version` column and stamping
(migration 0025), with the actual eval-harness runs still waiting on a
friend's hardware exactly as before.

**Same session, immediately after — C-01 CLOSED too.** User picked C-01
next (deferred C-02/MFA for later). Migration 0026 makes
`tanod_sos.latitude`/`longitude` nullable and adds
`location_source`/`location_recorded_at`. `POST /tanod-sos` no longer
hard-rejects a missing GPS fix: falls back to the Tanod's most recent
`gps_track` row (`last_known`, with that fix's OWN timestamp) or, with no
fix at all, still creates the SOS (`no_fix`, null coordinates) — the
alert is never blocked, per §2 Rule 27. `verify-sprint4.sh` extended with
8 new assertions, 57/58 (the 1 failure is pre-existing and unrelated —
see below). Also fixed one incidental regression the SAME session's
earlier H-17 work caused in `verify-sprint7-audit.sh`'s swap-approval
fixture (H-17's new coverage guard correctly blocked its release-to-
unassigned pattern; fixed by naming an explicit target instead) — back to
57/57. Full detail: `backend/DEVLOG.md` 2026-09-26 (18).

**`docs/REMAINING.md` now has only C-02 and C-03 open** — every other
finding from the 36-finding 2026-09-24 audit is closed or explicitly
deferred with a named reason. No web UI changes this session (backend/
policy only); `web/tests` and `verify-web-wiring.mjs` were not re-run
since nothing web-facing changed.

**Follow-up, same session — investigated and resolved: the "Admin
bypasses Tanod-only ack" item above was a stale test, not a bug.**
`NotificationsController::acknowledge()`'s role list
(`tanod`/`admin`/`secretary`/`punong_barangay`) is correct and was fixed
on purpose in 2026-09-24 (9) — the ack endpoint is ownership-scoped
(`nt.user_id = caller`), not role-gated, matching the mobile Tanod bell
and web topbar bell reading the same `notification_target` rows. The
failing test's Admin caller was a genuine SOS fan-out target (Rule 27
targets Admin + on-duty Tanods) acknowledging their own row — correct
behavior, not a privilege escalation. Fixed `verify-sprint4.sh`'s
assertion to match reality instead of the code; 59/59. No production
code changed. Full reasoning: `backend/DEVLOG.md` 2026-09-26 (19).

**Web UI/UX overhaul committed 2026-09-24** (was "in progress,
uncommitted" in the previous snapshot) after a full pre-commit code
review of the entire accumulated diff (63+ files) — see DEVLOG 2026-09-24
(9) for the complete list. 14 findings, all fixed at the code level;
highlights: the critical-alert sound's "already seen" baseline was
wrongly scoped to reset on every page navigation (not just a real
refresh), silently defeating the sound feature added earlier the same
day — fixed by moving it to module scope; `NotificationsController.php`'s
ack endpoints had a wrong role list (invented roles, missing
`punong_barangay`); the local GSM gateway's Windows `Start-Process`
timeout wrapper had a second cross-process-boundary quoting bug beyond
the one already fixed in (5); `ai-review.js`'s stale-draft state left
Regenerate/Approve clickable when they should be disabled. Two fixes
(the GSM gateway's Windows quoting, and a mobile permission-request
race) are reasoned-but-not-device-verified — see DEVLOG (9)'s closing
note. `web/tests/` renders every page × role in jsdom (`cd web/tests &&
npm install && npm test`, ~23s): **408/408** (moved up from 407 during
the later H-05 session-storage fix below) — also fixed an unrelated,
pre-existing bug caught along the way (a notification-panel header never
appended its title/badge elements). Run the suite after any further web
change alongside `verify-web-wiring.mjs` (569/569, moves as screens
change).

**Also 2026-09-24 — an external 36-finding business-rules audit was
reconciled against the live code; 19 findings resolved across six
passes, then 6 more (H-15, H-16, M-03, H-17, H-19, H-21) in a seventh
pass 2026-09-26 — 25 of 36 closed** (`docs/REMAINING.md` §H, `DEVLOG.md`
(10) through (17)). First
three passes: a fabricated blotter case number in the web UI, Punong
Barangay still able to list blotter records server-side after the screen
was removed, a Tanod double-booked across two different incidents,
off-duty declarable with an active dispatch, evidence upload trusting
the client's claimed file format, audit-log gaps for failed
authorization/raw-narrative reads/downloads, GPS ingestion with no
clock-skew/accuracy plausibility bounds, an SMS segment counter that
never accounted for UCS-2 encoding, blotter/incident display-ID years
computed in UTC instead of Asia/Manila, a stale route-count doc (claimed
84, real count is 91, now checkable via
`backend/scripts/count-routes.php`), notification delivery having no
operator-visible signal once both the FCM and SMS fallback tiers were
exhausted, and map-package uploads having a per-file size ceiling but no
total-per-barangay storage quota. **Fifth/sixth passes (user-directed,
picked from the remaining list and answered up front via
AskUserQuestion)**: H-11 (abuse-budget quotas — new shared
`rate_limit_counter`/`RateLimiter` infrastructure — added to AI jobs,
evidence upload, GPS, report export, map-package upload, SMS broadcast),
H-12 (citizen-report duplicate-content detection + per-barangay
aggregate limit, explicitly without a CAPTCHA/third-party per the user's
choice), H-13/L-03 (public transparency endpoint published properly:
real rate limit, `Cache-Control`, and a new `#/transparency` web page),
H-05 (web JWT moved out of `sessionStorage` into an in-memory-only
variable — a page reload now signs the user out, a disclosed tradeoff
until C-03/HTTPS lands; `docs/REMAINING.md` now has three scoped HTTPS
deployment options for whoever picks that up), and H-09 (hardware-backed
device identity — new `mobile_device.device_public_key_pem` +
`DeviceSignature` verify a per-request signature on evidence upload/GPS/
Tanod dispatch updates; SOS deliberately never rejects on a bad
signature, only audits it, matching the audit's own C-01 safety
priority; **backend fully verified real, mobile side code-complete but
NOT device-verified this session** — see "Recommended next step" below).
Several of the audit's own claims turned out to be wrong once checked —
most notably "no backup/DR exists," which is false (real encrypted
backups and a genuine restore-drill already exist; only scheduling is
missing, tracked as C2/B3 below); two others (H-08, M-05) asked for
changes that would have overridden existing, deliberate architecture
decisions (`GpsController` and `DispatchController::route()` both
explain their own reasoning in their class docs) — fixed the actual
underlying risk instead of doing what was literally asked, or confirmed
no fix was needed at all. Remaining items (MFA, HTTPS/TLS
implementation, privacy governance, retention-period policy calls,
incident duplicate/merge workflow, shift staffing constraints, AI
evaluation/provenance, contact-consent boundaries, map-tile licensing)
remain deliberately not started — see REMAINING.md §H for the full
disposition of all 36 findings.

**New 2026-09-23/24 — Semaphore removed, replaced by a local GSM
outbound gateway; C7 root-caused, fixed, AND device-verified working;
A4 (including its subprocess-timeout gap)/A5/M13's primary path all
closed with real device evidence; critical alerts now genuinely play
sound on both mobile and web; M13's `sms_failed` gap fixed at the code
level (not yet device-verified — see its own section below).** Explicit
user decision on Semaphore: its per-SMS cost wasn't worth it for this
project's actual volume. Full detail: `backend/DEVLOG.md` 2026-09-23
(3)–(7), 2026-09-24 (1)–(8).

## Where things stand

Sprints 0–7 complete. Sprint 8 (UAT/evaluation): every device-free box
was done 2026-09-17/18. Three real device sessions since: 2026-09-19
(first Infinix session, closed most hardware-blocked items), 2026-09-23
(second session — A1 down to 1 of 6 open, the three 2026-09-22 fixes
verified for real, C7 reclassified), 2026-09-24 (A4/A5 local GSM gateway
confirmed end-to-end including A4's subprocess-timeout fix, C7 root-caused
and fixed, M13 device-verified, critical-alert sound hardened on mobile
and web — A1 now fully closed, 6 of 6). Evidence screenshots:
`docs/evidence/2026-09-19-device/`.

**Branch/remote note (2026-09-22):** `main` had been stale since before
Sprint 8 while `develop` and feature branches carried all the real work
(PR #1 merged into `develop`, not `main`). `main` was fast-forwarded to
catch up. **By explicit user instruction, all work from now on commits
and pushes directly to `main`** — no more feature branches or PRs.
`develop` and `feature/push-body-incident-label` still exist on the
remote but are no longer the active line; don't build on them without
asking first.

**Credentials**: `baranguard_uiseed` password is `Demo@2026`.
`tanod.olayvar` is seeded suspended — use `tanod.reyes` (user_id 4),
`tanod.delacruz`, `tanod.gubaton`, or `tanod.dichoso`. `admin.dao` is
the Admin. `backend/.env` currently points at `baranguard_uiseed`.

## Semaphore removed — local GSM gateway is the new SMS transport

**Why**: explicit user decision, 2026-09-23 — Semaphore's per-SMS
aggregator cost (~₱0.50–0.56/SMS) wasn't justified for this project's
actual (barangay-scale) volume.

**What replaced it**: the SAME tethered phone that already does GSM
inbound ingestion (`gsm-ingest-daemon.php`, A5) now also SENDS, via a
new standalone Android project — `sms-gateway/` (its own Gradle project,
**not** part of the Capacitor Tanod app in `mobile/`; see its own
README). A single `BroadcastReceiver` (`SendSmsReceiver.java`) calls
`SmsManager` directly on the gateway phone's own SIM, triggered by
`backend/services/notifications/LocalGsmOutboundClient.php` over `adb
shell am broadcast`. No cloud call, no per-message fee, no API key —
sends over the phone's own SIM plan.

**Confirmed working end-to-end 2026-09-24**: two independent real SMS
sends through the actual production class, `correlation_id` verified
matching between the PHP call and the device's own logcat both times.
Found and fixed a real bug along the way — `adb shell` re-joins its own
arguments with a single space before sending to the remote Android
shell, corrupting multi-word extras (`correlation_id` arrived as
literally `"unknown"`); fixed by building the whole remote command as
one already-POSIX-shell-quoted string.

**Setup for a new gateway phone**: see `sms-gateway/README.md` — build,
`adb install`, `adb shell pm grant ... SEND_SMS`, then **launch the app
once** (a freshly-installed app is in Android's "stopped" state and
won't receive even an explicit broadcast until launched), then
`GSM_GATEWAY_ENABLED=true` in `backend/.env`.

**Known device quirks worth remembering**: this specific Infinix/XOS
build has its own proprietary background-app-freezer (`Usf_Hiber`,
logcat tag) separate from stock Android Doze — it can freeze a
backgrounded app's ability to receive broadcasts within seconds of
losing foreground/screen focus; a queued broadcast eventually delivers
once something (e.g. relaunching the app) triggers an unfreeze.

**Subprocess-timeout gap — CLOSED 2026-09-24.** The first `proc_open()`-
based timeout attempt was confirmed broken on Windows and reverted (see
gotcha #18 below). A real fix landed later the same day:
`LocalGsmOutboundClient::runWithTimeout()` now shells out to
`powershell.exe` (full path), which starts `adb.exe` via .NET's
`Process.Start()`/`WaitForExit(ms)` — a genuine OS-level timeout with no
relation to the broken `stream_set_blocking`/`stream_select` approach.
Device-verified in stages: an isolated `adb shell sleep 30` capped at 3s
was killed at 4.0s (`exitCode=124`); a real send through the production
class hit the 12s cap for real and failed with the new timeout message,
while logcat confirmed the remote broadcast still landed — a "timeout"
here means "we stopped waiting," not "nothing happened on the phone,"
and that tradeoff is disclosed in the class's own doc block, not silently
assumed safe. Full detail: `backend/DEVLOG.md` 2026-09-24 (5).

**What else changed**: `SystemHealthController` (`sms_gsm_gateway`
JSON field replaces `sms_semaphore`), `SettingsController` (the
now-vestigial `sms_gateway.api_key`/`sender_name` keys removed — no
cloud credential or sender name applies to this transport), the Settings
web page's whole "SMS Gateway" tab removed, `.env.example`
(`GSM_GATEWAY_ENABLED`/`GSM_GATEWAY_ADB_PATH`/`GSM_GATEWAY_DEVICE_SERIAL`
replace `SEMAPHORE_API_KEY`/`SEMAPHORE_SENDER_NAME`). `docs/REFERENCE.md`,
`docs/SETUP.md`, and the Master Reference doc were all reconciled in the
same pass — see DEVLOG for the full file list.

## C7 — CLOSED 2026-09-24: real fix, device-verified working

2026-09-23's battery-optimization exemption was confirmed granted, then
a real 35-minute locked-screen run was completed.

- **Process survival: confirmed, no regression.** Same PID the entire
  run, `PatrolLocationService` present at every 2-minute check — the
  original C7 hypothesis ("app dies ~50s in") is now settled: it doesn't.
- **But `gps_track` shows the last real fix landed 4 SECONDS before the
  screen locked, then nothing for the remaining ~36 minutes.** The
  foreground service and its notification stay alive and look healthy —
  but `FusedLocationProviderClient` genuinely stops delivering fixes the
  moment the screen locks. This is arguably worse than a crash: a crash
  shows up as a visible gap; this looks fine on every check available
  (`dumpsys`, the notification tray).

**2026-09-24 — researched properly (Android's own docs), then
implemented a real fix**: declaring `foregroundServiceType="location"`
is necessary but NOT sufficient for a service to keep receiving fixes
once the app itself drops out of the foreground (screen locked) — it
also needs `ACCESS_BACKGROUND_LOCATION`, which this app never declared
or requested. Added the manifest permission +
`PatrolLocationPlugin.requestBackgroundLocationPermission()` (Capacitor
declarative permission API, matches `VoiceRecorder`'s own pattern) +
wired into `startPatrolTracking()`. Device-verified GRANTED via
`dumpsys package` (the permission dialog *looked* like "while using the
app" to the person watching it, but the actual OS grant state said
otherwise — trust `dumpsys`, not the dialog's appearance).

**Retest: confirmed working, after correcting an initial misread.** A
live poll of `gps_track` mid-test appeared to show zero new rows and was
read as inconclusive (compounded by the phone being indoors, GPS
provider showing a stale `satellites=0` cached fix) — the monitor was
stopped early on that basis. **That read was wrong.** Querying
`gps_track` fresh right after showed a CONTINUOUS chain of real fixes
spanning the entire locked window — 17 minutes, every ~30-90s, normal
8-30m accuracy throughout. The live-poll "nothing yet" was a sync-delay
artifact (the phone's own upload batching), not a real stall. This is
real, measured evidence the fix works — dramatically different from the
original 4-second stall. Not proof beyond all doubt (a longer
outdoor/moving-patrol run would add confidence and is combinable with
the still-outstanding GPS moving run in REMAINING.md), but the core bug
is fixed. The recurring `FusedLocation: ... blocked - too close/too
fast` log lines seen during testing turned out to be a red herring —
real fixes kept landing despite them.

**Lesson**: when using a mobile app's server-side data as a live test
signal, remember sync delay is real — "no new rows yet" mid-test is not
the same as "nothing happened." Re-query after the window closes before
concluding a negative result. Full finding: DEVLOG 2026-09-23 (7),
2026-09-24 (2)-(3).

## M13 — SOS SMS fallback badge: device-verified for the success path

`SosSmsPlugin.java` (Android `SmsManager`, G1's third SOS tier) had never
been device-verified for a completed send. This session set
`sos_fallback.backup_contact_number` to a real phone (via `PATCH
/system-settings`), granted `SEND_SMS` up front, logged out/in as
`tanod.reyes` (required — `refreshSosFallbackContact()` only runs at
login, not at Live Map mount; `sosFallbackContact.ts`'s docblock wrongly
claimed otherwise and has since been corrected, DEVLOG 2026-09-24 (5)),
then went offline (`adb reverse --remove tcp:8081`) and held the Home
screen's Emergency SOS Backup control.

**Confirmed for real**, not just by the app's own claim: `adb shell
content query --uri content://sms/sent` showed the exact composed
emergency message actually sent, and — since the backup number was the
same device's own SIM — it also round-tripped into that device's own
Messages app as a second, independent confirmation. `SmsFallbackBadge`
correctly showed `saved_locally_for_retry` (grey) when the contact
wasn't yet cached, then `sent_by_sms` (green) once it was. Full detail:
`backend/DEVLOG.md` 2026-09-24 (4).

**Not exercised at the time**: `sms_pending`/`sms_failed`. A malformed-
number attempt to force `sms_failed` (2026-09-24) did NOT work and
revealed a real gap instead: `SmsManager` doesn't synchronously validate
the destination address, so the app reported `sent_by_sms` while nothing
was actually transmitted (no trace in `content://sms/sent`/`/failed`/
`/outbox`) — `sos_fallback.backup_contact_number` had no format
validation anywhere. `sos_fallback.backup_contact_number` was left set to
the real number (correct steady-state, not test residue) — the phone was
re-logged-in twice to pick up the malformed test value then restore the
real one, since its cache only refreshes at login. DEVLOG 2026-09-24 (7).

**Gap closed at the code level, 2026-09-24 (8) — not yet device-verified.**
No phone was attached this session, so this is a code-only fix per
SPRINTS.md's own "prove it, don't claim it" rule — treat it as closed
only after a real device retest. Two independent fixes: `SettingsController
::update()` now rejects a malformed `sos_fallback.backup_contact_number`
with 400 before it can ever reach a phone (tested against the real,
disposable `baranguard_uiseed` DB — malformed string → 400, a valid PH
number → 200, empty string to unset → 200). `SosSmsPlugin.java`
independently re-checks the same PH-mobile-number shape before ever
calling `SmsManager` (belt-and-suspenders — the setting could in
principle be set correctly and still arrive malformed some other way),
and now supplies a real `sentIntent` PendingIntent per message part
instead of trusting `sendTextMessage()`'s synchronous return, so a
genuine carrier-level rejection (airplane mode, no SIM, no service) will
report `sms_failed` for real. `mobile/src/services/sosSms.ts`'s docblock
corrected — it previously and wrongly claimed the failure path had
already been verified. `./gradlew assembleDebug` BUILD SUCCESSFUL; `npx
tsc --noEmit` clean; `php -l` clean. **Still needed**: install on the
Infinix and confirm (a) a malformed number now rejects immediately
client-side, and (b) airplane-mode/no-SIM produces a real `sms_failed`
badge, not just a code-level guarantee.

## Critical notifications now genuinely play sound (2026-09-24)

User-prompted audit found two real, separate gaps — not one.

**Mobile**: the M12 Critical Alert Overlay channel
(`CriticalAlertNotifier.java`) was `IMPORTANCE_HIGH` with no explicit
sound/vibration, relying on Android's plain default. Added an
alarm-usage sound (`RingtoneManager.TYPE_ALARM` +
`AudioAttributes.USAGE_ALARM`) and an explicit vibration pattern.
**Channel ID bumped to `baranguard_critical_alert_v2`** — a
NotificationChannel's sound/vibration is locked by the OS forever once
first created, so keeping the old ID would have made this fix a silent
no-op on every device that already has the app installed (including the
Infinix test phone).

**Web dashboard — a real gap, not a hardening.** There was no audio cue
at all on an incoming SOS/priority alert; a dispatcher with the tab
backgrounded had nothing but the topbar bell's badge dot. Added
`web/src/utils/criticalAlertSound.js` (Web Audio synthesized tone) wired
into `AppShell.js`'s existing 15s notification poller — a genuinely NEW
`sos`/`priority_alert` item now plays a tone, tracked by
`notificationId` so it never fires on already-seen items or on the
first load after a page refresh.

**Not done**: `setBypassDnd(true)` (letting the alert sound through Do
Not Disturb) — requires the user to separately grant "Do Not Disturb
access" from a system settings screen, a bigger ask than this session's
scope. Flagged, not silently skipped.

**Verified**: mobile — `./gradlew assembleDebug` BUILD SUCCESSFUL,
installed on the Infinix, user confirmed the Profile → Critical Alert
test now sounds and vibrates. Web — `verify-web-wiring.mjs` 557/557,
`web/tests` 397/398 at the time (`maps.test.mjs`'s SOS-marker-clustering
test failing) — a later full-suite re-run the same day came back
398/398 clean, so that failure was a flake, not a real regression (see
DEVLOG 2026-09-24 (8)). Full detail: `backend/DEVLOG.md` 2026-09-24 (6).

## Device-found bugs — status

- Fixed + device-verified 2026-09-19: fresh-install GPS permission gap,
  SQLCipher passphrase/`raw_narrative` in logcat (`loggingBehavior:
  'none'` now), cold-start `openLocalDatabase()` race, "15s" vs real 30s
  label.
- Fixed + device-verified 2026-09-23: the three 2026-09-22 bug fixes
  (heads-up dismiss on ACKNOWLEDGE, duty-unknown offline label, Home
  dispatch-card refresh-on-resume). The dispatch-card one turned out to
  have been **wrongly closed** on 2026-09-22 — it re-ran on every resume
  exactly as intended, but read a local cache (`dispatch_local`) that
  nothing but `assignments.tsx`'s own mount ever wrote to, so a dispatch
  arriving while the Tanod stayed on Home never actually reached the
  card. Real fix: `refreshActiveDispatches()` now calls `getDispatches()`
  + `cacheDispatchesFromServer()` first, same pair Assignments already
  uses. **Lesson**: a "fixed, code only, no device to verify" DEVLOG
  entry can be wrong in ways `tsc`/Gradle can never catch (a cross-screen
  data-flow gap, invisible to any type checker) — don't treat one as
  closed until a device session actually confirms it.
- Fixed + device-verified 2026-09-23: voice-recording evidence capture
  (A1 #3) — `stopVoiceRecording()` called `Filesystem.stat()`/`readFile()`
  on the voice-recorder plugin's own returned `path` with no `directory`
  option, but that `path` is relative, not absolute.
- Fixed + verified 2026-09-24: `LocalGsmOutboundClient`'s `adb shell`
  argument-quoting bug and its subprocess-timeout gap (see above), plus
  `sosFallbackContact.ts`'s stale docblock claim about Live Map mount.
- Fixed + device-verified 2026-09-24: `CriticalAlertNotifier`'s missing
  sound/vibration, and the web dashboard's total lack of an audible cue
  on new SOS/priority alerts (see above).
- Found 2026-09-24, fixed at the code level (not yet device-verified):
  `sos_fallback.backup_contact_number` had no format validation
  anywhere — a malformed value could make `SmsManager` silently drop a
  send with zero trace in `content://sms/*`, while the app still
  reported `sent_by_sms` (false confidence). Found while trying to test
  M13's `sms_failed` state; see "M13" section above for the two-part fix
  (server-side validation + `sentIntent`-based real send result).
- Push body "a animal_complaint" grammar fixed earlier (`7e9952a`),
  still standing.

**Decision taken (option B, 2026-09-19):** the app shell gates on a
session *existing*, not on the 15-min JWT being locally unexpired
(`hasStoredSession`), so a Tanod out of range >15 min keeps cached
dispatches/map/reports on cold start. Server still 401s the stale token
on first contact.

**A2/A6 (AI eval)**: unchanged — redaction has a real run (98.26% recall
/ 75.88% precision, Bikol weakest); other 7 tasks need a friend's faster
hardware (`eval-kit/README-FOR-FRIEND.md`).

## Things most likely to bite you

1. A native exception on Capacitor's plugin-invocation thread can't be
   caught by JS try/catch — needs a native pre-check instead.
2. Never mount an Ionic tab shell at a root catch-all (`/*` or `*`) —
   `@ionic/react-router` 9.0.3 mishandles it (C6's cause, fixed). Keep
   shells at a named prefix (`/tabs/*`) with relative children.
   `location.pathname` being right doesn't prove the screen is — read
   the outlet's actual view stack if in doubt.
3. Every static check here (`node --check`, `verify-web-wiring.mjs`,
   `php -l`, `tsc`) can be green on code with a P0 defect — several real
   bugs needed a live device/HTTP call to surface.
4. A verify script proves nothing about a route it never calls — grep
   the `.sh` before trusting a green result.
5. `backend/.env` may point at `baranguard_uiseed`, not `baranguard`,
   and isn't git-tracked — check it before trusting any real-DB claim.
   Same file may be missing secrets a feature needs (`DEVICE_SECRET_
   MASTER_KEY`, `INTERNAL_SERVICE_TOKEN` were both unset until
   2026-09-18) — check `.env.example` for what SHOULD be there.
6. Gradle's daemon JVM follows `JAVA_HOME`, not `java` on PATH —
   `./gradlew --stop` then re-export before building.
7. A named PDO parameter can only bind ONE placeholder occurrence under
   native prepares (`ATTR_EMULATE_PREPARES => false`) — bit
   `GET /incidents/nearby` for its whole lifetime (fixed).
8. OSRM's build moved to vcpkg-from-source between v5.x and v26.x, no
   more v5.x tags — irrelevant now (routing runs on ORS) but a trap if
   self-hosting is ever revisited.
9. Google Maps Platform requires a billing card for ANY API key, even
   free-tier — confirm before starting a Google Cloud integration here.
10. An already-open browser tab (or a Capacitor WebView after a process
    relaunch) can keep running a stale JS/asset bundle even after the
    server has the fix — try a brand-new tab, or `adb shell pm clear`,
    before assuming a fix is wrong. Also: `adb shell pm clear` resets
    RUNTIME PERMISSIONS, not just data — check `dumpsys package
    ph.baranguard.tanod | grep granted` before trusting any GPS/camera
    test after a clear.
11. `backend/scripts/bootstrap-admin.js`'s own header comment documents a
    `BARANGUARD_BOOTSTRAP_JSON` env var for non-interactive/CI use — the
    code never actually reads it. Piping answers via stdin in the same
    order as the prompts is the real non-interactive path today.
12. Capacitor live-reload (`CAP_LIVE_RELOAD=1`) over
    `adb reverse tcp:5173 tcp:5173`: the port mapping silently drops on
    every USB disconnect/reconnect. The whole adb connection can also
    drop mid-session — check `adb devices` before trusting any
    "still connected" assumption from earlier in a session.
13. A live-reload WebView reload resets JS module-level state without
    restarting the native process, so a native plugin's own connection
    can survive the reload while the JS side thinks it's starting fresh.
    Bit twice: `localDatabase.ts`'s early "Connection already exists",
    then THREE concurrent `openLocalDatabase()` calls at cold start
    (singleton assigned only after several awaits) — guard the
    in-flight promise, not just the result.
14. Capacitor's default `loggingBehavior: 'debug'` prints every plugin
    result to logcat — including SQLite rows and secure-storage reads.
    It is now `'none'` in `capacitor.config.ts`; if you need bridge logs
    to debug, `CAP_DEBUG_LOGGING=1 npx cap sync android`, and never ship
    that build.
15. `adb reverse tcp:8081 tcp:8081` is how the phone reaches this PC's
    backend over USB (default API base `localhost:8081`); `adb reverse
    --remove tcp:8081` is a clean way to make the workstation
    "unreachable" for offline tests without touching phone settings.
16. A "fixed, code only, no device to verify on" DEVLOG entry can be
    wrong in ways `tsc`/Gradle compile can never catch — 2026-09-22's
    Home dispatch-card refresh fix re-ran on every resume exactly as
    intended, but read a local cache that nothing else in the app was
    updating, a cross-screen data-flow gap no type checker sees. Don't
    treat a code-only fix as closed until a device session actually
    confirms it (SPRINTS.md's "prove it, don't claim it").
17. `adb shell <cmd> <arg with spaces>` does NOT preserve multi-word
    arguments as atomic tokens on the remote Android shell — `adb shell`
    re-joins its own arguments with plain spaces before sending, so
    anything with internal spaces gets word-split again remotely unless
    the ENTIRE remote command is built as one already-shell-quoted
    string and passed as a single argument. `escapeshellarg()` only
    protects the LOCAL hop.
18. PHP's `proc_open()` + `stream_set_blocking(..., false)` for a
    subprocess timeout does NOT work on Windows — confirmed by direct
    test (`stream_set_blocking` is a documented no-op for `proc_open`
    pipes there; `stream_select()` is also unsupported for non-socket
    streams on Windows). A real Windows subprocess timeout needs a
    different mechanism (e.g. shelling out to a PowerShell
    `Start-Process -Wait` wrapper with its own kill timer).
19. A freshly-installed Android app is in the OS's "stopped" package
    state and will NOT receive even an explicit targeted broadcast until
    launched at least once (`adb shell monkey -p <pkg> -c
    android.intent.category.LAUNCHER 1`).
20. This Infinix/XOS build has a proprietary background-app-freezer
    (`Usf_Hiber` in logcat) separate from stock Android Doze — can
    freeze a backgrounded app within seconds, delaying broadcast/service
    delivery until something unfreezes it (e.g. relaunching).
21. Git-Bash `/c/...`-style paths break native `curl.exe` too, not just
    `php.exe` (gotcha #4 already covered php) — `curl -F file=@/c/Users/.../
    photo.jpg` fails silently with `errormsg: Failed to open/read local
    data from file` (curl exit 26), giving `%{http_code}` of `000` with no
    other clue why. `cygpath -m` the path first, same fix as php.exe.
    Found writing `verify-device-signature.sh` (2026-09-24).

## Recommended next step

Everything below needs either the Infinix X6840 in hand, a second phone,
or a human decision/credential — nothing left is a pure coding-session
task.

1. **GPS moving run, outdoors** — a Tanod walking a known Dao street with
   the app on duty; compare `gps_track` against the road. C7's fix is
   already device-verified working (17 min stationary indoor locked-
   screen run); this adds outdoor/moving confidence, doesn't need to
   re-litigate the fix itself.
2. **C2 (Task Scheduler wiring)** / **B3 (restore drill)** — need your
   schedule/account call and `BACKUP_ENCRYPTION_PASSPHRASE`.
3. **Hand `eval-kit/` to faster hardware** for the other 7 model tasks.
4. **M13's `sms_failed` state — fixed at the code level 2026-09-24 (8),
   needs a device retest.** The malformed-number gap (`SmsManager`
   silently dropping a bad send while the app claimed `sent_by_sms`) is
   closed two ways: `SettingsController::update()` now 400s a malformed
   `sos_fallback.backup_contact_number` server-side (verified against
   the real disposable DB), and `SosSmsPlugin.java` independently
   re-validates the same shape client-side AND now uses a real
   `sentIntent` result instead of trusting `sendTextMessage()`'s
   synchronous return — so a genuine carrier rejection (airplane mode,
   no SIM) should now surface as a real `sms_failed`, not a false
   `sent`. `./gradlew assembleDebug` succeeded; no phone was attached
   this session to install and confirm on-device. DEVLOG 2026-09-24 (8).
5. **Critical-alert DND bypass** — the mobile critical-alert channel now
   has a real alarm sound/vibration, but does not bypass Do Not Disturb;
   that needs the user to separately grant "Do Not Disturb access" from
   system settings, a bigger ask than a code change. Decide whether it's
   worth prompting for.
6. **Two fixes from the 2026-09-24 pre-commit code review, reasoned but
   not device-verified** (DEVLOG (9)): the `LocalGsmOutboundClient.php`
   Windows `Start-Process` argument-quoting fix (needs a real send with
   a `"` in the message/number to confirm) and the
   `patrolLocationService.ts` permission-request sequencing fix (needs a
   fresh-install retest to confirm the background-location dialog now
   reliably surfaces).
7. **H-09 (device signature) — code-complete, needs a device session**
   (DEVLOG (16)): install the rebuilt APK on a Tanod device, log in
   (registers a new Keystore keypair + sends the public key to
   `POST /devices/register` — confirm `mobile_device.device_public_key_pem`
   is actually populated, not just that login succeeds), then confirm a
   real GPS ping / evidence upload / dispatch status update succeeds with
   the signature headers attached (check `.env`'s PHP error log or a
   packet capture for `X-Device-Signature` actually being sent, since a
   silent signing failure degrades to "works exactly like before H-09"
   with no visible symptom). Also worth confirming StrongBox availability
   either way (falls back to normal Keystore silently on most devices,
   including likely the Infinix — not a bug if it falls back, just worth
   knowing). `./gradlew assembleDebug` succeeded; nothing about the actual
   Keystore runtime behavior has been confirmed on real hardware.

**A5, A4 (including its subprocess-timeout gap), C7, and M13's primary
success path are all closed.** M13's `sms_failed` gap is fixed at the
code level, pending device confirmation (item 4 above). The
`maps.test.mjs` "SOS markers are never clustered" failure noted in an
earlier snapshot did not reproduce on a later full-suite run
(398/398, 2026-09-24) — treated as a flake, not a real regression; no
longer on this list.

**F1/C-03 (API base URL / HTTPS) — the requirement came back 2026-09-26,
and IS now on this list. Superseded again, same day: this machine now
runs the tunnel.** Earlier the same day, entry (27) found this machine
had no `cloudflared` at all and concluded it must be a separate
dev/staging box from wherever the original tunnel ran. **User then
clarified: this machine IS meant to be the production workstation going
forward.** Entry (28) set it up here for real — not a copy of the
original tunnel (its credentials never left the other machine and
weren't fetched, deliberately, per a safety guardrail on extracting an
existing tunnel's connector token): a brand-new tunnel, `baranguard-main`
(id `eeaa890d-a1dd-49aa-bc9b-3baff21a2e9d`), created locally on this
machine, with `baranguardph.win`/`api.baranguardph.win` DNS re-routed to
it via `--overwrite-dns`. **Verified live with real HTTP calls from this
machine**: `curl` returned real `200`s and real content — the actual
four barangays from `GET /api/v1/barangays`, the real dashboard
`<title>`, not just a status code check.

**Read this before assuming real data is exposed publicly**:
`backend/.env` on this machine is still pointed at `baranguard_uiseed`
(the demo/seed DB) — a deliberate, explicit choice this session (set up
the infrastructure first, defer the database switch). Anyone hitting
`baranguardph.win` right now sees DEMO data. Don't flip `DB_NAME` to the
real `baranguard` database without the user explicitly asking for that
— it's a separate, consequential decision from standing up the tunnel
itself, and REFERENCE.md §1 says so explicitly now too.

**The original `baranguard` tunnel (id `28c3134b-1a35-4c85-971a-
0fb18f262493`) still exists in the Cloudflare account, now orphaned** —
no DNS points to it anymore, but it was never deleted (its earlier
"active connections" were assumed stale per the user's own call, not
independently confirmed dead). Ask before deleting it if it comes up —
that's a one-way action on an object neither this session nor the prior
one fully investigated.

**Step 1 (`cloudflared service install`) is DONE as of entry (29), same
day.** The tunnel now runs as a real Windows service (`AUTO_START`,
`LocalSystem`) and survives a reboot. Getting there needed more than the
bare install command — `service install` never actually seeds a working
config for a locally-managed tunnel (confirmed via Windows Event Viewer:
every service start logged zero arguments, and a hand-written
`config.yml` kept getting silently overwritten back to a stub on every
restart). Real fix: `sc.exe config cloudflared binPath=` was set
directly to `cloudflared.exe --config "C:\Users\danilyn\.cloudflared\
config.yml" tunnel run baranguard-main`, routed through `cmd /c` to dodge
a PowerShell/native-exe quoting fight (same class of gotcha as
REFERENCE.md §8's existing `curl.exe`/`php.exe` entries — worth adding
there too if this bites again). Verified for real: killed every
`cloudflared.exe` process, confirmed via `tasklist` exactly one remained
(the service), then got real `200`s with real content from both
hostnames — the service alone is doing the work.

**Still open, explicitly deferred (not forgotten) — 2026-09-26 (29,
continued).** Went to set up Zero Trust/Access and corrected the plan
first: the original wording ("Access policy in front of
`api.baranguardph.win`") would have been a mistake to implement literally
— confirmed `GET /api/v1/barangays` and other citizen-facing endpoints
are intentionally public with no auth, and Access's email-OTP flow is
browser-redirect-based, which the mobile app's programmatic API calls
can't complete. Gating the whole API host would have broken real
citizen-facing features and likely the mobile app too. Re-scoped with
the user to **the web dashboard host only** (`baranguardph.win`), which
doesn't touch the API at all — Tanods on mobile are unaffected either
way. Walked through the exact dashboard steps (Zero Trust team name →
Access Application for `baranguardph.win` → an Allow policy listing
specific staff emails) and confirmed Access ties to the PERSON'S EMAIL,
not the device, so anyone on the allowed list can reach the dashboard
from any device once added — but **the user chose to skip this for now**
rather than commit to an email allow-list on the spot. Nothing was
created in the Cloudflare dashboard. Revisit whenever ready — the actual
steps are recorded here and in `docs/DEVLOG.md` 2026-09-26 (29,
continued) so this doesn't need to be re-derived from scratch, and the
scoping correction (web dashboard only, not the API) should carry over
even if a future session's `REMAINING.md`/`REFERENCE.md` wording still
says "either hostname."

Full detail: `docs/DEVLOG.md` 2026-09-26 (28), (29). Full ordered backlog with
reasoning: `docs/REMAINING.md`.

## Operational quick reference

```bash
# Retention (dry-run FIRST on real data — deletion is irreversible by design)
php backend/scripts/retention-job.php --dry-run
php backend/scripts/retention-job.php --list

# Restore drill (records the drill; W20 shows "Never" until you run it)
BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh

# AI worker
cd backend && php scripts/ai-worker.php --status

# GSM ingestion daemon (once the phone's adb-reachable) — inbound
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

# Web wiring check — run after ANY web change
node web/scripts/verify-web-wiring.mjs

# Web render tests (no backend needed; one-time `npm install` in web/tests)
cd web/tests && npm test

# Mobile static checks — run after ANY mobile change
cd mobile && npx tsc --noEmit && npm run lint && node scripts/verify-local-schema.mjs

# Sprint 8 evidence scripts (all safe to re-run — real backend/DB, self-restoring)
php backend/scripts/verify-json-contracts.php                 # 43 GET routes, envelope schema
php backend/scripts/verify-auth-lockout-revocation.php        # lockout + session revocation
bash backend/scripts/verify-b2-pentest-remaining-resources.sh # tenant/ownership pentest
bash backend/scripts/verify-scheduler-fatigue.sh               # fatigue flags + scheduler

# Turn-by-turn routing (real ORS block runs only with a real key in backend/.env)
bash backend/scripts/verify-routing.sh

# Device registration + map-packages
bash backend/scripts/verify-devices-map-packages.sh

# Evidence upload
bash backend/scripts/verify-evidence-upload.sh

# Sprint 3 backend (gps, dispatch status, sync/batch, nearby, mobile incidents)
bash backend/scripts/verify-sprint3.sh

# Backup/second responder
bash backend/scripts/verify-second-responder.sh

# Build + install the mobile Tanod app onto a connected Android device
cd mobile && npx vite build && npx cap sync android
cd android
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
export TMPDIR=C:/gtmp TEMP=C:/gtmp TMP=C:/gtmp
export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=C:/gtmp"
./gradlew --stop && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p ph.baranguard.tanod -c android.intent.category.LAUNCHER 1

# Check whether a Cloudflare Quick Tunnel is currently running (temporary
# remote testing only — see REFERENCE.md §1; not a production access path)
tasklist //FI "IMAGENAME eq cloudflared.exe"

# Set up the real, persistent Cloudflare Named Tunnel (C-03) — idempotent,
# safe to re-run. Needs `cloudflared tunnel login` already done once
# (interactive/browser-based, not scripted). See docs/SETUP.md stage 4.2.
bash backend/scripts/setup-cloudflare-tunnel.sh yourdomain.win

# One-time backend/.env generation for a fresh machine — interactive,
# auto-generates the three required secrets, asks about each optional
# integration. See docs/SETUP.md stage 1.4.
bash backend/scripts/setup-env.sh

# One-time mobile Android platform setup for a fresh machine (SDK must
# already be installed). See docs/SETUP.md stage 2.
bash mobile/scripts/setup-android-platform.sh
```

**Day-to-day: double-click `Start Baranguard.bat`** (repo root — copy a
shortcut to the Desktop) to start Apache/MySQL/the AI worker (whichever
of the three isn't already running — safe to click more than once, never
starts a duplicate worker) and open the dashboard. No admin rights
needed. This is the practical answer for "the redaction isn't doing
anything" — check that this was run today. See DEVLOG 2026-09-26 (26).

**For true zero-click power-on autostart instead** (needs a one-time
Administrator prompt, and does NOT replace the double-click launcher —
pick one): Apache/MySQL/the Cloudflare tunnel/the AI worker don't start
themselves by default, so a reboot takes all four down until someone
starts them (hit this directly 2026-09-26: once for Apache/MySQL/
cloudflared, again separately when a user's redaction sat doing nothing
because nobody had started `ai-worker.php` at all). From an elevated
PowerShell prompt, once:

```powershell
powershell -ExecutionPolicy Bypass -File backend\scripts\install-autostart-services.ps1
```

Idempotent, installs Apache2.4/MySQL/cloudflared as real auto-starting
services AND registers `BaranguardAiWorker` as a Scheduled Task
(`ai-worker.php --daemon`, starts at boot as SYSTEM, no login needed,
self-restarting) — prints an uninstall cheat-sheet for all four. See
docs/SETUP.md stage 5. **Not run this session** — needs an Administrator
prompt this session doesn't have; the double-click launcher above is the
one actually in use. `ai-worker.php`'s own `--daemon` mode also had a
real bug fixed in the same pass as this script: it used to exit entirely
(not just skip a job) if Ollama was ever unavailable for too long — see
DEVLOG 2026-09-26 (25).

**The retention job and restore drill are now BOTH scheduled** (2026-09-26
(35)) via a separate script — unlike the one above, this one did NOT need
an elevated prompt:

```powershell
powershell -ExecutionPolicy Bypass -File backend\scripts\install-scheduled-backup-jobs.ps1
```

Registers `BaranguardBackupRetention` (daily 02:00 — `backup.sh` then
`retention-job.php` for real) and `BaranguardRestoreDrill` (weekly Sunday
03:00 — `restore-drill.sh`), both reading `backend/.env`'s
`BACKUP_ENCRYPTION_PASSPHRASE` themselves. Logs land in
`backend/backups/scheduled-logs/`.

## Conventions

Commits: `[Tag] Short description`, ending with the `Co-Authored-By:`
line the current session instructions specify. Real remote (`origin` →
`github.com/jpbuenosaires/Baranguard`) — push before ending a session
that adds real work, not just when asked. **As of 2026-09-22, commit and
push directly to `main`** — no feature branches, no PRs, by explicit
user instruction.

Rewrite this file — don't append — at the end of any session that
changes the picture. A stale `HANDOFF.md` is treated like a stale DEVLOG
claim: verify against the repo before trusting it.
