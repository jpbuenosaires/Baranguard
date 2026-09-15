# Baranguard — Session Handoff

**This file is a replaced-in-place snapshot, not a log.** Rewrite the
sections below fresh each time something changes the picture — never
stack a new dated banner on an old one. Full session-by-session history
lives in `backend/DEVLOG.md` (grep it; don't read it front to back).

**Last updated: 2026-09-15.**

## Where things stand

**Sprints 0–7 are complete.** Sprint 8 (UAT/evaluation) is open. Its old
gate (`docs/REMAINING.md` §F) is fully closed. §C4's turn-by-turn routing
gap is also now closed. **C6 (login left the old screen stuck over Home)
closed 2026-09-15** — root-caused to an `@ionic/react-router` 9.0.3
defect with a root-level `/*` tab shell and fixed by moving the shell to
`/tabs/*`, proven on a real device through the exact repro sequence (see
"NEWEST" below). Sprint 8 still has ONE real-device-confirmed blocker
(C7) that should be fixed before any UAT scenario touches an on-duty
shift. See `SPRINTS.md`'s own gate note for exact current wording.

**A2 (the AI model's own end-to-end run) got real results 2026-09-14** —
a friend ran `eval-kit/` on their own hardware and sent back a completed
200-record evaluation, the first the model has ever actually finished
against the full dataset. Verified, not just trusted: the checkpoint's
per-record sums match the results file's aggregate exactly, and both
input dataset files are byte-identical to this repo's tracked copies.
**Recall 98.26% meets the ≥95% target; precision 75.88% misses the ≥90%
target** (the results file says so itself). A language breakdown derived
this session (joining the checkpoint against the dataset's own
`language` field, not present in either file sent) shows Bikol as the
measurably weakest recall (96.90% vs ~98.85% for English/Tagalog) — 7 of
the 13 total leaks despite being 30% of the dataset — while precision is
flat across languages. A second finding: every one of the 13 leaks came
from an "ordinary" (`hard_case: null`) record; none of the 7 deliberately
engineered hard-case categories produced a single leak. See
`backend/DEVLOG.md` 2026-09-14 and `docs/REMAINING.md` A2 for the full
numbers and caveats (the run was resumed, so its 1007.1s elapsed timing
covers only the last 24 records, not all 200; only 3 of the 13 leaked
names' identities survived in what was sent). **Not yet done**: no row
written to the real `ai_evaluation_run` table — deliberately paused
rather than writing to the real `baranguard`/`baranguard_uiseed`
databases without being asked; the long-recommended Bikol human
spot-check also still hasn't happened.

**A2's own finding immediately surfaced a bigger gap, closed the same
day: `docs/REMAINING.md` A6, "7 of the model's 8 tasks were never
evaluated at all."** The model backs 8 distinct prompt types
(`AiPrompts.php`); only `redaction` had ever been scored. Planned first
(researched methodology + targets for every task, four confirmed
architecture decisions), then rebuilt: the evaluation dataset grew from
200 to **350 records across 7 language buckets** — the original 3 pure
languages (en/tl/bcl) plus **4 code-mixed combinations**
(bcl-tl/bcl-en/tl-en/bcl-tl-en), because Bicol-region residents typically
code-switch and a monolingual-only corpus was testing an unrealistic
input shape — plus new ground truth (`complainant`/`respondent`/
`contact`/`priority`) for the two tasks that needed it. New
`backend/services/eval/` scorer classes (33/33 unit-checked); `ai-
evaluate.php` generalized to a `--task=` dispatch across all 8 tasks,
its pacing/resume/checkpoint machinery unchanged and re-verified;
migration `0021` added generic metric columns to `ai_evaluation_run` for
the tasks that aren't precision/recall-shaped (verified up/down/
idempotent against a disposable DB, not yet applied to the real
databases); `eval-kit/` converted from a hand-maintained copy to a
GENERATED one (`build-eval-kit.php`), closing a real, already-confirmed
drift bug (its `AiPrompts.php` copy was missing 4 of 8 methods). See
`backend/DEVLOG.md` 2026-09-14 ("full 8-task AI evaluation rebuild") and
`docs/REMAINING.md` A6 for the complete writeup, provisional per-task
targets (all researched, none yet empirically validated), and what's
still open (a friend's hardware still needs to run the other 7 tasks
against the real model, same as A2 needed for redaction; the human-rated
translation/summary quality samples haven't happened).

### NEWEST: C6 closed — the tab shell moved from `/*` to `/tabs/*` (2026-09-15)

The Ionic page-stacking bug behind C6 is fully root-caused, fixed, and
verified on a real device (a Samsung Galaxy A21s this time, not the
Infinix). Read `App.tsx`'s `TabbedShell` doc block for the full
mechanism; the short version:

- **Cause:** `@ionic/react-router` 9.0.3's `StackManager.
  handleReadyEnteringView()` treats any route ending in `/*` as a
  "wildcard container" and derives its base as `path.replace(/\/\*$/, '')`
  — the EMPTY string for our root-level `path="/*"` — so its "same
  container?" check was `pathname.startsWith('/')`, true for everything.
  `/login` → `/home` was therefore treated as a tab switch and the
  transition SKIPPED: the shell kept `ion-page-invisible` (opacity 0) and
  login never got `ion-page-hidden`. "Sometimes" was a 300 ms
  wait-timeout fallback that hides the old page itself when the shell
  mounts slowly; the bug hit on every fast login. Bonus latent defect
  with the same cause: a root catch-all matches every pathname, so at
  sign-out the shell's view item was repurposed in place as the login
  view (view id reused, `childProps.path` still `/*`). The previous
  "cross-outlet boundary" theory in this file was wrong. Not fixed
  upstream as of `9.0.4-nightly.20260914`.
- **Fix:** shell at `/tabs/*`, relative child routes, `/` → `/tabs/home`,
  every `navigate()`/tab `href`/`defaultBackHref` moved; `/login` and
  `/incidents/:localId/submitted` stay outside the shell; deliberately
  no `*` not-found route. Eleven files in `mobile/src`, all path strings
  except `App.tsx`.
- **Proof (real device, remote DevTools over `adb forward` to the
  WebView's `webview_devtools_remote_<pid>` socket):** a DOM
  MutationObserver log captured the broken sequence before the fix
  (shell registered 116 ms after navigation, then nothing else ever
  happened to either outer page) and the fixed one after (shell revealed
  + login hidden in the same frame, login removed 250 ms later); the
  outlet's internal view stack was read through the React fiber both
  times (before: the repurposed `childPropsPath: "/*"` login view plus
  an untransitioned shell; after: exactly one `/tabs/*` view). Then:
  sign-out, the original sign-out → sign-in repro twice ("Home appeared
  normally" both times), tab switching, a param route
  (`/tabs/assignments/srv-18`), hardware Back from a detail page, the M4
  confirmation-page round trip (same defect shape, both directions), and
  cold start with and without a live session. Screenshots of the stuck
  and fixed states were taken over the same protocol.
- **Reusable technique** (no app changes needed — the scripts lived only
  in that session's scratchpad, recreate in a minute): `adb forward
  tcp:9222 localabstract:webview_devtools_remote_<pid>`, then
  `Runtime.evaluate` over the `/json` target's websocket from Node 22+
  (built-in `WebSocket`). Find the outer `ion-router-outlet`'s React
  fiber (`Object.keys(el).find(k => k.startsWith('__reactFiber$'))`), walk
  `.return` to the class instance with `handlePageTransition` +
  `registerIonPage` (method names survive minification; the class name
  does not), and read `sm.context.getViewItemsForOutlet(sm.id)`. That
  dump is what turned a "sometimes" visual glitch into a deterministic
  library code path in one look.
- **Not done / caveats:** `App.test.tsx` still fails for the pre-existing
  reason documented under `REMAINING.md` C4's Cypress note
  (`localDatabase.ts`'s web-unsupported guard reached from `App.tsx`'s
  mount effect) — unrelated to routing, unchanged. `npx eslint` reports
  unused icon imports in `home.tsx`/`new-incident.tsx`/`profile.tsx`/
  `assignments.tsx`/`assignment-detail.tsx` that already exist in HEAD
  (`e559dbd`) — not touched; one-line removals whenever someone owns
  those files next. The installed device build also contains the OTHER
  sessions' uncommitted in-flight mobile work present in the tree
  (`LiveMapCanvas.tsx`/`assignment-detail.tsx` route-progress UI,
  `app.css`), since a build is of the working tree; only the C6 hunks
  were committed.

### Full turn-by-turn routing shipped (2026-09-13)

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
third-fallback-tier SMS path, found 2 new bugs (C6 — since closed, see
NEWEST above — and C7, still open, below). Then, as an explicit user-requested multi-box exception: closed
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

## One bug found this week, still OPEN (unrelated to routing)

- **C7 — the whole app process died twice, ~50s after patrol GPS
  started.** `adb logcat` shows `Process ... has died: fg +50 FGS` with
  no Java exception either time. Completely uninvestigated. See
  `REMAINING.md` C7. *(C6, which used to sit next to it here, is closed
  — see NEWEST above.)*

## Things most likely to bite you

1. **A native exception on Capacitor's own plugin-invocation thread
   cannot be caught by JS try/catch.** The only real fix is a native
   check BEFORE the crash-prone call.
2. **Never mount an Ionic tab shell at a root-level catch-all
   (`path="/*"` or `"*"`).** `@ionic/react-router` 9.0.3 derives an
   empty container base from it and then skips real page transitions
   into the shell, and a mounted catch-all view gets repurposed for any
   sibling route (C6, closed 2026-09-15 — `App.tsx`'s `TabbedShell` doc
   has the code paths). Keep the shell at `/tabs/*` with relative
   children. More generally: `location.pathname` being right is not
   proof the screen is right — read the outlet's view stack (technique
   under NEWEST above).
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

**C7 first** — it makes the mobile app genuinely unusable for a real
shift, ahead of anything in `REMAINING.md`'s own numbered order.

1. ~~**C6**~~ **Done 2026-09-15** — see NEWEST above and `REMAINING.md`
   C6.
2. **C7** — give this its own session; reproduce deliberately with
   `adb logcat -b crash` / `dumpsys activity` running. The Galaxy A21s
   (wireless adb, `SM-A217F`, Android 12) is a second device to
   reproduce on alongside the Infinix — if it does NOT die there, the
   OEM-policy theory in C7's entry gains weight.
3. **Confirm G1's real-SMS leg** — configure a backup contact, kill
   connectivity, verify the on-device SMS actually arrives.
4. **Apply migration 0021 to the real databases, then write TWO real
   `ai_evaluation_run` rows** — both need an explicit go-ahead since they
   write to the real `baranguard`/`baranguard_uiseed` databases:
   - redaction, from A2's 2026-09-14 results: dataset
     `redaction-eval-v1`/`v1` (the historical file, kept for exactly this
     reason), model `aisingapore/Llama-SEA-LION-v3.5-8B-R`, sample_count
     200, precision_score 0.75880, recall_score 0.98260.
   - Nothing to write yet for the other 7 tasks — A6's rebuild produced
     the harness and datasets, not a real model run against them (needs
     a friend's hardware, next).
5. **Hand the rebuilt `eval-kit/` to a friend again, for the other 7
   tasks** (A6, closed 2026-09-14) — redaction already has real numbers;
   summary/translation/extraction/blotter-assist/classification/
   sms-compose/threat-analysis don't. `README-FOR-FRIEND.md` has the
   7 commands. Expect this to take considerably longer than A2's own run
   (8 tasks, not 1) — see `REMAINING.md` A6 for the researched
   provisional targets to check results against.
6. Then the Bikol human spot-check A3 has recommended since 2026-09-07
   (redaction) — and now also the human-rated translation/summary
   quality samples A6 calls for.
7. **The 6 remaining `mobile/` npm advisories** — down from 9: the
   Cypress 13→16 bump closed 3 (both HIGHs). The rest are the two
   already-deliberate major-version bumps (`react-router`, `@capacitor/
   cli`/`xcode`); see `REMAINING.md`'s C4 section.
8. Then **Sprint 8** proper — pick exactly one box from `SPRINTS.md`,
   now informed by A2's real numbers for its AI-evaluation box.
9. ~~Apply migration 0020 to the real databases~~ **Done 2026-09-13** —
   applied to both `baranguard` and `baranguard_uiseed`.
10. ~~Cypress 13→16 npm-audit bump~~ **Done 2026-09-13** — see `REMAINING.md`
    C4 and `backend/DEVLOG.md` for the writeup, including the correction
    that `cypress/e2e/test.cy.ts` was never a real spec (unmodified Vite
    scaffold) — a real e2e test is still open, separate work.
11. ~~Hand `eval-kit/` to a friend with capable hardware for A2~~ **Done,
    results back 2026-09-14** — see item 4 above and `REMAINING.md` A2.
12. ~~7 of the model's 8 tasks had no evaluation harness (A6)~~ **Done
    2026-09-14** — see item 5 above and `REMAINING.md` A6.

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
