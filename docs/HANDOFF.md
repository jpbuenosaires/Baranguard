# Baranguard — Session Handoff

**Session J (2026-09-04, latest): Sprint 7's "Retention jobs" box — DONE
and GENUINELY VERIFIED, 66/66 via
`backend/scripts/verify-sprint7-retention.sh` against real XAMPP.** All
eight §11 record types are implemented in
`backend/services/retention/RetentionService.php` and run from the CLI
`backend/scripts/retention-job.php` (`--dry-run`, `--only=`, `--list`).
Three things a later session must know:
(1) **Migration 0007 was required and is already applied to the real
local `baranguard` database** — §11 was *not implementable* against the
0001 baseline: `incident.raw_narrative` was `TEXT NOT NULL` (nothing to
write to mean "purged"), `incident` had no `legal_hold` even though §11
calls legal hold the only exception, nothing recorded that a purge had
happened, and `mobile_device` had no deactivation timestamp for the
90-day clock. If you are on a DIFFERENT machine/DB, run
`mysql -u root baranguard < backend/migrations/0007_retention_columns.sql`
**before anything else — `DevicesController` now writes
`mobile_device.deactivated_at` and will 500 without it.**
(2) **That dependency caused a real regression this session**: three
older verify suites build their disposable DB from 0001+0002 only and
started failing device registration with 500s. Fixed by having each apply
0007 (`verify-devices-map-packages.sh` 54/54, `verify-sprint4.sh`,
`verify-sprint4-phase2-3.sh` 69/69 all green again, plus
`verify-sprint6.sh`). Adding a column to a controller's SQL breaks every
suite whose schema predates it — re-run the old suites, not just the new
one.
(3) **Nothing is scheduled.** The job is CLI-only by design (no HTTP
endpoint, same reasoning as `ai-worker.php`); wiring it to Windows Task
Scheduler daily is an outstanding runbook step. It is safe to re-run and
safe to miss days. **Run `--dry-run` first on any database with real data
in it** — retention deletion is irreversible by design. A dry run against
the real DB today reports 0 eligible for every rule, which is correct:
nothing on this workstation has aged past even the 90-day ceiling.
Backups are deliberately out of scope for the job (§11/Rule 11 still
apply to them — expiring `scripts/backup.sh` output is a separate runbook
step, and the job prints that reminder on every run). Sprint 7's other
four boxes (audit completeness, backup/restore drill, pen-test pass,
W17/W20/W9-export) are **not started**. Full detail in
`backend/DEVLOG.md`'s Sprint 7 entry.

**Last updated: 2026-09-04. Session I: STOPPED MID-WORK for a conversation
handoff — READ THIS BEFORE TOUCHING THE WEB FRONTEND.** A 9-phase
mockup-driven UI plan was written, checked against the schema/§8 rules,
and **approved by the user** — full plan at
`C:\Users\Jayson Buenosaires\.claude\plans\clever-wishing-hummingbird.md`.
Phases 1 (Dispatch queue double-scrollbar fix), 3 (avatar menu +
notification bell, incl. a new `GET /notifications` endpoint), and 4 (KPI
card convention) are **code-complete but never browser-verified**. Phase 2
(Blotter Entry two-column reorg) is **half-done and currently breaks**
`node scripts/verify-web-wiring.mjs` — `blotter-detail.js` references a
CSS class (`blotter-detail__main`) whose stylesheet was never created.
**Fix that first.** Phases 5-9 (Incident Management, Electronic Blotter
rebuild, Settings restyle, SMS log filters, Analytics + new chart
components) have **not been started at all**. Full detail, file-by-file,
in `backend/DEVLOG.md`'s newest entry — including the constraint table of
which mockup elements the schema/§8 rules do NOT support (a cross-barangay
comparison chart, a composite "performance score" radar, an SMS
compose/reply console, and W21's system-settings sections are all
explicitly out of scope, not just deferred). One stray database,
`baranguard_device_check`, exists locally and was flagged but not touched.
**UPDATE (Session J): all nine phases are now code-complete and the whole
lot — Sessions G, H and I together — is COMMITTED AND PUSHED as
`0b6e551`. It is still browser-UNVERIFIED; the checklist at the bottom of
`.claude/plans/clever-wishing-hummingbird.md` is the outstanding work,
and it is written to be worked through by the user, not re-derived.**

