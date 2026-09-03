# Baranguard — Super Prompt Library (Per-Sprint, Ready to Paste)

Usage: run this from Claude Code, inside the actual Baranguard repo. Keep
`Baranguard_Master_Reference_FINAL.md` and `DEVLOG.md` in the repo (e.g.
under `/docs`) and load them into every session automatically via your
project `CLAUDE.md` — an `@docs/Baranguard_Master_Reference_FINAL.md` and
`@docs/DEVLOG.md` import does this without you pasting anything. Claude
Code already sees the live repo state, so there's nothing to zip or link.
Then paste the block for whatever sprint you're working on. Each block
already includes the Base Prompt's non-negotiable rules — you don't need
to paste §12's Base Prompt separately, it's folded into every block below.

**Today's cut is now a real menu, not an open category.** Every block
below enumerates the actual choices for that sprint instead of a
bracketed placeholder — pick exactly ONE, mark it, and stop the session
there. If the pasted block still shows every box unchecked and nothing
named in prose, the executing session should stop and ask which one
before writing any code — it should never default to "the whole sprint"
and it should never pick on your behalf. If you finish your chosen item
early, end the session and log it rather than sliding into the next
box — Sprint 0's own devlog shows all four of its options getting built
in one sitting despite an enumerated list, which is exactly the drift
this rule exists to stop.

**Why `DEVLOG.md` alone still isn't enough, even with live repo access:**
`DEVLOG.md` is a description of what's built, never a substitute for it.
It's reliable for telling a session that something already exists; it
cannot reliably tell that session the *exact current shape* of a file
well enough to safely extend it — and that gap widens, not narrows, as
the project matures, because later sprints spend more time modifying
existing files than adding new ones. With Claude Code you no longer need
to attach the repo — it's already looking at the real files — but the
discipline still runs the other way: before extending anything DEVLOG.md
marks done, open and read the actual file, don't build on the
description alone. A good `DEVLOG.md` entry still includes a literal
file tree of what
exists (not just prose), the exact exported shape of any file other
code will import from, and — at the top of the entry — the exact
"Today's cut" line that session worked from, so later sessions can see
what was actually attempted, not just what's claimed done.

