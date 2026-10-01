# Baranguard - Thesis Objectives Alignment

Evidence is cited from repo docs; items not device-verified are labelled. No performance numbers are claimed.

## Objective 1 - GIS web command center: real-time responder tracking and historical heatmaps
- Does: W2 dashboard, W3 dispatch (map markers, assign-from-map), W4 GIS live map (vendored MapLibre), Analytics with a Heatmap tab (Admin and Punong Barangay). Endpoints: GPS live/history, `/reports/heatmap`.
- Evidence: `verify-w3-w4-dispatch-gis.sh`, `verify-w2-reports.sh`, `web/tests` (jsdom renders every page); continuous GPS over a 17-minute locked-screen run (REMAINING.md C7).
- Limits: "real-time" is polling (dashboard 15 s; phone GPS about every 30-90 s observed), so near-real-time; no latency measured yet. Depends on the single workstation being online. Road routing uses OpenRouteService (external, needs a key).
- Wording: "a web-based GIS command center showing near-real-time responder positions refreshed by periodic polling, and historical incident heatmaps."

## Objective 2 - Offline-first tanod mobile app that queues records and syncs on reconnect
- Does: Ionic React/Capacitor app with encrypted SQLite (SQLCipher); writes persist locally before the user leaves the screen and sync via `/sync/batch` with `client_event_id` + `X-Device-Id` idempotency. Queued: incident records, evidence, GPS points, dispatch status updates, SOS. Cached: dispatches and an offline map package.
- Evidence: `verify-sprint3.sh`, `verify-device-session.sh`, `verify-evidence-upload.sh`, `mobile verify.schema`; device sessions 2026-09-19/23/24. The Sprint 8 offline durability and duplicate-reconciliation box is not recorded complete.
- Limits: sync success and duplicate rates not yet measured. Device session is 24 h sliding with a 7-day cap, so a long-offline tanod must log in again. Offline map rendering not separately verified (REMAINING.md). Offline evidence is queued, not visible to the dashboard until sync.
- Wording: "an offline-first mobile application that stores incident records, evidence, GPS points, dispatch updates and SOS alerts in encrypted local storage and synchronizes them idempotently when connectivity returns."

## Objective 3 - SMS best-effort fallback for emergency alerts with geolocation
- Does: when an SOS cannot reach the server, the phone composes an SMS and sends it through its own SIM (Android SmsManager) to ONE configured backup contact (`sos_fallback.backup_contact_number`, format-validated). Location is included when available; the server-side SOS falls back to the tanod's last `gps_track` fix (`last_known`, with that fix's own timestamp) or to none (`no_fix`), and the SOS is never blocked for lack of GPS.
- Separate from this, a local GSM gateway phone sends server-originated SMS and ingests inbound SMS; it is not the SOS fallback path.
- Evidence: `verify-sprint4.sh`; M13 `sent_by_sms` confirmed on the Infinix via `content://sms/sent` (2026-09-24).
- Limits: emergency/SOS alerts only, not general incident reporting; single backup contact, not a broadcast; best-effort, carrier delivery is neither guaranteed nor confirmed; `sms_failed`/no-SIM handling and the mobile no-GPS SOS change are code-only, not device-verified; needs signal and a SIM with credit; the contact is cached at login, so it must be set before going offline.
- Wording: "a best-effort SMS fallback that sends an emergency (SOS) alert, with the last available geolocation when one exists, to a single configured backup contact when broadband is unavailable."

## Objective 4 - ISO/IEC 25010:2023 evaluation
- Plan: `docs/ISO25010_EVALUATION_PLAN.md`. Existing artefacts are mostly correctness and security suites; performance, usability (SUS) and reliability rates are unmeasured.
- Wording: "evaluated against the ISO/IEC 25010:2023 product quality model (Functional Suitability, Performance Efficiency, Compatibility, Interaction Capability, Reliability, Security, Maintainability, Flexibility, Safety)" - [verify names against the standard]. Do not claim any characteristic as achieved before data exist.

## Scope removals to state in the thesis
The electronic blotter and AI redaction pipeline were removed (migration 0029; barangays keep binders; DILG BIMSS remains the mandated case ledger and Baranguard complements it). Do not present them as features.

## Compliance notes - snippet-sourced, verify before citing
- Data Privacy Act (RA 10173) registration: NPC Circular 2022-04 thresholds may apply to the operator - snippet-sourced, verify.
- Personal data breach notification to NPC and data subjects within 72 hours - snippet-sourced, verify.
- Designate a Data Protection Officer; none is designated yet (HANDOFF: council action) - snippet-sourced, verify.
- Privacy Impact Assessment: drafts exist (`docs/PRIVACY_IMPACT_ASSESSMENT.md`, `DATA_INVENTORY.md`, `PRIVACY_NOTICES.md`) but predate 0029; reconcile.
- NPC Circular 2024-02 (CCTV): relevant only if CCTV is integrated; the system has no CCTV feature - snippet-sourced, verify.
- Research-ethics consent for the SUS study; note the public tunnel currently serves the demo seed DB (REFERENCE section 1).
