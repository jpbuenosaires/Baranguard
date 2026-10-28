# Mobile UI/UX audit (2026-10-28)

Scope: `mobile/src/pages/*` (incl. `admin/`), `mobile/src/components/*`, `mobile/src/theme/*`, `App.tsx`, `index.html`, `capacitor.config.ts`. Read-only; no source edited.
Paths below are relative to `mobile/src/` unless they start with `docs/`.

## Method and limits

Everything here was read in code (JSX, CSS, tokens). I computed WCAG contrast ratios from the token hex values with a script.

NOT verified (no device, no emulator, nothing rendered):
- Actual rendering at 360 px and any visual overflow.
- Keyboard overlap and `adjustResize` behaviour.
- TalkBack output and the real touch-target size of Ionic-rendered parts.
- Dark mode, beyond reading the token mapping.
- Pages only skimmed for state handling: `availability`, `accomplishments`, `my-shifts`, `my-reports`, `school-checkin`, `incident-submitted`, `admin-dispatch`, `admin-incidents`.

`.impeccable.md` does not exist. `docs/UI_CONSISTENCY_AUDIT.md` covers the web dashboard only and says so itself (`docs/UI_CONSISTENCY_AUDIT.md:54`, "Not verified: ... the Tanod mobile app"). **No consistency audit of the mobile app exists.**

What is already good, so it is not "fixed" by mistake:
- Tokenised type and spacing: 97 uses of `--text-xs`, 82 of `--text-sm`.
- 48 px touch tokens (`theme/variables.css:140-144`) and a real shared kit (`components/ui/*`, `theme/ui.css`).
- Loading, empty and error components exist and are used on most list screens.
- Offline-queue wording is honest ("Saved on this phone, will send when online").
- SOS confirm sheet: 60 px confirm button, a result shown inside the sheet, and the offline / SMS fallback.
- Hardware back handling; focus-visible rings on shared buttons.

---

## P0, blocks safe use

### P0-1. SOS exists only on the Home tab
- The only SOS control is the dock in `pages/home.tsx:543-572`. A grep for SOS triggers (`postSos`, `home-sos-button`, `useSosFlow`) shows no other trigger anywhere in `pages/` or `components/`.
- The Tanod's riskiest moments are on other screens:
  - Dispatch detail and navigation (`pages/assignment-detail.tsx`).
  - Live Map (`pages/live-map.tsx`).
  - New Incident.
- On Dispatch detail and New Incident the tab bar is hidden (`App.tsx:252,279`, `mobile-tab-bar--hidden`). From the dispatch screen the Tanod must press Back (possibly several times), land on Home, then tap SOS and Confirm.
- Fix direction: a persistent SOS affordance in the shell (above the tab bar, or long-press on the centre tab), and on the dispatch and navigation views.

### P0-2. SOS waits up to 10 s for GPS before it sends anything
- `components/home/useSosFlow.ts:73` awaits `getCurrentPosition()` before `postSos` (line 80).
- `services/geolocation.ts:69` uses `enableHighAccuracy: true, timeout: 10000`.
- With a poor fix (indoors, or GPS cold start) the confirmed SOS is delayed by up to 10 s while the sheet shows "Sending…".
- The server already supports no-fix and last-known fallback (REFERENCE.md §5, C-01). The client should send immediately with whatever it has, then update the location.
- Impact: this violates "SOS must be the fastest thing on screen". I could not measure real latency without a device.

### P0-3. SOS plays a loud siren and has no silent mode
- `components/home/useSosFlow.ts:52` plays `onWarning()` (square-wave double beep) when the sheet opens.
- Line 68 plays `onSosFired()` (sawtooth siren, gain 0.25, `utils/tacticalFeedback.ts:90-95`) when the SOS is sent.
- A grep for mute / silent / sound settings across `src` finds none. Every tap also plays a tone (`onTap`, `tacticalFeedback.ts:68-71`).
- A Tanod hiding from an assailant, or on a quiet patrol, announces their position. This needs an owner decision: silent SOS by default, or a Profile setting. I am flagging it as safety-critical, not as a style choice.

---

## P1

### P1-1. Home puts the active call below the identity card, and the dock eats the viewport
- Order in `pages/home.tsx:484-505`:
  1. `DutyStatusCard` (identity, chips, button, today count; about 200 px by CSS arithmetic: `theme/screens.css:8-16` plus children).
  2. Alert bar.
  3. Offer cards.
  4. `DispatchHeadline` ("Respond to Call").
  5. Emergency dials, then banners.
