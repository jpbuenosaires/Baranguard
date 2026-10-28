# Baranguard — Personal Data Inventory

Purpose: record of the personal data the system stores, as RA 10173 (Data
Privacy Act of 2012) and its IRR expect a controller to maintain. Not a new
system; a written inventory of what `docs/REFERENCE.md` §4/§5 already stores.
Status: draft, not reviewed by a DPO. Drafted 2026-09-26; last updated 2026-10-28.

**Reconciled 2026-10-01 for migration 0029** (Electronic Blotter and the
whole local-AI pipeline removed — `backend/migrations/0029_remove_blotter_
and_ai_pipeline.sql`, `docs/REFERENCE.md` §1/§4). `blotter_record`,
`blotter_revision`, `ai_processing_log` and `ai_evaluation_run` no longer
exist; every flow, processor and retention rule that depended on them is
removed below or marked historical. Not yet applied to either real DB as
of this writing (REFERENCE.md §4) — until it is, those four tables still
physically exist there.

**Extended 2026-10-01 for migrations 0030-0033** (tanod workflow:
availability, accomplishment reports, referrals, Safer School Zones). The
new categories are the "(2026-10-01)" rows in §1. They are written and
verified on disposable DBs only; not applied to either real DB, so no real
personal data is held in them yet. **Retention for every new category is
pending a policy decision (Rule 10).** Wave 3 (2026-10) added placeholder
retention rules for six of them (`tanod_availability`,
`accomplishment_report`/`accomplishment_entry`, `school_checkin`,
`incident_referral`, `ssz_term_report`; `document_scan` was dropped by migration 0041); each is switched OFF (no period set), so **nothing is purged from
them today** (§5).

**Extended 2026-10 for migration 0037** (paper approvals and scanned
signed copies): `document_scan` (§1) and the `approval_mode`/`paper_*`
columns on `accomplishment_report` and `ssz_term_report`. **Dropped again by migration 0041 (print-only: reports are signed on paper outside the app and no signature or scan is stored; older scan/paper data is dropped).**

**This is a snapshot, not a log.** Re-derive it from the actual schema
(`backend/migrations/`) whenever a migration adds, removes, or
reclassifies a personal-data column — don't hand-edit it out of sync
with the code.

## 1. Categories of personal data processed

