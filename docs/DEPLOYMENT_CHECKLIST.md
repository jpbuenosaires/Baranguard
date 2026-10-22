# Baranguard Deployment (Go-Live) Checklist

DRAFT. Tick each box only after checking it yourself, on the real workstation. Script details are in `OPERATIONS_MANUAL.md`. No credentials belong in this document; keep them in `backend/.env` and hand them over in person.

Date: ____________  Performed by: ____________  Witness: ____________

## 0. Before you start

- [ ] Decide and write down which database is the real one: `baranguard` (production) or `baranguard_uiseed` (demo). Current `backend/.env` `DB_NAME`: ____________
- [ ] A user with DBA/root access to MySQL is available (the app user has no ALTER/CREATE/DROP).
- [ ] The Punong Barangay and Chief Tanod agree the date, and tanods are told the app is changing.
- [ ] `git status` is clean on the workstation and you know which commit is being deployed: ____________

## 1. Back up (nothing proceeds without this)

- [ ] `BACKUP_ENCRYPTION_PASSPHRASE` is set in `backend/.env` and stored separately by two people.
- [ ] Take a backup of the database that will be changed (`bash backend/scripts/backup.sh` with `DB_*` and the passphrase exported). File: ____________
- [ ] Copy it to a second place off this computer.
- [ ] Run `bash backend/scripts/restore-drill.sh` and confirm all PASS. A backup that has never been restored is not a backup.

## 2. Apply migrations 0029 to 0045, in order, as DBA/root

0029 and 0042 drop tables for good (blotter and AI tables; fatigue flags). 0041 drops paper-signature data. Never re-run a migration that already applied. The repo docs say 0001-0026 are applied to both real databases and 0029-0045 are not; check what is actually applied first, because those claims can be stale.

- [ ] Rehearse on a scratch copy first (restore a backup into a throwaway database and apply there).
- [ ] 0029 to 0039: `powershell -ExecutionPolicy Bypass -File backend\scripts\apply-migrations-0029-0039.ps1 -Database <db>` (add `-DryRun` first to list the files; it takes its own backup, asks for the root password and for YES).
- [ ] 0040 to 0045 are NOT covered by that script. Apply each by hand, in order, as root, stopping at the first error: `C:\xampp\mysql\bin\mysql.exe -u root -p <db> < backend\migrations\<file>` for `0040_report_and_roster_notifications.sql`, `0041_drop_paper_signature_tracking.sql`, `0042_drop_fatigue_flag.sql`, `0043_display_id_unique_per_barangay.sql`, `0044_report_channel_phone_facebook.sql`, `0045_referral_lupon_kp.sql`.
- [ ] Do not use the `*.down.sql` files unless you are deliberately rolling back, from a backup.
- [ ] Record the migrations applied and the time: ____________
- [ ] Open Incidents, Personnel > Scheduler, Accomplishment Reports and Safer School Zones and confirm none shows an error (a missing table gives a 500).

## 3. Point the backend at the real database (deliberate)

- [ ] Edit `backend/.env`: set `DB_NAME` (and `DB_USER`/`DB_PASSWORD`) to the production database. Note the date and reason in `backend/DEVLOG.md`.
- [ ] Remember the public tunnel serves whatever `DB_NAME` names. After the switch, the public address shows production data to logged-in users only.
- [ ] `CORS_ALLOWED_ORIGIN` in `backend/.env` lists the real web origin(s) (for example `https://baranguardph.win`), not `*`.
- [ ] `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, `DEVICE_SECRET_MASTER_KEY` are real generated values (`bash backend/scripts/setup-env.sh` generates them on a fresh machine). Do not reuse demo values.
- [ ] Optional integrations set, or left honestly `not_configured`: `ORS_API_KEY` (routing), `FCM_SERVICE_ACCOUNT_PATH` (push), `GSM_GATEWAY_ENABLED=true` (SMS).
- [ ] Create the first real Admin for each barangay if none exists: `cd backend && node scripts/bootstrap-admin.js` (interactive). Create other accounts in the dashboard. Hand passwords over in person.
- [ ] No demo accounts or demo data in the production database (list the users and check).
- [ ] Restart Apache. `curl http://127.0.0.1:8081/api/v1/barangays` returns four barangays.

## 4. Scheduled tasks and services

