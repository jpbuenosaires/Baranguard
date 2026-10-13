# UAT / final-evaluation database: what each scenario needs

Database `baranguard_uiseed` (Barangay Dao only, **simulated data**; the project keeps only the real `baranguard` and this one). Built by the `uat` profile of
`backend/scripts/seed-ch4.php`; reset with **`Reset UAT Data.bat`** at the repo root
(`backend\scripts\reset-ch4.ps1 -Profile uat -PointAppTo uat`). Ground truth for each build:
`backend/storage/uat-seed-manifest.json` (key `uat_fixtures`). It never touches the real `baranguard`.

Source of the scenarios: `docs/chapter4-instruments/04-uat-signoff.html` (BG-UAT-01, 92 scenarios).
The ISO/IEC 25010 sheets (03a-d) rate the system after a short facilitator-guided task set on the
same setup and need no data of their own.

## How to run a session

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

## Accounts and the state each one starts in

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

## Fixtures (counts from the verified build, see the manifest for the exact incident numbers)

* 12 pending incidents with no dispatch and no offer (each dispatch, broadcast, reopen or "take over" scenario consumes one).
* 1 live `en_route` and 1 live `arrived` dispatched incident; 3 dispatched incidents whose dispatches are
  all `completed` (the Admin's "resolve" candidates, A-11).
* 130 resolved incidents (duplicate targets), 2 reopened, 4 duplicate, 3 invalid, 3 cancelled; 13 linked to a school.
* 2 active SOS (one for the web tester, one for the phone console), 1 acknowledged, 11 resolved (4 by SMS fallback).
* 4 pending swap requests (not reyes) on published future shifts; 19 draft future shifts awaiting publish.
* Accomplishment reports: 6 prepared (one with a flagged duration), 1 returned, 3 open.
* 6 unconverted legacy citizen reports; 3 schools; 1 prepared Annex D term report; 38 referrals; 4 related links.
* System settings: SOS backup contact `09170000099` and gateway `09170000001` (fictitious), so T-08 has a number to text.
* No dispatch offer is pre-opened (a pre-opened one would block the facilitator's "Broadcast to on-duty tanods").

## What is behind each screen (so no list is empty)

The UAT profile adds history on top of the 30-day Chapter 4 dataset (`uat_richness` in the manifest):

* **`tanod.reyes` (the phone tester):** 15 incidents he filed (3 school-zone reports at the school gate/road, 4 with a photo), 20 completed dispatches with routes, 5 referrals, 27 past and 3 future published shifts plus 4 drafts, availability (6 accepted, 1 submitted), a swap history (1 approved, 1 denied), accomplishment reports for August (prepared), September (open, with one entry flagged "differs from the duty record") and October (open), 2 past SOS, school check-ins, 6 notifications (1 unread: the roster).
* **All roles:** notifications (priority alerts and SOS for the Chief Tanod and the Secretary, dispatches and rosters for the tanods, night offers, a returned report), 4 evidence photos, 3 offline map packages (newest published, the files under `backend/storage/map-packages`), 6 SMS subscribers (1 opted out).
* **Evidence photos are flat striped placeholder images** named `SIMULATED-evidence-photo-N.png`, not photographs; real photos come from T-13 and T-28. No voice evidence is seeded (the upload path only accepts real AAC recordings).
* The Punong Barangay gets no notifications: the system sends none to that role.

## Scenario by scenario

Legend. **Data**: provided by the seed. **Facilitator**: needs a facilitator action during the session.
**Device**: needs a real phone/hardware. **Stale**: the form describes something the app no longer does (section below).

### Part B, Tanod (phone, `tanod.reyes`)

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

### Part C, Chief Tanod / Admin (web, `admin.dao`)

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

### Part D, Chief Tanod phone console (`admin.dao`)

| ID | Needs | How it is met |
|---|---|---|
| C-01 | Admin login with an `X-Device-Id` | none (device session). |
| C-02 | An **active** SOS | Data: 2 active (one is also used by A-01/A-02 on the web). |
| C-03, C-04 | An incident with a dispatch | Data: espinosa/banares incidents. |
| C-05 | A pending incident to take over | Data. |
| C-06, C-N1 | Incidents | Data. |

### Part E, Secretary (`secretary.dao`)

| ID | Needs | How it is met |
|---|---|---|
| S-01, S-N1, S-02, S-03 | none | Data (raw narratives exist, in en/tl/bik). |
| S-04 | An incident with an open dispatch, and another of the same barangay | Data: the two live incidents. |
| S-05 | none | none (but see Stale for the exact message). |
| S-06 | An incident with its dispatch closed, plus a target | Data: 130 resolved / completed ones. |
| S-07 | An incident with an open dispatch | Data. |
| S-08 | An incident without an open dispatch, then reopen | Data: pending ones; invalid ones exist. |
| S-09 | Unconverted legacy citizen reports | Data: 6. |
| S-10 | none | none. |
| S-11 | School-linked incidents with C-1 text | Data: 13. |
| S-12 | none; dates must not clash | Data: the seeded term is -45/+45 days; the API has no overlap rule. |
| S-13 | A draft/prepared Annex D report | Data: 1 prepared. |
| S-14 | A report with a flagged duration | Data: one prepared report (delacruz, September). |
| S-15 | A prepared report, account with `note_report` | Data: 6 prepared; the secretary holds `note_report`. |
| S-16, S-17, S-18, S-19 | (see Stale) | |
| S-20, S-N2 | A pending/dispatched incident | Data. |

### Part F, Punong Barangay (`punong.dao`)

| ID | Needs | How it is met |
|---|---|---|
| P-01, P-02 | Figures that match the seed | Data: compare with `uat-seed-manifest.json` (incidents 159, resolved 130 at the verified build; the screen's average response time is 23.2 min over 120 incidents). |
| P-03, P-04, P-08, P-N1, P-N2 | Incidents, heatmap data, referrals | Data. |
| P-05 | Draft shifts awaiting publish; `approve_roster` | Data: 19 drafts; the PB holds `approve_roster`. |
| P-06, P-07 | (see Stale) | |

## Scenarios that cannot be performed as written (fix the form, not the data)

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

## What no database can provide

* The phone, its GPS, camera, SIM and airplane-mode toggling (T-04 to T-08, T-13, T-16 to T-18, T-28).
* FCM push and the full-screen alert (T-14, A-09): needs the real `google-services.json` on the phone.
* The local GSM gateway for any SMS monitor or fallback check; `GSM_GATEWAY_ENABLED` is not set in `backend/.env`.
* Real response-time and sync-latency figures. Everything in this database is generated; report the
  figures as "simulated test data" (see `docs/CHAPTER4_SEED.md`, "Limits to state in the chapter").
* A tester who is the intended user; a developer may not act as tester (form, ground rule 5).

## Verification done when this was written (2026-10-13)

Build ran clean on a fresh `baranguard_uiseed` (42 migrations, seed loaded). Checked against the database: each
tanod's duty state, active dispatch count and published-shift cover (as in the account table); 12 pending
incidents with no dispatch or offer; 2 active dispatches, none created before its incident; 2 active SOS;
4 pending swaps on published future shifts; 3 open accomplishment reports and reyes' latest entry before
the last 3 days; 6 unconverted citizen reports; the SOS settings; no pre-opened offer. Over HTTP (Apache :8081)
Admin, Secretary and Punong Barangay logins succeed and the main lists answer 200; dispatching `tanod.dichoso`
is refused with 422 `NO_PUBLISHED_SHIFT` and dispatching `tanod.espinosa` is refused as unavailable. Not run:
any scenario in a browser or on a phone.