**Session H: acted on the interface audit — all
cross-cutting items plus the highest-value per-screen ones, and replaced
the dashboard bar chart with a two-series (reported vs resolved) line
chart at the user's request. Three things a later session must know:
(1) **the `html { font-size: 75% }` scale knob had never worked** —
`html, body` set font-size again further down at equal specificity, and
`rem` on the root resolves against the browser's initial 16px, so the app
has always rendered at a 16px root. It is now genuinely wired and set to
100%, which is what was rendering anyway, so nothing changed visually.
(2) **`--color-*-solid` tokens are new and must be used for any white
text/glyph on a saturated fill** — the plain status tokens lighten in dark
mode, which put the SOS banner at 2.77:1 and the KPI glyphs at 1.67:1.
(3) **the dark palette's values now live once** in `:root` as `--dark-*`;
the `prefers-color-scheme` and `[data-theme="dark"]` blocks only remap
onto them, because the old duplicated copies drifted the moment one was
edited. Verified: contrast re-audit **46 pairs / 0 failures** in both
themes (was 23 failures), web wiring **313/313**, diff-algorithm unit test
6/6, and a live browser pass with zero console errors across all 12
screens. Dispatch Center now polls every 15s — it previously never
refreshed itself, so a new incident or Tanod SOS never reached the
dispatcher. `GET /reports/summary`'s `trend[]` gained a `resolved` field
bucketed on `dispatch.completed_at` (the only resolution timestamp §5
records); it deliberately does not reconcile with `resolved_count`, and
both the controller and the API client say so. **Not committed.** Full
detail in `backend/DEVLOG.md`'s newest entry.

**Session G: a user-directed UI/UX completion
pass across web + mobile (not a Sprint Prompts box) — dark mode, DataTable
pagination/CSV/zebra/empty-state, sidebar badge counts (new `GET
/reports/nav-counts` endpoint), map clustering + click-to-zoom, KPI
sparklines, a PWA manifest, and a mobile parity pass (duty-toggle toast +
sign-out confirmation). Scoped and approved in advance via a 9-phase
written plan. **Genuinely verified via a real browser + disposable-DB
sweep**, not just claimed — see `backend/DEVLOG.md`'s newest entry for the
full evidence, including two real bugs found and fixed (`GET /sms/logs`
500'd on an under-migrated test DB — fixed by applying the missing
migrations to that DB, not an app bug; a QA seed script's `NOW()` vs
`UTC_TIMESTAMP()` mismatch produced a negative GPS age on-screen — fixed
in the seed script, not an app bug) and one real pre-existing gap fixed
along the way (`historical-heatmap.js` was the one screen an earlier
session's "every page migrated to PageHeader" pass had missed — a raw
`<h2 style="...">` in violation of §8, now migrated like every other
screen; `verify-web-wiring.mjs` 300→311 checks passing). **Nothing from
this session is committed yet** — sitting in the working tree pending the
user's go-ahead, per this project's own standing convention. Read
DEVLOG's entry before extending any of this pass's work — it names every
resolved decision (the new `--color-surface` token vs. the existing
theme-invariant `--color-white`; the hand-rolled DOM clustering instead
of MapLibre's native `cluster:true`, and why; sparklines scoped to Total
Incidents only, not Resolved, and why) and exactly what's still deferred.

**Session A: Sprint 2's leftover mobile
`POST /incidents` branch + ALL of Sprint 3 (coded, unverified). Session B:
ALL of Sprint 5, the AI pipeline (coded, unverified). Session C: Sprint 6
— and unlike A and B, **Sprint 6's code is genuinely VERIFIED, 112/112 via
`backend/scripts/verify-sprint6.sh` against real XAMPP**, plus 286 static
web-wiring checks and a real browser pass over W7/W8. Session D: Sprint 4
Phase 1 (notification model, Tanod SOS, acknowledgment) — VERIFIED, 48/48
via `backend/scripts/verify-sprint4.sh`, committed and pushed (`8599f09`).
Session E: Sprint 4 Phases 2-5 — THIS CLOSES SPRINT 4. FCM/SMS transport,
Rule 12's fallback ladder, the ack-timeout worker, device secret
provisioning, AES-256-GCM SMS envelope crypto, the internal-only
`/internal/sms/*` router, W14, and M12/M13 (mobile). **The backend half
(Phases 2-3) is genuinely VERIFIED — 321 checks passing across FIVE
suites, zero failures** (that session's own new 68 +
`verify-sprint4.sh`'s 48 + `verify-sprint6.sh`'s 112 +
`verify-devices-map-packages.sh`'s 53 + `verify-duty-status-map-upload.sh`'s
40), plus 300 static web-wiring checks and a real browser pass over the
new W14 screen. **COMMITTED AND PUSHED** to `origin/main` (`e578561`).
Read `backend/DEVLOG.md`'s Sprint 4 Phases 2-5 entry before trusting or
extending any of it — it is long, and the "Two 'no live credentials,
verify it anyway' notes" section near the top explains exactly why the
backend numbers above are trustworthy despite having no real FCM/Semaphore
account. Session F (same day, follow-up): **fixed the mobile build** —
`@capacitor/geolocation` and `@capacitor/push-notifications` were declared
in `package.json` but `npm install` had never actually been run for
either, which is the entire reason Sprint 3's mobile code "couldn't
compile." Now fixed (`npm install` run, one real type error found and
fixed in `deviceIdentity.ts`, `tsc`/`eslint`/`npm run build` all clean),
and confirmed working end-to-end with a real browser walkthrough — see
"Mobile app now confirmed working" below and DEVLOG's "Mobile build fix"
entry. **The mobile half of Phase 5 (M12/M13) is still UNVERIFIED ON A
REAL DEVICE** — the fix above proves the web-preview/TypeScript layer
works, not a native Android build; same standing Android SDK/JDK 21
blocker as every mobile cut since Sprint 3. Sprints 3 and 5 remain
coded-but-unverified on a device.

