# Baranguard — Working Reference (compact)

Purpose: the auto-loaded working reference (schema, API, roles, screens, rules).
Status / Last updated: 2026-10-28, reconciled through migrations 0001-0045.

**Which document wins:** the full `Baranguard_Master_Reference_FINAL .md`
stays in `docs/` for section numbers and DDL (open it by §n). Where the two
differ, this file wins for removed features (Electronic Blotter, Lupon
packet, AI/Ollama pipeline, Fatigue Flags) and the Master Reference wins
elsewhere.

**Never invent a field, route, role, or state transition that isn't
here or there.** If something seems missing, stop and ask.

---

## 1. What this is

Offline-first, locally hosted Barangay Intelligence and Emergency
Dispatch System for four barangays in Pilar, Sorsogon. Production
system, not a demo. Single workstation, LAN-only, no cloud.

**Not deployed (decision 2026-10-28).** The system is not being rolled out
at a barangay; scope is the thesis defense, ISO 25010 evaluation and UAT
(`docs/ROADMAP_TO_COMPLETION.md`, with a "not doing" appendix for
deployment). A Cloudflare Named Tunnel `baranguard` on this workstation
can front `https://baranguardph.win` (web) and `https://api.baranguardph.win`
(API), config in `~/.cloudflared/config.yml`; it is started by
`start-baranguard.ps1`, runs as a user process, has no Cloudflare Access
policy, and `backend/.env` points at the demo database `baranguard_uiseed`,
so anyone reaching those hostnames sees demo data only. A second tunnel
`baranguard-main` on another machine (profile `danilyn`) is orphaned; ask
before touching it. API base URL: `web/index.html` derives `api.<hostname>`
unless opened from localhost; the mobile app defaults to
`https://api.baranguardph.win/api/v1` and local builds override it with the
gitignored `mobile/.env.local` (`VITE_API_BASE_URL`). The on-device
"Workstation address" override was removed 2026-09-27. Public-endpoint
caveat if an Access policy is ever added: scope it to the web host only,
never the API (the transparency report and `GET /barangays` are public and
the mobile app's calls cannot pass a browser login).

**Stack:** PHP 8.2 serves all of `/api/v1/*` (Node is CLI tooling only).
MariaDB 10.4 via XAMPP. Web: vanilla JS, no bundler, no npm step (hand-
rolled charts, inline SVG icons, vendored MapLibre). Mobile: Ionic React
9 + Capacitor 8.5, encrypted SQLite (SQLCipher). **No AI**: the local
Ollama/SEA-LION pipeline was removed 2026-10-01 (see the removal note
below).

**Electronic Blotter and the whole AI pipeline REMOVED 2026-10-01
(migration 0029).** Barangays are directed to keep the blotter and the
Lupon records in their own **binders**, so Baranguard no longer
finalizes, amends or exports blotter entries, and with no blotter to feed
there is no redaction/summary/translation/extraction pipeline left to run.
Gone: `BlotterController`, `AiDraftController`, `routes/blotter.php`,
`routes/ai.php`, `services/ai/*`, `services/eval/*`, `ai-worker.php` and
the eval scripts/`eval-kit`, `GET /system/ollama-status`, `GET
/system/ai-queue`, the Redaction/Blotter tabs, the topbar AI badge, and
tables `blotter_record`/`blotter_revision`/`ai_processing_log`/
`ai_evaluation_run`. **Kept on purpose:** the Secretary role (it still
owns raw-narrative access and the incident lifecycle), `incident.
raw_narrative` and the party fields, and the unused columns `redacted_
narrative`/`redaction_approved_*` (nothing writes them any more). **Do
not rebuild any of this without an explicit new decision.** Consequence
to know about: with no approved redaction, `RetentionService`'s
raw_narrative rule reduces to its existing ceiling for every
incident (changed from 90 days to ONE YEAR by the owner 2026-10-17;
Rule 10 architecture review still applies to any further change).

**Tanod-workflow build added 2026-10-01 (migrations 0030-0033; feature plan and contract removed 2026-10-28, see git history).** Real tanods are honorarium-only,
have no DTR, and submit a monthly accomplishment report as their
attendance; rosters are built from stated availability and approved by a
barangay official; large matters are referred (PNP/BFP/EMS/officials),
never handled; MC 2026-037 adds school-zone reporting. So: availability +
draft/published rosters, monthly accomplishment reports (open -> prepared ->
returned; printed and signed on paper, not tracked), incident referrals, a school inventory + check-ins + a
per-incident Annex C-1 summary + an Annex D term report. **Code-complete,
verified on disposable DBs and jsdom only — not browser-verified by an
agent, not device-verified, migrations 0029-0033 not applied to either
real DB.** Positioning guard unchanged: the referral log and school
reports are delegation/aggregate views with no names or narratives — still
no browsable case registry (BIMSS/KPIS is the case ledger). **No retention
rule or purge job exists for any of the new tables or the `c1_*` columns;
retention is an open policy decision (Rule 10).** The Annex B/C-1/D field
lists come from the user's own forms; the circular text (deadlines, filing
frequency, Annex A) was not readable and is unknown — do not guess.

**Mobile rebuild ABANDONED same day it was decided (DEVLOG 2026-09-27
(3), reversed same date).** A React Native (Expo + dev build) rebuild was
attempted in a `mobile-rn/` folder, reached Phases 0–7 code-complete plus
a full UI redesign, and had a real device build running — then the user
chose to go back to **Capacitor**. `mobile-rn/` is deleted; `mobile/`
(Ionic React + Capacitor) is the one live, installable app, not a
placeholder pending cutover. Do not restart this rebuild without an
explicit new decision to do so — see `docs/HANDOFF.md` for what the
abandoned attempt found (including a real encrypted-SQLite bug that would
need re-discovering if this is ever revisited) and `backend/DEVLOG.md`
2026-09-27 (3)-(13) for the full arc.

**Review-decision build added 2026-10-07 (migrations 0034-0038; source: the
"Proposed Changes Review" decisions and `docs/WORKFLOWS_AND_RULES.md` Part 3
rules 56-66). Code-complete, verified on disposable DBs and jsdom only; NOT
browser- or device-verified; migrations 0034-0038 NOT applied to either real
DB (apply in order after 0029-0033, DBA/root, backup first).**

- **0034** `dispatch.cancel_reason`/`override_reason` (VARCHAR 255). `PATCH
  /dispatch/:id/cancel` now REQUIRES `reason` and also works from `arrived`;
  `POST /dispatch` requires a published shift covering now, else 422
  `NO_PUBLISHED_SHIFT` unless `override_reason` is sent. Reason text is never
  audited (Rule 8: `has_reason`/`reason_length` only).
- **0035** `shift_schedule.pending_reapproval`. An approved swap on a published
  shift makes it draft + flagged; the owning tanod still sees it. Secretary may
  create/update shifts and review swaps (publish still needs `approve_roster`).
  `backup.sh` prunes NOTHING while any legal hold exists.
- **0036** `incident.report_channel` (tanod_alerted|walk_in|sms|other) and
  `incident.related_incident_id`; `PATCH /incidents/:id/related`
  (admin|secretary, no status change, allowed with an open dispatch). Public
  `POST /citizen-reports` removed (405: GET shares the path).
- **0037** paper approvals (**superseded: columns, routes and `document_scan` dropped by 0041, below**): `approval_mode`/`paper_signed_on`/`paper_recorded_*`
  on `accomplishment_report` and `ssz_term_report`; `POST .../paper-signature`
  and `POST .../record-paper-approval` (admin|secretary); table `document_scan`
  + `POST /document-scans`, `GET /document-scans`, `GET /document-scans/:id/download`
  (PDF/JPEG/PNG, 10 MB, stored under `SCANS_DIR`, PB may read). Paper is the
  official record; approved reports stay locked; `paper_pending` flags the gap.
