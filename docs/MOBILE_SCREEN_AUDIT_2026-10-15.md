# Mobile screen audit and gesture test (2026-10-15)

Method: dual-agent critique (A: design review of device screenshots, B: detector and code evidence), plus my own on-device gesture tests. Device: Infinix X6840 (720x1576), bundled build of `main` at `1aa611c`, signed in as the seeded Tanod test account. Screenshots are in the session scratchpad (`scratchpad/aud/`). Not covered: Chief Tanod (admin) tabs (needs an admin sign-in), tablet widths.

Impeccable's critique command was used rather than `design-taste-frontend`, because `CLAUDE.md` reserves the latter for public marketing pages.

## 1. Gesture test results (tested on the phone)

| Gesture | Where | Result |
|---|---|---|
| Edge swipe back | Dispatch detail, My Shifts, Availability, Accomplishments, School check-in | Works, returns to the previous page |
| Pull down to refresh | Dispatches, My Shifts, Availability, Accomplishments, School check-in, My Reports, Profile | Triggers server requests (4 to 10 each). Only 5 screens have a real refresher (admin x3, Dispatches, My Reports), so on the others the pull is not a designed feature |
| Swipe drawer up and down | Live Map | Works |
| Swipe down on sheet | Map filter sheet | **Does not dismiss** (no drag-to-dismiss, close only via X or Apply) |
| Swipe down on sheet | SOS confirm sheet | **Does not dismiss**, although it shows a drag handle |
| Hardware Back with sheet open | SOS confirm sheet | Closes the sheet, stays on page (correct) |
| Hardware Back with sheet open | Map filter sheet | **Leaves the Map page** instead of closing the sheet (it is a plain div, not an Ionic modal) |
| Swipe left and right | Dispatch filter tabs, report template chips | Chips scroll sideways; tabs all fit so nothing to scroll |
| Swipe left and right on a card | Dispatch card | Nothing happens (no swipe actions exist) |
| Pan the map | Navigation view | Works |

## 2. Bugs found (functional)

1. **P0: Home says "All clear" while a high-priority dispatch is en route.** Dispatch #133 (en route, created minutes earlier on the server) showed on Dispatches but Home kept "All clear, no active dispatches" and Profile kept "0 Assigned", for 17+ minutes. Cause: Home loads dispatches once on mount (`pages/home.tsx` `useEffect([])`); Ionic keeps tab pages mounted, so it never refreshes on re-entry. Same load-once pattern on my-shifts, availability, accomplishments, profile, school-checkin, my-reports and the admin tabs. Present before the overhaul. Fix: reload in `useIonViewWillEnter`, and on sync events.
2. **P1: times are 8 hours wrong.** The API returns UTC like `2026-10-15 04:47:01` with no `Z`; the client does `new Date(string)`, which reads it as local time. Dispatch #133 created 5 minutes earlier showed "8h 5m ago". Safe helpers (`formatServerTime`, `parseServerTime`) exist but raw parses remain in `DispatchHistory.tsx:39`, `my-reports.tsx:106,112,123`, `SwapRequestCard.tsx:43`, `school-checkin.tsx:145`, `my-shifts.tsx:137`, `shiftTiming.ts:12`, and the dispatch age maths in `DispatchCard`, `BriefingView`, `assignment-detail`. Also explains "In 06:28 AM, Out 06:28 AM" on the check-in list. Fix: normalise once in `apiService`.
3. **P1: map filter sheet ignores hardware Back and swipe-down** (see table). Make it an Ionic modal or have it claim the `baranguard:hardware-back` event.
4. **P1: garbled text `Â·` and `â€¦` in the navigation view** (`components/dispatch/NavigationView.tsx:150,155,191`; `assignment-detail.tsx` comments and notes, 13 hits). Present before the overhaul.
5. **P2: idle polling.** `dispatch-offers` is requested about every 4 seconds while idle (about 10 requests per 20 s overall). Heavy on battery and data.
6. **P2: map overlay.** With the drawer raised, the "Updated hh:mm" and basemap chips sit on top of the filter rail.
7. **P2: My Shifts "Upcoming Schedule" includes past shifts** (Sep 13 and 14 listed as upcoming on Oct 15).
8. **P3: bounce easing** (`app.css:285,773`), a 4px top-border accent (`app.css:426`).

## 3. Design review (Assessment A + B combined)

Design health: **25/40, Acceptable.** The app is honest and plain-spoken, but visually stock: white bordered cards, blue primary, grey chips, an all-caps eyebrow on almost every screen. Dark mode is a recolour, not a night-duty mode.

Strengths: the navigation view (one dominant action); offline honesty in the copy ("Saved on this phone, will send when online", "Offline map v3-real-osm"); the Report form's big tiles and "required" marker.

