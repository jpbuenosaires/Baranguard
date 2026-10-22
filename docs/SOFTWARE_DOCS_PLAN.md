# Baranguard — Software Documentation Plan

Written 2026-10-23. A plan only: nothing below is drafted yet unless its
status says "exists". Formal letters (permission letters, consent forms,
DPA/MOA, certificates) are a separate list and are not covered here.

## Which standards this follows

The doc set is modelled on the ISO/IEC/IEEE life-cycle documentation
family, so a panel can see each document maps to a recognised standard:

| Area | Standard | Note |
|---|---|---|
| What documents a project has | ISO/IEC/IEEE 15289:2019 | Lists every life-cycle "information item" (clause 10) |
| Requirements (SRS) | ISO/IEC/IEEE 29148:2018 | Replaced IEEE 830 |
| Design (SDD) | IEEE 1016 / ISO/IEC/IEEE 42010 | Design views + architecture description |
| Testing | ISO/IEC/IEEE 29119-3:2021 | Replaced IEEE 829; test plan, test cases, test completion report |
| User manuals | ISO/IEC/IEEE 26514 (26511 for managing them) | Check current edition before citing |
| Quality evaluation | ISO/IEC 25010:2023 | Already planned in `ISO25010_EVALUATION_PLAN.md` |
| Maintenance | ISO/IEC/IEEE 14764 | Maintenance/turnover plan |
| Repo conventions | Keep a Changelog, SemVer | `CHANGELOG.md`, version numbers |

The standards themselves are paywalled; cite them by number and edition,
and check the edition with your adviser. Don't quote clause numbers you
haven't read.

## Inventory: what exists, what's partial, what's missing

### 1. Project management

| Document | Status | Source / plan |
|---|---|---|
| Project charter / proposal | partial | Chapter 1 of the manuscript. No separate doc needed. |
| Project schedule (Gantt) | missing | Build from `Baranguard_Sprint_Prompts.md` sprint dates + DEVLOG. One page. |
| Risk register | missing | Collect from HANDOFF "Open decisions", REMAINING, power-cut/SPOF notes. Table: risk, likelihood, impact, owner, mitigation. |
| Change log / release notes | missing | `CHANGELOG.md` at repo root (Keep a Changelog). Back-fill one entry per migration batch (0029, 0030-0033, 0034-0038, 0039-0045). |
| Versioning | missing | `mobile/package.json` is `0.0.0`. Pick `1.0.0` for the UAT build, tag it in git. |

### 2. Requirements

| Document | Status | Source / plan |
|---|---|---|
| SRS (29148) | partial | Content lives in Master Reference + `WORKFLOWS_AND_RULES.md` + `FEATURE_CONTRACT_2026-10.md`. Write `SRS.md`: intro, users/roles, functional requirements with IDs (FR-01…), non-functional (NFR-01…), constraints (DPA, BIMSS positioning, offline-first). Extract, don't invent. |
| Requirements traceability matrix | missing | Table: requirement ID → thesis objective (`THESIS_OBJECTIVES_ALIGNMENT.md`) → screen/endpoint → test (verify script / UAT case). The single most "standard-looking" artefact. |
| Use-case list / diagrams | check | Check whether the manuscript already has them; if not, one use-case diagram per role. |

### 3. Design

| Document | Status | Source / plan |
|---|---|---|
| System Design Document | **stale** | `docs/design/Baranguard_System_Design_Document.docx` last changed 2026-09-12, before migrations 0029-0045 (blotter/AI removed, tanod workflow, dispatch offers, Fatigue Flags removed). Update ERD, DFDs, architecture diagram and module list. |
| Data dictionary | partial | Master Reference §5 + REFERENCE §4. Generate table/column list from the live schema (`information_schema`) so it can't drift. |
| API reference | partial | Route tables in `backend/routes/*.php` + controller docs. Either a generated route list (`count-routes.php` already walks them) or an OpenAPI file. Generated list is cheaper. |
| UI design / screen catalogue | partial | Screenshots exist in `docs/manuscript-images/`. One page per screen: role, purpose, states. |

### 4. Testing (29119-3)

| Document | Status | Source / plan |
|---|---|---|
| Test plan | partial | `ISO25010_EVALUATION_PLAN.md`, `SPRINT8_DEVICE_TEST_PLANS.md`, chapter 4 instruments. Add a short master test plan that points to them: scope, levels (unit/integration/system/UAT), environment, entry/exit criteria (Sprint 8 pre-UAT list). |
| Test case specification | partial | The `verify-*.sh` suites and `web/tests` are the system test cases. List them with check counts (REFERENCE §9). UAT cases are in `09-consolidated-uat.html`. |
| Test completion report | missing | After UAT/ISO runs: what ran, measured results, pass/fail, deviations, residual risks. **Only real measured numbers.** |
| Defect log | missing | Consolidate the audits (`AUDIT_2026-09-07.md`, `audit-2026-10-09/`) into one table: ID, severity, found, fixed in commit, verified how. |