- The dock is fixed (`theme/screens-base.css:5-14`, `.home-sos-dock`). Container bottom padding is 176 px (`theme/screens.css:6`).
- On a 360x640 phone, header (56) + tab bar (70 + inset) + dock (~136 + inset) leave roughly 350 px for scrolling content. By my arithmetic the active-call card starts at about 200 px and ends at about 350 px, so it is borderline or hidden once an alert or offer is present. Unverified on a device.
- Per the file's own comment ("Showing 'All clear' during an active call is the one thing Home must never do", `pages/home.tsx:302`), an active call should sit first.

### P1-2. New Incident silently defaults the type to "Theft"
- `pages/new-incident.tsx:74` (`useState<IncidentType>('theft')`), and `handleDiscardDraft` resets to it (line 190).
- A Tanod who skips the 11-tile grid files a theft. A required, explicit choice, or "Not sure", is safer. The admin form has the same pattern (`pages/admin/admin-log-incident.tsx:32`, defaults `disturbance`), but its choice is a visible select.

### P1-3. Location is optional, never auto-tagged, and the empty state is calm
- Label "Incident Location (Optional)" (`components/home/LocationSection.tsx:42`).
- Empty text: "No location added • will save without map pin" (line 67).
- GPS is only fetched if the Tanod taps "Use Current GPS" (`pages/new-incident.tsx:222-236`). Nothing tries on open.
- A dispatcher needs a location. Auto-request a fix on mount (non-blocking) and make "no location" a visible warning.

### P1-4. SOS-critical and call-critical controls below 44 px
- `IonButton size="small"` is used for "Retry" on failed SOS alerts (`pages/home.tsx:525`) and for SyncQueue retry buttons (`components/SyncQueueModal.tsx:278,294`).
- Ionic's small button is about 30 px high by default. I did not measure it on a device, and there is no CSS override in `theme/*` for it.
- `.nav-header-briefing-btn` (`theme/app.css:3883-3895`) has `padding: 4px 12px` at `--text-xs`, giving roughly 26-28 px, with no hit-area extension. The sibling `.nav-hud__expand-btn` does extend its hit area (`app.css:3905-3910`); this one does not.
- Mixing `IonButton` (32 uses) and the kit `Button` makes sizes inconsistent app-wide.

### P1-5. "Briefing" button in the navigation header is white-on-white in light mode
- `theme/app.css:3883-3895`: `color: var(--color-white)` on `rgba(255,255,255,0.15)` with a white border.
- The header toolbar is `--background: var(--color-surface)`, i.e. white (`app.css:461-467`), and nothing overrides it for navigation mode.
- By CSS the label and border are effectively invisible in light theme. It is also the only in-header way back to the briefing. Dark mode is not affected, since the surface is dark there.
- Not rendered; high confidence from the CSS.

### P1-6. Chief Tanod SOS cards give no way to act on the location or reach the Tanod
- `pages/admin/admin-sos.tsx:140-170` shows only text: "Location: Live GPS fix", "Last known position...".
- `AdminSosAlert` carries `latitude`/`longitude` (`services/apiService.ts:1669-1670`) and `dispatchId`, but they are not rendered.
- There is no "Open on map / Navigate" and no "Call Tanod". The only phone number on the screen is the generic fallback card (lines 211-222).
- For an emergency console this is the missing core action. There is a privacy question, since Rule 8 bars coordinates in audit metadata only. Showing the position to the Admin in-app is consistent with the API already returning it, but it needs a decision.
- The page also polls every 20 s (line 76) with no push-driven refresh. I did not verify the critical-alert overlay path end to end.

### P1-7. Critical-alert overlay offers only "Acknowledge Alert" to a Tanod
- `components/CriticalAlertOverlay.tsx:150-158`: for a peer SOS, a Tanod gets one button that dismisses, with no location, no navigate and no call.
- For the Chief Tanod it navigates to the SOS tab (line 111).
- The acknowledge call's failure is swallowed (lines 69-72, 115-116) and the overlay is dismissed anyway, so a failed ack looks like a success.

### P1-8. Hard-coded identity and number defaults (Rule 6 "no hardcoded identities")
- `pages/home.tsx:60`: barangay name state defaults to `'Dao'` until the session loads. A Binanuahan, Marifosque or Banuyo Tanod briefly sees the wrong barangay.
- `components/home/DutyStatusCard.tsx:40,47`: initials `'TR'` and name `'Field Officer'` as fallbacks.
- `pages/profile.tsx:214`: `'Tanod Officer'`.
- `components/home/EmergencyDials.tsx:17-18`: `911` "Police" and `160` "MDRRMO" are hard-coded. I could not verify that 160 is the correct MDRRMO line for Pilar, Sorsogon. Put these under the barangay config or confirm them with the owner. A wrong emergency number is worse than none.

