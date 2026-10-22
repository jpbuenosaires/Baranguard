# Baranguard Operations Manual (System Administrator)

DRAFT. For whoever runs the barangay workstation day to day. It collects what was scattered across `HANDOFF.md`, `SETUP.md` and `POWER_CUT_PROCEDURE.md`. Every script named here exists in the repo; if a step fails, read the header comment of that script first.

No passwords, keys or passphrases are written here. They are kept in `backend/.env` (not in git) and handed over in person.

Commands are PowerShell or Git Bash from the repo root (`C:\xampp\htdocs\baranguard` is the same folder as the repo). Use Git Bash for `.sh` files.

---

## 1. Start and stop

| Action | How |
|---|---|
| Start everything | Double-click `Start Baranguard.bat` (repo root). It starts Apache (web on :80, API on :8081), MySQL and the Cloudflare tunnel, whichever is not already running, then opens the dashboard. Safe to click twice. |
| Start at Windows sign-in | `powershell -ExecutionPolicy Bypass -File backend\scripts\install-startup-shortcut.ps1` (remove with `-Remove`). No admin needed. |
| Start at boot, nobody logged in | Elevated PowerShell: `powershell -ExecutionPolicy Bypass -File backend\scripts\install-autostart-services.ps1`. Installs Apache2.4, MySQL and `cloudflared` as Windows services. After this, stop/start them from Services.msc or `net stop <name>`, not by closing XAMPP. |
| Stop | XAMPP Control Panel (Apache, MySQL), or the services above. Stopping the tunnel takes the dashboard and the mobile app off the internet. |

Rules for the machine:

- The workstation must never sleep (Power options: sleep and display-off = Never). A sleeping PC misses every alert. See `SETUP.md` 1.7.
- Check `backend/.env` `DB_NAME` before trusting what the public address shows. At the time of writing it pointed at the demo database (`baranguard_uiseed`), not the real one.
- Power cut or workstation down: follow `POWER_CUT_PROCEDURE.md`.

## 2. Daily and weekly checks

1. Open the dashboard, then Service Health (System Tools menu, Admin). Look for anything not OK. `not_configured` is neutral: it means that integration was never set up.
2. Confirm the last backup file is from today: `backend\backups\` (files `<DB_NAME>_<UTC time>.sql.enc` and `.sha256`).
3. Confirm the last restore drill is recent: Service Health shows the restore test time ("Never" means none was recorded).
4. Look at the logs in `backend\backups\scheduled-logs\` if anything above is stale.
5. API reachable: `curl http://127.0.0.1:8081/api/v1/barangays` returns the four barangays with no login.
6. Gateway phone: charged, connected, see section 7.

## 3. Backups

- Script: `backend/scripts/backup.sh`. Needs `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` and `BACKUP_ENCRYPTION_PASSPHRASE` in the process environment (it does not read `.env` itself). It writes an AES-256 encrypted dump plus a `.sha256` file to `backend/backups/` and prunes files older than `BACKUP_RETENTION_DAYS` (default 30). While ANY record is under legal hold it prunes nothing.
- The scheduled wrapper reads those values from `backend/.env` for you: `backend/scripts/scheduled-backup-and-retention.ps1`. **That wrapper also runs the retention job for real (irreversible deletion).** For a backup only, use `backup.sh` directly.
- Keep a second copy outside the hall (USB drive or another office). A backup on the same computer is lost with it. The passphrase must be stored separately from the backup, by the Punong Barangay and the Chief Tanod. Without it a backup cannot be opened.
- Never delete backups during an open breach or legal hold (`BREACH_RESPONSE_RUNBOOK.md`).

## 4. Restore and restore drill

Drill (safe, never touches the live database). It takes a fresh backup, restores it into `<db>_drill`, compares per-table fingerprints, drops the drill database and records the time:

```bash
BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh
# or against an existing file:
BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh --backup-file=path/to/dump.sql.enc
```

It is scheduled weekly (section 6). Read the PASS/FAIL lines; any FAIL means the backups cannot be trusted. Fix before relying on them.

Real recovery (disaster), supervised, with DBA credentials:

1. Stop Apache so nobody writes. Keep the damaged database if possible (rename it, do not drop it).
2. With `DB_*` and the passphrase exported: `bash backend/scripts/restore.sh <backup>.sql.enc <target_db_name>`. With no second argument it restores into `<DB_NAME>_restore_test`, not the live name. Passing the real name is a deliberate decision.
3. Check the data, point `backend/.env` `DB_NAME` at it if you restored under a different name, restart Apache, run the section 9 checks.
4. Tanod phones re-send saved records on their own; wait a few minutes before checking.

## 5. Retention job (always dry-run first)

Retention deletes database rows past their legal period. **It is irreversible.** The retention periods are constants in the code; changing one needs an architecture review, not an edit here.

```bash
cd backend
php scripts/retention-job.php --list       # show rules and periods
php scripts/retention-job.php --dry-run    # count only, deletes nothing
php scripts/retention-job.php              # apply (only after reading the dry-run)
php scripts/retention-job.php --only=raw_narrative,sms_log
```

Read the dry-run output before the first real run on any database that holds real data. Records under legal hold are skipped. Retention for the 2026-10 tables is a provisional 365 days pending a council decision (REFERENCE.md); do not treat those numbers as final.

## 6. Scheduled tasks

