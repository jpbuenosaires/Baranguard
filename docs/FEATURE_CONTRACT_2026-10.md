# Feature contract — tanod workflow build (2026-10-01)

Single source of truth for every agent building the plan in
`docs/FEATURE_PLAN_2026-10.md`. **Never invent a field, route, enum value or
state transition that is not here; if something is missing, stop and report it.**
Authority order: this file > FEATURE_PLAN > REFERENCE.md for these features only.
Project rules in `docs/REFERENCE.md` §2 still apply (tenant 404 never 403,
idempotency, audit metadata = ids/statuses only, new numbered migrations only,
UTC storage / Asia/Manila display with day-bucketing in PHP at +08:00 never
CONVERT_TZ, never interpolate server data into innerHTML, no controls that do
nothing, all four UI states).

Already done in Stage 0 (do NOT redo or edit): `backend/lib/ApprovalAuthority.php`,
and `SyncController.php` (four new groups wired, see §6).

## 1. Ownership (no two agents edit the same file)

| Agent | Owns |
|---|---|
| B1 referral | migration 0032; `ReferralsController.php`; `routes/referrals.php`; `verify-referrals.sh` |
| B2 roster/accomplishment | migrations 0030, 0031; `AvailabilityController.php`, `AccomplishmentController.php`; edits to `ShiftsController.php`, `UsersController.php`, `services/scheduling/*`; `routes/availability.php`, `routes/accomplishment.php`, `routes/shifts.php`, `routes/users.php` edits; `verify-roster-accomplishment.sh` |
| B3 school zones | migration 0033; `SchoolsController.php`, `SchoolCheckinsController.php`, `SszTermReportsController.php`; edits to `IncidentsController.php` and `ReportsController.php`; `routes/schools.php`, `routes/ssz.php`, `routes/reports.php`/`incidents.php` edits; `verify-school-zones.sh` |
| M mobile | everything under `mobile/src`, `mobile/scripts` |
| W1 web pages | NEW page files under `web/src/pages` + their CSS + `web/src/services` additions (apiClient functions go in a NEW file `web/src/services/tanodWorkflowApi.js`, not apiClient.js) |
| W2 web shell | `AppShell.js` nav, `main.js` routes/`PAGE_ROLES`, `personnel.js`, `admin-dashboard.js`, `user-management.js`, `incident-detail.js`, `incident-management.js`, `dispatch*.js`, `statistical-reports.js`, `web/tests` harness fixtures, `web/scripts/verify-web-wiring.mjs` |

Migration numbers are fixed: 0030 (B2), 0031 (B2), 0032 (B1), 0033 (B3). Each
migration needs a `.down.sql`, `SET NAMES utf8mb4;`, `IF NOT EXISTS` guards,
`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, DATETIME in
UTC, FKs `ON DELETE RESTRICT`. Do not apply to any real database.

## 2. Approval authority (migration 0030)

`user` gains:
- `official_title VARCHAR(64) NULL` — printed under a signature, e.g. "Chief Tanod", "Kagawad".
- `approval_authority SET('note_report','approve_report','approve_roster','prepare_annex_d','approve_annex_d') NOT NULL DEFAULT ''`.

Only roles admin / secretary / punong_barangay may hold authorities
(`ApprovalAuthority::ELIGIBLE_ROLES`). A Kagawad uses an account with role
`secretary` plus authorities; **open decision logged for the user: there is no
Kagawad role.** Backfill: `punong_barangay` users -> official_title 'Punong
Barangay', authority `note_report,approve_report,approve_roster,approve_annex_d`;
`admin` users -> official_title 'Chief Tanod', authority `note_report,prepare_annex_d`.

`PATCH /users/:id` (Admin only, existing Idempotency-Key rule) additionally
accepts `official_title` (string<=64|null) and `approval_authority` (array of
the five values; invalid -> 400; target role must be eligible else 400). `GET
/users` and `/users/:id` return both (`approval_authority` as an array). Audit
action `user_approval_authority_changed`, metadata `{target_user_id, count,
approval_authority}` (the new list; closed enum values only, Rule 8 safe) plus
`idempotency_key` when sent.

**Segregation of duties (fix review 2026-10-01):** an actor may NOT change their
OWN approving authorities (`approve_roster`, `approve_report`, `approve_annex_d`):
a PATCH whose target is the caller and whose `approval_authority` would add or
remove any of those three is `403 FORBIDDEN` ("ask another administrator"). The
caller's own `official_title`, `note_report` and `prepare_annex_d` stay editable,
as does re-submitting an unchanged list.

## 3. Roster (migration 0030, B2)

`tanod_availability`: `avail_id` PK, `barangay_id`, `user_id`, `period_start`
DATE, `period_end` DATE, `windows_json` JSON/TEXT (array of
`{date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM'}`, Manila local; max 62 entries,
each inside the period, end>start), `status ENUM('submitted','accepted','revised')`
DEFAULT 'submitted', `reviewed_by` NULL, `reviewed_at` NULL, `review_note
VARCHAR(255) NULL`, `version INT DEFAULT 1`, `client_event_id CHAR(36)`,
`created_at`, `updated_at`. UNIQUE(user_id, client_event_id); UNIQUE(user_id,
period_start, period_end).

