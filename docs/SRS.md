# Baranguard - Software Requirements Specification

Purpose: states what Baranguard must do and the limits it works within.
Status/Last updated: 2026-10-28 (written 2026-10-23).

Format follows ISO/IEC/IEEE 29148:2018 (check the edition with your adviser).
Extracted from `REFERENCE.md`, `WORKFLOWS_AND_RULES.md` (Parts 3 and 7),
the thesis-objective section of `TRACEABILITY_MATRIX.md`, `backend/routes/*.php` and `chapter4-instruments/09-consolidated-uat.html`.
Nothing here is new design. Where sources disagree, `REFERENCE.md` and the later WORKFLOWS rules win
(see section 9). Test mapping is in `TRACEABILITY_MATRIX.md`.

## 1. Introduction

### 1.1 Purpose
This document states what Baranguard must do and the limits it works within, for the developer, the
capstone panel, the four barangays and whoever maintains it after turnover.

### 1.2 Scope
Baranguard is an offline-first Barangay Intelligence and Emergency Dispatch System for four barangays
of Pilar, Sorsogon: Dao (1), Binanuahan (2), Marifosque (3), Banuyo (4). It is a production system on
a locally hosted workstation (one workstation per barangay, Rule 92), made of:
- a PHP 8.2 REST API (`/api/v1`, MariaDB 10.4);
- a web dashboard (vanilla JS) for the Chief Tanod (Admin), Secretary and Punong Barangay;
- an Android app (Ionic React + Capacitor, encrypted SQLite) for the Tanod, with a console mode for the Chief Tanod;
- a tethered Android SMS gateway phone.

Out of scope (removed or never built; do not specify or test them): the Electronic Blotter, the Lupon
packet, the AI/Ollama pipeline, Fatigue Flags (migrations 0029, 0042), the public citizen report form and
the Citizen Reports inbox (0036, 2026-10-17), in-app report approval and signature tracking (0041),
MFA (C-02, deferred), a two-way SMS console, voice-to-text, any resident-facing channel.

### 1.3 Definitions
Admin = Chief Tanod account. SOS = tanod panic alert. "Rule N" = numbered rule in `WORKFLOWS_AND_RULES.md`
Part 3/7; "REF Rule N" = rule in `REFERENCE.md` section 2. BIMSS/BIMS/KPIS = DILG's Barangay Information
Management System and its Katarungang Pambarangay subsystem. Every FR below is priority Must unless marked S (should).

### 1.4 Thesis objectives referenced
- **O1** GIS web command center: near-real-time responder tracking (by polling) and historical heatmaps.
- **O2** Offline-first tanod mobile app: encrypted local queue, idempotent sync on reconnect.
- **O3** Best-effort SMS fallback for SOS alerts with last available geolocation.
- **O4** Evaluation against ISO/IEC 25010:2023 (plan: `ISO25010_EVALUATION_PLAN.md`).
- **S** = supporting feature, not tied to one objective (the UAT form uses the same tag).

## 2. Product overview

### 2.1 Context
Baranguard complements DILG BIMSS and never replaces it (section 6.1). Its value is real-time dispatch,
GPS, SOS and offline field capture, which BIMSS does not provide. Case records and the Lupon/KP ledger stay
in BIMSS/KPIS and the barangay's binders.

### 2.2 Users and roles
| Role | Channel | Reach (REFERENCE section 3, Rules 86, 89, 95, 96) |
|---|---|---|
| Admin (Chief Tanod) | Web; phone console (device session) | Dispatch, GPS, scheduler, users, devices, audit log, health, exports, SMS, settings, Annex D preparation. Reads the narrative and party fields on web only. Not a responder: not dispatchable, no offers, no accomplishment entries. |
| Secretary (Records & Reports Officer) | Web | Records custodian: narrative, complainant name, incident lifecycle, schools (Annex B), referral log, C-1, annexes, accomplishment reports. Back-up dispatcher (assign, cancel, offers, resolve incident, ack/resolve SOS). No phone session. |
| Punong Barangay | Web | Oversight: dashboard, map, heatmap, analytics, approvals inbox, reports, referral log, school zones (read). No case list, no evidence. |
| Tanod | Android only | Own incidents, dispatches, published shifts, availability, accomplishment entries, referrals, school check-ins, SOS. Web login lands on a "no screen" page. |
| Lupon / Kagawad | none | No account (Rule 95). |

