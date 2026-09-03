# Baranguard — Session Handoff

**Last updated: 2026-09-03. Sprint 2's leftover mobile `POST /incidents`
branch plus ALL of Sprint 3 (M5, M6, M7, `POST /gps`, `POST /sync/batch`)
were CODED this session at explicit user direction — "code first, test
after". NONE of it has been verified beyond a bare `php -l`/`tsc --noEmit`
parse/type check (see `backend/DEVLOG.md`'s latest entry for exactly what
that means and doesn't mean). Treat everything in this section under
"Sprint 3" as unverified until a follow-up session runs the suggested
verification order at the bottom of that DEVLOG entry. The Android native
build environment work described further down is UNCHANGED by this
session — still blocked on the same JDK 21 install.**

This file is the one thing to read to pick this project back up cold. It's
a snapshot, not a substitute for `backend/DEVLOG.md` (the full narrative
history) or `docs/Baranguard_Sprint_Prompts.md` (the per-sprint menus) —
update this file at the end of a session, don't let it go stale for long.

## Where things stand right now

- **Working tree: uncommitted changes from THIS session on top of the
  clean `b9f7c7c` base** — everything described under "Sprint 3 — coded
  this session, UNVERIFIED" below. Nothing in it has been committed yet;
  it's pending the user's review.
- Everything from the earlier "Sprint 2 remaining items" session (backend
  `POST /duty-status` + `POST /map-packages`, M2 Home, bottom-nav tabs,
  photo/voice capture, Keystore passphrase, Inter font vendoring, the
  htdocs-junction work) is **committed and pushed** to `origin/main`
  (`b9f7c7c`), unchanged by this session.
- **Sprint 0 + Sprint 1: fully complete**, real-XAMPP verified, committed
  and pushed. Unchanged since the last handoff.
- **Sprint 2 (mobile): every code box is done, including the leftover
  mobile `POST /incidents` branch (coded this session — see below).** What
  remains is entirely device verification — see "Android native build
  environment" below, unchanged this session.
- **Sprint 3: all five "Today's cut" boxes were CODED this session, none
  verified.** See the dedicated section below before treating any of it
  as done.

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

Not done / explicitly deferred:
- Mobile branch of `POST /incidents` (device_id + client_event_id
  idempotency — a different code path from the Sprint 1 web path, never
  exercised).
- The `dispatch_local` cache-shape ambiguity (Sprint 2 vs Sprint 3) is
  still unresolved.

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

## Standing gotchas worth remembering (don't rediscover these)

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
- **`mobile/package.json` now lists `@capacitor/geolocation` but `npm
  install` was never run for it this session** — `tsc` will fail on
  `src/services/geolocation.ts`'s import until that runs. Run
  `npm install` before doing anything else in `mobile/`.

## Git / attribution convention

Commit messages: `[SprintN] Short description`, ending with
`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (current
convention — follow whatever the live CLAUDE.md session instructions say
if this ever changes again, not what old commits show).