Register all of them once, from an ordinary (non-elevated) PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File backend\scripts\install-scheduled-backup-jobs.ps1
```

| Task | When | Runs |
|---|---|---|
| `BaranguardBackupRetention` | daily 02:00 | `scheduled-backup-and-retention.ps1` (backup, then real retention purge) |
| `BaranguardRestoreDrill` | weekly Sunday 03:00 | `scheduled-restore-drill.ps1` |
| `BaranguardDispatchOfferSweeper` | every minute | `scheduled-dispatch-offer-sweep.ps1` (night dispatch offers; without it offers never time out or escalate) |
| `BaranguardPbDigest` | weekly Monday 06:00 | `scheduled-pb-digest.ps1` |

The tasks run only while the user is logged on. Check them in Task Scheduler or with `Get-ScheduledTask -TaskName Baranguard*`. Logs: `backend\backups\scheduled-logs\`. The sweeper logs only when it has output. If an old `BaranguardAiWorker` task exists, remove it: `Unregister-ScheduledTask -TaskName BaranguardAiWorker -Confirm:$false`.

## 7. Cloudflare tunnel and the gateway phone

**Tunnel.** The tunnel named `baranguard` serves `https://baranguardph.win` (web) and `https://api.baranguardph.win` (API) from this workstation. Its config is `~/.cloudflared/config.yml`. `start-baranguard.ps1` starts it as an ordinary process unless the `cloudflared` Windows service was installed (section 1). To see which machine actually serves traffic: `cloudflared tunnel list` (the one with active connections). A second tunnel (`baranguard-main`) on another machine's profile is orphaned; do not delete it without asking the owner. Setting up a new tunnel: `bash backend/scripts/setup-cloudflare-tunnel.sh yourdomain.win` after a one-time `cloudflared tunnel login` by the account owner. There is no Cloudflare Access policy; the API is reachable by anyone with the URL, protected by the app login only. If one is added, scope it to the web host only, never the API (REFERENCE.md section 1).

**Gateway phone (SMS in and out).** A dedicated Android phone with a SIM, tethered by USB. Setup is in `sms-gateway/README.md`. In `backend/.env` set `GSM_GATEWAY_ENABLED=true` (with `GSM_GATEWAY_ADB_PATH` / `GSM_GATEWAY_DEVICE_SERIAL` if needed). The app must be launched once after install. Inbound messages are polled by:

```bash
cd backend
php scripts/gsm-ingest-daemon.php --status    # state and reachability
php scripts/gsm-ingest-daemon.php --once      # one poll
php scripts/gsm-ingest-daemon.php --daemon    # keep polling (Ctrl-C to stop)
```

Keep the phone charged, with load on the SIM and signal. If it is down, SMS attempts are recorded as failed (not silently dropped). SOS from a tanod phone has its own SMS fallback that does not depend on the workstation.

## 8. Accounts: suspend, deactivate, offboard a tanod

Done by an Admin in the web dashboard (Personnel, Users tab; Devices page). Sessions are checked on every request, so a suspended or deactivated user is cut off on their next request.

When a tanod leaves or loses trust:

1. Suspend the account (Users, *Suspend*, with a reason). Immediate effect.
2. Deactivate the user (`is_active` toggle) once the suspension is no longer needed as a temporary state.
3. Deactivate their phone (Devices, *Deactivate*). Stops the device session and push tokens. Do this at once for a lost or stolen phone and follow `BREACH_RESPONSE_RUNBOOK.md`.
4. Remove them from upcoming shifts in the Scheduler (a suspended or inactive tanod cannot be dispatched anyway).
5. Do not delete the account or its records. Incidents, dispatches and reports tied to them stay and follow the normal retention periods.
6. Ask the person to uninstall the app. Offline data on the phone is encrypted and the session is already dead.

Password change: the user changes it in the app or web (*Change password*). An Admin sets titles and approval authorities in the Users tab; an Admin cannot change their own `approve_*` authorities, another Admin must.

## 9. Health checks after any change

- Service Health page shows no unexpected problem.
- `curl http://127.0.0.1:8081/api/v1/barangays` returns four barangays.
- Log in as each role you changed; the dashboard loads and the data matches the expected barangay.
- `php backend/scripts/count-routes.php` prints the live route count (the number in REFERENCE.md moves over time).
- The `backend/scripts/verify-*.sh` scripts use a disposable database and a throwaway app user. Never point them at the real database. Run them on a development machine, not as a daily check.

## 10. Migrations as DBA

The app database user (`baranguard_app`) cannot ALTER, CREATE or DROP. Migrations are run as MySQL `root`/DBA, in numeric order, after a backup. Never edit a migration that has been applied; add a new numbered file. Full go-live procedure: `DEPLOYMENT_CHECKLIST.md`.

Tool: `backend/scripts/apply-migrations-0029-0039.ps1 -Database <db>` backs up, asks you to type YES, then applies 0029 to 0039. It covers 0029-0039 only. `-DryRun` lists the files. For 0040 onward see the checklist.

## 11. Known operational risks

- Single workstation: if it is off, everything but SOS-by-SMS is down. UPS and a second copy of the backups are open items for the barangay (`POWER_CUT_PROCEDURE.md`).
- If XAMPP's PHP is ever swapped again, the four `LoadFile` lines for the curl DLLs in `C:\xampp\apache\conf\extra\httpd-xampp.conf` must be re-added (see `MAINTENANCE_AND_TURNOVER.md`).
- `Start Baranguard.bat` does not survive a reboot unless someone signs in or the services/shortcut above are installed.
