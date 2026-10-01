# Baranguard - ISO/IEC 25010:2023 Evaluation Plan

Status: PLAN ONLY. Every result cell reads "not yet measured" unless a real measured number exists in the repo docs (cited). Characteristic and sub-characteristic names are from memory of the 2023 edition; every item marked **[verify against the standard]** must be checked against the purchased text before the thesis cites it. Nothing here is a result.

Repo facts used: the blotter and AI pipeline were removed by migration 0029 (REFERENCE.md section 1; HANDOFF.md 2026-10-01), so no evidence for them is planned. Per HANDOFF, 0029 had NOT been applied to the real DBs. Verify suites live in `backend/scripts/verify-*.sh`; web render tests in `web/tests` (`npm test`); `node web/scripts/verify-web-wiring.mjs`; mobile `mobile/scripts/verify-local-schema.mjs`. Pass counts quoted in docs are code-correctness checks, not quality measurements, and several predate 0029 - re-run before citing.

Runner key: DEV = developer/researcher; DEVICE = researcher with the Infinix X6840 or other Android; USERS = recruited participants.

## 1. Functional Suitability
Sub-characteristics: completeness, correctness, appropriateness [verify against the standard].
- Metric: % of thesis-objective functions implemented; % of test cases giving the expected result.
- Method: requirement-to-test traceability matrix (see THESIS_OBJECTIVES_ALIGNMENT.md); UAT scenarios per role.
- Existing evidence: `verify-sprint0/1/3/4*.sh`, `verify-w3-w4-dispatch-gis.sh`, `verify-w2-reports.sh`, `verify-second-responder.sh`, `verify-json-contracts.php` (GET route envelopes), `verify-f8-response-time-dedup.sh`.
- Missing: the traceability matrix; a UAT pass/fail log with real users.
- Who: DEV (matrix, scripts), USERS (UAT).
- Result: not yet measured.

## 2. Performance Efficiency
Sub-characteristics: time behaviour, resource utilization, capacity [verify against the standard].
- Metrics: API response time (median, p95) per key endpoint; dashboard position-refresh delay; sync latency (reconnect to server row); dispatch response time per the REFERENCE definition (`incident.created_at` to `dispatch.arrived_at`, per-incident MIN(arrived_at)); workstation CPU/RAM; battery drain per on-duty hour.
- Method: scripted timed requests (N fixed in advance, e.g. 30+) against the real stack; timestamps from logcat/server for sync; `adb shell dumpsys batterystats` for battery.
- Existing evidence: no measured latency numbers found in the docs. The response-time computation is implemented (ReportsController, F8). The 15 s dashboard poll is a design interval, not a measurement. GPS fixes arriving every ~30-90 s over a 17-minute locked-screen run (REMAINING.md C7) is an observation, not a benchmark.
- Missing: all of the above. Sprint 8 boxes "Sync latency" and "Dispatch response-time metric" are open (SPRINTS.md).
- Who: DEV (API), DEVICE (sync, battery).
- Result: not yet measured.

## 3. Compatibility
Sub-characteristics: co-existence, interoperability [verify against the standard].
- Metrics: dashboard works in the chosen browsers; app runs on chosen Android versions; correct exchange with FCM, ORS, GSM gateway.
- Method: browser matrix (state which); 3+ device tiers (Sprint 8 hook); contract tests.
- Evidence: `verify-routing.sh` (ORS; SKIPs without a key), `verify-json-contracts.php`; FCM and GSM sends verified on the Infinix (REMAINING.md A4, 2026-09-24). Only one Android device is documented as tested.
- Missing: browser matrix, multi-device tiers.
- Who: DEV, DEVICE. Result: not yet measured.

## 4. Interaction Capability (2023 name for Usability) [verify against the standard]
Sub-characteristics I recall: appropriateness recognizability, learnability, operability, user error protection, user engagement, inclusivity, user assistance, self-descriptiveness [verify against the standard - the set changed in 2023].
- Metrics: SUS score; task success rate; time on task; errors per task.
- Evidence: web screens implement loading/empty/error/populated states and design tokens (REFERENCE section 6); no user study exists.
- Missing: the whole study. Who: USERS, run by DEV. Result: not yet measured.

### SUS plan (no invented results)
- Instrument: standard 10-item System Usability Scale, 5-point agreement scale. Any Filipino/Bikol translation is flagged as unvalidated unless validated.
- Administer separately per interface: web dashboard (Admin, Secretary, Punong Barangay) and mobile app (Tanods). Do not pool.
- Sample: purposive, real intended users from the four barangays (Dao, Binanuahan, Marifosque, Banuyo); state a minimum per role in advance (commonly 5-10 - cite source) and report actual n; small n limits generalization.
- Procedure: identical short orientation; 3-5 scripted tasks per role (Tanod: raise SOS, capture an incident offline, view a dispatch; Admin: dispatch a Tanod, read the heatmap); observe success, time, errors; SUS immediately after; optional open comments.
- Scoring: odd items score-1, even items 5-score, sum x 2.5 gives 0-100; report mean, SD, per role. Interpretation bands (e.g. about 68 as average) come from the literature - cite and verify.
- Informed consent and a data-privacy notice before the session.

