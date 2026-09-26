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

## H. 2026-09-24 external business-rules audit — 19 of 36 items CLOSED, rest deliberately deferred

A 36-finding external audit (4 Critical/22 High/7 Medium/3 Low), run against
a business-rules catalogue rather than the live code, was reconciled against
the actual implementation before any fix landed — see `DEVLOG.md`
2026-09-24 (10) for the full reconciliation and every fix's verification
evidence. Several of the audit's own claims were wrong once checked: **C-04
("no backup/DR at all") is REFUTED** — `backend/scripts/backup.sh` and
`restore-drill.sh` already do real encrypted backups and a genuine
restore-and-verify test; the only real gap is scheduler wiring, already
tracked below as C2/B3. Evidence-hash validation and login/logout audit
coverage were also refuted as gaps (both already exist) — only narrower
sub-parts of those findings were real.

**Closed, code-only, verified end-to-end against disposable DBs**: H-04
(fabricated blotter case number in `blotter-detail.js`), H-03 (`GET
/blotter` still allowed Punong Barangay server-side after the list screen
was removed from the web UI), H-01 (a Tanod with an active dispatch could
be double-booked onto a different incident), H-02 (off-duty could be
declared while a dispatch was still active), H-10 (evidence upload trusted
the client's claimed MIME type — magic-byte validation added), H-06/H-07
(audit gaps: failed authorization, the one raw-narrative read, and Lupon
packet/report-export downloads were unaudited).

**Also closed 2026-09-24, second pass (DEVLOG (11))**: H-08 + M-06
(fixed TOGETHER — same root cause: `GpsController::createItem()` now
rejects implausible `accuracy_m` and a future-dated `recorded_at`; did
NOT swap `is_stale`/`age_seconds` to `received_at` as H-08 literally
suggested, since using `recorded_at` there is an existing, deliberate,
documented architecture decision, not an oversight — see DEVLOG for the
full reconciliation), H-22 (SMS segment counter in `sms-monitor.js` now
detects GSM-7 vs UCS-2 and uses the right 160/153 vs 70/67 limits — the
actual send path was already correct; only the operator-facing estimate
was wrong), M-01 (`IncidentsController::nextDisplayId()` now computes
the year in Asia/Manila, not UTC, matching Rule 11).

**Third pass 2026-09-24 (DEVLOG (12))**: L-01 (REFERENCE.md §5 claimed 84
routes; a real count — via the new `backend/scripts/count-routes.php`,
the exact method `public/index.php` itself uses — came to 91, not even
matching the audit's own already-stale "90" comparison; doc updated with
a "this number moves" caveat and a script to check it going forward) and
H-20 (notification delivery had no operator-visible failure signal once
both FCM and SMS fallback tiers were exhausted — `GET /system/health` now
returns a real `notification_delivery_failures_24h` count, surfaced as a
third card on Service Health) were CONFIRMED and fixed. L-02 (the three
specific "stale comment"/"misleading fallback URL" sub-items the audit
cited) and M-05 (route access is unaudited by explicit, documented
design — Rule 8 + noise concerns already reasoned through in
`DispatchController::route()`'s own class doc; route-cache data is
already retention-bound via the incident cascade purge, same as every
other incident-linked artifact) were both REFUTED — already resolved or
already-adequate design, not gaps. Rule 12's FCM-retry-then-SMS ladder
itself (the "durable retry" part of H-20's claim) is real and was NOT a
gap either — only the "what happens after both fail" visibility was
missing.

**Fourth pass 2026-09-24 (DEVLOG (13))**: M-07 (map-package uploads had a
500MB per-file ceiling but no total-per-barangay quota, and superseded
package files are never deleted — added a 2000MB total-per-barangay quota
that rejects new uploads once hit; deliberately does NOT auto-delete old
packages, since `map_package` retention is itself H-15's open question)
was CONFIRMED and fixed. M-02 (user.is_active/is_suspended could in
theory land in a confusing combination) was REFUTED — the login check
already tests both flags and the status-toggle endpoint enforces exactly
one change per call, migration 0011's own doc comment already states
"deactivating always wins." M-04 (hardcoded 4 barangays / dead `lupon`
login role) was REFUTED for the barangay half (documented deliberate
pilot scope, §1) — the `lupon` enum value is confirmed real but harmless
dead cruft (unreachable via login or user-creation, left as-is rather
than spending a migration on pure enum hygiene).

**Fifth pass 2026-09-24 (DEVLOG (14))**: user picked H-05/H-09/H-11/H-12/
H-13/H-14 from the remaining list and answered up front on the ones
needing a decision (AskUserQuestion) before any code. H-11 (no abuse
budget on AI jobs/evidence/GPS/exports/map-packages/SMS broadcast), H-12
(citizen-report abuse protection is IP-only — fixed with duplicate-
content detection + a per-barangay aggregate limit, explicitly WITHOUT a
CAPTCHA/third-party per the user's choice), and H-13/L-03 (transparency
endpoint published properly: real rate limit, Cache-Control, and a web
page) were all CONFIRMED and fixed in this pass. New shared
`rate_limit_counter` table (migration 0023) + `Baranguard\Lib\
RateLimiter` — no generic "N per window" mechanism existed before this.
H-05 (session-storage redesign) and H-09 (hardware-backed device keys)
were also picked but are large enough to be tracked separately — see
below/DEVLOG for their own status once done. H-14 (privacy governance)
is explicitly not code and was deferred to a separate conversation.

**H-05 CONFIRMED and fixed** (DEVLOG (15)): the web JWT now lives in an
in-memory module variable in `apiClient.js`, never written to any Storage
object — an XSS can no longer exfiltrate it from `sessionStorage`.
Disclosed tradeoff: a page reload now signs the user out (previously
survived one within the tab). Real fix (HttpOnly/Secure/SameSite cookie)
needs C-03/F1's HTTPS to be safe cross-origin — see the scoping below,
done as the other half of this same user decision ("do both now").

**C-03/F1 — HTTPS deployment, SCOPED this session, not yet implemented**
(a real infrastructure/domain decision is needed before any of this can
be built, not just code):

> **Superseded 2026-09-26 (ninth pass, below) — the decision this section
> asks for has been made** (a stable hostname is coming, not LAN-only
> forever), and the actual path taken is a 5th option not enumerated
> below: a Cloudflare Named Tunnel, which needs no port-forwarding, no
> local cert issuance/rotation, and no reverse-proxy process of its own
> (Cloudflare terminates TLS at their edge). The reasoning below for
> options 1-4 is kept for historical context in case Cloudflare itself
> ever needs to be reconsidered, but is not the live plan.

The blocker isn't technical difficulty, it's that every real HTTPS option
needs an answer to a question only the deployment owner can give: **does
this system ever get a real, stable hostname**, or does it stay pure
LAN-only with device IPs that can change? The three realistic paths:

1. **Self-signed cert + manual trust install.** Generate a cert for the
   workstation's LAN IP or a `.local` mDNS name, install it as trusted on
   every Tanod phone + every browser that hits the web dashboard. Zero
   ongoing cost, works fully offline, but every new device needs a manual
   trust-install step (no CA can vouch for a private IP), and IP changes
   (DHCP) mean re-issuing. Matches this project's "single workstation,
   LAN-only" architecture (§1) most closely.
2. **A local/private CA + provisioning script.** Same trust-install
   burden as #1 but centralizes cert issuance/rotation instead of a single
   long-lived self-signed cert — more setup work up front, easier to
   rotate later. Worth it only if device churn (new Tanod phones) is
   frequent enough to justify the tooling.
3. **A reverse proxy (Caddy/nginx) in front of XAMPP**, terminating TLS
   and forwarding to the existing `:8081` API / `:80` web — decouples "how
   HTTPS is served" from "how the PHP app runs," and Caddy specifically
   can automate cert issuance/renewal IF there's a real public domain
   (option 4). Adds one more moving part to a workstation that's
   otherwise deliberately simple (§1: "no cloud").
4. **A real domain + Let's Encrypt** — only possible if this deployment
   ever gets a public-reachable hostname, which contradicts the current
   "LAN-only, no fixed public origin" architecture (§1, §2 Rule 7) unless
   that constraint itself changes. Not applicable to the current
   deployment model as documented; revisit only if the LAN-only decision
   is revisited first.

**Decision needed before implementation starts:** does the deployment
model stay LAN-only forever (→ option 1, cheapest, matches current
architecture) or is a stable hostname/public reachability coming at some
point (→ options 3/4 become worth the setup cost)? Also needed:
`GSM_GATEWAY_ENABLED`'s `adb`-over-USB workflow and the mobile app's
`network_security_config.xml` cleartext exception (HANDOFF.md/REFERENCE.md
§8) both assume plain HTTP today — either would need updating once a
concrete option is picked, which is real mobile-side work, not just a
server cert.

**Deliberately NOT started this session** (need a policy call, new
infrastructure, or an explicit architecture-review sign-off, not just
code): C-02 (MFA), C-03 (HTTPS/TLS enforcement + locking down the
mobile/web API-base-URL override — this is the same open item as F1
above, not a new one). **H-09 CONFIRMED and fixed at the code level** (DEVLOG (16)):
`mobile_device.device_public_key_pem` (migration 0024) +
`Baranguard\Lib\DeviceSignature` verify a per-request signature for
evidence upload / GPS / Tanod dispatch-status-updates; SOS deliberately
never rejects on a bad signature (same C-01 priority ordering — a real
emergency must never be lost to a secondary check), only audits it. New
`DeviceKeyPlugin.java` generates the device's Keystore keypair; wired
into every high-value mobile write. Backend fully verified
(`verify-device-signature.sh`, 21/21, real EC keypairs via the openssl
CLI). **Mobile side is code-complete but NOT device-verified** — no phone
was attached this session; `./gradlew assembleDebug` succeeds (compiles/
links) but the actual Keystore generation/signing behavior on real
hardware is unconfirmed. Needs a device session: install the build,
confirm a device registers with a real public key, confirm signed
requests succeed, confirm SOS still works if signing ever fails.

**Seventh pass, 2026-09-26 (user picked "all the H items and M-03" in
one session, with decisions answered up front via AskUserQuestion) — 5 of
7 remaining H items + M-03 CONFIRMED and fixed; 2 explicitly out of a
coding session's scope:**

- **H-15 (retention periods) CLOSED.** Researched the actual standard
  rather than guessing: the National Archives of the Philippines' 2023
  General Records Disposition Schedule sets Daily Time Records at 1 year;
  the NPC's own GPS-tracking guidance says only "as long as necessary for
  the purpose," no fixed number. `gps_track`/`duty_status`/
  `shift_schedule`/`notification` all got a 1-year retention constant
  (`RetentionService::purgeGpsTracks()` etc., migration-free — no schema
  change needed, same pattern every existing rule already uses).
  `map_package` deliberately got NO time-based retention — governed by
  the per-barangay storage quota already added for M-07/H-21 instead, not
  a second competing rule. Real deletion (not just a dry run) verified
  against `verify-sprint7-retention.sh`'s disposable DB with seeded
  400-day/300-day boundary rows — 8 new assertions, all passing. Shift
  schedules needed their own two-table cascade
  (`fatigue_flag`/`shift_swap_request`, both `ON DELETE RESTRICT`), same
  shape as `purgeOneIncident()`'s 5-table cascade, scaled down.
- **H-16/M-03 (incident duplicate/merge, lifecycle states) CLOSED.**
  Migration 0025 widens `incident.status` with `duplicate`/`invalid`/
  `cancelled`/`reopened` and adds `duplicate_of_incident_id`/
  `lifecycle_changed_by`/`lifecycle_changed_at`. New Secretary-only
  `PATCH /incidents/:id/lifecycle` (`IncidentsController::updateLifecycle()`),
  deliberately separate from the existing Admin-only `updateStatus()`
  ("resolved") — a records-custodian judgment call, not a dispatch
  outcome, same reasoning that makes blotter finalize/amend
  Secretary-only. Forward-only transition table (a terminal state can
  only be left via `reopened`, never jumped straight to another terminal
  state). **Merge = link, not delete** (explicit user decision): marking
  an incident `duplicate` requires `duplicate_of_incident_id` pointing at
  a different, same-barangay incident; nothing about the target is
  touched, no row moves, no FK is repointed — both incidents stay
  independently queryable and retained on their own clock. Blocked while
  an active dispatch exists, same guard `updateStatus()` uses.
  Idempotency-Key required, replayed off `audit_log`. New standalone
  `verify-h16-incident-lifecycle.sh`, 30/30 passing, including the
  merge-as-link assertions, the open-dispatch guard, cross-tenant 404,
  and idempotency replay. **Web UI affordance — DONE 2026-09-26 (W21,
  DEVLOG (36)).** `blotter-detail.js` now has a Secretary-only "Case
  lifecycle" card (duplicate/invalid/cancelled/reopened, forward-only,
  duplicate-link cross-navigation) — browser-verified live against real
  disposable data, not just unit-tested. `IncidentsController::show()`
  also gained the three lifecycle fields it had never returned (a real
  gap found while wiring this — the endpoint's own immediate response
  carried them, but a page reload lost them entirely).
- **H-17 (shift minimum-staffing/rest constraints) CLOSED.** User
  decision: at least 1 Tanod on duty per barangay per shift, 8h minimum
  rest, hard-blocked (409/422) rather than a warning.
  `ShiftsController::assertMinRest()`/`assertMinCoverage()`, wired into
  `create()`/`update()` and `ShiftSwapRequestsController::update()`'s
  approval path (both the reassignment branch and the
  release-to-unassigned branch, which is the one that can actually zero
  out coverage). `verify-scheduler-fatigue.sh` extended with 6 new
  assertions proving both directions: unassigning the ONLY covering
  shift is blocked, unassigning one of TWO covering shifts succeeds, and
  unassigning the last remaining one is blocked again. 47/47 passing (up
  from 41/41 pre-existing).
- **H-19 (contact-number consent boundaries) CLOSED as a scope
  clarification, no code change.** User decision: keep
  `incident.complainant_contact_number` (case data under RA 7160,
  Secretary-only per Rule 1's raw-narrative-adjacent protection) entirely
  separate from `sms_subscriber`'s consent tracking (`consent_at`/
  `consent_source`, migration 0018) — the finding was really "these two
  numbers looked like the same kind of thing and weren't," not a missing
  control. Documented in `docs/DATA_INVENTORY.md` §1/§3.
- **H-21 (offline tile licensing) CLOSED — already compliant, no code
  change.** User decision: stay on OSM. Checked `web/src/components/
  LiveMap.js`/`HeatmapMap.js` directly — both already carry the required
  ODbL attribution (`&copy; OpenStreetMap contributors`, linked to the
  copyright page) and the map component's own class doc already
  documents the "online raster, real attribution, moderate use" decision.
  The audit finding was a missing licensing DECISION, not a missing
  attribution string; documented in `docs/DATA_INVENTORY.md`/this file.
- **H-14 (privacy governance) partially closed — documents drafted, DPO
  designation still open.** User decision: draft the documents now.
  Three new files: `docs/DATA_INVENTORY.md` (RA 10173 records-of-
  processing inventory, derived from the real schema), `docs/
  PRIVACY_IMPACT_ASSESSMENT.md` (risk table covering every category in
  the inventory, explicitly flagging C-02/C-03 as NOT mitigated by
  anything in it), `docs/PRIVACY_NOTICES.md` (plain-language notices for
  a citizen reporter / Tanod / SMS subscriber — text only, no UI screen
  renders them yet). **Formally designating a DPO is a barangay council
  action** (a Sangguniang Barangay resolution or equivalent) that no
  coding session can complete — flagged in both new docs as the one
  genuinely open piece of H-14.
- **H-18 (AI evaluation/provenance) partially closed — provenance chain
  landed, eval runs still need hardware.** `ai_processing_log.model_version`
  already existed but recorded nothing about which PROMPT contract
  produced a given draft, so a later prompt-wording change couldn't be
  told apart from a model change when reviewing an old row. Migration
  0025 adds `prompt_template_version`, stamped at all five completion
  points in `AiJobQueue.php` alongside the existing `model_version`
  stamp. **The other half of H-18 — a real eval harness run tied to
  golden cases, prompt-injection tests — is unchanged**: A2/A6's
  8-task eval harness already exists, only redaction has a real run
  (98.26% recall / 75.88% precision), and the other 7 tasks still need a
  friend's faster hardware (`eval-kit/README-FOR-FRIEND.md`) — this is
  the same standing item as HANDOFF.md's "Recommended next step" #3, not
  a new one.

**Eighth pass, 2026-09-26 — C-01 CLOSED.** User picked C-01 next
(explicitly deferred C-02 for this session). Migration 0026 makes
`tanod_sos.latitude`/`longitude` nullable and adds `location_source`
ENUM('live','last_known','no_fix') + `location_recorded_at`.
`TanodSosController::createItem()` no longer hard-rejects a missing GPS
fix (§2 Rule 27's "SOS must never be silently suppressed" now actually
holds): live coordinates are used as before; a missing pair falls back to
the Tanod's most recent `gps_track` row (tagged `last_known`, carrying
that FIX's own `recorded_at`, not "now" — a dispatcher can tell a live
position from a stale one); with no `gps_track` row at all, the SOS is
still created with `location_source='no_fix'` and NULL coordinates — the
alert is never blocked. Providing only ONE of latitude/longitude is still
a 400 (a different failure mode than providing neither). Verified for
real: `verify-sprint4.sh` extended with a new step 4b (8 assertions —
no_fix creation+fan-out, last_known fallback with the fix's own
timestamp, partial-coordinate rejection), 58/58 total (1 pre-existing,
unrelated failure — `NotificationsController`'s Tanod-ack role check
returning 200 instead of 403 for an Admin caller — was already present
before this session and is untouched by C-01; flagged separately, not
fixed as part of this pass). `NotificationDispatcher`'s SOS message
formatting already handled null coordinates gracefully (`formatLocation()`
was already null-safe) — no change needed there. Also re-ran and fixed
one incidental regression from the SAME session's earlier H-17 work: a
swap-approval fixture in `verify-sprint7-audit.sh` released a shift to
unassigned as its only way to exercise the `swap_request_resolved` audit
action, which H-17's new coverage guard now correctly blocks (422) since
it was the shift's only coverage — fixed by naming an explicit
`target_user_id` instead, `verify-sprint7-audit.sh` back to 57/57. C-02
(MFA) and C-03 (HTTPS) remain the only two open Critical findings.

**Ninth pass, 2026-09-26 — C-03 IN PROGRESS, not yet closed.** User
answered the option-4 question from the scoping above: a stable hostname
is coming after all (Tanod/Secretary/PB need to reach the system off the
LAN), reversing the earlier "stay LAN-only" assumption. User registered
a real domain (`baranguardph.win`, Cloudflare Registrar) and added it to
a new Cloudflare account. Built end-to-end and verified live: a
Cloudflare Named Tunnel (`baranguard`) with DNS routes for
`baranguardph.win` (web) and `api.baranguardph.win` (API), both
confirmed serving real content over real Cloudflare TLS (`curl` +
browser test, not just "tunnel started"); `backend/.env`'s
`CORS_ALLOWED_ORIGIN` updated (and a stale leftover Tailscale entry from
the old mesh-VPN era cleaned out); `web/index.html` now auto-derives
`api.<hostname>` as its API base whenever opened from anywhere other
than localhost — verified live in-browser, no manual `?api_base=` link
needed; `mobile/src/services/apiService.ts`'s `DEFAULT_API_BASE_URL`
now defaults to the real domain too, with a new gitignored
`mobile/.env.local` overriding it back to `localhost:8081` for local dev
only. `docs/REFERENCE.md` §1 updated with the full picture.

**Explicitly NOT done yet, so this is not a close**: (1) the tunnel is a
manually-started process, not the Windows service
(`cloudflared service install`) that would survive a reboot — needs an
Administrator terminal, which only the workstation's owner can run; (2)
**no Cloudflare Access policy exists yet** — `api.baranguardph.win` is
currently reachable by anyone with the URL, structurally the same
exposure the Quick Tunnel had, just with a stable address instead of a
rotating one (§2 Rule 7 still applies); (3) `.win` was chosen with the
user fully informed it's a heavily spam/phish-abused TLD (>50% blocklist
rate in industry data) — a real, disclosed risk of browser/security-
software warnings down the line, accepted knowingly rather than
defaulted into. **Also raised and resolved in the same session**: moving
to redundant/cloud hosting was considered as a fix for "the whole system
goes down if the workstation is off" and explicitly rejected by the user
(cost, the GSM gateway's physical hardware dependency, and RA 7160
data-sovereignty questions were all flagged before the rejection) — the
single-workstation-outage risk stands as an accepted, disclosed
limitation, not a resolved one. SOS retains its own workstation-
independent fallback (§2 Rule 27's direct-SMS path) regardless.

**Tenth pass, 2026-09-26, same day — tunnel moved to this machine,
service install DONE.** Turned out the machine the ninth pass ran on was
a different box than the one running this session; user confirmed THIS
machine is the real production workstation and the tunnel should run
here instead. Did not reuse the original tunnel's credentials (an
attempt to fetch its connector token was correctly blocked as sensitive
credential access) — created a fresh tunnel (`baranguard-main`) with its
own locally-generated credentials, re-routed both hostnames' DNS to it
via `--overwrite-dns`, verified live with real `curl` calls. Then
installed it as a real Windows service for real — `cloudflared service
install` alone silently produces a non-functional service for a
locally-managed tunnel (confirmed via Windows Event Viewer: it always
registers with zero arguments, and a hand-written config file gets
overwritten back to a stub on every service start); the actual fix was
setting the service's `binPath` directly via `sc.exe config` to include
`--config`/`tunnel run` explicitly. **Item (1) from the ninth pass's
"not done" list is now closed** — verified by killing every
`cloudflared.exe` process, confirming exactly one remained (the
service), and getting real `200`s with real content from both hostnames.
Item (2) (Cloudflare Access policy) is still open. **New disclosure,
not present in the ninth pass**: this machine's `backend/.env` points at
`baranguard_uiseed` (the demo/seed DB), not the real production database
— by explicit user choice, deferred rather than switched. The public
tunnel currently serves demo data, not real citizen/incident records;
don't conflate "the tunnel is live" with "real data is exposed." The
original `baranguard` tunnel is now orphaned (no DNS points to it) but
was not deleted. Full detail: `backend/DEVLOG.md` 2026-09-26 (27), (28),
(29).

