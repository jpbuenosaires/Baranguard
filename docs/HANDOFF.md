# Baranguard — Session Handoff

**Replaced-in-place snapshot, not a log** — rewrite fresh each session,
never stack banners. Full history: `backend/DEVLOG.md` (grep by
date/keyword, don't read front to back).

**Last updated: 2026-09-22.**

## Where things stand

Sprints 0–7 complete. Sprint 8 (UAT/evaluation): every device-free box
was done 2026-09-17/18; 2026-09-19 was the first real device session on
the Infinix X6840 (the C7 phone) and closed most of what was
hardware-blocked. Evidence screenshots: `docs/evidence/2026-09-19-device/`.
Full detail: `backend/DEVLOG.md` 2026-09-19 entries (1)–(7), 2026-09-22.

**Branch/remote note (2026-09-22):** `main` had been stale since before
Sprint 8 while `develop` and feature branches carried all the real work
(PR #1 merged into `develop`, not `main`). `main` was fast-forwarded to
catch up (now equal to the former `feature/push-body-incident-label`
tip). **By explicit user instruction, all work from now on commits and
pushes directly to `main`** — no more feature branches or PRs. `develop`
and `feature/push-body-incident-label` still exist on the remote but are
no longer the active line; don't build on them without asking first.

**Credentials**: `baranguard_uiseed` password is `Demo@2026`.
`tanod.olayvar` is seeded suspended — use `tanod.reyes` (user_id 4),
`tanod.delacruz`, `tanod.gubaton`, or `tanod.dichoso`. `admin.dao` is
the Admin. `backend/.env` currently points at `baranguard_uiseed`.

**Confirmed on hardware 2026-09-19 (first time for each):**
- **FCM push lands** (A4): `google-services.json` baked into the APK,
  `/system/health` → `fcm: healthy`, a real `POST /dispatch` produced a
  heads-up + in-app NEW DISPATCH sheet within ~1s, ACKNOWLEDGE wrote
  `notification_target.acknowledged_at`. M12 PASS.
- **Route line renders** — root cause was MapLibre 6.x's GeoJSON worker
  never loading under Vite, not a stale bundle.
- **C7 did NOT reproduce on the Infinix**: 405s foreground GPS + a
  screen-off run with `PatrolLocationService` confirmed running and
  `gps_track` rows every ~30s. Downgraded from 🔴 to 🟡 in REMAINING.md;
  not closed — a real 30+ min locked-screen run is still outstanding.
- **A1**: #1 SQLCipher, #2 offline capture survives kill, #4 keystore
  round-trip, #6 sync drains queue — all PASS. #3 photo/voice and M13
  SMS badge still open.
- **A5**: adb reaches the phone, real `content query` shape matches the
  fixture. One real envelope SMS from a second phone still to send.
- **GPS/route accuracy** (Sprint 8 box): stationary baseline measured —
  30.8s interval, 39.7m avg reported accuracy, 3.0s upload lag, route
  44.2km vs 29.7km straight-line. Moving-along-a-known-street run not
  done (device wasn't in Pilar).

**Device-found bugs — status:**
- Fixed + device-verified 2026-09-19: fresh-install GPS permission gap,
  SQLCipher passphrase/`raw_narrative` in logcat (`loggingBehavior:
  'none'` now), cold-start `openLocalDatabase()` race, "15s" vs real 30s
  label.
- Fixed 2026-09-22, **code only, not yet device-verified** (no device
  available that session): Home's dispatch card only refreshed on
  mount (now also on `appStateChange` resume); system heads-up
  notification stayed posted after in-app ACKNOWLEDGE (now cancelled via
  `FullScreenAlertPlugin.dismiss()`); duty card showed OFF DUTY for an
  actually-*unknown* offline status (now its own "Duty Status Unknown
  (Offline)" label). Push body "a animal_complaint" grammar was fixed
  earlier (`7e9952a`). **Next device session should confirm all three**
  before this bullet is removed.

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

## Recommended next step

Everything below needs either the Infinix X6840 in hand or a human
decision/credential — nothing left is a pure coding-session task.

1. **A1 #3** — on the phone: Log Incident → Photo Evidence (allow
   camera), Voice Memo (allow mic), save; then `adb shell run-as
   ph.baranguard.tanod ls files/evidence/` and pull one file of each to
   confirm it opens.
2. **Confirm the three 2026-09-22 code fixes on a real device** (Home
   dispatch-card refresh, heads-up dismiss, duty-unknown label) — see
   "Device-found bugs" above.
3. **A5's last step** — send one real envelope SMS (the fixture's JSON
   body) from a second phone to the tethered Infinix, then
   `php backend/scripts/gsm-ingest-daemon.php --once` and check the DB.
4. **C7 long locked-screen run** — 30+ min screen-off on the Infinix,
   `adb logcat` for `has died`/`lmkd`/tombstone. If it ever kills,
   `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is the fix to try.
5. **GPS moving run** — a Tanod walking a known Dao street with the app
   on duty; compare `gps_track` against the road.
6. **C2 (Task Scheduler wiring)** / **B3 (restore drill)** — need your
   schedule/account call and `BACKUP_ENCRYPTION_PASSPHRASE`.
7. **Hand `eval-kit/` to faster hardware** for the other 7 model tasks.

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
that adds real work, not just when asked. **As of 2026-09-22, commit and
push directly to `main`** — no feature branches, no PRs, by explicit
user instruction.

Rewrite this file — don't append — at the end of any session that
changes the picture. A stale `HANDOFF.md` is treated like a stale DEVLOG
claim: verify against the repo before trusting it.
