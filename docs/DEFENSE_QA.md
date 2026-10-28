# Baranguard - Defense Q&A (prepared 2026-10-28)

Honest, evidence-based answers to the ten questions a skeptical panel is most likely to ask. Every answer names where the evidence lives. Test counts are the ones re-run on 2026-10-28 (`REFERENCE.md` section 9); nothing below claims a device or field result that does not exist.

## Known limitations - say these first

Open with these. A panel that hears them from you treats the rest as credible.

1. **Not device-verified.** The 2026-10 features and the 2026-10-28 mobile and messaging fixes were verified on disposable databases, vitest, jsdom and scripts only. The Gradle debug and release (R8) builds, the data-only FCM critical-alert path, the SOS hold button, the critical alert queue and offline sync of the newer record kinds have never run on a phone in their current form. The one device-verified SOS result is the successful `sent_by_sms` path on 2026-09-24 (`WORKFLOWS_AND_RULES.md` Scenario 7). Plans: `SPRINT8_DEVICE_TEST_PLANS.md`. Risks R-07, R-09, R-10, R-26.
2. **Real database not migrated.** Migrations 0029-0045 (45 migrations in all) are not applied to the real `baranguard` database. They were rehearsed on scratch copies of both real DBs on 2026-10-08 (0029-0038 then), and 0029, 0041 and 0042 are destructive. Until applied, the new code paths would fail against the real DB (R-04).
3. **The public tunnel shows demo data.** `baranguardph.win` and `api.baranguardph.win` are served from this workstation by a Cloudflare Named Tunnel, and `backend/.env` currently points at the demo database `baranguard_uiseed`. Visitors see simulated records, not real ones (R-02).
4. **No Cloudflare Access policy.** The API is reachable by anyone with the URL and protected by the application login only. Access was deferred on purpose, because gating the API would break the mobile app and the public endpoints; if added it covers the web host only (R-03).
5. **No MFA.** Multi-factor sign-in (C-02) was explicitly deferred (R-17).
6. **One workstation is a single point of failure**, and the background jobs (SMS inbound daemon, notification worker, offer sweeper) run only while a user is logged on until they are installed as services (R-01, R-05, R-28). Only SOS has a phone-side fallback independent of the workstation.
7. **Nothing is measured on real tanods or real data.** All tests and the UAT seed are synthetic. The ISO/IEC 25010 survey and UAT were not field results (R-24).
8. **Legal and governance items are open:** no Data Protection Officer designated, retention for the 2026-10 tables is provisional (365 days, purge off), and the text of MC 2026-037 and Annex A could not be read (R-11, R-12, R-13).

## 1. Security: how do you know one barangay cannot see another's data, or a tanod see a narrative?

- Every protected endpoint checks role, tenant and ownership on the server; a cross-tenant request is a 404, never a 403, so existence is not confirmed (`REFERENCE.md` section 2, Rules 2 and 12).
- `raw_narrative` is returned only by `GET /incidents/:id`, to the Secretary or to an Admin on a web session (Rule 1 as amended 2026-10-13). It is never sent by push, SMS, logs or audit metadata (Rules 1 and 8). Tanod and Admin phone sessions do not receive it.
- Phone sessions last 24 hours (7-day cap) and are revoked on the next request after logout, suspension or password change, because `auth_session` is checked every time (Rule 12, `SessionPolicy.php`). An Admin phone session is limited to an allow-list of routes, and its seven state-changing calls need the device header and signature.
- Evidence: `verify-sprint7-pentest-incidents.sh` (74 checks on 2026-10-09), `verify-b2-pentest-remaining-resources.sh` (59), `verify-device-signature.sh`, `verify-device-session.sh`; `TRACEABILITY_MATRIX.md` FR-05, FR-32.
- Say plainly: this is automated testing against disposable databases. There has been no independent penetration test, there is no MFA, and the API is public behind the app login (limitations 4 and 5).

## 2. Offline sync: what happens when two phones, or a phone and the desk, disagree?

