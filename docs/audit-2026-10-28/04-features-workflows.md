# Audit 04 — Features and workflows (mobile and messaging), 2026-10-28

Read-only audit. Method: read REFERENCE, WORKFLOWS_AND_RULES, REMAINING, HANDOFF, then the code in `mobile/src` and `backend/` (notifications, SOS, offers, sync, scheduling scripts). Nothing was run on a device; findings are from code reading plus `php backend/scripts/count-routes.php`. Paths are relative to the repo root.

Settled decisions respected: BIMSS complement, no blotter, no AI, no fatigue flags, paper-only signing, online-only offer accept (Rule 84/94), no resident self-reporting, no low-data mode.

---

## 1. Ranked findings (impact on real use first)

### P0 — can fail an emergency or silently stop a safety path

**1. The background jobs the safety paths depend on are not started by anything.**
- `backend/scripts/start-baranguard.ps1` starts Apache, MySQL, cloudflared. It does not start `gsm-ingest-daemon.php`, `notification-worker.php` or the offer sweeper.
- `install-scheduled-backup-jobs.ps1:65-80` registers backup, restore drill, PB digest and `BaranguardDispatchOfferSweeper`. Nothing registers the GSM ingest daemon or the notification worker; `install-autostart-services.ps1` mentions neither.
- Consequences: (a) the SOS-by-SMS envelope (`mobile/src/utils/sosFallbackSms.ts:31-42`, advertised in `docs/POWER_CUT_PROCEDURE.md` "SOS still reaches the gateway phone") only becomes a dashboard SOS if someone is manually running the ingest daemon; (b) FCM `ack_timeout` rows are never written; (c) the night-offer re-broadcast and Admin escalation (Rules 59, 94) stop after any reboot until the sweeper task is registered (HANDOFF already admits "NOT yet registered", item 8).
- Fix (no scope creep): have the launcher start the ingest daemon, register the sweeper and worker in the installer, and show daemon liveness in Service Health (it is a real probe: last-poll time).

