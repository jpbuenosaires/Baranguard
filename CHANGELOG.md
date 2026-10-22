# Changelog

All notable changes to Baranguard are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
intends to follow [Semantic Versioning](https://semver.org/) once a first
version is tagged. **No version has been tagged yet** (`mobile/package.json`
is still `0.0.0`); everything below is therefore under `[Unreleased]`,
grouped by migration batch, newest first.

Sources: `git log` and the dated headings of `backend/DEVLOG.md`
(the full reasoning for each item is there). Migrations 0029-0045 are
written and verified on disposable databases; per `docs/REFERENCE.md` they
are applied to `baranguard_uiseed` only in part (0041, 0042, 0045 are
recorded as applied there) and **none is recorded as applied to the real
`baranguard` database**. Check before relying on this.

## [Unreleased]

### Migrations 0039-0045 (2026-10-09 to 2026-10-17)

#### Added
- 0039: an Admin can resolve a `pending`/`reopened` incident that needed no
  dispatch, with a mandatory reason (`incident.resolve_reason`).
- 0040: report and roster notifications (`report_update`,
  `roster_published`).
- 0043: incident codes `INC-YYYY-NNN` numbered per barangay and year.
- 0044: report channels `phone_call` and `facebook`.
- 0045: referral destination `lupon_kp`.
- Secretary as back-up dispatcher; Chief Tanod phone console can log an
  incident; `docs/POWER_CUT_PROCEDURE.md` (2026-10-17).
- Scheduler week grid; offline "go off duty" with the device's tap time;
  SOS gateway envelope SMS fallback; ISO 25010 measurement tooling;
  self-hosted Inter font and offline basemap notice (2026-10-10 to 12).
- Mobile UI overhaul phases 1-6 (2026-10-14/15).

#### Changed
- Paper-first signing (2026-10-12), then print-only (0041): report statuses
  become open/prepared/returned and Annex D draft/prepared/submitted; the
  app no longer tracks signatures.
- Availability is fixed by the tanod; shifts must fit inside it.
- Web Admin may read the raw narrative and party fields (Rule 1 amended
  2026-10-13).
- Raw narrative retention ceiling 90 -> 365 days; provisional 365-day rules
  for the new tables (2026-10-17).
- Web UI consistency passes (design tokens, unified table cards,
  accessibility) and Chapter 4 / manuscript documentation updates.

#### Removed
- 0041: signature-tracking columns, `document_scan` and the paper-signature
  routes.
- 0042: Fatigue Flags (table, endpoints, web page, 56 h/week warnings). The
  12 h/day scheduled-hours cap is kept.
- Citizen Reports inbox retired (2026-10-17); old rows kept.
- Approval-authority dialog and the preparer-cannot-approve rule
  (2026-10-17).

#### Fixed
- Admin audit fixes of 2026-10-09 (service-health honesty, dispatch
  "updates paused" banner, invented fallback text, swapped barangay ids,
  Manila time, undefined `refreshCounterCounts()`); see
  `docs/DEFECT_LOG.md`.
- Phone could not reach the server: DNS pointed at a tunnel with no
  connection (2026-10-14).
- Sync gaps 1-4 (a phone owned by another account failed silently, etc.),
  see `docs/OFFLINE_SYNC_CONFLICT_RULES.md`.

#### Security
- `?api_base=` override restricted (credential-theft vector), `patrolZone`
  XSS and latent `innerHTML` sites escaped, session-expiry handling and a
  15-minute idle lock, CSP and security headers, Punong Barangay list reach
  limited, pre-written sworn attestation removed from printed reports
  (2026-10-09). `docs/BREACH_RESPONSE_RUNBOOK.md` drafted (not adopted).

### Migrations 0034-0038 (2026-10-07), Proposed Changes Review build

#### Added
- 0034: dispatch cancel/override reasons; dispatch requires a published
  shift covering now unless overridden.
- 0035: `shift_schedule.pending_reapproval`; Secretary may create shifts and
  review swaps; legal hold stops all backup pruning.
- 0036: `incident.report_channel` and `related_incident_id`.
- 0037: paper approvals and signed-paper scans (superseded by 0041).
- 0038: night dispatch offers (`dispatch_offer`, first accept wins,
  sweeper script and scheduled task definition).
- Chief Tanod (Admin) mobile console with a scope-limited device session.

#### Removed
- Public `POST /citizen-reports` (now answers 405).

### Migrations 0030-0033 (2026-10-01), Tanod-workflow build

#### Added
- 0030: approval authorities as a user attribute (not a role), tanod
  availability, draft/published rosters.
- 0031: monthly accomplishment reports and entries.
- 0032: incident referrals (a delegation log, no case content).
- 0033: Safer School Zones (school inventory, check-ins, Annex C-1 fields,
  Annex D term report).
- Web: Approvals, Accomplishment Reports, Referral Log, Safer School Zones
  pages. Mobile: availability, accomplishments, school check-in, refer panel.

#### Changed
- Roster rules: the 8 h minimum-rest and minimum-one-on-duty blocks replaced
  by a 12 h/day scheduled-hours cap (422 `DAILY_HOURS_EXCEEDED`).
- Secretary redefined as Records & Reports Officer.

### Migration 0029 (2026-10-01), Blotter and AI removal

#### Removed
- Electronic Blotter, Lupon packet, the whole local-AI pipeline (Ollama /
  SEA-LION redaction, summary, translation), eval harness and the AI Tools /
  Redaction / Blotter screens. Tables `blotter_record`, `blotter_revision`,
  `ai_processing_log`, `ai_evaluation_run` dropped. Barangays keep these
  records in binders; DILG BIMSS/KPIS remains the case ledger.

#### Fixed
- Post-0029 revision pass: sync/SOS safety and verify suites run on the full
  migration chain.

### Before 0029 (2026-08-21 to 2026-09-30), summary

Reconstructed from commit subjects and DEVLOG headings only; not itemised.
- Sprints 0-7: executable schema (2026-08-31), auth and sessions,
  incidents, dispatch, GIS, SMS, scheduling, offline mobile app, retention,
  audit, pentest suites.
- 2026-09-10: walk-in `POST /blotter` removed (DILG BIMSS overlap).
- 2026-09-12/13: 2026-09-07 audit findings F2-F8 fixed (see
  `docs/DEFECT_LOG.md`); evidence upload built.
- 2026-09-13 to 24: turn-by-turn routing (OpenRouteService), on-device SMS
  fallback, GSM gateway, Android background-location fix, device-signature
  keys, `is_suspended` enforcement, incident lifecycle states (0025), SOS no
  longer blocked by a missing GPS fix (0026).
- 2026-09-26/27: Cloudflare Named Tunnel (`baranguardph.win`), Apache on
  :8081, PHP 8.3, React Native rebuild attempted then abandoned (Capacitor
  kept).