`shift_schedule` gains: `approval_status ENUM('draft','published') NOT NULL
DEFAULT 'draft'` (**existing rows backfilled to 'published'**),
`source_availability_id BIGINT UNSIGNED NULL` (FK RESTRICT), `approved_by
BIGINT UNSIGNED NULL`, `approved_at DATETIME NULL`.

Endpoints:
- `POST /availability` — tanod; body `{period_start, period_end, windows[], client_event_id}` + `X-Device-Id` (+signature as other tanod writes). Same user+period while `submitted` -> updates windows, version+1 (idempotent by client_event_id); if status accepted -> 409. Returns the row.
- `GET /availability?status=&user_id=&period_start=` — tanod: own only; admin/secretary/punong_barangay: own barangay. Cross-tenant/other-user -> 404 on by-id.
- `PATCH /availability/:id` — role admin or secretary; body `{status:'accepted'|'revised', review_note?}`; Idempotency-Key.
- `POST /shifts` (existing, admin) — new optional `source_availability_id`; new shifts are `draft`. Rest/coverage rules change as in §8.
- `GET /shifts` — tanod sees ONLY `published` own shifts; others see all and may filter `approval_status`. Response rows include `approval_status`, `approved_by`, `approved_at`, `source_availability_id`.
- `POST /shifts/publish` — `ApprovalAuthority::require(APPROVE_ROSTER)`; body `{shift_ids:[int] (1..100)}`; Idempotency-Key; response `{published:[ids], already_published:[ids], warnings:[{code:'NO_COVERAGE', date:'YYYY-MM-DD'}]}`. Tenant mismatch ids -> 404 for the whole call. Notify affected tanods via the existing notification infrastructure only if a suitable type already exists, otherwise skip (do not invent a notification type). Audit `roster_published`, metadata `{count}`.
- Swap-request endpoints unchanged, except (fix review 2026-10-01): `POST /shift-swap-requests` on a DRAFT shift is `404` (a Tanod cannot see drafts), and any change to a PUBLISHED shift's `user_id`, `start_at` or `end_at` (`PATCH /shifts/:id`, or an approved swap) reverts it to `draft` and clears `approved_by`/`approved_at` (a fresh `approve_roster` publish is needed; audit metadata gets `approval_reset`). A `patrol_zone`-only edit keeps it published. Writes for one Tanod are serialized (user-row lock) so the 12h/day cap cannot be raced.

## 4. Accomplishment report (migration 0031, B2)

`accomplishment_report`: `report_id`, `barangay_id`, `user_id`, `month CHAR(7)`
('YYYY-MM'), `status ENUM('open','prepared','noted','approved','returned')`
DEFAULT 'open', `prepared_at`, `noted_by`,`noted_at`, `approved_by`,`approved_at`,
`return_reason VARCHAR(255) NULL`, `total_minutes_confirmed INT NULL`, `version`,
`created_at`,`updated_at`. UNIQUE(user_id, month).

