# Baranguard — To-Do to Finish, aligned to the 4 objectives

Source of the 4 objectives: `docs/THESIS_OBJECTIVES_ALIGNMENT.md`. Built from HANDOFF.md
(2026-10-13 snapshot) plus the Incident Management fix of 2026-10-17. Nothing below is
claimed done until it has evidence. Priority: P0 blocks everything, P1 needed for the
claim, P2 polish.

## Phase 0 — Cross-cutting blockers (do first)

- [ ] P0 Commit the uncommitted work (backend/web/mobile changes on `main`) after the fix to `incident-management.js` (`icons.user` -> `icons.users`) is browser-confirmed.
- [x] P0 Log in the browser as Admin and confirm Incident Management loads; also check Secretary and Punong Barangay.
- [x] P0 Make `load()`'s catch in `incident-management.js` log the real error to the console (the generic message hid this bug).
- [ ] P0 Back up, then apply migrations 0029–0043 in order, as DBA/root, to the real DB (`baranguard`); decide which DB backs the public tunnel (`baranguard_uiseed` is demo data).
- [ ] P0 Re-run the full verify suites after the migrations (list in REFERENCE.md §9) and record counts.
- [x] P0 Fix the 6 `verify-web-wiring.mjs` failures (undefined CSS classes: `incident-kpi-chip__label`, `case-dossier`/`font-mono` etc., `print-modal*`, `report-manifest*`, `case-card__field--*`).
- [x] P1 Run `web/tests` (`npm test`); fix the order-sensitive map test.
- [ ] P1 Register scheduled tasks: `BaranguardDispatchOfferSweeper`, backup/retention, restore drill, PB digest (`install-scheduled-backup-jobs.ps1`); unregister `BaranguardAiWorker`.
- [ ] P1 Run the tunnel as a Windows service (elevated `install-autostart-services.ps1`) so it survives a reboot.

## Objective 1 — GIS web command center (near-real-time tracking, heatmaps)

- [ ] P0 Browser pass of Dashboard, Dispatch Center, Live Map, Analytics (Reports + Heatmap) for Admin and Punong Barangay.
- [ ] P1 Run `backend/scripts/metrics-report.php` on real GPS data: delivery delay and fix interval. Record real numbers.
- [ ] P1 Run `measure-api-latency.mjs` against key endpoints; record p50/p95.
- [ ] P1 Outdoor moving GPS run on the device; compare the dashboard track against the real path.
- [ ] P1 Verify route accuracy (OpenRouteService, `GET /dispatch/:id/route`): needs a real ORS key; check the `stale`/`unavailable` states.
- [ ] P1 Compute the dispatch response-time metric exactly as Master Reference §6 defines it (`incident.created_at` -> `MIN(arrived_at)`).
- [ ] P2 Print/PDF visual check: statistical report, PB digest, Annex B/C-1/D, accomplishment report, week roster (A4).
- [ ] P2 Decisions owed: idle lock vs Dispatch screen, SOS bar after "Mark as seen", PB 30-day window.
- [ ] P2 Thesis wording stays "near-real-time, polling", not "real-time".

## Objective 2 — Offline-first tanod mobile app

- [ ] P0 Build a release APK with `VITE_API_BASE_URL=https://api.baranguardph.win/api/v1` set explicitly; grep the bundle for the real domain.
- [ ] P0 Device pass of every mobile screen (Availability, Accomplishments, School check-in, Refer, C-1 inputs, evidence capture, Chief Tanod console).
- [ ] P0 Offline durability test: create an incident, evidence, duty status and dispatch update in airplane mode, kill the app, reopen, reconnect; confirm one server row each (no duplicates).
- [ ] P1 Duplicate-reconciliation test: replay the same `client_event_id` batch; confirm the original row is returned.
- [ ] P1 Verify the four new sync kinds and the `closes_client_event_id` check-out path on a device.
- [ ] P1 Run the mobile discard SQL against real SQLCipher.
- [ ] P1 Measure sync latency and success/duplicate rates from `storage/metrics/sync-*.jsonl`.
- [ ] P1 Offline-map availability: load the map package, go offline, check rendering.
- [ ] P1 Confirm H-09 device-signature keys are populated and signature headers are sent.
- [ ] P1 FCM push end-to-end with the real `google-services.json`, including the critical alert for `dispatch_offer` (Android code only syntax-checked so far; compile in Gradle and run on a device).
- [x] P1 Run `tsc --noEmit` and lint; fix the pre-existing errors (1 and 18).
- [ ] P2 Mobile privacy page tests (`privacy.test.tsx`) and review.

