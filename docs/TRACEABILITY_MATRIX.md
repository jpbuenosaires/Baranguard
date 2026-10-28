# Baranguard - Requirements Traceability Matrix

Purpose: maps each requirement to a thesis objective, screen/endpoint and test; section 5 holds the per-objective evidence and limits.
Status/Last updated: 2026-10-28 (written 2026-10-23).

Companion to `SRS.md` (requirement text and rule numbers live there).
Chain: requirement -> thesis objective -> screen / endpoint -> test.

How to read it
- Objectives: O1 GIS command center, O2 offline-first app, O3 SMS fallback for SOS, O4 ISO/IEC 25010 evaluation, S supporting (evidence and limits in section 5).
- Automated tests are files under `backend/scripts/` (disposable DB, HTTP), `web/tests/pages|unit` (jsdom), `mobile/scripts/`. A suite is listed only if its header or a grep shows it exercises that route or rule; I did not re-run any suite for this matrix, so no pass counts are claimed here (counts: `REFERENCE.md` section 9, last measured 2026-10-01 to 2026-10-09).
- UAT cases are task IDs on form BG-UAT-02 (`chapter4-instruments/09-consolidated-uat.html`): T- Tanod, C- Chief Tanod, S- Secretary, P- Punong Barangay. The form lists them as tasks, not as results; none has been run on real users yet.
- "none yet" = no test found. "Not device-verified" = code exists, never run on a phone.

## 1. Functional requirements

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

## 2. Non-functional requirements

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
| NFR-14 | Honesty | FR-37 | `DEFECT_LOG.md` (manual audit) | audit only, no automated test |

## 3. Objective coverage

| Objective | Requirements | Strongest evidence | Gap |
|---|---|---|---|
| O1 GIS command center | FR-07, 09, 11, 12, 17-21, 23, 25, 35 | `verify-w3-w4-dispatch-gis.sh`, `verify-w2-reports.sh`, `web/tests` | no measured latency; browser pass by the user pending |
| O2 Offline-first app | FR-03, 08, 15, 19, 22, 24, 30-33 | `verify-sprint3.sh`, `verify-offline-sync-conflicts.sh`, `verify-local-schema.mjs` | offline durability and duplicate tests on a device not recorded complete (planned in ISO25010 plan) |
| O3 SMS SOS fallback | FR-26-FR-29 | `verify-sprint4.sh`, `verify-sprint4-phase2-3.sh`, `verify-sos-envelope.mjs` | end-to-end phone -> gateway -> dashboard SMS not demonstrated |
| O4 ISO 25010 | FR-01-FR-05, 10, 32, 36-37, 48-49; NFR-01-NFR-14 | security suites above | performance, usability, reliability rates unmeasured |

## 4. Gaps found

- No test found for: FR-02 UAT, FR-09 UAT, FR-12 no-dispatch resolve with reason (migration 0039), FR-16 PB 30-day scope, FR-47 print, NFR-06/07/12.
- Requirements with no UAT task: FR-02, 04, 05, 06, 09, 14, 24, 32-34, 36-39, 48, 49.
- UAT task S-20 and P-03 are read-only views; they do not exercise a requirement beyond access.
- `verify-sprint1-remaining.sh` header still lists the removed blotter list and citizen inbox; those assertions are history, do not cite them.
- `verify-roster-accomplishment.sh` predates Rule 96 (approval-authority dialog removed); re-check any authority assertion before citing it for FR-06.
- Suite pass counts in `REFERENCE.md` section 9 are from 2026-10-01 to 2026-10-09; re-run before quoting them in a test completion report.

## 5. Objective evidence and limits

Merged 2026-10-28 from the former `THESIS_OBJECTIVES_ALIGNMENT.md`. Evidence is cited from repo docs; items not device-verified are labelled. No performance numbers are claimed.

### Objective 1 - GIS web command center: real-time responder tracking and historical heatmaps
- Does: W2 dashboard, W3 dispatch (map markers, assign-from-map), W4 GIS live map (vendored MapLibre), Analytics with a Heatmap tab (Admin and Punong Barangay). Endpoints: GPS live/history, `/reports/heatmap`.
- Evidence: `verify-w3-w4-dispatch-gis.sh`, `verify-w2-reports.sh`, `web/tests` (jsdom renders every page); continuous GPS over a 17-minute locked-screen run (device session of 2026-09-24, `docs/evidence/2026-09-19-device/`).
- Limits: "real-time" is polling (dashboard 15 s; phone GPS about every 30-90 s observed), so near-real-time; no latency measured yet. Depends on the single workstation being online. Road routing uses OpenRouteService (external, needs a key). Measurement tooling exists since 2026-10-10 (`backend/scripts/metrics-report.php`: GPS delivery delay and fix interval; `measure-api-latency.mjs`: endpoint response times) but has NOT yet been run on real data.
- Wording: "a web-based GIS command center showing near-real-time responder positions refreshed by periodic polling, and historical incident heatmaps."

