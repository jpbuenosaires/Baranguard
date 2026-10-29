# Baranguard - Evaluation (ISO 25010, UAT data, device tests)

Purpose: everything needed to evaluate the build: the ISO/IEC 25010 measurement plan, the UAT and Chapter 4 test dataset, and the Android device test plans.
Status / Last updated: 2026-10-28. Plans and simulated data only; no real-user or device results exist yet.

## Contents

1. [ISO 25010 plan](#1-iso-25010-plan)
2. [UAT data and Chapter 4 test dataset](#2-uat-data-and-chapter-4-test-dataset)
3. [Device test plans](#3-device-test-plans)

---

## 1. ISO 25010 plan

Status: PLAN ONLY. Every result cell reads "not yet measured" unless a real measured number exists in the repo docs (cited). Characteristic and sub-characteristic names are from memory of the 2023 edition; every item marked **[verify against the standard]** must be checked against the purchased text before the thesis cites it. Nothing here is a result.

Repo facts used: the blotter and AI pipeline were removed by migration 0029 (REFERENCE.md section 1; HANDOFF.md 2026-10-01), so no evidence for them is planned. Per HANDOFF, 0029 had NOT been applied to the real DBs. Verify suites live in `backend/scripts/verify-*.sh`; web render tests in `web/tests` (`npm test`); `node web/scripts/verify-web-wiring.mjs`; mobile `mobile/scripts/verify-local-schema.mjs`. Pass counts quoted in docs are code-correctness checks, not quality measurements, and several predate 0029 - re-run before citing.

Runner key: DEV = developer/researcher; DEVICE = researcher with the Infinix X6840 or other Android; USERS = recruited participants.

### Functional Suitability
Sub-characteristics: completeness, correctness, appropriateness [verify against the standard].
- Metric: % of thesis-objective functions implemented; % of test cases giving the expected result.
- Method: requirement-to-test traceability matrix (see SRS.md); UAT scenarios per role.
- Existing evidence: `verify-sprint0/1/3/4*.sh`, `verify-w3-w4-dispatch-gis.sh`, `verify-w2-reports.sh`, `verify-second-responder.sh`, `verify-json-contracts.php` (GET route envelopes), `verify-f8-response-time-dedup.sh`.
- Missing: the traceability matrix; a UAT pass/fail log with real users.
- Who: DEV (matrix, scripts), USERS (UAT).
- Result: not yet measured.

### Performance Efficiency
Sub-characteristics: time behaviour, resource utilization, capacity [verify against the standard].
- Metrics: API response time (median, p95) per key endpoint; dashboard position-refresh delay; sync latency (reconnect to server row); dispatch response time per the REFERENCE definition (`incident.created_at` to `dispatch.arrived_at`, per-incident MIN(arrived_at)); workstation CPU/RAM; battery drain per on-duty hour.
- Method: scripted timed requests (N fixed in advance, e.g. 30+) against the real stack; timestamps from logcat/server for sync; `adb shell dumpsys batterystats` for battery.
- Existing evidence: no measured latency numbers found in the docs. The response-time computation is implemented (ReportsController, F8). The 15 s dashboard poll is a design interval, not a measurement. GPS fixes arriving every ~30-90 s over a 17-minute locked-screen run (device session of 2026-09-24, `docs/evidence/2026-09-19-device/`) is an observation, not a benchmark.
- Tooling added 2026-10-10 (not yet run on real data): `backend/scripts/measure-api-latency.mjs` (median/p95/max per key GET endpoint) and `backend/scripts/metrics-report.php` (GPS delivery delay, fix interval, dispatch response, offline sync delay, SOS delay).
- Missing: all of the above. The sync-latency and dispatch-response-time measurements are still open.
- Who: DEV (API), DEVICE (sync, battery).
- Result: not yet measured.

### Compatibility
Sub-characteristics: co-existence, interoperability [verify against the standard].
- Metrics: dashboard works in the chosen browsers; app runs on chosen Android versions; correct exchange with FCM, ORS, GSM gateway.
- Method: browser matrix (state which); the Android device(s) available (the SLM that motivated device tiers was removed); contract tests.
- Evidence: `verify-routing.sh` (ORS; SKIPs without a key), `verify-json-contracts.php`; FCM and GSM sends verified on the Infinix (2026-09-24 device session). Only one Android device is documented as tested.
- Missing: browser matrix, multi-device tiers.
- Who: DEV, DEVICE. Result: not yet measured.

### Interaction Capability (2023 name for Usability) [verify against the standard]
Sub-characteristics I recall: appropriateness recognizability, learnability, operability, user error protection, user engagement, inclusivity, user assistance, self-descriptiveness [verify against the standard - the set changed in 2023].
- Metrics: SUS score; task success rate; time on task; errors per task.
- Evidence: web screens implement loading/empty/error/populated states and design tokens (REFERENCE section 6); no user study exists.
- Missing: the whole study. Who: USERS, run by DEV. Result: not yet measured.

#### SUS plan (no invented results)
- Instrument: standard 10-item System Usability Scale, 5-point agreement scale. Any Filipino/Bikol translation is flagged as unvalidated unless validated.
- Administer separately per interface: web dashboard (Admin, Secretary, Punong Barangay) and mobile app (Tanods). Do not pool.
- Sample: purposive, real intended users from the four barangays (Dao, Binanuahan, Marifosque, Banuyo); state a minimum per role in advance (commonly 5-10 - cite source) and report actual n; small n limits generalization.
- Procedure: identical short orientation; 3-5 scripted tasks per role (Tanod: raise SOS, capture an incident offline, view a dispatch; Admin: dispatch a Tanod, read the heatmap); observe success, time, errors; SUS immediately after; optional open comments.
- Scoring: odd items score-1, even items 5-score, sum x 2.5 gives 0-100; report mean, SD, per role. Interpretation bands (e.g. about 68 as average) come from the literature - cite and verify.
- Informed consent and a data-privacy notice before the session.

### Reliability
Sub-characteristics: faultlessness (maturity), availability, fault tolerance, recoverability [verify against the standard].
- Metrics: (a) offline durability = % of records created offline that survive app kill/reboot and reach the server; (b) sync success rate = confirmed / queued; (c) duplicate rate after forced retry (design target zero via `client_event_id`); (d) SMS fallback outcome rate over N attempts; (e) workstation availability; (f) restore-test pass.
- Method: DEVICE trials: create N incidents/evidence items offline, kill app, reconnect, compare local queue with server rows; repeat with forced duplicate sends; log timestamps.
- Existing evidence: `verify-sprint3.sh` (sync/batch backend), `verify-device-session.sh`, `verify-evidence-upload.sh`, `restore-drill.sh` (12 checks, real DB; scheduled weekly per HANDOFF), `backup.sh`, `verify-sprint7-retention.sh`. Device sessions 2026-09-19/23/24: FCM alert, 17-minute continuous locked-screen GPS (device session of 2026-09-24, `docs/evidence/2026-09-19-device/`), one SMS fallback `sent_by_sms` (M13). The offline durability and duplicate-reconciliation box is not recorded complete.
- Known limit: everything depends on one powered-on workstation (REFERENCE section 1); no UPS/backup internet measured.
- Tooling added 2026-10-10: every `/sync/batch` appends success/duplicate/failed counts to `backend/storage/metrics/sync-*.jsonl`; `metrics-report.php` turns them into (b) and (c) once real tanod use exists. (a) still needs the DEVICE kill-and-reconnect trial.
- Missing: (a)-(e) as rates. Who: DEVICE + DEV. Result: not yet measured.

### Security
Sub-characteristics: confidentiality, integrity, non-repudiation, accountability, authenticity, resistance [verify against the standard].
- Metrics: % tenant/ownership penetration cases blocked (cross-tenant is 404); lockout and session-revocation behaviour; audit coverage; no secrets in logs.
- Evidence: `verify-sprint7-pentest-incidents.sh`, `verify-b2-pentest-remaining-resources.sh`, `verify-auth-lockout-revocation.php`, `verify-f6-suspended-request-rejected.sh`, `verify-device-signature.sh`, `verify-sprint7-audit.sh`, `verify-public-transparency.sh`. Check counts in docs are historical; re-run after 0029.
- Documented gaps: no Cloudflare Access policy; MFA deferred (C-02); API host publicly reachable.
- Who: DEV. Result: not yet measured for the thesis (re-run required).

### Maintainability
Sub-characteristics: modularity, reusability, analysability, modifiability, testability [verify against the standard].
- Metrics: automated test count/pass rate; wiring check; documented change log; coverage if obtainable.
- Evidence: `web/tests`, `verify-web-wiring.mjs`, `mobile verify.schema`, `backend/DEVLOG.md`, `count-routes.php`, numbered never-edited migrations.
- Missing: static-analysis report, coverage figure. Who: DEV. Result: not yet measured.

### Flexibility (2023 name for Portability) [verify against the standard]
Sub-characteristics I recall: adaptability, installability, replaceability, scalability (new) [verify against the standard].
- Metrics: timed clean-machine install; steps to deploy; effort to add a barangay (four are fixed in the schema).
- Evidence: `docs/SETUP.md`, `setup-env.sh`, `setup-cloudflare-tunnel.sh`, `bootstrap-db.sh`.
- Missing: timed clean-install trial. Who: DEV. Result: not yet measured.

### Safety (new in 2023) - emphasis
Sub-characteristics I recall: operational constraint, risk identification, fail-safe, hazard warning, safe integration [verify against the standard].
- Hazard: an emergency alert silently lost or blocked.
- Metrics: SOS acceptance rate with no GPS (design: always accepted, `location_source` = last_known or no_fix); online SOS delivery time; fallback outcome per scenario (queued, `sent_by_sms`, `sms_pending`, `sms_failed`); count of false-confidence cases (badge says sent, nothing sent).
- Method: device scenario matrix: online+GPS, online no GPS, offline+GPS, offline no GPS, airplane/no SIM, malformed backup number. Ground truth: `adb shell content query --uri content://sms/sent`, server `tanod_sos` row, app badge.
- Existing evidence: `verify-sprint4.sh` (SOS API incl. last_known/no_fix assertions; 59/59 per HANDOFF 2026-09-26); M13 `sent_by_sms` confirmed on device 2026-09-24. A false-`sent` gap was fixed in code only (SosSmsPlugin sentIntent, number validation) and the mobile no-GPS SOS change (2026-09-27 (14)) is also code-only; neither is device-verified (HANDOFF).
- Missing: the full matrix, `sms_failed` on device. DND bypass is not implemented.
- Who: DEVICE. Result: not yet measured.

### Execution order
1. Apply 0029 to a disposable DB and re-run all suites. 2. Safety and Reliability device matrix. 3. Performance timings. 4. SUS and UAT. 5. Fill result tables with raw data attached.

---

## 2. UAT data and Chapter 4 test dataset

Database `baranguard_uiseed` (Barangay Dao only, **simulated data**; the project keeps only the real `baranguard` and this one). Built by the `uat` profile of
`backend/scripts/seed-ch4.php`; reset with **`Reset UAT Data.bat`** at the repo root
(`backend\scripts\reset-ch4.ps1 -Profile uat -PointAppTo uat`). Ground truth for each build:
`backend/storage/uat-seed-manifest.json` (key `uat_fixtures`). It never touches the real `baranguard`.

Source of the scenarios: the per-role UAT forms `docs/chapter4-instruments/09a`-`09d` (forms BG-UAT-02-T, -CT, -S, -PB).
The per-group ISO/IEC 25010 questionnaires (`11a`-`11d`, forms BG-EV-02-A to -D) rate the system after a short facilitator-guided task set on the
same setup and need no data of their own.

### How to run a session

1. **Reset immediately before each tester** (about a minute). The scenarios change the data
   (dispatches, resolved incidents, submitted reports, the tester going on duty), so a second tester on
   the same data starts from a different state. Reset again for the next tester.
2. **Start within 9 hours of the reset.** The published shifts that make the Tanod and Admin scenarios
   work cover from 3 hours before the reset to 9 hours after it (rounded to the hour). After that,
   "published shift covering now" is false for everyone and A-03, A-09, T-14 and T-15 fail for a data
   reason, not a defect.
3. Password for every account: `Demo@2026` (give it to the tester separately, as the form requires).
4. Mobile testers need the phone to reach the API (`https://api.baranguardph.win`, or `adb reverse`
   for a USB phone) and the APK built with `VITE_API_BASE_URL` set (HANDOFF "Mobile build").

### Accounts and the state each one starts in

| Account | Role | State at reset | Used by |
|---|---|---|---|
| `tanod.reyes` | Tanod (**the Tanod tester**) | OFF duty. Published shift covering now. No active dispatch. Published shifts on D+1, D+2, D+3 (swap material), one draft on D+6 (must not appear in My Shifts). Accomplishment months Sep and Oct both **open**; no entry in the last 3 days. | T-01 to T-28 |
| `tanod.delacruz`, `tanod.gubaton` | Tanod | On duty, published shift now, no active dispatch, live GPS | A-03, A-06, A-09 recipients, T-15 "another tanod accepted first" |
| `tanod.dichoso` | Tanod | On duty, **no** published shift now, last GPS fix 40 min ago (stale marker) | A-02 stale unit, A-04 override prompt |
| `tanod.espinosa` | Tanod | Responding: live `en_route` dispatch on INC-fixture "live en route" | A-05 busy tanod, A-07, C-03, C-04 |
| `tanod.banares` | Tanod | Responding: live `arrived` dispatch | A-08 cancel after arrival |
| `tanod.candelaria` | Tanod | Off duty, no shift on D+2..D+4, whole-day availability on D+2..D+4 | A-05 (off duty not listed), A-13, A-14 |
| `tanod.olayvar` | Tanod | Suspended | login refusal |
| `admin.dao` | Chief Tanod (Admin) | no approval authority | Part C and D |
| `secretary.dao` | Secretary | `note_report`, `prepare_annex_d` | Part E |
| `punong.dao` | Punong Barangay | `approve_report`, `approve_roster`, `approve_annex_d` | Part F |

### Fixtures (counts from the verified build, see the manifest for the exact incident numbers)

* 12 pending incidents with no dispatch and no offer (each dispatch, broadcast, reopen or "take over" scenario consumes one).
* 1 live `en_route` and 1 live `arrived` dispatched incident; 3 dispatched incidents whose dispatches are
  all `completed` (the Admin's "resolve" candidates, A-11).
* 130 resolved incidents (duplicate targets), 2 reopened, 4 duplicate, 3 invalid, 3 cancelled; 13 linked to a school.
* 2 active SOS (one for the web tester, one for the phone console), 1 acknowledged, 11 resolved (4 by SMS fallback).
* 4 pending swap requests (not reyes) on published future shifts; 19 draft future shifts awaiting publish.
* Accomplishment reports: 6 prepared (one with a flagged duration), 1 returned, 3 open.
* 3 schools; 1 prepared Annex D term report; 38 referrals; 4 related links.
* System settings: SOS backup contact `09170000099` and gateway `09170000001` (fictitious), so T-08 has a number to text.
* No dispatch offer is pre-opened (a pre-opened one would block the facilitator's "Broadcast to on-duty tanods").

### What is behind each screen (so no list is empty)

The UAT profile adds history on top of the 30-day Chapter 4 dataset (`uat_richness` in the manifest):

* **`tanod.reyes` (the phone tester):** 15 incidents he filed (3 school-zone reports at the school gate/road, 4 with a photo), 20 completed dispatches with routes, 5 referrals, 27 past and 3 future published shifts plus 4 drafts, availability (6 accepted, 1 submitted), a swap history (1 approved, 1 denied), accomplishment reports for August (prepared), September (open, with one entry flagged "differs from the duty record") and October (open), 2 past SOS, school check-ins, 6 notifications (1 unread: the roster).
* **All roles:** notifications (priority alerts and SOS for the Chief Tanod and the Secretary, dispatches and rosters for the tanods, night offers, a returned report), 4 evidence photos, 3 offline map packages (newest published, the files under `backend/storage/map-packages`), 6 SMS subscribers (1 opted out).
* **Evidence photos are flat striped placeholder images** named `SIMULATED-evidence-photo-N.png`, not photographs; real photos come from T-13 and T-28. No voice evidence is seeded (the upload path only accepts real AAC recordings).
* The Punong Barangay gets no notifications: the system sends none to that role.

### Scenario by scenario

Legend. **Data**: provided by the seed. **Facilitator**: needs a facilitator action during the session.
**Device**: needs a real phone/hardware. **Stale**: the form describes something the app no longer does (section below).

#### Part B, Tanod (phone, `tanod.reyes`)

| ID | Needs | How it is met |
|---|---|---|
| T-01, T-02 | A Tanod account, off duty, with a published shift covering now | Data (reyes). |
| T-03 | An active dispatch while on duty | Facilitator assigns reyes a dispatch from the web (one of the 12 pending incidents). |
| T-04, T-05, T-06 | Nothing beyond the account | Device (airplane mode; the web Dispatch Center to see the priority alert). |
| T-07, T-08 | SOS fallback backup number | Data (settings). T-08's SMS needs a SIM, Device. |
| T-09 to T-12 | A dispatch assigned to reyes, with a routable incident | Facilitator assigns one of the pending incidents. ORS key is in `.env`. |
| T-13, T-28 | Evidence upload | Data/none (`storage/evidence` is writable by default); Device camera. |
| T-14, T-15, T-16 | Reyes on duty, a pending incident, a second on-duty tanod for the "first accept wins" case | Data: delacruz and gubaton are on duty, free, and rostered. Facilitator broadcasts the offer. |
| T-17, T-18 | Nothing | Device. |
| T-19 | Schools on the phone | Data (3 schools); the phone must connect once. |
| T-20 | An open accomplishment month, a recent work date with no entry | Data: reyes' Sep and Oct are open; last 3 days empty. |
| T-21, T-22 | Two open months (submit one online, attempt the other offline) | Data: Sep and Oct both open. |
| T-23 | A draft shift that must not show | Data: reyes has a draft on D+6. |
| T-24 | A published future shift | Data: D+1, D+2, D+3. |
| T-25 | Availability form | None (see Stale: review states). |
| T-26 | A school | Data. |
| T-27 | An assigned dispatch | Facilitator. |
| T-N1, T-N2 | Nothing | Data (any). |

#### Part C, Chief Tanod / Admin (web, `admin.dao`)

| ID | Needs | How it is met |
|---|---|---|
| A-01, A-02 | Markers, an SOS, a stale unit | Data: 2 active SOS; dichoso is stale; others live. |
| A-03 | Pending incident + on-duty tanod with a published shift | Data: 12 pending; delacruz/gubaton. |
| A-04 | On-duty tanod without a published shift | Data: dichoso (verified: API answers 422 `NO_PUBLISHED_SHIFT`). |
| A-05 | A tanod already responding elsewhere; an off-duty tanod | Data: espinosa/banares; reyes and candelaria are off duty (verified: dispatching espinosa is refused). |
| A-06 | A dispatched incident | Data: the live en-route and arrived incidents. |
| A-07, A-08 | An assigned/en-route responder; one that has arrived | Data: espinosa (en route) and banares (arrived). Cancelling consumes them. |
| A-09 | Pending incident; recipients on duty, published shift, no dispatch; no existing offer | Data. |
| A-10 | An incident with an active dispatch | Data: the two live ones. |
| A-11 | A dispatched incident whose dispatches are all completed | Data: three of them. |
| A-12, A-15, A-19 | (see Stale) | |
| A-13 | A tanod with availability and nothing rostered | Data: candelaria D+2..D+4. |
| A-14 | Two shifts that would exceed 12 h on one date | Data: candelaria has whole-day availability on D+2..D+4 and no shifts there. |
| A-16 | A pending swap request on a published shift | Data: 4 (not reyes). |
| A-17 | none | Data. |
| A-18 | Secretary reopens an incident | Facilitator step; 2 reopened incidents also exist. |
| A-20, A-N1, A-N2, A-N3 | Pending/dispatched incidents; admin account | Data. |

#### Part D, Chief Tanod phone console (`admin.dao`)

| ID | Needs | How it is met |
|---|---|---|
| C-01 | Admin login with an `X-Device-Id` | none (device session). |
| C-02 | An **active** SOS | Data: 2 active (one is also used by A-01/A-02 on the web). |
| C-03, C-04 | An incident with a dispatch | Data: espinosa/banares incidents. |
| C-05 | A pending incident to take over | Data. |
| C-06, C-N1 | Incidents | Data. |

#### Part E, Secretary (`secretary.dao`)

| ID | Needs | How it is met |
|---|---|---|
| S-01, S-N1, S-02, S-03 | none | Data (raw narratives exist, in en/tl/bik). |
| S-04 | An incident with an open dispatch, and another of the same barangay | Data: the two live incidents. |
| S-05 | none | none (but see Stale for the exact message). |
| S-06 | An incident with its dispatch closed, plus a target | Data: 130 resolved / completed ones. |
| S-07 | An incident with an open dispatch | Data. |
| S-08 | An incident without an open dispatch, then reopen | Data: pending ones; invalid ones exist. |
| S-10 | none | none. |
| S-11 | School-linked incidents with C-1 text | Data: 13. |
| S-12 | none; dates must not clash | Data: the seeded term is -45/+45 days; the API has no overlap rule. |
| S-13 | A draft/prepared Annex D report | Data: 1 prepared. |
| S-14 | A report with a flagged duration | Data: one prepared report (delacruz, September). |
| S-15 | A prepared report, account with `note_report` | Data: 6 prepared; the secretary holds `note_report`. |
| S-16, S-17, S-18, S-19 | (see Stale) | |
| S-20, S-N2 | A pending/dispatched incident | Data. |

#### Part F, Punong Barangay (`punong.dao`)

| ID | Needs | How it is met |
|---|---|---|
| P-01, P-02 | Figures that match the seed | Data: compare with `uat-seed-manifest.json` (incidents 159, resolved 130 at the verified build; the screen's average response time is 23.2 min over 120 incidents). |
| P-03, P-04, P-08, P-N1, P-N2 | Incidents, heatmap data, referrals | Data. |
| P-05 | Draft shifts awaiting publish; `approve_roster` | Data: 19 drafts; the PB holds `approve_roster`. |
| P-06, P-07 | (see Stale) | |

### Scenarios that cannot be performed as written (fix the form, not the data)

I compared the form's expected results with the current code. These describe behaviour that was removed
or changed after the form was written. Searching the web and mobile source for the form's exact wording
finds nothing for the first group.

* **Paper signing is no longer tracked in the app** (migration 0041, 2026-10-12: reports are printed and
  signed on paper; routes and screens for recording paper signatures and scanned documents were removed).
  So **S-16** (record paper signature date), **S-17** (upload a scan), **S-18** ("Record signed paper"),
  **P-06** and **P-07** (approval recorded after the Secretary records the signed paper), and the
  "paper" parts of **A-15** and **S-19** ("Publish with signed paper") cannot be done. Shifts now publish
  with a plain "Publish" / "Publish Week"; reports end at *prepared* ("Submitted — print and sign it at the
  barangay hall").
* **Availability is no longer reviewed** (the tanod's availability is fixed; `PATCH /availability/:id`
  answers 410, the review panel is gone): **A-12** and **A-19** ("Availability to review", "Accept", "Ask to
  revise", "Create shift from this availability") and the "accepted by the desk" part of **T-25**.
  Shifts are added from the Scheduler week grid.
* **T-21** expects "Submitted — waiting to be noted"; the app now says "Submitted — print and sign it at the barangay hall".
* **A-16** expects an approved swap to return the shift to draft; since 2026-10-12 an approved swap keeps a
  published shift published (HANDOFF, workflow-gap fix 1).
* **S-14** expects entry text only for note/approve holders; Admin and Secretary always see entry text
  since 2026-10-12 (REFERENCE.md §1, Rule 74).
* **P-05** names a "Publish selected" button; the control is now the week grid's "Publish Week" / Approvals inbox.
* **S-13** describes waiting for "the signed paper"; Annex D is now draft -> prepared -> submitted.
* **S-05** and **T-04**: the exact messages "Enter a valid incident id." and "Cannot change duty status while
  offline." were not found in the source (the behaviours may exist with other wording). Check on the device
  and fix whichever is wrong.
* **A-N1** (Admin must not see the confidential narrative and party details) no longer holds: since 2026-10-13 the
  Admin's web session reads them (REFERENCE.md Rule 1, amended). The Punong Barangay still sees the "Restricted" note,
  and the Admin's phone console still gets no narrative (C-06 unchanged).
* **C-02** says no option to resolve is offered on the phone, and **C-N1** says resolving an SOS stays on the web: since 2026-10-12 the Chief Tanod phone console can resolve an SOS (offered only after Acknowledge, owner decision 2026-10-14). Update both rows before use.
* **T-N1** expects a page saying the tanod role "has no built web screen"; `web/src/main.js` has such a page
  but the wording differs.

These were not run in a browser or on a phone. They are source comparisons, so confirm each one on screen
before changing the form.

### What no database can provide

* The phone, its GPS, camera, SIM and airplane-mode toggling (T-04 to T-08, T-13, T-16 to T-18, T-28).
* FCM push and the full-screen alert (T-14, A-09): needs the real `google-services.json` on the phone.
* The local GSM gateway for any SMS monitor or fallback check; `GSM_GATEWAY_ENABLED` is not set in `backend/.env`.
* Real response-time and sync-latency figures. Everything in this database is generated; report the
  figures as "simulated test data" (see "Limits to state in the chapter" below).
* A tester who is the intended user; a developer may not act as tester (form, ground rule 5).

### Seed data: scope, ground truth and limits

**Everything in the seeded database is simulated.** It exists for screenshots and for the ISO/IEC 25010 and UAT runs. It is not field data, and no figure taken from it may be reported as a measured result of real tanod use. In Chapter 4, call it "simulated test data".

What it contains:
- One barangay only: Dao (barangay_id 1). The seed script refuses to run on any database name other than the ones it knows, and never touches the real `baranguard`.
- 11 accounts, all with password `Demo@2026`: `admin.dao` (Chief Tanod), `secretary.dao`, `punong.dao`, and eight tanods (`tanod.reyes`, `tanod.delacruz`, `tanod.gubaton`, `tanod.dichoso`, `tanod.espinosa`, `tanod.banares`, `tanod.candelaria`, and `tanod.olayvar`, who is suspended on purpose).
- About 30 days of history covering every current screen: incidents (English, Tagalog, Bikol narratives; every status), dispatches with simulated routes, night dispatch offers, SOS alerts (app and SMS fallback), GPS tracks, shifts and rosters, availability, swap requests, accomplishment reports, referrals, Safer School Zones (3 schools, check-ins, a prepared term report), SMS log, legacy citizen-report rows (the inbox was retired 2026-10-17; nothing creates new ones), audit log, health checks.
- Not seeded: evidence photos and voice files, and the mobile app's own offline queue (that lives on the phone).

Ground truth: each run writes a manifest under `backend/storage/` (`uat-seed-manifest.json` for the UAT profile) with the exact counts generated: incidents by status, type and source; the median created-to-arrival time; SOS by app vs SMS fallback and their delays; offline-captured incidents and their lateness; GPS rows and delivery delay; referrals by office. Compare the system's own reports against it. The Reports screen's average response time should agree with the manifest (same rule: incident created to first arrival; the screen counts only the date range it shows), and `backend/scripts/metrics-report.php` should reproduce the GPS and SOS figures. Dates are relative to the moment of the reset, so the pending queue, active SOS, open offer and live tanod positions always look current.

Limits to state in the chapter:
- The delays and response times are drawn from ranges chosen by the script, so they show the system computing them correctly, not how fast real responders are.
- Names, contact numbers, school names and reference numbers are made up (`SIM-` prefixes where a reference is needed).
- The sync-latency and offline-durability figures for objective 2 still need real phone runs (Section 1, ISO 25010 plan).

---

## 3. Device test plans


**Status: PLANS ONLY. Nothing here has been run.** Written 2026-10-23 for two
evaluation items that need hardware (the former "Sprint 8" boxes). Results go in
`backend/DEVLOG.md`; an item counts as done only with the evidence listed under
"Pass evidence".

Baseline already proven (do **not** redo, only regress if code changed since):
Infinix X6840, 2026-09-19/24 (`docs/evidence/2026-09-19-device/`):
SQLCipher header, one offline report surviving force-stop, keystore round-trip,
one queue drain (incident 119), real FCM critical alert + ack, M13 `sent_by_sms`,
real GSM outbound SMS. These were **n = 1** each. The plans below turn them into
measured rates.

### 0. Pre-flight (both plans)

1. Build the APK with the real URL, then grep the bundle (HANDOFF "Mobile build"):
   `VITE_API_BASE_URL=https://api.baranguardph.win/api/v1 npx vite build`, then
   `grep -l api.baranguardph.win mobile/dist/assets/index-*.js`. If the device
   run is on the LAN instead, use `adb reverse tcp:8081 tcp:8081` (it drops on
   every reconnect).
2. Check `DB_NAME` in `backend/.env`. **Use a disposable or demo DB** (`baranguard_uiseed`
   or a fresh seed), not the real one. Note: the real DBs lack migrations 0029+.
3. Record: git commit (`git rev-parse HEAD`), APK build time, device model, Android
   version, SIM/carrier, date. Use `tanod.reyes` / `tanod.delacruz` (password in HANDOFF).
4. `adb` is at `C:\Users\JAYSON~1\AppData\Local\Android\Sdk\platform-tools\adb.exe`.
5. Make a folder `docs/evidence/<date>-offline-notif/` and save everything there.

### Plan A — Offline cache durability + duplicate reconciliation

**Question answered:** of records created offline, what % survive kill/reboot and
reach the server, and does forced retry ever create a second row?
Maps to the Section 1 (ISO 25010 plan) metrics (a), (b), (c).

Backend side is already proven by `verify-sprint3.sh` and
`verify-offline-sync-conflicts.sh` (see `docs/WORKFLOWS_AND_RULES.md`).
This plan covers only what needs the phone.

#### A1. Durability trial (N = 20 incidents, 10 per kill type)

| Step | Action |
|---|---|
| 1 | Log in online (device session). Let the dispatch cache fill. |
| 2 | Make the server unreachable for real: `adb reverse --remove tcp:8081` (LAN) or airplane mode (tunnel). Confirm in-app offline state. |
| 3 | Create incident *i* with a unique marker in the location text (`DUR-01`..`DUR-20`). Add a photo to 5 of them. Note the screen shown after save. |
| 4 | Kill type, alternating: **(a)** `adb shell am force-stop ph.baranguard.tanod` · **(b)** swipe from recents · **(c)** (3 of the 20) `adb reboot` before relaunch. |
| 5 | Relaunch still offline. Record the Unsynced count. Open each record: is the content intact? |
| 6 | Restore connectivity, sign in if asked. Wait for drain (poll the in-app count). |
| 7 | Server check (below). |

```sql
-- how many of the 20 arrived, and how many times each
SELECT location_description, COUNT(*) n, MIN(incident_id), MAX(incident_id)
FROM incident WHERE location_description LIKE 'DUR-%' GROUP BY location_description;
-- evidence arrived for the 5 with photos
SELECT incident_id, COUNT(*) FROM evidence_attachment
WHERE incident_id IN (SELECT incident_id FROM incident WHERE location_description LIKE 'DUR-%') GROUP BY incident_id;
```

**Pass evidence:** durability = rows found / 20 (target 100%, report the real number);
local count after relaunch = 20 minus none lost; every row `n = 1`; photos present;
no raw narrative in `adb logcat` (`adb logcat -d | grep -i DUR-` should show nothing
from plugin result dumps; `loggingBehavior` is `none`).

#### A2. Forced duplicate (N = 10)

Goal: the same event sent twice must yield one row (`UNIQUE (device_id, client_event_id)`).

1. Create 10 incidents offline (`DUP-01`..`DUP-10`).
2. Reconnect for a few seconds so the batch is accepted, then cut the link
   **before the app sees the response**: easiest is `adb reverse --remove` right after
   the request leaves (watch `backend` access log), or toggle airplane mode on
   the first `POST /sync/batch`. The app should keep the item queued and retry.
3. Reconnect and let it retry. Repeat the cut once more for 5 of the 10.
4. Check:

```sql
SELECT location_description, COUNT(*) FROM incident WHERE location_description LIKE 'DUP-%' GROUP BY 1 HAVING COUNT(*) > 1;  -- expect 0 rows
SELECT status, COUNT(*) FROM offline_queue WHERE client_event_id IN
  (SELECT client_event_id FROM incident WHERE location_description LIKE 'DUP-%') GROUP BY status;
```

Then `php backend/scripts/metrics-report.php --since=<test date>` for server-side
success / duplicate / failed counts (written by every `/sync/batch` to
`backend/storage/metrics/sync-*.jsonl`).

**Pass evidence:** zero duplicate rows; `duplicate` count in the metrics report is
> 0 (proves the retry path really ran and was deduplicated, not that nothing was
resent); all 10 present once.

#### A3. Mixed-kind and ordering spot-check (1 pass)

Offline on one on-duty shift: duty change, 3 GPS points, a dispatch status step,
an SOS (if on a test barangay), a referral, an accomplishment entry. Reconnect.
Confirm SOS-first ordering and that each kind landed once (processing order in
`SyncController`: sos · incident · referral · gps · duty_status · dispatch_status ·
availability · accomplishment_entry · school_checkin).

#### A4. Known open items to observe, not fix (record as found)

- Offline > 15 min then cold start: DEVLOG 2026-09-19 (4) found Login being shown;
  option B was built 2026-09-19 (6). Re-verify: stay offline 20 min, force-stop, relaunch;
  expected = cached view opens, writes queue.
- The local-schema upgrade path through v10 (`admin_incident_outbox`) and the
  workflow tables (`availability_local`, `accomplishment_entry_local`,
  `referral_local`, `school_checkin_local`) has never run on a device. Install the new
  APK **over** an older one (don't clear data) and confirm the old queue survives.
- `closes_client_event_id` school check-out path: never device-run (HANDOFF).
- Discard SQL never run against SQLCipher (HANDOFF).

#### A5. Report format

Table: trial · N · survived · reached server · duplicates · notes. Plus
sync latency (reconnect → last row in DB) per trial, since "Sync latency" is its
own evaluation item and the same data feeds it. Log in DEVLOG; reconcile
`docs/WORKFLOWS_AND_RULES.md` if behaviour differs from its table.

---

### Plan B — Notification end-to-end reliability (FCM → ack → SMS fallback)

**Question answered:** how often does each tier of Rule 12's ladder deliver, and
does a failure ever vanish silently? Maps to ISO plan metric (d).

Ladder under test (`NotificationDispatcher`, `notification-worker.php`):
no device / FCM fail → retry once → SMS on 2nd failure · FCM `sent` and no ack in
60 s → `ack_timeout` only, **no auto-SMS** (Rule 24).

#### B0. Prerequisites

- `FCM_SERVICE_ACCOUNT_PATH` set in `backend/.env`; `mobile/android/app/google-services.json`
  present (gitignored, per machine). `GET /system/health` shows `fcm` not `not_configured`.
- `GSM_GATEWAY_ENABLED=true`, gateway phone adb-visible (serial in `GSM_GATEWAY_DEVICE_SERIAL`),
  gateway app launched once after install, `php backend/scripts/gsm-ingest-daemon.php --status` OK.
- `php backend/scripts/notification-worker.php --daemon` running (it is the only thing that
  sets `ack_timeout`). Without it scenario B3 can't pass.
- Use a **test Tanod phone number you control** so real SMS cost/PII is nil.

#### B1. Scenario matrix (run each; N shown)

| # | Scenario | How to force it | N | Expected delivery rows |
|---|---|---|---|---|
| B1 | Happy path, app foreground | Admin web: dispatch the Tanod | 10 | fcm `sent` (attempt 1), `acknowledged_at` set after tap |
| B2 | App backgrounded / screen locked | lock screen, dispatch | 10 | fcm `sent`, full-screen critical alert shows, ack on tap |
| B3 | Sent, **never acknowledged** | ignore the alert 70 s | 5 | fcm `sent` → `ack_timeout` within ~15 s of 60 s; **no SMS row** |
| B4 | Phone offline (airplane) at send | airplane mode, dispatch | 5 | FCM accepted by Google but undelivered, or fails; record what the ladder does and what the Tanod sees on reconnect |
| B5 | No registered device | deactivate the device (`PATCH /devices/:id/deactivate`), dispatch | 3 | SMS `sms_log` row, no fcm row |
| B6 | FCM hard failure | temporarily blank `FCM_SERVICE_ACCOUNT_PATH` (restore after) or revoke token | 3 | fcm `failed` attempt 1 + attempt 2, then SMS |
| B7 | SMS fallback itself fails | B6 with the gateway phone unplugged | 2 | `sms_log.failure_reason` set, `GET /system/health` flags exhaustion |
| B8 | `dispatch_offer` critical alert | night window offer (or set test hours) | 3 | critical overlay; **Android side never compiled/run** (HANDOFF open item 2) |
| B9 | Tanod SOS → Admin/SMS path | raise SOS | 3 | per Rule 27, incl. no-GPS fix |

Every scenario: record dispatch→buzz time with a stopwatch or screen recording
(`adb shell screenrecord`) and compare to `notification_delivery.initiated_at / sent_at`.

#### B2. Queries

```sql
SELECT n.notification_id, n.notification_type, d.channel, d.attempt_no, d.status,
       d.failure_reason, d.initiated_at, d.sent_at, d.ack_timeout_at, t.ack_status, t.acknowledged_at
FROM notification n
JOIN notification_target t ON t.notification_id = n.notification_id
LEFT JOIN notification_delivery d ON d.notification_target_id = t.notification_target_id
WHERE n.notification_id >= <first id of the run> ORDER BY n.notification_id, d.channel, d.attempt_no;

SELECT message_type, status, failure_reason, receiver_number, created_at FROM sms_log
WHERE created_at >= '<run start UTC>' ORDER BY created_at;
```

Also `adb shell content query --uri content://sms/sent` on the **gateway** phone to prove
the SMS physically left (the M13 method), and `adb logcat -d | grep -i correlation` to match
the backend `correlation_id`.

#### B3. Pass evidence

- Per scenario: delivered / total, median and worst latency, and the DB rows above saved as a CSV.
- Rule 24: in B3 there is **zero** `sms_log` row for that notification.
- Rule 8/1: `raw_narrative` and coordinates absent from the FCM payload and from SMS bodies
  (read the actual delivered message on the phone).
- Nothing disappears: every notification has either an `acknowledged_at`, an `ack_timeout`,
  or a `failed`+SMS trail. An orphan with no delivery row is a **finding**.

#### B4. Known gaps to watch

- `sms_pending` / `sms_failed` badge states on the Tanod phone were never exercised
  (airplane mode / no SIM needed, DEVLOG 2026-09-24 (7)).
- Do Not Disturb bypass for critical alerts is deliberately not built.
- `CRITICAL_TYPES` in `criticalAlertStore.ts` and `CriticalAlertMessagingService.java`
  are kept in sync by hand: confirm all four types (`sos`, `priority_alert`, `dispatch`,
  `dispatch_offer`) raise the overlay on the device.
- Infinix `Usf_Hiber` freezer can delay broadcasts to the gateway app: note any lag in B6/B7.

---

### What I need from you to start

1. The phone (USB debugging on) and whether the gateway phone is the same device or a second one.
2. Confirmation that `google-services.json` and the Firebase service-account file are on this machine.
3. A test SIM/number for B5-B7, and the DB to use (recommended: a fresh disposable seed).
4. About 2-3 hours for Plan A and 2 hours for Plan B.
