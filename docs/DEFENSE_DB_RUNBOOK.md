# Defense database runbook

Purpose: how to inspect, reset and present the real and UAT databases at the defense.
Status/Last updated: 2026-10-28.

Written 2026-10-28. Everything here was checked against the live XAMPP MariaDB 10.4.32 on this workstation
(port **3306**, not 3307: `C:\xampp\mysql\bin\my.ini` says 3306, and `backend/.env` agrees; older docs that say 3307 are stale).
Root has an empty password on this XAMPP install, so the commands below use `-uroot` with no `-p`.

## 1. Where each real database stands (measured, read-only)

There is no migration-tracking table, so the level was inferred by comparing `information_schema` to the migrations.

| Database | Level | Lacks | Data |
|---|---|---|---|
| `baranguard_uiseed` | **0045, complete** | nothing | 11 users, 67 incidents, 43 dispatches, 356 shifts, 40 SMS, 139 audit rows |
| `baranguard` (real) | 0026 plus the early migrations, **but 0003 is also missing** (`shift_schedule.user_id` still NOT NULL) | **0003, 0027-0045** | 3 users, 0 incidents/dispatches/shifts/SMS, 7 audit rows, 4 barangays |

Note `scripts/apply-migrations-0029-0039.ps1` is NOT enough for the real DB (it skips 0003, 0027, 0028 and 0040-0045).
Use `backend/scripts/apply-migrations-range.sh` (new, below).

## 2. Recommendation: use `baranguard_uiseed` for the defense

- It is already at 0045, so there is nothing to migrate and nothing destructive to run the week of the defense.
- It has realistic demo data (67 incidents, rosters, referrals, SMS), so every screen has something to show. The real DB is empty.
- `backend/.env` already points at it (`DB_NAME=baranguard_uiseed`) and the public tunnel already serves it.
- Seed password is documented in `docs/HANDOFF.md` (`admin.dao`, `secretary.dao`, `punong.dao`, `tanod.reyes`, ...).
- Applying 0029 and 0042 to the real DB drops tables for good; do that after the defense, not before it.

Watch-outs with the seed data (measured): the seeded published shifts end **2026-10-29 22:00**. Dispatch needs a published
shift covering "now" (422 `NO_PUBLISHED_SHIFT` otherwise, unless the Admin supplies an override reason). If the defense is
after that, publish a fresh roster first (Personnel > Scheduler) or use the override reason in the demo.
Latest seeded incident is 2026-10-22.

## 3. Rehearsal results (2026-10-28, scratch copies only)

Real DBs were only read (mysqldump, SELECT). Scratch DBs `baranguard_rehearsal_real` and `baranguard_rehearsal_seed` were created, then dropped, along with the throwaway MySQL user.

1. Dumped `baranguard` into `baranguard_rehearsal_real`; applied **0027 through 0045** in numeric order with `apply-migrations-range.sh`: all 19 applied with no error.
2. Comparing columns showed a single difference from `baranguard_uiseed`: `shift_schedule.user_id` NOT NULL, i.e. **0003 was missing**. Applied 0003. After that, columns, indexes (name, order, uniqueness) and foreign keys (delete rules) were **identical to `baranguard_uiseed`**; 34 tables.
3. Row counts before and after: `user` 3 -> 3, `audit_log` 7 -> 7, `barangay` 4 -> 4, `incident`/`dispatch`/`shift_schedule`/`sms_log` 0 -> 0. No data loss. (The real DB holds almost nothing, so this proves little about data-preserving behaviour on large tables. The 2026-10-08 rehearsal on both DBs with data is in DEVLOG.)
4. Smoke test (`backend/scripts/smoke-rehearsal.sh`, throwaway app user + `php -S`): public `GET /barangays` 200, login OK, and 14 authenticated GETs (incidents, dispatch, shifts, nav-counts, summary, users, schools, availability, referrals, accomplishment-reports, dispatch-offers, system/health, notifications, audit-log) all **200**, on both the migrated copy of `baranguard` and the copy of `baranguard_uiseed`. Not tested: writes, mobile device sessions, SMS gateway, FCM, concurrency.
5. Scratch DBs and scratch user dropped; `SHOW DATABASES` afterwards lists only the original two plus system schemas.

## 4. Commands (only needed if you ever migrate the real `baranguard`)

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

### Rollback (restore path)

Restoring replaces the database with the dump, so it discards anything written since the backup.

```bash
$M -uroot -h127.0.0.1 -P3306 -e "drop database baranguard; create database baranguard character set utf8mb4"
$M -uroot -h127.0.0.1 -P3306 baranguard < backend/backups/pre-defense-baranguard-<STAMP>.sql
```

For the encrypted backups made by `backend/scripts/backup.sh`, use `backend/scripts/restore.sh <file.sql.enc> [target_db]`
(needs `DB_PASSWORD` and `BACKUP_ENCRYPTION_PASSPHRASE`; restores into `<DB_NAME>_restore_test` unless you name a target).
The same dump/restore pair works for `baranguard_uiseed`; existing safety dumps are in `backend/backups/`
(for example `pre-uat-rebuild-baranguard_uiseed-20261013T221349Z.sql`). Take a fresh one before the defense.

## 5. `backend/.env` values to check (do not paste secrets anywhere)

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

## 6. Scheduled tasks

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

## 7. Pre-defense checklist

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

## 8. Helper scripts added

- `backend/scripts/apply-migrations-range.sh <db> <from> <to>`: applies numbered migrations in order, stops at the first error. No backup inside it.
- `backend/scripts/smoke-rehearsal.sh <scratch_db> <user> <password>`: read-only API smoke test; refuses `baranguard` and `baranguard_uiseed`; creates and removes its own throwaway DB user and server.
