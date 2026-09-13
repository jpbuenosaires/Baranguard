# Baranguard — Everything left before Sprint 8

Sprints 0–7 are complete. This is the honest list of what still stands
between here and a UAT sign-off, ordered by what blocks what.

**Legend:** 🔴 blocks Sprint 8 · 🟠 needed for a credible UAT ·
🟢 polish / nice-to-have

**2026-09-07:** a full bug / logic / business-rule audit added section
**F** below. F comes first — it is the only section containing defects
in *shipped, believed-correct* behaviour rather than unfinished work.
Evidence for every item is in `docs/AUDIT_2026-09-07.md`.

**2026-09-10:** the DILG BIMSS session closed **F7** and **F9's first
bullet** by removing `POST /blotter`, and fixed two defects that were not
on any list:

- **`IncidentsController::updateStatus()` did not exist**, though
  `routes/incidents.php:19` routed to it and the web client called it
  twice — a live 500, and the reason `blotter_record.case_status` was
  never set to `resolved`. Written and now covered by `verify-sprint6.sh`.
- **Every verify suite that logs in had been broken since 2026-09-05**
  (migration 0011's `user.is_suspended` vs. each suite's partial
  migration subset). All four exited at setup without reaching an
  assertion while §9 listed them green. Fixed; see `REFERENCE.md` §9's
  warning box.

**2026-09-12:** F2/F3 (the XSS sweep), F5 (`PATCH /incidents/:id`
idempotency), F6 (`is_suspended` not checked on authenticated requests),
and F8 (`avg_response_time_minutes` double-count) were all fixed and
proven — F5/F6/F8 each with a new purpose-built verify script, since none
of the three endpoints had ever been exercised by an existing suite. See
`backend/DEVLOG.md` 2026-09-12 (4).

**F1 and F4 remain open and still gate Sprint 8 — both are decisions,
not code.**

---

## F. Audit remediation (2026-09-07) — gates Sprint 8

### 🔴 F1. The API base URL is still an undecided placeholder, not a real deployment value
`web/index.html:142` in committed `HEAD` points at `http://127.0.0.1:8140/api/v1`
(disposable `baranguard_uiseed` preview DB) on a system §1 defines as
LAN-only, no cloud. `backend/.env` sets no `CORS_ALLOWED_ORIGIN`, so the
API answers `*`. **The 2026-09-07 public Cloudflare tunnel value that
used to sit here uncommitted is gone** — a 2026-09-12 session pointed the
working tree at `http://localhost:8081/api/v1` instead, purely to
browser-verify that session's own changes, and deliberately left it
uncommitted rather than pushing a different guess. **The actual decision
— what `BARANGUARD_API_BASE_URL` should be in a real deployment — has
still never been made.** Whichever value is chosen, remember the
second-order effect: a tunnel (or anything else that puts every client
behind one shared address) **defeats the citizen-report rate limit** —
`CitizenReportsController::submit()` throttles on `REMOTE_ADDR`, so all
citizens would share one bucket and one spammer locks out the barangay.

**Decide the intended value and commit it.** Nothing else in this file
can be verified honestly until this is settled — a browser pass against
preview data proves nothing about production.

### ✅ F2. Stored XSS reaches the Secretary session from an anonymous attacker — CLOSED 2026-09-12
`POST /citizen-reports` is unauthenticated and stores `description`
(≤2000 chars) verbatim → convert copies it to `incident.raw_narrative` →
`web/src/pages/blotter-detail.js:135` renders it unescaped inside
`modal.innerHTML` → the token is in `sessionStorage`. The Secretary is
the only role that can read every `raw_narrative` in the barangay, so
this is a §2 Rule 1 exfiltration path with no authentication in front of
it. `contact_number` (≤32 chars — enough) does the same at
`citizen-reports-inbox.js:421` and needs no conversion step.

**Fixed 2026-09-12:** both interpolation sites now go through the shared
`web/src/utils/escapeHtml.js`. See F3's own closure note for the full
site list and DEVLOG detail.

### ✅ F3. ~40 further unescaped `innerHTML` interpolations — CLOSED 2026-09-12
Across 12 page modules. Only `admin-dashboard.js`, `dispatch-center.js`
and `gis-live-tracking.js` define an `escapeHtml` helper, and none of
the three applies it at every site. The ones taking non-Admin input:
`blotter-detail.js:472,487,517,555` · `blotter-list.js:535` ·
`incident-management.js:1268` (including into `href="tel:${...}"`) ·
`sms-monitor.js:697,1745` · `map-packages.js:300`. Full table in the
audit. The fix is one shared helper, not 45 individual judgement calls.

### 🔴 F4. Evidence attachment upload does not exist server-side
Not "device-unverified" — **unbuilt**. No `POST /incidents/:id/evidence`
route, no `INSERT INTO evidence_attachment` anywhere in `backend/`, and
`/sync/batch` has no evidence channel (it accepts `incidents`,
`gps_tracks`, `duty_status_updates`, `dispatch_status_updates`, `sos`).
Mobile writes to a local `evidence_attachment_local` table that nothing
ever ships.

Consequences: `GET /incidents/:id/evidence` is permanently empty in
production, and `RetentionService`'s evidence purge,
`evidence_attachment.legal_hold` and §11's evidence retention window all
govern a table that cannot be populated. This is a scope decision, not a
bug fix — build the endpoint plus the sync channel, or write down that
evidence is out of scope and correct §11.