**Mobile app now confirmed working (Session F, 2026-09-03):** a full live
browser walkthrough — real login, Home (real name/duty status), M5
Assignments, M7 Map, Profile (M12's new notification diagnostics), M3 Log
Incident — all render correctly with zero unexpected console errors
against a disposable backend. `npm run verify.schema` also re-confirmed
113/113. Full detail in DEVLOG's "Mobile build fix" entry. This was NOT
committed as part of Session E's push — the `npm install`-driven
`package-lock.json` change and the `deviceIdentity.ts` type fix are
tracked separately; check `git status` before assuming they're already on
`origin/main`.

**Housekeeping done in Session E (2026-09-03, follow-up pass):** migrations
0004 (`blotter_revision`), 0005 (`sms_envelope_replay`), and 0006
(`sms_log.barangay_id`) have all been applied to the real local
`baranguard` database — confirmed via `DESCRIBE`/`SHOW TABLES`. Blotter
finalize/amend and the full SMS/notification pipeline are now unblocked on
this machine. The two scratch PNGs under `mobile/` were deleted earlier
that session.

**The one number that matters for the AI work: the MODEL has still never
been called.** Everything verified was verified with SQL-seeded draft rows
and `OLLAMA_URL` pointed at a dead port. Whether the redaction is any
*good* is a separate question only the evaluation harness can answer — see
`docs/AI_Evaluation_Dataset_Guide.md`.

This file is the one thing to read to pick this project back up cold. It's
a snapshot, not a substitute for `backend/DEVLOG.md` (the full narrative
history) or `docs/Baranguard_Sprint_Prompts.md` (the per-sprint menus) —
update this file at the end of a session, don't let it go stale for long.

## Where things stand right now

- **Sprint 2's leftover + all of Sprint 3 are committed and pushed** to
  `origin/main` (`392a4b3`) — coded but unverified, and the commit
  message says so explicitly.
- **Sprint 5 (the AI pipeline) is committed and pushed** (`d808bfa`), and
  the earlier `web/` UI-polish work too (`c46e2c3` — Toast, ConfirmDialog,
  sortable DataTable).
- **All of Sprint 6 is committed and pushed** to `origin/main` (`4f13dd1`).
- **Sprint 4 Phase 1 is committed and pushed** to `origin/main`
  (`8599f09`) — notification model, `POST /tanod-sos` +
  acknowledge/resolve, `POST /notifications/:id/ack`, dispatch-triggered
  notifications, `/sync/batch`'s `sos[]`. Verified 48/48 real-XAMPP, and
  `verify-sprint6.sh` re-confirmed still passing 112/112 alongside it.
  **Nothing is actually delivered to anyone yet** — no FCM/SMS attempt is
  made, `notification_delivery` is never written. Phases 2-5 are next for
  Sprint 4 (see the dedicated section below).
- **Migration 0004 (`blotter_revision`) is now applied** to the real
  local `baranguard` database (done this session, confirmed via
  `DESCRIBE`). If you're on a DIFFERENT machine/DB than this one, you
  still need to run it there:
  `mysql -u root baranguard < backend/migrations/0004_blotter_revision.sql`.
- The two `mobile/.scratch-screenshot*.png` files have been deleted.
  Working tree is clean.
- Everything from the earlier "Sprint 2 remaining items" session (backend
  `POST /duty-status` + `POST /map-packages`, M2 Home, bottom-nav tabs,
  photo/voice capture, Keystore passphrase, Inter font vendoring, the
  htdocs-junction work) is **committed and pushed** to `origin/main`
  (`b9f7c7c`), unchanged by these sessions.
- **Sprint 0 + Sprint 1: fully complete**, real-XAMPP verified, committed
  and pushed. Unchanged since the last handoff.
- **Sprint 2 (mobile): every code box is done, including the leftover
  mobile `POST /incidents` branch (coded this session — see below).** What
  remains is entirely device verification — see "Android native build
  environment" below, unchanged this session.
- **Sprint 3: all five "Today's cut" boxes were CODED, none verified.**
  See the dedicated section below before treating any of it as done.
- **Sprint 4: ALL FIVE PHASES DONE. Sprint 4 is closed.** Phase 1
  (notification model/SOS/ack) was VERIFIED 48/48 in the prior session.
  Phases 2-5 (this session) add real FCM/Semaphore transport clients, the
  full Rule 12 fallback ladder, the 60s ack-timeout worker, device secret
  provisioning, real AES-256-GCM SMS envelope crypto, the internal-only
  `/internal/sms/*` router (6 endpoints), W14, and mobile M12/M13.
  **Backend (Phases 2-3) is genuinely VERIFIED — 68/68 new checks
  (`backend/scripts/verify-sprint4-phase2-3.sh`) plus 48/48 + 112/112 +
  53/53 + 40/40 on every pre-existing suite re-run to confirm zero
  regression = 321/321 total, real XAMPP.** No live FCM/Semaphore
  credentials exist on this machine, but see DEVLOG's "no live
  credentials, verify it anyway" notes for why that doesn't mean
  untested — the FCM-not-configured/Semaphore-not-configured code paths
  ARE Rule 12's real logic, exercised for real. **A Tanod's phone still
  does not physically buzz** — that specific last hop (a real Firebase
  project + a funded Semaphore account) is the one thing genuinely
  outside this environment's reach. **W14 (web) is real and
  browser-verified.** **M12/M13 (mobile) are coded but UNVERIFIED** — same
  Android SDK/JDK 21 blocker as everything mobile since Sprint 3, PLUS a
  new second prerequisite for full device testing: a real Firebase
  project. M2's SOS button in the mobile app is STILL disabled — wiring
  the mobile UI to the now-fully-built SOS/notification backend was not
  part of this cut either; that's a distinct, still-open follow-up.
  Two deliberate scope trims, both logged in DEVLOG: GSM-modem OUTBOUND
  sending, and on-device SMS sending (Android SmsManager) — neither has
  hardware/credentials to build against here.
- **Sprint 5 (AI pipeline): all four boxes CODED, none verified** beyond
  `php -l`. The queue, the Ollama client, the worker, the real health
  probe, and the translation gate all exist. **The model has never
  actually been called.** See the Sprint 5 section below.
- **Sprint 6: 3 of 4 boxes done. CODE complete and verified (112/112
  backend checks + a real browser pass over W7/W8) — but the sprint is NOT
  finished.** The evaluation box needs a 200-record dataset that does not
  exist yet and a model run that has never happened, so the sprint's
  central claim (>=95% recall) is still unmeasured.
  `bash backend/scripts/verify-sprint6.sh` against real XAMPP. This is the
  first Sprint 3+ work with genuine verification evidence rather than a
  parse check. It covers the approval loop (`regenerate-summary` +
  `approve`), blotter finalize/amend/read, the Lupon packet, and
  `GET /incidents/:id`.
  - **That script never calls Ollama** — it seeds draft rows via SQL and
    points `OLLAMA_URL` at a dead port, which doubles as proof the API only
    ever enqueues (Rule 15). So it is runnable on any machine, any time.
  - Before `approve` existed the AI pipeline was a dead end:
    `incident.redacted_narrative` could never be written, so translation,
    blotter finalization and the Lupon packet were all unreachable by
    construction. That loop is now closed and tested.
  - **Needs migration 0004 applied** (`blotter_revision`) to the real
    `baranguard` database — it has only ever been applied to disposable
    ones.
  - **`lupon-packet` IS built**, using `services/pdf/SimplePdf.php`, a
    small dependency-free PDF writer (no Composer in this repo). Packets
    are written to `backend/storage/` — now gitignored, since they contain
    the full approved narrative.
  - **The UI layer is complete against §9**: W7 Electronic Blotter Detail
    (finalize/amend, evidence list, Admin resolve, and the full
    created_at/dispatched_at/arrived_at/approved_at/finalized_at timeline)
    and W8 AI Redaction Review (redact/regenerate/approve/translate/packet).
    Blotter rows open W7; W7 links to W8. Completing W7 required two
    endpoints §6 documents but nobody had built —
    `GET /incidents/:id/evidence` and `PATCH /incidents/:id/status` — plus
    an `incident_id` filter on `GET /dispatch`.
    **Both screens were driven in a real browser** (disposable rig, torn
    down after) and that pass found two bugs every static check had
    passed — most importantly a FABRICATED TIMELINE: a Secretary gets 403
    on `GET /dispatch`, the failure was swallowed, and W7 showed "Not yet"
    for stages that had happened. Fixed by carrying `dispatched_at` /
    `arrived_at` / `has_active_dispatch` on `GET /incidents/:id` instead.
    Only the Secretary role was exercised, against seeded data.
  - **The evaluation harness (box 3) is BUILT and verified** —
    `scripts/ai-evaluate.php`, proven against a 10-record smoke fixture
    including the `ai_evaluation_run` write and its upsert-on-rerun.
    The **baseline number already exists**: recall 39.13% / precision
    100.00%, with every miss a NAME or ADDRESS — the concrete evidence
    that regex cannot do this job.
    Outstanding: the real 200-record dataset (manual, 3 people, see
    `docs/AI_Evaluation_Dataset_Guide.md` — startable now, no model
    needed) and the `--engine=model` run on the faster laptop.

## Sprint 2 — exactly what's done vs. not

Done and committed/pushed (`b9f7c7c`):
- **`POST /duty-status`** — Tanod-only, idempotent via `client_event_id`,
  40/40 verified against real XAMPP.
- **`POST /map-packages`** — Admin multipart upload, two-tier MBTiles
  validation (SQLite header always; `tiles`/`metadata` table check when
  `pdo_sqlite` is available), atomic "exactly one published package per
  barangay" enforcement. Same 40/40 script.
- **M2 Home** — real duty toggle (browser-verified end to end: a live
  `POST /duty-status` round-trip, UI reflects the server's response, and
  the resulting row was confirmed directly in the database), SOS shown
  disabled with an explanation (Sprint-4-blocked).
- **Bottom-nav tabs** — Home / Assignments / Log Incident / Map / Profile,
  Log Incident in the persistent slot per the resolved decision.
  Assignments/Map/Profile are real, reachable tabs that route to an
  honest "not built yet" placeholder rather than being hidden or faked.
- **Photo/voice capture** — `evidence_attachment_local` (local schema
  migration 2, 65/65 verified including a v1→v2 upgrade-path test),
  `evidenceCapture.ts` (Camera/Filesystem/voice-recorder plugins),
  `evidenceRepository.ts`, wired into M3's form (Add Photo / Record Voice
  Note buttons, staged then persisted after the incident saves).