- **0038** night dispatch offers: `dispatch_offer`, `dispatch_offer_recipient`,
  notification type `dispatch_offer`, `shift_schedule` paper columns. Routes
  `GET/POST /dispatch-offers`, `POST /dispatch-offers/:id/accept` (online-only,
  first accept wins), `PATCH /dispatch-offers/:id/cancel`. Night = 18:00-06:00
  Manila, 180 s per round, 3 rounds, then Admin-only escalation reminders
  (spaced). Sweeper `backend/scripts/dispatch-offer-sweeper.php`, scheduled by
  `install-scheduled-backup-jobs.ps1` as `BaranguardDispatchOfferSweeper`.
  `POST /shifts/publish` accepts `recorded_from_paper:{signer_user_id,signed_on}`.
- **0039** (2026-10-09, NOT applied to any real DB) `incident.resolve_reason`
  (VARCHAR 255). `PATCH /incidents/:id/status` (Admin) now also resolves a
  `pending` or `reopened` incident that was never dispatched, but ONLY with a
  `reason` (1-255 chars; missing -> 400). Stored on the incident, never in
  audit metadata (`has_reason`/`reason_length` only). A `dispatched` incident
  is resolved as before. **This amends Master Reference §2 rule 21, which
  said only a dispatched incident may be resolved; the Master Reference text
  has not been edited yet.**
- **Paper-first signing (2026-10-12, no migration):** the signed paper is the
  approval. Web no longer offers in-app Note/Approve on accomplishment reports
  or Approve on Annex D; Admin/Secretary "Record signed paper" instead.
  `POST /accomplishment-reports/:id/record-paper-approval` now also accepts a
  `prepared` report (`noted_by` stays NULL). Admin/Secretary always publish
  shifts with `recorded_from_paper`; a PB holding `approve_roster` can still
  publish in-app. The note/approve/publish endpoints are unchanged. Approvals
  inbox and dashboard widget show "waiting for the signed paper" queues to
  Admin/Secretary. Rule 73 in `docs/WORKFLOWS_AND_RULES.md`.
- **0041** (2026-10-12, print-only; NOT applied to any real DB) reports are
  printed and signed on paper and the app does not track signatures.
  `accomplishment_report.status` = open|prepared|returned (rows `noted`/`approved`
  become `prepared`); `ssz_term_report.status` = draft|prepared|submitted.
  Dropped: `approval_mode`/`paper_*` columns, `noted_*`/`approved_*` columns,
  table `document_scan`; routes `/note`, `/approve`, `/paper-signature`,
  `/record-paper-approval`, `/document-scans*` removed; `POST /shifts/publish`
  is plain (no `recorded_from_paper`). Authority flags remain. Older paper/scan
  data is dropped.
