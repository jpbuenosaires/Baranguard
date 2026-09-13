# Baranguard — Session Handoff

**This file is a replaced-in-place snapshot, not a log.** Rewrite the
sections below fresh each time something changes the picture — never
stack a new dated banner on an old one. Full session-by-session history
lives in `backend/DEVLOG.md` (grep it; don't read it front to back).

**Last updated: 2026-09-13.**

## Where things stand

**Sprints 0–7 are complete.** Sprint 8 (UAT/evaluation) is open. Its old
gate (`docs/REMAINING.md` §F) has moved: **F4 is now closed**, **F1 is
half-decided** (mobile side resolved, web dashboard side still open —
see below), and Sprint 8 also now has two NEW, real-device-confirmed
blockers (C6, C7) that aren't part of §F but should be fixed before any
UAT scenario touches login or an on-duty shift. See `SPRINTS.md`'s own
gate note for the exact current wording.

**2026-09-13 (this session): continued real-device testing on the same
Infinix X6840, found and fixed three real bugs, made and implemented one
real architecture decision, closed out the last two open items from the
Sept-7 audit and the G1-G4 backlog, and found two new bugs that are
still open.**

### Fixed and device-verified this session

- **Login crashed the whole app** — `PushNotifications.register()`
  throws a native `IllegalStateException` ("Default FirebaseApp is not
  initialized") when no `google-services.json` exists (this deployment
  has never had a real Firebase project — `REMAINING.md` A4). The
  exception fires on Capacitor's own native plugin-invocation thread,
  before the call can ever settle a JS promise, so `deviceIdentity.ts`'s
  existing try/catch around it could not intercept it — it just killed
  the process. **Fixed** with a native check
  (`FullScreenAlertPlugin.isFirebaseAvailable()`) called BEFORE
  `register()`, so the app now skips the crash-prone call instead of
  reacting to a failure it structurally cannot observe. Confirmed
  crash-free across multiple real relaunch cycles.
- **The full-screen critical alert (M12/Phase 4.2) crashed every time it
  opened** — `CriticalAlertActivity` was declared in the manifest with
  `android:theme="@style/AppTheme.NoActionBarLaunch"` (parent
  `Theme.SplashScreen`), but the Activity extends `AppCompatActivity`,
  which requires a `Theme.AppCompat` descendant — `IllegalStateException`
  at `setContentView()`, 100% reproducible, both from the Profile test
  button and a real notification tap. **Fixed**: theme changed to
  `@style/AppTheme.NoActionBar` (a real `Theme.AppCompat.DayNight.
  NoActionBar` descendant already defined in `styles.xml`). Not
  re-confirmed on-device after this specific fix in this session — the
  root cause is a deterministic Android platform requirement, not a
  timing-dependent bug, so confidence is high, but this is disclosed
  rather than claimed proven.
- **Every device on this no-Firebase deployment could never actually
  register** (`REMAINING.md` C5, closed) — `POST /devices/register`
  required `fcm_token`, and the mobile side never called it without a
  real one, so this device had never once completed real registration.
  Invisible until `POST /sync/batch` — which this session's own sync
  scheduler is the first thing to ever call automatically — rejected it
  with 422. **Fixed**: `fcm_token` is now optional
  (`DevicesController.php`), stored as `''` when absent (the same
  convention `RetentionService` already used for "no token," which
  `NotificationDispatcher` already reads as "fall through to SMS").
  Proven both ways: `verify-devices-map-packages.sh` (57/57, disposable
  DB) and a direct `curl` registration + `/sync/batch` call against the
  real `baranguard_uiseed` deployment for this device's actual
  `device_id`.

### Architecture decision made and implemented: mobile connectivity via Tailscale

User-requested discussion, explicit decision, 2026-09-13: the mobile app
must reach the workstation whether a Tanod is on barangay WiFi or out on
patrol on mobile data, and the barangay's residential internet can't
reliably be port-forwarded to (CGNAT). Chosen: **Tailscale**, a private
WireGuard mesh — the workstation and each Tanod's phone join one tailnet,
so the phone reaches the workstation at a stable address
(`laptop-b2rp6jkk.tail631c69.ts.net`) over any transport, without ever
exposing the API on the open internet. Implemented:
`mobile/src/services/apiService.ts`'s `DEFAULT_API_BASE_URL` now points
there. Confirmed on the workstation: port 8081 listens on `0.0.0.0`, the
existing `Baranguard Backend 8081` firewall rule covers `Any` profile,
Windows classifies the Tailscale adapter as Private, and a direct `curl`
to the workstation's own Tailscale address round-tripped a real
authenticated request. **Not yet device-verified end-to-end** — the test
phone still has a manual LAN-IP override saved in Profile from earlier
testing, so the new Tailscale default has never actually been the
address a real login exercised on-device. **The web dashboard's own API
base URL and `backend/.env`'s `CORS_ALLOWED_ORIGIN=*` were explicitly
NOT part of this decision and remain open** — see `REMAINING.md` F1.

### G1 (SOS third fallback tier) — last item of the G1-G4 backlog, now built

Both blockers the 2026-09-12 pass left open are resolved: a real device
(this session), and the backup-contact-number decision (lives in
`system_settings.sos_fallback.backup_contact_number`, the same narrow
W21-style override the SMS gateway keys got, explicit user sign-off).
`SosSmsPlugin.java` + `sosSms.ts` send a compact envelope directly from
the Tanod's own SIM when both the app POST and the workstation are
confirmed unreachable; `sosFallbackContact.ts` caches the number
on-device ahead of time. Code-complete and wired; **a real SMS actually
arriving has not been confirmed in this session** — that one leg of the
fallback ladder still needs a live test with a backup contact configured
and connectivity off.

### Two new bugs found, both still OPEN

- **C6 — login can leave the OLD screen visually stuck over Home.** Not
  a navigation or session bug: confirmed via remote Chrome DevTools that
  `location.pathname` is genuinely `/home` and Home's own mount effects
  run (patrol tracking starts, dispatches cache) — but
  `document.querySelectorAll('.ion-page').length` returns 3, and two of
  those three share the exact same `z-index: 101` with neither hidden.
  This is an Ionic `IonRouterOutlet` page-stacking bug: `/login` and the
  tab shell's `/*` route are sibling top-level routes in the same outer
  outlet, and `login.tsx`'s imperative `navigate('/home', {replace:
  true})` crosses directly into a route nested inside `TabbedShell`'s
  OWN inner outlet — a known-fragile transition shape for Ionic React.
  Likely masked until now by the crashes above making login never
  survive long enough to expose it. **Investigation was paused, not
  resolved** — see `REMAINING.md` C6 for the exact next diagnostic step.
- **C7 — the whole app process died twice, ~50 seconds after patrol GPS
  started.** Found in passing while chasing C6. `adb logcat` shows
  `Process ph.baranguard.tanod has died: fg +50 FGS` with no Java
  exception either time — rules out an ordinary uncaught-exception crash.
  More serious than C6 (kills the process outright, not just a visual
  glitch) and completely uninvestigated — needs its own session. See
  `REMAINING.md` C7.

### B1, B2, B4 all done this session — and a real, previously-invisible bug found and fixed

Continuing the same session after the mobile debugging above:

- **B1 (browser-verify)** — every flagged screen (Dispatch Center, GIS
  Live Tracking, Incident Management, all three Analytics tabs, both SMS
  Monitor tabs, Audit Log, Service Health, Citizen Reports' convert
  panel, all four Personnel tabs, Settings incl. SOS Fallback, Map
  Packages) walked as Admin against the real `baranguard_uiseed` demo
  data. Zero real defects — the one logged network "error" was the
  correct, designed 404 for a not-yet-published map package, already
  proven server-side by `verify-devices-map-packages.sh`.
- **B2 (pen-test the rest)** — new `backend/scripts/
  verify-b2-pentest-remaining-resources.sh`, 59/59: Dispatch, Shifts,
  Shift-Swap-Requests, Citizen Reports, SMS all now have the same
  four-dimension pass Incidents already had. Map Packages deliberately
  left to its existing suite rather than duplicated.
- **B4 (Sprint 3 backend)** — new `backend/scripts/verify-sprint3.sh`,
  38/38, and it earned its keep immediately: **`GET /incidents/nearby`
  has 500'd on every real call since the day it was built.** The
  haversine SQL reuses the named parameter `:lat` across two placeholder
  positions, which only works under PDO's EMULATED prepares —
  `config/db.php` runs native prepares (`ATTR_EMULATE_PREPARES => false`),
  so MySQL's binary protocol threw `SQLSTATE[HY093]: Invalid parameter
  number` on every single call, silently swallowed into a generic
  `SERVER_ERROR`. Nothing static could see this (it's valid SQL and valid
  PHP); nothing dynamic ever exercised it until this suite was the first
  thing to call this endpoint over real HTTP. **Fixed** — a second
  distinct placeholder (`:lat2`) for the repeated occurrence, bound to
  the same value. Also confirmed for real: duplicate-GPS handling and
  interrupted-sync resume both behave exactly as `/sync/batch`'s
  idempotency design intends.

### Previously-flagged uncommitted mobile UI work — now resolved

Earlier snapshots of this file flagged a separate body of uncommitted
mobile UI work (`MobileHeader.tsx`, `SyncQueueModal.tsx`,
`pages/profile.tsx`, `utils/`, and four files carrying mixed hunks from
two different sessions layered together) as a standing risk needing a
file-by-file/hunk-by-hunk review before committing. **That review
happened and everything was committed** across five phase commits this
session (`a72dbde` Phase 1, `f3d550b` Phase 2, `64c1319` Phase 3,
`b1951b1` Phase 4, plus `b570d25` for the backend/web half) — see those
commits' own messages for what landed in each. Nothing from that body of
work remains uncommitted.

### Unchanged from prior sessions (condensed — see `backend/DEVLOG.md` for full detail)

- F2/F3 (XSS sweep), F5 (PATCH idempotency), F6 (`is_suspended`), F7
  (walk-in blotter, closed by removal), F8 (response-time double-count)
  — all closed 2026-09-10/12, unchanged.
- G2 (`sms_log.legal_hold`) and G3 (`mobile_device` scrub-not-delete) —
  closed 2026-09-12, unchanged. G4 closed as obsolete.
- The §G feature-candidate backlog (14 items, 2026-09-07 brainstorm) is
  fully resolved — unchanged.
- Nine verify suites were dead (not green) from 2026-09-05 until
  2026-09-12 due to a missing migration in each suite's own setup — all
  fixed, all now apply the full 0001-0018 chain, unchanged.
- Migrations 0001-0018 are applied to both the real `baranguard` DB and
  the demo `baranguard_uiseed` DB — unchanged.
- M7 Live Map's rendered basemap (MapLibre + sql.js/MBTiles, online OSM
  fallback) is built and real-device-confirmed on the online-fallback
  path only — no offline `.mbtiles` package has ever been published for
  barangay 1, so the sql.js/MBTiles-protocol path itself remains
  device-unverified. Unchanged.
- Assignment Detail's "Navigate" now embeds `LiveMapCanvas` instead of
  handing off to Google Maps (the external link survives as an explicit
  opt-in) — fixed and real-device-confirmed 2026-09-13, unchanged this
  session.
- `eval-kit/` still needs capable hardware — no `generate()` has ever
  completed on this workstation. Unchanged.

## Things most likely to bite you

1. **A native exception on Capacitor's own plugin-invocation thread
   cannot be caught by JS try/catch, no matter how defensively the JS
   side is written.** The FCM crash above looked "safe" at the JS layer
   (try/catch wrapped, a timeout, a `.catch()` on the register call) and
   still crashed the whole process, because the exception never reached
   the JS promise machinery at all. The only real fix is a native check
   BEFORE the crash-prone call, not a JS-side reaction to it — remember
   this pattern before trusting any "it's wrapped in try/catch" claim
   about a native plugin call on this stack.
2. **Ionic's `IonRouterOutlet` treats sibling top-level routes as
   separate page-stack entries, and an imperative `navigate()` crossing
   from one into a route nested inside another outlet (like `/login` →
   `/home` here) can leave the old page visually on top even though
   React Router's own state is completely correct.** `location.pathname`
   being right is not proof the screen is right — check
   `document.querySelectorAll('.ion-page')` and each one's z-index/
   display when a screen "looks stuck" (see C6).
3. **Every static check in this project can be green on code with a P0
   defect.** `node --input-type=module --check`, `verify-web-wiring.mjs`,
   `php -l`, and a clean `tsc` all parse-and-resolve; none of them would
   have caught the FCM crash, the CriticalAlertActivity theme mismatch,
   or the device-registration 422 — all three needed a real device or a
   real HTTP call against a real database to prove.
4. **A verify script proves nothing about an endpoint it never calls.**
   `/sync/batch`'s device-registration check was silently broken for as
   long as nothing called it automatically — `grep` for the route across
   every `*.sh` before trusting a suite's green result to mean "this
   endpoint works," not just "the suites that happen to touch it pass."
5. **`backend/.env` may still be pointed at `baranguard_uiseed`, not
   `baranguard`**, and it is NOT tracked by git so nothing will remind
   you. `DB_NAME=baranguard php backend/scripts/...` overrides it for one
   command; check the file itself before trusting any CLI run against
   "the real database."
6. **Gradle's daemon JVM is decided by `JAVA_HOME`, not by whatever
   `java` resolves to on PATH.** Always `export JAVA_HOME=".../
   jdk-21.0.12.101-hotspot"` (and `./gradlew --stop` first) before
   building the Android app from a shell.
