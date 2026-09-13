# Baranguard — Session Handoff

**This file is a replaced-in-place snapshot, not a log.** Rewrite the
sections below fresh each time something changes the picture — never
stack a new dated banner on an old one. Full session-by-session history
lives in `backend/DEVLOG.md` (grep it; don't read it front to back).

**Last updated: 2026-09-13.**

## Where things stand

**Sprints 0–7 are complete.** Sprint 8 (UAT/evaluation) is open. Its old
gate (`docs/REMAINING.md` §F) is fully closed. §C4's turn-by-turn routing
gap is also now closed (below) — Sprint 8 still has two real-device-
confirmed blockers (C6, C7) that should be fixed before any UAT scenario
touches login or an on-duty shift. See `SPRINTS.md`'s own gate note for
exact current wording.

### NEWEST: full turn-by-turn routing shipped (2026-09-13, same day, after everything else below)

Closes `docs/REMAINING.md` §C4. Took three real architecture decisions
in a row before anything shipped — worth knowing because the first two
left no code behind and are otherwise invisible history:

1. **Self-hosted OSRM** (the Master Reference's original §1 stack line)
   — abandoned mid-Phase-1 after a wrong-tag `git clone` (OSRM
   renumbered past v5.x) and then a real toolchain wall: OSRM's current
   build needs vcpkg compiling Boost/TBB/libarchive from source, memory-
   heavy on this workstation's ~8GB RAM.
2. **Google Routes API** — built COMPLETELY (client, migration, health
   probe, web dashboard wiring), then torn out the same day the moment
   it became clear Google requires a billing account with a card on
   file even to stay in the free tier — a hard blocker, not a
   preference, given this deployment has no card.
3. **OpenRouteService (ORS)** — shipped. Free, no card, OSM-data-backed.
   Request-building verified directly against ORS's own official Python
   client source; response field names confirmed live against a real
   route computed with the user's real key.

**What's real and verified, not just built:**
- `backend/services/routing/OrsClient.php` + two exceptions — the only
  caller of ORS. `geometries=geojson` means no polyline-decoder library
  anywhere in this stack; ORS's own `instruction` text means no
  maneuver-code translation table either.
- `SystemHealthController.php`'s `ors` field (renamed from `osrm`) is a
  REAL probe now, not a presence check — confirmed live: `not_configured`
  with no key, `healthy` with the user's real key.
- New endpoint `GET /dispatch/:id/route?latitude=&longitude=&mode=
  car|foot` — `DispatchController::route()`. Own-Tanod-or-Admin gated,
  tenant-scoped, never a 500. A rejected/unreachable refresh KEEPS the
  prior good route and marks it `stale` — proven live (not just reasoned
  about) using the discovery below.
- Mobile: `apiService.getDispatchRoute()`, `dispatchRepository.
  cacheRouteFetch()` (reuses existing `dispatch_local` columns, no
  schema change), `LiveMapCanvas.tsx` gained a `routeGeometry` layer,
  `assignment-detail.tsx` gained an explicit "Get Route" button + step
  list. The external-navigation-app link is UNCHANGED (explicit
  non-regression requirement). `npx tsc --noEmit` and `npx eslint` both
  clean.
- **Real bug found live, not suspected**: the mobile app's own
  `DEFAULT_CENTER` map constant (12.9186°N/123.6667°E) has NO routable
  road within 350m in OSM's data for this area — ORS's first real probe
  against it returned a genuine rejection. `OrsClient.php`'s health-check
  points were moved to a confirmed-on-road pair instead (real street
  names: Prieto, Smith Street). `DEFAULT_CENTER` itself is a display-only
  map-center constant elsewhere (web + mobile) and was left alone.
- **Real bug found and fixed**: `route_json` had two different shapes
  depending on which endpoint last wrote it (`GET /dispatch`'s
  `mapDispatch()` passed the server's raw snake_case through untouched;
  the new endpoint's mapper normalized to camelCase). Fixed with one
  shared `mapRouteJson()` normalizer both now use.

**Verification**: new `backend/scripts/verify-routing.sh`, 23/23, against
a disposable DB over real HTTP — including a real-ORS block (only runs
with a real key in `backend/.env`, same "human-supplied precondition"
shape `restore-drill.sh` already has) that proves the stale-fallback
behavior against genuine ORS responses, not mocks. `verify-web-wiring.mjs`
unaffected (536/537 — the one failure is pre-existing, unrelated
in-progress `AppShell.js` work already in the tree).

**Docs reconciled the same session**: `docs/Baranguard_Master_Reference_
FINAL .md` (§1 stack table, Rules 7/15, `POST /dispatch` + new
`GET /dispatch/:id/route` contracts, `GET /system/health` shape),
`docs/REFERENCE.md` (§5 endpoint count 83→84, migration list, §9 verify
table), `docs/REMAINING.md` §C4, `backend/DEVLOG.md`.

**Migration 0020 applied to both real databases** (`baranguard` and
`baranguard_uiseed`, 2026-09-13, confirmed via `DESCRIBE
health_check_log` on each — `ors_status` present, defaulted
`not_configured`). A real `ORS_API_KEY` is in the real `backend/.env`
(the same file `verify-routing.sh`'s real-ORS block reads). No
real-device confirmation of the mobile UI yet — same A1 blocker as
everything else mobile, disclosed rather than claimed proven.

**Web dashboard route rendering — also shipped the same day, read-only
by explicit user decision.** Dispatch Center now shows whatever route a
Tanod's own mobile "Get Route" tap already computed — the web dashboard
never calls the routing endpoint itself (no geolocation/coordinate-input
concept exists anywhere in its Admin pages, and routing from the
Admin's own desk wouldn't be operationally meaningful). Planned via
`EnterPlanMode` first, then built: `apiClient.js` gained the same
`mapRouteJson()` fix mobile got; `LiveMap.js` gained `setRoute()`
mirroring its existing `setBoundary()` pattern exactly; `dispatch-
center.js` gained a per-responder "Show Route"/"Hide Route" button
(single-active-route model, gated on a route actually existing).
**Verified against real data, not mocks**: a throwaway admin account
was created in `baranguard_uiseed` (deleted after), the real
`GET /dispatch/:id/route` endpoint was called for a real dispatch to
produce a genuine ORS route, and a real browser walkthrough confirmed
the button appears only on that dispatch, clicking it draws the actual
computed route line on the map (screenshotted), and hiding it clears the
line. **Real bug found along the way, NOT caused by this work**: the
same pre-existing uncommitted `dispatch-center.js` changes already in
the tree before this session (see "previously-flagged uncommitted work"
pattern elsewhere in this file's history) had accidentally deleted
`let latestData = null;`, breaking the ENTIRE screen with a
`ReferenceError` — confirmed via `git diff` and this session's own first
`Read` of the file (already missing before any edit of mine). Restored
the one line so the screen works; flagged in `backend/DEVLOG.md` rather
than silently fixed away, since it isn't code this session owns.

### Everything before that (condensed — see `backend/DEVLOG.md` for full detail)

Earlier the same day: continued real-device testing on the same Infinix
X6840 — found/fixed 3 real mobile bugs (a native FCM-registration crash
on login, a full-screen critical-alert theme crash, no-Firebase devices
unable to register at all — `REMAINING.md` C5), decided + implemented
Tailscale as the mobile connectivity architecture, shipped G1's SOS
third-fallback-tier SMS path, found 2 new bugs still open (C6, C7 —
below). Then, as an explicit user-requested multi-box exception: closed
a 7-item punch list (F9's idempotency index, a chart null-vs-zero bug,
npm audit triage, Secretary/PB nav browser-verify — which found and
fixed a real PB dashboard 403 bug, `mobile/android/` committed), closed
4 "Quick" items from a published backlog artifact (F5 idempotency index,
an evidence-access audit log, a stale doc correction, a GIS panel
simplification), closed F1's web-dashboard half, and shipped backup/
second-responder dispatch (finding + fixing 3 fabricated-data UI
fallbacks and 1 Dispatch Center per-dispatch-not-per-incident card bug
along the way). All of F2/F3/F5/F6/F7/F8, G2/G3/G4, and the full §G
backlog were already closed in prior sessions and remain unchanged.
Migrations 0001–0019 are applied to both real databases.

## Two bugs found this week, still OPEN (unrelated to routing)

- **C6 — login can leave the OLD screen visually stuck over Home.**
  Confirmed via remote DevTools: `location.pathname` is genuinely
  `/home` and Home's mount effects run, but `document.
  querySelectorAll('.ion-page').length` returns 3, two sharing the same
  `z-index`. An Ionic `IonRouterOutlet` page-stacking bug — `/login`
  and the tab shell's `/*` route are siblings in the same outer outlet,
  and `login.tsx`'s `navigate('/home', {replace:true})` crosses directly
  into a route nested inside `TabbedShell`'s OWN inner outlet.
  Investigation paused, not resolved — see `REMAINING.md` C6.
- **C7 — the whole app process died twice, ~50s after patrol GPS
  started.** `adb logcat` shows `Process ... has died: fg +50 FGS` with
  no Java exception either time. More serious than C6, completely
  uninvestigated. See `REMAINING.md` C7.

## Things most likely to bite you

1. **A native exception on Capacitor's own plugin-invocation thread
   cannot be caught by JS try/catch.** The only real fix is a native
   check BEFORE the crash-prone call.
2. **Ionic's `IonRouterOutlet` treats sibling top-level routes as
   separate page-stack entries.** `location.pathname` being right is
   not proof the screen is right (see C6).
3. **Every static check in this project can be green on code with a P0
   defect.** `node --check`, `verify-web-wiring.mjs`, `php -l`, `tsc`
   all parse-and-resolve; none of them caught the FCM crash, the
   CriticalAlertActivity theme mismatch, the device-registration 422, or
   `GET /incidents/nearby`'s reused-named-parameter 500 — all needed a
   real device or a real HTTP call to prove.
4. **A verify script proves nothing about an endpoint it never calls.**
   Grep every `*.sh` for a route before trusting a suite's green result.
5. **`backend/.env` may still be pointed at `baranguard_uiseed`, not
   `baranguard`**, and it is NOT tracked by git. Check the file itself
   before trusting any CLI run against "the real database."
6. **Gradle's daemon JVM is decided by `JAVA_HOME`, not `java` on PATH.**
   Always `export JAVA_HOME=...` (and `./gradlew --stop` first).
7. **A named PDO parameter can only be bound to ONE placeholder
   occurrence under native prepares** (`config/db.php`'s
   `ATTR_EMULATE_PREPARES => false`) — bit `GET /incidents/nearby` for
   its entire lifetime, fixed.
8. **OSRM's build system changed from apt-installable system packages to
   vcpkg-managed from-source builds somewhere between v5.x and v26.x**,
   and its versioning scheme changed too (no more v5.x tags at all) —
   cost real time this session before the OSRM path was abandoned for
   other reasons. Irrelevant now that routing runs on ORS, but a trap
   for anyone who revisits self-hosting later.
9. **Google Maps Platform requires a billing account with a card on
   file to issue ANY API key**, even one that will only ever be used
   inside the free tier. Confirm this constraint before starting any
   Google Cloud integration on a deployment without a card.
10. **An already-open browser tab can keep running a stale JS module
    graph even after a hard refresh (Ctrl+Shift+R) fetches the corrected
    file from the server.** Hit this browser-verifying the route-
    rendering fix — `fetch(url, {cache:'no-store'})` confirmed the
    server had the fixed file, Network showed fresh 200s on reload, yet
    the SAME tab kept throwing the old error. A brand-new tab (same
    login, same URL) loaded the fix immediately. If a fix "isn't taking"
    in the browser despite the server clearly serving it, try a fresh
    tab before assuming the fix is wrong.

## Recommended next step

**C6 and C7 first** — they make the mobile app genuinely unusable for a
real shift, ahead of anything in `REMAINING.md`'s own numbered order.

1. **C6** — resume the paused investigation (see `REMAINING.md` C6 for
   the exact next diagnostic step).
2. **C7** — give this its own session; reproduce deliberately with
   `adb logcat -b crash` / `dumpsys activity` running.
3. **Confirm G1's real-SMS leg** — configure a backup contact, kill
   connectivity, verify the on-device SMS actually arrives.
4. **Hand `eval-kit/` to a friend with capable hardware** for A2.
5. **The 9 remaining `mobile/` npm advisories** — each needs its own
   test-and-verify pass; see `REMAINING.md`'s C4 section.
6. Then **Sprint 8** proper — pick exactly one box from `SPRINTS.md`.
7. ~~Apply migration 0020 to the real databases~~ **Done 2026-09-13** —
   applied to both `baranguard` and `baranguard_uiseed`.

Full ordered list with reasoning, including hardware/account-blocked
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

# Tailscale status (both mobile AND web dashboard connectivity)
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
