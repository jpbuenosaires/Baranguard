# Baranguard — Roadmap to Finish (Defense, ISO 25010 and UAT only)

Rewritten 2026-10-28. **Scope decision:** Baranguard will not be deployed at any
barangay. The remaining work is the thesis defense, the ISO/IEC 25010
evaluation and User Acceptance Testing (UAT). Everything about go-live, rollout,
Cloudflare Access, UPS, signing keys, DPO and council decisions is out of scope
and is listed at the end as "not doing, say so in the thesis".

Sources: `docs/THESIS_OBJECTIVES_ALIGNMENT.md` (the 4 objectives),
`docs/ISO25010_EVALUATION_PLAN.md`, `docs/chapter4-instruments/`,
`docs/SPRINT8_DEVICE_TEST_PLANS.md`, `docs/DEFENSE_QA.md`,
`docs/DEFENSE_DB_RUNBOOK.md` and the 2026-10-28 audit reports.

**Rule for every phase:** only measured numbers go into Chapter 4. A feature that
was not run on a device is written as "implemented, not device-verified".

**Effort key:** S under half a day, M 1-2 days, L 3-5 days. **Owner:** YOU = your
hands or decision, AGENT = I can do it.

---

## Phase 0 — Make the demo and test system stable (2-3 days)

One database for everything: `baranguard_uiseed` (already at migration 0045, has
demo data). **Do not migrate the real `baranguard`**; nothing needs it.

| # | Task | Owner | Effort | Done when |
|---|---|---|---|---|
| 0.1 | Hard refresh (Ctrl+F5) on demo browsers | YOU | S | Password toggles work on login, Settings, Add User |
| 0.2 | Set `.env`: `GATEWAY_BARANGAY_ID`, `GSM_GATEWAY_ENABLED`, `BACKUP_ENCRYPTION_PASSPHRASE`; keep `DB_NAME=baranguard_uiseed` | YOU | S | Matches the runbook |
| 0.3 | Run `install-scheduled-backup-jobs.ps1`; confirm tasks in Task Scheduler (needed for SMS, SOS escalation, offers) | YOU | S | All tasks listed |
| 0.4 | Fresh shifts: seeded ones end 2026-10-29 22:00; publish a new roster covering the demo and UAT days | YOU | S | Dispatch works with no override reason |
| 0.5 | Install the debug APK on the test phone(s); check login eye icon, SOS hold button, alerts, sync | YOU | M | Written pass/fail per screen |
| 0.6 | Confirm 3 defaults: Silent SOS on, SOS escalates to Secretary and Punong Barangay, emergency numbers 911/160 | YOU | S | Rules 97 and 99 confirmed or changed |
| 0.7 | Dry run of the demo script end to end, timed | YOU + AGENT | M | One clean run |
| 0.8 | Read and personalise `docs/DEFENSE_QA.md` | YOU | S | You can answer all 10 questions |

---

## Phase 1 — Device and field evidence (1-2 weeks)

This is the evidence for Objectives 1-3 and for ISO Reliability and Performance.
Use the test plans in `docs/SPRINT8_DEVICE_TEST_PLANS.md`. Record each result,
with date and phone model, in `backend/DEVLOG.md`.

**Objective 2 — offline-first mobile app**
- Offline durability: create an incident, evidence, duty change and dispatch update in airplane mode, kill the app, reopen, reconnect. Expect one server row each. (M)
- Duplicate test: replay a `client_event_id` batch; the original row is returned. (S)
- Newer sync kinds and the check-out path (`closes_client_event_id`). (M)
- Mobile discard SQL on real SQLCipher. (S)
- Offline map package loads with no network. (S)
- Locked-screen GPS for 17+ minutes after the balanced-power change. (S)
- Critical alert queue: SOS and an offer together, SOS first. (S)
- Logout: GPS service stops and another user cannot see the first user's reports. (S)
- At least 3 phone models and 2 Android WebView versions. (M)

**Objective 3 — SMS best-effort SOS fallback**
- Data off, raise SOS: dashboard shows `fallback_channel=sms`, backup contact gets the text, no duplicate after sync. (M)
- No-GPS SOS: server records last-known or no-fix. (S)
- Airplane mode and no SIM (`sms_failed`). (S)
- Inbound text from a second phone is stored; STOP opts out. (S)
- Broadcast to 20+ numbers through the queue worker. (S)
- Unacknowledged SOS repeats at 2 minutes. (S)
- FCM push end to end with real `google-services.json`: foreground, background, killed. (M)
- Measure delivery times. (S)

