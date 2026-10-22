# Baranguard Maintenance and Turnover

DRAFT for the barangay. This is the handover from the development team to the barangay, written for non-programmers where possible. Items in [[double square brackets]] are blanks for the team to fill in before signing. Nothing in this document is a password.

## 1. What is delivered

- The Baranguard web dashboard (Admin / Chief Tanod, Secretary, Punong Barangay), running on the barangay workstation.
- The Tanod Android app (an APK installed on each tanod's phone), which also serves as the Chief Tanod phone console.
- The backend system and database on the workstation, with a public address through a Cloudflare tunnel.
- The SMS gateway app for the dedicated gateway phone.
- Scripts for backup, restore drill, retention, start-up and scheduled tasks (`backend/scripts/`).
- Documents: `OPERATIONS_MANUAL.md`, `DEPLOYMENT_CHECKLIST.md`, `POWER_CUT_PROCEDURE.md`, `BREACH_RESPONSE_RUNBOOK.md`, `SETUP.md`, the privacy documents in `docs/`, and the user manuals [[list the manuals produced]].
- Source code in the repository [[repository location / who holds the copy]].

Baranguard complements the DILG BIMSS. It does not replace it and does not keep the blotter or the Katarungang Pambarangay case records.

## 2. Accounts and access

Accounts, passwords, the database root password, the backup passphrase, the Cloudflare login and the Firebase and routing keys are **handed over in person** to the named holders. They are never written in any document or sent in chat.

| Item | Holder (name and office) | Handed over on |
|---|---|---|
| Admin (Chief Tanod) account(s) | [[ ]] | [[ ]] |
| Secretary account | [[ ]] | [[ ]] |
| Punong Barangay account | [[ ]] | [[ ]] |
| MySQL root / DBA access | [[ ]] | [[ ]] |
| Backup encryption passphrase (two holders) | [[ ]] and [[ ]] | [[ ]] |
| Cloudflare account and domain | [[ ]] | [[ ]] |
| Windows login for the workstation | [[ ]] | [[ ]] |
| Firebase (push) and routing (ORS) keys | [[ ]] | [[ ]] |
| Gateway phone and its SIM | [[ ]] | [[ ]] |

After handover, change every password the development team knew, and remove or disable any developer or demo account.

## 3. Who does what after turnover

| Responsibility | Person / office | Contact |
|---|---|---|
| System owner (decisions, approvals) | [[ ]] | [[ ]] |
| Day-to-day administrator (accounts, daily checks) | [[ ]] | [[ ]] |
| Backups and the off-site copy | [[ ]] | [[ ]] |
| Data Protection Officer (designated by the barangay council) | [[ ]] | [[ ]] |
| Technical support (bugs, updates) and how long it is covered | [[ ]] | [[ ]] |
| Gateway phone load and SIM | [[ ]] | [[ ]] |
| Report a problem to | [[email / number / form]] | [[ ]] |
| Expected response time | [[ ]] | |

How to report a bug: write the date and time, which screen, who was logged in (role only), what you expected and what happened, and attach a screenshot with no personal data. Send it to the contact above. For a security problem or a lost phone, follow `BREACH_RESPONSE_RUNBOOK.md` first.

## 4. Routine maintenance (summary; details in `OPERATIONS_MANUAL.md`)

- Daily: check Service Health and that today's backup exists.
- Weekly: confirm the restore drill passed; copy the latest backup off the workstation.
- Monthly: review users and devices; suspend or deactivate anyone who left.
- Update Windows, XAMPP and the phones only as described in sections 6 and 7.

## 5. Known limitations

- One workstation per barangay. If it is off, only SOS-by-SMS keeps working. UPS and backup internet are the barangay's decision.
- The public web address has no second login gate (no Cloudflare Access) and the app has no multi-factor login. Use strong passwords.
- The newest features (migrations after 0028 and the tanod workflow) were checked on test databases and automated tests. Not every screen was verified in a browser or on a phone by the developers. Items still needing device checks are listed in `docs/HANDOFF.md`.
- Reports are printed and signed on paper; the system does not track signatures.
- Retention periods for the newest records are provisional pending a council decision, and some have no automatic deletion yet.
- The legal text for Safer School Zones (MC 2026-037) and Annex A was not available; the annex layouts follow the barangay's own forms.
- The mobile app is Android only, installed from an APK. A signed release or store build is not set up [[decision]].
- SMS depends on a gateway phone with a working SIM and load.
- With no connection, a phone shows cached data and sends its saved records later.

## 6. Update procedure

Do updates on a date agreed with the Chief Tanod, never during an emergency.

1. Take a backup and confirm a restore drill passes (`OPERATIONS_MANUAL.md` sections 3 and 4).
2. Get the new version of the code (git pull, or a copy from the developer) and read what changed.
3. If it includes new migrations, apply them as DBA in numeric order (never edit an old migration). See `DEPLOYMENT_CHECKLIST.md` section 2.
4. Restart Apache. Check Service Health and the API check.
5. If the mobile app changed, rebuild the APK with an explicit `VITE_API_BASE_URL` and reinstall on each phone (`DEPLOYMENT_CHECKLIST.md` section 6). Web-only changes need no rebuild.
6. Record the change in `backend/DEVLOG.md`.
7. If anything goes wrong: stop, restore from the backup, and contact support.

## 7. The PHP and curl DLL trap

XAMPP's Apache PHP was upgraded to PHP 8.3 because the old 8.0 cannot run the backend. That upgrade silently broke PHP's curl extension under Apache, while command-line PHP still worked and looked fine. Routing and push notifications depend on curl. The fix lives outside the repository: `C:\xampp\apache\conf\extra\httpd-xampp.conf` holds four `LoadFile` lines for `libcrypto-3-x64.dll`, `libssl-3-x64.dll`, `libssh2.dll` and `nghttp2.dll` from `C:/xampp/php/`, placed before `LoadModule php_module`. After any XAMPP or PHP upgrade or reinstall, check these lines first and re-add them if missing. The real error shows only in `C:\xampp\php\logs\php_error_log` ("Unable to load dynamic library 'curl'"), not in Apache's log. Keep the old PHP folder when upgrading so you can go back. Do not upgrade PHP, XAMPP, Android Studio or Node packages during a live period without a backup and a test.

## 8. Sign-off

Delivered by: [[ ]]  Received by (Punong Barangay): [[ ]]  Chief Tanod: [[ ]]  Date: [[ ]]
