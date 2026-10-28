# Baranguard - Defense Pack

Purpose: everything for the defense in one place: prepared panel answers and known limitations, the demo database runbook, and the manuscript and instrument audit with what is fixed and what is still open.
Status / Last updated: 2026-10-28. The Q&A and runbook are current; the audit's section A (reference corrections) and the 27-vs-57 sample decision are still open.

## Contents

1. [Panel Q&A and limitations](#1-panel-qa-and-limitations)
2. [Demo database runbook](#2-demo-database-runbook)
3. [Manuscript and instrument audit](#3-manuscript-and-instrument-audit)

---

## 1. Panel Q&A and limitations

Honest, evidence-based answers to the ten questions a skeptical panel is most likely to ask. Every answer names where the evidence lives. Test counts are the ones re-run on 2026-10-28 (`REFERENCE.md` section 9); nothing below claims a device or field result that does not exist.

### Known limitations - say these first

Open with these. A panel that hears them from you treats the rest as credible.

1. **Not device-verified.** The 2026-10 features and the 2026-10-28 mobile and messaging fixes were verified on disposable databases, vitest, jsdom and scripts only. The Gradle debug and release (R8) builds, the data-only FCM critical-alert path, the SOS hold button, the critical alert queue and offline sync of the newer record kinds have never run on a phone in their current form. The one device-verified SOS result is the successful `sent_by_sms` path on 2026-09-24 (`WORKFLOWS_AND_RULES.md` Scenario 7). Plans: `EVALUATION.md` Section 3. Risks R-07, R-09, R-10, R-26.
2. **Real database not migrated.** Migrations 0029-0045 (45 migrations in all) are not applied to the real `baranguard` database. They were rehearsed on scratch copies of both real DBs on 2026-10-08 (0029-0038 then), and 0029, 0041 and 0042 are destructive. Until applied, the new code paths would fail against the real DB (R-04).
3. **The public tunnel shows demo data (not part of the evaluated scope).** `baranguardph.win` and `api.baranguardph.win` are served from this workstation by a Cloudflare Named Tunnel, and `backend/.env` currently points at the demo database `baranguard_uiseed`. Visitors see simulated records, not real ones (R-02).
4. **No Cloudflare Access policy (not part of the evaluated scope).** The API is reachable by anyone with the URL and protected by the application login only. Access was deferred on purpose, because gating the API would break the mobile app and the public endpoints; if added it covers the web host only (R-03).
5. **No MFA.** Multi-factor sign-in (C-02) was explicitly deferred (R-17).
6. **One workstation is a single point of failure**, and the background jobs (SMS inbound daemon, notification worker, offer sweeper) run only while a user is logged on until they are installed as services (R-01, R-05, R-28). Only SOS has a phone-side fallback independent of the workstation.
7. **Nothing is measured on real tanods or real data.** All tests and the UAT seed are synthetic. The ISO/IEC 25010 survey and UAT were not field results (R-24).
8. **Legal and governance items are open:** no Data Protection Officer designated, retention for the 2026-10 tables is provisional (365 days, purge off), and the text of MC 2026-037 and Annex A could not be read (R-11, R-12, R-13).

### Security: how do you know one barangay cannot see another's data, or a tanod see a narrative?

- Every protected endpoint checks role, tenant and ownership on the server; a cross-tenant request is a 404, never a 403, so existence is not confirmed (`REFERENCE.md` section 2, Rules 2 and 12).
- `raw_narrative` is returned only by `GET /incidents/:id`, to the Secretary or to an Admin on a web session (Rule 1 as amended 2026-10-13). It is never sent by push, SMS, logs or audit metadata (Rules 1 and 8). Tanod and Admin phone sessions do not receive it.
- Phone sessions last 24 hours (7-day cap) and are revoked on the next request after logout, suspension or password change, because `auth_session` is checked every time (Rule 12, `SessionPolicy.php`). An Admin phone session is limited to an allow-list of routes, and its seven state-changing calls need the device header and signature.
- Evidence: `verify-sprint7-pentest-incidents.sh` (74 checks on 2026-10-09), `verify-b2-pentest-remaining-resources.sh` (59), `verify-device-signature.sh`, `verify-device-session.sh`; `SRS.md` FR-05, FR-32.
- Say plainly: this is automated testing against disposable databases. There has been no independent penetration test, there is no MFA, and the API is public behind the app login (limitations 4 and 5).

### Offline sync: what happens when two phones, or a phone and the desk, disagree?

- Every phone write goes to encrypted SQLite (SQLCipher) before the user leaves the screen and is shown as unsynced until the server confirms (Rule 7). Writes are serialised since 2026-10-28.
- Sync sends the queue in priority order (SOS first), in chunks of 50, with GPS capped at 200 points; a repeated `client_event_id` returns the original row, never a second one (Rules 3, 45-48; `WORKFLOWS_AND_RULES.md`).
- Non-transient rejections revert the optimistic local state and flag the item for the tanod rather than dropping it.
- Evidence: `verify-sprint3.sh`, `verify-offline-sync-conflicts.sh`, `mobile/scripts/verify-sync-failure-class.mjs`, mobile `verify-local-schema.mjs` (266 passed, 0 failed on 2026-10-28), mobile vitest (193 passed).
- Say plainly: the offline durability and duplicate tests have not been run on a real phone; SQLCipher discard SQL and several offline kinds are unproven on a device (`SRS.md` FR-30, FR-31, NFR-05). Accepting a night dispatch offer is online-only by decision (Rule 94), so a tanod with no data cannot take one.

### BIMSS legality: does this replace the DILG barangay system?

- No, and it must not. DILG BIMS/KPIS is the mandated case ledger and ships its own blotter. Baranguard complements it: real-time dispatch, GPS, SOS and offline field capture, none of which BIMS provides (`REFERENCE.md` section 1, "settled, do not re-litigate"; manuscript Chapter 1 scope and delimitations).
- To stay on the right side of that line the system has no electronic blotter, no Lupon or Katarungang Pambarangay case records and no browsable case registry. The referral log is a delegation log with no names or narratives, and an incident record is explicitly "not the barangay's official blotter entry" (manuscript glossary).
- Say plainly: the circular numbers (MC 2025-104 for LGUSS-BIMS, MC 2026-037 for Safer School Zones) come from secondary sources and have not been checked against the issued text (REFERENCE section 1). Nothing in the code depends on them.

### Data privacy (RA 10173): what personal data do you hold and how is it protected?

- Inventory by category, with legal basis and retention: `PRIVACY.md`. Privacy impact assessment: `PRIVACY.md`. Draft notice wording is in the appendix of the PIA. No breach runbook is adopted (the barangay council would need to adopt one before deployment).
- Controls: data stays on the barangay's own workstation (one workstation and one database per barangay, Rule 92); no cloud AI; the raw narrative is purged after one year unless under legal hold (Rule 82); audit metadata holds identifiers and statuses only (Rule 8); suspended or deactivated accounts lose access immediately; SMS subscribers are consent-tracked and an opt-out is recorded, not deleted.
- Since 2026-10-28 inbound human texts (sender number and body) are stored in `sms_log`; the draft notice wording and data inventory were updated, and a STOP, TIGIL or UNSUBSCRIBE text opts the sender out (Rule 101; R-25).
- Third parties that see some data: Firebase Cloud Messaging (no narrative, no names or coordinates in the push), OpenRouteService (live coordinates for routing), OpenStreetMap tiles on the web (viewed areas). All are listed in `PRIVACY.md` and risk R-16.
- Say plainly: no DPO is designated, the notices and breach runbook are drafts not adopted by the barangay council, and retention for the newer tables is provisional.

### Why no AI and no electronic blotter?

- Both were built, then removed on 2026-10-01 (migration 0029) by decision. The barangays are directed to keep the blotter and Lupon records in binders, and DILG BIMS/KPIS is the case ledger, so a Baranguard blotter would duplicate a mandated records function (a legal liability) and leave the AI redaction and summary pipeline with nothing to feed (`REFERENCE.md` section 1).
- It also removes a class of risk: no model sees a narrative, so Rule 1 has one fewer path to defend. Fatigue Flags were removed for similar reasons (0042); the 12-hour daily cap stays.
- Do not rebuild without a new decision. The thesis objectives were realigned accordingly (`SRS.md` section 5); AI-evaluation artifacts are history only.

### SOS reliability: what if the signal, the GPS or the workstation fails?

- The SOS control is on every tanod tab (hold 800 ms; Home has its own button). It waits at most 2 seconds for GPS, then sends; the server falls back to the last known position or `no_fix` and still creates the SOS (Rules 22, 97).
- If the server does not answer in 5 seconds the phone queues the SOS and sends an AES-256-GCM encrypted SOS envelope by SMS to the gateway phone, which creates a real SOS (`fallback_channel='sms'`, no duplicate on later sync), plus a plain text to a configured backup contact (Rules 23, 25).
- If nobody at the desk acknowledges, the SOS is re-sent every 2 minutes, up to 5 rounds; the Secretary and Punong Barangay are added from the third (Rule 99). SOS pushes are data-only FCM so the native alert service runs when the app is closed (Rule 98).
- Evidence: `verify-sprint4.sh`, `verify-sprint4-phase2-3.sh`, `verify-messaging-hardening.sh`, `mobile/scripts/verify-sos-envelope.mjs`.
- Say plainly: device-verified once for the successful SMS path on 2026-09-24; the failed-SMS path, no-GPS path, hold button, escalation and data-only FCM are code-only. SMS is best-effort: "Sent" means the SIM accepted it, there is no delivery report, and the envelope expires after 25 minutes if the inbound daemon is down. The escalation needs the notification worker task registered, and the recipient scope beyond the Admin awaits the owner's confirmation (R-27, R-28).

### Testing evidence: what has actually been run?

Re-run 2026-10-28 on the working tree: 103 routes in 27 files (`count-routes.php`); `verify-web-wiring.mjs` 938 passed, 0 failed; `web/tests` 736 tests, 735 passed and 1 failed in a known order-sensitive map test that passes alone; mobile vitest 193 tests passed (30 files); mobile `verify-local-schema.mjs` 266 passed, 0 failed; 39 backend `verify-*.sh` suites plus 5 `.php/.mjs` verifiers, each on a disposable database and user, never the real DB. Manuscript Tables 4-13 to 4-15 report the 17 October runs, including a response-time run on the demonstration database.

- Mapped requirement by requirement in `SRS.md`; defects and fixes in `RISKS_AND_DEFECTS.md`.
- Say plainly: these are code-correctness checks. A verify script proves nothing about a route it never calls (HANDOFF), static checks have been green on code with real defects, and system and acceptance testing on phones and with users is the gap. All data is synthetic.

### Limitations: what does it not do?

- Residents cannot report directly; staff log each report with its channel (Rule 94). No low-data mode; tanods use their own mobile data.
- Secretary and Punong Barangay have no phone app; "real-time" is polling (about 15 seconds on the web). No notification list screen on the phone, no tanod "decline", no notification on dispatch cancel or swap (`DEVLOG` 2026-10-28 open list).
- Reports and rosters are printed and signed on paper; the system does not track signatures (Rule 80).
- Sections above under "Known limitations" apply in full. Add: only Android is supported (minimum Android 7.0), and the phone's SOS SMS text still carries the tanod's name and a position (owner decision pending).

### SMS fallback: how can you trust texting through a tethered phone?

- Outbound and inbound SMS go through one dedicated Android phone on the workstation's USB, using its own SIM, with no cloud aggregator and no per-message fee. Setup: `sms-gateway/README.md`.
- Honesty rules: status is Waiting to send, Sent, not confirmed, Sent or Failed, and never Delivered (Rule 100); failures are recorded, not dropped; broadcasts are queued, limited to 100 recipients and own barangay, with a duplicate guard (Rule 102).
- Say plainly: the gateway is one phone and one SIM, which makes it a single point of failure; it needs load and signal; a text that stays "Sent, not confirmed" is not retried automatically; the inbound daemon and worker must be running (limitation 6). It is a fallback and an advisory channel, not a guaranteed-delivery system.

### Scalability: could it serve more than a few tanods?

- Scope is four barangays in Pilar, Sorsogon, each on its own workstation and database (Rule 92); tenant separation inside the database is a second safeguard. Targets are a few tanods per barangay, not a city.
- Evidence is small: a response-time run of 40 requests per endpoint on the demonstration database (159 incidents, 134 dispatches, 3,233 GPS fixes), manuscript Table 4-15. No load or concurrency test exists. Concurrency claims (first accept wins for offers, the 12-hour cap) are reasoned and tested on a single-threaded test server, not demonstrated under real Apache (R-08).
- Known costs: polling rather than push to the web, serial per-recipient SMS (now moved to a worker), and one workstation per barangay.
- Say plainly: scaling beyond the stated scope is untested and would need a different deployment, which was considered and rejected by the owner (cloud hosting).

---
## 2. Demo database runbook

Written 2026-10-28. Everything here was checked against the live XAMPP MariaDB 10.4.32 on this workstation
(port **3306**, not 3307: `C:\xampp\mysql\bin\my.ini` says 3306, and `backend/.env` agrees; older docs that say 3307 are stale).
Root has an empty password on this XAMPP install, so the commands below use `-uroot` with no `-p`.

### Where each real database stands (measured, read-only)

There is no migration-tracking table, so the level was inferred by comparing `information_schema` to the migrations.

| Database | Level | Lacks | Data |
|---|---|---|---|
| `baranguard_uiseed` | **0045, complete** | nothing | 11 users, 67 incidents, 43 dispatches, 356 shifts, 40 SMS, 139 audit rows |
| `baranguard` (real) | 0026 plus the early migrations, **but 0003 is also missing** (`shift_schedule.user_id` still NOT NULL) | **0003, 0027-0045** | 3 users, 0 incidents/dispatches/shifts/SMS, 7 audit rows, 4 barangays |

Note `scripts/apply-migrations-0029-0039.ps1` is NOT enough for the real DB (it skips 0003, 0027, 0028 and 0040-0045).
Use `backend/scripts/apply-migrations-range.sh` (new, below).

### Recommendation: use `baranguard_uiseed` for the defense

- It is already at 0045, so there is nothing to migrate and nothing destructive to run the week of the defense.
- It has realistic demo data (67 incidents, rosters, referrals, SMS), so every screen has something to show. The real DB is empty.
- `backend/.env` already points at it (`DB_NAME=baranguard_uiseed`) and the public tunnel already serves it.
- Seed password is documented in `docs/HANDOFF.md` (`admin.dao`, `secretary.dao`, `punong.dao`, `tanod.reyes`, ...).
- Applying 0029 and 0042 to the real DB drops tables for good; do that after the defense, not before it.

Watch-outs with the seed data (measured): the seeded published shifts end **2026-10-29 22:00**. Dispatch needs a published
shift covering "now" (422 `NO_PUBLISHED_SHIFT` otherwise, unless the Admin supplies an override reason). If the defense is
after that, publish a fresh roster first (Personnel > Scheduler) or use the override reason in the demo.
Latest seeded incident is 2026-10-22.

### Rehearsal results (2026-10-28, scratch copies only)

Real DBs were only read (mysqldump, SELECT). Scratch DBs `baranguard_rehearsal_real` and `baranguard_rehearsal_seed` were created, then dropped, along with the throwaway MySQL user.

1. Dumped `baranguard` into `baranguard_rehearsal_real`; applied **0027 through 0045** in numeric order with `apply-migrations-range.sh`: all 19 applied with no error.
2. Comparing columns showed a single difference from `baranguard_uiseed`: `shift_schedule.user_id` NOT NULL, i.e. **0003 was missing**. Applied 0003. After that, columns, indexes (name, order, uniqueness) and foreign keys (delete rules) were **identical to `baranguard_uiseed`**; 34 tables.
3. Row counts before and after: `user` 3 -> 3, `audit_log` 7 -> 7, `barangay` 4 -> 4, `incident`/`dispatch`/`shift_schedule`/`sms_log` 0 -> 0. No data loss. (The real DB holds almost nothing, so this proves little about data-preserving behaviour on large tables. The 2026-10-08 rehearsal on both DBs with data is in DEVLOG.)
4. Smoke test (`backend/scripts/smoke-rehearsal.sh`, throwaway app user + `php -S`): public `GET /barangays` 200, login OK, and 14 authenticated GETs (incidents, dispatch, shifts, nav-counts, summary, users, schools, availability, referrals, accomplishment-reports, dispatch-offers, system/health, notifications, audit-log) all **200**, on both the migrated copy of `baranguard` and the copy of `baranguard_uiseed`. Not tested: writes, mobile device sessions, SMS gateway, FCM, concurrency.
5. Scratch DBs and scratch user dropped; `SHOW DATABASES` afterwards lists only the original two plus system schemas.

### Commands (only needed if you ever migrate the real `baranguard`)

Run in Git Bash from the repo root. Stop Apache or put the dashboard in a quiet period first.

```bash
cd "/c/Users/Jayson Buenosaires/Videos/Baranguard"
M=/c/xampp/mysql/bin/mysql.exe; D=/c/xampp/mysql/bin/mysqldump.exe
# 1. BACKUP FIRST (plain dump, safe to restore with mysql)
mkdir -p backend/backups
$D -uroot -h127.0.0.1 -P3306 --single-transaction --routines --triggers baranguard \
   > backend/backups/pre-defense-baranguard-$(date -u +%Y%m%dT%H%M%SZ).sql
ls -l backend/backups | tail -2            # confirm the file is not 0 bytes

# 2. Optional dress rehearsal on a throwaway copy (recommended, 30 seconds)
$M -uroot -h127.0.0.1 -P3306 -e "create database baranguard_rehearsal character set utf8mb4"
$D -uroot -h127.0.0.1 -P3306 --single-transaction --routines --triggers baranguard | $M -uroot -h127.0.0.1 -P3306 baranguard_rehearsal
bash backend/scripts/apply-migrations-range.sh baranguard_rehearsal 3 3
bash backend/scripts/apply-migrations-range.sh baranguard_rehearsal 27 45
$M -uroot -h127.0.0.1 -P3306 -e "drop database baranguard_rehearsal"

# 3. Apply for real (stops at the first error). 0003 first, then 0027-0045.
bash backend/scripts/apply-migrations-range.sh baranguard 3 3
bash backend/scripts/apply-migrations-range.sh baranguard 27 45
```

Check it worked: `$M -uroot -P3306 -e "describe baranguard.shift_schedule"` shows `user_id ... YES`, `show tables from baranguard` lists 34 tables
and no `blotter_record`, `ai_processing_log` or `fatigue_flag`.

For `baranguard_uiseed` there is nothing to apply. Do not re-run migrations on it (0029 and 0042 would fail or misbehave).

#### Rollback (restore path)

Restoring replaces the database with the dump, so it discards anything written since the backup.

```bash
$M -uroot -h127.0.0.1 -P3306 -e "drop database baranguard; create database baranguard character set utf8mb4"
$M -uroot -h127.0.0.1 -P3306 baranguard < backend/backups/pre-defense-baranguard-<STAMP>.sql
```

For the encrypted backups made by `backend/scripts/backup.sh`, use `backend/scripts/restore.sh <file.sql.enc> [target_db]`
(needs `DB_PASSWORD` and `BACKUP_ENCRYPTION_PASSPHRASE`; restores into `<DB_NAME>_restore_test` unless you name a target).
The same dump/restore pair works for `baranguard_uiseed`; existing safety dumps are in `backend/backups/`
(for example `pre-uat-rebuild-baranguard_uiseed-20261013T221349Z.sql`). Take a fresh one before the defense.

### `backend/.env` values to check (do not paste secrets anywhere)

Names present today: `DB_*`, `JWT_SECRET`, `JWT_EXPIRES_IN_MINUTES`, `CORS_ALLOWED_ORIGIN`, `OLLAMA_*` (harmless leftovers), `ORS_API_KEY`,
`FCM_SERVICE_ACCOUNT_PATH`, `DEVICE_SECRET_MASTER_KEY`, `INTERNAL_SERVICE_TOKEN`.

| Key | Today | What to do |
|---|---|---|
| `DB_NAME` | `baranguard_uiseed` | Keep for the defense. `DB_PORT=3306`, `DB_HOST=127.0.0.1` are correct. |
| `CORS_ALLOWED_ORIGIN` | `https://baranguardph.win,http://localhost,http://localhost:5173` | Fine. Add any other origin you will demo from. |
| `GSM_GATEWAY_ENABLED` | **not set** (code default is off; health shows `not_configured`) | Set `true` only if the gateway phone is plugged in and the app was launched once; otherwise leave off and say so. |
| `GATEWAY_BARANGAY_ID` | **not set** | Both DBs hold 4 barangays, so inbound SMS filing fails with "Cannot tell which barangay this gateway serves" until it is set (1 Dao, 2 Binanuahan, 3 Marifosque, 4 Banuyo). Set it if you demo inbound SMS. |
| `BACKUP_ENCRYPTION_PASSPHRASE` | **not set** | `backup.sh`, the scheduled backup and the restore drill all refuse to run without it. Choose one, record it somewhere safe (losing it makes every backup unreadable). |

I did not edit `.env`. Apache must be restarted (or PHP re-read) after changing it.

### Scheduled tasks

None of the Baranguard tasks is registered on this machine today (`schtasks /Query` finds no `Baranguard*` entry, checked 2026-10-28).
From a normal (non-elevated) PowerShell in the repo root, after setting `BACKUP_ENCRYPTION_PASSPHRASE`:

```powershell
powershell -ExecutionPolicy Bypass -File backend\scripts\install-scheduled-backup-jobs.ps1
```

Confirm: the script ends with a table of `TaskName, State`; the expected names are `BaranguardBackupRetention` (daily 02:00),
`BaranguardRestoreDrill` (Sunday 03:00), `BaranguardPbDigest` (Monday 06:00), `BaranguardDispatchOfferSweeper`,
`BaranguardNotificationWorker`, `BaranguardGsmIngest`. Also open Task Scheduler (`taskschd.msc`) > Task Scheduler Library and look for them,
or run `Get-ScheduledTask -TaskName Baranguard* | Select TaskName,State`. Test one: `Start-ScheduledTask -TaskName BaranguardBackupRetention`,
then read the newest log in `backend\backups\scheduled-logs\`. The dispatch-offer sweeper matters for the night-offer demo
(offers escalate only if it runs). `BaranguardGsmIngest` is started by the script and needs the gateway phone.
The retention job's purge, if run on demo data, is irreversible: use `php backend/scripts/retention-job.php --dry-run` first.

### Pre-defense checklist

- [ ] Fresh backup of `baranguard_uiseed` taken (section 4 commands with `baranguard_uiseed`), file not empty.
- [ ] `tasklist /FI "IMAGENAME eq mysqld.exe"` shows MariaDB; `netstat -ano | findstr :3306` shows it LISTENING (the `MySQL80` service is NOT in use here).
- [ ] Apache up: `http://localhost/baranguard/web/` loads; `http://localhost:8081/api/v1/barangays` returns 200. (`Start Baranguard.bat` starts Apache, MySQL and the tunnel.)
- [ ] Tunnel up: `cloudflared tunnel list` shows active connections for `baranguard`; `https://baranguardph.win` and `https://api.baranguardph.win/api/v1/barangays` return 200 from a phone on mobile data. It is a user process, so it dies on reboot or logoff.
- [ ] Seed logins work on the dashboard: `admin.dao`, `secretary.dao`, `punong.dao` (password in HANDOFF); `tanod.reyes` on the phone (use `tanod.reyes`, `tanod.delacruz`, `tanod.gubaton` or `tanod.dichoso`; `tanod.olayvar` is seeded suspended). Check none is locked (5 failed logins locks an account).
- [ ] Time zone: Windows is `Singapore Standard Time` (UTC+8, same offset as Asia/Manila), MariaDB `system_time_zone` is `Asia/Singapore`; the app stores UTC and displays Manila. `SELECT NOW()` should match the wall clock (it did, 2026-10-28 10:53). Check the clock again on the day.
- [ ] A published shift covers the demo time (seed shifts end 2026-10-29 22:00), or the override reason is ready.
- [ ] Mobile APK was built with `VITE_API_BASE_URL=https://api.baranguardph.win/api/v1` set explicitly (see HANDOFF build command); phone reaches the API.
- [ ] `GET /system/health` as Admin: expect honest `not_configured` for anything not set up (GSM gateway, FCM), never green for something unprobed.
- [ ] Say plainly in the defense that migrations 0029-0045 are applied to the demo DB only, not to the empty real DB.

### Helper scripts added

- `backend/scripts/apply-migrations-range.sh <db> <from> <to>`: applies numbered migrations in order, stops at the first error. No backup inside it.
- `backend/scripts/smoke-rehearsal.sh <scratch_db> <user> <password>`: read-only API smoke test; refuses `baranguard` and `baranguard_uiseed`; creates and removes its own throwaway DB user and server.

---
## 3. Manuscript and instrument audit

### Status of findings (2026-10-28)

| Finding | Status |
|---|---|
| G2 (UAT form contradicts itself) | **Fixed** in the UAT form |
| G3 (stale UAT labels) | **Fixed** in the UAT form; re-check on the final build during the pilot |
| A (reference integrity, wrong authors, misreported findings) | **Open** - corrections still to apply in the manuscript |
| G1a (27 respondents in the manuscript vs 57 in the instrument plan) | **Open** - sample decision with the adviser |
| G1b-f, G4, G5 | Open |
| G6 (version clutter) | Done: instrument files `03`-`06`, `08`, `10` were removed; only `01`, `02`, `07`, `09`, `11`, `12a-d` remain in `docs/chapter4-instruments/`. Read mentions of the removed files below as history |
| B, C, D, E | Open until applied to the manuscript |

**Document reviewed:** `docs/Baranguard_Capstone_Manuscript.html` (revised 2026-10-17, about 24,000 words, Chapters 1-4, References, Appendices A-B).
**Reviewed on:** 2026-10-28, against the code as of commit `8c4ed06`, and with every scholarly reference checked online.
**Scope decision applied:** the system will not be deployed at any barangay; the study ends with ISO/IEC 25010 evaluation and UAT.

Severity: **P0** = a panel can reject or seriously question the study on this; **P1** = must fix before submission; **P2** = should fix.

---

### Verdict in one paragraph

The system description (Section 4.3) is unusually strong, honest and well evidenced. The weak points are elsewhere: **three references name the wrong authors or misreport what the source says**, **Chapter 3 states in the past tense that fieldwork, consent and validation already happened while Chapter 4 says they are pending**, and **the study is still framed around "deployment" and a before/after comparison that the new scope (no barangay deployment) can no longer deliver**. Fix those three groups first; the rest is ordinary revision work.

---

### A. Reference integrity (checked online)

| # | Sev | Reference in the manuscript | What the source actually shows | Fix |
|---|---|---|---|---|
| A1 | **P0** | Lardera, L. P., & Bagolong, S. (2026). *Barangay information management system with automated mobile messaging…* IJSAT 17(1) | The IJSAT page lists a **single author, Riel Montefalcon Rivas**; DOI 10.71097/IJSAT.v17.i1.10412 | Correct the author to Rivas, R. M. (2026), add the DOI, and change every in-text "Lardera and Bagolong (2026)". |
| A2 | **P0** | Omar, S., et al. (2024). *From SMS to RCS: Intelligent frameworks for resilient messaging…* Telecommunications Research Journal, ResearchGate link | Authors are **Mykhailo Odarchenko and Maksym Zaliskyi** (Kyiv Aviation Institute), *Science-Based Technologies*, 68(4), 504-510, DOI 10.18372/2310-5461.68.20800, published 2026 | Replace with Odarchenko & Zaliskyi (2026); fix the in-text "Omar et al. (2024)"; never cite a ResearchGate page as the venue. |
| A3 | **P0** | Longcop & Fuentes (2024) are said to find "reliance on manual tracking severely limits emergency response… necessity for modernized equipment and data systems" | The paper (IJRISS 8(11), 255-269) surveys 102 BHERT members on **COVID-19-era needs: PPE, training, transport**. It does **not** discuss manual tracking or data systems; the closest point is "lack of communication facilities" as a logistic problem | Rewrite the sentence to what the paper says (task overload, lack of transport and communication facilities), or drop it. Used again in Section 4.1, fix there too. |
| A4 | P1 | Sasane et al. (2026) "paired a cloud-hosted backend with SMS incident reporting and offline-capable mobile dashboards" | The system has an AWS/MongoDB backend and citizen reporting through an Android app; **SMS incident reporting is a prior work it cites, not its own feature** | Remove "SMS incident reporting" from the description. |
| A5 | P1 | Villafuerte, A. (2024), *Journal of Interdisciplinary Perspectives* 3(1) | Published **1 January 2025**, Vol. 3 No. 1 (2025) | Change year to 2025 everywhere. |
| A6 | P1 | Gasmido et al. (2025) "achieving an excellent overall ISO 25010 evaluation mean of 4.62" | The ejournals.ph record for Gasmido et al. shows an abstract about WebYu (Barangay Yuson), and **4.62 is exactly WebYu's grand mean** (Tosper et al.). The index page appears mixed up | Open the Gasmido PDF itself and confirm its own mean before citing 4.62; if it is WebYu's number, remove it from Gasmido. |
| A7 | P1 | Perante-Calina (2026), "paper presented at the 2026 KAPA International Conference, Busan" | Paper exists (hosted on Japan's MIC site, soumu.go.jp), but the PDF metadata dates it to **August 2025**; the venue/year could not be confirmed | Check the PDF's title page and cite the year and venue printed there. |
| A8 | P1 | eGIF "v2.0" of the DICT | No DICT-issued **eGIF v2.0** could be found; the known framework is the Philippine e-Government Interoperability Framework (DOST-ICTO, 2014), and the E-Governance Act's IRR is recent | Cite the framework that exists; soften "ensures seamless integration" to "is designed to be compatible with". |
| A9 | P2 | NDRRMC SitRep No. 12: "125 cities and municipalities without electricity" | News coverage of NDRRMC updates gives 151 with interruptions, later 124 still without power; 125 was not found | Open the SitRep PDF and quote its exact figure and table. |
| A10 | P2 | PhilAtlas (2024): Pilar population 76,908 | 76,908 is the **2024 PSA census** figure; PhilAtlas shows 2020 (75,793). The barangay figures (Dao 2,485 etc.) are **2020** census | Cite PSA 2024 POPCEN for 76,908 and say "2020 census" for the barangay figures. |
| A11 | P2 | National Privacy Commission (2012) as author of RA 10173 | The NPC was created by the Act; the author is Congress | Cite as Republic Act No. 10173 (2012). |
| A12 | P2 | Grey literature as evidence: MarketsandMarkets (paywalled), New Light Technologies blog, DICT and PSA home pages as URLs | Weak sources and generic URLs | Keep at most one grey source per claim; give deep links (e.g., the PSA NICTHS release page). |

**Verified as correct:** Tosper et al. 2025 (68% faster, 72% fewer errors, grand mean 4.62 — all confirmed), Omar & Van Belle 2023 (Safianu Omar and Jean-Paul Van Belle, 9th ACIST, Harare), Ng 2025 (JICTIE 12(2), DOI correct), PSA 48.8% household internet access 2024, Pilar 1st-class income class and 76,908 (2024), Endsley 1995, ISO/IEC 25010:2023 (2nd edition, Nov 2023, nine characteristics).

**Not checked online:** Budimir et al. 2021, Qureshi et al. 2021, DILG BIMS page, UN 2015.

---

### B. Research design and scope (adviser findings)

**B1 — P0. Chapter 3 says things happened that have not happened.** Sections 3.2.0, 3.2.4, 3.3.2 and 3.4 are in the past tense: baselines "were collected", metrics "were re-measured after the deployment period", the instrument "underwent content validation" and was "pre-tested", increments were "demonstrated to the user acceptance testing team", and "written consent was obtained from all 27 respondents". Chapter 4 itself says all of this is pending. A panel will read this as a claim of completed fieldwork.
*Fix:* write Chapter 3 as the plan (future or present tense, "will be", "is") until each activity is done, then switch each sentence to past tense with its date.

**B2 — P0. The study is still framed as a deployment.** "Deploy/deployment" appears about 40 times (Scope 1.4 "development and deployment", 3.2.0 "post-deployment comparison", 3.3.4 "ready for deployment", 4.3.7 "intended deployment… four deployments"). With no barangay deployment, the before/after comparison in 3.2.0 cannot be done.
*Fix:* reframe as **development and evaluation in a controlled pilot environment** with barangay personnel as evaluators. Replace the pre/post design with a **task-based comparison**: the same standard scenarios done the manual way and with the system, timed in the same session. Change 3.3.4's heading to "acceptance criteria for the evaluation". Keep the deployment model in 4.3.7 as a *recommended* model, clearly labelled.

**B3 — P1. ISO 25010 is a quality model, not a questionnaire.** The instrument is the team's own adaptation, so it needs its own validity and reliability evidence.
*Fix:* report **content validity** (e.g., item-level CVI from 3+ experts) and **internal consistency** (Cronbach's alpha from a pilot of 10+ people). Add standard deviation beside every weighted mean.

**B4 — P1. The overall mean mixes groups of very different size.** Five characteristics rest on 3 IT experts, four on 27 respondents, and the acceptance criterion is "overall mean ≥ 4.21" averaged across all nine. Three ratings cannot support an "Excellent" verdict.
*Fix:* report two summaries (users and IT experts) separately, give n beside each mean, and state the 4.21 criterion per group. Consider 5+ IT evaluators.

**B5 — P1. Usability is claimed but not measured with a usability instrument.** Objective 4 says "usability"; the comparable studies (WebYu) used TAM. The ISO items alone are weak evidence of usability.
*Fix:* add the **System Usability Scale (SUS)** after the UAT tasks (10 items, a known benchmark of 68), plus task completion rate, time on task and error count from the UAT sessions. Cite Brooke (1996) and Bangor et al. (2008).

**B6 — P1. The SMS criterion asks for three phone models, but only two are listed.** 3.3.4 requires 19 of 20 runs "across three distinct Android device models"; Tables 3-2 and 4-12 list two (Infinix X6840, Galaxy A21s). The −100 dBm signal threshold has no stated measuring method.
*Fix:* get a third phone or change the criterion; say how signal strength is read (Android's Settings > About > SIM status, or an app); name the confidence-interval method (Clopper-Pearson exact).

**B7 — P1. Internal contradiction about cloud services.** 1.4 says "One cloud service is used: … OpenRouteService"; 3.4 and 4.3.1 list ORS, OpenStreetMap tiles, Firebase and the Cloudflare tunnel. NFR-04 says the core runs "without a cloud service".
*Fix:* one sentence used everywhere: "Core data and functions stay on the workstation; four external services are used: routing (ORS), map tiles (OSM), push (FCM) and remote access (Cloudflare)."

**B8 — P1. Respondent group wording disagrees.** 3.3.2 says one form is for "the Punong Barangay and Kagawad", but no Kagawad is in Table 3-7 or 4-19.
*Fix:* either add Kagawad as respondents or remove the word.

**B9 — P1. Ethics.** There is no mention of an ethics review (institutional research ethics committee or the adviser's clearance), interview consent, recording consent, or how respondent data are stored.
*Fix:* add the approving body and date, the consent forms (Appendix), and respondent-data handling.

**B10 — P2. Sample justification.** 12 tanods over four barangays is 3 per barangay; say how they were chosen (e.g., one per shift) and why that is enough for a descriptive study.

---

### C. Literature and theory

**C1 — P1. The review is thin for a technical study.** About 13 scholarly sources, mostly local low-tier journals, and two grey sources carry key arguments. No peer-reviewed work on: offline-first synchronization and conflict handling, mobile field data collection (e.g., ODK), SMS in emergency systems (FrontlineSMS, Ushahidi), computer-aided dispatch and responder tracking (AVL), or GIS heatmaps (kernel density) for incident analysis.
*Fix:* add 8-12 peer-reviewed international sources across these topics; keep the 2020-2026 window but allow classic sources where they define a concept.

**C2 — P1. Overclaiming in syntheses.** "The studies validate that combining an offline-first mobile architecture with an SMS best-effort fallback protocol is a well-supported strategy" — the cited sources do not test that combination.
*Fix:* "The reviewed studies support each element separately; their combination for barangay responders has not been reported in the sources reviewed."

**C3 — P2. Uncited claims.** "a vast majority of Philippine barangays continue to rely on manual, handwritten logbooks" (1.1); "resilience engineering principles… robustness and recoverability" (1.4.1). *Fix:* cite a source (e.g., Hollnagel et al. for resilience engineering) or soften.

**C4 — P2. Theory is used only for design, not for evaluation.** Endsley's model explains the design; nothing explains acceptance. *Fix:* add TAM or UTAUT as the lens for the user evaluation (ties to B5), or say plainly that the ISO model is the evaluation framework.

**C5 — P2. Terms.** "Category 4+ typhoon" is a US scale; PAGASA uses "super typhoon". Rolly's landfall winds should cite PAGASA.

---

### D. Accuracy against the current system (code as of 2026-10-28)

| # | Sev | Manuscript says | Code now | Fix |
|---|---|---|---|---|
| D1 | P1 | Table 4-13: web 734, mobile 259, total 2,788 | web tests 736/0; mobile schema 266/0 plus mobile unit tests 193/0; backend new suite `verify-messaging-hardening` 61/0 | Re-run every suite on the final build and replace the counts, with the run date. |
| D2 | P1 | Wiring check: 936 passing, 30 findings, deferred defect in Table 4-18 | 938 passed, **0 failed** | Mark the deferred defect resolved; update Table 4-18. |
| D3 | P1 | Defects table lists 9 defects (to 17 Oct) | The 28 Oct audits found and fixed many more (SOS reachability, inbound SMS not stored, false "Delivered" status, SQLite transaction serialization, cleartext HTTP, backup flag, password toggle) | Add them to Table 4-18 by severity, with "found by code audit" as the method. |
| D4 | P1 | SOS and messaging behaviour as of 17 Oct | New since: SOS button on every tab (hold to confirm), GPS wait capped at 2 s, Silent SOS option, SOS escalation every 2 min with Secretary and Punong Barangay from round 3, inbound citizen SMS stored, STOP opt-out, "Sent" not "Delivered" | Update 4.3.4, 4.3.5 (new business rules) and Appendix A notes. |
| D5 | P2 | RA 7160 Sec. 394(d) for the Secretary's custody | `REFERENCE.md` cites 394(c) | Check the official text once; the custody duty is in the list of duties (believed to be 394(d)(1)). Make the project docs match the manuscript. |
| D6 | P2 | Appendix A shows two phone screens from a browser | Real device screenshots are still missing | Capture on a phone during the device test day. |

---

### E. Structure and presentation

- **E1 — P1. No abstract.** Add a 250-300-word abstract (problem, method, system, evaluation, key results).
- **E2 — P1. No Chapter 5 / conclusions and recommendations.** Check the BUCS IT 124 guide; if required, add Summary of Findings, Conclusions (one per objective) and Recommendations (put the deployment items there: UPS, workstation per barangay, MFA, Cloudflare Access, DPO, retention decisions).
- **E3 — P1. Remove working notes before submission:** the revision note at the very top, the "Status of this chapter" paragraph in Chapter 4, and the "to be confirmed against transcripts" note under Figure 4-1.
- **E4 — P2.** "Excellent = no observed deficiency" is too strong a descriptor for a mean of 4.21; use the scale's usual wording ("very high level of agreement").
- **E5 — P2.** Objective 1 says "near-real-time" — good; keep it consistent (Chapter 2 Level 1 says "real-time data ingestion").
- **E6 — P2.** References: APA 7 needs sentence-case titles, DOIs as https links, and no "Grey literature" tags inside entries.

---

### F. What is already strong (keep it)

- Honest limits: best-effort SMS, single workstation, no prediction, "near-real-time by polling".
- Clear DILG BIMS positioning (complements, never replaces) and a clean capability comparison table with a careful "not identified" note.
- Measured, reproducible performance table with method, sample size and caveats.
- Traceability from problems to requirements to modules (Tables 4-1 to 4-3).
- Business rules and role matrix that match the code.

---

### Priority order

1. **A1-A3** (wrong authors and misreported findings) — one afternoon.
2. **B1-B2** (tense and deployment framing; replace the pre/post design) — 1-2 days.
3. **G1-G2** (instrument vs manuscript sample and task counts; self-contradicting UAT tasks) and **B3-B6, B9** (instrument validity, group-wise reporting, SUS, third phone, ethics) — before any data collection.
4. **D1-D4** (update Chapter 4 to the current build) — after the final test run.
5. **C1-C2, E1-E3** (literature depth, overclaims, abstract, Chapter 5, remove notes).
6. Remaining P2 items.

---

### G. Chapter 4 instruments (`docs/chapter4-instruments/`)

Reviewed: the bundle `09-consolidated-uat.html` (removed) (per-role ISO forms BG-EV-02-A to D, per-role UAT forms BG-UAT-02-A to D, and the facilitator guide and tally sheets BG-EV-02-F), the newer one-sheet versions `09-consolidated-uat.html` (BG-UAT-02), `10`/`11` (BG-EV-02 questionnaire) and `12a-d` (answer sheets), plus the facilitator guide `07`, and the headings of `01` (interview guide) and `02` (needs questionnaire). Every UAT label was searched for in the current web and mobile code.

**What is good:** bilingual forms, N/A option, objective tags on each item, evidence-backed technical statements for IT evaluators, the SUS included with a correct scoring key, time-on-task and error counts in the UAT, defect and retest logs, a facilitator script that keeps the facilitator's hands off the device, and the honest rule "implemented, not yet device-verified" until the SMS test passes.

#### G1. Contradictions between the instruments and the manuscript (P0)

| # | Instrument says | Manuscript says | Fix |
|---|---|---|---|
| G1a | **Sample plan (06, BG-EV-02-F): 57 evaluators** — 40 tanods (10 per barangay), 4 Chief Tanods, 4 Secretaries, 4 Punong Barangays, 5 IT/faculty | **27 respondents** — 12 tanods, 4+4+4 officials, 3 IT experts (Tables 3-7, 4-19) | Choose one plan with your adviser. The 57-person plan (5 IT experts, separate end-user and official groups) answers my findings B4 and B10 better. Then make Tables 3-7, 4-4 and 4-19 match. |
| G1b | **94 UAT tasks**: Tanod 30, Chief Tanod 32 (web + console), Secretary 22, Punong Barangay 10 | **92 cases**: Chief Tanod web 23 + console 7 = 30 (Table 4-17) | Recount from the final form and update Table 4-17 and Table 4-4. |
| G1c | Safety is rated by **users** (RE-6, RE-7 on the phone) **and** IT (SA-1 to SA-6); RE-6 and RE-7 sit in section "C. Reliability and Safety" | Safety rated by the **3 IT experts only** (Table 4-22) | State in Section 3.3.2 exactly which items feed which characteristic and who rates them; use the same mapping in Table 4-22. |
| G1d | Group C form is "Punong Barangay **and Kagawad**" (03c, 06) | No Kagawad respondents | Drop Kagawad, or add them to the sample. |
| G1e | Two usability measures: SUS (S1-S10) and Q1-Q3 | No usability scale named | Describe SUS in 3.3.2 and report it in 4.4 (see B5). |
| G1f | Tally sheet says "Table 4-18 (template). Summary of ISO evaluation results" | That summary is **Table 4-22**; Table 4-18 is the defect table | Renumber the template. |

> **Status 2026-10-28:** G2 and G3 are **fixed** in `09-consolidated-uat.html`, `09-consolidated-uat.html` (removed) and `09-consolidated-uat.html` (removed) (and one note in `07-facilitator-session-guide.html`). Task IDs and task counts are unchanged: S-N2 was turned into a real Secretary boundary check (no Users tab in Personnel) rather than deleted. The Filipino lines added for T-04 and T-05 are working translations, like the rest of the form. G1, G4, G5 and G6 are still open.

#### G2. The UAT form contradicts itself (P0 — testers will fail correct behaviour)

| Task | What it expects | Conflicts with | Fix |
|---|---|---|---|
| **S-N1** (core) | Secretary **cannot** open Dispatch Center or Live Map | **S-16, S-17** (optional) have the Secretary dispatch from the Dispatch Center; the code shows Dispatch Center to Secretaries (`web/src/components/AppShell.js:335`); Rule 89 | Remove Dispatch Center from S-N1 (keep Dashboard, SMS Monitor, Audit Log, Service Health). |
| **S-N2** (core) | Secretary **cannot** resolve an incident | **S-17, S-20** say the Secretary resolves as back-up dispatcher; BR-15 in the manuscript | Delete S-N2 or turn it into a positive task. |
| **S-08** | "a reopened incident **cannot** receive a new dispatch" | **A-18** says a reopened incident is queued and can be dispatched (true since 2026-10-08) | Delete that clause from S-08. |
| **A-11** | An incident whose dispatches were all cancelled "cannot be resolved" | Since migration 0039 an Admin may resolve a pending or reopened incident **with a reason** ("Resolve without dispatch") | Reword: "cannot be resolved as dispatched; it can be resolved only with a reason". |
| **T-04** | Going off duty while offline shows "Cannot change duty status while offline" | Since 2026-10-12 a tanod **may go off duty offline** (Rule 77 in `WORKFLOWS_AND_RULES.md`); the message no longer exists in the code | Rewrite T-04: going on duty offline is refused, going off duty offline is queued. |

#### G3. UAT labels that no longer match the app (P1 — check on the final build)

These exact strings were **not found** anywhere in the current web or mobile code. Testers are told to tap or see them, so they will mark Fail or ask for help (which also spoils the error counts).

- SOS (T-05, T-06): "Confirm & Broadcast SOS", "EMERGENCY SOS DISTRESS", "Transmit Emergency SOS?", "Cancel / Stand Down". The current sheet asks **"Send SOS to HQ and nearby tanods?"**, and since 2026-10-28 there is a **hold-to-open SOS button on every tab**, plus a **Silent SOS** option (default on). Rewrite T-05/T-06 and add a task for the hold button.
- Offers (T-14, T-15): "Call available" not found; "Another tanod already responded." replaced on 2026-10-28 by a message that the call may have been taken, timed out or cancelled.
- Dispatch steps (T-10, T-12): "Start Navigation & Go En Route" is now "Go En Route"; "Mark as Completed" is now "Mark Completed".
- Others not found: "Needs a connection to upload" (T-28), "Record Referral" (T-27), "Preview & print Annex B" (S-09; the code uses "Preview and print Annex …" in labels), "Cannot go off duty while a dispatch is still active." (T-03; the server's wording differs).
- Case differences only (low risk, but match them): "Submit month", "Save entry", "Request swap", "My duty shifts", "Submit availability".

*Method:* exact-string and case-insensitive search of `mobile/src` and `web/src`. A label built at run time could still exist, so confirm each on the final build during the pilot session.

#### G4. Questionnaire design (P1)

- **Scale mismatch.** Part 3 statements are agreement statements ("It has the tools I need"), but the answer scale is a quality scale (Excellent … Poor). Parts 4 and 5 use an agreement scale. Use one agreement scale for statements, or reword the statements as quality judgements. The labels also differ from the manuscript (form: "Very good / Okay"; Table 3-8: "Very Satisfactory / Satisfactory").
- **Items under the wrong characteristic.** PE-3 ("still works when the signal is weak"), PE-4 (writing reports with no signal) and PE-5 are reliability (fault tolerance, recoverability), not performance. Performance efficiency has no item on resource use (battery, mobile data), which matters for tanods.
- **Double-barrelled items** (two ideas in one statement, so one answer cannot mean both): PE-1, PE-2, FS-6, FS-8, IC-5, IC-6, SE-1, SE-12. Part 6 itself says "each statement has one idea". Split them.
- **Items some groups cannot judge.** FS-2 "When I send out a tanod" goes to Group C (Punong Barangay), who cannot dispatch; RE-2 and RE-4 (app closing, report sent twice) are not tagged phone-only but describe the phone. Tag them or mark N/A by rule.
- **All statements are positive** (risk of agreeing by habit). SUS balances this; keep it.
- **N/A in the formula.** The tally sheet correctly excludes N/A from N; the manuscript's formula in 3.3.2 divides by "the total number of respondents". Align them.
- **SE-11** asks for "the retention setting", but retention periods are fixed in code by design (Rule 10). Ask to see the retention rule and the test output.

#### G5. Procedure and ethics (P1)

- **Unfilled placeholders** in the consent text: "Retention period: [to be stated by the proponents]" and "Questions: [name, role and contact …]". Fill them before printing.
- **Withdrawal is promised but not workable** as written: answers carry only a code, so a respondent cannot withdraw unless they keep their code. Give each respondent a slip with their code.
- **Validation blocks are empty** (adviser, content expert, language reviewer, pilot). Collect these signatures and compute a content validity index; the manuscript currently says validation already happened (finding B1).
- **Filipino translation is marked unvalidated**, and no Bikol version exists. Pilar tanods may answer best in Bikol; at least have the Filipino reviewed and decide on Bikol before the sessions.
- **SUS is asked twice** if the same person does the UAT form (Part D) and the questionnaire (Part 4). Keep it in one form only, or the respondent tires and you risk double counting.
- **Self-marked Pass/Fail.** The tester marks Pass or Fail; the facilitator only remarks. That is acceptable, but say so in Chapter 3 and report disagreements noted in Remarks.
- **Interview guide mixes needs and evaluation.** Guides A-D each end with "After seeing a demo". Questions asked after a demo of the proposed system are evaluation, not needs assessment. Report them separately from the baseline themes in Table 4-7.

#### G6. Version clutter (P2) - DONE

The folder holds three generations of the same forms: `03`-`03d` (BG-EV-01), `05` and `06` (BG-EV-02 per role, 19 Oct) and `09`-`12` (BG-EV-02 / BG-UAT-02 one sheet, 22 Oct). `05`, `06` and `11` all carry the code BG-EV-02. Keep only the final set for printing (move the rest to an `archive/` folder) and add a version date in each form footer, so the wrong one is never printed.

#### Instruments to-do, in order

1. ~~Fix G2 and G3~~ done in the UAT form; re-check G3 labels on the final build.
2. Decide the sample (G1a) and recount UAT tasks (G1b); update the manuscript tables.
3. Fix the scale and item problems (G4).
4. Fill the consent placeholders, run the 2-person pilot, collect validation signatures (G5).
5. ~~Archive old versions (G6)~~ done.

---

### Sources consulted

- IJSAT record for the messaging paper: https://www.ijsat.org/research-paper.php?id=10412
- Odarchenko & Zaliskyi, *Science-Based Technologies*: https://jrnl.kai.edu.ua/index.php/SBT/article/view/20800
- Longcop & Fuentes, IJRISS: https://rsisinternational.org/journals/ijriss/articles/profile-problems-and-needs-of-barangay-health-emergency-response-team-in-gamay-northern-samar/
- Sasane et al., Zenodo: https://zenodo.org/records/19692535
- Villafuerte, JIP: https://www.jippublication.com/index.php/jip/article/view/783
- WebYu (Tosper et al.): https://ejournals.ph/article.php?id=30194
- Gasmido et al. record: https://ejournals.ph/article.php?id=30193
- Omar & Van Belle, ACIST 2023: https://digitalcommons.kennesaw.edu/acist/2023/presentations/7
- Ng 2025, JICTIE: https://ejournal.upsi.edu.my/index.php/JICTIE/article/view/11463
- Perante-Calina PDF: https://www.soumu.go.jp/main_content/001045224.pdf
- PSA 2024 NICTHS coverage: https://ptvnews.ph/psa-dict-record-spike-in-internet-connected-households-increased-online-access-among-filipino-populace/ and https://www.sunstar.com.ph/cebu/filipino-households-spend-less-on-internet-in-2024-access-usage-expand
- Pilar, Sorsogon: https://en.wikipedia.org/wiki/Pilar,_Sorsogon and https://www.philatlas.com/luzon/r05/sorsogon/pilar.html
- ISO/IEC 25010:2023: https://committee.iso.org/standard/78176.html
- Rolly coverage of NDRRMC figures: https://newsinfo.inquirer.net/1355434/rolly-leaves-at-least-16-dead-3-missing-in-bicol-region
- Interoperability framework background: https://www.dlsu.edu.ph/wp-content/uploads/pdf/conferences/research-congress-proceedings/2024/SEP-06.pdf
