# Baranguard — Session Handoff

**Replaced-in-place snapshot, not a log** — rewrite fresh each session,
never stack banners. Full history: `backend/DEVLOG.md` (grep by
date/keyword, don't read front to back).

**Last updated: 2026-09-17.**

## Where things stand

Sprints 0–7 complete. Sprint 8 (UAT/evaluation) open; `REMAINING.md` §F
had been fully closed but F1 (API base URL) reopened 2026-09-15 — the
private mesh VPN that closed it was decommissioned the same day (see
`REFERENCE.md` §1); no persistent remote-access mechanism replaces it,
base architecture is LAN-only again, with a Cloudflare Quick Tunnel
available for temporary remote testing only (started this session,
ephemeral hostname, no Cloudflare-side auth). Turn-by-turn routing, C6
(login stuck over Home), and C4's M12 native-alert handoff are all closed
2026-09-15 or earlier. **One open blocker: C7** (app process dies ~50s
into patrol GPS) — first investigated 2026-09-15, does not reproduce on a
Galaxy A21s (negative result favoring an OEM-specific cause over a
generic one), still needs the Infinix X6840 to reproduce for real.
Doesn't block UAT scenarios that skip an on-duty patrol shift.

**2026-09-17 — Mobile tactical-theme WIP audited, 5 real bugs found and
fixed, plus a lint cleanup pass.** The in-progress rework (`App.tsx`,
`ActiveStepCard.tsx`, `LiveMapCanvas.tsx`, `assignment-detail.tsx`,
`assignments.tsx`, `live-map.tsx`, `app.css`, `variables.css`,
`tacticalFeedback.ts`) had 5 real defects: 2 compile errors (missing
`formatRemainingTime`/`formatNavDistance` import; a nonexistent
`tacticalFeedback.onWarning()` called by 3 emergency speed-dial buttons)
and 3 wired-but-dead gaps (turn-by-turn navigation had no Stop button;
the tab bar didn't hide on the New Incident screen; a fetched
`activeDispatchCount` was never rendered). All 5 fixed, plus 9 dead
imports/vars removed and both `exhaustive-deps` warnings resolved.
Verified: `tsc --noEmit` clean, `eslint` zero errors in source, `npx vite
build` succeeds. **Not device-verified** — full detail (including which
`react-hooks/exhaustive-deps` warning got a real dependency vs. a
documented disable) in `backend/DEVLOG.md` 2026-09-17.

**Still open, not resolved this session**: a live turn-by-turn nav
screenshot (Dispatch #18, real device data) showed no blue route line
overlaid on the road — `LiveMapCanvas.tsx`'s route-drawing code looks
correct on read-through (real royal-blue + white-casing layers, correct
z-order above the raster basemap), and a diagnostic `console.log` added
to `applyRoute()` never fired even once despite GPS position updating
continuously in `adb logcat` — meaning the effect never executed, most
likely a stale/cached WebView bundle rather than a logic bug (the
diagnostic log was removed again before this commit; nothing points to a
real code defect yet). Session's adb connection to the device then became
intermittent (`no devices/emulators found` after being visible earlier),
so a `pm clear` to force a truly fresh WebView load was proposed but never
run. **Next session: reconnect the device, clear app data, retest with a
fresh diagnostic log before assuming this is a real rendering bug.**

**A5 (GSM modem) was scoped but not built.** User has a tethered Android
phone available now (adb-readable inbox, not a dedicated AT-command
modem). Confirmed via code read: **no wire format exists yet** for
encoding the envelope as SMS text, because on-device SMS *sending* was
never built either (`smsFallbackState.ts`'s own header comment says so —
`smsAttempted` is never set anywhere). Planned approach, not started:
a PHP CLI daemon (`gsm-ingest-daemon.php`, mirroring `ai-worker.php`'s
`--once`/`--daemon`/`--status` shape) polling
`adb shell content query --uri content://sms/inbox` every ~10s, parsing
each new message body as the same flat JSON envelope
`sms-envelope-build.php` already produces (reusing the proven contract
rather than inventing a new encoding), POSTing to the matching
`/internal/sms/*` handler. Testable without the mobile-SmsManager work
existing: generate an envelope with `sms-envelope-build.php`, send *that*
JSON as a real SMS from a second phone to the tethered number. Cancelled
mid-session before implementation — user redirected to other work.
**Next session, if resumed**: confirm adb sees the tethered phone
separately from any emulator, then decide daemon scheduling (manual
testing first vs. wiring into Task Scheduler immediately).

**2026-09-16 — FCM wired to a real Firebase project (project id
`baranguard-acb27`), rebuild+device test still pending.**
`google-services.json` is in `mobile/android/app/` (gitignored) and
`backend/.env`'s `FCM_SERVICE_ACCOUNT_PATH` points at the service-account
key in `C:\Users\Jayson Buenosaires\baranguard-secrets\` (outside the
repo). Verified both resolve/match via the real `env.php` loader — not
yet verified end-to-end on-device, since the installed APK predates the
file (it's a native-build-time input, live-reload can't touch it). A
plain rebuild+reinstall from Android Studio, then a real dispatch created
against the phone's registered device, is the actual proof this works —
not done yet. Full reasoning: `backend/DEVLOG.md` 2026-09-16.

Same session found two real, unfixed issues while investigating this:
(1) a session-expiry 401 is indistinguishable from "workstation
unreachable" in every screen's error message — no code anywhere
special-cases it to prompt re-login (`apiService.ts`'s `request()` is
the one place to fix it centrally); (2) once FCM does work, the
critical-alert overlay for a new dispatch still won't refresh the
Dispatches list's own cache — it renders the push payload but never
re-syncs the list. Neither is fixed yet. Detail: `backend/DEVLOG.md`
2026-09-16.

Also fixed for real (not FCM-related, found via a live-reload dev
session): `mobile/src/services/db/localDatabase.ts`'s
`openLocalDatabase()` could throw `"Connection baranguard already
exists"` and get misread by every screen as a workstation-connectivity
failure — root cause and fix in `backend/DEVLOG.md` 2026-09-16.

The react-router v6→v8 npm-audit bump was investigated 2026-09-15 and is
staying **deliberately deferred**: `@ionic/react-router` hard-caps
`react-router` below v7 in every build including the newest nightly (no
Ionic release tolerates v7/v8 yet), and neither flagged CVE's attack
surface exists in this app (no `<Link>`, no user-controlled `navigate()`
targets, no SSR). Revisit via `npm view @ionic/react-router
peerDependencies` once that changes.

**A2/A6 (AI eval)**: redaction got a real completed run 2026-09-14 —
recall 98.26% (meets target), precision 75.88% (misses target), Bikol
weakest-recall language bucket. All 8 model tasks (not just redaction)
now have a harness + 350-record dataset (A6, closed 2026-09-14) but only
redaction has real numbers — the other 7 need a friend's hardware next,
same as A2 did. No `ai_evaluation_run` row written yet (needs explicit
go-ahead to write the real DBs); Bikol human spot-check still open. Full
numbers: `REMAINING.md` A2/A6.

## Things most likely to bite you

1. A native exception on Capacitor's plugin-invocation thread can't be
   caught by JS try/catch — needs a native pre-check instead.
2. Never mount an Ionic tab shell at a root catch-all (`/*` or `*`) —
   `@ionic/react-router` 9.0.3 mishandles it (C6's cause). Keep shells at
   a named prefix (`/tabs/*`) with relative children.
   `location.pathname` being right doesn't prove the screen is — read
   the outlet's actual view stack if in doubt.
3. Every static check here (`node --check`, `verify-web-wiring.mjs`,
   `php -l`, `tsc`) can be green on code with a P0 defect — several real
   bugs needed a live device/HTTP call to surface.
4. A verify script proves nothing about a route it never calls — grep
   the `.sh` before trusting a green result.
5. `backend/.env` may point at `baranguard_uiseed`, not `baranguard`,
   and isn't git-tracked — check it before trusting any real-DB claim.
6. Gradle's daemon JVM follows `JAVA_HOME`, not `java` on PATH —
   `./gradlew --stop` then re-export before building.
7. A named PDO parameter can only bind ONE placeholder occurrence under
   native prepares (`ATTR_EMULATE_PREPARES => false`) — bit
   `GET /incidents/nearby` for its whole lifetime.
8. OSRM's build moved to vcpkg-from-source between v5.x and v26.x, no
   more v5.x tags — irrelevant now (routing runs on ORS) but a trap if
   self-hosting is ever revisited.
9. Google Maps Platform requires a billing card for ANY API key, even
   free-tier — confirm before starting a Google Cloud integration here.
10. An already-open browser tab can keep running a stale JS module graph
    even after a hard refresh confirms the server has the fix — try a
    brand-new tab before assuming a fix is wrong. **The same class of
    staleness may also affect a Capacitor WebView after a full process
    relaunch, not just a browser tab** — 2026-09-17's route-line
    investigation never got a `pm clear` retest to confirm, so treat this
    as a live open question, not a settled one.
11. `backend/scripts/bootstrap-admin.js`'s own header comment documents a
    `BARANGUARD_BOOTSTRAP_JSON` env var for non-interactive/CI use — the
    code never actually reads it (found 2026-09-15 while verifying
    `docs/SETUP.md`'s onboarding flow end-to-end). The interactive
    prompt works fine; piping answers via stdin in the same order as the
    prompts is the real non-interactive path today.
12. Capacitor live-reload (`CAP_LIVE_RELOAD=1`, see `capacitor.config.ts`)
    over `adb reverse tcp:5173 tcp:5173`: the mapping silently drops on
    every USB disconnect/reconnect (even a brief power-cycle of the
    link), producing `net::ERR_CONNECTION_REFUSED` in the WebView with no
    obvious cause. A background loop that polls `adb reverse --list`
    every few seconds and reapplies the mapping when it's missing is the
    practical fix — see `backend/DEVLOG.md` 2026-09-16. **2026-09-17: the
    whole adb connection itself (not just the port mapping) can also drop
    mid-session** (`adb devices` returned empty after being visible
    earlier, on what was likely a wireless-adb link) — check `adb devices`
    before trusting any "still connected" assumption from earlier in a
    session.
13. A live-reload WebView reload resets `localDatabase.ts`'s module-level
    JS state without restarting the native process, so the native SQLite
    plugin's own connection survives the reload — `createConnection()`
    then throws `"Connection ... already exists"`, indistinguishable at
    a glance from a real workstation-connectivity failure. Fixed
    2026-09-16 (check `isConnection()`, reuse via `retrieveConnection()`)
    but the underlying lesson holds for any singleton assumption in this
    codebase: live-reload can desync JS state from native/device state
    in ways a cold app launch never would.

## Recommended next step

**Finish the FCM test in flight first** — it's one rebuild away from a
real answer, then **C7** — makes the mobile app unusable for a real shift.

1. **Rebuild+reinstall the mobile app** (Gradle sync so
   `google-services` actually activates, then Run from Android Studio),
   confirm `GET /system/health` reports `fcm: healthy`, then create a
   real dispatch and confirm the critical-alert push actually lands.
2. **Resolve the route-line-not-rendering question** — reconnect the
   device, `adb shell pm clear ph.baranguard.tanod` for a truly fresh
   WebView load, re-add a temporary diagnostic log to `applyRoute()` in
   `LiveMapCanvas.tsx`, and confirm whether it fires this time before
   assuming any code change is needed.
3. **C7** — needs the Infinix X6840 to reproduce; check for a
   `DEBUG`/`Fatal signal` tombstone (native crash) vs `lmkd` line (memory
   kill) vs neither (OEM policy, leading hypothesis — fix is
   `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), then implement/verify
   whichever the evidence points to.
4. **Session-expiry 401 handling** (found 2026-09-16, not fixed) — add a
   central check in `apiService.ts`'s `request()` that clears the
   session and redirects to `/login` on a 401, instead of every screen
   showing a misleading "workstation unreachable" message.
5. **A1's six-item device checklist** — in progress, user-driven. See
   `REMAINING.md` A1 for the exact `adb` command per item.
6. **GSM modem ingestion daemon (A5)** — scoped 2026-09-17, not built.
   See "Where things stand" above for the planned design; user has the
   tethered-phone hardware now.
7. **Write the redaction `ai_evaluation_run` row** (needs explicit
   go-ahead — writes the real DB): dataset `redaction-eval-v1`/`v1`,
   model `aisingapore/Llama-SEA-LION-v3.5-8B-R`, sample_count 200,
   precision_score 0.75880, recall_score 0.98260. Apply migration 0021
   to the real databases first.
8. **Hand `eval-kit/` to a friend for the other 7 model tasks** —
   `README-FOR-FRIEND.md` has the commands. Then the Bikol human
   spot-check and human-rated translation/summary samples.
9. Then **Sprint 8** proper — pick exactly one box from `SPRINTS.md`.

**F1 (reopened)** isn't on this list because nothing currently depends on
remote access working — LAN-only development and testing both work fine
via `docs/SETUP.md`. Revisit only if a real persistent remote-access
requirement comes back (a Cloudflare Named Tunnel + Access policy would
be the natural next architecture, needing a Cloudflare account + domain).

Full ordered backlog with reasoning: `docs/REMAINING.md`.

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

# Turn-by-turn routing (real ORS block runs only with a real key in backend/.env)
bash backend/scripts/verify-routing.sh

# Device registration + map-packages
bash backend/scripts/verify-devices-map-packages.sh

# Evidence upload
bash backend/scripts/verify-evidence-upload.sh

# Pen-test dispatch/shifts/swap-requests/citizen-reports/sms
bash backend/scripts/verify-b2-pentest-remaining-resources.sh

# Sprint 3 backend (gps, dispatch status, sync/batch, nearby, mobile incidents)
bash backend/scripts/verify-sprint3.sh

# SMS broadcast idempotency index
bash backend/scripts/verify-f9-sms-broadcast-idempotency-index.sh

# Backup/second responder
bash backend/scripts/verify-second-responder.sh

# Build + install the mobile app onto a connected Android device
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

# Mobile static checks (run after ANY mobile change)
cd mobile && npx tsc --noEmit && npm run lint && node scripts/verify-local-schema.mjs
```

Neither the retention job nor the restore drill is scheduled — both are
CLI-only by design; wiring to Task Scheduler is an outstanding runbook step.

## Conventions

Commits: `[Tag] Short description`, ending with the `Co-Authored-By:`
line the current session instructions specify. Real remote (`origin` →
`github.com/jpbuenosaires/Baranguard`) — push before ending a session
that adds real work, not just when asked.

Rewrite this file — don't append — at the end of any session that
changes the picture. A stale `HANDOFF.md` is treated like a stale DEVLOG
claim: verify against the repo before trusting it.
