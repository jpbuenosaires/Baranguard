# Baranguard - Software Requirements Specification

Purpose: states what Baranguard must do and the limits it works within.
Status / Last updated: 2026-10-28 (written 2026-10-23).

Format follows ISO/IEC/IEEE 29148:2018 (check the edition with your adviser).
Extracted from `REFERENCE.md`, `WORKFLOWS_AND_RULES.md` (Parts 3 and 7),
the thesis-objective section of the former traceability matrix (now section 10.5), `backend/routes/*.php` and the per-role UAT forms `chapter4-instruments/09a`-`09d`.
Nothing here is new design. Where sources disagree, `REFERENCE.md` and the later WORKFLOWS rules win
(see section 9). Test mapping is in section 10 (Traceability).

## Contents
1. Introduction · 2. Product overview · 3. External interfaces · 4. Functional requirements ·
5. Non-functional requirements · 6. Constraints · 7. Verification · 8. Limits stated by the sources ·
9. Source contradictions · 10. Traceability (10.1 functional matrix, 10.2 non-functional matrix,
10.3 objective coverage, 10.4 gaps, 10.5 objective evidence and limits)

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
- **O4** Evaluation against ISO/IEC 25010:2023 (plan: `EVALUATION.md`).
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
"Not set" means an agreed number is needed before UAT sign-off (`EVALUATION.md`).

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
hold; no student names in school records; PIA, data inventory and draft notice wording exist (`PRIVACY.md`); no breach runbook is adopted. DPO designation, NPC registration and 72-hour breach notification are barangay actions, snippet-sourced,
to verify. UAT uses pretend data only.

### 6.4 Other
Local-first, LAN with optional tunnel, no cloud hosting (rejected by the owner); no external AI (REF Rule 5);
four fixed barangays; retention values are constants changed only after architecture review (REF Rule 10);
Kagawads have no account and sign on paper; the app does not claim attendance (Rule 87).

## 7. Verification
Methods: automated backend suites on disposable databases (`backend/scripts/verify-*`), `web/tests` (jsdom),
mobile static scripts, UAT form BG-UAT-02 (task IDs T-, C-, S-, P-), ISO 25010 questionnaires. Status per
requirement is in section 10 (Traceability); "none yet" means no test was found.

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

## 10. Traceability

Maps each requirement to a thesis objective, screen/endpoint and test (requirement text and rule numbers are in sections 4-6). Merged 2026-10-28 from the former `SRS.md` (written 2026-10-23).

Chain: requirement -> thesis objective -> screen / endpoint -> test.

How to read it
- Objectives: O1 GIS command center, O2 offline-first app, O3 SMS fallback for SOS, O4 ISO/IEC 25010 evaluation, S supporting (evidence and limits in section 10.5).
- Automated tests are files under `backend/scripts/` (disposable DB, HTTP), `web/tests/pages|unit` (jsdom), `mobile/scripts/`. A suite is listed only if its header or a grep shows it exercises that route or rule; I did not re-run any suite for this matrix, so no pass counts are claimed here (counts: `REFERENCE.md` section 9, last measured 2026-10-01 to 2026-10-09).
- UAT cases are task IDs on forms BG-UAT-02-T, -CT, -S, -PB (the per-role UAT forms `chapter4-instruments/09a`-`09d`): T- Tanod, C- Chief Tanod, S- Secretary, P- Punong Barangay. The form lists them as tasks, not as results; none has been run on real users yet.
- "none yet" = no test found. "Not device-verified" = code exists, never run on a phone.

### 10.1 Functional requirements