**Objective 1 — GIS command centre**
- Browser pass of Dashboard, Dispatch, Live Map, Analytics for Admin and Punong Barangay. (M)
- Outdoor moving GPS run; compare the dashboard track to the real path. (M)
- Route accuracy with a real OpenRouteService key, including `stale` and `unavailable`. (S)
- Dispatch response time as defined in Master Reference §6 (`created_at` to first `arrived_at`). (S)
- Wording stays "near-real-time, polling", not "real-time". (S)

**Measurements**
- `measure-api-latency.mjs`: p50 and p95. (S)
- `metrics-report.php`: GPS delay and fix interval. (S)
- Sync success and duplicate rate from `storage/metrics/sync-*.jsonl`. (S)
- Concurrency of the 12 h/day cap and report creation under real Apache. (M)

**Browser and print**
- All four roles through every page. (M)
- Print and PDF on A4: statistical report, PB digest, Annex B, C-1, D, accomplishment report, week roster. (M)

**Exit:** each item has a dated result. Failures become fix tasks in Phase 2.

---

## Phase 2 — Fix what Phase 1 finds, plus gaps that hurt the evaluation (1-2 weeks, AGENT)

Keep this short. Only fix things a tester or panel would meet.

**Always do**
1. SOS replay then 500: replay row is inserted before the device lookup. (S)
2. Four open mobile P1s: SOS enqueue ordering, enqueue-before-send, patrol-service fixes, offline-clear. (M)
3. Retry a failed acknowledge on critical alerts. (S)
4. Fix the order-sensitive web map test ('SOS markers are never clustered'). (S)
5. Make `verify-sprint1-remaining.sh` and `verify-sprint4.sh` print counts. (S)
6. Unit tests for the alert queue and for SOS escalation timing. (M)

**Only if UAT users hit them (needs your OK first)**
7. Notify on dispatch cancel, and on swap request and outcome (new notification types and a migration). (M)
8. Show on-duty and nearest tanod in the assign picker. (M)
9. Tanod decline of a dispatch (new state). (L)
10. Notification list screen for ordinary pushes. (M)
11. TalkBack labels, input contrast and font-size cleanup on mobile. (M)

**Skipped on purpose (say it as a limitation):** encrypting the login token with Android Keystore, Do-Not-Disturb bypass, phone-built SMS for incident and position, STOP confirmation reply, phone-number masking.

---

## Phase 3 — UAT (2-3 weeks)

Instruments are in `docs/chapter4-instruments/` (interview guide, needs
questionnaire, SUS, consolidated UAT and ISO kits). Data needs are in
`docs/UAT_DATA_REQUIREMENTS.md`.

| # | Task | Owner | Effort |
|---|---|---|---|
| 3.1 | Research-ethics consent and participant list per role (Chief Tanod, Secretary, Punong Barangay, Tanod) | YOU | M |
| 3.2 | Prepare UAT data: accounts per role, fresh roster, a few seeded incidents; reset script between sessions | AGENT | M |
| 3.3 | Write 8-10 scenario tasks per role, each with a pass/fail rule (file an incident offline, dispatch, accept an offer, raise SOS, publish a roster, print a report, send a broadcast) | YOU + AGENT | M |
| 3.4 | Run sessions: observe, time each task, count errors, record on the UAT log | YOU | L |
| 3.5 | SUS questionnaire after each session; compute scores | YOU | S |
| 3.6 | Log every defect in `docs/DEFECT_LOG.md` with severity; fix P0 and P1 between rounds | AGENT | M |
| 3.7 | Second short round to confirm the fixes | YOU | M |

**UAT exit:** every role has completed its tasks, SUS scored, all P0 and P1
defects fixed or written up as limitations.

---

## Phase 4 — ISO/IEC 25010:2023 evaluation (2 weeks, overlaps Phases 1 and 3)

First confirm the characteristic names against the standard text (S). Then
collect one piece of real evidence per characteristic.

| Characteristic | Evidence | Source |
|---|---|---|
| Functional suitability | Schema-validate every §6 response; pass/fail per route; UAT task completion | `verify-json-contracts.php`, UAT log |
| Performance efficiency | p50 and p95 latency, GPS delay, response time | Phase 1 |
| Compatibility | Browsers and Android models/WebViews actually tested | Phase 1 |
| Interaction capability | SUS score, task time, error counts, accessibility pass | UAT |
| Reliability | Sync success and duplicate rate, restore drill, outage behaviour (workstation down: only SOS SMS works) | Phase 1, `restore-drill.sh` |
| Security | Tenant and ownership pentest suites, lockout and revocation, raw-PII audit, audit-report items fixed | verify suites, `docs/audit-2026-10-28/` |
| Maintainability | Test counts, route count, migrations, docs reconciled | `count-routes.php`, suites |
| Flexibility | Offline operation, per-barangay scoping, settings | Phase 1 |
| Safety | SOS and critical-alert behaviour, no false "synced" claims | Phase 1 |