Full disposition of every one
of the 36 findings — confirmed / partially confirmed / refuted, with
file-level evidence — lives only in the audit reconciliation itself (not
re-copied here); ask for it again if picking up more of this audit in a
future session, since re-deriving it from scratch would be wasted work
already done once.

---

## A. Blocked on hardware/accounts — start these first

### ✅ A1. Android device — 6 of 6 PASSED on the Infinix X6840 (2026-09-19/24) — DONE
App runs and reaches the real backend on a physical device (confirmed).
Evidence: `docs/evidence/2026-09-19-device/`, DEVLOG 2026-09-19 (2)–(5), 2026-09-23 (4).
1. ✅ **SQLCipher encrypts the DB file** — header `da db 34 30 …`, not "SQLite format 3". PASS.
2. ✅ **Offline capture survives app kill** — `adb reverse --remove` (workstation truly unreachable), report saved "for retry", `am force-stop`, relaunch → Unsynced reports 1. PASS.
3. ✅ **Photo/voice capture produces a real playable file** — DONE 2026-09-23 on the Infinix X6840. Photo worked first try; voice recording failed ("stat failed: evidence/recording-... does not exist") — a real bug, not a device fluke: `stopVoiceRecording()` was calling `Filesystem.stat()`/`readFile()` on the voice-recorder plugin's own returned `path` with no `directory` option, but that `path` is relative to `Directory.Data`, not absolute (confirmed by reading `capacitor-voice-recorder`'s `VoiceRecorder.java`). Fixed, rebuilt, reinstalled, retried — both photo and voice now save. Pulled both file types via `adb shell run-as ... cat files/evidence/<name>`, verified real magic bytes (`FFD8FFE0...JFIF` for the jpgs, `FFF1...` ADTS/AAC sync word for the recordings), sane non-zero sizes. DEVLOG 2026-09-23 (4).
4. ✅ **Keystore passphrase round-trip** — same force-stop/relaunch reopened the encrypted DB with 2 cached dispatches. PASS.
5. ✅ **M5/M12/M13 on a real screen** — M12 (Critical Alert) **PASS 2026-09-19**: real FCM push → heads-up + in-app NEW DISPATCH sheet → ACKNOWLEDGE → `notification_target.acknowledged_at`. M13 (SMS Fallback badge) **PASS 2026-09-24**: `saved_locally_for_retry` (grey) confirmed when the backup contact wasn't yet cached, then `sent_by_sms` (green) confirmed via `adb shell content query --uri content://sms/sent` showing the real composed message actually sent — not just the app's own claim. `sms_pending`/`sms_failed` states not exercised — a malformed-number attempt to force `sms_failed` was tried 2026-09-24 and found NOT to work; it revealed a real gap instead (DEVLOG 2026-09-24 (7)) — forcing it for real still needs airplane-mode/no-SIM testing. Offline MBTiles: package auto-downloaded on login (2.8MB `barangay-1-v3-real-osm.mbtiles`), rendering with it not separately verified.
6. ✅ **Sync trigger drains a queue** — the queued report from #2 reached the server ~2s after sign-in (`incident_id` 119, `client_event_id` preserved). PASS.