### P1-9. Offline empty state can read as "all quiet"
- `pages/assignments.tsx:275-293`: when the cache is empty and the refresh failed, the page shows "No active calls... Continue your regular patrol" under a dismissible warning banner (lines 221-242, dismissible at 225).
- Once the banner is dismissed, an offline Tanod with an empty cache sees reassurance, not "we couldn't check". The same applies to Home's "All clear" (`components/home/DispatchHeadline.tsx:17-26`) when the dispatch fetch failed. The error is swallowed at `pages/home.tsx:220-221` ("Offline fallback").

### P1-10. Small-screen risk in the tab bar (360 px)
- Five tabs at 360 px is 72 px each. `.tab-pill-container` is a fixed 60 px (`theme/app.css:761-770`) with 4 px side padding.
- The "Dispatches" label at 0.8rem / weight 600-700 (`app.css:785-792`) is roughly 62-66 px wide by estimate, so it likely overflows the 52 px usable width of the active highlight pill.
- Unverified visually. Check on a 360 px device or emulator.

---

## P2

### Visual hierarchy and tokens
- New Incident section titles are small, tertiary-grey labels (`theme/app.css:4315-4323`, `--text-sm`, `--color-text-tertiary`). The required field "What Happened" looks like a footnote next to the big tile grid. "(required)" is set in `.h4-required` at `--text-sm`.
- Off-scale font sizes, against the file's own rule "nothing essential under 0.8rem" (`variables.css:150`):
  - 0.68rem: `x-forms.css:30`, `x-home.css:21` (accuracy pill).
  - 0.72rem: `x-home.css:7` (char count), `x-dispatch.css:44`, `x-map.css:88,190`, `x-forms.css:32`.
  - 0.74rem: `x-dispatch.css:22`.
  - 0.75rem: `app.css:3290`, `x-home.css:32`, `x-map.css:54`.
  - 0.78rem: `x-map.css:134`.
  - Several of these carry map or accuracy data a Tanod needs in sunlight.
- Two undefined tokens are used with fallbacks: `--color-critical-text` (`ui.css:231,243`) and `--color-border-strong` (`ui.css:50`). Neither is defined in `variables.css`. The error text silently falls back to the same `--color-critical` as everything else; contrast is fine on white (4.83:1).
- Dark mode is implemented twice: tokens (`variables.css:268-448`) and 129 hand-written `[data-theme="dark"]` overrides in `app.css` (plus 5 in `tanod-workflow.css`) that reach for `--dark-*` directly, bypassing the tokens. This is the drift pattern that produced P1-5-type bugs.
- The header comment at `variables.css:12-23` still says "Light, not dark... dark import is removed". That is contradicted by the dark tokens below it, so it is stale and misleading.
- CSS layering: 25 selectors are defined in more than one file, and `app.css` is 5,276 lines with 32 `!important`. Later patch files (`screens.css`, `x-*.css`, `layout.css`) override earlier rules, e.g. `.home-sos-dock` in `screens-base.css`, `layout.css` and `screens.css`, and `.intake-textarea-box` three times. Hard to reason about and likely to regress.
- Two entry points to "Report" on Home: the centre tab FAB (`App.tsx`, `tab="log-incident"`) and the Home dock button (`pages/home.tsx:544-556`). The dock button is primary blue, 56 px, directly above SOS, so it competes with SOS for the same thumb zone.

### Touch and thumb reach
- Targets are mostly 48 px by token, and many have a documented 48 px hit-area trick. `.nav-hud__expand-btn` is 32 px visual plus an `::after` that extends it (`app.css:3905-3910`). Nothing there is a finding.
- The theme toggle sits in every header (`components/MobileHeader.tsx:101-114`, 48 px). It adds a top-right target on every screen, including the dispatch screen where a mis-tap flips the whole theme. Consider moving it to Profile only.
- The top-bar "CACHE" label (`MobileHeader.tsx:129`) is jargon for "offline".

