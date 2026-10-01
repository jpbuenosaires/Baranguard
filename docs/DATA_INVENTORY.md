# Baranguard — Personal Data Inventory

Drafted 2026-09-26 as part of closing H-14 (2026-09-24 external
business-rules audit, `docs/REMAINING.md` §H: "privacy governance
incomplete"). This is the record of processing activities the Data
Privacy Act of 2012 (RA 10173) and its IRR expect a personal information
controller to maintain — not a new system, a written inventory of what
the system in `docs/REFERENCE.md` §4/§5 already stores.

**Reconciled 2026-10-01 for migration 0029** (Electronic Blotter and the
whole local-AI pipeline removed — `backend/migrations/0029_remove_blotter_
and_ai_pipeline.sql`, `docs/REFERENCE.md` §1/§4). `blotter_record`,
`blotter_revision`, `ai_processing_log` and `ai_evaluation_run` no longer
exist; every flow, processor and retention rule that depended on them is
removed below or marked historical. Not yet applied to either real DB as
of this writing (REFERENCE.md §4) — until it is, those four tables still
physically exist there.

**This is a snapshot, not a log.** Re-derive it from the actual schema
(`backend/migrations/`) whenever a migration adds, removes, or
reclassifies a personal-data column — don't hand-edit it out of sync
with the code the way `docs/AUDIT_2026-09-07.md`'s findings drifted from
the reference before being reconciled.

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
| Citizen reports | `citizen_report` (submitter-supplied name/contact/description) | Ordinary personal data; may contain sensitive content in the free text |
| Messaging | `sms_log` (`message_body`, phone number), `sms_subscriber`, `notification`/`notification_target`/`notification_delivery` | Ordinary personal data (phone numbers, message content) |
| Audit | `audit_log` | Identifiers and statuses only (§2 Rule 8) — never narrative, coordinates or credentials |
| Employment/scheduling | `shift_schedule`, `duty_status`, `fatigue_flag` | Ordinary personal data (Tanod work records) |
| Authentication | `user.password_hash`, `auth_session` | Ordinary personal data; hashed, never stored in plaintext |

## 2. Purpose of processing

Barangay emergency dispatch, incident record-keeping, GPS-based Tanod
safety and accountability, SOS response, and citizen report intake.
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
- **Citizen reports**: consent (the citizen submits voluntarily) plus
  the barangay's public-safety mandate.

## 4. Who can access what (see `docs/REFERENCE.md` §3 for the full role matrix)

`raw_narrative` is Secretary-only (Rule 1) — the single sharpest access
restriction in the system, because it is the only narrative field and
carries unredacted personal/sensitive content. The incident party fields
(`complainant_name`, `respondent_name`, `complainant_contact_number`) are
Secretary-only on read as well. Admin gets less here on purpose. Every other category
above follows the ordinary role matrix (Admin/Secretary/Punong
Barangay/Tanod), tenant-isolated per barangay (Rule 2).

## 5. Retention (see `docs/REFERENCE.md` §11 and `backend/services/retention/RetentionService.php`)

Code-enforced constants (§2 Rule 10 — a change needs architecture
review, not a runbook edit): `incident` record 7 years
(`RECORD_RETENTION_DAYS`), `evidence_attachment` with its incident,
`audit_log` 7 years, `citizen_report` 1 year (unconverted only),
`sms_log` 1 year, `gps_track`/`duty_status`/`shift_schedule`/
`notification` 1 year each (H-15, 2026-09-26), `mobile_device` secret
columns scrubbed 90 days after deactivation. Legal hold exempts the
tables that carry it.

**`raw_narrative` — OPEN POLICY DECISION, not decided here.** The rule
in `RetentionService` is unchanged: hard-purged (set NULL,
`raw_narrative_purged_at` stamped) at the 90-day ceiling from
`created_at`, or 30 days after an approved redaction if one existed.
Since 0029 nothing can ever approve a redaction, so in practice **every
incident's narrative is permanently destroyed at 90 days with no
redacted or summarized replacement kept anywhere** (legal hold is the
only exception). Whether that is acceptable — or whether the retention
window, a manual Secretary-authored summary, or the barangay's binder
record is the intended continuation — is a policy call for the barangay
and an architecture review (Rule 10), not something this document or a
code session settles.

**Historical (removed by 0029, no longer in force):** retention rules
for `blotter_record`/`blotter_revision`, `ai_processing_log` (1 year)
and AI Tools jobs (90 days).

## 6. Third-party disclosure

- **DILG BIMSS/KPIS and Lupon ng Tagapamayapa**: Baranguard no longer
  generates a blotter handoff draft or a Lupon packet (removed 2026-10-01,
  migration 0029). Any transfer of case information to BIMSS/KPIS or to
  the Lupon is now done by barangay staff outside this system, from the
  barangay's own binders.
- **GSM SMS gateway**: outbound messages transit the barangay's own
  tethered phone/SIM, not a third-party cloud API (Semaphore was removed
  2026-09-23 for exactly this reason — see `backend/DEVLOG.md`).
- **OpenRouteService (ORS)**: dispatch routing sends the caller's live
  coordinates and the incident location to ORS (`OrsClient.php`); this is
  an external service and should be reviewed as a disclosure.
- **Firebase Cloud Messaging (FCM)**: push notifications transit FCM
  (`raw_narrative` is barred from it, Rule 1).
- **Cloudflare**: the production hostnames (`baranguardph.win`,
  `api.baranguardph.win`) are fronted by a Cloudflare Named Tunnel
  (REFERENCE.md §1), so web/API traffic transits Cloudflare. This
  supersedes the original "LAN-only, no cloud" framing of this inventory.
- **No AI processor**: the local Ollama/SEA-LION pipeline was removed
  2026-10-01; no AI service, cloud or local, processes personal data.
  There is no analytics vendor or ad network.

## 7. Data Protection Officer

**Not yet formally designated.** The natural fit given existing statutory
responsibility is the Barangay Secretary, who is already RA 7160
§394(c)'s designated records custodian and the only role with
`raw_narrative` access — but formally designating a DPO is a barangay
council action (a Sangguniang Barangay resolution or equivalent), not
something a codebase can resolve. Flagged here as the open item; see
`docs/REMAINING.md` §H, H-14.
