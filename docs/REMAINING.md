# Baranguard — Everything left before Sprint 8

Sprints 0–7 complete. Legend: 🔴 blocks Sprint 8 · 🟠 needed for credible UAT · 🟢 polish.

Full forensic detail for anything marked ✅ below lives in `backend/DEVLOG.md`
(grep by date/keyword) and, for the 2026-09-07 audit items, `docs/AUDIT_2026-09-07.md`.
Don't re-derive it here — this file tracks what's still open, not the story of how closed items got closed.

---

## F. 2026-09-07 audit remediation — F1 REOPENED 2026-09-15, rest CLOSED

F2/F3 (stored XSS via unescaped `innerHTML`, 12 files — shared
`escapeHtml.js`), F4 (evidence upload — built end-to-end, `POST
/incidents/:id/evidence`), F5 (`PATCH /incidents/:id` idempotency —
replay via `audit_log`), F6 (`is_suspended` not checked on authenticated
requests — mirrors `is_active`), F7 (walk-in blotter unredacted-PII
exposure — closed by removing `POST /blotter` entirely, 2026-09-10, DILG
BIMSS overlap), F8 (`avg_response_time_minutes` double-counted
multi-dispatch incidents — de-duped via `MIN(arrived_at)` per incident),
F9 (blotter `200 []` — moot, endpoint removed; SMS broadcast idempotency
lookup — indexed via migration 0019) all stay closed, proven with
dedicated verify scripts (see §9 of `REFERENCE.md`).

**F1 (API base URL, both mobile+web) — REOPENED.** Closed 2026-09-13 via
a private-mesh VPN; that VPN was decommissioned 2026-09-15 and nothing
persistent replaces it — see `REFERENCE.md` §1 and `DEVLOG.md`'s
2026-09-15 entry. Current state is plain LAN-only reachability again,
with a Cloudflare Quick Tunnel available for temporary remote testing
only (ephemeral hostname, no Cloudflare-side auth — not a production
access path). **Outstanding, not blocking**: Windows Firewall has no
inbound rule for port 80 (only 8081) — user has the
`New-NetFirewallRule` command to run.

---

## A. Blocked on hardware/accounts — start these first

### 🟡 A1. Android device — 4 of 6 PASSED on the Infinix X6840 (2026-09-19), 2 open
App runs and reaches the real backend on a physical device (confirmed).
Evidence: `docs/evidence/2026-09-19-device/`, DEVLOG 2026-09-19 (2)–(5).
1. ✅ **SQLCipher encrypts the DB file** — header `da db 34 30 …`, not "SQLite format 3". PASS.
2. ✅ **Offline capture survives app kill** — `adb reverse --remove` (workstation truly unreachable), report saved "for retry", `am force-stop`, relaunch → Unsynced reports 1. PASS.
3. ⬜ **Photo/voice capture produces a real playable file** — still open; needs the camera/mic permission taps on the phone, then `adb shell run-as ph.baranguard.tanod cat files/evidence/<uuid>.jpg > photo.jpg`.
4. ✅ **Keystore passphrase round-trip** — same force-stop/relaunch reopened the encrypted DB with 2 cached dispatches. PASS.
5. 🟡 **M5/M12/M13 on a real screen** — M12 (Critical Alert) **PASS 2026-09-19**: real FCM push → heads-up + in-app NEW DISPATCH sheet → ACKNOWLEDGE → `notification_target.acknowledged_at`. M13 (SMS Fallback badge) still untested (needs Semaphore or a real SMS path). Offline MBTiles: package auto-downloaded on login (2.8MB `barangay-1-v3-real-osm.mbtiles`), rendering with it not separately verified.
6. ✅ **Sync trigger drains a queue** — the queued report from #2 reached the server ~2s after sign-in (`incident_id` 119, `client_event_id` preserved). PASS.