| ID | Requirement (short) | Obj | Screen / endpoint | Automated test | UAT case |
|---|---|---|---|---|---|
| FR-01 | Login, logout, change password | O4 | Login; `POST /auth/login`, `/auth/logout`, `/auth/change-password` | `verify-sprint1-auth.sh`; `verify-auth-lockout-revocation.php` | T-01, C-01, S-01, P-01 |
| FR-02 | Lockout after 5 failures / 15 min | O4 | `POST /auth/login` | `verify-auth-lockout-revocation.php` | none yet |
| FR-03 | Web JWT vs device session; Admin allow-list | O2, O4 | `POST /auth/login` with `X-Device-Id`; any route (`DEVICE_SESSION_SCOPE`) | `verify-device-session.sh`; `verify-chief-tanod-mobile.sh`; `web/tests/unit/sessionSecurity.test.mjs` | none yet |
| FR-04 | Revocation on logout, suspend, password change | O4 | `AuthMiddleware`; `PATCH /users/:id` | `verify-f6-suspended-request-rejected.sh`; `verify-auth-lockout-revocation.php` | none yet |
| FR-05 | Role + tenant + ownership, cross-tenant 404 | O4 | all protected routes | `verify-sprint7-pentest-incidents.sh` (incidents); `verify-b2-pentest-remaining-resources.sh` (dispatch, shifts, swaps, SMS) | none yet (UAT has no negative-boundary task found; the form tags "Obj 4" negatives S-05, S-07 are business-rule refusals) |
| FR-06 | User admin, directory, own-authority guard | S | Personnel > Users; `GET/POST /users`, `GET/PATCH /users/:id`, `GET /users/directory` | `verify-sprint1-remaining.sh` (users list); `verify-chief-tanod-mobile.sh` (directory); `verify-roster-accomplishment.sh` (authorities, as of before Rule 96) | none yet |
| FR-07 | Staff log incident with report channel | O1 | Incident Management "New Incident"; `POST /incidents` | `verify-incident-intake.sh`; `web/tests/pages/incident-management.test.mjs` | S-02 |
| FR-08 | Tanod files incident offline; Chief Tanod logs from console | O2 | Mobile Report tab, Chief Tanod Incidents tab; `POST /incidents`, `POST /sync/batch` | `verify-sprint3.sh`; `verify-chief-tanod-mobile.sh`; `verify-offline-sync-conflicts.sh` | T-17, T-18, T-19, C-07 (not device-verified) |
| FR-09 | Operational correction `PATCH /incidents/:id` | O1 | Incident Detail / Management; `PATCH /incidents/:id` | `verify-f5-incident-update-idempotency.sh` | none yet |
| FR-10 | Narrative + party fields to Secretary / web Admin only | O4 | Incident Detail; `GET /incidents/:id` | `verify-sprint7-pentest-incidents.sh`; `verify-sprint7-audit.sh` (audit by id); `web/tests/pages/incident-detail.test.mjs` | S-03 |
| FR-11 | Secretary lifecycle: duplicate/invalid/cancelled/reopened | O1 | Incident Detail; `PATCH /incidents/:id/lifecycle` | `verify-h16-incident-lifecycle.sh` | S-05, S-06, S-07, S-08 |
| FR-12 | Resolve (Admin/Secretary) incl. reason when no dispatch | O1 | Incident Management / Detail; `PATCH /incidents/:id/status` | `verify-wave1a-dispatch-roster.sh` and `verify-second-responder.sh` resolve dispatched incidents; the no-dispatch-with-reason path (0039) has no suite found: none yet | S-20 (read-only view; resolve not a listed task) |
| FR-13 | Related-incident link | S | Incident Detail; `PATCH /incidents/:id/related` | `verify-incident-intake.sh` | S-04 |
| FR-14 | `INC-YYYY-NNN` per barangay | S | all incident views; `incident.display_id` | `verify-display-id.sh`; `web/tests/pages/incidentCode.test.mjs` | none yet |
| FR-15 | Evidence photo/voice upload | O2 | Mobile Report / assignment Evidence; `POST/GET /incidents/:id/evidence`, `.../download` | `verify-evidence-upload.sh`; `verify-device-signature.sh` | T-13, T-28 (not device-verified) |
| FR-16 | Search; PB 30-day scope | S | Global search, Incident Management; `GET /incidents?q=`, `GET /search` | `verify-sprint7-pentest-incidents.sh`, `verify-incident-intake.sh` (search); PB 30-day window: none yet | none yet |
| FR-17 | Assign tanod; eligibility; published-shift rule | O1 | Dispatch Center; `POST /dispatch` | `verify-wave1a-dispatch-roster.sh`; `verify-w3-w4-dispatch-gis.sh` | S-16, C-03 |
| FR-18 | Concurrent dispatches; cancel with reason | O1 | Dispatch Center, Chief Tanod Dispatch tab; `PATCH /dispatch/:id/cancel` | `verify-second-responder.sh`; `verify-wave1a-dispatch-roster.sh` | C-03, C-04, S-16 |
| FR-19 | Tanod dispatch status; response time metric | O1, O2 | Mobile Dispatches tab; `PATCH /dispatch/:id/status`, `GET /reports/summary` | `verify-sprint3.sh`; `verify-f8-response-time-dedup.sh`; `verify-w2-reports.sh` | T-09, T-10, T-11, T-12, P-02 |
| FR-20 | Night offers, first accept wins, escalation | O1 | Dispatch Center offers; mobile offer card; `GET/POST /dispatch-offers`, `.../accept`, `.../cancel` | `verify-dispatch-offers.sh` (sweeper included; concurrency reasoned, not demonstrated) | T-14, T-15, T-16, C-05, S-17 |
| FR-21 | Road routing with stale fallback | O1 | Mobile navigation; `GET /dispatch/:id/route` | `verify-routing.sh` (real-ORS block skips without a key); `verify-routing-fallback.php` | T-10 |
| FR-22 | Duty status; offline off-duty | O2 | Mobile Home; `POST/GET /duty-status`, sync `duty_status_updates[]` | `verify-duty-status-map-upload.sh`; `verify-offline-offduty.sh` | T-02, T-03, T-04 |
| FR-23 | GPS breadcrumbs; live positions and history | O1 | GIS Live Tracking, Dashboard; `POST /gps`, `GET /gps/live`, `GET /gps/history` | `verify-w3-w4-dispatch-gis.sh`; `verify-sprint3.sh`; `web/tests/pages/gis-live-tracking.test.mjs` | T-02, P-04 (17-min locked-screen GPS: device run, REMAINING C7) |
| FR-24 | Map packages | O2 | Map Packages page; `POST /map-packages`, `GET /map-packages/:id`, `.../download` | `verify-devices-map-packages.sh`; `verify-duty-status-map-upload.sh`; `web/tests/pages/map-packages.test.mjs` | none yet (offline map rendering not separately verified) |
| FR-25 | GIS map and historical heatmap | O1 | GIS Live Tracking; Historical Heatmap / Analytics; `GET /reports/heatmap` | `verify-sprint1-remaining.sh` (heatmap); `verify-w3-w4-dispatch-gis.sh`; `web/tests/pages/analytics.test.mjs` | P-04 |
| FR-26 | SOS never blocked by missing fix (GPS wait at most 2 s; SOS control on every Tanod tab, hold 800 ms; Silent SOS option) | O3 | Mobile Home SOS and `SosHoldButton`; `POST /tanod-sos` | `verify-sprint4.sh` | T-06, T-07 (no-GPS change not device-verified) |
| FR-27 | SOS acknowledge / resolve | O3 | Dispatch Center SOS bar; Chief Tanod SOS tab; `PATCH /tanod-sos/:id/acknowledge`, `.../resolve` | `verify-sprint4.sh`; `verify-chief-tanod-mobile.sh`; SOS escalation (Rule 99) in `verify-messaging-hardening.sh` | T-05, C-02, S-17 (escalation: no UAT task yet) |
| FR-28 | SMS SOS envelope + backup-contact text | O3 | Mobile SOS offline; `GET /tanod-sos/fallback-contact`; `/internal/sms/sos` | `verify-sprint4-phase2-3.sh`; `mobile/scripts/verify-sos-envelope.mjs` (12/12 per section 5) | T-08 (end-to-end tanod phone -> gateway -> dashboard not yet shown) |
| FR-29 | Notifications, ack, critical alert for offers | O3, S | Mobile notifications; `GET /notifications`, `POST /notifications/:id/ack`, `POST /notifications/ack-all` | `verify-sprint4.sh`; `verify-sprint4-phase2-3.sh`; `verify-dispatch-offers.sh` | T-14 (FCM end to end needs real credentials: none yet) |
| FR-30 | Durable encrypted local write before leaving screen | O2 | Mobile local SQLite schema | `mobile/scripts/verify-local-schema.mjs` (230/0 on 2026-10-01); SQLCipher discard SQL not run on a device | T-17 |
| FR-31 | Idempotent ordered sync, limits, failure handling | O2 | `POST /sync/batch` | `verify-sprint3.sh`; `verify-offline-sync-conflicts.sh`; `mobile/scripts/verify-sync-failure-class.mjs` | T-18 (Sprint 8 offline durability box not complete) |
| FR-32 | Idempotency keys and device signatures | O2, O4 | all write routes | `verify-f5-incident-update-idempotency.sh`; `verify-device-signature.sh`; `verify-f9-sms-broadcast-idempotency-index.sh` | none yet |
| FR-33 | Device register / deactivate | O2 | `POST /devices/register`, `PATCH /devices/:id/deactivate` | `verify-devices-map-packages.sh` | none yet |
| FR-34 | SMS log, send, broadcast, subscribers | S | SMS Monitor; `GET /sms/logs`, `/sms/conversations*`, `POST /sms/send`, `/sms/broadcast`, `/sms/subscribers` | `verify-b2-pentest-remaining-resources.sh`; `verify-f9-sms-broadcast-idempotency-index.sh`; `verify-sprint4-phase2-3.sh` (logs); `verify-messaging-hardening.sh` (inbound text store, opt-out, queued broadcast, statuses; 2026-10-28); `web/tests/pages/sms-monitor.test.mjs` | none yet |
| FR-35 | Dashboard, reports, export, digest | O1 | Dashboard, Analytics, Statistical Reports; `GET /reports/summary`, `/reports/export*`, `/reports/digest*`, `/reports/nav-counts` | `verify-w2-reports.sh` (incl. digest); `verify-sprint7-audit.sh` (export); `verify-f8-response-time-dedup.sh`; `web/tests/pages/admin-dashboard.test.mjs` | P-02 (PDF output visually unchecked) |
| FR-36 | Append-only, allow-listed audit log | O4 | Audit Log; `GET /audit-log` | `verify-sprint7-audit.sh`; `web/tests/pages/audit-log.test.mjs` | none yet |
| FR-37 | Real service health + history | O4 | Service Health; `GET /system/health`, `/system/health/history` | `verify-json-contracts.php`; `web/tests/pages/service-health.test.mjs` | none yet |
| FR-38 | Narrow system settings | S | Settings; `GET/PATCH /system-settings` | `verify-json-contracts.php`; `web/tests/pages/settings.test.mjs` | none yet |
| FR-39 | Public transparency aggregate | S | Privacy / transparency page; `GET /public/transparency` | `verify-public-transparency.sh` | none yet |
| FR-40 | Tanod availability, no review | S | Mobile Availability; `POST/GET /availability`, `PATCH /availability/:id` (410) | `verify-roster-accomplishment.sh`; `verify-scheduler.sh` | T-25 |
| FR-41 | Shifts, publish, 12 h cap, availability check | S | Personnel > Scheduler, Approvals, mobile My Shifts; `GET/POST/PATCH /shifts`, `POST /shifts/publish` | `verify-roster-accomplishment.sh`; `verify-scheduler.sh`; `verify-wave1a-dispatch-roster.sh`; `verify-chief-tanod-roster.sh`; `web/tests/unit/rosterWeek.test.mjs` | T-23, S-19, P-05 |
| FR-42 | Shift swap requests | S | Personnel > Swap Requests, mobile My Shifts; `/shift-swap-requests` | `verify-scheduler.sh`; `verify-wave1a-dispatch-roster.sh`; `verify-b2-pentest-remaining-resources.sh` | T-24 |
| FR-43 | Accomplishment entries, submit, return | S | Mobile Accomplishments; Accomplishment Reports page; `/accomplishment-entries`, `/accomplishment-reports*` | `verify-roster-accomplishment.sh`; `verify-offline-offduty.sh`; `web/tests/pages/accomplishment-reports.test.mjs` | T-20, T-21, T-22, S-14, S-15, P-06 |
| FR-44 | Referrals and referral log | S | Mobile Refer panel; Referral Log; `POST/GET /incidents/:id/referrals`, `GET /referrals` | `verify-referrals.sh`; `web/tests/pages/referral-log.test.mjs` | T-27, S-18, P-08 |
| FR-45 | Schools (Annex B), check-ins, C-1 | S | Safer School Zones; mobile School Check-in; `/schools*`, `/school-checkins` | `verify-school-zones.sh`; `web/tests/pages/school-zones.test.mjs` | T-19, T-26, S-10, S-11 |
| FR-46 | Annex D term report | S | Safer School Zones > Term Report; `GET /reports/school-term`, `/ssz-term-reports*` | `verify-school-zones.sh` | S-12, S-13, P-07 |
| FR-47 | A4 print layouts | S | print preview on report pages | none yet (print layouts unverified visually, HANDOFF outstanding item 2) | S-09, P-06, P-07 |
| FR-48 | Retention constants, legal hold | O4 | `backend/scripts/retention-job.php`; `RetentionService` | `verify-sprint7-retention.sh`; `verify-retention-new-tables.sh`; `verify-retention-new-tables-seam.php` | none yet |
| FR-49 | Nightly backup, weekly restore drill | O4 | `backup.sh`, `restore-drill.sh`, scheduled tasks | `verify-sprint0.sh` (restore verification); `restore-drill.sh` (12 checks, last run 2026-09-26, not re-run since 0030-0033) | none yet |

