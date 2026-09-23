# Baranguard — Business Rules Catalogue (Mobile + Web)

**Compiled 2026-09-23 from the code, not from the docs.** Every rule
below was read out of the implementation. The file that enforces it is
cited next to the rule. Where the code and `REFERENCE.md` / the Master
Reference disagree, the disagreement is listed in §23, not smoothed over.

**How to read this**

- **Enforced by:** **S** = server (`backend/`, the real security
  boundary), **M** = mobile app (`mobile/src/`), **W** = web dashboard
  (`web/src/`). A rule marked only **M** or **W** is a client-side UX
  rule. §2 Rule 6 says client-side hiding is never a security boundary,
  so every access rule is also checked on the server.
- Rule IDs (`AUTH-3`, `DSP-5` …) exist only so UAT notes and bug
  reports can point at a rule. They are not referenced anywhere in code.
- Numbers such as lockout counts, radii and thresholds are the constants
  in code on the compile date. Grep the cited file before trusting one.

---

## Contents

1. [Cross-cutting rules](#1-cross-cutting-rules)
2. [Roles and who can do what](#2-roles-and-who-can-do-what)
3. [Authentication and sessions](#3-authentication-and-sessions)
4. [Incidents](#4-incidents)
5. [Dispatch](#5-dispatch)
6. [AI redaction pipeline](#6-ai-redaction-pipeline)
7. [Blotter (finalize / amend / Lupon packet)](#7-blotter-finalize--amend--lupon-packet)
8. [AI Tools assistants](#8-ai-tools-assistants)
9. [Evidence attachments](#9-evidence-attachments)
10. [Citizen reports and the public transparency report](#10-citizen-reports-and-the-public-transparency-report)
11. [Duty status, GPS and live tracking](#11-duty-status-gps-and-live-tracking)
12. [Tanod SOS](#12-tanod-sos)
13. [Notifications and delivery](#13-notifications-and-delivery)
14. [Shifts, swap requests and fatigue](#14-shifts-swap-requests-and-fatigue)
15. [Users and devices](#15-users-and-devices)
16. [Offline map packages](#16-offline-map-packages)
17. [SMS](#17-sms)
18. [System settings](#18-system-settings)
19. [Reports, analytics, audit log, search, service health](#19-reports-analytics-audit-log-search-service-health)
20. [Data retention](#20-data-retention)
21. [Mobile app–only rules](#21-mobile-apponly-rules)
22. [Web dashboard–only rules](#22-web-dashboardonly-rules)
23. [Gaps and inconsistencies found while compiling](#23-gaps-and-inconsistencies-found-while-compiling)

---

## 1. Cross-cutting rules

| ID | Rule | By | Where |
|---|---|---|---|
| X-1 | **Four fixed tenants:** Dao=1, Binanuahan=2, Marifosque=3, Banuyo=4. Every resource belongs to exactly one barangay. The caller's barangay always comes from their session, never from the request body. A `barangay_id` in a body, such as `POST /shifts`, is ignored. | S | `AuthMiddleware::requireTenant`, `ShiftsController` doc |
| X-2 | **Cross-tenant access returns 404, never 403.** A 403 would confirm that the resource exists. The same applies to a Tanod asking for an incident, dispatch, device or job that isn't theirs. | S | `AuthMiddleware::requireTenant` + every controller |
| X-3 | **Wrong role returns 403 `FORBIDDEN`.** Role is checked per endpoint, and authentication never implies authorization. | S | `AuthMiddleware::requireRole` |
| X-4 | **`raw_narrative` never leaves the system** except through the approved AI pipeline. It never goes to FCM, SMS, logs, audit metadata or list endpoints. `GET /incidents/:id` is the only endpoint that returns it, and only to a Secretary. | S | `IncidentsController::show` |
| X-5 | **Party fields follow `raw_narrative`'s protection.** `complainant_name`, `respondent_name` and `complainant_contact_number` on `incident` are Secretary-only to read, and `complainant_name` is Secretary-only to edit. | S, W | `IncidentsController::show/update`, `incident-management.js` |
| X-6 | **Idempotency.** Web writes carry an `Idempotency-Key` UUID header (or a body `request_id`). Mobile writes carry `client_event_id` plus a server-verified `X-Device-Id`. A retry returns the original row with 200, never a second row. | S, M, W | Incidents, Dispatch, Shifts, Duty, GPS, SOS, Sync, SMS, Evidence |
| X-7 | **Audit metadata is allow-listed.** It may hold identifiers and statuses only. It never holds narrative, names, contact numbers, coordinates, tokens or credentials. Edits record which fields changed, never their values. | S | `Lib/Audit.php` callers |
| X-8 | **The audit log is write-once.** No endpoint edits or deletes it. Only the retention job removes rows. | S, W | `AuditLogController`, `audit-log.js` (no row actions) |
| X-9 | **No fabricated data.** No invented stats, confidence scores, identities or health badges, and no control that looks functional but does nothing. A dependency that isn't set up reports `not_configured` and shows as neutral, never as red and never as green. | S, M, W | Everywhere (§2 Rule 6) |
| X-10 | **Timestamps are stored in UTC and shown in Asia/Manila (+08:00).** Day bucketing is done in PHP against a fixed +08:00, never with `CONVERT_TZ()`. Client timestamps are informational: the server's `received_at`/`created_at` is authoritative. | S, W | `ReportsController`, `DateRangePicker.js` |
| X-11 | **Pagination:** `page` starts at 1, `limit` defaults to 25 and is capped at 100. Notifications default to 20, capped at 50. | S | All list controllers |
| X-12 | **Error envelope:** `{"error":{"code","message"}}`. The codes are `VALIDATION_ERROR` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `UNPROCESSABLE_ENTITY` 422, `RATE_LIMITED` 429, `SERVICE_UNAVAILABLE` 503 and `SERVER_ERROR` 500. | S | `Lib/ApiError.php` |
| X-13 | **Unknown enum values are rejected with 400,** not silently matched to nothing. This covers status, priority, type, role, direction and similar fields. | S | All filters |
| X-14 | **The API never calls the AI model.** It only queues jobs. `scripts/ai-worker.php` is the only process that talks to Ollama. There is no external AI fallback. | S | `AiDraftController`, `AiToolsController` |
| X-15 | **Baranguard complements DILG BIMSS and must not replace it.** There is no walk-in blotter entry and no standalone blotter records list. AI blotter output is a draft for re-typing into BIMSS/KPIS. | S, W | Removed `POST /blotter`, W6 removed |
| X-16 | **Server data is never put into `innerHTML` without escaping.** Use `textContent` or `escapeHtml.js`. AI model output always renders as `textContent`. | W | `utils/escapeHtml.js`, `AiToolPanel.js` |

## 2. Roles and who can do what

**Roles:** Admin · Secretary · Punong Barangay (PB) · Tanod ·
Lupon. Lupon exists in the database enum only and can never log in.

| Capability | Admin | Secretary | PB | Tanod |
|---|---|---|---|---|
| Web dashboard screens | all ops screens | Incident Mgmt, Citizen Inbox, incident detail, AI Review, Settings | Dashboard, Live Map, Analytics, Personnel (Fatigue tab only), incident detail, Settings | none ("no screen" page) |
| Mobile app | — | — | — | yes (only mobile role) |
| List incidents | own barangay | own barangay | own barangay | **only incidents they reported** (forced server-side) |
| View one incident | redacted fields | **full, including raw + party fields** | redacted fields | only if they reported it or were dispatched to it |
| Create incident | web (Idempotency-Key, may set priority) | web | ✗ | mobile (X-Device-Id, priority always `normal`) |
| Edit incident (priority/type/location) | ✓ | ✓ (+ complainant name) | ✗ | ✗ |
| Resolve incident | ✓ | ✗ | ✗ | ✗ |
| Create/cancel dispatch | ✓ | ✗ | ✗ | ✗ |
| Advance dispatch status | ✓ (override_reason required) | ✗ | ✗ | own dispatch only |
| List dispatches | ✓ | ✗ (gets timeline via incident detail) | ✓ | own only |
| AI redaction, approve, translate, extraction | ✗ | ✓ | ✗ | ✗ |
| Finalize/amend blotter, Lupon packet | ✗ | ✓ | ✗ | ✗ |
| Read a blotter record | ✓ | ✓ | ✓ | only if reporter/dispatched |
| Evidence list | ✓ | ✓ | ✗ | only if reporter/dispatched |
| Evidence upload | ✗ | ✗ | ✗ | ✓ (own-access incidents) |
| AI Classifier | ✓ | ✓ | ✗ | ✗ |
| AI Blotter Assistant | ✗ | ✓ | ✗ | ✗ |
| AI SMS Composer | ✓ | ✗ | ✗ | ✗ |
| AI Threat Analyzer | ✓ | ✗ | ✓ | ✗ |
| Citizen report inbox + convert | ✓ | ✓ | ✗ | ✗ |
| GPS live roster | ✓ | ✗ | ✓ | ✓ (same-barangay peers) |
| GPS history | ✓ | ✗ | ✗ | ✗ |
| Duty status | read all | ✗ | read all | set + read own |
| SOS raise | ✗ | ✗ | ✗ | ✓ |
| SOS list | ✓ | ✗ | ✓ | ✗ |
| SOS acknowledge/resolve | ✓ | ✗ | ✗ | ✗ |
| Shifts | create/edit/list | ✗ | ✗ | list own |
| Swap requests | approve/deny/list | ✗ | ✗ | create/list own |
| Fatigue flags | list + acknowledge | ✗ | list (read-only) | ✗ |
| Users (list/create/suspend/deactivate) | ✓ | ✗ | ✗ | ✗ |
| Edit own profile / change password | ✓ | ✓ | ✓ | ✓ |
| Devices register/deactivate | ✗ | ✗ | ✗ | own only |
| Map package upload/metadata | upload + view | ✗ | ✗ | view + download |
| SMS logs/conversations/send/broadcast/subscribers | ✓ | ✗ | ✗ | ✗ |
| Reports summary/heatmap/export | ✓ | ✗ | ✓ | ✗ |
| Nav badge counts | ✓ | ✗ | ✗ | ✗ |
| Audit log, service health, system settings | ✓ | ✗ | ✗ | ✗ |
| Global search | ✓ | ✓ | ✓ | ✓ |
| Notifications feed (own targets) | ✓ | ✓ | ✓ | ✓ (ack Tanod-only) |

**Why the Secretary outranks the Admin on records:** RA 7160 §394(c)
makes the Barangay Secretary the statutory records custodian. Admin
getting *less* on raw narrative and blotter is deliberate. Do not "fix"
it. (`IncidentsController::show`, `BlotterController` class doc)

## 3. Authentication and sessions

| ID | Rule | By | Where |
|---|---|---|---|
| AUTH-1 | Usernames are normalised by trimming and lowercasing. They must be 3–64 characters of `a-z 0-9 . _ -`. | S | `Username.php` |
| AUTH-2 | Passwords need ≥12 characters, with at least one lowercase letter, one uppercase letter and one digit. They are hashed with Argon2id. The web settings form shows the same checklist live. | S, W | `PasswordPolicy.php`, `settings.js` |
| AUTH-3 | **Lockout:** 5 failed logins inside a rolling 15-minute window lock the account for 15 minutes. A successful login resets the counters. | S | `AuthController` |
| AUTH-4 | **Failed logins look identical from outside.** Unknown user, wrong password, locked, inactive, suspended and Lupon all get the same 401 "Invalid username or password." A dummy Argon2 hash equalises the timing. Both clients show one generic message ("Unable to sign in with those credentials."). The only other message is an honest "workstation unreachable" when the network is down. | S, M, W | `AuthController::login`, `login.tsx`, `login.js` |
| AUTH-5 | There is no role selector at login. The role always comes from the account. | M, W | `login.tsx`, `login.js` |
| AUTH-6 | **Two session kinds.** *Web:* a 15-minute sliding JWT (`JWT_EXPIRES_IN_MINUTES`). *Device:* issued only when the role is `tanod` **and** a well-formed `X-Device-Id: and-<uuidv4>` header is sent. It lasts 24 hours sliding, with a hard cap of 7 days from issue. | S, M | `SessionPolicy.php`, `apiService.ts` |
| AUTH-7 | **Sliding renewal** happens only once less than half the token's life remains. Expiry never moves backwards. The new token comes back in the `X-Renewed-Token` header, and the mobile client keeps whichever token expires later. | S, M | `AuthMiddleware::maybeRenew`, `session.ts::storeRenewedToken` |
| AUTH-8 | **Every request re-checks the database session**: signature, expiry, session exists, not revoked, user active, user not suspended. Revocation takes effect on the next request for both session kinds. | S | `AuthMiddleware::authenticate` |
| AUTH-9 | Logout is idempotent. A second logout with the same token returns `{success:true}`. | S | `AuthMiddleware::resolveForLogout` |
| AUTH-10 | Change password is self-only and needs the current password (a wrong one gets a generic 401). It revokes every *other* session and keeps the current one. | S | `AuthController::changePassword` |
| AUTH-11 | Suspending or deactivating a user revokes all of their sessions in the same transaction. | S | `UsersController::updateOtherUserStatus` |
| AUTH-12 | **Web session storage:** the token lives in `sessionStorage`, so it dies with the tab. "Remember me" stores only the username in `localStorage`, never the password. | W | `apiClient.js`, `login.js` |
| AUTH-13 | **Mobile session storage:** the token lives in app-private Capacitor Preferences. The app shell opens if **any** session is stored, even an expired one, so an out-of-range Tanod keeps their cached view. The first 401 from the server clears the session and redirects to Login. | M | `session.ts::hasStoredSession`, `App.tsx` |
| AUTH-14 | **Mobile post-login steps never block entering Home.** Device registration, map-package check and SOS fallback-contact caching are all best-effort and non-fatal. | M | `login.tsx::runPostLoginSetup` |
| AUTH-15 | A Tanod can log in on the web but lands on an honest "no screen for your role" page. | W | `main.js` |

## 4. Incidents

**Enums:** status `pending → dispatched → resolved`. Priority
`normal | high | critical`. Type: `theft, physical_injury, disturbance,
domestic_dispute, vandalism, traffic_incident, fire, medical_emergency,
missing_person, animal_complaint, other`. The same 11 types are
duplicated in `mobile/src/services/db/incidentRepository.ts`.

| ID | Rule | By | Where |
|---|---|---|---|
| INC-1 | New incidents always start as `pending`. `source` is set by the server (`web`, `app` or `sms`), and any `source` the client sends is ignored. | S | `IncidentsController::createWeb/createMobileItem` |
| INC-2 | **Web create** (Admin/Secretary) needs an `Idempotency-Key` UUID, `incident_type` and a non-blank `raw_narrative`. Optional: `priority` (default `normal`), `location_description` (≤255), `complainant_name`/`respondent_name` (≤255), `complainant_contact_number` (≤32). Blank optional strings are stored as NULL. | S, W | `createWeb` |
| INC-3 | **Mobile create** (Tanod) needs `X-Device-Id` (a device registered to the caller and active), `client_event_id` UUID, `incident_type` and a non-blank `raw_narrative`. Priority is always `normal`, because mobile cannot set it. `device_offline_created_at` is optional and informational. | S, M | `createMobileItem` |
| INC-4 | Coordinates are optional, but must be sent as a pair of numbers when present. Latitude must be within ±90 and longitude within ±180. | S | `validateCoordinates` |
| INC-5 | **Display ID** is `INC-YYYY-NNN`, numbered per barangay per UTC year and computed inside the insert transaction. A collision is retried up to 3 times. | S | `nextDisplayId` |
| INC-6 | Creating an incident notifies the barangay's Admins and Secretaries. Mobile-created incidents are always a `priority_alert`. Web-created ones are a `priority_alert` only when high or critical, and `other` otherwise. A notification failure never rolls back the incident. | S | `createWeb/createMobileItem` |
| INC-7 | **Tanod list scope:** `GET /incidents` for a Tanod is forced to `reported_by = me`. | S | `IncidentsController::index` |
| INC-8 | **Tanod detail access:** only if they reported the incident or have (or had) a dispatch on it. Otherwise 404. | S | `show`, `tanodMayAccess` |
| INC-9 | List endpoints never return a narrative. `q=` searches `display_id`/`incident_type`, and also an exact `incident_id` when the query is numeric. The list is sorted newest first. | S | `index` |
| INC-10 | **Edit (`PATCH /incidents/:id`) corrects operational fields only.** Admin and Secretary may set `priority`, `incident_type` and `location_description`. Only a Secretary may set `complainant_name` (anyone else gets 403). Sending `raw_narrative` or `redacted_narrative` is a hard 400. An empty patch is a 400. `Idempotency-Key` is required, and a replay returns the original result. | S, W | `update`, `incident-management.js` |
| INC-11 | **Resolve (`PATCH /incidents/:id/status`)** is Admin-only and the body must be exactly `{status:"resolved"}`. Only a `dispatched` incident can be resolved: `pending` gets 409 and already `resolved` gets 409. Resolving is refused while any dispatch is still `assigned`, `en_route` or `arrived`. | S, W | `updateStatus`, `blotter-detail.js` admin panel |
| INC-12 | Resolving an incident also sets any linked **finalized** blotter's `case_status` to `resolved`. This is the only way that value is ever set. | S | `updateStatus` |
| INC-13 | Resolving an incident that came from a citizen report sends that citizen a best-effort "resolved" SMS. | S | `CitizenUpdateNotifier::notifyResolved` |
| INC-14 | **A completed dispatch does not auto-resolve the incident.** A human Admin closes it. | S | (no auto-resolve anywhere) |
| INC-15 | **Nearby (`GET /incidents/nearby`)** is Tanod-only. It needs latitude/longitude. The radius defaults to 2 km with a 5 km maximum. It excludes resolved incidents and those without coordinates, returns at most 100 items sorted by distance, and never includes a narrative. | S, M | `nearby`, `live-map.tsx` |
| INC-16 | The approved `redacted_narrative` may be read by every role that can view the incident, because approval is what makes it shareable. | S | `show` |

## 5. Dispatch

**Dispatch states:** `assigned → en_route → arrived → completed`, with
`cancelled` as a side exit.

| ID | Rule | By | Where |
|---|---|---|---|
| DSP-1 | Create is Admin-only. The body needs `incident_id`, `tanod_id` and a `request_id` UUID for idempotency. A replay returns the existing dispatch. | S, W | `DispatchController::create`, `DispatchAction.js` |
| DSP-2 | The incident must be `pending` or `dispatched`. A resolved incident gets 409. | S | `create` |
| DSP-3 | **Tanod eligibility:** same barangay, role `tanod`, active, and their **latest** duty-status row is exactly `on_duty`. `responding`, `off_duty` and having no row at all are all ineligible. Every failure reason returns the same generic 422 so reasons can't be enumerated. | S, W | `create`, dispatch picker |
| DSP-4 | **Multiple concurrent responders are allowed** on one incident, with no cap and no priority gate. The same Tanod cannot be actively assigned twice to the **same** incident (409). | S | `create` |
| DSP-5 | Creating a dispatch sets the incident to `dispatched`, copies the incident's priority onto the dispatch, sets `route_status='unavailable'`, notifies the assigned Tanod (a `dispatch` notification, FCM with SMS fallback) and writes an audit row that includes `is_additional_responder`. A delivery failure never fails the dispatch. | S | `create` |
| DSP-6 | **Cancel** is Admin-only, and only from `assigned` or `en_route` (409 otherwise). When no *other* active dispatch remains, the incident goes back to `pending`. Otherwise it stays `dispatched`. | S, W | `cancel` |
| DSP-7 | **Status transitions move forward exactly one step:** `assigned→en_route→arrived→completed`. Skipping a step or going backwards gets 409. `cancelled` cannot be reached through this endpoint. | S, M | `applyStatusTransition`, `assignment-detail.tsx` (button always advances one step) |
| DSP-8 | A Tanod may advance only their own dispatch. An Admin may advance any same-barangay dispatch but must give an `override_reason`, which is audited as `dispatch_status_override`. | S | `applyStatusTransition` |
| DSP-9 | When a Tanod (not an Admin) marks a dispatch `arrived` or `completed`, the barangay's Admins and Secretaries are notified. | S | `applyStatusTransition` |
| DSP-10 | Each transition stamps its own timestamp column (`en_route_at`, `arrived_at`, `completed_at`). | S | `applyStatusTransition` |
| DSP-11 | **Routing (`GET /dispatch/:id/route`)** is for the dispatch's own Tanod or an Admin. It needs the caller's live latitude/longitude, and `mode` is `car` (default) or `foot`. An incident without coordinates gets 409. On an ORS failure the previous route is kept and marked `stale`. It is `unavailable` only if no route was ever computed. It never returns 500 and is never audited, because the input is raw coordinates. | S, M | `route`, `assignment-detail.tsx` |
| DSP-12 | `GET /dispatch` for a Tanod is forced to `tanod_id = me`. The response includes `incident_type`/`lat`/`lng` for the mobile cache but never a narrative. | S | `index` |
| DSP-13 | The Secretary cannot call `GET /dispatch`. They see dispatch timestamps and responder names through `GET /incidents/:id`'s `dispatches[]`, `dispatched_at`, `arrived_at` and `has_active_dispatch`. The singular timestamps mean the **first/primary** responder. | S | `IncidentsController::show` |

## 6. AI redaction pipeline

**Order:** raw → redaction draft → summary built from the draft (never
from raw) → Secretary review → approve. Only `POST
/incidents/:id/ai-draft/approve` may write `incident.redacted_narrative`.

| ID | Rule | By | Where |
|---|---|---|---|
| AI-1 | Every pipeline endpoint is **Secretary-only** and same-barangay. | S, W | `AiDraftController`, `ai-review.js` (route gated to Secretary) |
| AI-2 | `POST /incidents/:id/redact` queues a redaction job and an extraction job (party-field draft). It is refused with 409 once a finalized blotter exists, because the amendment workflow applies then. It returns 503 if no model is configured. If the model is configured but down, the job still queues. | S | `redact` |
| AI-3 | `draft_version` must match exactly for regenerate-summary, approve and extraction-approve. A stale version gets 409 "reload and try again". | S, W | `regenerateSummary`, `approve`, `approveExtraction` |
| AI-4 | Regenerate-summary is refused while the draft is still being generated (409). | S | `regenerateSummary` |
| AI-5 | **Approve requires** that no approval exists yet (a second approval gets 409, unless it's an identical replay, which returns 200), that the draft is `completed`, that the summary is **not stale**, that `draft_version` matches, and that the submitted text is **byte-for-byte equal** to the current draft. | S | `approve` |
| AI-6 | Approval sets `redacted_narrative`, `redaction_approved_by` and `redaction_approved_at`. After that the approved text can only change through the amendment workflow. | S | `approve` |
| AI-7 | Extraction approve writes whatever the Secretary submits (≤255 for names, ≤32 for contact, all optional) onto the incident's party fields. The values are never audited. | S | `approveExtraction` |
| AI-8 | **Translation** is offered in `en`, `fil` and `bcl`, and only for an **approved** redaction (409 otherwise). Output is flagged `language_validated=false` for Bikol until a real evaluation run exists. | S, W | `translate` |
| AI-9 | Every run records the model version it actually used. There are no invented confidence scores and no vendor model badge. | S, W | `AiJobQueue`, `ai-review.js` |
| AI-10 | W8 polls the draft every 3 seconds while a job is queued, and stops polling when the user navigates away. | W | `ai-review.js` |

## 7. Blotter (finalize / amend / Lupon packet)

**`case_status`:** `active → under_investigation → settled →
resolved`. It only moves forward.

| ID | Rule | By | Where |
|---|---|---|---|
| BLT-1 | Finalize, amend and the Lupon packet are **Secretary-only**, and Admin cannot do them. | S, W | `BlotterController`, `blotter-detail.js` |
| BLT-2 | **Finalize** requires an approved redaction (409 otherwise) and a non-blank `narrative_summary`. The Secretary types the summary; it is not copied from the AI. Optional party fields: names ≤255, contact ≤32. Finalizing twice gets 409. | S | `finalize` |
| BLT-3 | Finalize assigns `BLT-YYYY-NNN`, numbered per barangay per year of `finalized_at`, and sets `case_status='active'`. A draft that is never finalized never uses up a number. | S | `finalize` |
| BLT-4 | **Amend** requires a finalized record (409 if it isn't), a non-blank `narrative_summary` and a non-blank `reason`. The previous version is copied into `blotter_revision` **before** being overwritten. Nothing is deleted. | S | `amend` |
| BLT-5 | In an amend, an omitted party field keeps its current value, while an explicitly sent blank clears it. | S | `parsePartyFields` |
| BLT-6 | Amend may only move `case_status` **forward**, to `under_investigation` or `settled`. `active` and `resolved` are not accepted, and any backward or same-step move gets 409. `resolved` is set only by resolving the incident (INC-12). | S, W | `amend` |
| BLT-7 | A **Lupon packet** (PDF) needs both an approved redaction and a finalized blotter (409 otherwise). It is stored outside the web root and served only through an authorised download route with a verification code. | S | `luponPacket*` |
| BLT-8 | Reading a blotter record is allowed for any role in the same barangay. A Tanod additionally needs a reporter or dispatch relationship to the incident (404 otherwise). | S | `show`, `showByIncident` |
| BLT-9 | The incident-detail action panel is driven by real server state. When an action is unavailable, it **says which prerequisite is missing** instead of hiding the control. The Back button depends on the role: PB goes back to the Dashboard, everyone else to Incident Management. | W | `blotter-detail.js` |

## 8. AI Tools assistants

| ID | Rule | By | Where |
|---|---|---|---|
| AIT-1 | AI Tools **write nothing**. Each one queues an `ai_processing_log` row. The output is text that a human reads and re-types. | S | `AiToolsController` |
| AIT-2 | **Blotter Assistant** is Secretary-only, because it reads raw narrative. **Classifier** is Admin and Secretary, reads only the *approved* redaction, and returns 409 if none exists (the worker re-checks at write time). **SMS Composer** is Admin-only and takes an operator-typed `prompt` of up to 2,000 characters, never an incident. **Threat Analyzer** is Admin and PB and uses aggregate counts only for the caller's own barangay. | S, W | `AiToolsController` |
| AIT-3 | Polling a job (`GET /ai-tools/jobs/:id`) requires the **same barangay and the same requesting user**. Anyone else gets 404, which stops an Admin from reading a Secretary's Blotter Assistant output. | S | `job` |
| AIT-4 | `GET /ai-tools/availability` returns healthy, unhealthy or not_configured with no details. The panel disables Generate and shows a banner when the model can't be reached. The availability result is cached for 60 seconds, and jobs are polled every 3 seconds. | S, W | `availability`, `AiToolPanel.js` |
| AIT-5 | The Classifier is collapsed by default. It auto-runs once per incident per visit once an approved redaction exists, and shows a chip only when its suggestion **disagrees** with what's recorded. "Apply in Edit" preselects the values, and a human still has to save. | W | `incident-management.js` |
| AIT-6 | The SMS Composer's "Use this draft" fills the compose box. The panel has no send button, because sending stays a separate, audited action. | W | `sms-monitor.js` |
| AIT-7 | The Threat Analyzer offers 7-, 30- or 90-day presets (90 is the default) or a custom range. It is labelled as describing what was recorded, not as a forecast. The server-side prompt forbids naming people or households and forbids predicting offenders. | W, S | `threat-analysis.js`, `AiPrompts` |

## 9. Evidence attachments

| ID | Rule | By | Where |
|---|---|---|---|
| EVD-1 | **Upload** is Tanod-only, by multipart form. It needs `X-Device-Id` (registered and owned), access to the incident (reporter or dispatched), `type` of `photo` or `voice`, a client `sha256` (64 hex characters), `mime_type` (≤100), an optional `original_filename` (≤255), and a `client_request_id` UUID. A replay returns the original row. | S, M | `uploadEvidence`, `syncService.ts` |
| EVD-2 | The server hashes the bytes it actually received and **rejects a mismatch** with the client's SHA-256. Empty files are rejected. The maximum size is 25 MB. | S | `uploadEvidence` |
| EVD-3 | Files are stored outside the web root. **Responses never include a filesystem path.** | S | `evidence`, `uploadEvidence` |
| EVD-4 | **Listing evidence** is allowed for Admin, Secretary, and a Tanod with a relationship to the incident. PB is not allowed. Every listing writes an `evidence_accessed` audit row. | S | `evidence` |
| EVD-5 | On the phone, photos are downscaled to at most 1600 px on the longest side and saved as JPEG at 0.75 quality. If compression fails, the original is kept rather than lost. Voice notes are not compressed. Files go to app-private storage, and the SHA-256 is computed from the bytes on disk. | M | `evidenceCapture.ts` |
| EVD-6 | An attachment is saved locally only **after** its parent incident has saved. If an evidence save fails, the incident is still kept. | M | `new-incident.tsx` |
| EVD-7 | Evidence uploads run after the sync batch, so an incident synced in the same pass can have its evidence uploaded straight away. | M | `syncService.ts` |
| EVD-8 | **On-device cleanup** only removes files that are already synced and were synced more than 30 days ago. It runs when the user taps a button in Profile. | M | `storageMaintenance.ts`, `profile.tsx` |

## 10. Citizen reports and the public transparency report

| ID | Rule | By | Where |
|---|---|---|---|
| CIT-1 | `POST /citizen-reports` is **public, with no account**. It needs `barangay_id` (one of the 4) and `description` (≤2,000 characters). `contact_number` (≤32) and coordinates (sent as a pair) are optional. | S, W | `CitizenReportsController::submit`, `citizen-report.js` |
| CIT-2 | **Rate limit:** 3 accepted submissions per IP address per rolling 15 minutes. The next one gets 429. | S | `submit` |
| CIT-3 | The public form shows a "call 911 for life-threatening emergencies" notice and a live character counter. | W | `citizen-report.js` |
| CIT-4 | The inbox is Admin and Secretary only, with the filter `status=unconverted` (default), `converted` or `all`. | S, W | `index`, `citizen-reports-inbox.js` |
| CIT-5 | **Convert** is Admin and Secretary only. It needs `incident_type` and an optional `priority` (default `normal`). It creates a `pending` incident with `source='web'` and `reported_by=NULL`. The description becomes `raw_narrative` and the contact number becomes `complainant_contact_number`. It notifies Admins and Secretaries. Converting an already-converted report returns the existing incident. | S | `convert` |
| CIT-6 | After conversion the citizen gets a best-effort "received" SMS. Citizen SMS messages contain only a fixed template, the barangay name and the `display_id`. They never include the incident type, names, location or narrative. Duplicate messages are prevented by a deterministic correlation ID. | S | `CitizenUpdateNotifier` |
| CIT-7 | **`GET /public/transparency`** is public. It returns counts only, in monthly buckets, over a fixed 6-month window with no location breakdown. Any category with fewer than 5 cases is merged into a combined bucket. There is no response-time figure and no rate limit; it relies on being LAN-only. | S | `PublicReportsController` |

## 11. Duty status, GPS and live tracking

| ID | Rule | By | Where |
|---|---|---|---|
| DUT-1 | Duty status is `on_duty`, `responding` or `off_duty`. Only a Tanod can set it, for themselves, with a `client_event_id`. The server always records the channel as `app`, or as `sms` when it arrives through the SMS fallback. | S | `DutyStatusController` |
| DUT-2 | Reading duty status: a Tanod reads their own history (`?user_id=me`). Admin and PB read their barangay (`?barangay_id=`). Sending both parameters is a 400. | S | `index` |
| DUT-3 | The mobile duty toggle **always calls the server** rather than flipping local state. It only toggles between `on_duty` and `off_duty`. The status shown on load comes from the server, and an unknown status while offline is labelled "Duty Status Unknown (Offline)". | M | `home.tsx` |
| DUT-4 | Going on duty starts the native patrol foreground GPS service and going off duty stops it. Background tracking never runs off-duty. If location permission is denied, duty still toggles and the screen shows "patrol GPS is OFF". | M | `home.tsx`, `patrolLocationService.ts` |
| GPS-1 | `POST /gps` is Tanod-only. It needs `client_event_id`, latitude/longitude within range, `accuracy_m` ≥ 0 and `recorded_at`. An optional `dispatch_id` must be one of the caller's own **active** dispatches (422 otherwise). The server stamps `received_at`. | S | `GpsController::createItem` |
| GPS-2 | `GET /gps/live` is for Admin, PB and Tanod, own barangay only. It returns each active Tanod's latest point. A point is **stale when `age_seconds` ≥ 120**, measured from the device's `recorded_at`. | S, M, W | `live` |
| GPS-3 | `GET /gps/history` is Admin-only, takes `user_id` and a date range, and the range may not exceed 366 days. | S | `history` |
| GPS-4 | A stale location is never presented as live. The web GIS screen polls every 15 seconds. The Call action appears for Admin only, because it needs the Admin-only users list. | W | `gis-live-tracking.js` |
| GPS-5 | Live Map on the phone broadcasts GPS only while the screen is open, at most once every 15 seconds. It refreshes nearby incidents every 30 seconds. A failed POST is saved to `gps_track_local` for later sync, so points are never dropped. Distance and bearing are straight-line (haversine) and labelled as such, not road distance. | M | `live-map.tsx`, `utils/geo.ts` |

## 12. Tanod SOS

| ID | Rule | By | Where |
|---|---|---|---|
| SOS-1 | Only a Tanod can raise an SOS. It needs `client_event_id` and latitude/longitude. `fallback_channel` is `app` or `sms`. An optional `dispatch_id` must be the caller's own active dispatch. Duplicates are detected by (user, `client_event_id`). | S | `TanodSosController::createItem` |
| SOS-2 | **SOS never depends on incident triage.** It creates no incident and doesn't need one. The SOS row and its notification are committed in one transaction. A missing transport never fails the request. | S | `createItem` |
| SOS-3 | **Recipients:** every Admin in the barangay, plus every Tanod whose latest status is `on_duty` or `responding`, excluding the Tanod who raised it. | S | `NotificationService::sosRecipients` |
| SOS-4 | SOS states are `active → acknowledged → resolved`. Acknowledge and resolve are Admin-only. Acknowledging an already-acknowledged SOS is fine. Anything on a resolved SOS gets 409. | S | `transition` |
| SOS-5 | Admin and PB can list SOS records. On the dashboard an SOS stays visible until it is resolved, above any map filter. | S, W | `index`, `dispatch-center.js`, `gis-live-tracking.js` |
| SOS-6 | **On the phone, SOS is held down for 2 seconds and then confirmed** before it is sent. | M | `home.tsx` |
| SOS-7 | **No position means no SOS.** If GPS fails, the SOS is not sent and the reason is shown. The app never makes up a coordinate. | M | `home.tsx` |
| SOS-8 | **Fallback order:** (1) send directly to the server. (2) On failure, queue it in `offline_queue_local`; it is **always** queued in this case. (3) Also try a native SMS from the phone's own SIM to the cached backup contact (`GET /tanod-sos/fallback-contact`, cached at login and Live Map). The badge reports what actually happened (sent, failed or no contact) and never claims more. | M, S | `home.tsx`, `sosSms.ts`, `sosFallbackContact.ts` |

## 13. Notifications and delivery

| ID | Rule | By | Where |
|---|---|---|---|
| NTF-1 | Notification types are `dispatch`, `sos`, `priority_alert` and `other`. Which linked records each type must have is enforced in PHP. | S | `NotificationService::assertEntityIntegrity` |
| NTF-2 | **Delivery order:** if the device has no FCM token, send SMS straight away. Otherwise try FCM; if it fails, retry once; if that fails too, send SMS. Each attempt is its own row per (target, channel, attempt number). An acknowledgement timeout alone does not trigger SMS. | S | `NotificationDispatcher` |
| NTF-3 | **Acknowledging is not the same as delivery.** `POST /notifications/:id/ack` is Tanod-only, repeatable, finds the caller's own target row, and never touches delivery records. | S | `NotificationsController::acknowledge` |
| NTF-4 | `GET /notifications` returns only the caller's own targets in their own barangay, with no narrative text. | S, W | `index`, `AppShell.js` |
| NTF-5 | Push and SMS text never contain narrative. Incident types are written in plain words in messages. | S | `NotificationDispatcher` |
| NTF-6 | **Critical alert overlay (mobile):** it shows only what the push itself carried, with no follow-up API call. If the acknowledge call fails, the alert is **not** hidden. After acknowledging in the app, the system heads-up notification is dismissed. | M | `criticalAlertStore.ts`, `CriticalAlertOverlay.tsx` |

## 14. Shifts, swap requests and fatigue

| ID | Rule | By | Where |
|---|---|---|---|
| SHF-1 | Creating and editing shifts is Admin-only. Create needs `user_id`, a `request_id` UUID, `start_at < end_at` and an optional `patrol_zone`. The assignee must be an active Tanod in the same barangay (422 otherwise). | S, W | `ShiftsController` |
| SHF-2 | **A Tanod cannot have overlapping shifts.** The check locks rows so two requests can't both pass it; an overlap gets 409. | S | `assertNoOverlap` |
| SHF-3 | Editing a shift is checked with a `version` number; a stale version gets 409 "changed by someone else". Setting `user_id: null` unassigns the shift. | S | `update` |
| SHF-4 | Tanods see only their own shifts. The list is sorted by `start_at` ascending. | S, M | `index`, `my-shifts.tsx` |
| SHF-5 | The web scheduler offers three presets: Morning 06–14, Afternoon 14–22 and Night 22–06. | W | `scheduler.js` |
| SWP-1 | Only a Tanod can create a swap request, and only for **their own** shift (403 otherwise). It needs a `client_request_id` UUID. `reason` (≤1,000) and `target_user_id` are optional. The mobile app always sends it **without** a target, so the desk picks a substitute. | S, M | `ShiftSwapRequestsController::create`, `my-shifts.tsx` |
| SWP-2 | Approving or denying is Admin-only. It uses a `version` check, and a request that was already decided gets 409. | S | `update` |
| SWP-3 | **Approval re-checks the facts.** The requester must still hold the shift (409 otherwise). A named target must be an eligible Tanod without an overlap. The shift is reassigned and fatigue is recalculated for both people. With no target, the shift is released as **unassigned**, and the dashboard shows it as needing Admin action. | S, W | `update`, `swap-requests.js` |
| FAT-1 | **Fatigue threshold: more than 56 scheduled hours in a rolling 7-day window** that ends at the triggering shift's `end_at`. Hours count by `start_at`. It is recalculated whenever a shift is created, edited or reassigned. | S | `FatigueCalculator` |
| FAT-2 | **A fatigue flag is never deleted or cleared** by a later recalculation. Only acknowledging it changes it, and acknowledgement keeps the record. Editing the same shift updates that shift's flag, while a different shift gets its own flag. | S | `FatigueCalculator`, `FatigueFlagsController` |
| FAT-3 | Admin can list and acknowledge flags. PB can only view them. | S, W | `FatigueFlagsController`, `fatigue-flags.js` |
| FAT-4 | The web colours flags by band: moderate 56–60 h, high 60–70 h, severe over 70 h. These bands are display-only. | W | `fatigue-flags.js` |

## 15. Users and devices

| ID | Rule | By | Where |
|---|---|---|---|
| USR-1 | Only an Admin can list and create users, and only in their own barangay. Roles that can be created are admin, secretary, tanod and punong_barangay; **lupon cannot be created**. Usernames must be unique (409). The password must meet AUTH-2. `contact_number` is at most 32. | S, W | `UsersController` |
| USR-2 | Anyone may edit their **own** `full_name`/`contact_number`. Editing another user is Admin-only and limited to status changes. | S | `update` |
| USR-3 | A status change must send **exactly one** of `is_active` or `is_suspended`. These are separate settings. A suspension reason is optional, up to 255 characters. | S | `updateOtherUserStatus` |
| USR-4 | **At least one active, non-suspended Admin must remain** in each barangay (409). | S | `updateOtherUserStatus` |
| DEV-1 | Only a Tanod can register a device. `device_id` must be 8–64 characters of `[A-Za-z0-9._:-]`. The app generates it once as `and-<uuidv4>` and keeps it for the life of the install. `platform` must be `android`. `app_version` is at most 64. `fcm_token` is optional; an empty one means "use SMS". | S, M | `DevicesController::register`, `deviceIdentity.ts` |
| DEV-2 | Registering a device turns off the Tanod's **other** active devices. Registering the same device again just refreshes it, and never overwrites a real FCM token with an empty one. A `device_id` that belongs to a different user gets 409. | S | `register` |
| DEV-3 | The SMS encryption key is created and returned **only once**, on the device's first-ever registration. It is stored encrypted on the server and never sent again. The FCM token is never echoed back. | S, M | `register`, `login.tsx` |
| DEV-4 | A Tanod can deactivate their own device, and repeating it is fine. An unknown device or someone else's device gets 404. | S | `deactivate` |
| DEV-5 | Every mobile write requires the device to be registered, **owned by the caller and active**. Otherwise it gets 422. | S | `assertDeviceOwnership`, `SyncController` |

## 16. Offline map packages

| ID | Rule | By | Where |
|---|---|---|---|
| MAP-1 | Uploading is Admin-only, for their own barangay. `version` is 1–64 characters of `[A-Za-z0-9._-]` and must be unique per barangay (409). The file must be 500 MB or less, and must be a valid MBTiles SQLite file with `tiles` and `metadata` tables. | S, W | `MapPackagesController::create`, `map-packages.js` |
| MAP-2 | **Exactly one package is published per barangay.** Publishing a new one unpublishes the previous one in the same transaction. | S | `create` |
| MAP-3 | Package metadata can be read by Admin or Tanod. Downloading is Tanod-only, own barangay. No published package gives 404, which is treated as a normal empty state. | S, W | `show`, `download` |
| MAP-4 | The phone **checks the SHA-256 before switching to a package.** A download never blocks login or Home. If the download fails, the phone keeps the package it already has. With no package installed it falls back to online OSM tiles. | M | `mapPackageService.ts`, `LiveMapCanvas.tsx` |

## 17. SMS

| ID | Rule | By | Where |
|---|---|---|---|
| SMS-1 | Every `/sms/*` endpoint is **Admin-only** and limited to the caller's barangay. The log date range may not exceed 366 days. | S, W | `SmsController`, `sms-monitor.js` |
| SMS-2 | **Manual send** needs an `Idempotency-Key`, a message of at most 918 characters, and **exactly one** of `recipient_user_id` or `phone_number`. For a user, the number is looked up on the server. A raw phone number is accepted **only if it is already on record in this barangay** (from a citizen report or earlier SMS traffic), so the system can't be used to text arbitrary numbers. | S | `send` |
| SMS-3 | **Broadcast** needs an `Idempotency-Key` that covers the whole broadcast, and a message of at most 918 characters. `scope` is `on_duty_tanods`, `role` (with a `role`) or `subscribers`. Recipients are always worked out on the server within the caller's barangay. Opted-out subscribers are excluded. | S, W | `broadcast` |
| SMS-4 | **Subscribers need recorded consent.** `consent_source` is `walk_in`, `staff_entry` or `sms_keyword`, and a consent note is optional (≤255). A number can be subscribed only once (409). Removing someone sets `opted_out_at` rather than deleting the row. | S | `addSubscriber`, `optOutSubscriber` |
| SMS-5 | Resolving a conversation marks its unread inbound messages as read. | S | `resolveConversation` |
| SMS-6 | **Incoming encrypted SMS (GSM fallback):** the sender is identified by the registered device, and any user ID inside the payload is ignored. Each message must be valid, fresh (lifetime ≤30 minutes, ±5 minutes clock skew), not a replay, and genuinely from that device. Every rejection looks the same from outside. The message is replayed through the **same** code the app uses (incident, GPS, duty, SOS), so offline SMS and online app results are identical. | S | `SmsGatewayService`, `/internal/sms/*` (loopback + token only) |
| SMS-7 | Without Semaphore credentials, an outbound SMS is still logged, marked `failed / SEMAPHORE_NOT_CONFIGURED`, and never claimed as sent. | S | `SmsGatewayService` |
| SMS-8 | The compose box counts SMS segments (160 characters for a single message). The live feed polls every 10 seconds. | W | `sms-monitor.js` |

## 18. System settings

| ID | Rule | By | Where |
|---|---|---|---|
| SET-1 | System settings are Admin-only, and only these keys exist: `general.system_name` (≤100), `general.municipality` (≤100), `general.region` (≤100), `sms_gateway.sender_name` (≤32), `sms_gateway.api_key` (≤255, secret) and `sos_fallback.backup_contact_number` (≤32). Any other key is a 400. | S, W | `SettingsController` |
| SET-2 | Secrets are masked (`••••••••`) when read. JWT, device-master, internal-token and FCM credentials **never** move into settings; they stay in `.env`. | S | `SettingsController` |
| SET-3 | Only the SOS backup contact number is exposed to Tanods, through `GET /tanod-sos/fallback-contact`. | S | `TanodSosController::fallbackContact` |
| SET-4 | Admin, Secretary and PB all get the web Settings screen for their account (password, theme, default landing page). Only Admin sees the system-configuration sections. | W | `settings.js`, `main.js` |

## 19. Reports, analytics, audit log, search, service health

| ID | Rule | By | Where |
|---|---|---|---|
| RPT-1 | Summary, heatmap and export are for Admin and PB, own barangay, with date ranges of at most 366 days. | S, W | `ReportsController` |
| RPT-2 | **Response time** is measured per incident as `incident.created_at → MIN(dispatch.arrived_at)`, counting each incident once even when it had several responders. | S | `ReportsController` |
| RPT-3 | Export is CSV or PDF, is audited, and is served through an authorised download route. | S | `export`, `exportDownload` |
| RPT-4 | The heatmap covers the past only, over a bounded range, and says clearly that it does not predict anything. | W | `historical-heatmap.js` |
| RPT-5 | Statistical Reports load only when the user presses **Generate** for a chosen range; nothing loads automatically. | W | `statistical-reports.js` |
| RPT-6 | The dashboard compares KPIs with the previous period of the same length. If that comparison fails, the main dashboard still loads. Charts treat `null` as a real gap, not zero. The escalation line for the oldest urgent pending incident changes after **15 minutes**, which is a display threshold and not an SLA. | W | `admin-dashboard.js`, `LineChart.js` |
| RPT-7 | Nav badge counts are Admin-only and poll every 60 seconds. | S, W | `navCounts`, `AppShell.js` |
| AUD-1 | The audit log is Admin-only, defaults to the last 7 days on the server, is paginated and has **no edit or delete controls**. | S, W | `AuditLogController`, `audit-log.js` |
| SRC-1 | Global search is open to all roles. The query must be 2–64 characters, returns at most 10 results, and follows each role's normal visibility rules. | S, W | `SearchController`, `AppShell.js` |
| HLT-1 | Service health is Admin-only. Each check reports `healthy`, `unhealthy` (configured but failing) or `not_configured` (neutral, not a fault, never shown green). The screen refreshes every 30 seconds. Status changes are logged to `health_check_log`. | S, W | `SystemHealthController`, `service-health.js` |

## 20. Data retention

These periods are fixed in code and changing them needs an architecture
review. The retention job runs from the command line only, with
`--dry-run` recommended first.

| Record | Retention |
|---|---|
| `raw_narrative` after an approved redaction | purged 30 days after approval |
| `raw_narrative` with no approval | purged 90 days after `created_at` |
| Incident / blotter / evidence records | 7 years (2557 days) |
| Unconverted citizen reports | 365 days |
| SMS log | 365 days |
| AI processing log | 365 days, or as long as the incident is kept if that is longer |
| AI Tools jobs (no incident) | 90 days |
| Audit log | 7 years (2557 days) |
| Deactivated devices (scrubbed) | 90 days |
| On-device synced evidence files (mobile, manual prune) | 30 days after sync |

Anything on **legal hold** (`incident`, `evidence_attachment`,
`citizen_report`, `sms_log`) is skipped by retention. Deleting an
incident removes its dependent rows in a fixed order, because the foreign
keys are `ON DELETE RESTRICT`.
(`RetentionService::purgeOneIncident`)

## 21. Mobile app–only rules

| ID | Rule | Where |
|---|---|---|
| MOB-1 | **Offline capture is durable.** An incident is written to encrypted SQLite (SQLCipher) *before* the user can leave the form. The Save button stays busy until the commit finishes. The form needs a non-blank narrative. | `new-incident.tsx`, `incidentRepository.ts` |
| MOB-2 | The `client_event_id` is created **when the record is first saved** and reused on every transport and retry (direct POST, sync batch, SMS). It is never regenerated. | `incidentRepository.ts` |
| MOB-3 | Capture never checks the auth session. An expired session never blocks saving an incident. | `incidentRepository.ts`, `session.ts` |
| MOB-4 | **Never claim a sync that hasn't happened.** The shown state comes from the saved row: `Saved locally`, `Queued`, `Synced`, `Duplicate reconciled` or `Needs attention`. | `incident-submitted.tsx`, `deriveSyncState` |
| MOB-5 | **Sync runs** when the network reconnects, when the app comes to the foreground, and **every 60 seconds only while on duty**. A lock stops two syncs running at once. Items are sent oldest first, in the order incidents → GPS → duty → dispatch status → SOS. | `syncScheduler.ts`, `syncService.ts`, `SyncController` |
| MOB-6 | A dispatch status change is applied locally straight away, then sent with PATCH. If that fails, **the same event ID** is queued for the sync batch. The app never skips a status step. | `assignment-detail.tsx` |
| MOB-7 | Assignments are read from the cache first. A cached copy is considered fresh for 10 minutes, and the screen shows a stale/cached indicator. The screen never goes blank while offline. | `assignments.tsx`, `dispatchRepository.ts` |
| MOB-8 | **Navigation:** off-route means more than 50 m from the route line. Arrival means within 30 m of the destination, which vibrates the phone and suggests "Mark Arrived" (it does not change the status by itself). A route that isn't live is labelled cached, stale or unavailable. | `routeProgress.ts`, `assignment-detail.tsx` |
| MOB-9 | The external navigation app is opt-in only. Navigation stays inside Baranguard's own map by default. | `assignment-detail.tsx` |
| MOB-10 | **Encryption at rest:** the SQLCipher passphrase is random, created on the device, and stored in the Android Keystore. It is never derived from the password or fetched from the server. Capacitor bridge logging is off (`loggingBehavior: 'none'`), so rows and secrets never reach logcat. | `db/passphrase.ts`, `capacitor.config.ts` |
| MOB-11 | My Reports reads only the local store and shows exactly what the device knows. It does not guess the server's case status. | `my-reports.tsx` |
| MOB-12 | The API base URL can be changed from Profile or the Login server-URL dialog, which warns "only change if told to by an administrator". The default is `http://localhost:8081/api/v1`, and requests time out after 15 seconds. | `apiService.ts`, `profile.tsx`, `login.tsx` |
| MOB-13 | Home's greeting and figures come only from the real session and real queries; no placeholder identity or numbers. | `home.tsx` |
| MOB-14 | Duty and patrol tracking are shown on screen whenever they are running. There is no hidden background location tracking. | `home.tsx`, `patrolLocationService.ts` |

## 22. Web dashboard–only rules

| ID | Rule | Where |
|---|---|---|
| WEB-1 | **The router gates pages by role** (`PAGE_ROLES`). If a page is outside the role, the user lands on the first page they're allowed. A saved "default landing page" is used only when that role may see it. Detail pages (`ai-review`, `blotter-detail`) with no ID fall back to the landing page. | `main.js` |
| WEB-2 | Sidebar items are filtered by the same role lists. Count badges are Admin-only. | `AppShell.js` |
| WEB-3 | **Every data screen has four states:** Loading, Empty, Error with Retry, and Populated. | all pages |
| WEB-4 | **Polling:** Dispatch Center and GIS every 15 s, SMS live feed every 10 s, Service Health every 30 s, nav counts every 60 s, AI jobs every 3 s. Each timer stops when the user leaves the page, via the page's `stop()`. | `main.js` + pages |
| WEB-5 | The Dispatch Center is Admin-only; PB has no view of it. Critical styling follows the incident/dispatch state and disappears once the item is dispatched or resolved. | `dispatch-center.js` |
| WEB-6 | Incident Management offers Create to Admin and Secretary. Narrative is never editable in its Edit form. The complainant-name field is disabled for non-Secretaries. The officer contact number is shown to Admin only. | `incident-management.js` |
| WEB-7 | The dashboard's named "Tanods On Duty" roster is Admin-only, because `GET /users` is Admin-only. PB sees the on-duty count plus a note, and the page never makes the call that would return 403. | `admin-dashboard.js` |
| WEB-8 | The public citizen report form opens at `#/citizen-report` with no session and no app shell. | `main.js`, `citizen-report.js` |
| WEB-9 | The map packages screen shows only the Admin's own barangay. It has no download option. | `map-packages.js` |
| WEB-10 | Login has no "forgot password" link, because it would lead nowhere. | `login.js` |
| WEB-11 | Colour tokens only, and dark mode has to pass contrast: `-solid` tokens for white-on-fill and `-text` tokens for coloured text. | `base.css` |

---

## 23. Gaps and inconsistencies found while compiling

These were found while reading the code for this catalogue. Nothing was
changed. Each one needs a decision before it counts as a bug.

1. **`GET /blotter` is still open to PB on the server.**
   `REFERENCE.md` §3 says PB has "no blotter LIST", and the web screen
   was removed, but `BlotterController::index` still allows
   `['admin','secretary','punong_barangay']`. Only the screen is gone,
   not the permission.
2. **A Tanod on an active dispatch can still be sent to another
   incident.** The mobile duty toggle only ever sends `on_duty` or
   `off_duty`; the app never sets `responding` (grep `'responding'` in
   `mobile/src` finds only the type). Taking a dispatch doesn't change
   duty status either. So DSP-3's "`responding` is not eligible" never
   applies in practice. DSP-4's duplicate check only covers the *same*
   incident. The result: a Tanod who is en route to incident A still
   shows as eligible for incident B.
3. **`blotter-detail.js` makes up a case number.** When neither
   `blotter.displayId` nor `incident.displayId` exists, it builds
   `` `BLT-2026-${incidentId}` ``. The year 2026 is hardcoded and the
   sequence is not the real one. That goes against §2 Rule 6 (no
   fabricated identifiers).
4. **`assignment-detail.tsx`'s header comment is out of date.** It says
   "Get Route" is an explicit tap and never runs on mount. The code
   (the `autoFetchedRef` effect) fetches a route automatically once, as
   soon as a GPS fix and a server dispatch ID exist.
5. **`smsFallbackState.ts`'s header comment is out of date.** It says
   phone-side SMS sending "is NOT built" and only
   `saved_locally_for_retry` can occur. `sosSms.ts`/`SosSmsPlugin.java`
   now exist and `home.tsx` calls them (the G1 third tier).
6. **`PublicReportsController`'s reason for leaving out response time is
   out of date.** It says the metric double-counts because F8 "is still
   open". `REFERENCE.md` §5 says F8 was fixed (per-incident
   `MIN(arrived_at)`). Leaving the figure out may still be the right
   call for privacy, but the stated reason no longer holds.
7. **Nothing calls `GET /public/transparency`.** No page in `web/src`
   uses it, so the "public half" it was built for isn't reachable from
   the dashboard.
8. **The mobile app doesn't stop non-Tanod accounts at login.** An
   Admin or Secretary can sign in on the phone, gets a *web* session
   (AUTH-6), and then every Tanod-only call returns 403. This is safe,
   because the server enforces roles, but the user gets no clear message
   explaining why nothing works.
9. **The route count has drifted.** `REFERENCE.md` §5 says "84 live
   `/api/v1` routes". `backend/routes/*.php` now declares 90, including
   `/public/transparency`, the SMS subscriber routes and
   `/tanod-sos/fallback-contact`.
10. **`apiClient.js`'s own fallback base URL is
    `http://127.0.0.1:8080/api/v1`.** `index.html` always sets
    `window.BARANGUARD_API_BASE_URL` (default `localhost:8081`) first,
    so the fallback is never used. It is still misleading next to
    `REFERENCE.md` §1.