**Found and fixed during this pass (DEVLOG 2026-09-19):** patrol GPS
silently off on a fresh install (no explicit location permission
request); SQLCipher passphrase + `raw_narrative` printed to logcat by
Capacitor's default bridge logging (`loggingBehavior` now `'none'`);
cold-start DB open race leaving Home empty; "15s" GPS label vs real 30s.
**Found, not fixed — needs a decision:** a Tanod offline >15 min who
cold-starts is sent to Login and cannot reach cached dispatches (JWT TTL
+ `RequireSession`'s local `exp` check). See DEVLOG 2026-09-19 (4).

**The three 2026-09-22 "code only, not device-verified" bug fixes — all
confirmed 2026-09-23**, using real dispatches created via the API
(INC-2026-121/122/123) against `tanod.reyes`'s live device session:
heads-up-dismiss-on-ACKNOWLEDGE and the duty-unknown offline label both
worked exactly as designed. **The dispatch-card refresh-on-resume fix was
found BROKEN** — it re-read `listActiveCachedDispatches()`, a local cache
that's written in exactly one place in the app (`assignments.tsx`'s own
mount), so a dispatch arriving while the Tanod stayed on Home never
actually reached the card until Assignments was separately visited. Real
fix: `home.tsx`'s `refreshActiveDispatches()` now calls `getDispatches()`
+ `cacheDispatchesFromServer()` first, same pair Assignments already
uses. Rebuilt, reinstalled, re-tested on device — confirmed working. See
DEVLOG 2026-09-23 (4)/(5). **Lesson**: a code-only fix logged without a
device to verify it can be wrong in ways `tsc`/Gradle can never catch —
this was a cross-screen data-flow gap, invisible to any type checker.

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

