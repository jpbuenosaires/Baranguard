# Baranguard — Session Handoff

**Replaced-in-place snapshot, not a log** — rewrite fresh each session,
never stack banners. Full history: `backend/DEVLOG.md` (grep by
date/keyword, don't read front to back).

**Last updated: 2026-09-18.**

## Where things stand

Sprints 0–7 complete. Sprint 8 (UAT/evaluation): **every box doable
without a real device or a live Ollama run is now done**, with real
measured evidence — response-time metric, JSON contract validation,
auth lockout/session revocation, tenant pentest, raw-PII audit, fatigue
audit trail, offline-map availability (server side), and one full
citizen-report-to-resolution UAT scenario. Full detail in
`backend/DEVLOG.md`'s 2026-09-17/18 entries. What's left in Sprint 8 —
offline cache durability, notification e2e reliability, GPS/route
accuracy, AI dataset evaluation, SLM inference across device tiers — is
genuinely blocked on hardware or a friend's faster machine, not skipped
for convenience.

**Credentials, corrected this session — use these, not older ones
elsewhere in this file's history**: `baranguard_uiseed` login password
is `Demo@2026` (not `DevSeed#2026`, which was stale from an earlier seed
round). `tanod.olayvar` is seeded `is_suspended=1` — its login is
*supposed* to fail; use `tanod.reyes`, `tanod.delacruz`, `tanod.gubaton`,
or `tanod.dichoso` instead (all active, not suspended).

**One open blocker: C7** — the app process dies ~50s into patrol GPS.
Confirmed NOT reproducing on a Galaxy A21s (2026-09-15); still needs the
Infinix X6840 in hand to reproduce for real and pick between a native
crash, an `lmkd` memory kill, or (leading hypothesis) an OEM battery
policy needing `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. Doesn't block a
UAT scenario that skips an on-duty patrol shift.

**A5 (GSM modem)**: the ingestion daemon
(`backend/scripts/gsm-ingest-daemon.php`) is built and proven end-to-end
against a fixture shaped like real `adb` output — real AES-256-GCM
decrypt, real incident creation, real replay-dedup, all confirmed in the
DB. Found and fixed along the way: `DEVICE_SECRET_MASTER_KEY` and
`INTERNAL_SERVICE_TOKEN` were BOTH unset in the real `.env`, meaning
`/internal/sms/*` had never worked on this workstation at all — both are
now generated and set locally (gitignored). **Only the real `adb shell
content query` invocation against your actual tethered phone is
unverified** — see the Recommended next step below for the exact command.

**FCM**: wired to a real Firebase project (`baranguard-acb27`) 2026-09-16,
but the installed APK predates `google-services.json` (a native-build-time
input) — needs a rebuild+reinstall to actually activate, then a real
dispatch to confirm the push lands. Not done yet.

**Session-expiry 401 handling**: fixed 2026-09-18.
`apiService.ts`'s `request()` now clears the session and fires a central
event on any 401 from an authenticated call; `App.tsx`'s
`SessionExpiryWatcher` redirects to `/login` immediately instead of every
screen showing a misleading "workstation unreachable" message.
Code-verified (`tsc`/`eslint`/`vite build` all clean) — **not yet
device-tested**, the real 401-to-redirect round trip needs a live
Capacitor session.

**Route-line rendering** (mobile turn-by-turn nav): a live screenshot
showed no blue route line over the road. `LiveMapCanvas.tsx`'s
route-drawing code reads correctly, and a diagnostic log added to
`applyRoute()` never fired even once despite GPS position updating
continuously — most likely a stale/cached WebView bundle, not a logic
bug, but never confirmed. The device's adb connection dropped
mid-investigation before a `pm clear` retest could run. **Next device
session: reconnect, `adb shell pm clear ph.baranguard.tanod`, re-add a
temporary log to `applyRoute()`, confirm it fires before assuming any
code change is needed.**

**A2/A6 (AI eval)**: redaction has a real completed run — recall 98.26%
(meets target), precision 75.88% (misses target), Bikol is the
weakest-recall language bucket. The `ai_evaluation_run` row is written to
both real DBs (2026-09-18). All 8 model tasks have a harness+dataset, but
only redaction has real numbers — the other 7 need a friend's faster
hardware (this workstation can't finish a generation inside Ollama's
300s timeout). Bikol human spot-check still open.

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
    before assuming a fix is wrong. Never fully confirmed on the WebView
    side (see "Route-line rendering" above) — treat as a live open
    question, not settled.
11. `backend/scripts/bootstrap-admin.js`'s own header comment documents a
    `BARANGUARD_BOOTSTRAP_JSON` env var for non-interactive/CI use — the
    code never actually reads it. The interactive prompt works fine;
    piping answers via stdin in the same order as the prompts is the
    real non-interactive path today.
12. Capacitor live-reload (`CAP_LIVE_RELOAD=1`) over
    `adb reverse tcp:5173 tcp:5173`: the port mapping silently drops on
    every USB disconnect/reconnect, producing `net::ERR_CONNECTION_
    REFUSED` with no obvious cause. The whole adb connection itself can
    also drop mid-session, not just the mapping (seen on what was likely
    a wireless-adb link) — check `adb devices` before trusting any
    "still connected" assumption from earlier in a session.
13. A live-reload WebView reload resets JS module-level state without
    restarting the native process, so a native plugin's own connection
    can survive the reload while the JS side thinks it's starting fresh
    (`localDatabase.ts`'s `"Connection ... already exists"` — fixed, but
    the general lesson holds for any singleton assumption in this
    codebase).

## Recommended next step

1. **Rebuild+reinstall the mobile app** — Gradle sync so
   `google-services` activates, then Run from Android Studio. Confirm
   `GET /system/health` reports `fcm: healthy`, then create a real
   dispatch and confirm the critical-alert push lands.
2. **A5's last check** — with the tethered phone connected:
   `php backend/scripts/gsm-ingest-daemon.php --status` to confirm `adb`
   reaches it, then capture one real `adb shell content query --uri
   content://sms/inbox --projection "_id:address:date:body"` sample and
   diff it against `backend/storage/gsm-test-fixture.txt`'s shape —
   adjust `parseContentQueryOutput()` if it differs — then send one real
   test SMS (the fixture's envelope JSON as the body) from a second
   phone before trusting `--daemon` unattended.
3. **Resolve the route-line-not-rendering question** — reconnect the
   device, `adb shell pm clear ph.baranguard.tanod`, re-add a temporary
   diagnostic log to `applyRoute()` in `LiveMapCanvas.tsx`, confirm
   whether it fires this time.
4. **C7** — needs the Infinix X6840; check for a `DEBUG`/`Fatal signal`
   tombstone vs an `lmkd` line vs neither (OEM policy, leading
   hypothesis), then implement/verify whichever the evidence points to.
5. **A1's six-item device checklist** — in progress, user-driven. See
   `REMAINING.md` A1 for the exact `adb` command per item.
6. **C2 (Task Scheduler wiring)** — needs your call on schedule/account
   and whether `BACKUP_ENCRYPTION_PASSPHRASE` gets stored for unattended
   runs; tell me and I'll build it.
7. **B3 (restore drill)** — give me `BACKUP_ENCRYPTION_PASSPHRASE` and
   I'll run it for real; W20 still shows "Never."
8. **Hand `eval-kit/` to a friend's faster hardware** for the other 7
   model tasks — `README-FOR-FRIEND.md` has the commands. Then the
   Bikol human spot-check and human-rated translation/summary samples.

**F1 (API base URL, reopened)** isn't on this list — nothing currently
depends on remote access working; LAN-only development/testing both work
via `docs/SETUP.md`. Revisit only if a real persistent remote-access
requirement comes back (a Cloudflare Named Tunnel + Access policy would
be the natural next architecture).

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

# GSM ingestion daemon (once the phone's adb-reachable)
cd backend && php scripts/gsm-ingest-daemon.php --status
php scripts/gsm-ingest-daemon.php --once   # one poll
php scripts/gsm-ingest-daemon.php --daemon # keep polling

# Web wiring check — run after ANY web change
node web/scripts/verify-web-wiring.mjs

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
