# Baranguard — Personal Data Inventory

Drafted 2026-09-26 as part of closing H-14 (2026-09-24 external
business-rules audit, `docs/REMAINING.md` §H: "privacy governance
incomplete"). This is the record of processing activities the Data
Privacy Act of 2012 (RA 10173) and its IRR expect a personal information
controller to maintain — not a new system, a written inventory of what
the system in `docs/REFERENCE.md` §4/§5 already stores.

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
| Case narrative | `incident.raw_narrative`, `incident.redacted_narrative` | May contain sensitive personal information (health, criminal-allegation content) — this is the single most sensitive field in the system, hence Rule 1's access restriction |
| Location | `incident.latitude/longitude`, `gps_track.latitude/longitude`, `dispatch.route_json` | Ordinary personal data; precise geolocation of Tanod personnel and incident sites |
| Device/technical | `mobile_device.device_id`, `fcm_token`, `device_public_key_pem` | Ordinary personal data (device identifiers) |
| Contact (broadcast) | `sms_subscriber.phone_number`, `consent_at`, `consent_source` | Ordinary personal data, consent-tracked |
| Evidence | `evidence_attachment` files (photo/audio) | May contain sensitive personal information depending on content |
| Employment/scheduling | `shift_schedule`, `duty_status`, `fatigue_flag` | Ordinary personal data (Tanod work records) |
| Authentication | `user.password_hash`, `auth_session` | Ordinary personal data; hashed, never stored in plaintext |

## 2. Purpose of processing

Barangay emergency dispatch, incident/blotter record-keeping under RA
7160 §394(c), GPS-based Tanod safety and accountability, SOS response,
citizen report intake, and legally mandated case documentation feeding
DILG BIMSS/KPIS (`docs/REFERENCE.md` §1 — Baranguard complements BIMSS,
never replaces it).

## 3. Legal basis

- **Incident/blotter records**: RA 7160 (Local Government Code) §394(c)
  designates the Punong Barangay Secretary as records custodian;
  processing is necessary for the performance of a public function.
- **SMS broadcast subscriber list**: consent (`sms_subscriber.consent_at`
  / `consent_source`, migration 0018).
- **Employee/Tanod records** (shifts, duty status, GPS while on duty):
  necessary for the barangay's management of its own personnel.
- **Citizen reports**: consent (the citizen submits voluntarily) plus
  the barangay's public-safety mandate.

## 4. Who can access what (see `docs/REFERENCE.md` §3 for the full role matrix)

`raw_narrative` is Secretary-only (Rule 1) — the single sharpest access
restriction in the system, because it is the only field guaranteed to
still carry unredacted personal/sensitive content. Every other category
above follows the ordinary role matrix (Admin/Secretary/Punong
Barangay/Tanod), tenant-isolated per barangay (Rule 2).

## 5. Retention (see `docs/REFERENCE.md` §11 and `backend/services/retention/RetentionService.php`)

Every category above has an explicit, code-enforced retention period —
`raw_narrative` (30/90 days), redacted incident/blotter/evidence (7
years), citizen reports (1 year unconverted), SMS logs (1 year), AI
processing logs (1 year), device secrets (scrubbed 90 days after
deactivation), and — as of the 2026-09-26 H-15 sign-off — `gps_track`,
`duty_status`, `shift_schedule`, and `notification` (1 year each). None
of this is a config value an operator can quietly shorten or lengthen
(§2 Rule 10); a change requires the same architecture-review process
that set these numbers.

## 6. Third-party disclosure

- **DILG BIMSS/KPIS**: the redacted blotter record is manually
  transcribed by the Secretary (Baranguard's Blotter Assistant tool
  drafts, never auto-submits — `docs/REFERENCE.md` §7).
- **Lupon ng Tagapamayapa**: a generated PDF packet for cases requiring
  conciliation (no system account — `docs/REFERENCE.md` §3).
- **GSM SMS gateway**: outbound messages transit the barangay's own
  tethered phone/SIM, not a third-party cloud API (Semaphore was removed
  2026-09-23 for exactly this reason — see `backend/DEVLOG.md`).
- **No cloud AI, no analytics vendor, no ad network**: the AI pipeline
  runs on local Ollama only (§2 Rule 5); there is no external service
  this system sends personal data to as a matter of routine operation.

## 7. Data Protection Officer

**Not yet formally designated.** The natural fit given existing statutory
responsibility is the Barangay Secretary, who is already RA 7160
§394(c)'s designated records custodian and the only role with
`raw_narrative` access — but formally designating a DPO is a barangay
council action (a Sangguniang Barangay resolution or equivalent), not
something a codebase can resolve. Flagged here as the open item; see
`docs/REMAINING.md` §H, H-14.
