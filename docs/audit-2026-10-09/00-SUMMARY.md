# Web audit 2026-10-09: combined report

Nine read-only auditors reviewed the web dashboard from different angles; each wrote its own file in this folder. This page merges them. **Nothing was run in a browser or printed, and no screen reader was used.** Findings are from reading code (and, in 08, running the existing checks). Items marked **CONFIRMED** I re-read in the code myself after the auditors reported; everything else is the auditor's claim with file:line evidence in its report.

## Totals

| Report | Lens | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| 01 | Admin screens | 0 | 21 | 13 | 4 |
| 02 | Secretary screens | 0 | 9 | 12 | 5 |
| 03 | Punong Barangay | 1 | 12 | 9 | 5 |
| 04 | Personnel, roster, approvals | 1 | 10 | 6 | 2 |
| 05 | Design system and UI | 0 | 7 | 11 | 9 |
| 06 | Accessibility and language | 2 | 10 | 12 | 6 |
| 07 | Security and privacy | 1 | 5 | 8 | 3 |
| 08 | Functionality and wiring | 0 | 6 | 7 | 3 |
| 09 | Barangay norms and law | 1 | 12 | 7 | 2 |
| **All** | | **6** | **92** | **85** | **36** |

Several findings are reported by more than one auditor, so the real number of distinct problems is lower than 219.

**Existing checks (report 08):** `verify-web-wiring.mjs` 779 passed, 0 failed; `web/tests` 625 passed, 0 failed, 0 skipped. All 107 web API calls match one of the 117 backend routes. The checks pass while the defects below exist, because they cannot see them.

## The six P0 findings

| # | Problem | Where | Status |
|---|---|---|---|
| 1 | **The `?api_base=` link can steal sign-ins.** Any page URL with `?api_base=https://other-host/...` is saved to localStorage with no validation, and the login password and bearer token then go to that host. | `web/index.html:180-192` (V-01) | **CONFIRMED** |
| 2 | **Stored XSS in Swap requests.** `shift.patrolZone` goes into `innerHTML` unescaped; a Secretary can store script that runs in the Admin session. | `web/src/pages/swap-requests.js:284` (R-01, V-03) | **CONFIRMED** |
| 3 | **A sworn attestation is printed with the Punong Barangay's name though nobody attested.** The weekly digest and every PDF/print export carry "I hereby certify under oath ..." and "Punong Barangay · Attested & Approved". | `backend/controllers/ReportsController.php:1063,1071` (P-01, N-18) | **CONFIRMED (text present)** |
| 4 | **The Dispatch Center freezes looking live when the API drops.** Background poll errors are swallowed; no "out of date" banner; no offline detection anywhere. | `web/src/pages/dispatch-center.js:301-302` (X-01, A-03) | auditor |
| 5 | **Session expiry is not handled.** A 401 clears the token only; the user sees "Not signed in." with a useless Retry; unsaved forms are lost; a refresh also signs out. | `web/src/api/apiClient.js:171-175` (X-02, X-03, F-03) | auditor |
| 6 | **No data protection officer, no breach runbook, no security-event log** before real data goes live. RA 10173 sec 20(f) and 21(b) were read in the primary source; the 72-hour clock is from secondary commentary only. | policy, no code (N-04) | auditor |

## Themes found by more than one auditor (highest value)

1. **Invented or placeholder content shown as real (Rule 6).** Seen by 01, 02, 03, 08, 07: "Juan dela Cruz" as the reporter fallback (**CONFIRMED** `incident-management.js:815`), "Barangay Desk Secretary", "Barangay Center", "Under Investigation", "Purok 3", "Brgy. Dao", a canned SMS naming "San Jose St". **Barangay ids 2 and 3 are swapped** in the Incident Management fallback (**CONFIRMED**) and on Map Packages.
2. **Fake or unproven health.** Service Health shows HEALTHY for FCM, GSM gateway and GSM ingestion from an environment variable being set, not a live check (01, 08). The Dashboard and statistical report show a hardcoded "Target < 20m" chip with no documented basis (**CONFIRMED** `admin-dashboard.js:639`, `statistical-reports.js:546`) (03, 09). The chart caption says "dispatch to arrival" but the backend measures from incident creation to first arrival (03, 09).
3. **Dead or broken navigation.** "New Emergency Report" calls `navigate('incidents')`, but the route key is `incident-management` (**CONFIRMED** `dispatch-center.js:415`); `statistical-reports.js:665` has the same kind of bad target (01, 08).
4. **SOS handling gaps.** The web cannot acknowledge an SOS; `acknowledgeTanodSos` is imported and never called (**CONFIRMED** `dispatch-center.js:29`) (01, 08). The web drops `location_source`, so a stale last-known position is drawn as live and an SOS with no GPS fix is not drawn at all (01, 08). The SOS alert is one chime blocked until the first click, with no `aria-live` and no persistent bar (01, 06).
5. **Time zone.** About 40 places show times in the browser's time zone instead of Asia/Manila, plus a clock labelled "PST" (06).
6. **Modals.** Nine of ten modals lack the focus trap, Escape and focus return that ConfirmDialog has; toasts (z 300) render behind page modals (z 999-1000) (05, 06).
7. **The Scheduler, Swap and Approvals pages load only the first 100 records** oldest first with no paging, so newer shifts disappear after a few weeks (04, 08).
8. **Restricted data shown as "nothing recorded".** The Punong Barangay sees "No digital evidence attachments recorded" and "Unspecified / Under Investigation" because a 403 is swallowed; the captain publishes rosters seeing only "Tanod #id" (02, 03).
9. **Privacy posture of the UI.** No privacy notice, retention statement or DPO contact anywhere (07, 09). The 90-day narrative purge is silent: after it the screen says "No narrative recorded yet" and a card claims "permanent statutory retention" (02). The API still gives the Punong Barangay a full paginated incident list and search with coordinates, location text and officer names, against the role table (07, 03).
10. **Paper-report workflow breaks for the Secretary.** She sees no accomplishment entry text unless she holds note or approve authority, so the paper report to sign prints blank; paper approval can only be recorded from `noted`; "approved, paper signature pending" has no queue (04, 02).