### 10.2 Non-functional requirements

| ID | Characteristic | Related FR | Test / evidence | Status |
|---|---|---|---|---|
| NFR-01 | Access control | FR-05, FR-10 | `verify-sprint7-pentest-incidents.sh`, `verify-b2-pentest-remaining-resources.sh` | automated; other resource types (referrals, schools, availability) only inside their own suites |
| NFR-02 | Confidentiality | FR-10, FR-28, FR-36 | raw-PII exposure audit (planned, not yet run); `verify-sprint7-audit.sh` | partial; audit box not done |
| NFR-03 | Authenticity | FR-02-FR-04, FR-32 | `verify-auth-lockout-revocation.php`, `verify-device-signature.sh`, `verify-device-session.sh` | automated |
| NFR-04 | Accountability | FR-36 | `verify-sprint7-audit.sh` | automated |
| NFR-05 | Recoverability | FR-30-FR-31, FR-49 | `verify-offline-sync-conflicts.sh`, `restore-drill.sh` | backend automated; device durability test not done |
| NFR-06 | Availability | FR-28, FR-49 | none | none yet (no measurement; not deployed) |
| NFR-07 | Performance efficiency | FR-23, FR-31 | `measure-api-latency.mjs`, `metrics-report.php` exist | none yet (never run on real data; no target set) |
| NFR-08 | Interaction capability | all screens | `mobile/scripts/verify-touch-targets.mjs`, `verify-contrast.mjs`; `web/tests` render every page; SUS in ISO questionnaires (`chapter4-instruments/10-`, `11-`) | partial; SUS not collected |
| NFR-09 | Compatibility | FR-03 | device sessions on Infinix X6840 and Galaxy A21s (HANDOFF, memory); no multi-device tier test | partial |
| NFR-10 | Functional correctness | FR-19, FR-35 | `verify-f8-response-time-dedup.sh`, `web/tests/unit/manilaTime.test.mjs`, `verify-json-contracts.php` | automated |
| NFR-11 | Maintainability | all | `count-routes.php`, `verify-web-wiring.mjs` | tooling only; no maintainability evaluation |
| NFR-12 | Installability | - | `SETUP.md` (mobile and gateway sections partial) | none yet |
| NFR-13 | Safety | FR-26, FR-28 | `verify-sprint4.sh`; T-07, T-08 | no-GPS and offline paths not device-verified |
| NFR-14 | Honesty | FR-37 | `RISKS_AND_DEFECTS.md` defect log (manual audit) | audit only, no automated test |

