# Baranguard — Session Handoff

**Last updated: 2026-09-03, end of the Sprint 2 "remaining items" session.**

This file is the one thing to read to pick this project back up cold. It's
a snapshot, not a substitute for `backend/DEVLOG.md` (the full narrative
history) or `docs/Baranguard_Sprint_Prompts.md` (the per-sprint menus) —
update this file at the end of a session, don't let it go stale for long.

## Where things stand right now

- **Working tree: NOT clean.** Everything from this session (backend
  `POST /duty-status` + `POST /map-packages`, M2 Home, bottom-nav tabs,
  photo/voice capture, Keystore passphrase, Inter font vendoring, doc
  updates) is written and tested but **not yet committed** — pending the
  user's go-ahead, same convention as every prior session's uncommitted
  work.
- **Sprint 0 + Sprint 1: fully complete**, real-XAMPP verified, committed
  and pushed. Unchanged since the last handoff.
- **Sprint 2 (mobile): every box on the working checklist is now done
  except what genuinely requires the Android SDK.** Both blocking
  decisions (bottom-nav slot, photo/voice scope) are resolved. The only
  remaining Sprint 2 items are device-only verification and one backend
  box (mobile's `POST /incidents` branch) — see below.

## Sprint 2 — exactly what's done vs. not

Done this session (2026-09-03, uncommitted):
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

## Hard blockers — still the same one root cause (need the user's machine, not code)

**No Android SDK / Android Studio installed.** `mobile/android/` was never
added (`npx cap add android && npx cap sync` still to run). Everything
below is blocked on this one thing:
1. SQLCipher encryption-at-rest — never verified.
2. Offline-capture-survives-app-kill — never verified.
3. Photo/voice capture — never executed (camera/mic permission flow, real
   file write, real sha256-of-a-real-file all unexercised).
4. The Keystore passphrase upgrade — never executed (Android Keystore
   round-trip, and the legacy-value migration path, both unexercised).

None of these can be verified in a browser — M1 and M2 could be (and were,
this session and the last), because neither touches SQLite or a native
plugin. M3/M4/evidence capture fundamentally can't: `localDatabase.ts`
deliberately throws on the web platform rather than silently opening an
unencrypted store, and Camera/VoiceRecorder need a real device.

**Recommended next physical step, regardless of which Sprint-scoped box
gets picked next: install the Android SDK, then
`npx cap add android && npx cap sync`, then actually run M1/M2/M3/M4 and
the new evidence-capture flow on a device/emulator** — pull the DB file to
confirm it isn't plaintext SQLite, and confirm the Keystore-backed
passphrase actually round-trips.

## Sprint 3 — what's next once you're ready to move on from Sprint 2

**Two boxes are fully unblocked today, no device needed** (unchanged from
the last handoff):
- `POST /gps` — `GET /gps/live` and `GET /gps/history` already exist
  (Sprint 1, 37/37 verified), so this is genuinely just the missing write
  side.
- `POST /sync/batch` — the natural next step after M3: incidents already
  get a stable `client_event_id` at first save specifically so this
  endpoint can dedupe on it.

**The mobile boxes (M5 Assignments List, M6 Assignment Detail/Nav, M7
Live Map) are still NOT good picks** — same Android-SDK wall, AND they
need local tables that still don't exist: `dispatch_local`,
`gps_track_local`, `offline_queue_local` (confirmed absent from
`mobile/src/services/db/localSchema.ts` as of this session).

**Recommendation, unchanged: `POST /sync/batch`** is the highest-value
unblocked pick whenever the user wants to step outside Sprint 2's device
wall again. Per this project's own "pick exactly ONE" rule, confirm with
the user before writing code.

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

## Git / attribution convention

Commit messages: `[SprintN] Short description`, ending with
`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (current
convention — follow whatever the live CLAUDE.md session instructions say
if this ever changes again, not what old commits show).