- **0042** (2026-10-13, NOT applied to any real DB; destructive, back up first)
  **Fatigue Flags removed.** Drops table `fatigue_flag`. Gone: `GET
  /shifts/fatigue-flags`, `PATCH /fatigue-flags/:id/acknowledge`,
  `FatigueFlagsController`, `FatigueCalculator` (its `recalculate()` calls in
  shift create/update and swap approval), `unacknowledged_fatigue_flags` in
  `GET /reports/nav-counts`, the web Fatigue page, the scheduler's fatigue
  callouts / "[Over/Near Limit]" labels, the 56 h/week red markers and Smart
  Fill limit, and the `fatigue_flag` delete in the shift retention cascade.
  **Kept on purpose:** the 12 h/day scheduled-hours cap (422
  `DAILY_HOURS_EXCEEDED`, week-grid marker, Smart Fill limit), the per-tanod
  weekly "Hours" total as a plain number, and historical `audit_log` rows
  `fatigue_flag_acknowledged` (write-once). Routes 117 -> 105 (the rest of that
  drop is 0041's removals). **Do not rebuild without an explicit new decision.**
- **0044** (2026-10-17, NOT applied to any real DB) `incident.report_channel` gains `phone_call` and `facebook` (additive enum widening; down folds them into `other`). Same day, no migration: raw narrative ceiling 90 -> 365 days, the five new-table retention rules set to a provisional 365 days, tanod availability made optional (Rule 83), Safer School Zones annexes marked draft layout (Rule 88). See `WORKFLOWS_AND_RULES.md` rules 81-88.
- **0045** (2026-10-17, applied to `baranguard_uiseed` only) `incident_referral.referred_to` gains `lupon_kp`. Same day, no other migration: the Secretary is the back-up dispatcher (Rule 89), the Chief Tanod phone console can log an incident (`POST /incidents` joins `ADMIN_DEVICE_ALLOWLIST`, local schema v10 `admin_incident_outbox`, Rule 90), one workstation per barangay (Rule 92). See `WORKFLOWS_AND_RULES.md` Part 7.
- **2026-10-28 mobile and messaging audit fixes** (no migration; working tree, verified on disposable DBs / vitest / jsdom only, NOT device-verified; Rules 97-106 in `WORKFLOWS_AND_RULES.md` Part 8; findings summarised in `docs/DEFECT_LOG.md`). SOS control on every Tanod tab (hold 800 ms), GPS wait at most 2 s, Silent SOS option (default silent). SOS repeats every 2 min while `active` (Secretary and Punong Barangay added from round 3, max 5). FCM is data-only for `sos`, `priority_alert`, `dispatch`, `dispatch_offer`. `POST /sms/broadcast` answers `{recipient_count, queued}` (queued, 10-min duplicate guard, 100 cap). SMS statuses: `queued` / `pending` ("Sent, not confirmed") / `sent` ("Sent") / `failed`; never "Delivered". Inbound human texts stored through `POST /internal/sms/inbound-text` (7 internal handlers) under `GATEWAY_BARANGAY_ID`; STOP/TIGIL/UNSUBSCRIBE opts out. `server_time` added to `GET /dispatch-offers`. Scheduled tasks `BaranguardNotificationWorker` and `BaranguardGsmIngest`. Phone: logout cleanup and per-user local data, `allowBackup` off, cleartext only in debug builds, My Shifts offline cache, critical alert queue. Open owner decisions: names/coordinates in the SOS SMS, SOS recipients beyond the Admin (Rule 89), keystore for the native service token.
- **0040** (2026-10-12, NOT applied to any real DB) report and roster
  notifications: `notification.notification_type` gains `report_update` and
  `roster_published`; `notification.accomplishment_report_id` (FK, SET NULL).
  A tanod gets an ordinary push (no SMS fallback, never a critical alert)
  when their report is approved (in-app or from paper) or returned, and when
  shifts assigned to them are published. Body = month and outcome only. Also
  2026-10-12: Admin/Secretary always see accomplishment entry text (they print
  it); every print is A4 (`@page` in `base.css`, A4-sized preview sheet).
  Rule 74.

- **Workflow-gap fixes (2026-10-12, no migration; Rules 74-79 in
  `docs/WORKFLOWS_AND_RULES.md`):** (1) an approved swap keeps a published
  shift published (`swap_request_resolved.approval_reset` always false);
  (2) paper is the only approval: `/accomplishment-reports/:id/note|approve`
  and `/ssz-term-reports/:id/prepare|approve` answer 410
  `PAPER_APPROVAL_REQUIRED`, `POST /shifts/publish` requires
  `recorded_from_paper` from every caller (422), a PB holding `approve_roster`
  may record it and may read `GET /users/directory?purpose=signer&authority=approve_roster`;
  (3) `POST /ssz-term-reports/:id/record-paper-approval` accepts a `draft`
  with `preparer_user_id` (prepare_annex_d, never the signer); (4) tanods
  can go off duty offline: `duty_status_updates[]` items take an optional
  `changed_at` (off_duty only; <= 5 min ahead, <= 62 days back, not before
  the last on_duty/responding row, else 409), and a late off duty
  recalculates suggested durations in open/returned months; (5) night offers
  fall back to on-duty tanods whose availability covers now when no rostered
  tanod qualifies (fixed `OfferService::FALLBACK_OVERRIDE_REASON`, audit
  `fallback`/`offer_fallback` flags); (6) the Admin device session may
  `PATCH /tanod-sos/:id/resolve` (signed write; the Admin device session now has seven signed writes, see the Rule 12 amendment).
  **Availability is fixed by the tanod:** `PATCH /availability/:id` answers
  410 `AVAILABILITY_NOT_REVIEWED`, a tanod may change any period at any time,
  and shift create/edit/swap approval refuse with 422 `OUTSIDE_AVAILABILITY`
  when a tanod would be scheduled outside their windows (unassigned shifts
  and Admin assignees not checked).
- **Rule 12 amendment:** an Admin login with a well-formed `X-Device-Id` gets a
  device session (24h sliding, 7-day cap) limited to
  `SessionPolicy::ADMIN_DEVICE_ALLOWLIST` (anything else 403
  `DEVICE_SESSION_SCOPE`); seven writes require the device header/signature (SOS acknowledge, SOS resolve, `POST /dispatch`, dispatch cancel, `POST /incidents`, `POST /dispatch-offers`, dispatch-offer cancel; counted from `ADMIN_DEVICE_ALLOWLIST` 2026-10-28). The
  mobile app serves the Chief Tanod (Admin) with a 4-tab console: SOS
  acknowledge and resolve (owner decision 2026-10-14, matching the 2026-10-12 backend change and Rule 72; Resolve is offered only after Acknowledge), dispatch assign/cancel/offers, read-only incidents.
  `GET /users/directory?purpose=tanod|roster|signer` (admin|secretary) returns `{user_id, full_name,
  official_title}` for tanod and signer pickers.
- **Retention:** placeholder rules (`RetentionService::NEW_TABLE_RULES`, period
  `null`, purge OFF) for availability, accomplishment reports, school check-ins,
  referrals and Annex D (`ssz_term_report`, submitted only); `document_scan`
  was dropped by 0041; `school` is deliberately never purged. Needs a
  council/COA decision (Rule 10).
- **Web:** System Tools menu groups SMS Monitor, Audit Log, Service Health, Map
  Packages (Admin only; Settings unchanged); reason dialogs; offer state on the
  Dispatch board; paper panels; related-incident card; Secretary scheduler.
  Verification counts 2026-10-07: `verify-web-wiring.mjs` 776, `web/tests` 609,
  `verify-wave1a-dispatch-roster.sh` 145, `verify-incident-intake.sh` 124,
  `verify-dispatch-offers.sh` 193 (re-run 2026-10-08; 184 was the first count),
  `verify-retention-new-tables.sh` 131,
  `verify-sprint7-retention.sh` 89, `verify-chief-tanod-mobile.sh` 174.

**Four barangays, fixed:** Dao=1, Binanuahan=2, Marifosque=3, Banuyo=4.

**Incident code `INC-YYYY-NNN` (`incident.display_id`, 0014; unique per barangay since 0043, 2026-10-14).** Numbered per
barangay and per Asia/Manila year as MAX(existing number)+1 (locking read in the insert's transaction), so every barangay
starts at 001 each year and a purged incident's number is never re-issued; NNN grows past 3 digits. It is NOT derivable
from the numeric `incident_id`: never build it client-side. The API returns it as `display_id` (incidents, search results,
sync results) or `incident_display_id` (dispatch, dispatch offers, SMS logs, citizen reports) and `entity_display_id`
(audit log). A row without a stored code (older rows) is shown as `INC-#<id>` (web `formatIncidentCode`, mobile
`formatIncidentCode`), visibly not an official code. Dispatch SMS/push carry `Ref: INC-...`. Referral `reference_no` is
free text typed by staff (<= 64 chars); the `SIM-nnnn` values exist only in seeded data.

**Relationship to DILG BIMSS — settled, do not re-litigate.** DILG
BIMSS/BIMS is mandated for all barangays by Memorandum Circular; its
KPIS subsystem already *is* the Katarungang Pambarangay case database
and BIMS ships its own electronic blotter. **Baranguard complements
BIMSS and may never be positioned as replacing it** — a legal
constraint, not a design preference. Baranguard's value is real-time
dispatch, GPS, SOS and offline field capture — none of which BIMSS has. Anything duplicating a BIMSS *records* function
is liability, which is why the walk-in blotter endpoint and the
standalone blotter records list were removed 2026-09-10, and the rest of
the blotter with it 2026-10-01.

**Current-circular note (from secondary sources, verify against the
circulars themselves before relying on it):** DILG's LGUSS-BIMS is
reportedly the mandated barangay information system under MC 2025-104,
and Safer School Zones is reportedly MC 2026-037 (June 25, 2026). Neither
number has been checked against the issued text, and nothing in the code
depends on them.

---

## 2. Non-negotiable rules — the ones that actually bite

**This numbered list (1-12) is not the Master Reference's own 32-rule
§2 list** — overlapping ground, different numbering. A "Rule N" citation
elsewhere means whichever list context makes clear.

1. **`raw_narrative` never leaves the system.** Never to FCM, the SMS gateway, cloud, logs,
   terminal output, or audit metadata. **`GET /incidents/:id` is the only endpoint
   that returns it, and only to a Secretary or to an Admin on a WEB session.**
   (RA 7160 §394(c) makes the Secretary the statutory records custodian.
   **Amended 2026-10-13 by the owner:** the Chief Tanod (Admin) is the dispatcher
   and must read the narrative and the party fields to brief a responding Tanod.
   The Admin's DEVICE session, the phone console, still never receives them;
   editing is unchanged, `complainant_name` stays Secretary-only; each read is
   audited as `raw_narrative_viewed`, ids only.)
2. **Every protected endpoint verifies role + tenant + ownership
   server-side.** No client-side check is a security boundary.
   Cross-tenant is **404, never 403** (403 confirms the resource exists).
3. **Idempotency, not interchangeable:** web writes use the
   `Idempotency-Key` UUID header; mobile writes use `client_event_id`
   (+ `X-Device-Id`, server-verified). A retry returns the original row,
   never a second one.
4. **(Retired 2026-10-01.)** This rule governed the AI redaction
   pipeline's order of operations; the pipeline was removed (migration
   0029). Numbering is kept so older "Rule N" citations still line up.
5. **(Retired 2026-10-01.)** "The API never calls Ollama" — there is no
   Ollama or AI worker any more, and no external AI is permitted either.
6. **No demo/prototype tells.** No fabricated statistics, hardcoded
   identities, confidence numbers, controls that look functional and do nothing, or
   a health badge that isn't a real probe. `not_configured` is neutral.
7. **Offline capture is durable state.** A mobile write persists to
   encrypted SQLite before the user can leave the screen, never claimed
   synced until the server confirms.
8. **Audit metadata is allow-listed** — identifiers and statuses only.
   Never narrative, credentials, tokens, coordinates, or personal data.
9. **Never edit a completed migration.** Add a new numbered one.
10. **Retention numbers are constants, not config** (§11) — changing one
    needs an architecture review, not a runbook edit.
11. **Timestamps stored UTC; operational/display times Asia/Manila.**
    Day-bucketing is done in PHP against a fixed +08:00, never
    `CONVERT_TZ()` (tz tables aren't loaded on stock XAMPP).
12. **Two session kinds, one revocation rule** (§2 Rule 9, amended
    2026-09-19; `services/auth/SessionPolicy.php`): the web dashboard
    gets a 15-minute sliding JWT (an open dashboard polls every 15s and
    never expires; a closed tab/sleeping PC does); a Tanod login with a
    well-formed `X-Device-Id` gets a **device** session — 24h sliding,
    hard cap 7 days from issue, tanod role only. Both die on the next
    request after logout/suspension/deactivation/password change because
    `AuthMiddleware` checks `auth_session` every time — never lengthen
    a token on the assumption that it can't be revoked. The mobile shell
    also opens on an *expired-but-stored* session (cached view only) so
    an out-of-range Tanod isn't locked out of their own queue.

---

## 3. Roles (§3, §7)

| Role | Reach |
|---|---|
| **Admin** | Full operations / Chief Tanod's seat: dispatch, GPS, scheduler (drafts rosters, reviews availability), users (incl. editing official title and approval authorities), devices, audit log, service health, exports, Annex D preparation. Reads `raw_narrative` and the party fields on the web only (amended 2026-10-13, see Rule 1) but cannot edit them or run the Secretary lifecycle actions. May NOT change their OWN `approve_*` authorities (403; another Admin must). |
| **Secretary** | **Back-up dispatcher (2026-10-17, Rule 89)**: may also dispatch, cancel, open night offers, resolve incidents and acknowledge/resolve SOS on the web, with no phone device session. **Records & Reports Officer** (redefined 2026-10-01): records custodian: reads `raw_narrative` and the incident party fields (the web Admin may read them too, amended 2026-10-13) and is the only one who edits the complainant name; only role that may change an incident's lifecycle (duplicate/invalid/cancelled/reopened); also owns the school inventory (Annex B), the referral log, C-1 fields and preparing/filing annexes. A Kagawad has NO role of their own: they use a `secretary` account carrying approval authorities (open decision, see HANDOFF). |
| **Punong Barangay** | Oversight **plus approval** when granted authority: dashboard, map, heatmap, analytics, Approvals inbox, accomplishment reports, referral log, school zones (read). Still no evidence files and no list of cases (individual incidents still reachable from dashboard). |
| **Tanod** | Mobile only. Own incidents/dispatches/**published** shifts, availability, accomplishment entries, referrals, school check-ins. Web login succeeds but lands on an honest "no screen" page. |
| **Lupon** | **No system account at all** (DB-enum-only, never a login role). Baranguard no longer generates anything for them. |

**Approval authority is a separate, Admin-managed attribute — NOT a role**
(migration 0030): `user.approval_authority` is a SET of `note_report` ·
`approve_report` · `approve_roster` · `prepare_annex_d` · `approve_annex_d`,
and `user.official_title` is the text printed under a signature. Only
admin / secretary / punong_barangay accounts may hold any
(`backend/lib/ApprovalAuthority.php`, `ELIGIBLE_ROLES`). Backfill: every
Punong Barangay -> title "Punong Barangay" + `note_report, approve_report,
approve_roster, approve_annex_d`; every Admin -> title "Chief Tanod" +
`note_report, prepare_annex_d`. Segregation of duties between preparer and approver was dropped 2026-10-17 (Rule 96); an Admin cannot
add/remove their own `approve_*` authorities. `PATCH /users/:id` (Admin)
edits title/authorities; audit `user_approval_authority_changed`.

---

## 4. Schema map (§5 — 23 tables at the Master Reference; +7 tables from migrations 0030-0033, minus 4 dropped by 0029, minus `fatigue_flag` dropped by 0042)

Core chain: `barangay → user → mobile_device → incident → dispatch →
tanod_sos → notification → notification_target → notification_delivery`.

**Key tables:** `incident` (raw_narrative NULLable, redacted_narrative,
legal_hold, raw_narrative_purged_at, complainant_name/respondent_name/
complainant_contact_number — Secretary-only, location_description,
display_id, status incl. duplicate/invalid/cancelled/reopened since
migration 0025, duplicate_of_incident_id/lifecycle_changed_by/
lifecycle_changed_at) · `dispatch` · `evidence_attachment` (files outside web
root, legal_hold) · `citizen_report`
(legal_hold) · `duty_status` · `gps_track` · `shift_schedule` (user_id
nullable) · `shift_swap_request` · `sms_log` (barangay_id,
message_body/read_at, `message_type` incl. `manual`, legal_hold) ·
`sms_envelope_replay` · `audit_log` (write-once except retention) ·
`offline_queue` · `auth_session` · `map_package` · `user`
(is_suspended/suspended_reason/suspended_at — independent axis from
is_active) · `system_settings` (§7 W21 note) · `sms_subscriber`
(consent-tracked broadcast list — `consent_at`/`consent_source` NOT
NULL, removal is `opted_out_at` not a DELETE) · `health_check_log`
(dependency-status CHANGE log, includes `ors_status`) · `rate_limit_counter`
(fixed-window abuse-budget counter, not a business dataset — no retention/
legal-hold treatment, see migration 0023's own doc comment).

**Tanod-workflow tables (0030-0033, 2026-10-01; NOT applied to any real DB;
no retention/purge defined — Rule 10 decision pending):**
`tanod_availability` (per tanod + period, `windows_json`, status
submitted/accepted/revised, `client_event_id`) · `accomplishment_report`
(per tanod + `month` 'YYYY-MM', status open/prepared/
returned) · `accomplishment_entry` (work_date, text,
confirmed `duration_minutes`, server `suggested_duration_minutes`,
`duration_flag`) · `incident_referral` (referred_to enum incl.
`ambulance_ems`, never a citizen name) · `school` (Annex B, no student data;
carries a focal person + contact) · `school_checkin` (no coordinates) ·
`ssz_term_report` (Annex D snapshot, draft/prepared/approved/submitted).
**New columns:** `user.official_title`/`approval_authority`;
`shift_schedule.approval_status` (draft/published)/`source_availability_id`/
`approved_by`/`approved_at`; `incident.school_id`/`c1_summary`/
`c1_action_taken`/`c1_status_notes` (short, non-identifying Annex C-1 text,
separate from `raw_narrative`, which stays on the one-year purge);
`offline_queue.payload_type` gained `referral`, `availability`,
`accomplishment_entry`, `school_checkin`.

**Migrations 0001–0045 (45 migration files, counted in `backend/migrations` 2026-10-28; the rest of this paragraph was written at 0033 and describes 0001-0033).** 0001–0026 are applied to both real DBs
(`baranguard`, `baranguard_uiseed`); **0029 (drops the blotter and AI
tables) and 0030–0033 (tanod workflow) are written and verified on
disposable DBs only — NONE of them has been run against either real DB**
(0029 is destructive; take a backup first; apply in numeric order). On a new machine apply all in order as DBA/root —
`baranguard_app` has no `ALTER`/`CREATE TABLE` (§8). Notable ones:
0008 incident party fields · 0009 blotter case_status (table since dropped by 0029) · 0011 user
suspension · 0012 system_settings (W21) · 0014 display_id · 0015 ai_tools
(since removed again by 0027/0028) · 0016 retention
hold + device scrub · 0017 health_check_log · 0018 sms_subscriber ·
0019 audit_log idempotency index · 0020 health_check_log.ors_status ·
0021 generic metric columns on `ai_evaluation_run` (table since dropped by 0029) · 0022
`auth_session.session_kind` (web/device — see §2 rule 12) · 0023
`rate_limit_counter` (shared abuse-budget store, `Baranguard\Lib\
RateLimiter` — code-review findings H-11/H-13) · 0024
`mobile_device.device_public_key_pem` (H-09 device-signature keys) · 0025
incident lifecycle states/merge linkage (H-16/M-03; its `ai_processing_log.
prompt_template_version` half went with that table) · 0026 `tanod_sos` nullable
latitude/longitude + `location_source`/`location_recorded_at` (C-01 SOS
no-fix fallback) · 0027/0028 remove the AI Tools screen's columns/types ·
0029 `remove_blotter_and_ai_pipeline` (drops `blotter_revision`,
`blotter_record`, `ai_processing_log`, `ai_evaluation_run`; keeps
`incident.raw_narrative`/`redacted_narrative`/party fields and
`health_check_log.ollama_status` as historical, new rows write
`not_configured`) · 0030 `approval_authority_and_roster` (`user.official_title`/
`approval_authority`, `tanod_availability`, `shift_schedule` draft/published
columns; existing shifts backfilled to published) · 0031
`accomplishment_reports` (`accomplishment_report`/`accomplishment_entry`;
widens `offline_queue.payload_type`) · 0032 `incident_referral` · 0033
`school_zones` (`school`, `school_checkin`, `incident.school_id`/`c1_*`,
`ssz_term_report`).

**FK trap:** `evidence_attachment` and `dispatch` are `ON DELETE
RESTRICT` against `incident` — deleting
an incident is an ordered cascade (`RetentionService::purgeOneIncident`).

**MariaDB 10.4 limits:** no `SKIP LOCKED`; a table-level CHECK on
`notification`'s entity matrix fails with ERROR 1901 (enforced in PHP).

---

## 5. Endpoints (103 live `/api/v1` routes across 27 route files, all built; re-measured 2026-10-28 with `count-routes.php`: 103 / 27)

Read the route tables in `backend/routes/*.php` for the authoritative
list; controllers carry the per-endpoint contract in their class docs.
**This number moves as routes change** (code-review finding L-01,
2026-09-24 — it had drifted to 84 here while the real count was already
91): run `php backend/scripts/count-routes.php` to check it against
reality rather than trusting whatever's written here.

**Auth** login · logout · change-password
**Incidents** list (+`q=` search) · show · create · **update** (`PATCH
/incidents/:id`) · nearby · evidence (GET+POST — Tanod-only multipart,
tenant+device+tanod-access checked server-side) · status (Admin
resolve) · **lifecycle** (`PATCH
/incidents/:id/lifecycle`, Secretary-only — `duplicate`/`invalid`/
`cancelled`/`reopened`, H-16/M-03, migration 0025; see the note below)

> `PATCH /incidents/:id` is an **operational-correction endpoint, NOT a
> narrative editor**: Admin+Secretary may set `priority`/`incident_type`/
> `location_description`; `complainant_name` is Secretary-only (it
> carries `raw_narrative`'s protection, same rule as `show()`). Sending
> `raw_narrative`/`redacted_narrative` is a hard 400. `Idempotency-Key`
> required. Audit
> metadata records changed field **names**, never values (Rule 8).

> `PATCH /incidents/:id/lifecycle` is **Secretary-only, separate from
> Admin-only `.../status`** — a records-custodian judgment call
> (duplicate/invalid/cancelled/reopened), not a dispatch outcome, same
> reasoning as a records-custodian decision. Forward-only per state: a terminal
> state (`resolved`/`cancelled`/`invalid`/`duplicate`) can only be left
> via `reopened`, never jumped straight to another terminal state.
> **`duplicate` requires `duplicate_of_incident_id`; MERGE MEANS LINK, NOT
> DELETE** — the target incident is completely untouched (no row moves,
> no FK repointed), both incidents stay independently queryable and
> retained on their own clock. Blocked while any dispatch is still open,
> same guard `.../status` uses. `Idempotency-Key` required.

**Dispatch** list (tanod_name joined) · create · cancel · status ·
route (`GET /dispatch/:id/route`)

> An incident may have **more than one concurrent active dispatch**
> (explicit architecture sign-off, no priority gate, unbounded count).
> `create` accepts `pending` OR `dispatched` incidents, rejecting only a
> Tanod already actively assigned. `cancel` reverts to `pending` only
> when no OTHER active dispatch remains. `GET /incidents/:id` has a
> `dispatches[]` array (every responder); its singular
> `dispatched_at`/`arrived_at` means "the primary/first responder."
>
> `GET /dispatch/:id/route?latitude=&longitude=&mode=car|foot` computes
> a road-snapped route from the CALLER's live position to the incident,
> via OpenRouteService (`OrsClient.php`), persisted onto
> `dispatch.route_json`/`route_status`. Own-Tanod-or-Admin gated,
> tenant-scoped. Never a 500 on routing failure — an existing route is
> kept and marked `stale` rather than discarded; only a never-successful
> dispatch falls to `unavailable`. Not audited (Rule 8 bars raw
> coordinates).

**GPS** live · history · post · `/sync/batch` (kinds: sos · incident ·
referral · gps · duty_status · dispatch_status · availability ·
accomplishment_entry · school_checkin, processed in that order; request
keys `referrals[]`, `availability[]`, `accomplishment_entries[]`,
`school_checkins[]` added 2026-10-01; each new kind is signature-checked
PER ITEM, SOS never is)
**Scheduling** shifts (list/create/update/**publish**) · swap requests.
(**Fatigue Flags were removed entirely 2026-10-13**, migration 0042: no table,
endpoints, nav count, tab or 56 h/week warning.) **Roster rules changed 2026-10-01** (supersedes H-17): the 8h
minimum-rest block and the min-1-on-duty hard block are GONE; replaced by
a hard cap of 12 scheduled hours per tanod per Manila day (422
`DAILY_HOURS_EXCEEDED`, writes per tanod serialized by a user-row lock);
`assertNoOverlap` stays; missing coverage is a `NO_COVERAGE` warning on
publish. New shifts are `draft`; a Tanod only ever sees `published` own
shifts. Changing a published shift's `user_id`/`start_at`/`end_at`
(PATCH or approved swap) reverts it to `draft` (re-publish needed); a
`patrol_zone`-only edit does not. A swap request on a draft shift is 404.
**Notifications/SOS** notifications · ack · tanod-sos (+ack/resolve)

> `POST /tanod-sos` **never rejects on a missing GPS fix** (C-01,
> migration 0026, §2 Rule 27). Live coordinates are used when sent;
> missing coordinates fall back to the Tanod's most recent `gps_track` row
> (`location_source='last_known'`, `location_recorded_at` = that fix's OWN
> timestamp); with no `gps_track` row at all the SOS is still created
> (`location_source='no_fix'`, `latitude`/`longitude` NULL). Sending only
> ONE of latitude/longitude is still a 400 — a different failure mode from
> sending neither.
**Devices/Map** register (`fcm_token` optional) · deactivate ·
map-packages (get/upload/download)
**Reports** summary · heatmap · nav-counts · export (+download, response
time is per-incident `MIN(arrived_at)`, de-duplicated)
**Ops** `/audit-log` · `/system/health` (+`/history`, Admin-only) ·
`/search` · `/barangays` · `/users` (list `q=`, last_login_at,
is_suspended; suspend/unsuspend + is_active toggle) · ~~`/citizen-reports`~~ (**RETIRED 2026-10-17**: the Citizen Reports inbox, its routes, controller and nav item are gone, every path now answers 404. Walk-ins and phone reports are logged as incidents with `report_channel`. The `citizen_report` table and its existing rows are kept (retention, seeds); nothing creates new ones)
(+`/:id/convert`, list `status=`) · `/duty-status`

> **The whole blotter family (`/blotter`, `/incidents/:id/blotter`,
> `finalize`, `blotter/amend`, `lupon-packet`) and the AI pipeline
> (`/incidents/:id/redact`, `/ai-draft/*`, `/system/ollama-status`,
> `/system/ai-queue`, and earlier `/ai-tools/*`) were REMOVED** — the
> walk-in `POST /blotter` on 2026-09-10 (a walk-in with no prior incident
> is exactly a DILG BIMSS/KPIS case, §1), everything else 2026-10-01
> (migration 0029; barangays use binders). Each now answers a plain 404
> route miss (asserted in `verify-sprint7-pentest-incidents.sh`).

**Tanod workflow (2026-10-01;
cross-tenant 404, web writes need `Idempotency-Key`, tanod writes
`client_event_id` + `X-Device-Id`; audit metadata ids/statuses only):**

- **Availability** `POST /availability` (tanod; same user+period while
  `submitted` updates windows and bumps `version`; accepted -> 409) ·
  `GET /availability` (tanod own; admin/secretary/PB barangay-wide) ·
  `PATCH /availability/:id` (admin|secretary: `accepted`/`revised` + note).
- **Roster approval** `POST /shifts/publish` (`approve_roster`; 1-100 ids;
  returns `published`, `already_published`, `warnings[NO_COVERAGE]`; a
  tenant-mismatched id 404s the whole call; each tanod with a newly
  published shift gets one `roster_published` push, migration 0040).
  `POST /shifts` takes optional `source_availability_id`.
- **Users** `GET /users/:id` (new) · `PATCH /users/:id` also accepts
  `official_title` and `approval_authority[]` (Admin; see §3).
- **Accomplishment** `POST`/`PATCH /accomplishment-entries` (tanod; work
  date not future and <= 62 days back; confirmed duration 1-1440 min; the
  server stores its own suggested duration from `duty_status` and sets
  `duration_flag` when they differ by > 30 min) ·
  `GET /accomplishment-reports` (+`/:id`, entry text for Admin, Secretary
  and holders of note/approve authority) ·
  `POST /accomplishment-reports/:id/submit` (tanod, ONLINE-ONLY, not a sync
  kind) · `/return` (note or approve authority, reason
  1-255). open|returned -> prepared (locked; printed and signed on paper, not
  tracked) ; prepared -> returned; illegal -> 409. `/note` and `/approve` were
  removed (0041).
- **Referrals** `POST /incidents/:id/referrals` (tanod own/dispatched,
  admin, secretary; does not change dispatch/incident status; records a
  handoff, never acceptance) · `GET /incidents/:id/referrals` ·
  `GET /referrals?from=&to=&referred_to=` (admin/secretary/PB; rows carry
  no narrative, names, contacts or coordinates — a delegation log, not a
  case registry). `referred_to`: pnp · bfp · ambulance_ems ·
  barangay_official · vaw_desk · social_welfare · higher_lgu · doh · dpwh
  · other.
- **Safer School Zones** `GET/POST /schools`, `PATCH /schools/:id`
  (admin|secretary write; no DELETE, deactivate via `is_active`; all roles
  read own barangay) · `POST /school-checkins` (tanod; strict ISO-8601 with
  zone; in <= 5 min future / <= 62 days back; out not before and <= 24h
  after in; close-by-reference for already-synced check-ins via
  `closes_client_event_id`) · `GET /school-checkins` (admin/secretary/PB) ·
  `GET /reports/school-term?term_start=&term_end=` (live Annex D counts, span
  <= 366 days) · `GET/POST /ssz-term-reports`, `GET/PATCH /:id`,
  `POST /:id/prepare` (`prepare_annex_d`) · `/approve` (`approve_annex_d`,
  never the preparer) · `/mark-submitted` (admin|secretary). Report objects
  carry `prepared_by_name/title` and `approved_by_name/title` for the
  signature page. Incident create (mobile + web) and `PATCH /incidents/:id`
  (admin+secretary) accept `school_id` and `c1_*`; on the MOBILE path an
  unusable `school_id` is stored NULL rather than failing the offline
  incident (Rule 7), on web create/PATCH it is a 400.
  Referral-column mapping for Annex D: `ambulance_ems` and `other` ->
  other agencies by default (`annex_d.ambulance_ems_maps_to` setting may
  map it to DOH); the Secretary confirms.

**SMS** `/sms/logs` (read-only) · `/sms/conversations` (+`/:phone/messages`,
+`/:phone/resolve`, Admin-only) · `/sms/send` · `/sms/broadcast`
(Admin-only, Idempotency-Key required, recipient always resolved
server-side, own-barangay scope only)
**Settings** `GET/PATCH /system-settings` (Admin-only; three `general.*`
keys + `sos_fallback.backup_contact_number` — see §7 W21;
`sms_gateway.api_key`/`sender_name` REMOVED 2026-09-23 with Semaphore)
**Internal only** `/internal/sms/*` (7 handlers, incl. `inbound-text` since 2026-10-28, loopback + token gated,
`public/internal.php`)

**Response envelope:** success = the object; error =
`{"error":{"code":"...","message":"..."}}`. Pagination: `page`/`limit`,
default 25, max 100.

---

## 6. Design system (§8) — web

Tokens only, never a hardcoded hex/px/font in a component file.
`--color-*` in `base.css`; dark mode is a second value set on the same
tokens (`--dark-*` remapped by both `prefers-color-scheme` and
`[data-theme]`).

**Use `--color-*-solid` for white text/icons on a saturated fill** —
plain status tokens lighten in dark mode and fail contrast there. Use
`--color-*-text` for colored text (never `-solid`, which stays dark in
dark mode), and `--color-link` (not `--color-primary`) for primary-
colored text. Keep badge tints at 8% (the `*-text` tokens are specced
against white).

**Every data-driven screen needs all four states:** Loading / Empty /
Error-with-retry / Populated.

Shared components: `AppShell` · `PageHeader` · `DataTable` (+CSV export,
pagination) · `KpiCard` · `LineChart` (treats `null` as a genuine gap,
not zero) · `BarChart` · `DonutChart` · `LiveMap` · `Menu` · `Toast` ·
`ConfirmDialog` (+`promptSelect`) · `StatStrip` · `Avatar` ·
`DateRangePicker` · `icons`.

**Shared CSS entities — use these, don't re-roll them:**

| Entity | Classes | Where |
|---|---|---|
| Tab bar | `.page-tabs` / `.page-tab` (+`__icon`, `__badge`) | `PageHeader.css` |
| Filter chip | `.filter-chips` / `.filter-chip` (+`__count`) | `base.css` |
| Stat card grid | `.stat-card-grid` / `.stat-card` (+`__value`, `__label`) | `base.css` |
| Role badge | `.role-badge--{admin,secretary,punong_barangay,tanod}` | `base.css` |
| Date range | `DateRangePicker()` | `components/DateRangePicker.js` |

**Sizing/spacing tokens:** `--control-height` (2.5rem) ·
`--control-height-prominent` (2.625rem) · `--pad-panel`/`--pad-panel-lg`
· `--spacing-md-lg` (1.25rem).

**Dark mode:** `index.html` stamps a resolved `data-theme` on every load
and follows the OS until the user stores a preference — a page-level
`[data-theme="dark"] .x` rule alone is sufficient.

**Run `node web/scripts/verify-web-wiring.mjs` after any web change** —
catches imports/CSS classes that don't resolve. Measured 528 checks,
0 failed on 2026-10-01 (the count moves as screens change; failures=0 is
what matters).

**Never interpolate server data into `innerHTML`.** Use `textContent`,
or the shared `web/src/utils/escapeHtml.js`. An 2026-09-07 audit found
11 unescaped sites (one let an unauthenticated citizen report execute
script in the Secretary session); all fixed 2026-09-12. Neither
`verify-web-wiring.mjs` nor `node --check` can catch this class of
defect — verify by reading every interpolation site, not by script.

---

## 7. Screens (§9)

**Built:** W1 login · W2 dashboard · W3 dispatch (map markers,
assign-from-map; queues group multiple active dispatches on one
incident into one card) · W4 GIS · W7 incident detail (routed
`incident-detail`; dossier, narrative, evidence, timeline, Admin resolve,
Secretary lifecycle actions) ·
Analytics (tabbed Reports/Heatmap, Admin+PB) · Personnel
(tabbed Users/Scheduler/Swap requests — Admin sees all three, Secretary
and PB the Scheduler only; the **Fatigue flags tab, page, endpoints and table
were removed 2026-10-13**, migration 0042) · W14 SMS Monitor (Activity Log + Conversations tabs) · W15
settings (+General/SMS Gateway, Admin-only) · ~~W16 citizen inbox~~ (RETIRED 2026-10-17) · W17 audit log · W18 map package management ·
W19 public report (REMOVED 2026-10-07) · W20 service health · Incident Management (search,
Resolve action, multi-responder support).
**Added 2026-10-01 (code-complete, jsdom-verified only; not browser- or
device-verified by an agent):** **Approvals** (inbox for admin/secretary/PB:
availability to review, shifts to publish, reports to note/approve, Annex D
to prepare/approve; no count badge — no approvals-count endpoint exists) ·
**Accomplishment Reports** (monthly list, detail with flagged durations,
note/approve/return only for holders of the authority, print layout) ·
**Referral Log** (delegation log, no case content) · **Safer School Zones**
(tabs Schools/Annex B + print, Incidents/C-1 + print, Term Report/Annex D
live counts + create/prepare/approve/mark-submitted + signature page; no
deadline hardcoded) · Personnel: Users tab edits `official_title` and
approval authorities (Admin); Scheduler tab gained draft/published badges
and Publish with coverage warnings (its availability review was replaced
2026-10-12 by a week grid that shows availability as fixed, see DEVLOG
2026-10-12 (3)) · Dashboard
pending-approvals widget (PB landing) · Dispatch "Delegated to" action ·
Incident Detail/Management school link, C-1 fields and referrals section.
Secretary nav gained Approvals, Accomplishment Reports, Referral Log, Safer
School Zones.
**Mobile:** M1–M7, M12, M13, plus (2026-10-01, not device-verified)
Availability, Accomplishments (entry with confirmed duration + online
server suggestion; month submit is online-only), School check-in/out, a
Refer panel on assignment detail and the submitted-incident view, school
picker + C-1 fields on New Incident, My Shifts showing published shifts
only. New local tables `availability_local`, `accomplishment_entry_local`,
`referral_local`, `school_checkin_local`, `school_local` (cache).

> **W6 Electronic Blotter (records list) was REMOVED 2026-09-10, and the
> rest of the blotter 2026-10-01** (migration 0029; barangays keep the
> blotter in binders, DILG BIMSS's KPIS is the mandated case ledger).
> **W7 survives and is load-bearing:** the app's ONLY per-incident detail
> view, and where Incident Management/dashboard/SMS Monitor/audit log/
> search/notifications all land. Its route key was renamed
> `blotter-detail` → `incident-detail` the same day. It is a single page
> now (the former Redaction and Blotter tabs, the workflow stepper and the
> print excerpt are gone). Back button is role-aware. **Role
> consequence**: Punong Barangay has no list-of-cases screen — reach is
> dashboard + Analytics + individual incident detail. **Nothing here
> re-adds a browsable list.** The AI Tools screen (migrations 0027/0028)
> and the W8 AI Redaction Review (0029) are likewise gone.

**W21 system settings — narrow, deliberate exception, not a full
build-out.** Migration 0012 + `SettingsController` originally covered
`sms_gateway.api_key`/`sender_name` too; those two keys were REMOVED
2026-09-23 when Semaphore was replaced by a local GSM gateway (§1) — that
transport has no cloud credential or configurable sender name, so there
was nothing left for them to hold. `SettingsController` now covers only
three `general.*` display keys + `sos_fallback.backup_contact_number`,
masked on read where applicable, under explicit user authorization. Does **not** extend
to `DEVICE_SECRET_MASTER_KEY`/`INTERNAL_SERVICE_TOKEN`/`JWT_SECRET`/
`FCM_SERVICE_ACCOUNT_PATH` — those stay in `.env`/PHP constants, and a
future session must not "complete" W21 by moving them without the same
sign-off. Full Notifications/Security/GIS/Backup settings remain
**not built** — no schema/endpoints exist, §2 Rule 6 forbids shipping
controls that do nothing.

---

## 8. Environment gotchas (each cost hours once — don't rediscover)

- **Apache doesn't forward `Authorization`** — fixed by a rewrite in
  `backend/public/.htaccess`. Only bites under real Apache, never `php -S`.
- **`config/env.php` precedence:** an already-set env var wins over
  `.env`. Never `set -a; . .env` in a script — it inverts that.
- **Empty `DB_PASSWORD` is rejected by design.** Disposable-DB tests
  must mint a throwaway MySQL user with a real password.
- **The app DB user has no `CREATE DATABASE`/`ALTER`/`CREATE TABLE`**
  (correct least-privilege) — migrations need DBA credentials.
- **Git-Bash `/c/...` paths break native `php.exe`** — `cygpath -m` first.
  **Native `curl.exe` too** (`-F file=@/c/...` fails with curl exit 26,
  `%{http_code}` reads `000`) — same fix.
- **Space in the Windows username breaks Gradle and SDK `.bat` tools** —
  use the short path (`C:\Users\JAYSON~1\...`), `C:\gtmp` for
  `java.io.tmpdir`. **Gradle's daemon JVM follows `JAVA_HOME`, not
  `java` on PATH** — `./gradlew --stop` then re-export before building.
- **XAMPP MySQL isn't always running:** `tasklist //FI "IMAGENAME eq mysqld.exe"`,
  start with `cmd //c "C:\xampp\mysql_start.bat"`. **Don't trust
  `mysqld.exe` running as proof it's XAMPP's** — this machine also has
  an unrelated `MySQL80` Windows service on port 3306; check the actual
  listening port against `backend/.env`'s `DB_PORT` (XAMPP's own MariaDB
  is 3306 here, per `my.ini`). Same trap for the `mysql` CLIENT: bare
  `command -v mysql` can resolve to that other install's client ahead of
  `C:\xampp\mysql\bin\mysql.exe` on PATH, and pointed at the wrong
  server (that other install, on 3306) even XAMPP's own client fails
  with `caching_sha2_password could not be loaded` — an old-client-vs-
  new-server plugin gap, not a broken client (it works fine against
  XAMPP's real MariaDB on 3306). **Fixed 2026-09-26 (33) in all 29
  `backend/scripts/*.sh` that talk to MariaDB directly**: their shared
  `find_bin()` now tries the explicit XAMPP path before falling back to
  `command -v`, and `XAMPP_MYSQL_PORT` now defaults to `backend/.env`'s
  own `DB_PORT` instead of a hardcoded 3306 guess — verified by running
  `verify-sprint1-auth.sh`/`verify-sprint0.sh` clean with zero env var
  overrides. Any NEW script written the same way should copy this
  pattern, not the old `command -v`-first one.
- **XAMPP's Apache PHP was upgraded 2026-09-26** (was 8.0.30, which
  can't load the backend's 8.1+ `readonly` properties) — `C:\xampp\php`
  is now a copy of `C:\php-8.3.13`, and a new `Listen 8081`/
  `<VirtualHost *:8081>` vhost in `httpd-vhosts.conf` (DocumentRoot
  `backend/public`) serves the API through Apache, matching
  `docs/SETUP.md` "Serving through Apache" for real. Old PHP kept at
  `C:\xampp\php-8.0.30-backup`. See `backend/DEVLOG.md` 2026-09-26 (32).
- **That PHP upgrade silently broke `ext-curl` under Apache specifically
  (fixed same day, (34))** — a real symptom: the dashboard's AI badge
  showed offline while the CLI worker could still reach Ollama. (The AI
  badge, Ollama and the worker are all gone since 0029, but this DLL
  problem still applies to every other `ext-curl` caller: ORS routing,
  FCM.)
  Cause: `php_curl.dll`'s real dependency DLLs (`libcrypto-3-x64.dll`/
  `libssl-3-x64.dll`/`libssh2.dll`/`nghttp2.dll`, confirmed via
  `C:\xampp\php\deplister.exe ext\php_curl.dll`) live in `C:\xampp\php`,
  which CLI `php.exe` finds fine (its own directory), but Apache's
  process is `httpd.exe` in `C:\xampp\apache\bin` — which has
  same-NAMED but differently-built copies of those four DLLs — so
  Windows' DLL search order resolves `php_curl.dll`'s dependencies
  against the WRONG copies and the load silently fails. The real error
  only shows in **`C:\xampp\php\logs\php_error_log`** (PHP's own log,
  separate from Apache's `httpd\logs\error.log` — easy to miss), as
  `PHP Startup: Unable to load dynamic library 'curl' ... module could
  not be found`. **Fix (not git-tracked — lives outside the repo)**:
  `C:\xampp\apache\conf\extra\httpd-xampp.conf` has four `LoadFile`
  directives for those DLLs from `C:/xampp/php/`, placed BEFORE
  `LoadModule php_module`, same pattern the file already used for
  `php8ts.dll`. **If XAMPP's Apache PHP is ever swapped again, re-add
  these** — nothing in `git status` will flag their loss. See
  `backend/DEVLOG.md` 2026-09-26 (34).
- **Browser tool:** a backgrounded tab can show a stale screenshot while
  the DOM is already correct. Prefer `read_page`/`get_page_text`.
- **Case-sensitivity in test assertions** — `.status-pill` etc. render
  uppercase via CSS while the DOM string isn't; caused false failures.
- **Windows Firewall silently drops inbound** to a dev port unless a
  rule allows it. **Android blocks cleartext HTTP** (API 28+) — needs
  `network_security_config.xml` (since 2026-10-28 the cleartext allowance is in the debug config only; a release APK blocks it). **Capacitor's `https://localhost`
  fetching a plain `http://` backend is a SEPARATE mixed-content block**
  (`server.androidScheme:'http'` fixes it; symptom is an opaque `Failed
  to fetch`). `ACCESS_FINE_LOCATION`/`COARSE` must be declared in the
  manifest or geolocation silently fails. Vite needs `server.host:true`
  + the real LAN IP (not `localhost`, which means the phone itself).
- **`adb` is not on PATH** — full path is
  `C:\Users\JAYSON~1\AppData\Local\Android\Sdk\platform-tools\adb.exe`.
- **A named PDO parameter can only bind ONE placeholder occurrence**
  under native prepares (`ATTR_EMULATE_PREPARES => false`) — bit
  `GET /incidents/nearby` for its whole lifetime, fixed.
- **`mobile/.env.local`'s `VITE_API_BASE_URL` silently leaks into EVERY
  `vite build` run on this machine**, not just intentional local dev
  builds — Vite auto-loads `.env.local` with no opt-in, so a bare `cd
  mobile && npx vite build` meant to produce the real APK for a Tanod's
  phone bakes in `http://localhost:8081` instead of the real domain,
  invisible on this workstation (where that address is correct) but
  fatal on a real device's own network (`localhost` there means the
  phone itself — nothing listens, every API call fails instantly, the
  whole app runs off cache). Always build a real-device APK with
  `VITE_API_BASE_URL=https://api.baranguardph.win/api/v1` set explicitly
  (an explicit process env var beats `.env.local` in Vite's precedence) —
  see HANDOFF.md's own build command. Verify by grepping the built bundle
  (`dist/assets/index-*.js`) for the real domain before trusting a build,
  not just the source-level default. Found 2026-09-28 chasing a real
  device report of the app being permanently offline.

---

## 9. Verification suites (current totals in the 2026-10-28 note; the table is historical per-suite counts from 2026-10-01; disposable DBs only)

**Re-measured 2026-10-28 (docs reconciliation, run on the working tree):** `php backend/scripts/count-routes.php` 103 routes / 27 files; 45 migrations (0001-0045); 39 `backend/scripts/verify-*.sh` plus 5 `verify-*.php/.mjs` there (44), 5 in `mobile/scripts`, 1 in `web/scripts`; `node web/scripts/verify-web-wiring.mjs` 938 passed, 0 failed; `web/tests` `npm test` 736 tests, 735 passed and 1 failed in the known order-sensitive map test 'SOS markers are never clustered' (a second run showed 734/2, same test family; it passes alone); mobile `npx vitest run` 30 files, 193 tests, all passed; mobile `verify-local-schema.mjs` 266 passed, 0 failed. The older per-suite figures in the table below are historical and were not all re-run. Nothing here is device-verified.

| Script | Checks |
|---|---|
| `verify-sprint0.sh` | 19 |
| `verify-sprint1-auth.sh` | 23 |
| `verify-w2-reports.sh` | 31 |
| `verify-w3-w4-dispatch-gis.sh` | 38 |
| `verify-sprint1-remaining.sh` | `ALL CHECKS PASSED` (count not captured) |
| `verify-scheduler.sh` (was `verify-scheduler-fatigue.sh` before 2026-10-13) | ALL CHECKS PASSED (flag assertions replaced by 404 checks for the removed routes) |
| `verify-devices-map-packages.sh` | 57 |
| `verify-duty-status-map-upload.sh` | 49 |
| `verify-public-transparency.sh` | 17 |
| `verify-device-signature.sh` | 21 |
| `verify-sprint4.sh` | `ALL CHECKS PASSED` (count not captured) |
| `verify-sprint4-phase2-3.sh` | 72 |
| `verify-sprint7-retention.sh` | 82 |
| `verify-sprint7-audit.sh` | 59 |
| `verify-sprint7-pentest-incidents.sh` | 56 |
| `verify-b2-pentest-remaining-resources.sh` | 59 |
| `verify-sprint3.sh` | 43 |
| `verify-f9-sms-broadcast-idempotency-index.sh` | 15 |
| `verify-second-responder.sh` | 25 |
| `verify-routing.sh` | 23 (real-ORS block SKIPs, not fails, if no key) |
| `verify-device-session.sh` | 20 |
| `verify-evidence-upload.sh` | 19 |
| verify-f5 / f6 / f8 suites | 16 / 8 / 8 |
| verify-h16 lifecycle suite | 30 |
| `verify-referrals.sh` (new 2026-10-01) | 147 |
| `verify-roster-accomplishment.sh` (new 2026-10-01) | 332 (a final run prints `ALL CHECKS PASSED`; the roster half of the earlier scheduler run likewise, counts not captured) |
| `verify-school-zones.sh` (new 2026-10-01) | 213 |
| `restore-drill.sh` | 12 (real DB; last run 2026-09-26, not re-run since 0030-0033) |
| `verify-web-wiring.mjs` | 733 passed, 0 failed (2026-10-01) |
| `web/tests` (`npm test`) | 542 passed, 0 failed (2026-10-01; the map test 'SOS markers are never clustered' looks order-sensitive/flaky) |
| `mobile: verify-local-schema.mjs` | 230 passed, 0 failed (`tsc --noEmit`: 1 and lint: 18 errors, both pre-existing) |

All use a disposable database + disposable app user + throwaway port,
never the real `baranguard` database. `web/tests` needs no backend at
all: it renders every page in jsdom against a fake `fetch` (one-time
`npm install` in `web/tests/`; the dashboard itself stays npm-free).

> **Lesson learned the hard way (2026-09-05 to 2026-09-12):** migration
> 0011 added `user.is_suspended`; every suite that logs in but applies
> only its own sprint's migration subset 500'd at setup and never
> reached an assertion, while this table said green for a week. Found
> and fixed twice (4 suites, then 9 more found by systematically
> checking every suite, not just the ones in front of you). **Never pin
> a suite to a partial schema** — apply the full migration chain. When
> you find this class of bug, check every suite, not just the current one.

---

## 10. Where the full detail lives

- **`docs/Baranguard_Master_Reference_FINAL .md`** — section numbers and DDL (see the precedence note at the top). §5
  schema DDL, §6 per-endpoint contracts, §7 role matrix, §8 design
  system, §9 screen specs, §11 retention table.
- **`backend/DEVLOG.md`** — every decision and why. **Don't read front
  to back.** `grep` for the feature you're touching.
- **`docs/ROADMAP_TO_COMPLETION.md`** — what's left (defense, ISO 25010, UAT).
- **`docs/HANDOFF.md`** — current state and next step.
- Controller/component class docs carry the resolved decisions for that
  file specifically, usually the fastest answer.