### 10.3 Objective coverage

| Objective | Requirements | Strongest evidence | Gap |
|---|---|---|---|
| O1 GIS command center | FR-07, 09, 11, 12, 17-21, 23, 25, 35 | `verify-w3-w4-dispatch-gis.sh`, `verify-w2-reports.sh`, `web/tests` | no measured latency; browser pass by the user pending |
| O2 Offline-first app | FR-03, 08, 15, 19, 22, 24, 30-33 | `verify-sprint3.sh`, `verify-offline-sync-conflicts.sh`, `verify-local-schema.mjs` | offline durability and duplicate tests on a device not recorded complete (planned in ISO25010 plan) |
| O3 SMS SOS fallback | FR-26-FR-29 | `verify-sprint4.sh`, `verify-sprint4-phase2-3.sh`, `verify-sos-envelope.mjs` | end-to-end phone -> gateway -> dashboard SMS not demonstrated |
| O4 ISO 25010 | FR-01-FR-05, 10, 32, 36-37, 48-49; NFR-01-NFR-14 | security suites above | performance, usability, reliability rates unmeasured |

### 10.4 Gaps found

- No test found for: FR-02 UAT, FR-09 UAT, FR-12 no-dispatch resolve with reason (migration 0039), FR-16 PB 30-day scope, FR-47 print, NFR-06/07/12.
- Requirements with no UAT task: FR-02, 04, 05, 06, 09, 14, 24, 32-34, 36-39, 48, 49.
- UAT task S-20 and P-03 are read-only views; they do not exercise a requirement beyond access.
- `verify-sprint1-remaining.sh` header still lists the removed blotter list and citizen inbox; those assertions are history, do not cite them.
- `verify-roster-accomplishment.sh` predates Rule 96 (approval-authority dialog removed); re-check any authority assertion before citing it for FR-06.
- Suite pass counts in `REFERENCE.md` section 9 are from 2026-10-01 to 2026-10-09; re-run before quoting them in a test completion report.