7. **A named PDO parameter can only be bound to ONE placeholder occurrence
   under native prepares** (`config/db.php`'s `ATTR_EMULATE_PREPARES =>
   false`) — reusing `:name` twice in one query string (e.g. a haversine
   formula needing the same latitude twice) silently compiles and lints
   clean, then throws `SQLSTATE[HY093]` on every real call. This bit
   `GET /incidents/nearby` for this endpoint's entire lifetime. **Checked,
   not just fixed**: a PHP-tokenizer scan of every `->prepare()` call
   across all of `backend/controllers/` and `backend/services/` (33
   files) confirms this was the ONLY occurrence — not a systemic pattern,
   but worth re-running that same scan after adding any new query that
   might reuse a coordinate/value across a formula.

## Recommended next step

**C6 and C7 first — they make the mobile app this session just finished
building genuinely unusable for a real shift**, ahead of anything in
`REMAINING.md`'s own numbered order (which is still valid for everything
below Sprint 8's gate).

1. **C6** — resume the paused investigation: confirm which physical
   `.ion-page` is the stale login screen and whether it's missing
   Ionic's usual hidden class, then either fix the cross-outlet
   transition or route the post-login redirect through Home's own inner
   outlet instead.
2. **C7** — give this its own session. Reproduce deliberately (toggle
   on-duty, wait ~50s, watch `adb logcat -b crash` and `dumpsys activity`
   rather than noticing it as a side effect of testing something else).
3. **Confirm G1's real-SMS leg** — configure a backup contact, kill
   connectivity, and verify the on-device SMS actually arrives.
4. **Settle F1's web-dashboard half** — the real production API base URL
   for Admin/Secretary/PB, and revisit `CORS_ALLOWED_ORIGIN` once that's
   decided.
5. ~~B1, B2, B4~~ **Done 2026-09-13** — see their own `REMAINING.md`
   entries (B4 in particular found and fixed a real `nearby()` bug).
6. **Hand `eval-kit/` to a friend with capable hardware** for A2.
7. Then **Sprint 8** proper — pick exactly one box from `SPRINTS.md`.

Full ordered list with reasoning, including the hardware/account-blocked
items: **`docs/REMAINING.md`**.

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

# Device registration + map-packages (this session's new assertions)
bash backend/scripts/verify-devices-map-packages.sh

# Evidence upload (F4)
bash backend/scripts/verify-evidence-upload.sh

# B2: pen-test dispatch/shifts/swap-requests/citizen-reports/sms
bash backend/scripts/verify-b2-pentest-remaining-resources.sh

# B4: Sprint 3 backend (gps, dispatch status, sync/batch, nearby, mobile incidents)
bash backend/scripts/verify-sprint3.sh

# Build + install the mobile app onto a connected Android device
cd mobile && npx vite build && npx cap sync android
cd android
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
export TMPDIR=C:/gtmp TEMP=C:/gtmp TMP=C:/gtmp
export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=C:/gtmp"
./gradlew --stop && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p ph.baranguard.tanod -c android.intent.category.LAUNCHER 1

# Tailscale status (mobile connectivity, F1's mobile half)
tailscale status
```

Neither the retention job nor the restore drill is **scheduled** — both
are CLI-only by design; wiring them to Task Scheduler is an outstanding
runbook step.

## Conventions

Commits: `[Tag] Short description`, ending with the `Co-Authored-By:`
line the current session instructions specify. Repo has a real remote
(`origin` → `github.com/jpbuenosaires/Baranguard`) — push before ending
a session that adds real work, not just when asked.

Rewrite this file — don't append to it — at the end of any session that
changes the picture it describes. A stale `HANDOFF.md` is treated like a
stale DEVLOG claim: verify against the repo before trusting it.