Priority issues:
- **P0 SOS sheet:** Confirm (white pill, red text) and Cancel (translucent pill) have the same height and no colour distinction; headline "TRANSMIT EMERGENCY SOS?" is bureaucratic; no visible sent/queued result. Fix: solid saturated Confirm vs quiet Cancel, plain headline ("Send SOS to HQ and nearby tanods?"), optional hold-to-send, visible result state.
- **P1 readability outdoors:** 21 uppercase+tracked eyebrows (even form labels); 9 rules below 12px (`app.css:3514` is 9.6px); disabled "Submit month" is nearly illegible; light-blue-on-light-blue info box on Availability.
- **P1 hierarchy and card-in-card:** Profile is five identical bordered rows plus nested grey boxes; Home is card > pills > button > card.
- **P2 Home:** big dead gap; quick calls (Backup, Police 911, MDRRMO 160) are small and above the fold gap; in dark mode SOS is salmon with dark text and can look disabled.
- **P2 map controls:** icon-only filter toggles, crowded chips, bottom sheet half empty.
- **P3 chrome:** permanent "LIVE" pill and theme toggle take header space on every page; it carries no information.

Per-screen suggestions:
- **Home:** SOS and Report as the top fixed block; one-line status card; calls as full-height buttons under it; drop "Reports saved today: 0" unless items are waiting. Landscape fixed on `main`.
- **Dispatches:** show type as the title and status as a chip in history; last-synced time; dim "Recent history"; use the same code treatment as My Reports.
- **Map:** labelled filters (All, Tanods, Incidents); merge the three chips into one status line; fit the sheet height; fix overlap when the drawer is raised.
- **Navigation view:** fix mojibake; show the place name instead of raw coordinates; larger next-turn text and ETA; give Briefing more weight.
- **Profile:** rename "Console & Profile / Responder Diagnostics / Station Sync & Storage" to plain tanod words; flat grouped list; distinct icons (two rows share the document icon, two share the calendar).
- **Report form:** drop the duplicate selected-type label; sticky Submit; show an affordance that the template chips scroll; remove the textarea resize handle.
- **My Shifts:** "Next shift" first and large; hide or dim past shifts; stop repeating Request Swap on 30 cards.
- **Availability:** cut the five-line info box; dim ended periods; make rows tappable; say "Submitted" not "Sent".
- **Accomplishments:** put "Add first entry" inside the empty state; "0 hours logged"; raise disabled-button contrast.
- **School check-in:** make "Refresh school list" a text link; show the school name as the primary line; fix times.
- **My Reports:** remove "Details stay on the server" from every card; give the INC code its own line; "Not sent" chip red when above zero.
- **Dark mode:** more layer separation, less saturated primary, red reserved for the alarm action.

Personas: Casey (one-handed): the header toggle and pill are unreachable top-right, template chips hide behind a scroll. Sam (accessibility): small grey caps, faint disabled buttons, icon-only map filters, mojibake read aloud. Jordan (first-timer): "Responder diagnostics", "Console", "Station Sync" and "Briefing" are not tanod words.

Caveat on the design review: two of its screenshots were mislabelled by my capture (it reviewed Home from other shots), and it read the Vandalism/"Theft / property loss reported" form state as a bug; that was my own accidental taps, not an app defect.

## 4. Suggested order

1. Fix the safety bugs: Home refresh on re-entry (1), UTC timestamps (2), mojibake (4).
2. SOS sheet redesign (P0 design) and the map-sheet back/swipe behaviour (3).
3. Readability pass: eyebrows to sentence case, 12px floor, disabled-button contrast.
4. Profile and Home restructure (flat list, one-line status card, quick calls).
5. Polling interval for offers, past shifts in My Shifts, map chip overlap.

## 5. Status after the fix round (same day)

Done in code (tsc, lint, 182 vitest tests, contrast 184/184, touch 0 violations, schema 259/0, build ok):
- Home and Profile refresh on tab re-entry and every 30 s while visible; an active call now replaces "All clear" (seen working on the phone: Home showed ACTIVE CALL #133). Active call moved above the emergency lines.
- Zone-less UTC timestamps are normalised once at the API layer (`utils/serverTime.ts`), fixing the 8-hour error everywhere.
- Garbled characters removed from the navigation view and assignment detail.
- Map filter sheet: hardware Back closes it, swipe down on its header dismisses it.
- SOS sheet: solid Confirm vs quiet Cancel, plain wording, visible sent/saved result, swipe-down on the handle (single tap kept, no hold-to-send, per your answer).
- Home: solid red SOS in both themes, emergency lines as full-width rows, report count hidden at zero. Report form: sticky Submit, chip fade, no resize handle, distinct icons.
- Readability: sentence-case labels (uppercase kept for status chips), 0.75rem floor, no bounce easing, readable disabled buttons, neutral info banners.
- Header: the LIVE pill is gone; the status pill shows when offline or when items are waiting to send ("N waiting").
- Profile: one grouped list, plain tanod wording, distinct icons. Dispatches: lighter history rows, "Updated hh:mm". Navigation view: bigger turn text and ETA, priority chip, coordinates behind Copy. Map: labelled filters, one status line, drawer fits its summary.
- Data screens: reload on entry, pull-to-refresh added to My Shifts, Availability, Accomplishments, School check-in; ended shifts under "Past shifts"; offers polled every 12 s idle (4 s while one is pending, paused when hidden).

Not yet verified on the phone after these changes: everything except Home (the phone was unplugged during the check). Not done: Chief Tanod tabs, tablet widths, `my-reports` date grouping in Manila time.
