# Baranguard — Session Handoff

**Replaced-in-place snapshot, not a log** — rewrite fresh each session,
never stack banners. Full history: `backend/DEVLOG.md` (grep by
date/keyword, don't read front to back).

**Last updated: 2026-09-19 (device session).**

## Where things stand

Sprints 0–7 complete. Sprint 8 (UAT/evaluation): every device-free box
was done 2026-09-17/18; **2026-09-19 was the first real device session
on the Infinix X6840** (the C7 phone) and closed most of what was
hardware-blocked. Evidence screenshots: `docs/evidence/2026-09-19-device/`.
Full detail: `backend/DEVLOG.md` 2026-09-19 entries (1)–(6).

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
  never loading under Vite (see 2026-09-19 (1)), not a stale bundle.
- **C7 did NOT reproduce on the Infinix**: 405s foreground GPS + a
  screen-off run (result in DEVLOG 2026-09-19 (6)) with
  `PatrolLocationService` confirmed running and `gps_track` rows every
  ~30s. Downgraded from 🔴 to 🟡 in REMAINING.md; not closed.
- **A1**: #1 SQLCipher, #2 offline capture survives kill, #4 keystore
  round-trip, #6 sync drains queue — all PASS. #3 photo/voice and M13
  SMS badge still open.
- **A5**: adb reaches the phone, real `content query` shape matches the
  fixture. One real envelope SMS from a second phone still to send.
- **GPS/route accuracy** (Sprint 8 box): stationary baseline measured —
  30.8s interval, 39.7m avg reported accuracy, 3.0s upload lag, route
  44.2km vs 29.7km straight-line. Moving-along-a-known-street run not
  done (device wasn't in Pilar).

**Four bugs found by the device, all fixed and device-verified:**
1. Fresh install went "on duty" with NO location permission and no GPS
   while the card said "Foreground GPS" — nothing ever called
   `requestPermissions()`. Now explicit; card says "GPS OFF" if denied.
2. **SQLCipher passphrase and `raw_narrative` were in logcat** —
   Capacitor's default bridge logging echoes every plugin result.
   `capacitor.config.ts` `loggingBehavior` is now `'none'`
   (`CAP_DEBUG_LOGGING=1 npx cap sync android` re-enables for a local
   diagnostic build only).
3. Cold-start race in `openLocalDatabase()` — three concurrent opens,
   Home read empty. Now one in-flight promise.
4. Home said "15s Broadcast"; the service runs 30s. Label fixed.

**Decision taken (option B, user's call 2026-09-19):** the app shell now
gates on a session *existing*, not on the 15-min JWT being locally
unexpired (`hasStoredSession`), so a Tanod out of range >15 min keeps
their cached dispatches/map/reports on cold start. Server still 401s the
stale token on first contact and the existing handler redirects to
Login. **Device verification of this exact path: see DEVLOG 2026-09-19
(6).**

**Observed 2026-09-19, three of four now fixed 2026-09-22 (code only —
no device this session, so none of the three are device-verified yet)**:
Home's dispatch card only reading the cache on mount (now also refreshes
on `appStateChange` resume); the system heads-up staying posted after
in-app ACKNOWLEDGE (now cancelled via a new `FullScreenAlertPlugin.dismiss()`);
duty card saying OFF DUTY when status is actually *unknown* offline (now
its own "Duty Status Unknown (Offline)" label/color). Push body
"a animal_complaint" was already fixed earlier (`7e9952a`). Detail:
`backend/DEVLOG.md` 2026-09-22. **Next device session should confirm all
four** before this line is removed.

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
    before assuming a fix is wrong. (The 2026-09-18 route-line symptom
    turned out to be a real bug — MapLibre's worker never loading — not
    a stale bundle, but the general caution still holds.) Also: `adb
    shell pm clear` resets RUNTIME PERMISSIONS, not just data — check
    `dumpsys package ph.baranguard.tanod | grep granted` before trusting
    any GPS/camera test after a clear.
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
    codebase). Bit again 2026-09-19 in a different shape: THREE
    concurrent `openLocalDatabase()` calls at cold start, because the
    singleton was assigned only after several awaits — guard the
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

1. **A1 #3** — on the phone: Log Incident → Photo Evidence (allow
   camera), Voice Memo (allow mic), save; then `adb shell run-as
   ph.baranguard.tanod ls files/evidence/` and pull one file of each to
   confirm it opens.
2. **A5's last step** — send one real envelope SMS (the fixture's JSON
   body) from a second phone to the tethered Infinix, then
   `php backend/scripts/gsm-ingest-daemon.php --once` and check the DB.
3. **C7 long locked-screen run** — 30+ min screen-off on the Infinix,
   `adb logcat` for `has died`/`lmkd`/tombstone. If it ever kills,
   `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is the fix to try.
4. **GPS moving run** — a Tanod walking a known Dao street with the app
   on duty; compare `gps_track` against the road.
5. **Fix the four "observed, not yet fixed" items** above — all small.
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
that adds real work, not just when asked.

Rewrite this file — don't append — at the end of any session that
changes the picture. A stale `HANDOFF.md` is treated like a stale DEVLOG
claim: verify against the repo before trusting it.