*(This supersedes C4's "evidence files can't be downloaded from W7" and
A1's framing of photo/voice capture as merely device-unverified.)*

### ✅ F5. `PATCH /incidents/:id` idempotency is theatre — CLOSED 2026-09-12
The endpoint requires and UUID-validates `Idempotency-Key`, then never
stores or replays it. §2 Rule 3: "a retry must return the original row."
Every sibling write does this for real. A double-submit currently writes
a duplicate `incident_updated` audit row.

**Fixed:** replays off `audit_log` (`action='incident_updated'`,
`entity_id`, an `idempotency_key` field added to the existing
`metadata_json`) — the same shape `SmsController::broadcast()` already
uses, since an UPDATE has no natural unique column to dedupe on the way
a CREATE dedupes on `client_event_id`. This endpoint had never been
called over HTTP by any existing verify suite, so proof needed a new
script: `backend/scripts/verify-f5-incident-update-idempotency.sh`
(16/16), which confirms a retry with the same key writes exactly one
audit row and does not re-apply the write.

### ✅ F6. `is_suspended` is not checked on authenticated requests — CLOSED 2026-09-12
`AuthMiddleware::authenticate()` rejects on `is_active` as documented
defense-in-depth but has no equivalent line for migration 0011's
independent `is_suspended` axis. Unreachable today (login checks it, and
the suspend endpoint revokes sessions transactionally), so this is an
asymmetry to close, not a live hole — but it is an omission, not a
decision.

**Fixed:** mirrors the `is_active` check exactly. Also had zero suite
coverage outside `AuthController::login()`; proven by a new script,
`backend/scripts/verify-f6-suspended-request-rejected.sh` (8/8), which
suspends a user via direct SQL (leaving the session row un-revoked on
purpose) to isolate this check from session-revocation covering for it.

### ✅ F7. Walk-in blotter shows unredacted intake text to Admin and PB — CLOSED BY REMOVAL (2026-09-10)
`POST /blotter` no longer exists. It was removed because DILG BIMSS's
KPIS module already *is* the mandated Katarungang Pambarangay case
database and Baranguard must complement BIMSS rather than duplicate it
(§1) — the PII carve-out this item asked for became moot rather than
being written. `raw_narrative` now reaches a non-Secretary through no
path at all.

### ✅ F8. `avg_response_time_minutes` double-counts multi-dispatch incidents — CLOSED 2026-09-12
`AVG(TIMESTAMPDIFF(...))` over `incident JOIN dispatch` with no de-dup,
in both `ReportsController::summary()` and the export path. An incident
with two arrived dispatches is weighted twice; §6 defines the metric per
incident. **Settle this before picking Sprint 8's response-time box** —
otherwise that box reports a wrong number as a measured one.

**Fixed:** all three call sites (`summary()`'s scalar,
`response_time_trend[]`, and the export path's
`averageResponseTimeMinutes()`) now join against `(SELECT incident_id,
MIN(arrived_at) AS first_arrived_at FROM dispatch WHERE arrived_at IS
NOT NULL GROUP BY incident_id)` — one row per incident, first arrival
defines "the" response time. Proven at two levels: an isolated SQL
demonstration (old query gives 17.5 on a 2-dispatch fixture, new gives
10.0) and a new HTTP-level script,
`backend/scripts/verify-f8-response-time-dedup.sh` (8/8), which seeds
exactly that scenario and asserts the real endpoint reports the
de-duplicated figure. Sprint 8's response-time box can now proceed —
this was the blocker its own menu entry named.

### 🟢 F9. Smaller, contained
- ~~`POST /blotter` can answer `200 []`~~ **✅ closed by removal
  2026-09-10** — the endpoint is gone (see F7).
- ~~Enter double-toggles the GIS Live Activity collapse panel~~ **✅ not
  reproducible (2026-09-10).** Read while extracting `AiToolPanel`: the
  header's bubble-phase `keydown` handler calls `preventDefault()`, which
  cancels the inner button's native Enter/Space activation before it
  dispatches `click`, so only one toggle runs. The entry was theoretical.
  The nesting (a `<button>` inside a `role="button"` header with its own
  keydown handler) is still fragile; `AiToolPanel` deliberately uses the
  simpler structure — the toggle button is the only interactive element —
  and the GIS panel could be brought in line when next touched.
- `SmsController::broadcast()` resolves idempotency with
  `JSON_EXTRACT` over unindexed `audit_log` — a growing full scan, and
  it makes an append-only record load-bearing for write correctness.

---

## A. Blocked on hardware or accounts you have to provide

Nothing in this group can be finished by a coding session alone. These
are the long poles — start them first, because everything downstream
waits on them.

### 🟠 A1. Android device/emulator run — PARTIALLY UNBLOCKED 2026-09-12, further 2026-09-13
**A real physical device now runs the app and reaches the real backend —
the "does it run at all" half of this blocker is cleared.** The six
verifications below are still open; a device that boots the app is not
the same as those being tested.

**2026-09-13: the app was actually BUILT and INSTALLED on the device
(not just reasoned about) for the first time, from this workstation's own
CLI.** `npx vite build` → `npx cap sync android` → `gradlew assembleDebug`
→ `adb install -r`. One new environment gotcha found and fixed, logged
below alongside 2026-09-12's; two real-device passes recorded under the
six-item list.

**What actually blocked a real device, found and fixed 2026-09-12 (none
of this was previously documented — logged here so the next machine that
hits it doesn't re-discover it from scratch):**
- **Windows Firewall silently drops inbound connections** to the PHP dev
  server's port unless a rule explicitly allows it — a phone gets
  "cannot reach the workstation" with no other symptom. Fix: `New-NetFirewallRule`
  for the backend's port, run by the user (firewall rules are a system
  security setting, not something a coding session does on someone's
  behalf).
- **Android blocks cleartext (plain HTTP) traffic by default** (API 28+)
  at the OS level — needs `network_security_config.xml`
  (`cleartextTrafficPermitted="true"`) referenced from
  `AndroidManifest.xml`. This project is LAN-only with no TLS
  infrastructure (§1), so this is the correct fix, not a workaround —
  revisit if F1's deployment decision ever introduces a stable hostname
  or LAN TLS.
- **A SEPARATE mixed-content block, even with cleartext permitted above.**
  Capacitor's default local-page origin is `https://localhost`; fetching
  a plain `http://` backend from that `https://` origin is blocked by the
  WebView engine's own mixed-content policy, independent of the Android
  OS-level policy above. Symptom: `TypeError: Failed to fetch` with no
  further detail (Chromium deliberately doesn't expose the reason to JS).
  Fix: `server.androidScheme: 'http'` in `capacitor.config.ts`, so the
  app's own origin matches the backend's scheme.
- **`ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` were never declared
  in `AndroidManifest.xml`** — `@capacitor/geolocation` was a registered
  plugin (per the 2026-09-05 fix below) but the permission itself was
  missing, so `Geolocation.getCurrentPosition()` failed immediately.
  This silently broke SOS (`home.tsx` refuses to transmit without a GPS
  fix), the Live Map, and "Use Current Location" on Log Incident — all
  three failed with no error a user would recognize as a permissions
  problem. Fixed by declaring both permissions.
- The Vite dev server needs `server.host: true` to listen on the LAN
  interface at all, and `.env.local`'s `VITE_API_BASE_URL` must be the
  workstation's actual LAN IP, not `localhost` — `localhost` inside the
  app means the phone itself, not the PC, with no error distinguishing
  the two failure modes.

**Debugging technique worth keeping:** the app's own error handling
deliberately swallows the raw fetch failure (`apiService.ts`'s
`catch {}` — by design, so a Tanod never sees a raw stack trace). When
the generic "cannot reach the workstation" message isn't enough to
diagnose *which* of the above is the cause, pull the real error via
`adb logcat -d | grep -i capacitor` after a temporary `console.error` in
that catch block — this surfaced the mixed-content error above in
seconds where blind guessing had already ruled out firewall/CORS/DNS one
at a time.

**Original blocker, now moot:** JDK 21 (Temurin) + an API 36 emulator
were "part-installed" — superseded by testing on a real physical device
over USB instead, which sidesteps the emulator setup entirely. Android
Studio itself (not the SDK) was slow to open on this workstation, but
`npx cap run android` / manual `gradlew` invocation both hit unrelated
sandboxing issues in-session (`.bat`/`.ps1` script execution blocked);
building through Android Studio's own UI worked without issue.

**2026-09-13 correction: `./gradlew` (the Unix wrapper script, no
extension) runs fine from Git Bash — the `.bat`/`.ps1` sandboxing above
doesn't apply to it.** What actually broke a plain `./gradlew
assembleDebug` this session was unrelated to sandboxing: the shell's
`JAVA_HOME` was independently set to JDK 17 (a system-wide env var), and
**Gradle's daemon uses `JAVA_HOME` over whatever `java` resolves to on
PATH** — even though `java -version` on PATH already resolved to Temurin
21. Since the Capacitor plugin modules set `sourceCompatibility
JavaVersion.VERSION_21` directly (not via a toolchain request),
`gradle.properties`' `org.gradle.java.installations.paths` (which lists
JDK 21 as a toolchain candidate) never came into play — the daemon simply
compiled with JDK 17's `javac`, which cannot target a release higher than
itself: `invalid source release: 21`. Fix: `./gradlew --stop` (kill the
wrong-JVM daemon) then re-run with `JAVA_HOME` explicitly overridden to
the JDK 21 path for the gradlew invocation. `C:/gtmp` as
`TMPDIR`/`TEMP`/`TMP`/`-Djava.io.tmpdir` (2026-09-03's fix) was still
required and still worked.

Once the six items below are ACTUALLY exercised on the now-working
device (not just "the app boots"), this clears:
- SQLCipher actually encrypts the DB file (pull it off the device and
  confirm it isn't readable plaintext SQLite)
- Offline capture survives app kill
- Photo/voice capture produces a real playable file
- Keystore passphrase round-trip + the legacy-migration path
- M5/M6/M7 (Sprint 3) and M12/M13 (Sprint 4) on a real screen —
  **M6/M7 now have a real PASS, 2026-09-13**: login (`tanod.reyes` /
  `Demo@2026`, per `backend/fixtures/uiseed-dao-demo.sql`'s own header),
  Home's duty-status toggle, the Assignments list showing a real seeded
  dispatch (#12, THEFT, ARRIVED), Assignment Detail's 4-stage workflow
  stepper, and — the actual point of this session — M7's rendered
  basemap (`LiveMapCanvas.tsx`) genuinely renders on-device with a real
  self GPS marker and a real destination marker, both via the
  **online-OSM-fallback path only** (no offline package has ever been
  published for barangay 1 on `baranguard_uiseed` — `SELECT * FROM
  offline_map_package` returns zero rows — so the sql.js/MBTiles-protocol
  path itself is STILL not device-verified). Zero crashes across two
  install/relaunch cycles (`logcat` grepped for `FATAL|AndroidRuntime|
  Uncaught`, empty both times). M5/M12/M13 and hold-SOS remain untested
  this session. SQLCipher, offline-capture-survives-kill, and photo/voice
  capture (this list's other three items) are also still untouched.
- **A real bug this device pass caught, fixed same session**: Assignment
  Detail's "Navigate" fired a `geo:` intent that left the app for Google
  Maps — reported by the user directly after using the build. Fixed by
  embedding `LiveMapCanvas.tsx` in that screen instead (self + destination
  on Baranguard's own map); "Navigate" is now "Center Map" and recenters
  the embedded map instead of leaving the app, with the old external hand-off
  kept as an explicit, secondary "Open in external navigation app" link
  rather than removed outright. Full detail: `backend/DEVLOG.md`
  2026-09-13.
- `runSyncPass()` draining a queue after a forced offline→online cycle

**Also outstanding here:** nothing calls `runSyncPass()` yet — no timer,
no app-foreground hook. Wiring a trigger is a small code task that only
makes sense to verify on a device.

### 🔴 A2. Run the AI model end-to-end (blocks the AI evaluation box)
**Blocked on:** a machine that can run SEA-LION at usable speed. **This
workstation is confirmed NOT to be that machine** (see below) — the
"blocked on a machine" framing is now measured, not assumed.

**Updated 2026-09-07: Ollama is installed, running, and has the model
pulled on this workstation** (`ollama.exe`/`ollama app.exe` listening on
`127.0.0.1:11434`; `aisingapore/Llama-SEA-LION-v3.5-8B-R:latest`, 4.9GB
Q4_K_M, confirmed present via a real `/api/tags` response) — corrects the
older "dead Ollama port" framing below. **A real `generate()` call was
made for the first time in this project's history, while building
`eval-kit/`** (see DEVLOG's "Friend-runnable AI evaluation kit" entry).
It did **not** complete: `Operation timed out after 300001 milliseconds
with 0 bytes received` on a single record. `OllamaUnavailableException`
handling worked exactly as designed (clean message, no crash), so that
part of the pipeline is now proven, not just reasoned-about — but no
redaction has ever actually finished. This workstation's CPU is
apparently not fast enough to complete even one generation within the
300s default timeout, which is real evidence for why a more capable
machine matters here, not just an assumption.

**A concrete path now exists:** `eval-kit/` is a small (316K),
self-contained package — a friend with possibly-faster hardware runs it
via one `.bat` double-click, entirely locally (no DB, no project secrets
leave this workstation), and sends back a results file. It paces itself
(20-record batches, 2-minute rests) and checkpoints so a multi-hour run
survives being closed and resumed. **Committed and pushed 2026-09-12**
(`69c7bf3`) — it had actually existed uncommitted since 2026-09-07 and
only reached git this session; still nobody has run it on hardware that
can finish a generation.

Must still confirm, once a run actually completes somewhere:
- No `<think>` block survives into `draft_redacted_narrative`
  (`stripReasoning()` is reasoned-from-docs, never observed)
- Planted PII is actually removed
- **Kill Ollama mid-job → the row returns to `queued`, not `failed`**
  (the single most important untested behaviour in the pipeline — note
  this is about the real `ai-worker.php` queue path, a separate question
  from `eval-kit/`'s own dry-run evaluation harness)
- `model_version` records what really ran

Remember: `backend/.env` needs the `OLLAMA_*` keys added by hand on any
new machine (they're only in `.env.example`) — confirmed still true; this
workstation's own `backend/.env` state was not touched by this session's
`eval-kit/` work, which uses its own separate, minimal `.env`.

### ✅ A3. The 200-record evaluation dataset — DONE (generated, not hand-authored)
**Was blocked on:** ~3 people doing manual labelling per
`docs/AI_Evaluation_Dataset_Guide.md`. **Resolved differently, by explicit
user decision (2026-09-07):** the dataset is generated instead of
hand-authored — `backend/scripts/generate-eval-dataset.php` (template +
pool synthesis) produced `backend/fixtures/redaction-eval-v1.json`, 200
records, self-validated (every entity/must-keep string checked verbatim)
and sanity-checked against the baseline engine (see DEVLOG for the full
coverage breakdown and the two real generator bugs found and fixed along
the way).

**This is a real methodology deviation from the guide, disclosed in the
dataset's own `generation_method` field** — not independently authored by
three human labelers. Recommended before quoting results in the capstone:
a human spot-check pass, especially the ~60-record Bikol subset, where
the generating model's own fluency is weaker than Tagalog/English.

Baseline already established, now against the real 200 (not just the
10-record smoke fixture): the regex comparator scores **32.71% recall /
100% precision**, misses concentrated in NAME/ADDRESS — same shape as the
10-record fixture's 39.13%/100%, now with real sample size behind it —
the concrete argument for the model over a pattern list.

### 🟠 A4. Real FCM + Semaphore credentials
A Firebase project (`google-services.json` + `FCM_SERVICE_ACCOUNT_PATH`)
and a funded Semaphore account. Rule 12's fallback ladder is fully
verified *logically*, but **no Tanod's phone has ever actually buzzed.**

### 🟢 A5. GSM modem hardware
Only needed if you want the tethered-phone inbound path. The contract is
already proven — `scripts/sms-envelope-build.php` produces exactly what
the ingestion daemon would.

---

## B. Verification a coding session can do now

### 🔴 B1. Browser-verify the unverified screens
Two batches, both wired and wiring-checked but **never opened in a
browser**:
- **Round-2 UI (9 phases):** Dispatch queue fix, Blotter Entry two-column
  + timeline rail, avatar/bell topbar, KPI convention, Incident
  Management, rebuilt Electronic Blotter, Settings rail, SMS log
  filters/stats, Analytics charts. Checklist ready at
  `.claude/plans/clever-wishing-hummingbird.md`.
- **Sprint 7:** W17 Audit Log Viewer, W20 Service Health.

This is the largest pile of unverified-but-finished work in the project.

### 🟠 B2. Pen-test the other resource types
Incidents passed 68/68. Dispatch, shifts, citizen reports, SMS logs and
map packages have had **no equivalent pass**. Reuse
`verify-sprint7-pentest-incidents.sh`'s four-dimension structure (no
token / wrong role / cross-tenant / wrong owner) — it's designed to be
copied.

### 🟠 B3. Run the restore drill with your own passphrase
The drill is proven (12/12 against the real database) but this session
used a scratch backup dir deliberately, so **W20 still shows "Never"**:
```
BACKUP_ENCRYPTION_PASSPHRASE=your-passphrase bash backend/scripts/restore-drill.sh
```

### 🟠 B4. Verify Sprint 3's backend against real XAMPP
`POST /gps`, `PATCH /dispatch/:id/status`, `POST /sync/batch`,
`GET /incidents/nearby`, and the mobile `POST /incidents` branch were
coded in one sitting and **never got their own verify script**. They're
exercised incidentally by later suites, but there is no
`verify-sprint3.sh`. Interrupted-sync resume and duplicate-GPS handling
are specifically unproven.

### 🟢 B5. Roles other than Admin in a browser
Almost all browser verification has been done as Admin (plus one
Secretary pass on W7/W8). Punong Barangay and Secretary have never been
walked through the full nav.

---

## C. Real gaps in shipped behaviour

### ✅ C1. Backup file expiry (§11 / Rule 11) — DONE
`backup.sh` now computes the earliest `created_at`/`uploaded_at` among
rows currently under `legal_hold` (incident/citizen_report/
evidence_attachment) and refuses to prune any backup file timestamped
on/after that floor, regardless of age — and fails closed (prunes
nothing) if the hold check itself can't run. Verified against a
disposable DB + scratch backup dir; see `backend/DEVLOG.md`'s "backup
legal-hold expiry" entry.

### 🟠 C2. Nothing is scheduled
`retention-job.php` and `restore-drill.sh` are both CLI-only by design.
Neither runs on its own. Wiring them to Windows Task Scheduler (daily /
weekly) is a runbook step, and until it happens retention never actually
fires in production. **Deliberately still not done**: creating a
Windows Scheduled Task is a system-settings change outside what a
coding session can execute on the user's behalf — this needs a human at
the keyboard running the final `schtasks` command.

### ✅ C3. Mobile SOS button — DONE (code-complete, device-unverified)
`POST /tanod-sos` is now wired end-to-end: online-first via
`apiService.postSos()`, falling back to `offlineQueueRepository`'s new
`enqueueSosItem`/`listPendingSosItems` (draining through
`syncService.runSyncPass()` → `/sync/batch`'s `sos[]`, live since
Sprint 4 but previously always sent empty) when offline. `home.tsx`'s
button is a real `color="danger"` action behind an `IonAlert` confirm.
`npx tsc --noEmit` compiles clean; **not device-verified** — same A1
blocker as everything else mobile. Also still true: nothing calls
`runSyncPass()` automatically yet (see A1), so a queued-offline SOS
drains on whatever next sync trigger exists.

### 🟢 C4. Smaller known gaps
- `LineChart` has no data-gap concept — a null response-time day renders
  as 0 on Analytics.
- ~~Evidence files can't be downloaded from W7~~ **Understated —
  promoted to F4.** They can't be *uploaded* either; nothing in
  `backend/` ever writes `evidence_attachment`. Downloading was never
  the binding constraint.
- On-device SMS sending was never built, so M13 can only ever show
  `saved_locally_for_retry`. **Deferred** — needs a native SMS plugin
  and device verification (A1).
- M12 is a JS overlay, not a native full-screen-intent activity.
  **Deferred** — needs a native Android activity and device
  verification (A1).
- ✅ **M7 Live Map rendered basemap — DONE 2026-09-12.** The "needs a
  native, offline-tile-capable map renderer" framing below turned out to
  be avoidable: `mobile/` is a real Vite/npm-bundled app, so MapLibre GL
  JS installs as a normal dependency and runs inside the existing
  Capacitor WebView — no native plugin, no AndroidManifest change. Two
  architecture decisions were confirmed with the user first (CLAUDE.md
  requires this): pure-JS-in-WebView over a native plugin, and
  **offline MBTiles-first with online OSM fallback** (not the
  online-only path `web/`'s own LiveMap took) — chosen because the field
  app is specifically where offline matters (§1). `mbtilesReader.ts`
  reads the downloaded package via `sql.js` (WASM SQLite);
  `mapPackageService.ts` downloads/SHA-256-verifies/stores it (§2 Rule
  14); `LiveMapCanvas.tsx` renders it via a MapLibre custom protocol,
  falling back to online tiles when no package is installed. Nearby
  incidents/Tanods (already fetched by the pre-existing status view) now
  plot as real map pins, in addition to the distance/bearing list, which
  is kept, not replaced. Real browser-rendered proof (a live OpenStreetMap
  basemap centered correctly on Pilar/Dao/Binanuahan/Marifosque, no
  crash, graceful fallback when the fake test backend was unreachable) —
  see `backend/DEVLOG.md` 2026-09-12 (5) for the full verification
  writeup and the one deliberate deviation (package-activation metadata
  tracked via `@capacitor/preferences`, not the pre-declared
  `offline_map_package_local` SQLite table, because that table lives in
  the Android-only encrypted local DB and using it would have made this
  whole feature untestable in a browser). **What this does NOT close:**
  the offline-MBTiles path itself (download → verify → local tile read)
  has no real backend package or real device available to exercise
  end-to-end in this environment — same A1 blocker as the rest of
  mobile's local-storage layer, disclosed rather than claimed proven.
  Full turn-by-turn routing remains separately unbuilt, below.
- Full turn-by-turn routing (road-snapped directions, recalculation)
  needs an offline routing engine (OSRM/GraphHopper-class) plus real
  road-network data for Pilar, Sorsogon extracted from OpenStreetMap —
  neither exists anywhere in this stack. This is a multi-session build on
  its own, not an increment on the basemap work above, and is unaffected
  by that work being done.
- ✅ `npx cap sync android` run + the `POST_NOTIFICATIONS` manifest
  permission added — `@capacitor/geolocation` and
  `@capacitor/push-notifications` are now registered native plugins
  (6 → 8). `gradle.properties`' hand-fixed JDK paths confirmed intact.
- 13 pre-existing npm advisories in `mobile/` — never triaged.

---

## D. Unbuilt screens

| Screen | Status |
|---|---|
| **W10 User Management** | ✅ Built: Admin can create an account (`POST /users`, own barangay, admin sets the initial password, no forced-change flow), and deactivate/reactivate a same-barangay user with session revocation and a "one active Admin must remain" guard. Role CHANGES to an existing account remain out of scope (a deliberate decision, not an oversight) — `PATCH /users/:id`'s self-edit path is unchanged. 19+17 ad hoc checks + browser-verified; see DEVLOG's two W10 entries. |
| **W18 Map Package Management** | ✅ Built. Both endpoints already existed; new web screen shows published version/checksum (or an honest empty state) and an upload form that surfaces the server's real validation errors verbatim. Browser-verified end-to-end (empty state, invalid-file rejection, real MBTiles upload) against a disposable backend. |
| **W21 System Settings** | ⚠️ **This row was stale — corrected 2026-09-07.** It is no longer true that there is "no schema, no endpoints". Migration 0012 (`system_settings`) plus `SettingsController` and `GET/PATCH /system-settings` shipped 2026-09-05 under explicit user authorization, surfaced Admin-only as the Settings screen's General + SMS Gateway sections. The override is **narrow**: `sms_gateway.api_key`/`sms_gateway.sender_name` and three non-secret `general.*` display keys, masked on read. It does **not** extend to `DEVICE_SECRET_MASTER_KEY`, `INTERNAL_SERVICE_TOKEN`, `JWT_SECRET` or `FCM_SERVICE_ACCOUNT_PATH` — those stay in `.env`, and a future session must not "complete" W21 by moving them without the same explicit sign-off. Full-scope settings (Notifications/Security/GIS/Backup) remain unbuilt, with no schema or endpoints, and §2 Rule 6 forbids shipping controls for them that do nothing. See `docs/REFERENCE.md` §7's W21 note. |

---

## E. Housekeeping

- 🟢 A stray `baranguard_device_check` database exists locally — flagged,
  never investigated, safe to drop after a look.
- ✅ The three empty untracked files in the repo root (`cls`, `git`,
  `main)`) are **gone** — confirmed 2026-09-07, nothing to do.
- 🟢 Eight untracked design-doc/scratch artifacts sit in the repo root
  and `docs/` and have done for several sessions:
  `Baranguard_System_Design_Document.docx`/`.pdf`, four `diagram_*.png`,
  `scratch_diagrams.py`, and `docs/progress-tracker.html`. Still
  undecided as of 2026-09-12, despite six other uncommitted changes from
  around the same period finally landing that session (see DEVLOG).
  Commit them under `docs/`, or gitignore them — but decide, rather than
  letting them keep riding along untracked where `git add -A` could
  sweep them in.
- 🟢 `mobile/android/` is gitignored but now holds real, non-regeneratable
  fixes (`gradle.properties`, manifest permissions). `npx cap sync` is
  safe; `npx cap add android` would destroy them. Decide whether to
  commit it.

---

## G. Recommended enhancements (2026-09-07 — not required for Sprint 8)

Not blockers. Kept here rather than in a separate file so there's one
list of outstanding work. None of A2/A3/A6 below need re-doing — those
three were pure doc/wording fixes and are already applied in the Master
Reference itself.

### G1-G4. Logic-gap fixes — target rule already written, code/schema not yet built

Each of these has its correct, intended behavior already spelled out in
`docs/Baranguard_Master_Reference_FINAL .md` (marked "not yet built"
inline) — implementing means matching code/schema to a rule that already
exists, not inventing one.

**Status 2026-09-12: G2 and G3 are built, G4 is closed as obsolete, G1
is the only one of the four still open.**

- 🔴 **G1 — SOS third fallback tier. STILL OPEN, and blocked on the same
  thing A1 is.** App and SMS fallback (Rule 27) both terminate on the
  same workstation Rule 15 already calls a single point of failure —
  neither survives a total outage. Fix: mobile app sends a native-device
  SMS (own SIM, no gateway) to a configured backup contact with GPS
  coords, only when both other paths are confirmed unreachable.
  **Why it wasn't built in the 2026-09-12 pass that closed G2/G3:** it
  needs (a) a native Capacitor SMS plugin plus the `SEND_SMS` runtime
  permission, which cannot be built or tested without the Android
  device/emulator **A1** is blocked on, and (b) an unmade architecture
  decision about where the backup contact number lives — `system_settings`
  is the obvious home but §7's W21 note explicitly forbids widening that
  table's narrow override without the same explicit sign-off the SMS
  gateway keys got. Note that `mobile/src/services/smsFallbackState.ts`
  already models the four transport states correctly and its header
  already records that nothing sets `smsAttempted` — building the
  decision logic alone would reproduce exactly that situation one layer
  up, which §2 Rule 6 is about. **Needs a decision on (b), then a device
  for (a).**
- ✅ **G2 — `sms_log.legal_hold` column — DONE 2026-09-12.** Migration
  0016 adds the column (+ `idx_sms_log_retention`), and
  `RetentionService::purgeSmsLogs()` now checks four hold paths at purge
  time rather than trusting a pre-propagated flag: the row's own
  `legal_hold`, the linked `incident`, the linked `citizen_report`, and
  the linked `dispatch` resolved through to its incident (dispatch has no
  `legal_hold` of its own, by 0007's "a hold is placed on a CASE" rule).
  Held rows are counted and reported like every other rule. Proven by
  six new assertions in `verify-sprint7-retention.sh` (76/76).
- ✅ **G3 — `mobile_device` retention scrubs, not deletes — DONE
  2026-09-12.** `RetentionService::scrubDeactivatedDevices()` (renamed
  from `purgeDeactivatedDevices()`) clears `fcm_token`/
  `device_secret_ref` in place and keeps the row, stamping migration
  0016's `secrets_scrubbed_at` as both per-record evidence and the
  idempotency guard — the same shape `raw_narrative` already used. The
  assertion that matters is in the suite: a 7-year incident filed by a
  retired handset still resolves its `device_id` after the scrub, which
  the old delete-the-row behaviour destroyed.
- ⬜ **G4 — `incident.source = 'web_walkin'` discriminator — CLOSED AS
  OBSOLETE 2026-09-12, not built.** Its entire purpose was to let
  reports exclude walk-in incidents that entered the system already
  `resolved`, skipping the `pending`/dispatch lifecycle. **That path no
  longer exists.** `POST /blotter` was removed 2026-09-10, and all three
  surviving incident-creation sites — `CitizenReportsController:290`,
  `IncidentsController:894` (web) and `:1086` (mobile/sync) — hardcode
  `status = 'pending'`; `IncidentsController::updateStatus()` further
  refuses to resolve anything not already `dispatched`. There is
  therefore no incident for the discriminator to discriminate, and
  adding an enum value nothing can ever write is precisely the control
  §2 Rule 6 forbids. **F8's `avg_response_time_minutes` double-count is
  unaffected** — it needs de-duplication in its own `JOIN`, which never
  depended on this discriminator.

  *(Observation, not tracked work: because resolution requires a
  `dispatched` incident, a walk-in logged at the desk that genuinely
  needs no Tanod sent has no legitimate way to reach `resolved`. That is
  a different question from G4 and is deliberately not folded into it.)*

### New feature candidates (2026-09-07 brainstorm, curated subset)

Each is 🟢 unless noted. One-line rationale kept; full discussion was in
that session's chat, not duplicated here.

**Being worked in phases since 2026-09-12** — Phase 1 and Phase 2 are
done and committed; Phases 3-5 below are not started. Two items are
blocked behind other decisions and are marked ⛔ rather than left looking
merely un-started.

**Dispatch/incident**
- ✅ **Nearest-available-Tanod ranking on the dispatch picker — DONE 2026-09-12 (Phase 1).** `promptDispatchTanod()` orders by real haversine distance to each Tanod's last GPS fix and labels every option with a measured distance; no fix sorts last as "location unknown", a stale fix shows its age, and a missing incident coordinate falls back to the unranked list. Decision support only — no automatic assignment.
- ✅ **Stale-pending escalation for undispatched high/critical incidents — DONE 2026-09-12 (Phase 1).** The dashboard attention banner now carries the real measured wait of the oldest un-dispatched high/critical incident and escalates past `STALE_URGENT_MINUTES`, which is documented as a display heuristic and explicitly **not** an SLA — no document in this project defines a dispatch response target.
- ⛔ **Backup/second responder on critical incidents — NEEDS A DECISION, not code.** It reopens the "one active dispatch per incident" resolved decision and touches Rules 21/28's state machine, so it cannot be built without the architecture review this repo requires for exactly that. Warranted for fire/medical; still warranted; still a decision.

**AI/oversight**
- ✅ **Redaction diff view — ALREADY SHIPPED** (commit `27d6cc9`, found 2026-09-12 while phasing this list). An LCS word-level diff in `ai-review.js` marks which original words survived redaction. It was never listed as done because it landed inside a batch of uncommitted work.
- ⛔ **Evidence-access audit — BLOCKED BEHIND F4, same as the photo-compression item.** There is nothing to audit: nothing in `backend/` ever writes `evidence_attachment` (F4), there is no download route, and the table is empty. Auditing `GET /incidents/:id/evidence` today would record "someone listed zero files" — an oversight control that can never observe the thing it exists for, which is the §2 Rule 6 shape. Build it **with** F4's upload/download work, not before.
- ✅ **Lupon packet verification hash — DONE 2026-09-12 (Phase 2).** A SHA-256 over the case content (not the PDF bytes — hashing the file to then print the hash inside it is circular) is printed on the packet as a 16-hex-character grouped code, and recorded in the `lupon_packet_generated` audit row. It is re-derivable: regenerate and compare, and a mismatch means the record was amended after printing or the paper is not ours. The generation timestamp is deliberately excluded so the code is stable. **QR deliberately not built** — a QR encoder in hand-rolled PHP is real work for marginal gain over a transcribable code.

**Resilience**
- ✅ **Health-check history — DONE 2026-09-12 (Phase 3).** Migration 0017's `health_check_log` plus `GET /system/health/history` (Admin-only, new route, documented as an addition to §6) and a "Dependency status changes" section on W20. It is a **state-change log, not a time series**: a row is written only when the observed statuses differ from the newest row, so W20's own polling cannot flood it and the useful facts — the transitions — are stored losslessly. Honest limitation stated in the migration header, the API payload (`sampling: "change_only_on_probe"`) and the UI itself: samples exist only where a probe ran, so a gap means nobody was looking, not that nothing happened. C2's scheduler wiring is what would close that.
- ✅ **Backup-staleness warning in W20 — ALREADY SHIPPED, and was silently broken.** The card already computed freshness and rendered "Active (< 24h)" / "Stale (> 24h)" / "No Backup Taken" badges. But the badge class it used for the warning state, `status-pill--warning`, **was defined in no stylesheet at all** — so the most alarming disaster-recovery states rendered with no fill. Defined in `base.css` 2026-09-12 as a deliberate alias of `--pending`'s amber treatment. `verify-web-wiring.mjs` could not catch this: the class name is assembled inside a ternary in a template literal, which its static extraction cannot see — worth remembering as a known blind spot of that check.

**Communication**
- ✅ **Closing-the-loop SMS to the citizen reporter — DONE 2026-09-12 (Phase 4).** `CitizenUpdateNotifier` fires on conversion and on resolution, reusing `sendOutbound` with `message_type='confirmation'`. §2 Rule 1 shapes the content: fixed templates plus the barangay name and `display_id` only — no narrative, no names, and deliberately not even the incident type, since a "Physical Injury" notice on a shared household phone discloses something about that household. Best-effort and after the commit (a courtesy text must never fail the records action), idempotent per (report, event). Anonymous reports correctly send nothing.
- ✅ **Two-way SMS console — ALREADY SHIPPED.** All four conversation endpoints exist and SMS Monitor's Conversations tab renders inbound citizen messages with outbound replies, delivery states, quick replies and a compose box. Confirmed in the browser 2026-09-12 rather than assumed. It was on this list because the Master Reference §10 named it out-of-scope, not because it was unbuilt.
- ✅ **Barangay-wide advisory broadcast — DONE 2026-09-12 (Phase 5).** Migration 0018's `sms_subscriber` plus three Admin-only endpoints and an "Advisory List" tab in SMS Monitor, and `scope=subscribers` on `/sms/broadcast`. The DPA concern this entry raised is handled structurally, not by policy: `consent_at`/`consent_source` are NOT NULL so a row without provenance cannot exist, and removal is an `opted_out_at` timestamp rather than a DELETE, because proving a withdrawal was honoured means keeping the record of it. Reusing `sms_log`/`citizen_report` numbers is exactly what the table exists to prevent.

**Civic/oversight**
- ✅ **Periodic PB digest — the content half ALREADY EXISTS; the periodic half is C2-blocked.** `GET /reports/export?format=pdf` already produces a PDF summary and is already `punong_barangay`-accessible — verified 2026-09-12 by generating and downloading a 27KB packet as `kapitan.dao`. Building a second near-identical "digest" endpoint would duplicate it. What is genuinely missing is *periodic*, and nothing on this system is scheduled (**C2**); it becomes trivial once that is wired.
- ✅ **Aggregated public transparency report — DONE 2026-09-12 (Phase 5).** `GET /public/transparency?barangay_id=N`, the only unauthenticated read in the system. Counts only, no location breakdown at any level, monthly not daily buckets, and categories under 5 pooled rather than dropped (dropping breaks the total and leaks the hidden number by subtraction). No response-time figure — at the time this shipped, F8's double-count meant publishing one would have been publishing a known-wrong number. **F8 is now fixed (2026-09-12)**, so that specific reason no longer applies; whether a response-time figure belongs in a *public* transparency report is a separate policy question this entry never actually settled, not something the F8 fix alone resolves — left as a genuinely open follow-up, not auto-added here. Not rate-limited, and the class doc says so plainly instead of shipping an APCu limiter that this build cannot run.

**Mobile**
- ⛔ **Client-side photo compression — BLOCKED BEHIND F4**, exactly as this entry always said: build it into the work that builds the upload endpoint at all, not as a separate later feature.

---

## Suggested order

**0. Section F first.** F2/F3 (XSS sweep), F5 (PATCH idempotency), F6
(is_suspended), and F8 (response-time double-count) are all **closed as
of 2026-09-12** — see each item's own closure note above. **F1 (settle
the real API base URL) and F4 (evidence upload: build or descope) are
the two that remain, and both need the user, not more code.** F1 in
particular gates step 3 below: browser-verifying screens that are
pointed at seeded preview data over a public tunnel proves nothing about
production.

*(The rest of the order is unchanged. A3 is now ✅ done — see its own
entry — and A2 has a concrete path via `eval-kit/` that a friend can run
in parallel with everything below; nobody needs to wait on it.)*

1. ~~Start A3 (dataset)~~ **Done 2026-09-07** — generated, not
   hand-authored; see A3's own entry for the disclosed methodology
   deviation and the recommended spot-check.
2. **A1 (Android)** in parallel — it unblocks six verifications at once,
   plus device-verifying C3's SOS wiring (code-complete, done above).
3. **B1 (browser-verify)** — biggest pile of finished-but-unproven work,
   and needs nothing but a session.
4. **B3, C2** — quick, and they make W20 tell the truth. (C2's Task
   Scheduler wiring still needs a human to run the final command —
   see C2's own note.)
5. **B2, B4** — close the verification gaps Sprint 8 will otherwise
   inherit.
6. **A2 (model run)** — hand `eval-kit/` to a friend with capable
   hardware (see A2's own entry for what "capable" means here: this
   workstation itself timed out on a single record at 300s CPU-only) →
   then Sprint 8's AI evaluation box, informed by the disclosed
   generation-method caveat on the dataset itself.