`accomplishment_entry`: `entry_id`, `report_id` FK, `barangay_id`, `user_id`,
`work_date DATE`, `accomplishment_text TEXT NOT NULL` (<=2000), `start_time
TIME NULL`, `end_time TIME NULL`, `duration_minutes INT NOT NULL` (the tanod's
CONFIRMED duration, 1..1440), `suggested_duration_minutes INT NULL` (server sum
of the tanod's on_duty intervals for that Manila day, computed from existing
`duty_status` rows at write time), `duration_flag TINYINT(1)` = 1 when
`abs(duration_minutes - suggested) > 30` (constant `DURATION_FLAG_MARGIN_MINUTES`),
`client_event_id CHAR(36)`, timestamps. UNIQUE(user_id, client_event_id).
One entry per (user, work_date) is NOT enforced (several entries per day allowed).

Endpoints (all barangay-scoped; tanod only touches own rows; others 404):
- `POST /accomplishment-entries` — tanod; `{work_date, accomplishment_text, start_time?, end_time?, duration_minutes, client_event_id}`; `work_date` not in the future (Manila) and within 62 days back; creates the month's report row if missing; 409 if the report is not `open`/`returned`. `createEntryItem` for sync. A retried `client_event_id` returns the stored entry BEFORE any validation or report-state check (a late retry is never a 400/409).
- `PATCH /accomplishment-entries/:id` — tanod own, only while report open/returned.
- `GET /accomplishment-reports?month=&user_id=&status=` — tanod own; admin/secretary/punong_barangay barangay-wide. Rows include entries aggregated counts and `total_minutes`, `flagged_entries`.
- `GET /accomplishment-reports/:id` — full report with entries (text included for approvers only; audit-log reads NOT recorded as content).
- `POST /accomplishment-reports/:id/submit` — tanod own; open|returned -> prepared; needs >=1 entry; **online-only action** (not a sync kind).
- `POST /accomplishment-reports/:id/note` — `require(NOTE_REPORT)`; prepared -> noted; `assertNotPreparer`.
- `POST /accomplishment-reports/:id/approve` — `require(APPROVE_REPORT)`; noted -> approved; `assertNotPreparer`; the noter MAY also approve if they hold both authorities (user decision: officials are few) but never the preparer.
- `POST /accomplishment-reports/:id/return` — NOTE or APPROVE authority; body `{reason}` (1..255); prepared|noted -> returned (entries editable again).
Web actions need Idempotency-Key; replay returns the original outcome. Illegal transition -> 409. Audit actions `accomplishment_report_submitted|noted|approved|returned`, metadata `{report_id, month, status}` only — never text, minutes of a person, or names.

## 5. Referral (migration 0032, B1)

`incident_referral`: `referral_id`, `incident_id` FK, `barangay_id`, `referred_to ENUM('pnp','bfp','ambulance_ems','barangay_official','vaw_desk','social_welfare','higher_lgu','doh','dpwh','other')`, `other_text VARCHAR(100) NULL` (required when `other`; for others optional free label), `contact_name VARCHAR(100) NULL` (responder/unit/official, NEVER a citizen), `referred_at DATETIME NOT NULL`, `reference_no VARCHAR(64) NULL`, `created_by`, `client_event_id CHAR(36) NULL`, `created_at`. UNIQUE(created_by, client_event_id). Multiple referrals per incident allowed.

- `POST /incidents/:id/referrals` — roles tanod (own: incident reported by them or they hold an active/any dispatch on it), admin, secretary; body `{referred_to, other_text?, contact_name?, referred_at?, reference_no?, client_event_id}` (web: Idempotency-Key header instead). Tenant mismatch -> 404. Does NOT change dispatch/incident status. `createItem($pdo,$identity,$deviceId,$item)` for sync; sync item may carry `incident_client_event_id` instead of `incident_id` (resolved via incident.device_id + client_event_id of the same device).
- `GET /incidents/:id/referrals` — tanod (own scope), admin, secretary, punong_barangay.
- `GET /referrals?from=&to=&referred_to=&page=&limit=` — admin, secretary, punong_barangay; rows `{referral_id, incident_id, display_id, incident_type, referred_to, other_text, referred_at, reference_no}` ONLY — no narrative, names, contacts, coordinates (keeps this a delegation log, not a case registry).
- Audit `incident_referral_created`, metadata `{incident_id, referred_to}`.