### Objective 2 - Offline-first tanod mobile app that queues records and syncs on reconnect
- Does: Ionic React/Capacitor app with encrypted SQLite (SQLCipher); writes persist locally before the user leaves the screen and sync via `/sync/batch` with `client_event_id` + `X-Device-Id` idempotency. Queued: incident records, evidence, GPS points, dispatch status updates, SOS. Cached: dispatches and an offline map package.
- Evidence: `verify-sprint3.sh`, `verify-device-session.sh`, `verify-evidence-upload.sh`, `mobile verify.schema`; device sessions 2026-09-19/23/24. The offline durability and duplicate-reconciliation device test is not recorded complete.
- Limits: sync success and duplicate rates are now logged per batch (`backend/storage/metrics/sync-*.jsonl`, summarised by `metrics-report.php`) but have no real-use data yet. Device session is 24 h sliding with a 7-day cap, so a long-offline tanod must log in again. Offline map rendering not separately verified. Offline evidence is queued, not visible to the dashboard until sync.
- Wording: "an offline-first mobile application that stores incident records, evidence, GPS points, dispatch updates and SOS alerts in encrypted local storage and synchronizes them idempotently when connectivity returns."

### Objective 3 - SMS best-effort fallback for emergency alerts with geolocation
- Does (updated 2026-10-10, DEVLOG): when an SOS cannot reach the server, the phone sends two independent SMS through its own SIM (Android SmsManager): (a) an AES-256-GCM encrypted `sos` envelope with the coordinates to the command center's GSM gateway phone (`sos_fallback.gateway_number`), whose ingest daemon forwards it to `/internal/sms/sos` and creates a real SOS (`fallback_channel='sms'`) on the dashboard; (b) a plain-text alert to ONE human backup contact (`sos_fallback.backup_contact_number`). Both numbers are format-validated. Location is included when available; the server-side SOS falls back to the tanod's last `gps_track` fix (`last_known`, with that fix's own timestamp) or to none (`no_fix`), and the SOS is never blocked for lack of GPS. The envelope reuses the SOS's `client_event_id`, so the queued sync cannot create a duplicate.
- The gateway phone is tethered to the workstation: if the workstation itself is down, only (b) still works. Path (a) covers the partial-outage case (app cannot reach the server over data, cellular SMS still works).
- Evidence: `verify-sprint4.sh`; M13 `sent_by_sms` confirmed on the Infinix via `content://sms/sent` (2026-09-24); `mobile/scripts/verify-sos-envelope.mjs` 12/12 (the JS-built envelope decrypts with the real PHP `EnvelopeCrypto`). NOT yet shown: a real end-to-end SMS from a tanod phone through the gateway phone to the dashboard.
- Limits: emergency/SOS alerts only, not general incident reporting; one gateway number and one backup contact, not a broadcast; best-effort, carrier delivery is neither guaranteed nor confirmed; the envelope is about 3 SMS segments; `sms_failed`/no-SIM handling and the mobile no-GPS SOS change are code-only, not device-verified; needs signal and a SIM with credit; the contact is cached at login, so it must be set before going offline.
- Wording: "a best-effort SMS fallback that, when broadband is unavailable, sends an encrypted emergency (SOS) alert with the last available geolocation to the command center's gateway phone, which records it as an SOS on the dashboard, and sends a plain-text alert to a configured backup contact." Use this wording only after the end-to-end device test passes; until then say "implemented, not yet device-verified".

### Objective 4 - ISO/IEC 25010:2023 evaluation
- Plan: `docs/ISO25010_EVALUATION_PLAN.md`. Existing artefacts are mostly correctness and security suites; performance, usability (SUS) and reliability rates are unmeasured.
- Wording: "evaluated against the ISO/IEC 25010:2023 product quality model (Functional Suitability, Performance Efficiency, Compatibility, Interaction Capability, Reliability, Security, Maintainability, Flexibility, Safety)" - [verify names against the standard]. Do not claim any characteristic as achieved before data exist.

### Scope removals to state in the thesis
The electronic blotter and AI redaction pipeline were removed (migration 0029; barangays keep binders; DILG BIMSS remains the mandated case ledger and Baranguard complements it). Do not present them as features.

### Compliance notes - snippet-sourced, verify before citing
- Data Privacy Act (RA 10173) registration: NPC Circular 2022-04 thresholds may apply to the operator - snippet-sourced, verify.
- Personal data breach notification to NPC and data subjects within 72 hours - snippet-sourced, verify.
- Designate a Data Protection Officer; none is designated yet (HANDOFF: council action) - snippet-sourced, verify.
- Privacy Impact Assessment: PIA and data inventory exist (`docs/PRIVACY_IMPACT_ASSESSMENT.md`, `DATA_INVENTORY.md`), reconciled for 0029; draft notice wording is in the PIA appendix.
- NPC Circular 2024-02 (CCTV): relevant only if CCTV is integrated; the system has no CCTV feature - snippet-sourced, verify.
- Research-ethics consent for the SUS study; the public tunnel (REFERENCE section 1) is outside the evaluated scope and serves the demo seed DB.