## Objective 3 — SMS best-effort SOS fallback with geolocation

- [ ] P0 End-to-end device test: set `sos_fallback.gateway_number` and the backup contact in Settings, turn mobile data off, raise SOS. Confirm the dashboard shows an SOS with `fallback_channel='sms'`, the plain SMS reaches the backup contact, and the later sync creates no duplicate.
- [ ] P0 Set `GSM_GATEWAY_ENABLED=true`; confirm the gateway phone (`sms-gateway/`) and `gsm-ingest-daemon.php` are running.
- [ ] P1 No-GPS SOS: disable GPS, raise SOS; confirm `last_known` / `no_fix` handling on the server and web.
- [ ] P1 `sms_failed` path: airplane mode / no SIM; `SosSmsPlugin` pre-validation.
- [ ] P1 SOS acknowledge and resolve from the Chief Tanod phone console (signed device writes).
- [ ] P1 Notification end-to-end reliability: FCM plus the local GSM SMS gateway, with measured delivery times.
- [ ] P1 Run `verify-sprint4.sh`, `verify-device-signature.sh`, `mobile/scripts/verify-sos-envelope.mjs`.
- [ ] P2 State the limits in the thesis: SOS only, one gateway number, carrier delivery not guaranteed, the workstation must be up for path (a). Use "implemented, not yet device-verified" until the test passes.

## Objective 4 — ISO/IEC 25010:2023 evaluation

- [ ] P0 Verify the characteristic names against the standard text (Functional Suitability, Performance Efficiency, Compatibility, Interaction Capability, Reliability, Security, Maintainability, Flexibility, Safety).
- [ ] P0 Run UAT with real users (`docs/chapter4-instruments/`: interview guide, needs questionnaire, SUS); get research-ethics consent first.
- [ ] P1 Functional Suitability: schema-validate every §6 response (`verify-json-contracts.php`) and list pass/fail per route.
- [ ] P1 Performance Efficiency: the real latency numbers from Objective 1.
- [ ] P1 Reliability: restore drill, Windows-service restart test, outage behaviour (workstation down -> only SOS fallback), sync success rate.
- [ ] P1 Security: tenant/ownership penetration tests beyond incidents (dispatch, shifts, citizen reports, SMS: `verify-b2-pentest-remaining-resources.sh`), auth lockout/revocation (`verify-auth-lockout-revocation.php`), raw-PII exposure audit.
- [ ] P1 Interaction Capability: SUS scores, task completion, error counts.
- [ ] P1 Compatibility and Maintainability: browsers, Android tiers actually tested, test counts, route count (`count-routes.php`).
- [ ] P1 Safety: SOS/critical-alert behaviour, no false "synced" claims.
- [ ] P2 Report only measured numbers; log every reference-vs-implementation gap in `backend/DEVLOG.md`.

## Scope, compliance and documents (all objectives)

- [ ] P0 Thesis states the removals: Electronic Blotter and AI pipeline gone (migration 0029) and Fatigue Flags gone (0042); BIMSS is complemented, never replaced.
- [ ] P1 Reconcile stale docs: Master Reference, `PRIVACY_NOTICES.md` (staff hours, availability, school check-ins), `PRIVACY_IMPACT_ASSESSMENT.md`, `DATA_INVENTORY.md`.
- [ ] P1 Verify the legal text: MC 2026-037 (deadlines, Annex A, C-1 filing frequency) against the circular itself.
- [ ] P1 Data Privacy Act items: designate a DPO (council action), NPC registration check, 72-hour breach procedure.
- [ ] P1 Retention decisions for the new tables (availability, reports, check-ins, referrals, Annex D, `c1_*`): needs council/COA decision (Rule 10).
- [ ] P1 Decide: Kagawad-as-secretary account model; narrative 90-day retention policy; what attendance evidence COA accepts.
- [ ] P1 Decide: darker warning/success/info colours, Secretary incident filters, Lupon/KP referral destination, map tiles/fonts (third party).
- [ ] P2 Deferred on purpose: MFA (C-02), Cloudflare Access (web host only, never the API), UPS/backup internet.
- [ ] P2 Update `HANDOFF.md` (replace, don't append), log work in `backend/DEVLOG.md`, push `main`; drop `git stash@{0}`; delete stray `web/tests/*_out.txt`, `*_err.txt`, `node_v.txt`, `debug_test.mjs`.