### 2.3 Operating environment
Windows workstation (XAMPP Apache + MariaDB, PHP 8.3 runtime), optional Cloudflare Named Tunnel
(`baranguardph.win` / `api.baranguardph.win`) for off-LAN access, Android phones (API 28+), a GSM gateway
phone, optional OpenRouteService and FCM. Times are stored UTC and shown Asia/Manila (REF Rule 11).

### 2.4 Assumptions and dependencies
Workstation power and connectivity (UPS; no power-cut procedure is specified because the system is not deployed); tanods use their own mobile data (Rule 94);
tanods without data cannot accept night offers and are assigned by call/SMS (Rule 84); migrations 0029-0045
are not yet applied to the real `baranguard` database; the tunnel currently serves the demo database
(REFERENCE section 1).

## 3. External interfaces
| ID | Interface | Notes |
|---|---|---|
| EI-01 | REST API `/api/v1/*`, JSON | Success = the object; error = `{"error":{"code","message"}}`; pagination `page`/`limit` (default 25, max 100). 103 routes in 27 files (`php backend/scripts/count-routes.php`, run 2026-10-28; earlier text saying 105 is stale). |
| EI-02 | Web dashboard | Browser, vanilla JS, MapLibre vendored. Pages (`web/src/pages`): Login, Dashboard, Dispatch Center, GIS Live Tracking, Incident Management, Incident Detail, Analytics, Historical Heatmap, Statistical Reports, Personnel (Users, Scheduler, Swap Requests), Approvals, Accomplishment Reports, Referral Log, Safer School Zones, SMS Monitor, Audit Log, Service Health, Map Packages, Settings, Privacy. |
| EI-03 | Android tanod app | Tabs Home, Dispatches, Report, Map, Profile; plus Availability, Accomplishments, School Check-in, My Shifts, Refer panel. Chief Tanod console: SOS, Dispatch, Incidents (read-only plus Log an incident), Profile. |
| EI-04 | Push (FCM) | Optional; needs real credentials. Never carries `raw_narrative`. |
| EI-05 | SMS gateway | Tethered Android phone (`sms-gateway/`) outbound; `gsm-ingest-daemon.php` inbound (stores human texts via `POST /internal/sms/inbound-text`); internal `/internal/sms/*` (7 handlers) loopback and token only. |
| EI-06 | OpenRouteService | Road routing for `GET /dispatch/:id/route`; failure never a 500. |
| EI-07 | Cloudflare Named Tunnel | Public hostnames; no Access policy yet. |
| EI-08 | Printer | A4 print layouts for reports, rosters, Annexes B, C-1, D. |

## 4. Functional requirements

### 4.1 Authentication, sessions, tenancy
- **FR-01** Users sign in with username and password, sign out, and change their password. No anonymous write route exists. (Rule 1; O4)
- **FR-02** An account locks for 15 minutes after 5 failed logins in a rolling 15 minutes. (Rule 2; O4)
- **FR-03** Web sessions use a 15-minute sliding JWT. A Tanod or Admin login with a well-formed `X-Device-Id` gets a device session (24 h sliding, 7-day cap); an Admin device session reaches only a fixed allow-list (else 403 `DEVICE_SESSION_SCOPE`). (Rule 3, REF Rule 12; O2, O4)
- **FR-04** Logout, suspension, deactivation and password change revoke sessions on the next request; `AuthMiddleware` checks the session every time. (Rule 4; O4)
- **FR-05** Every protected endpoint verifies role, tenant and ownership server-side; a cross-tenant request answers 404, never 403. (Rules 5, 6; O4)
- **FR-06** Admin creates, edits, deactivates and suspends users and reads the user directory (`purpose=tanod|roster|signer`); an Admin cannot change their own `approve_*` authority. (S)

