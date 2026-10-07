# Baranguard — Privacy Impact Assessment (PIA)

Drafted 2026-09-26 to close H-14 (2026-09-24 external business-rules
audit, `docs/REMAINING.md` §H: "privacy governance incomplete — no PIA,
DPO role, notices, data inventory"). Companion documents:
`docs/DATA_INVENTORY.md` (what is collected) and `docs/PRIVACY_NOTICES.md`
(what data subjects are told). This PIA assesses risk and mitigation; it
does not restate the inventory.

**Reconciled 2026-10-01 for migration 0029** (Electronic Blotter and the
local-AI pipeline removed). Risks and mitigations tied to redaction,
Ollama or blotter retention are removed or marked historical below.

## 1. System description

Baranguard is an offline-first, single-workstation Barangay Intelligence
and Emergency Dispatch System for four barangays in Pilar, Sorsogon
(`docs/REFERENCE.md` §1). It processes incident reports, GPS location of
on-duty Tanod, SOS alerts and citizen reports. It no longer produces or
stores blotter entries or Lupon packets — barangays keep those in their
own binders; DILG BIMSS/KPIS remains the case ledger. Note: the
workstation is now reachable through a Cloudflare Named Tunnel
(REFERENCE.md §1), so "LAN-only" no longer describes the deployment.

## 2. Necessity and proportionality

- **Raw narrative collection** supports dispatch and the Secretary's
  records-custodian role (RA 7160 §394(c)) and is the system's single
  highest-risk field — mitigated by Rule 1 (Secretary-only access, never
  leaves the system) and the 90-day hard purge in §11. **OPEN POLICY
  DECISION:** with the redaction pipeline gone there is no redacted
  replacement, so the narrative is destroyed outright at 90 days (legal
  hold excepted). Whether that is the intended outcome is undecided and
  is not settled by this PIA.
- **GPS tracking is limited to on-duty Tanod**, for dispatch routing and
  personnel safety (SOS). It is not continuous surveillance of an
  off-duty person's location — `duty_status` gates whether tracking is
  active, and `docs/REFERENCE.md` §8's gotcha list documents the real
  device behavior (tracking stops when off-duty, subject to the
  background-location permission fix in HANDOFF.md's C7 entry).
- **Tanod workflow data (added 2026-10-01, migrations 0030-0033, not yet
  applied to a real DB):** availability windows, monthly accomplishment
  entries with hours, referral metadata, a school inventory (with a school
  focal person's name and phone), school check-ins and Annex C-1 summary
  fields. Purpose: replace the missing DTR with an auditable
  accomplishment-report path, build rosters, record that large incidents
  were referred rather than handled, and prepare the school-zone annexes.
  Proportionality measures: no student or victim names anywhere (C-1 text
  is meant to be short, factual and non-identifying, but that is a
  convention, not enforced); check-ins store no coordinates; the referral
  log shows no narrative, names or contacts; audit metadata carries
  ids/statuses only. **Retention for all of it is pending a policy
  decision and no purge job exists (Rule 10).**
- **Evidence photos/audio** are collected only against a specific
  incident, stored outside the web root, and follow the same 7-year
  retention as the incident record.

## 3. Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Raw narrative (raw PII, possibly sensitive personal information) leaking beyond the Secretary role | Medium (many endpoints touch incidents) | High | Rule 1 — `GET /incidents/:id` is the ONLY endpoint returning `raw_narrative`, Secretary-only; never sent to FCM/SMS/logs/audit metadata; enforced server-side, not client-side (Rule 2) |
| Narrative lost at 90 days with no redacted record kept | Certain under current code | Medium-high (records-integrity, not confidentiality) | None — open policy decision (§2 above); see `docs/DATA_INVENTORY.md` §5 |
| Cross-tenant access to another barangay's residents' data | Medium | High | Every protected endpoint verifies tenant server-side; cross-tenant is 404, never 403 (Rule 2) |
| GPS/location data retained indefinitely | Was a real gap until 2026-09-26 | Medium | H-15: `gps_track` now on a 1-year retention clock (`RetentionService::purgeGpsTracks()`) |
| Device compromise exposing stored session/credentials | Low-medium | High | Encrypted SQLite (SQLCipher) on mobile; 15-min sliding web JWT / device sessions revoked on password change or suspension (§2 Rule 12); web JWT moved out of `sessionStorage` into memory-only (H-05, 2026-09-24) |
| ~~AI processing exposing raw narrative to an external service~~ | **Historical** — the AI pipeline was removed 2026-10-01 (migration 0029); no AI processor exists | — | Risk retired with the feature. Do not reintroduce without a new PIA |
| Staff hours/activities (accomplishment reports), availability and school check-ins accumulate indefinitely | Certain under current code | Medium (sensitive staff data, honorarium-linked) | None yet in effect: retention for the new tables is an open policy decision; placeholder retention rules exist in `RetentionService` but are switched OFF (no period set) until the barangay/COA confirms one, so nothing is purged today (`docs/DATA_INVENTORY.md` §5). Access limited to the owner and same-barangay admin/secretary/PB; cross-tenant 404 |
| Annex C-1 free text or accomplishment text containing victim/student/third-party identities | Medium | Medium-high (minors near schools) | Length limits and in-form guidance only; nothing detects names. Needs a barangay policy and tanod training before real use |
| Approval authority misused (an official approves their own or colleagues' reports/rosters) | Low-medium | Medium | A preparer can never note/approve their own report; an Admin cannot edit their OWN approving authorities (403); every change audited. A second Admin could still grant them (open decision, HANDOFF.md) |
| SMS broadcast reaching a non-consenting number | Low | Medium | `sms_subscriber.consent_at`/`consent_source` NOT NULL; removal is `opted_out_at`, never a hard delete (traceability) |
| Unauthorized access via a compromised web session (XSS) | Was a real gap until 2026-09-24 | High | H-05 — JWT moved to an in-memory variable, unreachable by `sessionStorage`-targeting XSS; full mitigation (HttpOnly cookie) is scoped and pending an HTTPS deployment decision (C-03/F1) |
| Transport-level interception / public exposure | Partly addressed (C-03, in progress per REFERENCE.md §1) | High | The Cloudflare Named Tunnel provides TLS to the public hostnames; no Cloudflare Access policy exists and `api.baranguardph.win` is reachable by anyone with the URL. Re-check against `docs/REMAINING.md` before relying on this row |
| No MFA on Admin/Secretary web accounts | Open (C-02, `docs/REMAINING.md`) | Medium-high (these roles reach raw case data) | Needs a method decision (TOTP vs. SMS OTP via the existing GSM gateway) before implementation |

## 4. Data subject rights (RA 10173 Chapter IV)

- **Right to be informed**: addressed by `docs/PRIVACY_NOTICES.md`.
- **Right to access/correction**: a complainant/respondent may request
  their own record through the barangay (manual process today — no
  self-service portal, consistent with the system's staff-operated,
  LAN-only design).
- **Right to object/erasure**: constrained by RA 7160's records-retention
  mandate — an incident record cannot be deleted on request while its
  7-year retention or a legal hold is active (the raw narrative is
  purged at 90 days regardless, unless on hold); this is a legal
  requirement, not an oversight, and should be stated as such in any
  public-facing notice.
- **Right to data portability**: not currently offered; low priority
  given the system's records-custodian purpose rather than a personal
  data marketplace.

## 5. Residual risk and sign-off

Findings **C-02 (no MFA, explicitly deferred by the user)** and
**C-03 (remote access/TLS, in progress)** are NOT mitigated by anything
in this PIA. Both need a policy/infrastructure decision, not a
documentation exercise — see `docs/REMAINING.md` for current disposition.
This PIA should be revisited once either is resolved, and again whenever a new personal-data
field is added to the schema (§9's migration convention makes each such
addition a discrete, reviewable commit).

**Not yet formally reviewed/signed by a DPO** — see `docs/DATA_INVENTORY.md`
§7. This draft is a starting point for that review, not a substitute for
it.

## 6. To confirm

**All items below are from secondary sources, not the primary text —
verify each against the primary source (the NPC issuances themselves)
before relying on it.** None has been checked by this repository's
authors against the original.

- **NPC registration threshold (Circular 2022-04).** Reportedly, a
  personal information controller/processor must register its data
  processing system with the National Privacy Commission when it
  processes sensitive personal information of 1,000 or more individuals
  (among other triggers). Confirm the exact threshold, how a barangay is
  counted, and whether four barangays' combined records meet it.
- **72-hour breach notification.** Reportedly, the NPC and affected data
  subjects must be notified within 72 hours of knowledge of a notifiable
  personal data breach. Confirm the trigger conditions and who at the
  barangay would own the clock; no breach-response procedure exists in
  this repository.
- **DPO designation.** A Data Protection Officer must be designated; for
  a barangay this is a council action (Sangguniang Barangay resolution or
  equivalent), not something code completes. Still open — see
  `docs/DATA_INVENTORY.md` §7.
- **CCTV/photo evidence and minors near schools (NPC Circular 2024-02).**
  Evidence photos/audio (`evidence_attachment`) may capture bystanders and
  minors, including near schools. Confirm what the circular requires for
  such images (notice, retention, access) and whether Tanod evidence
  capture needs additional safeguards.
- **Staff data under the tanod workflow (2026-10-01).** Confirm how RA
  10173 and NPC issuances treat staff hours/attendance records and school
  deployment records held by a barangay, whether a separate privacy notice
  is needed for tanods (none exists in `docs/PRIVACY_NOTICES.md`), and what
  retention applies (COA/treasurer attendance-evidence rules are
  unconfirmed). Annex A fields and MC 2026-037 reporting duties are
  unknown until the circular PDF is read.
- **Third-party disclosures** (ORS, FCM, Cloudflare —
  `docs/DATA_INVENTORY.md` §6) are not yet assessed for data-sharing
  agreements.
