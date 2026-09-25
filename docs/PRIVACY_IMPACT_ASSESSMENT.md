# Baranguard — Privacy Impact Assessment (PIA)

Drafted 2026-09-26 to close H-14 (2026-09-24 external business-rules
audit, `docs/REMAINING.md` §H: "privacy governance incomplete — no PIA,
DPO role, notices, data inventory"). Companion documents:
`docs/DATA_INVENTORY.md` (what is collected) and `docs/PRIVACY_NOTICES.md`
(what data subjects are told). This PIA assesses risk and mitigation; it
does not restate the inventory.

## 1. System description

Baranguard is an offline-first, LAN-only, single-workstation Barangay
Intelligence and Emergency Dispatch System for four barangays in Pilar,
Sorsogon (`docs/REFERENCE.md` §1). It processes incident reports, GPS
location of on-duty Tanod, SOS alerts, and case records feeding the
barangay's DILG BIMSS/KPIS ledger.

## 2. Necessity and proportionality

- **Raw narrative collection is necessary** to produce a legally usable
  blotter record (RA 7160 §394(c)), but is the system's single highest-risk
  field — mitigated by Rule 1 (Secretary-only access, never leaves the
  system except through the approved AI redaction pipeline) and the
  30/90-day purge windows in §11.
- **GPS tracking is limited to on-duty Tanod**, for dispatch routing and
  personnel safety (SOS). It is not continuous surveillance of an
  off-duty person's location — `duty_status` gates whether tracking is
  active, and `docs/REFERENCE.md` §8's gotcha list documents the real
  device behavior (tracking stops when off-duty, subject to the
  background-location permission fix in HANDOFF.md's C7 entry).
- **Evidence photos/audio** are collected only against a specific
  incident, stored outside the web root, and follow the same 7-year
  evidentiary retention as the case record.

## 3. Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Unredacted narrative (raw PII, possibly sensitive personal information) leaking beyond the Secretary role | Medium (many endpoints touch incidents) | High | Rule 1 — `GET /incidents/:id` is the ONLY endpoint returning `raw_narrative`, Secretary-only; never sent to FCM/SMS/logs/audit metadata; enforced server-side, not client-side (Rule 2) |
| Cross-tenant access to another barangay's residents' data | Medium | High | Every protected endpoint verifies tenant server-side; cross-tenant is 404, never 403 (Rule 2) |
| GPS/location data retained indefinitely | Was a real gap until 2026-09-26 | Medium | H-15: `gps_track` now on a 1-year retention clock (`RetentionService::purgeGpsTracks()`) |
| Device compromise exposing stored session/credentials | Low-medium | High | Encrypted SQLite (SQLCipher) on mobile; 15-min sliding web JWT / device sessions revoked on password change or suspension (§2 Rule 12); web JWT moved out of `sessionStorage` into memory-only (H-05, 2026-09-24) |
| AI processing exposing raw narrative to an external service | Low (architecturally prevented) | High | §2 Rule 5 — the API never calls Ollama directly; only a local worker process does, no external AI fallback under any failure mode |
| SMS broadcast reaching a non-consenting number | Low | Medium | `sms_subscriber.consent_at`/`consent_source` NOT NULL; removal is `opted_out_at`, never a hard delete (traceability) |
| Unauthorized access via a compromised web session (XSS) | Was a real gap until 2026-09-24 | High | H-05 — JWT moved to an in-memory variable, unreachable by `sessionStorage`-targeting XSS; full mitigation (HttpOnly cookie) is scoped and pending an HTTPS deployment decision (C-03/F1) |
| Transport-level interception (no TLS) | Open (C-03/F1, `docs/REMAINING.md`) | High | Currently LAN-only by design (§1); a genuine fix needs an infrastructure/domain decision, not code — see REMAINING.md's three scoped HTTPS options |
| No MFA on Admin/Secretary web accounts | Open (C-02, `docs/REMAINING.md`) | Medium-high (these roles reach raw case data) | Needs a method decision (TOTP vs. SMS OTP via the existing GSM gateway) before implementation |

## 4. Data subject rights (RA 10173 Chapter IV)

- **Right to be informed**: addressed by `docs/PRIVACY_NOTICES.md`.
- **Right to access/correction**: a complainant/respondent may request
  their own record through the barangay (manual process today — no
  self-service portal, consistent with the system's staff-operated,
  LAN-only design).
- **Right to object/erasure**: constrained by RA 7160's records-retention
  mandate — a blotter record cannot be deleted on request while its
  7-year retention or a legal hold is active; this is a legal
  requirement, not an oversight, and should be stated as such in any
  public-facing notice.
- **Right to data portability**: not currently offered; low priority
  given the system's records-custodian purpose rather than a personal
  data marketplace.

## 5. Residual risk and sign-off

Two Critical findings remain genuinely open and are NOT mitigated by
anything in this PIA: **C-02 (no MFA)** and **C-03 (no TLS)**. Both are
explicitly out of this document's scope because they require a policy/
infrastructure decision, not a documentation exercise — see
`docs/REMAINING.md` for their current disposition. This PIA should be
revisited once either is resolved, and again whenever a new personal-data
field is added to the schema (§9's migration convention makes each such
addition a discrete, reviewable commit).

**Not yet formally reviewed/signed by a DPO** — see `docs/DATA_INVENTORY.md`
§7. This draft is a starting point for that review, not a substitute for
it.