**Environment note:** this loosens with Claude Code. A cloud chat session
(this note's original assumption) can't reach your local MariaDB/XAMPP, a
GSM modem, self-hosted Ollama, or OSRM. Claude Code runs on your actual
workstation, so — subject to whatever tool/network permissions you grant
it — it can call and verify against all of those directly, because it's a
shell on your machine, not a sandboxed remote session. The one real
exception is Semaphore: a funded account and an actual SMS send still
cost money and require the live service no matter where the session
runs, so budget for genuine send-and-verify tests under Sprints 4–6
rather than mocking it.

---

## Sprint 0 (Weeks 1–2) — Local MariaDB Setup + Executable Schema

```
You are working on Baranguard, a real offline-first, locally hosted Barangay
Intelligence and Emergency Dispatch System for four barangays in Pilar,
Sorsogon, Philippines. Initial development uses local MariaDB through XAMPP;
cloud deployment is deferred and undecided. Treat this as a production
system, not a demo. The Master Reference (uploaded) is the source of truth —
never invent fields, routes, roles, or state transitions not listed in it.

SPRINT 0 — Local MariaDB 10.4 environment + executable schema.
Scope: (a) env-driven DB connection; (b) migrations for §5 with explicit SQL
types, nullability, foreign keys, indexes, uniqueness, and delete behavior,
in the corrected dependency order given in §5 (barangay → user → mobile_device
→ incident → dispatch → tanod_sos → notification → notification_target →
notification_delivery → remaining dependent tables — mobile_device MUST
precede incident); (c) seed only the four deterministic barangay rows
(§11's retention table has nothing to do with seeding — don't seed
incident/PII data); (d) interactive first-admin bootstrap per Rule 10;
(e) backup/restore baseline per §11.

Known trap: a table-level CHECK constraint on notification's entity-integrity
matrix (§5) will fail in MariaDB with ERROR 1901, because dispatch_id/sos_id/
incident_id each carry an ON DELETE SET NULL foreign key. Enforce that matrix
in application code and a transaction-level check instead — don't re-attempt
it as a CHECK.

Validate: schema applies cleanly from an empty database, rollback strategy is
documented, tenant constraints are testable, and the bootstrap password never
appears in source/logs.

Today's cut — pick exactly ONE:
  [ ] Migrations only (§5's full 24-table/57-FK schema, corrected order)
  [ ] Seed script (four deterministic barangay rows only)
  [ ] First-admin bootstrap CLI
  [ ] Backup/restore baseline

Stop at your chosen item even if there's time left in the session — don't
slide into the next box. If nothing above is checked and nothing is named
in prose, stop and ask which one before writing any code.

Output: files changed, migration applied against an empty DB with evidence
(not just claimed), tests performed, deviations logged in DEVLOG.md.
```

---

## Sprint 1 (Weeks 3–4) — Web Command Center + GIS + Public Intake + Reports

```
You are working on Baranguard (uploaded Master Reference is the source of
truth — check §§2,5,6,7,8,9 before coding; never invent fields, routes,
roles, or state transitions). Enforce tenant/ownership server-side on every
endpoint, use exact §5 schema names, never log/print raw_narrative, no
client-side role check is a security boundary, no demo/prototype tells.

Idempotency, exactly: web writes use the required Idempotency-Key UUID
header; mobile writes use client_event_id. These are not interchangeable —
POST /incidents on the web path uses Idempotency-Key, never client_event_id.

CONFIRM BEFORE CODING: §1 lists the backend stack as "PHP 8.2 + Node.js"
jointly and never says which one actually serves /api/v1/*. Check
DEVLOG.md first in case a prior session already decided this. If it
didn't, stop and ask which language serves the API before writing the
first route file — don't assume, and don't let two different sessions
resolve this two different ways.

ALREADY BUILT — DO NOT RECREATE: DEVLOG.md is the cumulative
record of what's already built and tested. Before extending any file it
lists as done, open that actual file from the repo and
confirm it matches DEVLOG's description — don't build on the description
alone. Do not rewrite, restructure, or regenerate anything DEVLOG lists as
done — build only this sprint's new scope on top of it. If Sprint 1 needs
a schema change not covered by the existing migration, add a new migration
file rather than editing the completed one, and log it in DEVLOG.md. If
something this sprint needs seems missing or unclear from DEVLOG.md, STOP
and ask before generating it from scratch.

SPRINT 1 — Web Command Center core + GIS dashboard + public citizen intake
+ reports (S1 items from §10's Web Command Center and Citizen Reports
backlog, excluding export/service-health which are S7).

Endpoints to build against exactly as documented: POST /auth/login,
POST /auth/logout, GET /reports/summary, GET /gps/live, GET /gps/history,
GET /reports/heatmap, GET /incidents, POST /incidents (web path —
Idempotency-Key header), POST /dispatch, PATCH /dispatch/:id/cancel,
POST /citizen-reports (public), GET /citizen-reports.

Today's cut — pick exactly ONE:
  [ ] Auth backend + shared middleware (POST /auth/login, POST /auth/logout,
      JWT verify → role guard → tenant scope; unblocks every item below)
  [ ] W2 Admin Dashboard — wire existing frontend to real GET /reports/summary
  [ ] W3a Dispatch Center — pending queue + Tanod picker (read-only)
  [ ] W3b Dispatch Center — create/cancel actions (POST /dispatch,
      PATCH /dispatch/:id/cancel)
  [ ] W4 GIS Live Tracking — build the shared LiveMap component here; W3's
      map pane reuses it later, it does not get a second implementation
  [ ] W5 Historical Heatmap
  [ ] W6 Electronic Blotter List (read-only excerpt + new-entry form)
  [ ] W9 Statistical Reports — Generate only
  [ ] W15 Settings/Account
  [ ] W19 Public Citizen Report
  [ ] W16 Citizen Reports Inbox — list only
  [ ] Scheduler + fatigue calc (optional this sprint per §10)

If nothing above is checked and nothing is named in prose, stop and ask
which one before writing any code — don't default to the full sprint and
don't pick on the user's behalf. If you finish early, end the session and
log it rather than continuing into the next box.

Requirements: match §5/§6 exactly; enforce §7 role+tenant+ownership
server-side; Loading/Empty/Error/Populated states on every data-driven
screen (§9 checklist); design tokens only, no hardcoded colors/spacing
(§8); idempotency on every retryable POST; test the failure path, not
just happy path.

Output: state the exact Today's cut item this session built, at the top.
Then: files changed, endpoints/tables touched, tests performed (happy
path + retry + unauthorized + cross-tenant, with evidence, not just
claimed), deviations in DEVLOG.md.
```

---

## Sprint 2 (Weeks 5–6) — Mobile UI + Encrypted SQLite + Offline Basemaps

```
You are working on Baranguard (uploaded Master Reference is the source of
truth). Non-negotiables: tenant/ownership enforced server-side, stable
client_event_id on every mobile write, raw_narrative never leaves the
encrypted local store except through the approved AI/redaction workflow,
offline cache is durable state (not temporary UI state), no demo tells.

ALREADY BUILT — DO NOT RECREATE: DEVLOG.md is the cumulative
record of everything through Sprint 1. Before extending any file it lists
as done, open that actual file from the repo and confirm it
matches DEVLOG's description — don't build on the description alone. Do
not regenerate any of it — build only Sprint 2's new mobile-side scope.
If something this sprint needs seems missing or unclear from DEVLOG.md,
STOP and ask before generating it from scratch.

SPRINT 2 — Mobile Tanod app core: encrypted SQLite cache, offline incident
capture, dispatch_local cache shape, offline basemap packages, local
evidence storage (§10 Mobile App backlog, S2 items).

M2's UI (§9) may follow the Figma reference's greeting-card/quick-actions
layout, but every identity/stat shown must come from the authenticated
session and real local queries — the reference hardcodes a fake tanod name
and fabricated performance stats with no session lookup at all; do not
carry that pattern over. §8 also flags an unresolved open question — whether
"Log Incident" or "Schedule" gets the persistent bottom-nav tab slot — that
needs a deliberate decision before wiring M3/M8's nav, not a silent pick.

Local tables to build exactly per §5 Mobile Local section: incident_local,
mobile_device_local, offline_map_package_local. Evidence local table
(evidence_attachment_local) if photo/voice capture is in this sprint's cut.
Map packages: GET /map-packages/:barangay_id, GET /map-packages/:barangay_id/download
— client verifies SHA-256 before activation, per §6.

Today's cut — pick exactly ONE:
  [x] Local schema: incident_local + mobile_device_local +
      offline_map_package_local
      DONE 2026-09-02, commit d61a213. Also scaffolded the Ionic React
      app (prerequisite plumbing — /mobile was an empty placeholder).
      Verified 47/47 against §5 via mobile/scripts/verify-local-schema.mjs.
  [x] M1 Login — device registration + map-package metadata/download
      DONE 2026-09-02, commit 40dbde5. CAVEAT: the "registers FCM" half is
      Sprint-4-blocked (devices/register needs an fcm_token that cannot
      exist until FCM is set up); getFcmToken() returns null and
      registration is skipped rather than sending a placeholder.
  [x] M2 Home — duty status control + SOS entry point
      DONE 2026-09-03. Duty toggle calls real POST /duty-status (browser-
      verified: DB row confirmed, channel='app'); own current status loaded
      from GET /duty-status?user_id=me on mount rather than assumed. SOS
      shown but disabled with an explanatory note (Sprint-4-blocked, per
      the resolved ambiguity below) — never a button that looks functional
      but silently does nothing.
  [x] M3 Log New Incident — local SQLite write path (client_event_id
      assigned at time of first save, atomic before the user can leave)
      DONE 2026-09-02, commit 40dbde5. Extended 2026-09-03 with photo/voice
      capture (staged in-memory, persisted to evidence_attachment_local
      only after the incident itself saves). STILL NEVER EXECUTED ON A
      DEVICE — see below; the form itself (including the new Add
      Photo/Record Voice Note buttons) IS browser-verified to render.
  [x] M4 Incident Submitted Confirmation — sync-state display only
      (Saved locally / Queued / Synced / Duplicate reconciled / Needs
      attention)
      DONE 2026-09-02, commit 40dbde5. NEVER EXECUTED — see below.
  [x] Local schema: evidence_attachment_local
      DONE 2026-09-03 — photo/voice capture shipped in this same cut, so
      the deferral condition didn't apply. Migration 2 (LOCAL_SCHEMA_
      VERSION now 2); verified 65/65 including a v1->v2 in-place upgrade
      test (a device already on schema v1 keeps its existing rows).

If nothing above is checked and nothing is named in prose, stop and ask
which one before writing any code. If you finish early, end the session
and log it rather than continuing into the next box.

--- Sprint 2 working checklist (added 2026-09-02) -------------------------
Derived from this menu + §9's M-screens + §10's S2-tagged backlog, so a
later session inherits it instead of re-deriving it. None of the items
below are extra scope — they are the prerequisites the boxes above
already imply.

BLOCKERS — environment (gate Sprint 2's OWN required tests):
  [ ] Install Android SDK / Android Studio on the workstation, then
      `npx cap add android && npx cap sync` (mobile/android/ is gitignored).
      Now also needed for: @capacitor/camera, capacitor-voice-recorder,
      @aparajita/capacitor-secure-storage — added 2026-09-03, none have
      ever run on a device either. AndroidManifest.xml permissions
      (CAMERA, RECORD_AUDIO) don't exist yet since `cap add android`
      hasn't run — add them when it does.
  [ ] Verify SQLCipher ACTUALLY encrypts the DB file on a device — this
      prompt's own "encrypted store actually encrypted — verify, don't
      assume". Not possible without the SDK; unverified as of d61a213.
  [ ] Verify offline capture survives app kill — same, needs a device.
  [ ] Verify photo/voice capture actually produces a playable file, that
      SecureStorage.getItem/setItem round-trip on Android Keystore, and
      that the passphrase migration path (old @capacitor/preferences value
      -> secure storage) works on an install that predates 2026-09-03.

BLOCKERS — decisions (each gates a specific box):
  [x] DB passphrase source → RESOLVED 2026-09-02 (commit 40dbde5), UPGRADED
      2026-09-03: now uses @aparajita/capacitor-secure-storage, whose
      Android implementation encrypts under an Android-Keystore-generated
      key before writing to SharedPreferences (confirmed against the
      plugin's own README) — the Keystore upgrade this note's own original
      text flagged as the documented next step. Only passphrase.ts changed,
      exactly as anticipated; a one-time migration reads an old
      @capacitor/preferences value on an existing install rather than
      generating a second passphrase.
  [x] Bottom-nav slot: "Log Incident" vs "Schedule" → RESOLVED 2026-09-03
      (confirmed with the user): Log Incident takes the persistent tab
      slot; Schedule (M8, unbuilt) moves behind Profile. §8 updated.
      Implemented as `TabbedShell` in mobile/src/App.tsx; unbuilt tabs
      (Assignments/Map/Profile) route to an honest `NotBuiltYetPage`
      rather than being hidden or faked.
  [x] Is photo/voice attachment in Sprint 2? → RESOLVED 2026-09-03: yes,
      built in full this cut (not schema-only) — see the M3/local-schema
      boxes above.

BACKEND — documented in §6:
  [x] POST /devices/register              DONE (cb27272), 53/53 verified
  [x] PATCH /devices/:id/deactivate       DONE (cb27272)
  [x] GET  /map-packages/:barangay_id     DONE (cb27272)
  [x] GET  /map-packages/:barangay_id/download  DONE (cb27272)
  [x] POST /map-packages                  DONE 2026-09-03. Admin-only,
      MBTiles structure validated (SQLite header always; tiles/metadata
      table check when pdo_sqlite is available), atomic publish enforcing
      §5's "exactly one published package per barangay" via SELECT...FOR
      UPDATE. 40/40 verified against real XAMPP
      (verify-duty-status-map-upload.sh).
  [x] POST /duty-status                   DONE 2026-09-03 (M2). Idempotent
      via client_event_id, same 40/40 script.
  [~] Mobile branch of POST /incidents — the web path exists (Sprint 1)
      but mobile idempotency is device_id + client_event_id, a different
      code path. CODED 2026-09-03 (X-Device-Id header + createMobileItem(),
      also reused by Sprint 3's SyncController) — NOT YET VERIFIED, same
      session/caveat as the Sprint 3 boxes below.

MOBILE INFRASTRUCTURE:
  [x] apiService.ts — DONE (40dbde5); extended 2026-09-03 with
      setDutyStatus/getOwnDutyStatus.
  [x] On-device session storage — DONE (40dbde5); sliding renewal refuses
      to move a token's expiry backwards, per Rule 9
  [~] Repository layer over the local schema — incident_local DONE
      (40dbde5); evidence_attachment_local DONE 2026-09-03
      (evidenceRepository.ts); mobile_device_local and
      offline_map_package_local still have no reader/writer
  [x] evidenceCapture.ts (Camera/Filesystem/voice-recorder platform edge)
      — DONE 2026-09-03, type-checked against each plugin's documented
      contract, NOT device-verified (see environment blockers above).

AMBIGUITIES to settle before they cause drift:
  [ ] This block's scope line says "dispatch_local cache shape", but it is
      not a menu box and §10 tags cached dispatch/route detail as S2–3.
      Decide whether it lands in Sprint 2 or Sprint 3.
  [x] M2's SOS entry point → RESOLVED 2026-09-03: built visibly disabled
      with an explanatory note, not hidden and not silently non-functional.
      Still fully blocked on Sprint 4's POST /tanod-sos.

Suggested order for what's left: Android SDK install (unblocks every
device-only verification above) → device run of M1/M3/M4/M2. The mobile
POST /incidents branch and the dispatch_local cache-shape decision are
both resolved — see the [~] entries above and Sprint 3's own section
below: all of it is CODED (2026-09-03) but UNVERIFIED, not yet a device
run.
--------------------------------------------------------------------------

Requirements: every local write gets a stable client_event_id at time of
first save — the same ID must survive direct POST, sync, and SMS fallback
later (don't build a different ID scheme now that Sprint 3/4 would have to
retrofit). Voice/photo files in app-private storage only. No claim of
server sync until the server actually confirms it.

Output: state the exact Today's cut item this session built, at the top.
Then: files changed, local schema applied, tests performed (offline
capture survives app kill, encrypted store actually encrypted — verify,
don't assume), deviations in DEVLOG.md.
```

---

## Sprint 3 (Weeks 7–8) — GPS Tracking + Idempotent Sync + Offline Reconciliation

```
You are working on Baranguard (uploaded Master Reference is the source of
truth). Non-negotiables: idempotency/client_event_id on every retryable
write, no client-side role check is a security boundary, cached
dispatch/route data used when offline, stale GPS never presented as live.

ALREADY BUILT — DO NOT RECREATE: DEVLOG.md is the cumulative
record of everything through Sprint 2. Before extending any file it lists
as done, open that actual file from the repo and confirm it
matches DEVLOG's description — don't build on the description alone. Do
not regenerate any of it — build only Sprint 3's new scope. If something
this sprint needs seems missing or unclear from DEVLOG.md, STOP and ask
before generating it from scratch.

SPRINT 3 — GPS broadcast, idempotent /sync/batch, cached dispatch/route
detail, offline state reconciliation (§10 items tagged S3, plus S2–3
carryover on dispatch/route caching).

Reconciliation detail to get right: dispatch_local's route_status/stale_after
fields exist specifically so M6 can show "cached/last known" instead of
silently presenting a stale route as current — verify the UI actually reads
those fields rather than always showing the freshest cached row.

Today's cut — pick exactly ONE:
  [~] M5 Assignments List (reads dispatch_local, works when API unreachable)
      CODED 2026-09-03, NOT YET VERIFIED. Built alongside all four other
      boxes below in one session at explicit user direction ("code first,
      test after") — a deliberate exception to "pick exactly ONE",
      confirmed by the user, same category as prior multi-box sessions.
      See backend/DEVLOG.md's "Sprint 2's leftover mobile POST /incidents
      branch, then all of Sprint 3 in one session" entry for exactly what
      was and wasn't checked (php -l / tsc --noEmit only — no verify
      script, no browser pass, no device run).
  [~] M6 Assignment Detail/Navigation — status transitions queue into
      dispatch_status_updates[], reconcile via idempotent client event IDs
      CODED 2026-09-03, NOT YET VERIFIED — same session/caveat as M5 above.
  [~] M7 Live Map — GPS broadcast + nearby redacted incidents
      CODED 2026-09-03, NOT YET VERIFIED — same session/caveat as M5 above.
      Ships without a rendered basemap (real status view only — see
      DEVLOG for why); the map-tile rendering surface is separate,
      unscoped follow-up work.
  [~] Server: POST /gps + GET /gps/live + GET /gps/history
      POST /gps CODED 2026-09-03, NOT YET VERIFIED — same session/caveat
      as M5 above. GET /gps/live + GET /gps/history were already DONE and
      real-XAMPP-verified in Sprint 1 (37/37) — unchanged by this cut.
  [~] Server: POST /sync/batch reconciliation (oldest-first per device,
      locks/dedupes by event key)
      CODED 2026-09-03, NOT YET VERIFIED — same session/caveat as M5
      above. PATCH /dispatch/:id/status (needed by both M6 and this) was
      also coded this same session, same caveat.

None of the boxes above are checked [x] — a checked box in this file has
always meant real verification evidence, and this session deliberately
has none yet. Do not treat the [~] marks as "done"; treat them as "code
exists, go verify it" per the suggested order at the end of that DEVLOG
entry.

If nothing above is checked and nothing is named in prose, stop and ask
which one before writing any code. If you finish early, end the session
and log it rather than continuing into the next box.

Requirements: is_stale=true at ≥120s without a fresh GPS point (§6);
sync processes oldest-first and is safe to retry from any interrupted point;
GPS write requires dispatch_id (if present) to belong to caller and same
barangay at write time — recheck at write time, not just at read time.

Output: state the exact Today's cut item this session built, at the top.
Then: files changed, endpoints/tables touched, tests performed
(interrupted sync resumes correctly, duplicate GPS points from retry don't
double-count, offline→online transition doesn't lose queued writes),
deviations in DEVLOG.md.
```

---

## Sprint 4 (Weeks 9–10) — Notifications + FCM + GSM/SMS Fallback + SOS

```
You are working on Baranguard (uploaded Master Reference is the source of
truth). Non-negotiables: raw_narrative never sent to FCM/Semaphore/cloud
(GSM fallback uses the authenticated-encrypted envelope in §6 only), no
telecom-layer silent/Flash SMS assumed, SOS never depends on incident
dispatch triage, device secrets never exposed via ordinary API/logs/UI.

ALREADY BUILT — DO NOT RECREATE: DEVLOG.md is the cumulative
record of everything through Sprint 3. Before extending any file it lists
as done, open that actual file from the repo and confirm it
matches DEVLOG's description — don't build on the description alone. Do
not regenerate any of it — build only Sprint 4's new scope. If something
this sprint needs seems missing or unclear from DEVLOG.md, STOP and ask
before generating it from scratch.

Environment note: this session can write and unit-test the SMS/GSM
handler and envelope logic correctly, but has no real GSM modem and no
funded Semaphore account to send an actual message through. Code it
against §6's exact contract; note in DEVLOG.md that live send/receive
verification is a workstation task, not something this session claimed
to have tested end-to-end.

SPRINT 4 — Notification logical/delivery model, FCM registration and
critical-alert path, GSM/SMS fallback (incident/duty/coord/SOS), dedicated
SOS local/SMS fallback path, device lifecycle (§10 Resiliency backlog, S4).

W14 (§9) stays a read-only log against `GET /sms/logs` this sprint and
every sprint after unless explicitly rescoped — the Figma reference's
two-way chat/reply/broadcast console (§8's adopted-patterns list) needs new
send/reply/broadcast endpoints that don't exist in §6; it's an unscoped
backlog idea (§10 item 7), not part of this sprint's SMS fallback work.

Automation to implement exactly per §6 "Notification lifecycle automation":
if no active FCM registration, go straight to SMS with no FCM attempt; FCM
send error/timeout → retry once, then SMS on second failure; FCM sent but
no client ack within 60s → record ack_timeout, do NOT auto-send SMS.

Today's cut — pick exactly ONE:
  [ ] Notification data model: notification / notification_target /
      notification_delivery tables + FCM send path
  [ ] SMS/GSM fallback handlers: /sms/incident-fallback,
      /sms/dispatch-payload, /sms/priority-alert, /sms/coord-ping,
      /sms/duty-status (encrypted-envelope logic; internal-only, never on
      the public API surface)
  [ ] Tanod SOS: POST /tanod-sos + acknowledge/resolve endpoints
  [ ] M12 Critical Alert Overlay (heads-up/banner fallback + local cached
      rendering when local API unreachable)
  [ ] M13 SMS Fallback Confirmation (text reflects actual transport state)

If nothing above is checked and nothing is named in prose, stop and ask
which one before writing any code. If you finish early, end the session
and log it rather than continuing into the next box.

Requirements: offline detection is 3 failed health-check pings, 5s timeout
each, 2s apart (~21s window) before fallback triggers — don't shortcut this
to "immediately on any failure." Sender identity on inbound SMS is always
derived server-side from the registered device mapping; any user ID embedded
in the SMS payload is ignored.

Output: state the exact Today's cut item this session built, at the top.
Then: files changed, endpoints/tables touched, tests performed (FCM
failure actually triggers SMS on the documented schedule against a
mocked/stubbed transport, SOS fires even with the workstation unreachable,
no raw narrative appears in any SMS payload — verify by inspecting the
actual bytes), deviations in DEVLOG.md.
```

---

## Sprint 5 (Weeks 11–12) — Ollama/SEA-LION Setup + AI Health/Queue

```
You are working on Baranguard (uploaded Master Reference is the source of
truth). Non-negotiables: AI is Llama-SEA-LION-v3.5-8B-R via Ollama,
self-hosted, never an external AI API; summary generation never reads raw
text; every AI run records source/target language, model version, status,
and the draft version it operated on (§2 Rule 16).

ALREADY BUILT — DO NOT RECREATE: DEVLOG.md is the cumulative
record of everything through Sprint 4. Before extending any file it lists
as done, open that actual file from the repo and confirm it
matches DEVLOG's description — don't build on the description alone. Do
not regenerate any of it — build only Sprint 5's new scope. If something
this sprint needs seems missing or unclear from DEVLOG.md, STOP and ask
before generating it from scratch.

Environment note: this session can write the queue, the API contract, and
the ai_processing_log integration correctly, but cannot download or run
the actual model — no GPU, no model registry in reach. Don't mark "model
runs" as tested from this session; that verification happens on your
workstation, once, and gets logged there.

SPRINT 5 — Local SLM setup, AI job queue/health handling, translation
pipeline scaffold, voice-to-text scope confirmation (§10 AI & Data Privacy
Core backlog, S5 items — NOT redaction/summary generation itself, that's
S6).

Decide and document this sprint (don't leave implicit): whether voice-to-text
is in scope for the capstone timeline at all, and if so, what "scope" means
(mobile-side transcription vs. server-side) — §10 flags this as a S5–6
"scope confirmation," meaning it's an open decision, not a resolved one.

Today's cut — pick exactly ONE:
  [~] Queue infra: ai_processing_log table + job queue that survives
      Ollama being unreachable
      CODED 2026-09-03, NOT YET VERIFIED. All four boxes built in one
      session at explicit user direction ("only the coding part, later the
      checking") — a deliberate exception to "pick exactly ONE", same
      category as the prior multi-box sessions. The TABLE already existed
      (Sprint 0's baseline migration, confirmed by reading it) — this cut
      added the queue: services/ai/AiJobQueue.php + scripts/ai-worker.php.
      The API never calls Ollama; it only enqueues, which is what makes
      Rule 15 structural. Claiming uses a compare-and-set UPDATE, not
      SKIP LOCKED (MariaDB 10.4). See backend/DEVLOG.md's Sprint 5 entry.
  [~] GET /system/health's ollama field
      CODED 2026-09-03, NOT YET VERIFIED. Upgraded from an env-var-presence
      check to a real probe (GET /api/tags). Reachable-but-model-not-pulled
      is reported `unhealthy`, not `healthy`.
  [~] Translation scaffold: POST /incidents/:id/ai-draft/translate
      (Secretary-only gate + prerequisite check must be real even if the
      translation call itself is stubbed this session)
      CODED 2026-09-03, NOT YET VERIFIED. The gate and the
      approved-redaction prerequisite are both real; the call itself is
      queued rather than stubbed, so it starts working the moment Sprint
      6's approve endpoint lands, with no change here. Response carries
      `language_validated:false` for Bikol (Rule 16).
  [x] Voice-to-text scope decision (document the decision itself, not code)
      RESOLVED 2026-09-03: **OUT OF SCOPE** for the capstone. Voice
      *capture* stays (already built, Sprint 2); *transcription* is out —
      Android's SpeechRecognizer would send audio to Google (Rule 1),
      server-side ASR needs a second self-hosted model SEA-LION can't
      provide, Bikol ASR is even less validated than Bikol text, and voice
      notes already attach as playable evidence. Full reasoning recorded in
      §10 of the Master Reference. Checked [x] because a decision IS the
      deliverable here — there is nothing to verify later. The user can
      overturn it.

Note: the two Sprint 6 endpoints `POST /incidents/:id/redact` and
`GET /incidents/:id/ai-draft` were also built this session — a queue with
no producer and no reader can't be exercised at all. `regenerate-summary`
and `approve` were deliberately NOT pulled forward and remain Sprint 6.

If nothing above is checked and nothing is named in prose, stop and ask
which one before writing any code. If you finish early, end the session
and log it rather than continuing into the next box.

Requirements: AI jobs queue when the workstation/Ollama is unavailable —
no external AI fallback exists, ever, under any failure mode. Bikol is
explicitly unvalidated until empirical testing (§2 Rule 16) — don't let the
UI imply Bikol output is production-quality yet.

Output: state the exact Today's cut item this session built, at the top.
Then: files changed, service configuration, tests performed against a
stubbed/mocked Ollama response (queue survives Ollama restart, health
check accurately reflects real service state), deviations in DEVLOG.md.
```

---

## Sprint 6 (Weeks 13–14) — PII Redaction + Summary Pipeline + Draft Versioning

```
You are working on Baranguard (uploaded Master Reference is the source of
truth). Non-negotiables: AI pipeline order is raw narrative → redaction
draft → summary derived from the draft (never from raw) → Secretary review
→ approval (§2 Rule 16); only the human-approval endpoint may commit
incident.redacted_narrative (§2 Rule 3); draft edits use optimistic
concurrency via draft_version (§2 Rule 23).

ALREADY BUILT — DO NOT RECREATE: DEVLOG.md is the cumulative
record of everything through Sprint 5. Before extending any file it lists
as done, open that actual file from the repo and confirm it
matches DEVLOG's description — don't build on the description alone. Do
not regenerate any of it — build only Sprint 6's new scope. If something
this sprint needs seems missing or unclear from DEVLOG.md, STOP and ask
before generating it from scratch.

Environment note: redaction/summary generation calls the actual model.
This session can build the full pipeline, prompts, and versioning logic
against a stubbed Ollama response, but real precision/recall numbers on
the 200-record evaluation set require the model actually running on your
workstation — don't record estimated numbers in ai_evaluation_run as if
they were measured.

SPRINT 6 — Redaction draft generation, draft-based summary, draft
versioning/concurrency, evaluation dataset + baseline regex comparator,
human approval gate, blotter finalization + amendment controls, Lupon
packet generation (§10 AI & Data Privacy Core backlog, S6 items).

W8's UI (§9, §8's "Adopted UI reference") may follow the Figma reference's
side-by-side input/output panel layout, but every value on screen must come
from a real `ai_processing_log` row for an actual local-Ollama pipeline run —
never a scripted/hardcoded output string, a `setTimeout`-faked "Generating…"
delay with no real request behind it, or a confidence/accuracy number that
isn't backed by a real `ai_evaluation_run`. The model badge names the real
self-hosted model (`ai_processing_log.model_version`) — never a vendor/
hosted-AI name like "Claude AI"; Rule 1/§1 requires self-hosted-only AI, no
exceptions for a demo-quality label.

Target for the evaluation dataset per §10: recall ≥95% / precision ≥90% on
a 200-record evaluation set, benchmarked against a baseline regex
comparator — build the harness this sprint even if the model doesn't hit
target yet; record actual numbers in ai_evaluation_run, don't estimate them.

Today's cut — pick exactly ONE:
  [ ] Redaction pipeline: POST /incidents/:id/redact +
      GET /incidents/:id/ai-draft
  [ ] Draft versioning UI: regenerate-summary + approve endpoints, exact
      draft_version equality enforced, stale draft_summary_stale blocks
      approval
  [ ] Evaluation harness: baseline regex comparator + ai_evaluation_run
      scoring against the 200-record set
  [ ] Finalize/amend/lupon-packet: POST /incidents/:id/finalize,
      /blotter/amend, /lupon-packet

If nothing above is checked and nothing is named in prose, stop and ask
which one before writing any code. If you finish early, end the session
and log it rather than continuing into the next box.

Requirements: approval requires draft_summary_stale=false and exact text
equality against the current draft (§6) — a stale tab must get 409, not a
silent overwrite. Finalized blotter is never silently overwritten; amendment
is explicit, audited, and increments revision_no without deleting the prior
value.

Output: state the exact Today's cut item this session built, at the top.
Then: files changed, endpoints/tables touched, tests performed (stale
draft_version correctly rejected with 409, finalized blotter resists normal
overwrite, evaluation harness produces real precision/recall numbers once
run against the actual model — flag clearly if this session only verified
the harness against stubbed output), deviations in DEVLOG.md.
```

---

## Sprint 7 (Weeks 15–16) — RBAC Hardening + Audit + Retention + Backup/Restore

```
You are working on Baranguard (uploaded Master Reference is the source of
truth). Non-negotiables: every protected endpoint verifies role + tenant +
object-ownership server-side (§2 Rule 6/30); retention periods are the
resolved values in §11's table, not placeholders; a database deletion is
not complete while a retained backup still holds the same data outside its
documented lifecycle (§2 Rule 11).

ALREADY BUILT — DO NOT RECREATE: DEVLOG.md is the cumulative
record of everything through Sprint 6. Before extending any file it lists
as done, open that actual file from the repo and confirm it
matches DEVLOG's description — don't build on the description alone. This
sprint hardens and audits existing endpoints/jobs, it doesn't rebuild
them. If something needed seems missing or unclear from DEVLOG.md, STOP
and ask before generating it from scratch.

SPRINT 7 — RBAC/ownership penetration hardening, audit completeness,
retention/legal-hold jobs, blotter amendment (if not finished in S6),
backup/restore verification, integration/security testing, service health
UI, report export (§10 Data/Operational Hardening + Web Command Center
S7 items).

Retention jobs implementing §11's table exactly: 30-day post-approval
grace / 90-day unapproved ceiling on raw_narrative, 7 years on redacted
incident/blotter/evidence/audit_log, 1 year on unconverted
citizen_report/sms_log/ai_processing_log, 90 days on deactivated
mobile_device — all subject to legal_hold override.

Today's cut — pick exactly ONE:
  [ ] Retention jobs (§11's table, all record types)
  [ ] Audit completeness (§2 Rule 17's full action list actually produces
      audit_log rows)
  [ ] Backup/restore drill (restore is actually tested, not assumed to
      work because a backup file exists)
  [ ] Pen-test pass — ONE resource type only (e.g. incidents, or dispatch;
      testing every §6 endpoint in one sitting isn't a single cut)
  [ ] W17 Audit Log Viewer / W20 Service Health / W9 Export button

W21 System Settings (§9, added in the 2026-09-02 architecture review) is
**not** on this list and not a valid "Today's cut" pick yet — it has no
sprint assignment, schema, or endpoints. If a future session wants to build
it, that's a separate architecture-review step first (confirm which
subsections are actually needed, design real schema/API, update §5/§6/§7),
not something to fold into this or any other existing box.

If nothing above is checked and nothing is named in prose, stop and ask
which one before writing any code. If you finish early, end the session
and log it rather than continuing into the next box.

Requirements: audit metadata is allow-listed — identifiers/statuses only,
never raw narrative or credentials, on every logged action in §2 Rule 17's
list. Backup restore is actually tested this sprint, not assumed to work
because a backup file exists.

Output: state the exact Today's cut item this session worked on, at the
top. Then: files changed, endpoints/tables touched, tenant-penetration
test results (pass/fail per endpoint, not a summary claim), restore-drill
evidence, deviations in DEVLOG.md.
```

---

## Sprint 8 (Weeks 17–18) — UAT + Reliability/Safety/Performance Evaluation

```
You are working on Baranguard (uploaded Master Reference is the source of
truth). This sprint is verification, not new features — do not add scope
that isn't already in §9/§10 without an explicit architecture-review note.

ALREADY BUILT — DO NOT RECREATE: DEVLOG.md is the cumulative
record of everything through Sprint 7. This sprint verifies and evaluates
that existing system — it never regenerates it. Treat DEVLOG.md as the
list of what to test, not what to rebuild — and spot-check its claims
against the actual repo before trusting them for a UAT sign-off.

SPRINT 8 — UAT execution, reliability/safety/performance evaluation,
ISO/IEC 25010:2023 assessment (§11 sprint map).

Required pre-UAT exit conditions to confirm before this sprint counts as
started (§11): executable schema matches §5; every §6 endpoint has a
documented response shape and authorization rule that the implementation
actually matches; tenant penetration tests pass; offline duplicate tests
pass; critical notification/SOS fallback tests pass; restore test passes;
no unresolved P0/P1 reference contradictions remain in DEVLOG.md.

Today's cut — pick exactly ONE evaluation hook or ONE UAT scenario, not
several from the list:
  [ ] Auth/session revocation + lockout evidence
  [ ] Tenant/ownership penetration tests
  [ ] Offline cache durability + duplicate-reconciliation tests
  [ ] Notification end-to-end reliability
  [ ] Sync latency
  [ ] Raw-PII exposure audit
  [ ] GPS/route accuracy
  [ ] Dispatch response-time metric (incident.created_at →
      dispatch.arrived_at, per §6's own definition — don't invent a
      different formula for the UAT report)
  [ ] Offline-map availability
  [ ] Fatigue audit trail
  [ ] Valid JSON contracts (schema-validate every §6 response shape)
  [ ] AI dataset evaluation run records / Bikol language-quality validation
  [ ] SLM inference time / 3+ Android device tiers (workstation-side —
      this session records the methodology, the actual run happens
      outside it)
  [ ] One specific end-to-end UAT scenario (name it in prose)

If nothing above is checked and nothing is named in prose, stop and ask
which one before writing any code. If you finish early, end the session
and log it rather than continuing into the next box.

Requirements: report real measured numbers against each metric above, not
target numbers restated as if measured. Any gap found between this
reference and the actual implementation gets logged in DEVLOG.md and
reconciled into the reference — the reference doesn't get treated as
correct by default just because it's older than the code.

Output: state the exact Today's cut item this session evaluated, at the
top. Then: evaluation results per metric, UAT scenario pass/fail log,
updated DEVLOG.md, and — if this is the last sprint — a final go/no-go
summary against the pre-UAT exit conditions above.
```

---

## Notes on using these

- **Visual/UI reference (added 2026-09-02):** §8 of the Master Reference now
  documents an adopted Figma Make design export as the canonical visual/
  component reference — check its "Adopted UI reference" subsection (and the
  matching per-screen note in §9) before styling any screen, built or new.
  It also lists specific patterns from that export that are explicitly
  **not** adopted because they conflict with rules already in this
  document (a login role-selector, fabricated marketing/trust statistics,
  a "Claude AI" branding claim, hardcoded fake identities, client-side-only
  security/permission toggles, a decorative fake map) — check that list
  before copying anything from the export wholesale.

- **Let Claude Code read the repo directly instead of re-attaching state
  each session.** Put a project `CLAUDE.md` in the repo root that
  `@import`s `Baranguard_Master_Reference_FINAL.md` and `DEVLOG.md` from
  wherever you keep them in-tree, so both load automatically every
  session. DEVLOG still describes what's built rather than proving it —
  before extending anything it lists as done, have the session open the
  actual file and confirm, not just trust the description.
- Keep `DEVLOG.md` as one running, append-only file across all sprints
  (§13 already asks for this). Each entry should open with the exact
  "Today's cut" line that session worked from, then a file tree of what
  changed, then test evidence — not just a paragraph asserting things
  work.
- Each block is self-contained — you don't need to also paste §12's Base
  Prompt separately, it's folded in.
- Every "Today's cut" list is a closed menu now, not an open placeholder.
  Pick exactly one, stop there for the session, and if the session gets
  a blank/unmarked list, it should ask which item before writing any
  code — never default to the whole sprint and never pick for you.
- If you build something in a sprint that isn't in that sprint's scope
  (e.g. you get ahead and start S4 work during S3), that's fine — just
  don't let the model invent scope beyond what §9/§10 actually describe
  for that item, and log which sprint's DEVLOG entry it actually landed
  in so the two don't drift apart.