Also: run every verify suite on a disposable DB and record counts in
`REFERENCE.md` §9 (S), and log any gap between reference and implementation in
`backend/DEVLOG.md`.

---

## Phase 5 — Thesis and defense (1-2 weeks)

1. Update the manuscript's 17 October test tables with the new measured numbers. (M)
2. Chapter 4 reports only measured results; each number points to a file. (M)
3. State the limitations first (list below). (S)
4. Keep "Baranguard complements DILG BIMSS, never replaces it" everywhere. (S)
5. State the removals: Electronic Blotter and AI pipeline (migration 0029), Fatigue Flags (0042). (S)
6. Rehearse the defense with `docs/DEFENSE_QA.md`; run the demo twice. (M)

---

## Order of work

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 (UAT) ──► Phase 5
              │                          │
              └────────► Phase 4 ◄───────┘
```

Phase 1 comes before UAT, so testers don't meet bugs you could have found.
Phase 4 collects evidence while the others run.

---

## Limitations to state (not doing, by scope)

- Not deployed at any barangay; evaluated on a demo database, test phones and one workstation.
- The real `baranguard` database is not migrated; no production data exists.
- No MFA and no Cloudflare Access; the public tunnel shows demo data only.
- No UPS or backup internet; a workstation outage stops everything except the SOS SMS fallback.
- SMS fallback covers SOS only, uses one gateway number, and carrier delivery is not guaranteed.
- Retention periods for newer tables are provisional; there is no DPO designation or NPC registration.
- MC 2026-037 text was not available, so annex layouts follow the forms you supplied.
- Android: release APK not signed for distribution; login token stored without Keystore encryption.
- Anything not run on a device is written as "implemented, not device-verified".

---

## Biggest risks

| Risk | Reduce it by |
|---|---|
| Nothing from 2026-10-28 has run on a real phone; a hidden Android bug appears during UAT | Phase 0.5 and Phase 1 first |
| UAT users meet a bug on camera | Dry run (0.7), fix between rounds (3.6, 3.7) |
| Numbers in Chapter 4 not backed by files | Phase 4 table; one evidence file per number |
| Seeded shifts expire, dispatch asks for an override reason | Task 0.4, reset script (3.2) |
| Panel asks about deployment, privacy or MFA | Limitations list and `DEFENSE_QA.md` |

---

## Definition of done

- Phases 0-5 complete with dated evidence in `backend/DEVLOG.md`.
- No open P0 or P1 in `docs/DEFECT_LOG.md`.
- Wiring check 0 failed; web tests, mobile tests and every verify suite green on a disposable DB, with counts recorded.
- Every UAT role finished its tasks; SUS scored.
- One evidence item for each ISO 25010 characteristic.
- Chapter 4 contains only measured numbers, each traceable to a file.

---

## Appendix — If Baranguard is ever deployed (kept on record, not part of this thesis)

These items are NOT being done now. They stay documented so a later team, or
the barangays, know what a real deployment still needs. The detail lives in
`docs/REMAINING.md`, `docs/POWER_CUT_PROCEDURE.md`, `docs/DEFENSE_DB_RUNBOOK.md`,
`docs/MAINTENANCE_AND_TURNOVER.md`, `docs/BREACH_RESPONSE_RUNBOOK.md` and
`docs/RISK_REGISTER.md`; none of those files were changed by this scope decision.

**Infrastructure and resilience**
- UPS for the workstation and a backup internet source (a workstation outage stops everything except the SOS SMS fallback). Follow `POWER_CUT_PROCEDURE.md` and test a real power cut.
- Run Apache, MySQL and cloudflared as Windows services (`install-autostart-services.ps1`, elevated) so the system returns after a reboot; add the Windows Firewall rule for port 80.
- Scheduled backups and a weekly restore drill checked on the real backup.
- One workstation per barangay with its own `GATEWAY_BARANGAY_ID` (Rule 92).

**Data and access**
- Back up, then migrate the real `baranguard` database (0003 and 0027-0045; 0029 and 0042 drop tables permanently); choose which database backs the public address.
- Cloudflare Access on the web host only (never the API), and a decision on MFA (C-02).
- Release signing key stored safely; Android Keystore for the login token; Do-Not-Disturb bypass for critical alerts.

**Legal and privacy (RA 10173)**
- Designate a DPO and check NPC registration; practise the 72-hour breach procedure; DPO review of the privacy notices.
- Council/COA decisions: retention periods for the newer tables, the one-year raw narrative ceiling, accepted attendance evidence for honoraria, and the Kagawad account model.
- Verify MC 2026-037 and the annex layouts against the circular itself.

**Rollout**
- Role training with the manuals, a two-week pilot in one barangay with a daily defect list, then the other three barangays, handover package and a daily Service Health check routine.