### Forms (New Incident)
- The textarea has `rows={4}`, `resize: none` (`x-home.css:199`) and no `maxLength` (`pages/new-incident.tsx:398-412`). The accomplishment form has one (`components/forms/AccomplishmentEntrySheet.tsx:91`). The char counter shows no limit.
- The template chips append with ". " (`new-incident.tsx:428`) and the strings are English only ("Suspicious persons sighted"). No Filipino or Bikol option. Whether that matches the Tanods' working language is an owner question.
- Input boundaries are `--color-border` (#e2e8f0) on `--color-bg` (#f8fafc), about 1.15:1 (`theme/app.css:4378-4392`, `tanod-workflow.css:132-144`). That is below WCAG 1.4.11's 3:1 for control boundaries, so in direct sunlight the field edges nearly vanish. Focus is only a border-colour change, with no outline defined (`app.css:4393`, `tanod-workflow.css:146-149`).
- The sticky Submit bar is good (`x-home.css:209-217`). The admin Log Incident page has no sticky submit, no draft autosave and no location capture (`pages/admin/admin-log-incident.tsx`). It uses native `<select>`s where the Tanod form uses tile chips, an inconsistent pattern.
- The home duty toast for a queued off-duty is a long sentence on a 3 s toast (`pages/home.tsx:436,575-581`). It is too brief to read while on patrol.

### Copy (plain English / Filipino-friendly)
- The same thing is called "workstation", "HQ", "Barangay Desk", "the desk" and "Barangay HQ". "Workstation" alone appears in at least 15 user-facing strings:
  - `pages/home.tsx:344,389`
  - `pages/assignment-detail.tsx:239,253,302`
  - `pages/assignments.tsx:85`
  - `pages/login.tsx:188` ("Workstation Network Connected")
  - `pages/accomplishments.tsx:297,357`
  - `pages/school-checkin.tsx:140`
  - `components/DispatchOfferCards.tsx:111`
  - `components/SyncQueueModal.tsx:142,159`
  - `pages/profile.tsx:156`
- "Tactical" language: "Tactical Guidance" (`assignment-detail.tsx:382`), "Open tactical map" (`components/dispatch/DispatchDock.tsx:23`), "Field Assignment Detail" (line 383).
- Incident type slugs are shown lower-case with underscores replaced, e.g. "physical injury Guidance" (`assignment-detail.tsx:382`, `components/dispatch/CompleteConfirmSheet.tsx:51`, `components/home/DispatchHeadline.tsx:50`).
- `components/ReferralPanel.tsx:271` placeholder says "Blotter / case / ticket number", although the blotter feature was removed (migration 0029). It is probably a legitimate external reference, but confirm.
- Error text can leak raw server messages: `assignment-detail.tsx:253` (`(error as ApiError).message`), `home.tsx:390-392`.
- No "forgot password / ask the Chief Tanod" guidance on login.

### Accessibility
- Positive: tile grid is a `radiogroup` with `aria-checked` (`new-incident.tsx:355-363`). Tab bar buttons carry `aria-label`s. Offers carry live-region labels. Error banners use `role="alert"`.
- The Home SOS button's `aria-label` ("Emergency SOS. Opens confirmation.") is good.
- The dispatch complete-confirm sheet is a hand-rolled dialog with no focus trap (only an initial focus and an Escape handler, `CompleteConfirmSheet.tsx:21-39`), unlike the Ionic modals.
- The Live Map is gesture-driven (drawer drag, `components/map/useDrawerGestures.ts`). I could not verify any TalkBack alternative for the map itself or the drawer.
- The `ui-banner__icon` has a `margin-top: 10px` magic number (`ui.css:130`), so icons misalign with multi-line text.
- Contrast computed from tokens: status text on white and on bg passes (≥ 4.8:1, `warning` 5.02, `info` 5.12, `tertiary` 6.1). Disabled text is `#94a3b8` on white at 2.56:1 (`--color-text-disabled`), though the disabled `Button` uses secondary text (`ui.css:47-54`, OK).
- No text-scale / large-font handling was found (no `rem` caps, no overflow checks) for users with Android "Font size: Largest". Unverified.

### Navigation / structure
- The Tanod tab structure is sensible: Home / Dispatches / Report / Map / Profile. The Admin console has four tabs with SOS first (`App.tsx:~335-395`), which is right for the Chief Tanod.
- Seven Tanod secondary screens (shifts, availability, accomplishments, school check-in, my reports, privacy, and the like) live only under Profile rows (`pages/profile.tsx:~226-300`). A school check-in is time-sensitive, but Home surfaces it only once one is already open (`pages/home.tsx:465-476`, a "Check out" alert); starting one needs Profile.
- "Dispatch #id" naming plus "Active call #id" plus "INC-" codes: the user sees three kinds of identifier (`DispatchHeadline.tsx:42`, `assignment-detail.tsx:379`, `CompleteConfirmSheet.tsx:48-51`). Consider showing the incident code only.

---

## Summary table

| Rank | Count | Where |
|---|---|---|
| P0 | 3 | SOS reach, SOS GPS delay, SOS siren |
| P1 | 10 | Home hierarchy, default type, optional location, tiny targets, invisible Briefing button, Admin SOS actions, alert overlay, hard-coded identity/numbers, offline empty states, 360 px tab bar |
| P2 | ~20 | tokens, off-scale fonts, copy, input contrast, CSS layering, forms |

## Needs a device check (priority order)
1. SOS time-to-send with GPS off and on (P0-2).
2. 360x640 Home screen with one active dispatch plus one alert: is "Respond to Call" visible without scrolling (P1-1)?
3. Light-theme navigation header: is "Briefing" visible (P1-5)?
4. Tab bar label overflow, plus the largest Android font size (P1-10).
5. Ionic `size="small"` button height, to confirm P1-4.
6. TalkBack pass over Home, the SOS sheet, New Incident and the Map drawer.