- **DB passphrase → Android Keystore.** Swapped from plain
  `@capacitor/preferences` to `@aparajita/capacitor-secure-storage`
  (Android-Keystore-backed AES-GCM, confirmed against the plugin's own
  README). Only `passphrase.ts` changed; includes a one-time migration for
  an install that predates this change.
- **Inter font vendored** into the app bundle (400/500/600/700 weights,
  ~100KB, pulled once from `@fontsource/inter`) — no more runtime fallback
  to the platform font.

Still done from the prior session (unchanged): Ionic React 9 scaffold,
local schema for `incident_local`/`mobile_device_local`/
`offline_map_package_local`, `POST /devices/register`,
`PATCH /devices/:id/deactivate`, `GET /map-packages/:barangay_id[/download]`,
`apiService.ts`, session storage, M1 Login (browser-verified), M3/M4
(built, browser-rendering verified this session too, but the actual local
SQLite write has never executed — see blockers).

Both of this section's former "not done" items are now resolved (in
`392a4b3`, coded but unverified):
- Mobile branch of `POST /incidents` — built, using a new `X-Device-Id`
  header for the device half of the `device_id + client_event_id`
  idempotency key.
- The `dispatch_local` cache-shape question — resolved as Sprint 3, and
  the table is created there (local schema migration 3). §5 had defined
  its columns all along; the only real ambiguity was which sprint owned
  it.