### 4.2 Incidents
- **FR-07** Staff (Admin, Secretary) log an incident on the web with a report channel (tanod-alerted, walk-in, SMS, phone call, Facebook, other); residents cannot report directly. (Rules 56, 81; O1)
- **FR-08** A Tanod files an incident from the phone, offline included, with optional photo/voice evidence, school and C-1 fields; the Chief Tanod may log one from the console (signed write, narrative never shown back). (Rules 44, 70, 90; O2)
- **FR-09** Admin and Secretary may correct `priority`, `incident_type`, `location_description`; `complainant_name` is Secretary-only; sending a narrative field is a 400; `Idempotency-Key` required. (REFERENCE section 5; O1)
- **FR-10** `raw_narrative` and the party fields are returned only by `GET /incidents/:id` to a Secretary or to an Admin on a web session; never in FCM, SMS, logs, audit metadata or the Admin device session; each read is audited by id. (REF Rule 1; O4)
- **FR-11** Only the Secretary sets `duplicate`, `invalid`, `cancelled` or `reopened`; `duplicate` needs a same-barangay `duplicate_of_incident_id` (link, never merge); terminal states leave only via `reopened`; refused (409) while a dispatch is open. (Rules 12-15; O1)
- **FR-12** The Admin (and the Secretary as back-up) resolves a `dispatched` incident once all dispatches are completed or cancelled, or a `pending`/`reopened` one with a mandatory 1-255 character reason stored on the incident and never in audit metadata. (Rules 11, 71, 89; O1)
- **FR-13** A related-incident link between two incidents of one barangay changes no status and is allowed during an open dispatch. (Rule 61; S)
- **FR-14** Each incident has a code `INC-YYYY-NNN`, unique per barangay and Manila year, never built client-side. (REFERENCE section 1; S)
- **FR-15** Tanod evidence upload (photo/voice) on an assigned incident is checked for tenant, device and tanod access; offline captures show "waiting for connection" until confirmed. (Rule 70; O2)
- **FR-16** Staff search incidents (`q=`) and use global search; Punong Barangay incident and dispatch lists are scoped to open plus last 30 days. (HANDOFF 2026-10-09; S)

### 4.3 Dispatch and responders
- **FR-17** The Admin (or Secretary) assigns a Tanod to a `pending`, `reopened` or `dispatched` incident; the Tanod must be active, not suspended, on duty, not already responding, same barangay, and hold a published shift covering now unless an `override_reason` is given (422 `NO_PUBLISHED_SHIFT` otherwise). (Rules 7, 8, 67, 89; O1)
- **FR-18** An incident may have several concurrent active dispatches. Cancelling requires a reason (also from `arrived`) and reverts the incident to `pending` only when no other active dispatch remains. (Rules 9, 10; O1)
- **FR-19** The assigned Tanod updates dispatch status (en route, arrived, completed) from the phone; arrival drives the response-time metric (per-incident `MIN(arrived_at)` minus `created_at`). (REFERENCE section 5; O1, O2)
- **FR-20** Between 18:00 and 06:00 Manila every new pending incident opens a night offer to eligible on-duty tanods (fallback: those whose availability covers now); first online accept wins; 180 s rounds, 3 rounds, then spaced Admin escalation. The Admin can also open or cancel an offer by day. (Rules 57-60, 77, 84; O1)
- **FR-21** `GET /dispatch/:id/route` returns a road-snapped route from the caller's position, persisted with `route_status`; on routing failure an existing route is kept and marked `stale`. (REFERENCE section 5; O1)
- **FR-22** The Tanod sets duty status; going on duty needs a connection, going off duty works offline with the tap time and is refused while a dispatch is open. (Rule 49; O2)

### 4.4 Tracking and map
- **FR-23** The phone posts GPS breadcrumbs while on duty (including locked screen); the web shows live positions and history by polling (dashboard 15 s). (O1)
- **FR-24** Admin publishes, and tanods download, an offline map package per barangay. (O2)
- **FR-25** The GIS page shows live responders, active incidents and SOS markers (never clustered); Analytics provides a historical heatmap for Admin and Punong Barangay. (O1)