### 10.5 Objective evidence and limits

Merged 2026-10-28 from the former `THESIS_OBJECTIVES_ALIGNMENT.md`. Evidence is cited from repo docs; items not device-verified are labelled. No performance numbers are claimed.

#### Objective 1 - GIS web command center: real-time responder tracking and historical heatmaps
- Does: W2 dashboard, W3 dispatch (map markers, assign-from-map), W4 GIS live map (vendored MapLibre), Analytics with a Heatmap tab (Admin and Punong Barangay). Endpoints: GPS live/history, `/reports/heatmap`.
- Evidence: `verify-w3-w4-dispatch-gis.sh`, `verify-w2-reports.sh`, `web/tests` (jsdom renders every page); continuous GPS over a 17-minute locked-screen run (device session of 2026-09-24, `docs/evidence/2026-09-19-device/`).
- Limits: "real-time" is polling (dashboard 15 s; phone GPS about every 30-90 s observed), so near-real-time; no latency measured yet. Depends on the single workstation being online. Road routing uses OpenRouteService (external, needs a key). Measurement tooling exists since 2026-10-10 (`backend/scripts/metrics-report.php`: GPS delivery delay and fix interval; `measure-api-latency.mjs`: endpoint response times) but has NOT yet been run on real data.
- Wording: "a web-based GIS command center showing near-real-time responder positions refreshed by periodic polling, and historical incident heatmaps."