## Barangay norms and law (report 09)

Source quality matters here. The auditor read RA 7160 and RA 10173 only through summarising fetches (paraphrase, not exact text). NPC circulars, DILG memorandum circulars, the Safer School Zones circular, EO 56 and the COA honoraria rules were secondary sources only. **MC 2026-037's text could not be read** (two sites returned 403). Treat every legal statement in 09 as "to verify" before it goes into a thesis or a barangay policy.

Points that fit the project: confidentiality plumbing for the narrative is sound; the BIMSS/KPIS complement positioning is consistent; the role model is workable. Points that do not: a Kagawad needs a `secretary` account, which also exposes raw narratives (N-06); an open dashboard tab never expires, so a shared barangay-hall PC stays signed in (N-12); the "Admin = Chief Tanod" mapping gives a volunteer technical-admin and audit powers (N-08); Safer School Zones Annexes are presented without saying the layouts come from your forms, not the circular (N-10).

## What is solid (reported by several auditors)

Server-side role, tenant and ownership checks; the narrative never leaks into lists, search, print or page titles; no web call hits a missing route; the response-time SQL is correct (per-incident minimum arrival); the `escapeHtml` discipline is followed in almost every place; the four data states exist on the data screens; the design tokens are mostly used.

## Suggested fix order (nothing has been changed yet)

**Wave 1: safety and truth (small changes, high value)**
1. Restrict the `?api_base=` override (localhost only, or same-site `api.<host>` over https) and clear any stored override.
2. Escape `patrolZone` in `swap-requests.js:284`, and the four latent sites (`fatigue-flags.js:557,582`, `KpiCard.js:69`, `DataTable.js:231,241`).
3. Remove the pre-filled sworn attestation and the "Attested & Approved" line, or make them an explicit signature block that stays blank until a person signs.
4. Fix the swapped barangay ids and remove the invented fallbacks ("Juan dela Cruz", "Barangay Desk Secretary", "Purok 3", "Brgy. Dao", "Under Investigation", "San Jose St"); show an honest "not available".
5. Remove the "Target < 20m" chip and fix the "dispatch to arrival" caption.
6. Fix the two dead `navigate()` targets; wire SOS acknowledge in the web; carry `location_source` through.

**Wave 2: resilience**
7. Handle 401 (redirect to sign-in, keep unsaved form data), add an offline/stale banner to polling pages, add an idle lock.
8. Replace environment-variable "HEALTHY" with real probes or show "not checked".
9. Page the Scheduler, Swap and Approvals lists; fix the paper-report visibility and `prepared` stuck state.

**Wave 3: accessibility, language and design**
10. One shared modal with focus trap, Escape and focus return; a z-index scale; a theme-change event for charts and maps; Manila-time formatting helper used everywhere; linked form labels; `aria-live` for SOS.

**Wave 4: decisions that are not code (need you, the barangay or counsel)**
11. Designate a DPO and write a breach runbook; add a privacy notice and retention statement to the UI; decide the Kagawad account model; decide whether the Punong Barangay may see the incident list; confirm the legal claims in report 09 against primary sources, including MC 2026-037.

## Not verified by anyone

Visual rendering, print and PDF output, dark-mode appearance of hand-tuned colours, screen reader behaviour, live response headers from Apache, whether the server honours `Idempotency-Key` on every endpoint, notification templates, and the full text of the circulars.