### ✅ A4. Real FCM + local GSM outbound SMS — DONE 2026-09-24
Firebase project `baranguard-acb27` is wired and **a phone has now
actually buzzed**: dispatch 71's critical push landed on the Infinix
within ~1s of `notification_delivery` 26 `fcm/sent` (DEVLOG 2026-09-19
(4)).

**Semaphore REMOVED 2026-09-23** — explicit user decision, a paid
per-SMS aggregator cost too much for this project's actual volume.
Replaced by a local GSM gateway: the SAME tethered phone that does GSM
inbound ingestion (A5) now also sends, via a small companion Android app
(`sms-gateway/`, its own standalone Gradle project — `SendSmsReceiver.java`
calls `SmsManager` directly on this phone's own SIM) triggered over `adb
shell am broadcast` from `LocalGsmOutboundClient.php`. Backend wiring
complete: `SmsGatewayService`, `SystemHealthController` (`sms_gsm_gateway`
replaces `sms_semaphore`), `SettingsController` (the now-vestigial
`sms_gateway.api_key`/`sender_name` keys removed), and `.env.example`
(`GSM_GATEWAY_ENABLED`/`GSM_GATEWAY_ADB_PATH`/`GSM_GATEWAY_DEVICE_SERIAL`)
all updated. `php -l` clean throughout, `web/tests` 398/398,
`verify-web-wiring.mjs` 555/555.

**Real end-to-end device verification, 2026-09-24**: two independent
real SMS sends through the actual `LocalGsmOutboundClient::send()` class
(not a manual reproduction), `correlation_id` confirmed matching between
the PHP call and the device's own logcat both times. Along the way, found
and fixed a real bug — `adb shell` re-joins its own arguments with a
single space before sending to the remote Android shell, which was
corrupting `correlation_id`/`body` (arrived as literally `"unknown"`) —
fixed by building the whole remote command as one POSIX-shell-quoted
string. Also surfaced two device-specific quirks worth remembering for
any future gateway-phone setup: a freshly-installed app is in Android's
"stopped" state and won't receive even an explicit broadcast until
launched once (now in `sms-gateway/README.md`'s setup steps); this
specific Infinix/XOS build has its own proprietary background-app-freezer
(`Usf_Hiber`) separate from stock Doze that can delay broadcast delivery
to a backgrounded app.

**Subprocess-timeout gap — CLOSED 2026-09-24.** `exec()` had none, and a
`proc_open()`-based timeout was tried first and found NOT to work on
Windows PHP (`stream_set_blocking()` is a documented no-op for
`proc_open` pipes there). Real fix: shells out to `powershell.exe`,
which starts `adb.exe` via .NET's `Process` and waits with
`Process.WaitForExit(ms)` — a genuine OS-level timeout unrelated to the
broken PHP mechanism. Device-verified in stages: an isolated `adb shell
sleep 30` capped at 3s was killed in 4.0s (`exitCode=124`); a fast real
command still succeeded normally; and real sends through the actual
production class confirmed the kill only stops the LOCAL wait — a
device-side `SUBMITTED` still landed at the same moment the PHP call
gave up, meaning a "timeout" failure here means "we stopped waiting,"
not "nothing happened on the phone." The 12s cap is a real, disclosed
tradeoff (keeps an SOS request from hanging a full minute) — on this
specific device's aggressive OEM background-app-freezer, a legitimate
send can occasionally still report failed even though it completes on
the phone moments later. DEVLOG 2026-09-24 (5).
DEVLOG 2026-09-23 (3)-(7), 2026-09-24 (1).

### ✅ A5. GSM modem hardware — DONE 2026-09-23
`--status` reaches the tethered Infinix; the real `content query` output
matches the fixture's shape (one parser gap — multi-line bodies — fixed,
DEVLOG 2026-09-19 (3)). Last step closed: sent the fixed test envelope as
a real SMS from a second phone to the Infinix's own SIM number, confirmed
it landed in the real inbox (`adb shell content query`), ran
`--once` for real — correctly REJECTED as expired/replayed (this
fixture's `message_id` was already recorded from the 2026-09-18
stand-in test, and its `expiry` had long passed). That's the correct,
proven outcome, not a null result: every piece of the real hardware path
— carrier SMS delivery, `adb`/`content query`, the daemon's forward
logic, the backend's envelope validation — has now been exercised
end-to-end against real hardware. DEVLOG 2026-09-23 (6).

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
- ✅ **B3. Restore drill — DONE 2026-09-26.** Real run, 12/12: fresh encrypted backup, checksum verified, restored into a disposable `_drill` database, fingerprinted against live (30 tables, every row count matching, 66 FKs). `GET /system/health`'s `restore_test_at`/`backup_last_success` confirmed populated — W20 no longer shows "Never". Now also runs weekly on its own via C2's `BaranguardRestoreDrill` scheduled task.
- ✅ **B4. Sprint 3 backend verification** — DONE 2026-09-13, 38/38. Found and fixed a real bug: `GET /incidents/nearby` 500'd on every call (reused named PDO param under native prepares) since the day it was built — nothing static or previously-dynamic had ever caught it.
- ✅ **B5. Non-Admin roles in a browser** — DONE 2026-09-13. Found and fixed a real bug: PB's dashboard "Tanods On Duty" panel 403'd unconditionally (called an Admin-only endpoint for both roles).

---

## C. Real gaps in shipped behaviour

- ✅ **C1. Backup file expiry** — DONE. Refuses to prune any backup file at/after the earliest active legal-hold timestamp; fails closed.
- ✅ **C2. Scheduling — DONE 2026-09-26.** Turned out NOT to need an Administrator prompt after all (a bare `Register-ScheduledTask` succeeds under an ordinary user for a task that only needs to run while logged on, which this workstation already must be). Two new Scheduled Tasks, registered and verified firing for real via `Start-ScheduledTask` (`LastTaskResult`=0 both): `BaranguardBackupRetention` (daily 02:00 — `backup.sh` then `retention-job.php` for real) and `BaranguardRestoreDrill` (weekly Sunday 03:00 — `restore-drill.sh`). Found and fixed a real bug along the way: `backup.sh`'s legal-hold pruning query had referenced a `citizen_report.created_at` column that table has never had (it's `submitted_at`) — every prune had silently failed closed since the script was written. See `backend/DEVLOG.md` 2026-09-26 (35).
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
- 🟢 **C7 — RECLASSIFIED 2026-09-23, real fix implemented AND device-verified working 2026-09-24.** Not a process death — that's settled (405s and 35min locked-screen runs both survived clean). The real issue: `gps_track` showed the last fix landing 4 seconds before screen-lock, then nothing for ~36 minutes, while the service stayed alive and healthy-looking. **Root-cause research** (Android's own docs, not a guess): `foregroundServiceType="location"` alone is NOT sufficient for a service to keep receiving fixes once the app itself drops out of the foreground — it also needs `ACCESS_BACKGROUND_LOCATION`, which this app never declared or requested. Implemented: manifest permission + `PatrolLocationPlugin.requestBackgroundLocationPermission()` (Capacitor declarative permission API) + wired into `startPatrolTracking()`. Device-verified GRANTED via `dumpsys package` (the permission dialog *looked* like "while using the app" to the person watching it, but the actual OS grant state said otherwise — trust `dumpsys`).

  **Retest result (corrected — an initial live-poll read of "inconclusive" was wrong, a sync-delay artifact, not a real stall):** querying `gps_track` fresh after the test window shows a CONTINUOUS chain of real fixes from screen-lock through 17 minutes later, every ~30-90s, normal 8-30m accuracy throughout — dramatically different from the original bug's 4-second stall. This is real, measured evidence the fix works, though not proof beyond all doubt — a longer outdoor/moving-patrol run (see the GPS moving run box below) would strengthen confidence further and can be combined with it. The recurring `FusedLocation: ... blocked - too close/too fast` log lines seen during testing turned out to be a red herring, not a real block — real fixes kept landing throughout despite them. DEVLOG 2026-09-23 (7), 2026-09-24 (2)-(3).

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

1. **GPS moving run, outdoors** — a Tanod walking a known Dao street with the app on duty, comparing `gps_track` against the road. Can double as further confidence-building on C7's fix (already device-verified working for a 17-min stationary locked-screen indoor run, 2026-09-24) — a longer/moving/outdoor run only strengthens that, doesn't need to re-litigate it.
2. ~~C2 (scheduler wiring) + B3 (real restore-drill passphrase)~~ — **both DONE 2026-09-26**, see sections B/C above.
3. **A2/A6** — hand `eval-kit/` to a friend's hardware for the other 7 model tasks (the redaction `ai_evaluation_run` row is done, 2026-09-18).
4. **M13's `sms_failed` — fixed at the code level 2026-09-24, still needs a device retest.** The gap found the same day (a malformed backup number made `SmsManager` silently drop the send while the app reported `sent_by_sms` — false confidence, zero trace in `content://sms/*`) is now closed two ways: `SettingsController::update()` rejects a malformed `sos_fallback.backup_contact_number` with 400 before it can ever reach the phone (verified against the real, disposable `baranguard_uiseed` DB — malformed → 400, valid PH number → 200, empty-to-unset → 200); `SosSmsPlugin.java` independently re-checks the same PH-mobile-number shape before ever calling `SmsManager`, AND now uses a real `sentIntent`-based result instead of trusting the synchronous return, so a genuine carrier-level rejection (airplane mode, no SIM, no service) will report `sms_failed` for real instead of a false `sent`. `./gradlew assembleDebug` BUILD SUCCESSFUL. **Not yet device-verified** — no phone was attached this session; still needs an on-device retest (malformed number should reject immediately client-side too; airplane-mode/no-SIM should now produce a real `sms_failed`).
5. **Two fixes from the 2026-09-24 pre-commit code review, both reasoned-but-not-device-verified** (DEVLOG 2026-09-24 (9)):
   - `LocalGsmOutboundClient.php`'s `runWithTimeout()` Windows `Start-Process` argument-quoting fix — needs a real send through the gateway phone with a `"` character in the message body/number to confirm it no longer gets corrupted (the previous `-ArgumentList` array form was silently space-joined by PowerShell 5.1 before `adb.exe` re-parsed it).
   - `patrolLocationService.ts`'s battery-optimization/background-location permission sequencing fix — needs a fresh-install device retest to confirm the background-location system dialog now reliably surfaces on `startPatrolTracking()` (previously fired un-awaited alongside the battery-exemption request on the same host Activity).
6. Then whichever Sprint 8 box a real device unblocks next.

**A5, A4 (including its subprocess-timeout gap), C7, A1 (6/6), and M13's primary success path closed 2026-09-23/24; M13's `sms_failed` gap fixed at the code level 2026-09-24 (see above) — the stale `sosFallbackContact.ts` doc comment and `maps.test.mjs`'s SOS-clustering regression (re-ran clean, 398/398, evidently a flake — not reproduced) are also resolved.** None of these are on this list anymore.
