# Baranguard — Defect Log

Consolidated 2026-10-23 from `AUDIT_2026-09-07.md`, `audit-2026-10-09/`
(`00-SUMMARY.md` plus nine reports), `REMAINING.md` §F and the DEVLOG
entries that record the fixes. **Only statuses those documents state are
recorded here**; "not stated" means no source says. "Verified" means what
the source says was run, and none of the 2026-10-09 fixes were
browser-verified (jsdom and scripts only). Severity is the audit's own
(P0 worst).

## A. Audit of 2026-09-07 (F1-F11)

Numbering below is the audit file's own. `REMAINING.md` §F groups and
numbers a few items differently (it calls the response-time item F8 and
the blotter `200 []` item F9).

| ID | Sev | Found | Status | How fixed / verified |
|---|---|---|---|---|
| F1 | P0 | 2026-09-07 | **Reopened 2026-09-15** | API published to the internet. Closed 2026-09-13 via private VPN, VPN decommissioned 2026-09-15; now a Cloudflare Named Tunnel with no Access policy (see `RISK_REGISTER.md` R-02, R-03) |
| F2 | P0 | 2026-09-07 | Closed | Stored XSS from unauthenticated citizen report; shared `escapeHtml.js`, fixed 2026-09-12; endpoint later removed (2026-10-07). Per REMAINING: "proven with dedicated verify scripts" |
| F3 | P0 | 2026-09-07 | Closed | Same unescaped `innerHTML` pattern across ~12 files; fixed 2026-09-12 |
| F4 | P1 | 2026-09-07 | Closed | Evidence upload built end-to-end (`POST /incidents/:id/evidence`); `verify-evidence-upload.sh` |
| F5 | P1 | 2026-09-07 | Closed | `PATCH /incidents/:id` idempotency replay via `audit_log`; dedicated verify script |
| F6 | P1 | 2026-09-07 | Closed | `is_suspended` now checked on authenticated requests |
| F7 | P1 | 2026-09-07 | Closed | Unredacted walk-in blotter text: `POST /blotter` removed 2026-09-10 (blotter later fully removed, 0029) |
| F8 | P2 | 2026-09-07 | Closed (moot) | `POST /blotter` answering `200 []`; endpoint removed |
| F9 | P2 | 2026-09-07 | Not stated | Enter double-toggles GIS Live Activity panel; no source states its fate |
| F10 | P2 | 2026-09-07 | Closed | `avg_response_time_minutes` double-counted multi-dispatch incidents; de-duplicated with per-incident `MIN(arrived_at)` |
| F11 | P2 | 2026-09-07 | Closed | Broadcast idempotency full-scanned `audit_log`; indexed by migration 0019 (`verify-f9-sms-broadcast-idempotency-index.sh`) |
| P3 set | P3 | 2026-09-07 | Not stated | Documentation drift list (HANDOFF/REFERENCE/REMAINING mismatches); docs have been reconciled since but no source closes each row |

## B. Web audit of 2026-10-09

Nine read-only auditors; totals 6 P0, 92 P1, 85 P2, 36 P3 (219 reported,
fewer distinct). Fixed in three committed waves (`06736b5`, `6b52a53`,
wave 3), recorded in DEVLOG 2026-10-09. The per-finding IDs (V-, X-, R-,
S-, P-, A-, F-, N- series) live in the nine reports; the P0s and the main
fixed groups are below. The remaining P1-P3 findings are **not itemised
here**; DEVLOG lists which IDs each wave covered.

### The six P0 findings

| ID | Sev | Found | Status | How fixed / verified |
|---|---|---|---|---|
| V-01 | P0 | 2026-10-09 | Fixed | `?api_base=` credential theft: override honoured only for localhost, the page's own host, or `https://api.<page host>`; bad stored values deleted at startup. `web/tests/unit/sessionSecurity.test.mjs` |
| V-03 / R-01 | P0 | 2026-10-09 | Fixed | `patrolZone` stored XSS in swap requests, plus latent sites (fatigue page, `KpiCard`, `DataTable`) escaped or built with `textContent` |
| P-01 / N-18 | P0 | 2026-10-09 | Fixed | Pre-written sworn attestation and "Attested & Approved" removed from PDF and print sheet; blank signature block. `verify-w2-reports.sh` 41; PDF text checked by grep only |
| X-01 / A-03 | P0 | 2026-10-09 | Fixed | Dispatch Center froze looking live: failed polls now keep last data and show an "updates paused" banner |
| X-02 / X-03 / F-03 | P0 | 2026-10-09 | Partly fixed | 401 now returns to sign-in with a notice; unsaved form text is **not** kept, refresh still signs out (deliberate), no hash routing or draft guard |
| N-04 | P0 | 2026-10-09 | Open | No DPO or adopted breach runbook; runbook and DPO template drafted, council action needed |

### Main fixed groups (not exhaustive)

| IDs | Sev | Status | How fixed |
|---|---|---|---|
| F-05 / A-16 | P1 | Fixed | Service Health shows neutral `configured` instead of fake HEALTHY; FCM checks the service-account file. `verify-sprint4-phase2-3.sh` 73 |
| S-01..S-09 etc. | P1 | Fixed | Invented fallbacks removed ("Juan dela Cruz", "Purok 3", etc.); barangay ids 2/3 un-swapped |
| X-01 related (A-01..A-05) | P1 | Fixed | Dead `navigate()` target fixed; web can acknowledge SOS; `location_source` carried through; SOS bar |
| N-01 / N-02 / P-02..P-08 | P1 | Fixed | "Target < 20m" chip removed; response-time captions match the SQL; sample sizes shown |
| V-02 / P-12 | P1 | Fixed | Punong Barangay incident/search/dispatch reach limited. `verify-sprint7-pentest-incidents.sh` 74 |
| V-04 | P1 | Fixed | CSP and security headers added (checked in Chrome against a static server) |
| R-02..R-11 | P1 | Fixed | Scheduler/Swap/Approvals paging window; Secretary sees entry text; paper-pending queues |
| Time zone (report 06) | P1 | Fixed | `manilaTime.js` used everywhere |
| Modals, z-index, contrast (reports 05/06) | P1-P2 | Fixed (waves 2-3) | Shared modal accessibility, z-index tokens, status labels |
| V-10 | P2 | Fixed | Copy Narrative button removed |

### Stated as not fixed or needing a decision

| ID | Status |
|---|---|
| V-05 | Not changed: web maps use third-party OSM tiles and fonts; decision needed |
| Idle lock vs Dispatch | Decision needed: 15-min lock also signs out an Admin watching for SOS |
| N-06 | Kagawad needs a `secretary` account (exposes narratives): decision owed |
| N-08, N-10, N-12 | Reported; N-12 addressed by the idle lock, others not stated |
| `tanodWorkflowApi` / `shellWorkflowApi` 401 handling | Stated as not fixed (caught within ~15 s by shell poll) |
| Delete shift route | "Not done" per DEVLOG |
| Legal claims (report 09) | Unverified against primary sources; MC 2026-037 unreadable |

### Verification the sources state

Not browser-verified. After the waves: `verify-web-wiring.mjs` 914/0,
`web/tests` 742 (an order-sensitive map test can fail in a full run),
h16 59, wave1a 145, roster-accomplishment 339, paper-approvals 280,
w2-reports 41, pentest-incidents 74, sprint4-phase2-3 73, sprint7-audit
60 (HANDOFF, 2026-10-09 snapshot).