## Android native build environment — IN PROGRESS as of this entry

The Android SDK is installed and `npx cap add android && npx cap sync`
has been run — `mobile/android/` exists. Getting an actual build to
compile surfaced **four real, non-obvious environment bugs**, all found
and fixed via `--stacktrace`/direct source inspection (full detail,
exact fixes, and file-by-file changes in `backend/DEVLOG.md`'s "Android
SDK / native build environment setup" entry — read that before touching
any of this again):

1. Gradle daemon failed on every invocation with `Unable to establish
   loopback connection` — root cause was JDK 17's internal wakeup-pipe
   socket breaking under the space in `C:\Users\Jayson Buenosaires\...`.
   Fixed by redirecting `TMPDIR`/`TEMP`/`TMP`/`-Djava.io.tmpdir` to a
   short path (`C:\gtmp`) — **must be set via environment variables on
   every `gradlew` invocation**, it cannot live in `gradle.properties`
   (the crash happens before that file is even read).
2. `mobile/android/local.properties`'s `sdk.dir` was malformed by an
   earlier bad write — fixed using the Windows short-path form
   (`C:/Users/JAYSON~1/AppData/Local/Android/Sdk`).
3. `sdkmanager.bat`/`avdmanager.bat` also choke on the same
   space-in-username — always use the short-path form
   (`C:\Users\JAYSON~1\...`) for any SDK cmdline-tools invocation.