### 5. User documentation (26514)

| Document | Status | Source / plan |
|---|---|---|
| Tanod user manual (mobile) | missing | Login, duty on/off, SOS, assignments, new incident offline, referrals, availability, accomplishments, school check-in. Phone screenshots. Filipino/Bikol-friendly plain language. |
| Chief Tanod manual (mobile console + web) | missing | Dispatch, night offers, SOS ack/resolve, scheduler, users. |
| Secretary manual (web) | missing | Incident lifecycle, narrative access, referrals, schools/annexes, printing reports, back-up dispatcher. |
| Punong Barangay manual (web) | missing | Dashboard, analytics, approvals, printing. |
| Quick reference cards | missing | One printable page per role (laminated by the barangay). |
| FAQ / troubleshooting | missing | Offline banner, sync pending, no GPS, forgot password, power cut (link `POWER_CUT_PROCEDURE.md`). |
| Training plan | missing | Session outline per role, duration, materials; reuse `07-facilitator-session-guide.html` structure. |

### 6. Operations and deployment

| Document | Status | Source / plan |
|---|---|---|
| Installation guide | partial | `SETUP.md` covers backend/web; mobile and SMS gateway are "optional" stubs. Fill in mobile APK build/install from HANDOFF. |
| System administrator / operations manual | partial | Scattered in HANDOFF quick reference: backups, restore drill, retention job, scheduled tasks, tunnel, GSM gateway, account suspension. Collect into one `OPERATIONS_MANUAL.md`. |
| Backup and recovery procedure | partial | `backup.sh`, `restore-drill.sh`; write the human procedure + schedule. |
| Business continuity / disaster recovery | partial | `POWER_CUT_PROCEDURE.md`, SMS SOS fallback. Add workstation-failure and data-loss scenarios. |
| Deployment / go-live checklist | missing | Apply migrations 0029-0045 (backup first), switch `DB_NAME` off the demo DB, register scheduled tasks, install services, build release APK with the real API URL. |

### 7. Maintenance and turnover (14764)

| Document | Status | Source / plan |
|---|---|---|
| Maintenance plan | missing | Who maintains it after graduation, how bugs are reported, update procedure, dependency/PHP upgrades (note the curl DLL trap). |
| Turnover / handover document | partial | `HANDOFF.md` is developer-facing. Write a barangay-facing one: what's delivered, accounts, credentials handover (in person, never in the doc), support contacts. |
| Known issues / limitations | partial | HANDOFF "unresolved" + REMAINING. Publish as a short list in the turnover doc. |

### 8. Security and privacy

| Document | Status | Source / plan |
|---|---|---|
| Privacy impact assessment | exists | `PRIVACY_IMPACT_ASSESSMENT.md` (new tables only partly reconciled). |
| Privacy notices | partial | `PRIVACY_NOTICES.md` lacks staff hours / availability / school check-ins. |
| Data inventory / ROPA | exists | `DATA_INVENTORY.md`. |
| Breach response | exists | `BREACH_RESPONSE_RUNBOOK.md`. |
| Security assessment report | partial | Audits + pentest suites exist; summarise into one report (threats, controls, test evidence). |
| Access control / account policy | missing | Who gets which role, password rules, suspension, offboarding a tanod. |
| `SECURITY.md` | missing | How to report a vulnerability, supported version. |

### 9. Repository files

| File | Status | Plan |
|---|---|---|
| `README.md` | exists | Still lists `services (sms/ai/sync)`; drop "ai". Add version, license, links to manuals. |
| `LICENSE` | missing | Decide with adviser/school (they may own the IP or require a specific licence). |
| `CHANGELOG.md` | missing | See §1. |
| `SECURITY.md` | missing | See §8. |
| `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` | skip | Solo project; only add if the repo goes public for others to contribute. |

## Order of work

1. **Fix what's stale first** — SDD (diagrams), README "ai" line,
   privacy notices. A panel reading an outdated design doc is worse than
   a missing one.
2. **SRS + traceability matrix** — everything else (tests, manuals)
   cites requirement IDs.
3. **User manuals + quick reference cards** — needed for UAT training.
4. **Operations manual + deployment checklist** — needed before go-live.
5. **Master test plan → run UAT/ISO → test completion report + defect log.**
6. **Maintenance/turnover doc, CHANGELOG, version tag, SECURITY.md,
   LICENSE** — at handover.
7. Risk register and schedule can be done any time; they're small.

## Decisions needed from you

- Licence and IP ownership (school policy).
- Manual language: English, Filipino, or both.
- Format: Markdown in `docs/`, or Word/PDF to match the manuscript.
- Who maintains the system after turnover (named person or office).