### 4.5 SOS and fallback
- **FR-26** A Tanod raises an SOS after a confirmation dialog; the server never rejects it for a missing fix: live coordinates, else last `gps_track` fix (`last_known`, with that fix's own time), else `no_fix`. (Rules 22, 25; O3)
- **FR-27** Admin (and Secretary on web) acknowledge and resolve an SOS; acknowledging does not clear the alert banner, resolving does; the Chief Tanod phone console may do both (online, signed write; Resolve only after Acknowledge). An SOS left `active` is re-sent every 2 minutes, to the Secretary and Punong Barangay too from round 3, up to 5 rounds. (Rules 24, 72, 89, 99; O3)
- **FR-28** If the server is unreachable the phone sends (a) an AES-256-GCM encrypted SOS envelope with coordinates to the gateway phone, which creates a real SOS (`fallback_channel='sms'`) with no duplicate on later sync, and (b) a plain-text alert to one configured backup contact. Best-effort only. The SOS control is on every Tanod tab (hold 800 ms), waits at most 2 s for GPS, and has a Silent SOS option (default silent). (Rules 23, 97; O3)
- **FR-29** Notifications (push, with SMS fallback for critical types) are created, delivered and acknowledged; a dispatch-offer push raises a full-screen critical alert; roster and report-update pushes are ordinary and carry no narrative; `sos`, `priority_alert`, `dispatch` and `dispatch_offer` pushes are data-only FCM, queued by severity on the phone. (Rules 74, 98; O3, S)

### 4.6 Offline sync
- **FR-30** Every mobile write persists to encrypted SQLite before the user can leave the screen and is never shown as synced until the server confirms. (Rule 44, REF Rule 7; O2)
- **FR-31** `POST /sync/batch` processes kinds in order sos, incident, referral, gps, duty_status, dispatch_status, availability, accomplishment_entry, school_checkin; (the phone's own upload order differs slightly, SOS first in both: Rule 45 note) chunks of 50, server limit 200, GPS capped at 200; a repeated `client_event_id` returns the original row; non-transient rejections revert optimistic local state and flag the item. (Rules 45-48; O2)
- **FR-32** Web writes carry `Idempotency-Key`; mobile writes carry `client_event_id` plus `X-Device-Id`; signed device writes are verified against the registered public key. (Rule 16, REF Rule 3; O2, O4)
- **FR-33** Devices register and deactivate; a deactivated device is refused. (O2)

### 4.7 Messaging
- **FR-34** Admin reads SMS logs and conversations, sends SMS, and broadcasts to opted-in subscribers of the own barangay only (recipient resolved server-side, `Idempotency-Key`); a broadcast is queued (`{recipient_count, queued}`, 10-minute duplicate guard, 100 recipients at most). Inbound human texts are stored and shown in Conversations; STOP, TIGIL or UNSUBSCRIBE opts the sender out. Send status is `Waiting to send`, `Sent, not confirmed`, `Sent` or `Failed`, never `Delivered`. Subscriber removal is an opt-out, not a delete. (Rules 100-102; S)

### 4.8 Reports, audit, health, settings
- **FR-35** Dashboard and reports show summary, average response time, heatmap, a statistical report export and a weekly digest for Admin and Punong Barangay. (O1)
- **FR-36** The audit log is append-only and records only allow-listed identifiers and statuses, never narratives, credentials, coordinates or personal data; Admin reads it. (Rule 20, REF Rule 8; O4)
- **FR-37** Service Health shows real dependency probes (`not_configured` is neutral) and a status-change history. (REF Rule 6; O4)
- **FR-38** Admin edits three `general.*` display keys and the SOS backup/gateway numbers; secrets stay in `.env`. (REFERENCE section 7 W21; S)
- **FR-39** `GET /public/transparency` serves a rate-limited, cached aggregate with no names or narratives; the only anonymous read besides `GET /barangays`. (S)

### 4.9 Roster, accomplishment, referrals, school zones
- **FR-40** A Tanod may submit availability windows (optional, versioned; no review step; `PATCH /availability/:id` answers 410). (Rules 32, 83; S)
- **FR-41** Admin or Secretary create and edit shifts (draft by default) and publish them; a Tanod sees only published own shifts; at most 12 scheduled hours per tanod per Manila day (422 `DAILY_HOURS_EXCEEDED`); a tanod who submitted availability is held to it (422 `OUTSIDE_AVAILABILITY`); missing coverage is a `NO_COVERAGE` warning, not a block. (Rules 26-30, 69, 76, 83; S)
- **FR-42** A Tanod requests a shift swap on a published shift (draft = 404); Admin or Secretary approve; an approved swap keeps the shift published. (Rules 29, 74; S)
- **FR-43** A Tanod records accomplishment entries (work date not future, <= 62 days back, confirmed duration 1-1440 min; the server stores its own suggested duration and flags a difference over 30 min) and submits the month online only; Admin/Secretary return it with a reason; `open -> prepared -> returned`; printed and signed on paper, signature not tracked. (Rules 33, 34, 80, 87; S)
- **FR-44** A Tanod, Admin or Secretary records an inter-agency referral (pnp, bfp, ambulance_ems, barangay_official, vaw_desk, social_welfare, higher_lgu, doh, dpwh, lupon_kp, other) without changing dispatch or incident status; the referral log carries no names, narratives or coordinates. (Rules 37, 38, 91; S)
- **FR-45** The Secretary or Admin maintains the school inventory (Annex B; deactivate, not delete); a Tanod checks in and out at a school (ISO-8601, <= 5 min ahead, <= 62 days back, out within 24 h); incidents carry non-identifying C-1 fields; an invalid `school_id` from mobile is stored NULL. (Rules 39-41, 43; S)
- **FR-46** Annex D term reports are computed live from check-ins, incidents and referrals and move `draft`, `prepared`, `submitted`; layouts are marked draft until the circular is checked. (Rules 80, 88; S)
- **FR-47** Every printed form is A4 with the signature block left blank. (Rules 74, 80; S)

### 4.10 Data lifecycle
- **FR-48** A retention job purges data at constant periods defined in code: raw narrative 365 days; GPS, duty status, shifts and notifications one year; the five newer workflow tables a provisional 365 days; legal hold stops any purge and any backup pruning; `school` is never purged. Purging is an ordered cascade. (Rules 19, 50-53, 82; O4)
- **FR-49** Encrypted backups run nightly and a restore drill runs weekly as scheduled tasks. (Rule 52; O4)

## 5. Non-functional requirements
No numeric performance target has been agreed or measured; the NFRs below state only what the sources fix.
"Not set" means an agreed number is needed before UAT sign-off (`ISO25010_EVALUATION_PLAN.md`).

| ID | Characteristic (ISO/IEC 25010) | Requirement |
|---|---|---|
| NFR-01 | Security: access control | Role, tenant and ownership enforced on the server for every protected endpoint; cross-tenant 404. |
| NFR-02 | Security: confidentiality | `raw_narrative` and party fields never leave the system by push, SMS, logs or audit metadata; local phone store encrypted (SQLCipher). |
| NFR-03 | Security: authenticity | Revocable sessions (15 min web, 24 h / 7 d device); lockout; device signatures for signed writes; security headers and CSP on web and API. |
| NFR-04 | Security: accountability | Append-only audit log with allow-listed metadata. |
| NFR-05 | Reliability: recoverability | Offline capture durable before navigation; idempotent retries create no duplicates; encrypted nightly backup and weekly restore drill; power-cut handling is not specified (not deployed). |
| NFR-06 | Reliability: availability | One workstation per barangay is a known single point of failure; only SOS has a device-local SMS fallback. Availability target: not set. |
| NFR-07 | Performance efficiency | Dashboard refresh by 15 s polling; phone GPS interval observed about 30-90 s. API response time, sync latency, position-refresh delay: target not set; tooling exists (`measure-api-latency.mjs`, `metrics-report.php`), no real-data run yet. |
| NFR-08 | Interaction capability | Every data screen has Loading, Empty, Error-with-retry and Populated states; tokens-only styling with dark mode; touch targets and contrast checked (`verify-touch-targets.mjs`, `verify-contrast.mjs`); usability (SUS) not yet measured. |
| NFR-09 | Compatibility | Android API 28+ (cleartext and mixed-content rules handled); modern browsers; no bundler or npm step for the web app. |
| NFR-10 | Functional correctness | Time stored UTC, displayed Asia/Manila, day-bucketing in PHP at +08:00; response time defined once as per-incident `MIN(arrived_at)` minus `created_at`. |
| NFR-11 | Maintainability | Migrations numbered and never edited; REFERENCE and DEVLOG kept current; route count checked by script. |
| NFR-12 | Installability | Local install via `SETUP.md` and `Start Baranguard.bat`; real-device APK built with explicit `VITE_API_BASE_URL`. |
| NFR-13 | Safety | An emergency SOS is never blocked by a missing GPS fix or by the server being down. |
| NFR-14 | Honesty (REF Rule 6) | No fabricated statistics, hardcoded identities or controls that do nothing. |

## 6. Constraints

### 6.1 DILG BIMSS positioning (legal, not a design choice)
DILG BIMSS/BIMS is mandated for all barangays; its KPIS subsystem is the Katarungang Pambarangay case
database and BIMS has its own electronic blotter. Baranguard complements BIMSS and may never be
presented as replacing it. Anything duplicating a BIMSS records function is a liability, so there is no blotter, no
case registry and no Lupon packet; the referral log and school reports are delegation or aggregate views.
The circular numbers (MC 2025-104, MC 2026-037) come from secondary sources and are unverified.

### 6.2 Offline-first
Field capture must work with no signal and sync later (FR-30, FR-31). Stated exceptions: going on duty,
accepting a night offer and submitting a monthly report need a connection (Rules 49, 58, 34).

### 6.3 Data Privacy Act (RA 10173)
Data minimisation and allow-listed audit metadata; raw narrative on a fixed retention ceiling with legal
hold; no student names in school records; PIA, data inventory and draft notice wording exist (`PRIVACY_IMPACT_ASSESSMENT.md`,
`DATA_INVENTORY.md`); no breach runbook is adopted. DPO designation, NPC registration and 72-hour breach notification are barangay actions, snippet-sourced,
to verify. UAT uses pretend data only.

### 6.4 Other
Local-first, LAN with optional tunnel, no cloud hosting (rejected by the owner); no external AI (REF Rule 5);
four fixed barangays; retention values are constants changed only after architecture review (REF Rule 10);
Kagawads have no account and sign on paper; the app does not claim attendance (Rule 87).

## 7. Verification
Methods: automated backend suites on disposable databases (`backend/scripts/verify-*`), `web/tests` (jsdom),
mobile static scripts, UAT form BG-UAT-02 (task IDs T-, C-, S-, P-), ISO 25010 questionnaires. Status per
requirement is in `TRACEABILITY_MATRIX.md`; "none yet" means no test was found.

## 8. Limits stated by the sources
A tanod with no data cannot take a night offer (Rule 84). "Real-time" is polling. The SMS fallback is
best-effort, emergency-only, one gateway number and one contact, and the gateway phone is tethered to the
workstation. The 2026-10 features are not browser- or device-verified by an agent, and migrations 0029-0045
are not applied to the real database.

## 9. Source contradictions found while writing
1. `Baranguard_Master_Reference_FINAL .md` section 7 matrix still shows Secretary-only narrative, Admin-only dispatch, fatigue flags, the citizen inbox and AI; superseded by REF Rule 1 (2026-10-13), Rule 89, 0042, 0029.
2. `WORKFLOWS_AND_RULES.md` Rule 18 says Admins get no narrative; REF Rule 1 lets the web Admin read it.
3. Rules 7, 26, 28 and 42 still say Admin-only dispatch and in-app publish/approve; Rules 89, 80 and 96 supersede them.
4. `REFERENCE.md` sections 3 and 5 still describe the Admin-managed approval authority and note/approve; Rule 96 and 0041 removed the screens and routes.
5. Route count: REFERENCE section 5 says 103 and the 2026-10-28 `count-routes.php` run agrees; HANDOFF's old 105 is stale (resolved).
