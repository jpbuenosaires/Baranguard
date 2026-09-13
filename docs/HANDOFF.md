# Baranguard — Session Handoff

**This file is a replaced-in-place snapshot, not a log.** Rewrite the
sections below fresh each time something changes the picture — never
stack a new dated banner on an old one. Full session-by-session history
lives in `backend/DEVLOG.md` (grep it; don't read it front to back).

**Last updated: 2026-09-13.**

## Where things stand

**Sprints 0–7 are complete.** Sprint 8 (UAT/evaluation) is open but
**still gated** by `docs/REMAINING.md` §F — do not open a Sprint 8 box
while F1 or F4 are unresolved (F2/F3/F5/F6/F8 closed 2026-09-12 — see
below). None of the work below is a Sprint 8 box either — it's
`REMAINING.md` A1 (device verification) and a live bug report, both
ahead of Sprint 8 in the suggested order.

**2026-09-13: the app was built and installed on a real physical device
(Infinix X6840, connected via USB) for the first time from this
workstation's CLI, and a real bug the user hit using it was found and
fixed same session.** Pipeline: `npx vite build` → `npx cap sync android`
→ `gradlew assembleDebug` (needs `JAVA_HOME` explicitly overridden to the
JDK 21 install — see the new "bites you" item below, a genuinely new
gotcha) → `adb install -r`. Confirmed real-device, crash-free: login,
duty-status toggle, the Assignments list against a real seeded dispatch,
Assignment Detail's workflow stepper, and M7's rendered basemap
(`LiveMapCanvas.tsx`, built 2026-09-12) actually rendering on-device —
online-OSM-fallback path only, since no offline MBTiles package has ever
been published for barangay 1 on the `baranguard_uiseed` database this
build talks to (`backend/.env` is still pointed at the demo DB, not
`baranguard` — standing warning #4 below, reconfirmed). SQLCipher,
offline-capture-survives-kill, and photo/voice capture remain
device-unverified — this session only exercised Home/Assignments/Live
Map. Full detail: `backend/DEVLOG.md` 2026-09-13, `REMAINING.md` A1.

**The bug: Assignment Detail's "Navigate" left the app for Google Maps.**
Reported directly by the user right after installing the build — tapping
Navigate fired a `geo:` intent, which Android hands off to whichever maps
app is installed. Fixed by embedding `LiveMapCanvas.tsx` (the same
component M7 Live Map uses) directly in that screen, showing the Tanod's
own position and the assignment's destination on Baranguard's OWN map.
"Navigate" is now "Center Map" (recenters the embedded map via a new
`focusTarget` prop + `forwardRef`/`recenter()` on `LiveMapCanvas`); the
old external hand-off survives as an explicit, opt-in "Open in external
navigation app" link rather than being removed — a Tanod who genuinely
wants road-snapped turn-by-turn can still get it, it's just no longer the
surprise default. Verified on the real device: opened the real THEFT
dispatch (#12), confirmed both a self marker and destination marker
render, tapped "Center Map" and watched it correctly `fitBounds` across
both — made more convincing than a same-location happy path since this
device's real GPS fix is genuinely ~100km from barangay 1's seeded test
coordinates. No crash (`logcat` checked, not assumed). Full detail:
`backend/DEVLOG.md` 2026-09-13.

**M7 Live Map now has a real rendered basemap (`REMAINING.md` C4, closed
2026-09-12, real-device-confirmed 2026-09-13 above).** The screen used to
be an honest status-list-only view
because rendering a basemap was believed to need a native Capacitor map
plugin. That framing was wrong: `mobile/` is a real Vite-bundled app, so
MapLibre GL JS installs as a normal npm dependency and runs inside the
existing WebView — no native plugin, no AndroidManifest change. Two
architecture calls were confirmed with the user first (pure-JS-in-WebView
over a native plugin; **offline MBTiles-first with online OSM fallback**,
not the online-only path `web/`'s own LiveMap took, because the field app
is specifically where offline matters per §1). New files:
`mobile/src/services/mbtilesReader.ts` (sql.js/WASM MBTiles tile reader),
`mobile/src/services/mapPackageService.ts` (download/SHA-256-verify/
store), `mobile/src/components/LiveMapCanvas.tsx` (the MapLibre render).
**One deliberate deviation, logged in that file's own header comment:**
package-activation metadata is tracked via `@capacitor/preferences`, not
the pre-declared `offline_map_package_local` SQLite table — that table
lives in the Android-only encrypted local DB, and using it would have
made this whole feature untestable outside a physical device. Verified by
a real browser render (seeded a fake session into `localStorage`, hit
`/map`, got an actual OpenStreetMap basemap centered correctly on
Pilar/Dao/Binanuahan/Marifosque with no crash and a graceful, correctly-
labeled fallback when the test backend was unreachable) plus a clean
`tsc`/`vite build`. **2026-09-13 update:** the online-fallback path is now
ALSO confirmed on a real device (see above) — but the offline-MBTiles
path itself (download → verify → local tile read) is still unverified:
no package has ever been published for barangay 1 on the database this
device talks to (`SELECT * FROM offline_map_package` returns zero rows),
so every real-device render so far has exercised the fallback, not the
sql.js/MBTiles-protocol path. That specific path needs someone to
actually `POST /map-packages` a real `.mbtiles` file before it can be
called device-verified. Full detail and the exact verification steps:
`backend/DEVLOG.md` 2026-09-12 (5) and 2026-09-13.

**§F's audit remediation: F2/F3/F5/F6/F8 fixed and proven earlier
2026-09-12 (DEVLOG's (4) entry — a separate session from the M7 basemap
work above). F1 and F4 remain — both are decisions, not code.**

- **F2/F3 (the XSS sweep) — CLOSED.** All eleven `innerHTML`
  interpolation sites from `docs/AUDIT_2026-09-07.md` are now escaped via
  the existing shared `web/src/utils/escapeHtml.js`. One site
  (`blotter-list.js`) no longer exists — closed by W6's 2026-09-10
  removal, not by fix. `verify-web-wiring.mjs` 536/536, no regressions.
- **F5 (`PATCH /incidents/:id` idempotency) — CLOSED.** Was validated but
  never stored/replayed; now replays off `audit_log` (same shape
  `SmsController::broadcast()` already uses — there's no natural unique
  column an UPDATE can dedupe on the way a CREATE dedupes on
  `client_event_id`). Proven by a new script,
  `verify-f5-incident-update-idempotency.sh` (16/16) — this endpoint had
  never been called over HTTP by any existing suite, so nothing else
  exercised it.
- **F6 (`is_suspended` not checked on authenticated requests) — CLOSED.**
  `AuthMiddleware::authenticate()` now checks it exactly like `is_active`.
  Proven by a new script, `verify-f6-suspended-request-rejected.sh`
  (8/8), which suspends a user via direct SQL (session deliberately left
  un-revoked) to isolate this check from session-revocation covering for
  it.
- **F8 (`avg_response_time_minutes` double-counts multi-dispatch
  incidents) — CLOSED.** All three call sites (`summary()`'s scalar,
  `response_time_trend[]`, and the export path) now join against a
  per-incident `MIN(arrived_at)` subquery instead of the raw `dispatch`
  table. Proven two ways: an isolated SQL demonstration (old query gives
  17.5 on a 2-dispatch fixture, new gives the correct 10.0) and a new
  HTTP-level script, `verify-f8-response-time-dedup.sh` (8/8).
- **F1 still open** — the real `BARANGUARD_API_BASE_URL` for a genuine
  deployment has never been decided, only ever pointed at disposable
  preview/local values. This is a decision for the user, not something a
  coding session can settle on its own.
- **F4 still open** — evidence attachment upload is unbuilt end-to-end
  server-side (no route, no `INSERT`, no sync channel). Needs an explicit
  scope call: build it, or formally descope and correct §11's retention
  table, which currently governs a table nothing can ever populate.

**Not done in that 2026-09-12 §F session, logged rather than silently
skipped:** B2 (pen-test dispatch/shifts/citizen-reports/SMS/map-packages
— Incidents' own 68-check pass is the template) and B4
(`verify-sprint3.sh`, which has never existed) are each their own
substantial new-suite-writing session and were left for one, rather than
rushed. Three new verify scripts from that session (`verify-f5-*`,
`verify-f6-*`, `verify-f8-*`) join the existing eighteen — none of the
counts in `REFERENCE.md` §9 changed, since those three are new files, not
adjustments to existing suites.

**Housekeeping (§E):** the stray `baranguard_device_check` DB no longer
exists (already dropped by an earlier session). The eight untracked
design-doc files that had been sitting at the repo root
(`Baranguard_System_Design_Document.docx`/`.pdf`, four `diagram_*.png`,
`scratch_diagrams.py`) are real deliverables, not scratch — moved into
`docs/design/` and committed. `mobile/android/`'s "commit or not"
decision is deliberately still open — see §E's own note in
`REMAINING.md` for why that one wasn't just acted on.

**⚠️ There is a SEPARATE body of uncommitted mobile UI work in this
working tree that remains UNREVIEWED** — `App.tsx`, several pages,
`vite.config.ts`, theme CSS, and four new files
(`components/MobileHeader.tsx`, `components/SyncQueueModal.tsx`,
`pages/profile.tsx`, `utils/`) were already sitting modified/untracked
before the M7 basemap session above touched anything, and this session
did not review or commit them either. `pages/profile.tsx` in particular
is notable: `REFERENCE.md` §7 and `App.tsx`'s own routing currently say
M10 Profile is **not built yet** (`NotBuiltYetPage`) — if this file
actually implements it, that is real, unlogged scope that needs the same
file-by-file review the six-sessions' backlog got in the 2026-09-12 (1)
DEVLOG entry, before anyone trusts or commits it.

**Nuance the M7 basemap session (2026-09-12) and the Navigate-fix session
(2026-09-13) both add:** four of the pre-existing-modified files —
`mobile/src/pages/live-map.tsx`, `login.tsx`, `services/apiService.ts`,
and (as of 2026-09-13) `pages/assignment-detail.tsx` — now carry BOTH
bodies of change layered together in the same file (the pre-existing
unreviewed edits, plus reviewed/tested work from these two sessions: the
new imports, `ensureMapPackageDownloaded()`/`downloadMapPackage()`
wiring, and assignment-detail's embedded-map/`geo:`-removal changes). A
future review pass can no longer treat "trust or discard" as a per-file
decision for these four — it has to be a per-hunk read. `git log -p`
against origin isn't available here (nothing from either body of work is
committed yet), so the practical way to separate them is to diff against
what `backend/DEVLOG.md` 2026-09-12 (5) and 2026-09-13 actually describe
changing in each file. Everything else these two sessions touched
(`mapPackageService.ts`, `mbtilesReader.ts`, `LiveMapCanvas.tsx`,
`types/sql-wasm.d.ts`, `theme/app.css`'s `.map-marker*` block,
`db/localSchema.ts`'s added comment, `package.json`/`package-lock.json`)
is new-file-or-small-and-attributable, not mixed with the other pile.

Do not sweep either body in with a broad `git add` — stage by path, the
same discipline the 2026-09-12 (4) session already used for this reason.

**The §G feature backlog is worked to completion** (unchanged this
session). All 14 candidates resolved: 7 built, 4 found already shipped,
3 deliberately not built with reasons. Detail: `backend/DEVLOG.md`
2026-09-12 (3), statuses in `REMAINING.md` §G.

**⚠️ Nine verify suites were dead, not green, until 2026-09-12** —
unchanged this session, still the most important piece of *prior*
context if you haven't read it yet. All nine now apply the full
0001-0018 chain and every §9 count was re-measured. Detail:
`backend/DEVLOG.md` 2026-09-12 and 2026-09-12 (3), `REFERENCE.md` §9's
warning box.

**The A1-A7 logic-gap backlog is swept; G1 (SOS third fallback tier) is
the one item still open**, blocked on a native SMS plugin + device and
an unmade decision about where the backup contact number lives.
Unchanged this session. Detail: `backend/DEVLOG.md` 2026-09-12 (2).

**Migrations 0016, 0017, 0018 are applied to both the real `baranguard`
DB and the demo `baranguard_uiseed` DB.** Unchanged this session.

**AI Classifier auto-checks itself; a real layout bug in
`incident-management.css` was found and fixed; a demo-DB migration gap
was found and fixed.** All unchanged this session — full detail in the
2026-09-12 (1) DEVLOG entry if you need it.

**`eval-kit/` still needs capable hardware.** Unchanged: no
`generate()` has ever completed on this workstation.

## Things most likely to bite you

1. **Every static check in this project can be green on code with a P0
   defect.** `node --input-type=module --check`, `verify-web-wiring.mjs`,
   `php -l` all parse-and-resolve; none of them caught the eleven XSS
   sites this session fixed, or would have caught F5/F6/F8 either — all
   three needed a real HTTP call against a real database to prove, which
   is why each got its own new verify script rather than a claim.
2. **A verify script proves nothing about an endpoint it never calls.**
   F5 and F6 were both provably broken for a long time specifically
   *because* no existing suite exercised the code path — `grep` for the
   route across every `*.sh` before trusting a suite's green result to
   mean "this endpoint works," not just "the suites that happen to touch
   it pass."
3. **Finished work sitting uncommitted is a standing risk, not a
   curiosity** — see the mobile UI work flagged above. Review it
   file-by-file before committing it, the same way the six-sessions'
   backlog was reviewed on 2026-09-12, rather than either ignoring it
   indefinitely or sweeping it in blind.
4. **`backend/.env` may still be pointed at `baranguard_uiseed`, not
   `baranguard`**, from earlier browser-verification sessions, and it is
   NOT tracked by git so nothing will remind you. `DB_NAME=baranguard
   php backend/scripts/...` overrides it for one command; check the file
   itself before trusting any CLI run against "the real database."
5. **Gradle's daemon JVM is decided by `JAVA_HOME`, not by whatever
   `java` resolves to on PATH** — and this workstation's `JAVA_HOME` is
   set to JDK 17 system-wide, unrelated to this project.
   `./gradlew assembleDebug` fails with `invalid source release: 21`
   under that JVM (the Capacitor plugins set `sourceCompatibility
   VERSION_21` directly, not via a toolchain request, so
   `gradle.properties`' toolchain-candidate list doesn't rescue it).
   Always `export JAVA_HOME=".../jdk-21.0.12.101-hotspot"` (and
   `./gradlew --stop` first, to kill any daemon already started under the
   wrong JVM) before building the Android app from a shell. `./gradlew`
   itself (no extension) runs fine from Git Bash — the documented
   `.bat`/`.ps1` sandboxing issue doesn't apply to it.

## Recommended next step

**F1 is now the most valuable open item.** Every other §F code defect is
closed; F1 is purely a decision (the real `BARANGUARD_API_BASE_URL`) and
F4 purely a scope call (build evidence upload, or descope it and correct
§11). Neither needs more investigation — both need the user to decide.

1. **Settle F1** (the real deployment API base URL) and **F4** (build
   evidence upload, or formally descope it). Nothing can be called
   "verified against production" until F1 is settled.
2. **Review and decide on the parallel mobile UI work** flagged above
   (`MobileHeader.tsx`, `SyncQueueModal.tsx`, `pages/profile.tsx`,
   `utils/`, and the modified files around them) before it becomes a
   sixth "six sessions of uncommitted work" story — and read
   `live-map.tsx`/`login.tsx`/`apiService.ts`/`assignment-detail.tsx`
   hunk-by-hunk rather than file-by-file, since the M7 basemap and
   Navigate-fix work above is layered into those same four files (see
   that section's own nuance note).
3. **B1** — browser-verify the screens nobody has opened yet (Dispatch
   Center, GIS Live Tracking, Analytics > Heatmap, the Dashboard
   tooltips/attention banner, Citizen Reports' Convert-to-Incident
   dialog). See `REMAINING.md` B1.
4. **B2, B4** — pen-test the non-incident resource types, and write the
   Sprint-3-endpoint verify script that has never existed.
5. **Hand `eval-kit/` to a friend with capable hardware** for A2.
6. Then **Sprint 8** proper — pick exactly one box from `SPRINTS.md`.

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

# This session's new verify scripts
bash backend/scripts/verify-f5-incident-update-idempotency.sh
bash backend/scripts/verify-f6-suspended-request-rejected.sh
bash backend/scripts/verify-f8-response-time-dedup.sh

# Build + install the mobile app onto a connected Android device
# (proven working 2026-09-13 — see that DEVLOG entry and REMAINING.md A1
# for why each of these exact steps/env-vars is needed)
cd mobile && npx vite build && npx cap sync android
cd android
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
export TMPDIR=C:/gtmp TEMP=C:/gtmp TMP=C:/gtmp
export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=C:/gtmp"
./gradlew --stop && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p ph.baranguard.tanod -c android.intent.category.LAUNCHER 1
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
