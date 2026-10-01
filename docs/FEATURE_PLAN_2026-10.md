# Baranguard — Tanod workflow feature plan (2026-10-01)

**Status: PLAN ONLY. Nothing here is built.** Decisions below were taken by the
user on 2026-10-01 (recommendations accepted; decision 1 answered directly).
Evidence for the real workflow is thin: primary texts (DILG MC 2024-086, the
2025 Tanod Handbook, MC 2026-037's full text, Annex A) were NOT readable by
research agents, so items marked *unconfirmed* must be checked against the
documents or a real barangay treasurer/COA auditor before go-live.

## 1. The real workflow this plan is built on

User-stated ground truth: tanods are honorarium-only and not on duty a full 8
hours; there is no DTR; each tanod submits an accomplishment report as their
attendance; schedules are built from each tanod's availability and approved by
a barangay official; tanods delegate big tasks (PNP, ambulance/EMS, BFP,
barangay officials) instead of handling them; MC 2026-037 (Safer School Zones,
25 June 2026) adds Annex B/C-1/D reporting.

Working sequence (steps 1-6 inferred from research, *unconfirmed*):

1. Each tanod states availability for the period.
2. The Chief Tanod drafts the roster from it; coverage gaps are normal.
3. A barangay official approves it; tanods are notified.
4. On duty the tanod patrols and **refers** large matters, never handles them.
5. The tanod prepares an accomplishment report; the Chief Tanod notes it; a
   barangay official approves it.
6. Approved reports are the attendance evidence for monthly honorarium payroll.
7. Safer School Zones: Annex B school inventory, Annex C-1 per-incident report,
   Annex D term report (prepared by the Chief Tanod, approved by the Punong
   Barangay, received by the Mayor's office, copy to DILG).

Caveat: a secondary source claims COA disallows honoraria lacking a DTR or duty
log (citation unverified). Confirm with the barangay treasurer / municipal COA
auditor what attendance evidence payroll actually accepts.

## 2. Decisions taken

| # | Decision |
|---|---|
| 1 | **Accomplishment report signatories (user answer):** tanod prepares; **noted and approved by barangay officials: Chief Tanod, a Kagawad, or the Punong Barangay**. Noter/approver are configurable per barangay (a setting listing eligible officials), never hardcoded to one person. Approval must be by someone other than the preparer. |
| 2 | Availability **coexists** with admin-created shifts; both reach tanods only after publish approval. |
| 3 | Server duty-on/off sum is shown as a **suggestion**; the tanod confirms or edits; **both values stored**; a difference beyond a set margin is flagged to the noter. |
| 4 | **Ambulance/EMS is its own referral value** in the app. On the printed Annex D it maps into DOH or Other agencies (Secretary confirms which); the circular's printed categories are not altered. |
| 5 | **Keep the Secretary role, redefined as Records & Reports Officer** (citizen reports, school inventory, referral log, preparing/filing annexes). |
| 6 | **Fatigue Flags removed from navigation**; table and data kept; revisit from actual accomplishment hours later. |
| 7 | `raw_narrative` stays on the **90-day** purge. A separate short, factual, non-identifying school-incident narrative (Annex C-1) is stored with its own retention for the reporting cycle. **Retention numbers need an architecture review (Rule 10) and a barangay council decision; no legal retention rule is cited.** |

Also decided: add a **Chief Tanod** flag on a user (signature blocks), and
generate printable layouts of the user's accomplishment report and Annex B,
C-1, D from system data.

## 3. Web: keep / change / remove / add

- **Keep:** Login, Citizen Reports, Map Packages, SMS Monitor, Audit Log,
  Settings, public report page, Live Map.
- **Change:** Dashboard (pending-approvals widget; Punong Barangay home =
  approvals + oversight); Dispatch (add "delegated to" PNP/BFP/ambulance/
  official); Incident Management + Detail (school link, referral section);
  Scheduler (availability-based, draft -> published); Statistical Reports
  (Annex D generator); Service Health (remove any dead AI panels).
- **Remove / demote:** Fatigue Flags (nav); Swap Requests merge into schedule
  approval.
- **Add:** availability review; accomplishment-report approval queue with
  monthly roll-up; referral log; school inventory (Annex B); Annex C-1 and D
  print views; approvals inbox for approving officials.
- **Roles:** Admin = Chief Tanod/operations coordinator (dispatch, roster,
  report review, Annex D preparation); Secretary = Records & Reports Officer;
  Punong Barangay (and designated Kagawad) = approvers.

## 4. Mobile (offline-first, Rule 7)

Availability submission; "my schedule" (approved only); daily accomplishment
entry (text + time in/out, prefilled from duty on/off, editable); **Refer**
action on an incident (referred-to, who/when, reference no.; records a handoff,
never claims acceptance); school check-in and Annex C-1 incident capture
extending the existing incident form. New local tables with `client_event_id
UNIQUE`; new `/sync/batch` kinds (availability, accomplishment, referral,
checkin), chunked and attempt-capped like existing items.

## 5. Backend (new numbered migrations only; never edit old ones)

- **0030** availability + schedule approval: `tanod_availability`; `shift_schedule`
  gains `approval_status` (draft/published), `source_availability_id`,
  `approved_by/at` (existing rows backfill to published).
- **0031** `accomplishment_report` (month; prepared -> noted -> approved, with
  return) + `accomplishment_entry` (date, text, start/end, confirmed duration,
  server-suggested duration).
- **0032** `incident_referral` (incident, referred_to enum incl. ambulance_ems,
  other text, contact, referred_at, reference_no).
- **0033** `school` (Annex B), `school_checkin`, `incident.school_id`.
- Endpoints: availability, shift publish, accomplishment entries/reports,
  incident referrals, schools, school check-ins, `GET /reports/school-term`.
- Rules for all: role + tenant + ownership server-side, cross-tenant 404,
  `client_event_id` + `X-Device-Id` for tanod writes, `Idempotency-Key` for web
  writes, audit metadata = ids/statuses only, no student or victim names.
- Shift rules relaxed: 8-hour rest becomes a per-day maximum (or skipped for
  availability-sourced shifts); min-coverage block becomes a warning on publish.
  Overlap check stays.

## 6. Annex data requirements (from the user's own forms)

- **Annex B (per school):** name, public/private, level (Preschool/Daycare/ECCD,
  Primary/Elementary, Secondary/High School, Integrated, HEI/Tertiary,
  All-through, TVET, SNED), address, SSZ focal person, focal contact, remarks.
- **Annex C-1 (per incident):** school, date/time, exact place, brief factual
  narrative (no speculation or accusation), action taken, referred-to
  (multi-valued: PNP/BFP/Higher LGU/DPWH/DOH/Others, or "Barangay"), responding
  personnel, status/notes.
- **Annex D (term):** term, total tanods (annual, Term 1), schools covered,
  days with tanod deployment, incidents logged, and counts by destination
  (barangay-only, PNP, BFP, higher LGU, DOH, DPWH, other agencies + names).
  Referral columns may sum to more than total incidents. Deployment days need a
  per-deployment record (tanod + school + time), distinct from a shift.
  Signatories: Chief Tanod prepares, Punong Barangay approves, Mayor's office
  receives, DILG copy-furnished.
- **Accomplishment report (monthly, per person):** name, position, month,
  duration hours, per day an accomplishment + time, Prepared/Noted/Approved by.

## 7. Phases

1. **Referral and delegation** (smallest; core of "refer, don't handle").
2. **Availability, roster approval, accomplishment reports** (attendance path).
3. **Safer School Zones** (Annex B/C-1/D) + approvals inbox.
4. **Web cleanup** (fatigue, swaps, Secretary redefinition).

Each phase: pick one slice, build, verify with a disposable-DB suite and a real
browser/device pass, log in DEVLOG, update HANDOFF.

## 8. Still unknown (do not guess)

- MC 2026-037 deadlines for Annex B, C-1, D; C-1 filing frequency; required
  deployment days/hours; Annex A fields. Get the circular PDF from dilg.gov.ph.
- What attendance evidence the treasurer/COA actually requires; whether
  honorarium is prorated by hours.
- Who approves rosters in practice (Punong Barangay alone or a committee).
- Whether August 2026 reports of tanod outposts inside schools change the
  "outside school premises unless authorized" limit.
- Positioning guard (REFERENCE.md §1): per-person and per-incident reports are
  fine; **no browsable case registry**, since DILG BIMSS/KPIS is the mandated
  case ledger.
- Privacy: staff hours and school check-ins are sensitive; any student/victim
  data must stay out of school reports; NPC items in the privacy docs still need
  primary-source confirmation.