**Found and fixed during this pass (DEVLOG 2026-09-19):** patrol GPS
silently off on a fresh install (no explicit location permission
request); SQLCipher passphrase + `raw_narrative` printed to logcat by
Capacitor's default bridge logging (`loggingBehavior` now `'none'`);
cold-start DB open race leaving Home empty; "15s" GPS label vs real 30s.
**Found, not fixed — needs a decision:** a Tanod offline >15 min who
cold-starts is sent to Login and cannot reach cached dispatches (JWT TTL
+ `RequireSession`'s local `exp` check). See DEVLOG 2026-09-19 (4).

**Environment gotchas already paid for (don't rediscover)**: Windows
Firewall blocks inbound to the dev port by default (`New-NetFirewallRule`
needed). Android blocks cleartext HTTP (API 28+) — needs
`network_security_config.xml` (this project is intentionally LAN-only, no
TLS). Capacitor's `https://localhost` origin fetching a plain `http://`
backend is ALSO blocked by WebView mixed-content policy, separately from
the OS policy — fix is `server.androidScheme:'http'` in
`capacitor.config.ts`; symptom is an opaque `TypeError: Failed to fetch`.
`ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` must be declared in the
manifest or geolocation silently fails (broke SOS/Live Map/"Use Current
Location" all at once). Vite needs `server.host:true` + the real LAN IP
in `.env.local` (not `localhost`, which means the phone itself from the
WebView's perspective). **Gradle uses `JAVA_HOME`, not `java` on PATH** —
if it's pointed at the wrong JDK, `./gradlew --stop` then re-export
`JAVA_HOME` before `assembleDebug`. To debug a swallowed fetch failure:
`adb logcat -d | grep -i capacitor` after a temporary `console.error` in
`apiService.ts`'s catch block.

### 🟠 A2. AI model end-to-end run — SUBSTANTIALLY UNBLOCKED, real numbers exist for 1 of 8 tasks
This workstation cannot complete a generation within Ollama's 300s
timeout (confirmed, not assumed) — needs a friend's faster hardware via
`eval-kit/` (self-contained, `.bat`-launchable, paces/checkpoints itself).
**Redaction got a real completed run 2026-09-14**: recall 98.26% (meets
≥95% target), precision 75.88% (misses ≥90% target). Bikol is the
weakest-recall language bucket (96.90% vs ~98.85% en/tl); all 13 leaks
came from "ordinary" records, zero from the 7 engineered hard-case
categories. **The `ai_evaluation_run` row is now written to both real
DBs** (2026-09-18, `evaluation_run_id=1` in both `baranguard` and
`baranguard_uiseed`; migration 0021 applied for real at the same time).
Still open: Bikol human spot-check not done; **the other 7 of 8 model
tasks have a harness+dataset ready (A6, closed) but no real run yet** —
same friend's-hardware next step.

### ✅ A3. 200/350-record eval dataset — DONE, generated not hand-authored
`generate-eval-dataset.php` (template+pool synthesis), self-validated.
Deviates from `AI_Evaluation_Dataset_Guide.md`'s original hand-labeling
plan by explicit user decision — disclosed in the dataset's own
`generation_method` field. Recommended, still open: a human spot-check,
especially the Bikol subset.

### 🟡 A4. Real FCM + Semaphore credentials — FCM DONE 2026-09-19, Semaphore still none
Firebase project `baranguard-acb27` is wired and **a phone has now
actually buzzed**: dispatch 71's critical push landed on the Infinix
within ~1s of `notification_delivery` 26 `fcm/sent` (DEVLOG 2026-09-19
(4)). Semaphore: still no funded account, `sms_semaphore:
not_configured` in `/system/health`, the SMS rung of Rule 12's fallback
ladder remains logically-verified only.

### 🟢 A5. GSM modem hardware — adb path verified 2026-09-19, one real envelope SMS still to send
`--status` reaches the tethered Infinix; the real `content query` output
matches the fixture's shape (one parser gap — multi-line bodies — fixed,
DEVLOG 2026-09-19 (3)). Last step: send one real envelope SMS from a
second phone and run `--once` against it.

### ✅ A6. All 8 model tasks now have an eval harness — DONE 2026-09-14
Was: only `redaction` (1 of 8 `AiPrompts.php` task types) had ever been
scored. Rebuilt: dataset grew to 350 records across 7 language buckets
(3 pure + 4 code-mixed, since Bicol-region users typically code-switch);
new scorer classes (`backend/services/eval/`, 33/33 unit-checked);
`ai-evaluate.php` generalized to `--task=` dispatch; migration 0021 added
generic metric columns (applied for real to both `baranguard` and
`baranguard_uiseed` 2026-09-18); `eval-kit/` is now generated, not
hand-maintained (fixed a real
drift bug — it was missing 4 of 8 prompt methods). Provisional targets
researched, not yet empirically validated. **Not done**: no real model
run against the 7 new tasks yet (same friend's-hardware step as A2); human-rated translation/summary samples haven't happened.

---

## B. Verification a coding session can do now

- ✅ **B1. Browser-verify every screen** — DONE 2026-09-13. Every screen renders real data, zero console errors, against real `baranguard_uiseed` data.
- ✅ **B2. Pen-test dispatch/shifts/citizen-reports/SMS** — DONE 2026-09-13, 59/59 (`verify-b2-pentest-remaining-resources.sh`). Incidents already had 68/68.
- 🟠 **B3. Run the restore drill with your own passphrase** — still shows "Never" on W20 (drill itself proven 12/12, just needs a real run): `BACKUP_ENCRYPTION_PASSPHRASE=your-passphrase bash backend/scripts/restore-drill.sh`
- ✅ **B4. Sprint 3 backend verification** — DONE 2026-09-13, 38/38. Found and fixed a real bug: `GET /incidents/nearby` 500'd on every call (reused named PDO param under native prepares) since the day it was built — nothing static or previously-dynamic had ever caught it.
- ✅ **B5. Non-Admin roles in a browser** — DONE 2026-09-13. Found and fixed a real bug: PB's dashboard "Tanods On Duty" panel 403'd unconditionally (called an Admin-only endpoint for both roles).

---

## C. Real gaps in shipped behaviour

- ✅ **C1. Backup file expiry** — DONE. Refuses to prune any backup file at/after the earliest active legal-hold timestamp; fails closed.
- 🟠 **C2. Nothing is scheduled** — `retention-job.php`/`restore-drill.sh` are CLI-only by design; wiring to Windows Task Scheduler needs a human at the keyboard (system-settings change, not a coding-session action).
- ✅ **C3. Mobile SOS button** — DONE, code-complete. Online-first via `apiService.postSos()`, offline fallback queues and drains through `/sync/batch`. Device-unverified (A1).
- **C4. Smaller known gaps**:
  - ✅ LineChart null-vs-zero data gap — DONE 2026-09-13.
  - ✅ Evidence download from W7 — promoted to F4, closed.
  - ✅ On-device SMS sending (M13) — DONE 2026-09-13, see G1.
  - ✅ M12 native-alert handoff — **DONE 2026-09-15**. The native full-screen Activity already existed; the real gap was "Open Baranguard" cold-launching with no context. Fixed: `notification_id`/`notification_type` now thread from the FCM payload through `CriticalAlertNotifier`→`CriticalAlertActivity`'s static handoff→`FullScreenAlertPlugin.getPendingAlert()`→`criticalAlertStore.ts`'s `checkForPendingNativeAlert()` (called from `App.tsx` mount). `tsc --noEmit` + Gradle Java compile both clean. Still needs A1's device pass to confirm the overlay shows real content after tapping "Open Baranguard."
  - ✅ M7 Live Map rendered basemap — DONE 2026-09-12 (MapLibre GL JS in the WebView, MBTiles-first/OSM-fallback). Offline MBTiles path itself still device-unverified (A1).
  - ✅ Full turn-by-turn routing — DONE 2026-09-13 (OpenRouteService, after OSRM/Google Routes both proved non-viable — see `OrsClient.php`'s doc block). `GET /dispatch/:id/route`, 23/23 incl. real-ORS block. Device-unverified (A1).
  - **react-router v6→v8 npm-audit bump — investigated 2026-09-15, staying deferred.** Two real CVEs (open redirect, SSR constructor injection), but `@ionic/react-router` hard-caps `react-router` to `>=6.4.0 <7` in every published build including the newest nightly — no Ionic release tolerates v7/v8 yet, so bumping would force a peer-incompatible install against the exact router internals C6 was just fixed on. Also: neither CVE's attack surface exists here (no `<Link>`, no user-controlled `navigate()` targets, no SSR anywhere in this Capacitor stack). Revisit via `npm view @ionic/react-router peerDependencies` once Ionic widens it. `@capacitor/cli`/`xcode` stay deferred too (iOS-only, inert here).
  - ✅ Cypress 13→16 bump — DONE 2026-09-13, cleared 3 advisories.
- ✅ **C5. No-Firebase device couldn't register** — DONE 2026-09-13. `fcm_token` made optional server-side.
- ✅ **C6. Login left old screen stuck over Home** — DONE 2026-09-15, real-device-verified. Root cause: `@ionic/react-router` 9.0.3 mishandles a tab shell mounted at a root-level `path="/*"` catch-all (treats it as matching every pathname, skips the real page transition). Fix: shell moved to `/tabs/*` with relative children. **General lesson, worth remembering beyond this bug**: never mount an Ionic tab shell at a root catch-all; `location.pathname` being correct doesn't prove the screen is — read the outlet's actual view stack. Full forensic detail (DevTools-over-adb technique, proof sequence): `backend/DEVLOG.md` 2026-09-15.
- 🟡 **C7. App process dies ~50s into patrol GPS — did NOT reproduce on the Infinix X6840 itself (2026-09-19).** With location actually granted and `PatrolLocationService` confirmed running (`dumpsys`), PID 29418 survived 405s of foreground GPS — GPS rows every ~30s, a critical push handled mid-patrol — until deliberately force-stopped. A screen-off run on the final build followed (see DEVLOG 2026-09-19 (6) for its result). Important caveat discovered on the way: after any `pm clear`, the app was going "on duty" with NO location permission and no GPS at all while still displaying "Foreground GPS" — so any earlier C7 run done after a data clear wasn't exercising GPS. Now fixed (explicit `requestPermissions`). Still not on the battery-optimisation whitelist and no exemption is requested; if a long locked-screen run ever shows the kill, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` remains the leading fix.

---

## D. Unbuilt screens

- ✅ W10 User Management, W18 Map Package Management — both built.
- ⚠️ **W21 System Settings — narrow, deliberate exception, not full-scope.** Migration 0012 + `SettingsController` cover exactly `sms_gateway.api_key`/`sender_name` + three `general.*` display keys, masked on read, under explicit user authorization. **Does not extend** to `DEVICE_SECRET_MASTER_KEY`/`INTERNAL_SERVICE_TOKEN`/`JWT_SECRET`/`FCM_SERVICE_ACCOUNT_PATH` — those stay in `.env`. A future session must not "complete" W21 by moving those without the same explicit sign-off. Full Notifications/Security/GIS/Backup settings remain unbuilt (§2 Rule 6 bars shipping controls that do nothing).

---

## G. Recommended enhancements (not Sprint 8 blockers)

**G1-G4 (logic-gap fixes) — all resolved.** G1 SOS third-fallback SMS
tier: built 2026-09-13, code-complete, real on-device SMS delivery not
yet confirmed. G2 `sms_log.legal_hold`: done. G3 device retention scrubs
instead of deletes: done. G4 `incident.source` discriminator: closed as
obsolete (its use case no longer exists post-F7).

**Feature backlog — nearly all done, condensed:**
- ✅ Nearest-Tanod ranking, stale-pending escalation, backup/second responder (unbounded concurrent dispatches, explicit sign-off) — all done 2026-09-12/13. Second-responder work also found+fixed 3 fabricated-data UI fallbacks and a Dispatch-Center per-dispatch-not-per-incident card bug.
- ✅ Redaction diff view, evidence-access audit log, Lupon packet verification hash — all done.
- ✅ Health-check history (state-change log, not a time series), backup-staleness W20 badge (was defined nowhere in CSS — fixed) — both done.
- ✅ Closing-the-loop SMS to citizen reporters, two-way SMS console, barangay-wide advisory broadcast (consent-tracked, `sms_subscriber`) — all done.
- ✅ Aggregated public transparency report (`GET /public/transparency`, counts only, categories <5 pooled) — done. **Genuinely open policy question, not resolved by any fix**: whether a response-time figure belongs in a *public* report at all (unrelated to F8's now-fixed double-count).
- **Periodic PB digest — content half already exists** (`GET /reports/export?format=pdf`), periodic half blocked on C2 (nothing is scheduled).
- ✅ Client-side photo compression — done alongside F4.

---

## Sprint 8 — every device-free/AI-free box done 2026-09-17/18

Dispatch response-time metric, Valid JSON contracts, Auth/session
revocation + lockout, Tenant/ownership pentest (non-incident resource),
Raw-PII exposure audit, Fatigue audit trail, Offline-map availability
(server side), and one end-to-end UAT scenario (citizen report →
resolution) are all done with real evidence — see `backend/DEVLOG.md`
2026-09-17/18 entries. **Remaining Sprint 8 boxes are genuinely
hardware/AI-blocked**: offline cache durability, notification e2e
reliability, GPS/route accuracy, AI dataset evaluation, SLM inference
across device tiers — none attempted without the real device/friend's
hardware they need.

## Current priority

1. **C7** (patrol-GPS process death) — needs the Infinix X6840 in hand to reproduce for real; see C7's entry above for the exact next diagnostic step.
2. **A1's six-item checklist** — in progress, device-driven.
3. **A5's last check** — real `adb shell content query` against the tethered phone; daemon itself is built and proven (see A5 above).
4. **C2** (scheduler wiring) + **B3** (real restore-drill passphrase) — quick, both need a human at the keyboard for the final step.
5. **A2/A6** — hand `eval-kit/` to a friend's hardware for the other 7 model tasks (the redaction `ai_evaluation_run` row is done, 2026-09-18).
6. Then whichever Sprint 8 box a real device unblocks next.