#### Objective 2 - Offline-first tanod mobile app that queues records and syncs on reconnect
- Does: Ionic React/Capacitor app with encrypted SQLite (SQLCipher); writes persist locally before the user leaves the screen and sync via `/sync/batch` with `client_event_id` + `X-Device-Id` idempotency. Queued: incident records, evidence, GPS points, dispatch status updates, SOS. Cached: dispatches and an offline map package.
- Evidence: `verify-sprint3.sh`, `verify-device-session.sh`, `verify-evidence-upload.sh`, `mobile verify.schema`; device sessions 2026-09-19/23/24. The offline durability and duplicate-reconciliation device test is not recorded complete.
- Limits: sync success and duplicate rates are now logged per batch (`backend/storage/metrics/sync-*.jsonl`, summarised by `metrics-report.php`) but have no real-use data yet. Device session is 24 h sliding with a 7-day cap, so a long-offline tanod must log in again. Offline map rendering not separately verified. Offline evidence is queued, not visible to the dashboard until sync.
- Wording: "an offline-first mobile application that stores incident records, evidence, GPS points, dispatch updates and SOS alerts in encrypted local storage and synchronizes them idempotently when connectivity returns."

#### Objective 3 - SMS best-effort fallback for emergency alerts with geolocation
- Does (updated 2026-10-10, DEVLOG): when an SOS cannot reach the server, the phone sends two independent SMS through its own SIM (Android SmsManager): (a) an AES-256-GCM encrypted `sos` envelope with the coordinates to the command center's GSM gateway phone (`sos_fallback.gateway_number`), whose ingest daemon forwards it to `/internal/sms/sos` and creates a real SOS (`fallback_channel='sms'`) on the dashboard; (b) a plain-text alert to ONE human backup contact (`sos_fallback.backup_contact_number`). Both numbers are format-validated. Location is included when available; the server-side SOS falls back to the tanod's last `gps_track` fix (`last_known`, with that fix's own timestamp) or to none (`no_fix`), and the SOS is never blocked for lack of GPS. The envelope reuses the SOS's `client_event_id`, so the queued sync cannot create a duplicate.
- The gateway phone is tethered to the workstation: if the workstation itself is down, only (b) still works. Path (a) covers the partial-outage case (app cannot reach the server over data, cellular SMS still works).
- Evidence: `verify-sprint4.sh`; M13 `sent_by_sms` confirmed on the Infinix via `content://sms/sent` (2026-09-24); `mobile/scripts/verify-sos-envelope.mjs` 12/12 (the JS-built envelope decrypts with the real PHP `EnvelopeCrypto`). NOT yet shown: a real end-to-end SMS from a tanod phone through the gateway phone to the dashboard.
- Limits: emergency/SOS alerts only, not general incident reporting; one gateway number and one backup contact, not a broadcast; best-effort, carrier delivery is neither guaranteed nor confirmed; the envelope is about 3 SMS segments; `sms_failed`/no-SIM handling and the mobile no-GPS SOS change are code-only, not device-verified; needs signal and a SIM with credit; the contact is cached at login, so it must be set before going offline.
- Wording: "a best-effort SMS fallback that, when broadband is unavailable, sends an encrypted emergency (SOS) alert with the last available geolocation to the command center's gateway phone, which records it as an SOS on the dashboard, and sends a plain-text alert to a configured backup contact." Use this wording only after the end-to-end device test passes; until then say "implemented, not yet device-verified".

#### Objective 4 - ISO/IEC 25010:2023 evaluation
- Plan: `docs/EVALUATION.md`. Existing artefacts are mostly correctness and security suites; performance, usability (SUS) and reliability rates are unmeasured.
- Wording: "evaluated against the ISO/IEC 25010:2023 product quality model (Functional Suitability, Performance Efficiency, Compatibility, Interaction Capability, Reliability, Security, Maintainability, Flexibility, Safety)" - [verify names against the standard]. Do not claim any characteristic as achieved before data exist.

#### Scope removals to state in the thesis
The electronic blotter and AI redaction pipeline were removed (migration 0029; barangays keep binders; DILG BIMSS remains the mandated case ledger and Baranguard complements it). Do not present them as features.

#### Compliance notes - snippet-sourced, verify before citing
- Data Privacy Act (RA 10173) registration: NPC Circular 2022-04 thresholds may apply to the operator - snippet-sourced, verify.
- Personal data breach notification to NPC and data subjects within 72 hours - snippet-sourced, verify.
- Designate a Data Protection Officer; none is designated yet (HANDOFF: council action) - snippet-sourced, verify.
- Privacy Impact Assessment: PIA and data inventory exist (`docs/PRIVACY.md` parts 1 and 2), reconciled for 0029; draft notice wording is in the `PRIVACY.md` appendix.
- NPC Circular 2024-02 (CCTV): relevant only if CCTV is integrated; the system has no CCTV feature - snippet-sourced, verify.
- Research-ethics consent for the SUS study; the public tunnel (REFERENCE section 1) is outside the evaluated scope and serves the demo seed DB.