**2. An unacknowledged SOS goes nowhere further.**
- `NotificationService::sosRecipients` (`backend/services/notifications/NotificationService.php:173-198`) = active Admins in the barangay + on-duty Tanods. One push, one SMS fallback only if FCM failed or there is no device (`NotificationDispatcher.php:428-448`). `notification-worker.php:8-14` states an ack timeout "does not create an SMS row".
- No repeat, no escalation, and the Secretary (who Rule 89 makes the back-up dispatcher and who can ack/resolve, `TanodSosController.php:389`) and the Punong Barangay are never alerted. If the single Chief Tanod account is asleep, driving, or has the phone off, the only humans told are other tanods who cannot acknowledge (no ack for SOS in the Tanod UI beyond the overlay's notification ack).
- Contrast: night offers do escalate (`OfferService.php:54, 105-106`), so a stray pending incident is better protected than a tanod's panic button.
- Fix: a sweeper step "SOS still `active` after N minutes: re-push every Admin, then push + SMS the Secretary, then SMS the PB (and the `sos_fallback.backup_contact_number`)". Needs one owner decision because Rule 89 says SOS alerts stay Admin-only.

**3. SOS can only be raised from the Home tab, and it waits for GPS before it sends.**
- The SOS button exists only in `mobile/src/pages/home.tsx:543-560` (grep: no other page references it). Assignment detail and New Incident hide the tab bar (`App.tsx:~226-231`, `mobile-tab-bar--hidden`). From an open assignment the tap count is: Back (1), Home tab (2), SOS (3), Confirm (4). From Home it is 2 taps (SOS, Confirm).
- `useSosFlow.ts:71-80` awaits `getCurrentPosition()` (timeout 10 s, `geolocation.ts` `getCurrentPosition`) before `postSos` (5 s timeout, `apiService.ts:131`). Worst case about 15 s before the offline SMS fallback is even attempted (`useSosFlow.ts:84-91`). Rule 22 says SOS is "never blocked by a missing GPS fix"; it is delayed by one.
- `postSos` accepts `dispatchId` (`apiService.ts:470-476`) but no caller passes it, so an SOS raised mid-dispatch never links to the dispatch.
- Fix: send immediately with last-known fix (the server already falls back to `gps_track`, REFERENCE §5) and refine; put a persistent SOS control in the shared shell; pass the active `dispatchId`.

### P1 — real field friction or role gaps

**4. A Tanod in a dead-data zone with working cell signal cannot report an incident or position by SMS.**
- The server has inbound SMS handlers for `incident-fallback`, `coord-ping`, `duty-status` and `sos` (`SmsGatewayService.php:85-135`, `InternalSmsController.php:62-83`; Master Reference Rule 22). The mobile app builds an SMS envelope only for SOS (grep `buildSosEnvelopeText`: only `sosFallbackSms.ts`). The other three handlers have no client.
- For Pilar, where voice/SMS often works when mobile data does not, this is the biggest "built on the server, missing on the phone" gap. It is also already inside the BIMSS-complement scope (it is the existing Rule 22 channel).

**5. My Shifts is not cached.** There is no `shift_local` table (`localSchema.ts` table list); `my-shifts.tsx:75` calls `getMyShifts()` and on offline shows "Connect to the internet or Barangay Wi-Fi to refresh schedule" (`my-shifts.tsx:84-85`). A tanod cannot see their own published shift, or swap status, without data. Availability is cached locally; shifts are the one roster object that is not. Swap request creation is online-only too.

**6. Chief Tanod phone console cannot see where the SOS is, or who is on duty.**
- `admin-sos.tsx:145` prints only "Location: Live GPS fix / Last known / No location available" (`adminFormat.ts:89-95`). Latitude/longitude are in `AdminSosAlert` (`apiService.ts:1665-1672`) but there is no map, "open in maps", or "call this tanod" action. The only `tel:` is the fallback number (`admin-sos.tsx:~211`).
- The assign picker is the name-only `GET /users/directory` list (`AdminBits.tsx:196-208, 357-370`) with the hint "Shift availability is not available on the phone". It does not show who is on duty, nearest, or a phone number, although `GET /gps/live` is on the allow-list (`SessionPolicy.php` `ADMIN_DEVICE_ALLOWLIST`) and unused by any mobile screen (the admin shell has no map tab: `App.tsx:375-380`).
- For a dispatcher on a phone at night this reduces the console to "acknowledge, then phone people from the contacts app".
- Button label "Assign more responders" is also used for the first responder on a pending incident (`AdminBits.tsx:~382`), which is misleading.

**7. A colleague's SOS gives responders nothing to act on.**
- Tanods are SOS recipients, but the overlay (`CriticalAlertOverlay.tsx:100-140`) offers only acknowledge; the text carries raw "near lat, lng" (`NotificationDispatcher.php:398-404`) with no map link, no "navigate to", and the Live Map has no SOS marker (grep `sos` in `live-map.tsx`, `components/map/*`: none). A nearby tanod would have to copy coordinates into another app.

**8. Notification gaps between roles (who tells whom).**
- Admin cancels a dispatch: the assigned tanod is not notified. `DispatchController::cancel` (lines 586-712) has no `NotificationService::create`; the only create sites are 399 (assign) and 869 (tanod arrived/completed to Admins). The tanod finds out on the Home 30 s poll (`home.tsx:309`).
- Shift swap requested or decided: no notification to Admin/Secretary or to the tanod. Only seven `NotificationService::create` call sites exist (Accomplishment, Dispatch x2, Incidents x2, Shifts, SOS, OfferService x2); none in `ShiftSwapRequestsController`.
- A tanod cannot decline or say "cannot respond" on an assignment. `PATCH /dispatch/:id/status` only advances (`assigned > en_route > arrived > completed`; WORKFLOWS Part 2 section 2); there is no decline in any mobile page (grep). An out-of-battery or unsafe tanod can only be silent until the Chief Tanod notices.
- Escalated offers: after 8 reminders the sweeper "stops alerting" (`OfferService.php:102-106, 643`); the incident stays pending and silent. Daytime pending incidents get one push to Admins/Secretaries only (`IncidentsController.php:1890-1905`), with no repeat.
- Ordinary pushes (`report_update`, `roster_published`) are ignored when the app is open: `criticalAlertStore.ts:103` returns null for any non-critical type, and the mobile app has no notification inbox (`GET /notifications` is on the Admin allow-list but there is no mobile screen). A tanod who misses the tray push never sees that their report was returned or their roster published, except by opening the right screen.
- Secretary receives no SOS/offer alerts (`OfferService.php:309` selects `role = 'admin'` only) while Rule 89 makes her the back-up dispatcher. Inbound SMS from the gateway raises no notification at all and Secretary has no SMS Monitor (`PAGE_ROLES`), so a text to the barangay number is seen only if the Chief Tanod opens the console.

**9. Incident form can save with no location.** `new-incident.tsx:74` defaults `incidentType` to `'theft'`; `handleSave` (`:~270-300`) only requires a narrative; GPS is never tagged automatically (only on tapping the Tag GPS button, `:222`); there is no landmark/location text field (grep `locationDescription`: none) and no warning when saving without a location. A dispatcher can receive a theft with no place. Offline Tanods are the ones most likely to be skipping the GPS step.

### P2 — worth doing, lower urgency

**10. Tap/step counts (from code).**
| Task | Taps (best case) | Notes |
|---|---|---|
| Raise SOS from Home | 2 (SOS, Confirm) | plus up to 10 s GPS wait; from assignment detail 4 |
| Accept a night offer | about 3: push, Open/ack overlay (`CriticalAlertOverlay.tsx:100-113` navigates to Dispatches), Accept call (`DispatchOfferCards.tsx:93-100`) | online-only; button disabled offline by design |
| File incident offline | Report tab, (change type: default is theft), type narrative, tap Save | draft is auto-saved (`incident_draft`), saves to SQLite before navigation, shows receipt |
| School check-in | 4 (Profile tab, School row `profile.tsx:275`, pick school, Check In) | Home shows the school strip only after a check-in is open (`home.tsx:473`); offline-safe |
| Go off duty offline | 2 (toggle, confirm) | queued with tap time (`home.tsx:~330`, Rule 49) |

**11. Chief Tanod phone cannot log into other jobs it implies.** Incidents tab is read-only plus "Log an incident" (`admin-incidents.tsx:58`); there is no "mark resolved without dispatch" (stays web, deliberate, WORKFLOWS section 5). Not a defect, but the Chief Tanod must go to a desk PC to close incidents, which will make "pending" counts stale in practice.

**12. Secretary and Punong Barangay have no mobile surface.** By design (`SessionPolicy.php:68` only `tanod`, `admin`). The PB's "oversight" at night and the Secretary's "back-up dispatcher" role (Rule 89) both require the web dashboard through the tunnel. The web layout on a phone browser was not checked in this audit.

---

## 2. Promised vs delivered on mobile (parity table)

| Promised (doc) | Mobile reality | Status |
|---|---|---|
| Tanod: incidents offline (WORKFLOWS s4) | `new-incident.tsx`, SQLite first | Built; location optional, type defaulted (finding 9) |
| SOS with offline SMS fallback (Rules 22-25) | `useSosFlow.ts`, `sosFallbackSms.ts` | Built; Home-only, GPS wait (finding 3) |
| SOS badge for SMS result | `SmsFallbackBadge.tsx` | Built |
| Shifts + swap (s4) | `my-shifts.tsx` | Built, online-only, not cached (finding 5) |
| Availability offline | `availability.tsx`, `availability_local` | Built |
| Accomplishments offline entry, online-only submit | `accomplishments.tsx` | Built (month submit online by Rule 34) |
| Referrals (Refer panel) | `ReferralPanel.tsx` | Built |
| School check-in/out | `school-checkin.tsx` | Built; 4 taps |
| Offline map | `mbtilesReader.ts`, `mapPackageService.ts`, OSM fallback | Built; device-unverified (REMAINING A1 only covers some checks) |
| Dispatch offers (accept) | `DispatchOfferCards.tsx`, poll 4/12 s plus push | Built; online-only by decision |
| Chief Tanod console: SOS ack/resolve | `admin-sos.tsx` | Built; no map/call (finding 6) |
| Chief Tanod: dispatch assign/cancel/offers | `admin-dispatch.tsx`, `AdminBits.tsx` | Built; name-only picker |
| Chief Tanod: incidents (read) plus log | `admin-incidents.tsx`, `admin-log-incident.tsx` | Built |
| SMS fallbacks for incident/duty/coords (Master Reference Rule 22) | server handlers only | **Missing on mobile** (finding 4) |
| Notifications to tanod for report/roster (Rule 74) | pushes sent; no in-app display | **Half-built** (finding 8) |
| Tanod decline/unavailable | none | **Missing** |
| Chief Tanod live map of tanods | API allowed, no screen | **Missing** |

---

## 3. Docs-vs-code spot checks (16 claims)

Confirmed (9):
1. REFERENCE s5: 103 routes across 27 files. Ran `count-routes.php`: 103 / 27. OK.
2. REFERENCE s1: mobile on-device API override removed 2026-09-27. `apiService.ts:40-56` documents it; no `setApiBaseUrlOverride` caller. OK.
3. Rule 46: chunks of 50, GPS cap 200. `syncService.ts:147,149`. OK.
4. Rule 25/s2 SOS 5 s timeout. `apiService.ts:131` `SOS_TIMEOUT_MS = 5000`. OK.
5. Rule 12 device session 24 h / 7 d. `SessionPolicy.php:44-45`. OK.
6. Rule 49 offline off-duty queued with tap time. `home.tsx:102-130, 318-330`, `enqueueOffDuty`. OK.
7. Rule 57 offer alert shows only type/barangay/time. `criticalAlertStore.ts:107-120`, `NotificationDispatcher.php` `dispatch_offer` case. OK.
8. REFERENCE s1 mobile stack Ionic React 9 + Capacitor 8.5. `mobile/package.json` `@capacitor/core ^8.5.1`, `@ionic/react ^9`. OK.
9. Rule 90 local schema v10 `admin_incident_outbox`. `localSchema.ts:53, 472`. OK.

Contradictions or drift (7):
10. REFERENCE Rule 12 amendment: "five writes require the device header/signature". `ADMIN_DEVICE_ALLOWLIST` has **seven** signed writes (ack, resolve, POST dispatch, cancel, POST incidents, POST offers, cancel offer); HANDOFF says "six".
11. Rule 45 priority order ("SOS, dispatch updates, incidents, workflow, GPS") vs REFERENCE s5 and `SyncController.php:126` (`sos, incident, referral, gps, duty_status, dispatch_status, ...`) vs the client (`syncService.ts:205-240`: sos, dispatch status, duty, incidents, referrals, availability, accomplishments, school, gps). Three different orders; client is closest to Rule 45, but Rule 45 omits duty status and the REFERENCE order puts GPS before dispatch status.
12. WORKFLOWS s7 / Scenario 7 step 5 say an Admin can resolve an `active` SOS directly; the phone offers Resolve only after Acknowledge (`admin-sos.tsx:~165-180`; REFERENCE Rule 12 amendment says the same for the phone). Doc should say "web: direct; phone: after acknowledge".
13. Rule 89 "SOS and offer alerts still go to Admin accounts only" is true in code (`OfferService.php:309`, `sosRecipients`), but the same section makes the Secretary back-up dispatcher. The two together describe a back-up who is never told (finding 8). Doc consistent, design incomplete.
14. POWER_CUT_PROCEDURE: "An SOS still reaches the gateway phone by SMS" is stated as fact. It depends on `gsm-ingest-daemon.php` running, which no launcher or installer starts (finding 1). Also notification-worker.php says "Run via cron/Task Scheduler" and nothing registers it; no doc says it is unscheduled.
15. WORKFLOWS Part 1 s2 title "Complete Navigation Reach (8 Sidebar Items)" lists 7 (web, minor). Scenario 2 cites `verify-dispatch-offers.sh` 193 checks; REFERENCE Wave 2 list says 184. Counts drift between docs.
16. HANDOFF 2026-10-12 says mobile "shows Open / Prepared / Returned; stale `noted`/`approved` shown as Prepared"; `accomplishments.tsx` and `my-reports.tsx` contain no `noted`/`approved` handling (grep). Either the mapping lives in a shared helper I did not find, or the claim is unimplemented; not proven either way.

---

## 4. Beneficial additions that are not scope creep

Each is small, uses what already exists, and none rebuilds a removed feature.

1. **Start the dormant jobs** (finding 1): launcher starts the ingest daemon; installer registers the sweeper and the worker; Service Health shows ingest last-poll age. Smallest change, highest safety return.
2. **SOS repeat and escalation** (finding 2), with the owner deciding Secretary/PB involvement.
3. **SOS in the shell plus send-first** (finding 3): fire the post without waiting for GPS, attach `dispatchId`.
4. **"Send by SMS" for incidents and a position ping** (finding 4) — the server side is built.
5. **Cache published shifts** like schools (finding 5), read-only.
6. **Chief Tanod phone: on-duty/nearest in the assign picker, a map/tel link on the SOS card** (finding 6): `GET /gps/live` is already allowed.
7. **Tanod "cannot respond" with a reason** that returns the dispatch to the Chief Tanod and alerts them (finding 8). Keeps the dispatch state machine, adds one transition.
8. **Notify the tanod on cancel; notify Admin/Secretary on swap request and the tanod on its outcome** (finding 8); a tiny mobile notification list for ordinary pushes.
9. **Make location a visible requirement in the incident form**: auto-tag GPS on open, add a one-line landmark field, warn on save without a place, no silent `theft` default (finding 9).
10. **Quick "request backup" to the Chief Tanod** (priority alert, no new dispatch state). Optional; discuss before building because it adds a new alert type.

Not proposed (decided): SMS-accept for offers (Rule 84/94), resident self-reporting (Rule 56), low-data mode (Rule 94), any blotter/AI/fatigue feature, Cloudflare Access on the API.

---

## 5. What was not checked

No device or browser run; no Gradle build. Native pieces (`SosSmsPlugin.java`, `CriticalAlertMessagingService.java`) were not read. The web dashboard was out of scope except where it determines a mobile workflow. Claim 16 may be satisfied in a helper not located. Server batch limit "rejects above 200" (Rule 46) was not verified.