## 6. Sync batch (done in Stage 0)

Fix review 2026-10-01: each new `createItem`/`createEntryItem` runs `DeviceSignature::verifyOrReject` PER ITEM (a keyed device must have signed the batch request; a failure is that item's `failed`, reason `Device signature verification failed.`). SOS items are never signature-rejected. SQLSTATE 23000 is reported `duplicate` only when the original row is found; otherwise the item is `failed` with a generic reason.

`POST /sync/batch` body additionally accepts `referrals[]`, `availability[]`,
`accomplishment_entries[]`, `school_checkins[]`; each item = that feature's POST
body. Order: sos, incident, referral, gps, duty_status, dispatch_status,
availability, accomplishment_entry, school_checkin. Each controller exposes
`public static function createItem|createEntryItem(PDO $pdo, array $identity, string $deviceId, array $item): array{id:int,wasCreated:bool}`
(`AccomplishmentController::createEntryItem`; the others `createItem`). Throw `ApiError` for validation; a unique-key race is handled by SyncController. `findExistingServerId` already maps: `incident_referral(referral_id, created_by, client_event_id)`, `tanod_availability(avail_id, user_id, client_event_id)`, `accomplishment_entry(entry_id, user_id, client_event_id)`, `school_checkin(checkin_id, user_id, client_event_id)` — column names above are therefore FIXED.

## 7. School zones (migration 0033, B3)

`school`: `school_id`, `barangay_id`, `name VARCHAR(160)`, `school_type ENUM('public','private')`, `level ENUM('preschool_daycare_eccd','primary_elementary','secondary_high_school','integrated','higher_education_tertiary','all_through','tvet','sned')`, `address VARCHAR(255)`, `focal_person VARCHAR(120) NULL`, `focal_contact VARCHAR(32) NULL`, `remarks VARCHAR(500) NULL`, `latitude/longitude DECIMAL(10,7) NULL`, `is_active TINYINT(1) DEFAULT 1`, timestamps, `client_request_id CHAR(36) NULL UNIQUE`. No student data of any kind.

`school_checkin`: `checkin_id`, `school_id` FK, `barangay_id`, `user_id`, `checked_in_at DATETIME`, `checked_out_at DATETIME NULL`, `client_event_id CHAR(36)`, `created_at`. UNIQUE(user_id, client_event_id). No coordinates stored. Closing a check-in (the only allowed mutation): (a) if the check-in has NOT synced yet, mobile merges `checked_out_at` into the single create item; (b) if it already synced, mobile sends a NEW sync item `{client_event_id:<new uuid>, closes_client_event_id:<the check-in's client_event_id>, checked_out_at}` (no school_id/checked_in_at needed). Re-sending the SAME client_event_id does NOT work through /sync/batch (the offline_queue ledger answers 'duplicate' first); it only works on direct `POST /school-checkins`.

`incident` gains nullable: `school_id` (FK RESTRICT), `c1_summary VARCHAR(500) NULL` (short factual, **non-identifying** Annex C-1 narrative — separate from `raw_narrative`; never include victim/student names), `c1_action_taken VARCHAR(500) NULL`, `c1_status_notes VARCHAR(500) NULL`. These are accepted by the mobile incident create body / sync item, and by `PATCH /incidents/:id` (admin+secretary), and returned by incident list/show (secretary rule for raw_narrative unchanged). Validate school_id belongs to the caller's barangay (else 400 on the web create/PATCH). On the MOBILE create path (direct and sync) an unusable `school_id` is stored as NULL instead of failing the whole offline incident (Rule 7).

`ssz_term_report`: `report_id`, `barangay_id`, `term_label VARCHAR(40)` (e.g. 'Term 1 S.Y. 2026-2027'), `term_start DATE`, `term_end DATE`, `status ENUM('draft','prepared','approved','submitted')`, `total_tanods`, `total_schools`, `total_deployment_days`, `total_incidents`, `incidents_barangay_only`, `incidents_pnp`, `incidents_bfp`, `incidents_higher_lgu`, `incidents_doh`, `incidents_dpwh`, `incidents_other_agencies` (all INT), `other_institutions VARCHAR(500) NULL`, `remarks VARCHAR(1000) NULL`, `prepared_by`,`prepared_at`, `approved_by`,`approved_at`, `mayor_office_received_by VARCHAR(120) NULL`, `mayor_office_received_at DATE NULL`, `dilg_received_by VARCHAR(120) NULL`, `dilg_date_received DATE NULL`, `version`, timestamps, `client_request_id CHAR(36) NULL UNIQUE`.

Endpoints:
- `GET /schools` (all roles incl. tanod, own barangay, `?active=`), `POST /schools`, `PATCH /schools/:id` — admin+secretary; Idempotency-Key; deactivate by `is_active=false`, no DELETE.
- `POST /school-checkins` — tanod; `{school_id, checked_in_at, checked_out_at?, client_event_id}`; `createItem` for sync. Timestamps must be strict ISO-8601 with `Z` or an offset; `checked_in_at` at most 5 min in the future and at most 62 days back; `checked_out_at` not before, and at most 24h after, `checked_in_at` (else 400). The direct POST also runs the H-09 device-signature check after the ownership check. `GET /school-checkins?from=&to=&school_id=` admin/secretary/punong_barangay (aggregate-friendly rows `{checkin_id, school_id, user_id, checked_in_at, checked_out_at}`).
- `GET /reports/school-term?term_start=&term_end=` — admin, secretary, punong_barangay; live computed object with the same fields as the snapshot (below), no persistence.
- `POST /ssz-term-reports` (create draft + snapshot of computed counts; admin|secretary; body `{term_label, term_start, term_end, remarks?}`), `GET /ssz-term-reports`, `GET /ssz-term-reports/:id`, `PATCH /ssz-term-reports/:id` (remarks/other_institutions only while draft), `POST /:id/prepare` (`require(PREPARE_ANNEX_D)`, recompute snapshot, draft->prepared), `POST /:id/approve` (`require(APPROVE_ANNEX_D)`, `assertNotPreparer`, prepared->approved), `POST /:id/mark-submitted` (admin|secretary; body `{mayor_office_received_by, mayor_office_received_at, dilg_received_by?, dilg_date_received?}`; approved->submitted). Illegal transition 409. Idempotency-Key on writes. Audit `ssz_term_report_*`, metadata `{report_id, status}`. A term spans at most 366 days (400), for create, prepare and `GET /reports/school-term`. Report objects also carry `prepared_by_name`, `prepared_by_title`, `approved_by_name`, `approved_by_title` (joined server-side from `user.full_name`/`official_title`) for the signature page.

Annex D computation (range in Manila dates, bucketed in PHP):
- `total_tanods` = active users with role tanod in the barangay.
- `total_schools` = active schools.
- `total_deployment_days` = COUNT DISTINCT Manila date of `school_checkin.checked_in_at` in range.
- `total_incidents` = incidents with `school_id` NOT NULL and created in range.
- Referral columns count INCIDENTS having >=1 referral mapping to that column (so columns may sum to more than total): pnp->pnp; bfp->bfp; higher_lgu and social_welfare->higher_lgu; doh->doh; dpwh->dpwh; ambulance_ems and other->other_agencies by default (system_settings key `annex_d.ambulance_ems_maps_to` = 'other'|'doh', default 'other', Admin-editable via the existing settings endpoint pattern only if trivial, otherwise default constant). `barangay_official` and `vaw_desk` count as barangay-level, not external.
- `incidents_barangay_only` = school incidents with NO external referral (any of pnp,bfp,ambulance_ems,social_welfare,higher_lgu,doh,dpwh,other).
- `other_institutions` = distinct `other_text` of referrals on school incidents (plus 'Ambulance/EMS' when mapped to other), joined by '; ', <=500 chars.

## 8. Rule changes to existing roster guards (B2)

Remove `MIN_REST_HOURS` hard block (`assertMinRest`) and the min-coverage hard
block (`assertMinCoverage`). Replace with: constant `MAX_DAILY_SCHEDULED_HOURS = 12`
per tanod per Manila day (hard 422 `DAILY_HOURS_EXCEEDED`), and coverage becomes
a `warnings[]` item on publish (§3). Keep `assertNoOverlap`. Update the existing
suites that assert the old rules (`verify-scheduler-fatigue.sh`,
`verify-sprint7-audit.sh`, others you find by grep) to the new documented
behaviour, listing every changed assertion. Fatigue endpoints stay untouched;
only the web nav item goes.

## 9. Mobile (agent M)

New local tables (bump schema version, add a NEW migration step, update
`scripts/verify-local-schema.mjs`): `availability_local`, `accomplishment_entry_local`,
`referral_local`, `school_checkin_local` (each with `client_event_id TEXT UNIQUE`,
`synced`, `sync_attempts`, `permanent_failure` like the existing pattern) and
`school_local` (read-only cache of `GET /schools`). Writes persist to encrypted
SQLite before the screen closes (Rule 7); sync kinds added to `syncService.ts`
chunking after `sos`/dispatch: referrals, availability, accomplishment_entries,
school_checkins (request keys `referrals`, `availability`, `accomplishment_entries`,
`school_checkins`). Screens: availability (new page), accomplishments (list, add
entry with confirmed duration and the server-suggested value shown when online,
submit month — submit is online-only), "Refer" action sheet in
`assignment-detail.tsx` and on the submitted-incident view, school check-in/out
(Home card or new page) and C-1 fields (school picker + c1_* inputs) in
`new-incident.tsx`, `my-shifts.tsx` showing approved shifts only plus an
"Availability" entry point. Reuse the existing design tokens/components. Do not
build an APK. Not device-verifiable: say so.

## 10. Web (agents W1 + W2)

New nav (roles in brackets) — W2 wires nav/routes/PAGE_ROLES, W1 builds pages:
- `approvals` "Approvals" [admin, secretary, punong_barangay] — queues: availability to review (admin/secretary), shifts to publish, reports to note, reports to approve, Annex D to prepare/approve; each row deep-links.
- `accomplishment-reports` "Accomplishment Reports" [admin, secretary, punong_barangay] — monthly list by status/person, detail with entries (flagged durations marked), note/approve/return actions shown only if the viewer holds the authority (from `/users` or a `/auth` payload — use GET `/users/:id` for self), print via `PrintPreviewModal` using the user's form layout (header with province/municipality/barangay from settings or editable fields, name, position, month, duration hours, 31-day rows, Prepared/Noted/Approved by with `official_title`).
- `referrals` "Referral Log" [admin, secretary, punong_barangay].
- `school-zones` "Safer School Zones" [admin, secretary, punong_barangay(read)] with tabs Schools (Annex B + print), Incidents (C-1 view of incidents with `school_id` + print), Term Report (Annex D: live counts, create/prepare/approve/mark-submitted, print incl. signature page Prepared by Chief Tanod / Approved by Punong Barangay / Received by Office of the Mayor / DILG copy). Forms mirror the user's files at `…/scratchpad/drive/*.html` (read them); do NOT hardcode a deadline.
- `personnel` hub: tabs Users (+ official_title and approval_authority editing, Admin) | Scheduler (+ availability review panel, draft/published badges, publish action with coverage warnings; swap requests as a section) — **Fatigue tab removed from nav/hub** (code and endpoints stay).
- `dispatch`: "Delegated to" referral action per incident; `incident-detail`/`incident-management`: school link + C-1 fields (secretary/admin edit) + referrals section.
- `admin-dashboard`: pending-approvals widget linking to Approvals (punong_barangay landing).
- Secretary nav gains Approvals, Accomplishment Reports, Referral Log, Safer School Zones.
Verification: `node web/scripts/verify-web-wiring.mjs` and `web/tests` stay green (update tests/fixtures for changed structure, add tests for each new page across roles).

## 11. Retention / privacy

No purge job is added for the new tables or `c1_*` columns: **retention is an
open policy decision** (Rule 10: needs architecture review). Do not invent
numbers; document "retention pending" in `docs/DATA_INVENTORY.md`. No student or
victim names anywhere; focal-person contact is school staff data, minimal.