| Category | Example columns | Sensitivity |
|---|---|---|
| Identity (staff/Tanod) | `user.full_name`, `user.username` | Ordinary personal data |
| Identity (complainant/respondent) | `incident.complainant_name`, `incident.respondent_name`, `incident.complainant_contact_number` | Ordinary personal data; contact number is also processed for SOS fallback |
| Case narrative | `incident.raw_narrative` (live); `incident.redacted_narrative`, `redaction_approved_at/by` (legacy columns kept by 0029 — nothing writes them any more) | May contain sensitive personal information (health, criminal-allegation content) — this is the single most sensitive field in the system, hence Rule 1's access restriction. There is no longer any redacted replacement for it (see §5) |
| Location | `incident.latitude/longitude`, `gps_track.latitude/longitude`, `dispatch.route_json` | Ordinary personal data; precise geolocation of Tanod personnel and incident sites |
| Device/technical | `mobile_device.device_id`, `fcm_token`, `device_public_key_pem` | Ordinary personal data (device identifiers) |
| Contact (broadcast) | `sms_subscriber.phone_number`, `consent_at`, `consent_source` | Ordinary personal data, consent-tracked |
| Evidence | `evidence_attachment` files (photo/audio) | May contain sensitive personal information depending on content |
| Citizen reports (legacy) | `citizen_report` (submitter-supplied name/contact/description). No new rows: public intake removed 2026-10-07, inbox retired 2026-10-17; existing rows kept | Ordinary personal data; may contain sensitive content in the free text |
| Messaging | `sms_log` (`message_body`, phone number; since 2026-10-28 inbound human texts are stored too: `direction='inbound'`, `sender_number`, body; a rejected SOS envelope is logged without its body), `sms_subscriber`, `notification`/`notification_target`/`notification_delivery` | Ordinary personal data (phone numbers, message content) |
| Audit | `audit_log` | Identifiers and statuses only (§2 Rule 8) — never narrative, coordinates or credentials |
| Employment/scheduling | `shift_schedule`, `duty_status` | Ordinary personal data (Tanod work records) |
| Authentication | `user.password_hash`, `auth_session` | Ordinary personal data; hashed, never stored in plaintext |
| Official/approver identity (2026-10-01) | `user.official_title`, `user.approval_authority` | Ordinary personal data (staff title printed under signatures). Retention: pending decision, no purge job |
| Tanod availability (2026-10-01) | `tanod_availability.windows_json`, period, review note | Ordinary personal data about a named staff member's time. Retention: pending barangay/COA confirmation (placeholder rule, purge OFF; §5) |
| Accomplishment reports (2026-10-01) | `accomplishment_entry.accomplishment_text`, `work_date`, `start_time`/`end_time`, `duration_minutes`, `suggested_duration_minutes`, `duration_flag`; `accomplishment_report` month/status (open/prepared/returned) | Ordinary personal data but sensitive in practice: a named person's hours and activities, and the likely attendance evidence for honorarium. Free text could be typed to include third-party details. Retention: pending barangay/COA confirmation (placeholder rule, purge OFF; §5) |
| Referral metadata (2026-10-01) | `incident_referral` (`referred_to`, `other_text`, `contact_name` = a responder/unit/official, never a citizen, `referred_at`, `reference_no`, `created_by`) | Ordinary personal data (staff/responder names, handoff times). The referral log endpoint returns no narrative, names or coordinates. Rows are deleted with their incident by the retention cascade (so they follow the incident's clock); a separate placeholder age rule exists but is OFF pending barangay/COA confirmation (§5) |
| School inventory (2026-10-01) | `school` (name, address, optional coordinates, `focal_person`, `focal_contact`, remarks) | Ordinary personal data limited to school staff contact (a named focal person and phone number). No student data of any kind. Retention: **deliberately NOT time-purged, by decision** (standing master list, retired via `is_active`; §5), not a gap |
| School check-ins (2026-10-01) | `school_checkin` (`user_id`, `school_id`, `checked_in_at`, `checked_out_at`) | Ordinary personal data: where and when a named tanod was deployed. No coordinates stored. Retention: pending barangay/COA confirmation (placeholder rule, purge OFF; §5) |
| Signed-paper scans (2026-10; **dropped by migration 0041**) | Nothing is stored any more: the `document_scan` table, the files under `SCANS_DIR` and the `paper_*`/`approval_mode` columns are removed. Reports are printed and signed on paper outside the app. | Not applicable | Not applicable |
| Annex C-1 summary fields (2026-10-01) | `incident.school_id`, `c1_summary`, `c1_action_taken`, `c1_status_notes` | Designed as short, factual, non-identifying text (no victim/student names), separate from `raw_narrative`, which stays on the one-year (365-day) purge. Code enforces length only; free text can still be typed carelessly. Retention: pending decision; no purge rule exists for these columns, so they currently live as long as the incident |
| Term reports (2026-10-01) | `ssz_term_report` (aggregate counts, prepared_by/approved_by, mayor-office and DILG received-by names and dates) | Aggregate counts plus names of staff and receiving officers. Retention: pending barangay/COA confirmation (placeholder rule, purge OFF; §5) |

## 2. Purpose of processing

Barangay emergency dispatch, incident record-keeping (walk-in and phone
reports are logged as incidents by staff), GPS-based Tanod safety and
accountability, and SOS response.
Baranguard no longer finalizes, amends or exports blotter entries —
barangays keep the blotter and Lupon records in their own binders, and
DILG BIMSS/KPIS remains the mandated case ledger (`docs/REFERENCE.md`
§1 — Baranguard complements BIMSS, never replaces it).

## 3. Legal basis

- **Incident records**: RA 7160 (Local Government Code) §394(c)
  designates the Barangay Secretary as records custodian (basis for the
  Secretary-only access to `raw_narrative`); processing is necessary for
  the performance of a public function. Legal basis as stated here is
  carried over from the original draft, not re-reviewed.
- **SMS broadcast subscriber list**: consent (`sms_subscriber.consent_at`
  / `consent_source`, migration 0018).
- **Employee/Tanod records** (shifts, duty status, GPS while on duty):
  necessary for the barangay's management of its own personnel.
- **Citizen reports (legacy rows only)**: consent (the citizen submitted
  voluntarily) plus the barangay's public-safety mandate. No new rows are created.

## 4. Who can access what (see `docs/REFERENCE.md` §3 for the full role matrix)

`raw_narrative` is read only by the Secretary and, since 2026-10-13, the
Chief Tanod (Admin) on a web session (Rule 1 as amended; the Admin's phone
session never receives it). The incident party fields
(`complainant_name`, `respondent_name`, `complainant_contact_number`) follow
the same read rule; `complainant_name` is edited by the Secretary only. Accomplishment-entry text is shown only
to the owning tanod and to admin/secretary/Punong Barangay of the same
barangay (cross-tenant is 404); the Referral Log and school-term reports
are aggregate/delegation views. Every other category
above follows the ordinary role matrix (Admin/Secretary/Punong
Barangay/Tanod), tenant-isolated per barangay (Rule 2).

## 5. Retention (see `docs/REFERENCE.md` §11 and `backend/services/retention/RetentionService.php`)

Code-enforced constants (§2 Rule 10 — a change needs architecture
review, not a runbook edit): `incident` record 7 years
(`RECORD_RETENTION_DAYS`), `evidence_attachment` with its incident,
`audit_log` 7 years, `citizen_report` 1 year (unconverted only; legacy rows),
`sms_log` 1 year, `gps_track`/`duty_status`/`shift_schedule`/
`notification` 1 year each (H-15, 2026-09-26), `mobile_device` secret
columns scrubbed 90 days after deactivation. Legal hold exempts the
tables that carry it.

**`raw_narrative` — one year (decided 2026-10-17).** The rule
in `RetentionService` is unchanged: hard-purged (set NULL,
`raw_narrative_purged_at` stamped) 365 days after `created_at`. There is no
redaction path, so **every incident's narrative is permanently destroyed at
one year (365 days; set by the owner 2026-10-17, was 90) with no redacted
or summarized replacement kept** (legal hold is the only exception). The
barangay's binder remains the long-term record. Any further change needs an
architecture review (Rule 10).

**New 2026-10 tables: retention PENDING barangay/COA confirmation —
placeholder rules exist, purge is OFF.** `RetentionService::NEW_TABLE_RULES`
(Rule 10: code constants, never config) now carries one rule per type
below, each with `days = null` and status `pending_barangay_confirmation`.
No duration was invented and no legal retention rule is cited (needs an
architecture review and a barangay council decision). While `days` is
null the rule is a no-op: it runs no query, writes no audit row, and
reports `{purged:0, held:0, note:'pending barangay confirmation'}`;
`php scripts/retention-job.php --list` shows each rule and its pending
state. A full non-dry-run job therefore deletes nothing from these tables
(asserted by `verify-retention-new-tables.sh`).

| Data | Purpose | Who can read | Retention today | What the job will do once a number is set |
|---|---|---|---|---|
| `tanod_availability` | Tanod's stated availability, input to rosters | Owning tanod; admin/secretary/PB of the same barangay | Pending barangay/COA confirmation (placeholder) | Delete rows whose `period_end` is older than the period, one transaction per row, first nulling `shift_schedule.source_availability_id` on shifts that cite it (the shift keeps its own 1-year rule) |
| `accomplishment_report` + `accomplishment_entry` | Monthly accomplishment report = attendance evidence for honorarium | Owning tanod; entry text also admin/secretary/PB of the same barangay | Pending barangay/COA confirmation (placeholder) | Delete only reports with status `prepared` (retention keys on prepared since 0041; the backend retention code is authoritative for the aging column), together with their entries; never an open/returned report; one transaction per report |
| `school_checkin` | Where/when a tanod was deployed to a school (MC 2026-037 reporting) | Admin/secretary/PB of the same barangay (tanod writes own) | Pending barangay/COA confirmation (placeholder) | Delete rows whose `checked_in_at` is older than the period |
| `incident_referral` | Log of matters referred to PNP/BFP/EMS/officials | Admin/secretary/PB of the same barangay (tanod sees own referrals on their incidents) | Pending barangay/COA confirmation (placeholder); independently, the existing 7-year incident purge still deletes a referral with its incident | Delete rows whose `referred_at` is older than the period, except referrals of an incident under `legal_hold` (counted as `held`) |
| `document_scan` | Dropped by migration 0041 (print-only) | Not applicable | Not applicable | Table and files removed |
| `ssz_term_report` (Annex D) | Per-term aggregate report to the Mayor's office/DILG | Admin/secretary/PB of the same barangay | Pending barangay/COA confirmation (placeholder, period null, purge OFF) | Delete only reports with status `submitted`, aged from `mayor_office_received_at` (the Secretary-entered submission date; the table stores no other submission timestamp), never a draft/prepared report; one transaction per report |

**`school` (Annex B inventory) has no retention rule, deliberately.** It
is a standing master list, not time-bound activity data: it holds no
student data (school name/address, optional coordinates, a staff focal
person's name and phone), it is referenced by check-ins and incident C-1
fields, and a school that closes or leaves the program is retired by
setting `is_active = 0`, never by age. Not purging it is a decision, not
a gap; revisit only if the barangay wants the focal-person contact
removed on a clock (that would be a column scrub, not a row purge).

Not covered by any rule, still accumulating with no placeholder:
`user.official_title`/`approval_authority`
and the `incident.c1_*` columns. Accomplishment reports are the likely
attendance evidence for honorarium payroll, but what the treasurer/COA
accepts is unconfirmed (HANDOFF.md). Backups are not covered by any of
this (Rule 11 reminder in `retention-job.php`).

**Historical (removed by 0029, no longer in force):** retention rules
for `blotter_record`/`blotter_revision` and `ai_processing_log`.

## 6. Third-party disclosure

- **DILG BIMSS/KPIS and Lupon ng Tagapamayapa**: Baranguard no longer
  generates a blotter handoff draft or a Lupon packet (removed 2026-10-01,
  migration 0029). Any transfer of case information to BIMSS/KPIS or to
  the Lupon is now done by barangay staff outside this system, from the
  barangay's own binders.
- **GSM SMS gateway**: outbound messages and inbound texts (stored in `sms_log` since 2026-10-28, same 1-year `sms_log` retention) transit the barangay's own
  tethered phone/SIM, not a third-party cloud API (Semaphore was removed
  2026-09-23 for exactly this reason — see `backend/DEVLOG.md`).
- **OpenRouteService (ORS)**: dispatch routing sends the caller's live
  coordinates and the incident location to ORS (`OrsClient.php`); this is
  an external service and should be reviewed as a disclosure.
- **Firebase Cloud Messaging (FCM)**: push notifications transit FCM
  (`raw_narrative` is barred from it, Rule 1).
- **Cloudflare**: the workstation's hostnames (`baranguardph.win`,
  `api.baranguardph.win`) are fronted by a Cloudflare Named Tunnel
  (REFERENCE.md §1), so web/API traffic transits Cloudflare while the
  tunnel runs. The system is not deployed at any barangay; the tunnel is
  outside the evaluated scope and may be offline.
- **No AI processor**: the local Ollama/SEA-LION pipeline was removed
  2026-10-01; no AI service, cloud or local, processes personal data.
  There is no analytics vendor or ad network.

## 7. Data Protection Officer

**Not yet formally designated.** The natural fit given existing statutory
responsibility is the Barangay Secretary, who is already RA 7160
§394(c)'s designated records custodian and the only role with
`raw_narrative` access — but formally designating a DPO is a barangay
council action (a Sangguniang Barangay resolution or equivalent), not
something a codebase can resolve. Flagged here as the open item.