- [ ] Ordinary PowerShell: `powershell -ExecutionPolicy Bypass -File backend\scripts\install-scheduled-backup-jobs.ps1`
- [ ] `Get-ScheduledTask -TaskName Baranguard*` shows `BaranguardBackupRetention`, `BaranguardRestoreDrill`, `BaranguardDispatchOfferSweeper` and `BaranguardPbDigest`, all Ready. The sweeper is the one most often missed.
- [ ] From `backend/`, run `php scripts/retention-job.php --dry-run`, read the numbers, and only then let the daily task purge for real.
- [ ] Elevated PowerShell: `powershell -ExecutionPolicy Bypass -File backend\scripts\install-autostart-services.ps1` (Apache, MySQL, cloudflared as services). At minimum, run `install-startup-shortcut.ps1`.
- [ ] If an old `BaranguardAiWorker` task exists, unregister it.
- [ ] The four curl-DLL `LoadFile` lines are present in `C:\xampp\apache\conf\extra\httpd-xampp.conf` (PHP curl is needed for routing and push).
- [ ] Windows power options: never sleep.
- [ ] Reboot once and confirm the system comes back on its own (or document that someone must sign in first).

## 5. Tunnel and gateway phone

- [ ] `cloudflared tunnel list` shows active connections for `baranguard` on THIS machine. The orphaned `baranguard-main` tunnel on the other machine is left alone.
- [ ] `https://api.baranguardph.win/api/v1/barangays` and the web address answer from outside the hall network.
- [ ] Gateway phone set up per `sms-gateway/README.md`, `php backend/scripts/gsm-ingest-daemon.php --status` shows it reachable, one real test SMS sent and received.
- [ ] `sos_fallback.backup_contact_number` and `sos_fallback.gateway_number` are set in Settings.

## 6. Build and install the mobile app

`mobile/.env.local` silently bakes `http://localhost:8081` into any bare build. Always set the URL explicitly.

```bash
cd mobile && VITE_API_BASE_URL=https://api.baranguardph.win/api/v1 npx vite build && npx cap sync android
cd android
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
export TMPDIR=C:/gtmp TEMP=C:/gtmp TMP=C:/gtmp
export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=C:/gtmp"
./gradlew --stop && ./gradlew assembleDebug
```

- [ ] Grep the built bundle `mobile/dist/assets/index-*.js` for `api.baranguardph.win`, and confirm `localhost:8081` is absent.
- [ ] Install on each tanod phone: `adb install -r app/build/outputs/apk/debug/app-debug.apk` (adb is not on PATH: `C:\Users\JAYSON~1\AppData\Local\Android\Sdk\platform-tools\adb.exe`), or hand the APK over by a trusted route.
- [ ] Launch the app once on each phone and grant location (including all-the-time), notification and SMS permissions.
- [ ] OPEN: the repo documents only the debug build (`assembleDebug`). A signed release build is not documented or verified. Decide whether one is needed.

## 7. Verify go-live

- [ ] Log in once as each role (Admin, Secretary, Punong Barangay, Tanod) and confirm each sees only its own barangay.
- [ ] Create a test incident, dispatch it to a tanod phone, confirm the push or SMS arrives, resolve it, and mark or remove it as test.
- [ ] Offline: put one phone in airplane mode, log an incident, reconnect, confirm it syncs once (no duplicate).
- [ ] SOS from one phone reaches the dashboard; the SMS fallback is tested with mobile data off.
- [ ] Service Health shows no unexpected problem; run `restore-drill.sh` once more on the new database and confirm PASS.
- [ ] Take a fresh backup of the live, migrated database and store a copy off-site.
- [ ] Record what was done in `backend/DEVLOG.md` and rewrite the current-state section of `docs/HANDOFF.md`.

## 8. Sign-off

Punong Barangay: ____________  Chief Tanod: ____________  Developer: ____________  Date: ____________

## Open decisions (fill before go-live)

- Release signing and distribution of the APK (only the debug build is documented).
- Which database backs the public tunnel (production or demo), and the date it switches.
- Who holds the backup passphrase (two named people).
- Retention periods for the 2026-10 tables (provisional 365 days) need the council decision.
- UPS and off-site backup location (`POWER_CUT_PROCEDURE.md`).