4. **All 6 Capacitor native plugins require an exact JDK 21 toolchain**
   (confirmed in each plugin's own `android/build.gradle` — not just
   Camera). A newer JDK does NOT satisfy this — tested directly:
   registering Android Studio's bundled JBR (JDK 25) produced the
   identical failure. **A real JDK 21 install is the only fix.**

**Current status**: user is installing Temurin 21 (`.msi`, from
adoptium.net) and creating an **API 36** (not 34 — see the resolved
decision in DEVLOG; `variables.gradle` sets `compileSdk=targetSdk=36`,
`minSdk=24` is a floor not a test target) emulator via Android Studio's
Device Manager, both directly on their own machine since this
sandbox's network sustained only ~105 KB/s on the JDK download.

**A real open question surfaced by this, not yet resolved**:
`mobile/android/` is `.gitignore`d (line 39), but now holds two real,
non-regeneratable-by-default fixes (`gradle.properties`,
`AndroidManifest.xml`'s CAMERA/RECORD_AUDIO permissions). `npx cap sync`
(routine) never touches either file, so day-to-day work is safe — but
`npx cap add android` (rare, one-time, already run once) fully
regenerates the folder and would silently lose both. Whether to commit
`mobile/android/` now that it holds real fixes, or keep it gitignored
and accept that risk, is a decision for the user — flagged, not decided.

**Once the JDK + emulator are ready, next steps in order**: confirm
Gradle picks up JDK 21 → confirm `adb devices` sees the running emulator
→ `gradlew assembleDebug` → install → walk through M1 (login) → M2 (duty
toggle) → M3 (incident capture + Add Photo/Record Voice Note) → M4
(confirmation) → pull the SQLite DB file off the device and confirm it
isn't plaintext → kill the app mid-capture and confirm the record
survives → `./gradlew lintDebug` (the `NewApi` check for the
`minSdk=24` floor — not yet run, needs the same JDK 21) → ideally also
a spot-check on a lower-API emulator eventually, for real minSdk=24
confidence rather than just "no plugin declares a higher floor," which
is the only check done so far (see DEVLOG).

None of the four items below (still the actual verification goal) can
be checked in a browser — M1 and M2 could be (and were). M3/M4/evidence
capture fundamentally can't: `localDatabase.ts` deliberately throws on
the web platform rather than silently opening an unencrypted store, and
Camera/VoiceRecorder need a real device.
1. SQLCipher encryption-at-rest — never verified.
2. Offline-capture-survives-app-kill — never verified.
3. Photo/voice capture — never executed (camera/mic permission flow, real
   file write, real sha256-of-a-real-file all unexercised).
4. The Keystore passphrase upgrade — never executed (Android Keystore
   round-trip, and the legacy-value migration path, both unexercised).

## Sprint 3 — coded this session, UNVERIFIED (read before touching any of it)

All five "Today's cut" boxes exist as code now — `POST /gps`,
`PATCH /dispatch/:id/status`, `POST /sync/batch`, M5 Assignments List, M6
Assignment Detail/Navigation, M7 Live Map (plus Sprint 2's own leftover
mobile `POST /incidents` branch) — written in one sitting at the user's
explicit request to defer all testing until after the whole sprint was
coded. **The only verification performed was `php -l` on every new/
modified PHP file (clean) and `tsc --noEmit` across the mobile project
(clean except the expected `@capacitor/geolocation` module-not-found,
since its `npm install` was never run).** Nothing has executed against a
real database, no local-schema migration-3 check has run, no browser
walkthrough happened, no device run happened. Full detail — every
resolved decision, every file touched, and the exact suggested
verification order — is in `backend/DEVLOG.md`'s newest entry ("Sprint
2's leftover mobile POST /incidents branch, then all of Sprint 3 in one
session"). Read that before extending or trusting any of this, per this
project's own standing rule about not building on a description alone.

Two things worth knowing before that verification session starts:

1. **A real, undocumented API gap was found and fixed**: `GET /dispatch`
   didn't carry `incident_type`/`latitude`/`longitude`, which M5/M6 need
   to show what/where a cached assignment is. Extended `DispatchController
   ::index()`'s query to join them in (redacted-safe fields only, same
   precedent as `GET /incidents`'s own `officer_name` addition).
2. **M7 Live Map ships with NO rendered basemap.** It's a real,
   fully-functional status view (GPS broadcast, freshness, nearby
   incidents) — the actual map-tile rendering surface needs a native
   offline-tile-capable renderer (MapLibre Native or similar) that wasn't
   in scope to add silently this cut. Flagged as explicit follow-up work,
   not a demo-tell gap.

**Immediate next step, in order** (also at the end of the DEVLOG entry):
`npm install` in `mobile/` → `npm run verify.schema` → a new
`backend/scripts/verify-sprint3.sh` against real XAMPP → a browser pass
for M5/M6's non-device-dependent parts → once the Android SDK/JDK 21
blocker below clears, a real device run through M5→M6→M7→offline status
change→reconnect, and wiring `syncService.ts`'s `runSyncPass()` to an
actual trigger (nothing calls it yet).

## Sprint 5 — the AI pipeline, CODED this session, UNVERIFIED

All four Sprint 5 boxes exist as code. Jumping here with Sprints 2–4
outstanding is sound and shouldn't be "fixed": the AI pipeline depends
only on Sprint 0's schema and Sprint 1's incidents — `raw_narrative` is
its entire input. It needs nothing from the mobile app, GPS/sync, or
notifications.

**What's there:**
- `services/ai/OllamaClient.php` — the only place this codebase talks to
  the model. No fallback branch to a hosted provider exists (Rule 1 made
  structural, not aspirational).
- `services/ai/AiJobQueue.php` — the queue, which IS `ai_processing_log`
  (already migrated back in Sprint 0; **no new migration was needed**).
- `services/ai/AiPrompts.php` — the three prompts, versioned, plus
  `stripReasoning()`.
- `scripts/ai-worker.php` — the CLI worker; the only process that calls
  the model.
- `controllers/AiDraftController.php` + `routes/ai.php` — `POST
  /incidents/:id/redact`, `GET /incidents/:id/ai-draft`, `POST
  /incidents/:id/ai-draft/translate`.
- `GET /system/health`'s `ollama` field upgraded from an env-var-presence
  check to a real probe.
- Voice-to-text **resolved as out of scope** (§10 of the reference has the
  full reasoning) — the one item here that's genuinely *done*, since a
  decision is the whole deliverable.

**Three things to know before touching it:**

1. **The API never calls Ollama — only the worker does.** That's what
   makes `POST /incidents/:id/redact` behave identically whether Ollama is
   running, stopped, or still downloading (§2 Rule 15). Don't "optimise"
   by making the endpoint run inference inline.
2. **The model is a reasoning variant** (`-R`), so it emits
   `<think>…</think>`. `AiPrompts::stripReasoning()` removes that before
   anything is persisted — a security control, not formatting: a reasoning
   trace restates the original narrative, so keeping it would put the
   names redaction just removed back into the draft.
3. **Nothing has run.** `php -l` is clean; the worker has never executed,
   and no redaction, summary, or translation has ever been generated.
   Prompt quality is entirely unmeasured.

**To try it (once the SEA-LION pull finishes):**
```
ollama serve
cd backend && php scripts/ai-worker.php --status
```
Then set `OLLAMA_URL`/`OLLAMA_MODEL` in `backend/.env` (see
`.env.example`), queue a redaction, and run `php scripts/ai-worker.php`.
Full instructions in `backend/scripts/README-ai.md`; the suggested
verification order is at the end of DEVLOG's Sprint 5 entry. The single
most important behaviour to confirm: **kill Ollama mid-job and check the
row returns to `queued`, not `failed`.**

**Still Sprint 6, deliberately not built:**
`POST /incidents/:id/ai-draft/regenerate-summary` and
`POST /incidents/:id/ai-draft/approve` — the latter being the only
endpoint allowed to commit `incident.redacted_narrative` (§2 Rule 3).
Until it exists, nothing can set `redaction_approved_at`, so the
translation endpoint's prerequisite check is real but unsatisfiable by
design. Also unbuilt: the evaluation harness and
finalize/amend/lupon-packet.

## Standing gotchas worth remembering (don't rediscover these)

- **`backend/.env` needs the `OLLAMA_*` keys added by hand on every
  machine.** Sprint 5 only added them to `.env.example`, which is the
  committed template — the real `.env` is gitignored and per-machine. On
  THIS workstation they were appended on 2026-09-03 (`OLLAMA_URL`,
  `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_SECONDS`; a `.env.bak-preollama` backup
  was left behind, covered by `.gitignore`'s `.env.*`). **On the laptop
  you move the model work to, copy that block from `.env.example` or
  `POST /incidents/:id/redact` will return 503 and
  `GET /system/health` will report `ollama: not_configured`** — both of
  which are correct, honest behaviour, not bugs.
- **An empty `DB_PASSWORD` is rejected by design** (`config/db.php`), so a
  disposable-database test cannot just use XAMPP's passwordless `root`.
  Every `verify-*.sh` script creates a throwaway MySQL user with a real
  password for exactly this reason; do the same in any new one.

- **The user's real working directory is `C:\xampp\htdocs\baranguard`**,
  not `Videos\Baranguard` — see `CLAUDE.md`'s "Working directory" section
  for the full detail. Since 2026-09-03 it's a genuine NTFS junction onto
  this repo (verified via `fsutil`, and a full recursive diff — 299 files,
  zero differences), not a copy, so nothing about editing files changes;
  just prefer that path in anything shown to the user. First attempt at
  this used Git-Bash `ln -s`, which silently created a disconnected STATIC
  COPY of the whole repo (including `.git` and `backend/.env`) instead of
  a link — caught and fixed before it went stale, but worth remembering as
  a category: **on this machine, verify a newly created symlink with
  `fsutil reparsepoint query` (or PowerShell `Get-Item | select LinkType`)
  before trusting it** — `ln -s`'s silent fallback makes an `ls -la`-only
  check unreliable. `mklink /J` (junction, no admin/Developer-Mode needed)
  is what actually worked.
- **`backend/config/env.php` regression, already fixed**: under PHP's
  built-in server (`php -S`), a shell-exported env var reaches `getenv()`
  but not always `$_ENV`/`$_SERVER` — `baranguard_load_env()`'s
  skip-condition checks all three. If this regresses, every disposable-DB
  test script will silently point at the REAL `baranguard` database.
- **Apache doesn't forward the `Authorization` header by default** — fixed
  via a rewrite rule in `backend/public/.htaccess`. Only surfaces under
  real Apache/XAMPP, never under `php -S`.
- **Git-Bash paths (`/c/...`) don't work with native `php.exe`** — always
  `cygpath -m` first when a shell script hands a path to PHP.
- **`npm`/`npx` now work directly under this machine's Git Bash** (as of
  this session — contradicts an older note in this same file history
  about needing to invoke `npm-cli.js` directly. Re-check if a future
  session hits the old symptom again; environments can regress.)
- **XAMPP's MySQL service is not always running when a session starts** —
  check with `tasklist //FI "IMAGENAME eq mysqld.exe"` and start it with
  `cmd //c "C:\xampp\mysql_start.bat"` (backgrounded) if needed, before
  any verify script or manual DB work.
- **The Claude Browser tool's `computer` click/screenshot actions were
  unreliable against the mobile Vite dev server this session** — clicks
  timed out with "pane is hidden" even after `tabs_select`, and
  screenshots sometimes showed a stale page mid-route-transition even
  though the DOM/URL had already updated correctly (Chrome throttles
  `requestAnimationFrame` for a backgrounded tab, which stalls Ionic's
  page-transition completion). Workaround: use `javascript_tool` to
  dispatch real DOM events directly (set `.value` + dispatch `ionInput`/
  `ionChange` for Ionic form fields, `form.requestSubmit()` for
  submit-type buttons, `.click()` for plain buttons), and prefer
  `get_page_text/read_console_messages/read_network_requests` over
  screenshots for verifying real state. A full `navigate()` to the target
  URL sidesteps a stuck client-side transition entirely.
- **`.claude/launch.json` now exists** (created this session) — runs the
  mobile Vite dev server via `npm run dev --prefix mobile` on port 5173,
  for previewing the mobile app through the Browser tool. Point
  `mobile/.env.local`'s `VITE_API_BASE_URL` at whatever PHP server you're
  testing against (gitignored — never commit a real value there).
- **Three stray empty untracked files in the repo root** (`cls`, `git`,
  `main)`) — leftovers from an old mis-pasted command, not part of any
  build. Harmless; just don't `git add -A`/`git add .` and sweep them in.
- **RESOLVED this session**: `@capacitor/geolocation` and `@capacitor/
  push-notifications` were declared in `mobile/package.json` but never
  actually installed — that was the entire "Sprint 3 doesn't compile"
  root cause. `npm install` has now been run in `mobile/`
  (778 packages audited; 13 pre-existing moderate/high advisories, NOT
  addressed — that's its own scoped `npm audit` decision). One real type
  error surfaced once the real types existed
  (`PushNotifications.addListener()` returns a `Promise<PluginListenerHandle>`
  in v8, not a handle directly) and was fixed in `deviceIdentity.ts`.
  `tsc --noEmit`, `eslint`, and `npm run build` are all clean as of this
  commit — see backend/DEVLOG.md's "Mobile build fix" entry for the full
  diagnosis and a real browser walkthrough (login, M5 Assignments, M7
  Map, Profile, M3 Log Incident all confirmed rendering with zero
  unexpected errors). `npx cap sync android` and the `POST_NOTIFICATIONS`
  manifest permission (Android 13+) are STILL outstanding — this fix gets
  the web-preview/TypeScript layer working, not a native Android build.

## Git / attribution convention

Commit messages: `[SprintN] Short description`, ending with
`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (current
convention — follow whatever the live CLAUDE.md session instructions say
if this ever changes again, not what old commits show).
