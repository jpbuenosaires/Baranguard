# Chapter 4 test dataset (simulated)

**Everything in `baranguard_ch4` is simulated.** It exists for screenshots and for the ISO/IEC 25010 test runs. It is not field data, and no figure taken from it may be reported as a measured result of real tanod use. In Chapter 4, call it "simulated test data".

## What it is

- One barangay only: Dao (barangay_id 1).
- A separate database, `baranguard_ch4`. It never touches `baranguard` or `baranguard_uiseed`; the seed script refuses to run on any other name.
- 11 accounts, all with password `Demo@2026`: `admin.dao` (Chief Tanod), `secretary.dao`, `punong.dao`, and eight tanods (`tanod.reyes`, `tanod.delacruz`, `tanod.gubaton`, `tanod.dichoso`, `tanod.espinosa`, `tanod.banares`, `tanod.candelaria`, and `tanod.olayvar`, who is suspended on purpose).
- About 30 days of history covering every current screen: incidents (English, Tagalog, Bikol narratives; every status), dispatches with simulated routes, night dispatch offers, SOS alerts (app and SMS fallback), GPS tracks (live positions for tanods on shift right now), shifts and rosters (including a paper-recorded week and a re-approval case), availability, swap requests, accomplishment reports, referrals, Safer School Zones (3 schools, check-ins, a prepared term report), SMS log, citizen reports, audit log, health checks.
- Not seeded: evidence photos and voice files (no files exist for them), and the mobile app's own offline queue (that lives on the phone).

## Reset before each test session

Double-click `Reset Chapter 4 Data.bat` at the repo root. It asks you to type `RESET`, then drops and rebuilds `baranguard_ch4`, applies every migration, loads the seed, and switches `backend\.env` to `baranguard_ch4` (a copy of the old `.env` is kept as `.env.bak-before-ch4`).

To put the app back on the old demo database: `powershell -ExecutionPolicy Bypass -File backend\scripts\reset-ch4.ps1 -PointAppTo uiseed`.

Needs MySQL running (use `Start Baranguard.bat` first). It tries the XAMPP root account with no password, then asks for the password.

## Ground truth for the tests

Each run writes `backend/storage/ch4-seed-manifest.json` with the exact counts it generated: incidents by status, type and source; the median created-to-arrival time; how many SOS came by app vs SMS fallback and their delays; how many incidents were captured offline and by how many minutes they were late; GPS rows and their delivery delay; referrals by office. Compare the system's own reports against it. Examples:

- The Reports screen's average response time should agree with the manifest (same rule: incident created to first arrival; the screen only counts the date range it shows).
- `backend/scripts/metrics-report.php` should reproduce the GPS and SOS figures.

Dates are relative to the moment of the reset, so the "pending" queue, the active SOS, the open dispatch offer and the live tanod positions always look current. Re-run the reset for a fresh "now".

## Limits to state in the chapter

- The delays and response times are drawn from ranges chosen by the script, so they show the system computing them correctly, not how fast real responders are.
- Names, contact numbers, school names and reference numbers are made up (`SIM-` prefixes where a reference is needed).
- The sync-latency and offline-durability figures for objective 2 still need real phone runs (docs/ISO25010_EVALUATION_PLAN.md).

## Final testing / UAT database

**Only two databases exist now: the real `baranguard` and `baranguard_uiseed`, which holds the Chapter 4 / UAT test data** (`baranguard_ch4` and `baranguard_uat` were dropped 2026-10-14; the Chapter 4 profile above still works if you ever need a separate database). For the UAT sign-off and the ISO evaluation sessions use `Reset UAT Data.bat`, which rebuilds `baranguard_uiseed` (reset before each tester). Same simulated Dao data plus fixtures arranged for every UAT scenario; see `docs/UAT_DATA_REQUIREMENTS.md`.