- Every phone write goes to encrypted SQLite (SQLCipher) before the user leaves the screen and is shown as unsynced until the server confirms (Rule 7). Writes are serialised since 2026-10-28.
- Sync sends the queue in priority order (SOS first), in chunks of 50, with GPS capped at 200 points; a repeated `client_event_id` returns the original row, never a second one (Rules 3, 45-48; `OFFLINE_SYNC_CONFLICT_RULES.md`).
- Non-transient rejections revert the optimistic local state and flag the item for the tanod rather than dropping it.
- Evidence: `verify-sprint3.sh`, `verify-offline-sync-conflicts.sh`, `mobile/scripts/verify-sync-failure-class.mjs`, mobile `verify-local-schema.mjs` (266 passed, 0 failed on 2026-10-28), mobile vitest (193 passed).
- Say plainly: the offline durability and duplicate tests have not been run on a real phone; SQLCipher discard SQL and several offline kinds are unproven on a device (`TRACEABILITY_MATRIX.md` FR-30, FR-31, NFR-05). Accepting a night dispatch offer is online-only by decision (Rule 94), so a tanod with no data cannot take one.

## 3. BIMSS legality: does this replace the DILG barangay system?

- No, and it must not. DILG BIMS/KPIS is the mandated case ledger and ships its own blotter. Baranguard complements it: real-time dispatch, GPS, SOS and offline field capture, none of which BIMS provides (`REFERENCE.md` section 1, "settled, do not re-litigate"; manuscript Chapter 1 scope and delimitations).
- To stay on the right side of that line the system has no electronic blotter, no Lupon or Katarungang Pambarangay case records and no browsable case registry. The referral log is a delegation log with no names or narratives, and an incident record is explicitly "not the barangay's official blotter entry" (manuscript glossary).
- Say plainly: the circular numbers (MC 2025-104 for LGUSS-BIMS, MC 2026-037 for Safer School Zones) come from secondary sources and have not been checked against the issued text (`DILG_CIRCULARS_NOTES.md`, REFERENCE section 1). Nothing in the code depends on them.

## 4. Data privacy (RA 10173): what personal data do you hold and how is it protected?

- Inventory by category, with legal basis and retention: `DATA_INVENTORY.md`. Privacy impact assessment: `PRIVACY_IMPACT_ASSESSMENT.md`. Notices (drafts): `PRIVACY_NOTICES.md`, `PRIVACY_NOTICE_WEB_DRAFT.md`. Breach plan (draft): `BREACH_RESPONSE_RUNBOOK.md`.
- Controls: data stays on the barangay's own workstation (one workstation and one database per barangay, Rule 92); no cloud AI; the raw narrative is purged after one year unless under legal hold (Rule 82); audit metadata holds identifiers and statuses only (Rule 8); suspended or deactivated accounts lose access immediately; SMS subscribers are consent-tracked and an opt-out is recorded, not deleted.
- Since 2026-10-28 inbound human texts (sender number and body) are stored in `sms_log`; the privacy notice and data inventory were updated, and a STOP, TIGIL or UNSUBSCRIBE text opts the sender out (Rule 101; R-25).
- Third parties that see some data: Firebase Cloud Messaging (no narrative, no names or coordinates in the push), OpenRouteService (live coordinates for routing), OpenStreetMap tiles on the web (viewed areas). All are listed in `DATA_INVENTORY.md` and risk R-16.
- Say plainly: no DPO is designated, the notices and breach runbook are drafts not adopted by the barangay council, and retention for the newer tables is provisional.

## 5. Why no AI and no electronic blotter?

- Both were built, then removed on 2026-10-01 (migration 0029) by decision. The barangays are directed to keep the blotter and Lupon records in binders, and DILG BIMS/KPIS is the case ledger, so a Baranguard blotter would duplicate a mandated records function (a legal liability) and leave the AI redaction and summary pipeline with nothing to feed (`REFERENCE.md` section 1).
- It also removes a class of risk: no model sees a narrative, so Rule 1 has one fewer path to defend. Fatigue Flags were removed for similar reasons (0042); the 12-hour daily cap stays.
- Do not rebuild without a new decision. The thesis objectives were realigned accordingly (`THESIS_OBJECTIVES_ALIGNMENT.md`); AI-evaluation artifacts are history only.

## 6. SOS reliability: what if the signal, the GPS or the workstation fails?