## 5. Reliability
Sub-characteristics: faultlessness (maturity), availability, fault tolerance, recoverability [verify against the standard].
- Metrics: (a) offline durability = % of records created offline that survive app kill/reboot and reach the server; (b) sync success rate = confirmed / queued; (c) duplicate rate after forced retry (design target zero via `client_event_id`); (d) SMS fallback outcome rate over N attempts; (e) workstation availability; (f) restore-test pass.
- Method: DEVICE trials: create N incidents/evidence items offline, kill app, reconnect, compare local queue with server rows; repeat with forced duplicate sends; log timestamps.
- Existing evidence: `verify-sprint3.sh` (sync/batch backend), `verify-device-session.sh`, `verify-evidence-upload.sh`, `restore-drill.sh` (12 checks, real DB; scheduled weekly per HANDOFF), `backup.sh`, `verify-sprint7-retention.sh`. Device sessions 2026-09-19/23/24: FCM alert, 17-minute continuous locked-screen GPS (REMAINING.md C7), one SMS fallback `sent_by_sms` (M13). The Sprint 8 offline durability and duplicate-reconciliation box is not recorded complete.
- Known limit: everything depends on one powered-on workstation (REFERENCE section 1); no UPS/backup internet measured.
- Missing: (a)-(e) as rates. Who: DEVICE + DEV. Result: not yet measured.

## 6. Security
Sub-characteristics: confidentiality, integrity, non-repudiation, accountability, authenticity, resistance [verify against the standard].
- Metrics: % tenant/ownership penetration cases blocked (cross-tenant is 404); lockout and session-revocation behaviour; audit coverage; no secrets in logs.
- Evidence: `verify-sprint7-pentest-incidents.sh`, `verify-b2-pentest-remaining-resources.sh`, `verify-auth-lockout-revocation.php`, `verify-f6-suspended-request-rejected.sh`, `verify-device-signature.sh`, `verify-sprint7-audit.sh`, `verify-public-transparency.sh`. Check counts in docs are historical; re-run after 0029.
- Documented gaps: no Cloudflare Access policy; MFA deferred (C-02); API host publicly reachable.
- Who: DEV. Result: not yet measured for the thesis (re-run required).

## 7. Maintainability
Sub-characteristics: modularity, reusability, analysability, modifiability, testability [verify against the standard].
- Metrics: automated test count/pass rate; wiring check; documented change log; coverage if obtainable.
- Evidence: `web/tests`, `verify-web-wiring.mjs`, `mobile verify.schema`, `backend/DEVLOG.md`, `count-routes.php`, numbered never-edited migrations.
- Missing: static-analysis report, coverage figure. Who: DEV. Result: not yet measured.

## 8. Flexibility (2023 name for Portability) [verify against the standard]
Sub-characteristics I recall: adaptability, installability, replaceability, scalability (new) [verify against the standard].
- Metrics: timed clean-machine install; steps to deploy; effort to add a barangay (four are fixed in the schema).
- Evidence: `docs/SETUP.md`, `setup-env.sh`, `setup-cloudflare-tunnel.sh`, `bootstrap-db.sh`.
- Missing: timed clean-install trial. Who: DEV. Result: not yet measured.

## 9. Safety (new in 2023) - emphasis
Sub-characteristics I recall: operational constraint, risk identification, fail-safe, hazard warning, safe integration [verify against the standard].
- Hazard: an emergency alert silently lost or blocked.
- Metrics: SOS acceptance rate with no GPS (design: always accepted, `location_source` = last_known or no_fix); online SOS delivery time; fallback outcome per scenario (queued, `sent_by_sms`, `sms_pending`, `sms_failed`); count of false-confidence cases (badge says sent, nothing sent).
- Method: device scenario matrix: online+GPS, online no GPS, offline+GPS, offline no GPS, airplane/no SIM, malformed backup number. Ground truth: `adb shell content query --uri content://sms/sent`, server `tanod_sos` row, app badge.
- Existing evidence: `verify-sprint4.sh` (SOS API incl. last_known/no_fix assertions; 59/59 per HANDOFF 2026-09-26); M13 `sent_by_sms` confirmed on device 2026-09-24. A false-`sent` gap was fixed in code only (SosSmsPlugin sentIntent, number validation) and the mobile no-GPS SOS change (2026-09-27 (14)) is also code-only; neither is device-verified (HANDOFF).
- Missing: the full matrix, `sms_failed` on device. DND bypass is not implemented.
- Who: DEVICE. Result: not yet measured.

## Execution order
1. Apply 0029 to a disposable DB and re-run all suites. 2. Safety and Reliability device matrix. 3. Performance timings. 4. SUS and UAT. 5. Fill result tables with raw data attached.
