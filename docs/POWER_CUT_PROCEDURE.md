# Power cut and workstation-down procedure

For the barangay's operating steps. It is a draft for the Punong Barangay and the Chief Tanod to confirm. Each barangay runs its own workstation (Rule 92), so each barangay keeps its own copy.

## Before it happens

1. The workstation and the internet router are plugged into a **UPS**. Size it to keep both running for at least 30 minutes, long enough to shut the workstation down properly.
2. The nightly encrypted backup is copied to a second place outside the hall (the Chief Tanod's USB drive or another office). A backup that stays on the same computer is lost with it.
3. A printed list of on-duty tanod phone numbers and the backup contact number is kept at the desk.
4. The gateway phone is kept charged and connected. The SOS by SMS path does not need the internet.

## While the workstation or the internet is down

| Who | What |
|---|---|
| Chief Tanod | Call or text the nearest on-duty tanod directly. Write the incident in the paper logbook with the time, the place and the tanod sent. |
| Chief Tanod (phone) | If the phone has data, log the incident in the console. It is saved on the phone first and sent when the workstation is back. |
| Tanods | Keep using the app. Records are kept on the phone and sent later. An SOS still reaches the gateway phone by SMS and the backup contact. |
| Secretary | Back-up dispatcher when the Chief Tanod is away: dispatches and resolves from the web dashboard once it is back. |

## When it comes back

1. Start the workstation and open `Start Baranguard.bat`. Check Service Health shows no problem.
2. Tanod phones send their saved records on their own. Wait a few minutes before checking.
3. Enter the incidents written in the paper logbook during the outage, with the real time in the description.
4. Note the outage (start, end, what was done on paper) in the barangay's own record.

## Still open

- UPS size and who buys it: for the barangay council.
- Where the offsite backup copy is kept: for the Chief Tanod and the Punong Barangay.
- A second computer that can take over: optional; the restore procedure in `docs/SETUP.md` is the starting point.