- The SOS control is on every tanod tab (hold 800 ms; Home has its own button). It waits at most 2 seconds for GPS, then sends; the server falls back to the last known position or `no_fix` and still creates the SOS (Rules 22, 97).
- If the server does not answer in 5 seconds the phone queues the SOS and sends an AES-256-GCM encrypted SOS envelope by SMS to the gateway phone, which creates a real SOS (`fallback_channel='sms'`, no duplicate on later sync), plus a plain text to a configured backup contact (Rules 23, 25).
- If nobody at the desk acknowledges, the SOS is re-sent every 2 minutes, up to 5 rounds; the Secretary and Punong Barangay are added from the third (Rule 99). SOS pushes are data-only FCM so the native alert service runs when the app is closed (Rule 98).
- Evidence: `verify-sprint4.sh`, `verify-sprint4-phase2-3.sh`, `verify-messaging-hardening.sh`, `mobile/scripts/verify-sos-envelope.mjs`.
- Say plainly: device-verified once for the successful SMS path on 2026-09-24; the failed-SMS path, no-GPS path, hold button, escalation and data-only FCM are code-only. SMS is best-effort: "Sent" means the SIM accepted it, there is no delivery report, and the envelope expires after 25 minutes if the inbound daemon is down. The escalation needs the notification worker task registered, and the recipient scope beyond the Admin awaits the owner's confirmation (R-27, R-28).

## 7. Testing evidence: what has actually been run?

Re-run 2026-10-28 on the working tree: 103 routes in 27 files (`count-routes.php`); `verify-web-wiring.mjs` 938 passed, 0 failed; `web/tests` 736 tests, 735 passed and 1 failed in a known order-sensitive map test that passes alone; mobile vitest 193 tests passed (30 files); mobile `verify-local-schema.mjs` 266 passed, 0 failed; 39 backend `verify-*.sh` suites plus 5 `.php/.mjs` verifiers, each on a disposable database and user, never the real DB. Manuscript Tables 4-13 to 4-15 report the 17 October runs, including a response-time run on the demonstration database.

- Mapped requirement by requirement in `TRACEABILITY_MATRIX.md`; defects and fixes in `DEFECT_LOG.md`.
- Say plainly: these are code-correctness checks. A verify script proves nothing about a route it never calls (HANDOFF), static checks have been green on code with real defects, and system and acceptance testing on phones and with users is the gap. All data is synthetic.

## 8. Limitations: what does it not do?

- Residents cannot report directly; staff log each report with its channel (Rule 94). No low-data mode; tanods use their own mobile data.
- Secretary and Punong Barangay have no phone app; "real-time" is polling (about 15 seconds on the web). No notification list screen on the phone, no tanod "decline", no notification on dispatch cancel or swap (`DEVLOG` 2026-10-28 open list).
- Reports and rosters are printed and signed on paper; the system does not track signatures (Rule 80).
- Sections above under "Known limitations" apply in full. Add: only Android is supported (minimum Android 7.0), and the phone's SOS SMS text still carries the tanod's name and a position (owner decision pending).

## 9. SMS fallback: how can you trust texting through a tethered phone?

- Outbound and inbound SMS go through one dedicated Android phone on the workstation's USB, using its own SIM, with no cloud aggregator and no per-message fee. Setup: `sms-gateway/README.md`, `OPERATIONS_MANUAL.md` section 7.
- Honesty rules: status is Waiting to send, Sent, not confirmed, Sent or Failed, and never Delivered (Rule 100); failures are recorded, not dropped; broadcasts are queued, limited to 100 recipients and own barangay, with a duplicate guard (Rule 102).
- Say plainly: the gateway is one phone and one SIM, which makes it a single point of failure; it needs load and signal; a text that stays "Sent, not confirmed" is not retried automatically; the inbound daemon and worker must be running (limitation 6). It is a fallback and an advisory channel, not a guaranteed-delivery system.

## 10. Scalability: could it serve more than a few tanods?

- Scope is four barangays in Pilar, Sorsogon, each on its own workstation and database (Rule 92); tenant separation inside the database is a second safeguard. Targets are a few tanods per barangay, not a city.
- Evidence is small: a response-time run of 40 requests per endpoint on the demonstration database (159 incidents, 134 dispatches, 3,233 GPS fixes), manuscript Table 4-15. No load or concurrency test exists. Concurrency claims (first accept wins for offers, the 12-hour cap) are reasoned and tested on a single-threaded test server, not demonstrated under real Apache (R-08).
- Known costs: polling rather than push to the web, serial per-recipient SMS (now moved to a worker), and one workstation per barangay.
- Say plainly: scaling beyond the stated scope is untested and would need a different deployment, which was considered and rejected by the owner (cloud hosting).
