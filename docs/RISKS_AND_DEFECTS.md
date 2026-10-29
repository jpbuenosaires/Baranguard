# Baranguard - Risks and Defects

Purpose: one place for the project risk register and the defect log (audits of 2026-09-07, 2026-10-09 and 2026-10-28).
Status / Last updated: 2026-10-28 (risk register compiled 2026-10-23 from `HANDOFF.md` and `REFERENCE.md` section 1; defect log consolidated 2026-10-23).

## Contents
1. Risk register (R-01 to R-30)
2. Defect log: 2.A audit of 2026-09-07 (F1-F11), 2.B web audit of 2026-10-09, 2.C mobile and messaging audit of 2026-10-28

## 1. Risk register

Likelihood and impact are the compiler's judgement (H/M/L), not measured; the source docs do not rate them.
Owner "Researcher" = the thesis author, for risks inside the evaluated scope; "Out of scope" = needs a deployment or a barangay council action, and the system is not deployed.
Status reflects what the source docs said at their last update; verify before relying on it.

| ID | Risk | Likelihood | Impact | Owner | Mitigation | Status |
|---|---|---|---|---|---|---|
| R-01 | Single point of failure: everything depends on one workstation being powered and online | M | H | Out of scope (deployment) | SOS has a device-local SMS fallback; UPS / backup internet is unsolved and no power-cut procedure is documented (out of scope, not deployed); cloud hosting was considered and rejected by the user | Open |
| R-02 | Public tunnel (`baranguardph.win`) currently reaches the demo DB `baranguard_uiseed`, not real data; switching `DB_NAME` is deferred | H | M | Out of scope (deployment) | Decide which DB backs the tunnel; check `DB_NAME` before any real-data claim | Open (deliberate user decision) |
| R-03 | No Cloudflare Access policy: API reachable by anyone with the URL | M | H | Out of scope (deployment) | Scope any Access policy to the web host only, never the API (breaks mobile and public endpoints); steps worked out in DEVLOG | Deferred by user |
| R-04 | Migrations 0029-0045 not applied to the real `baranguard` DB; code paths will 500 against it; 0029, 0041, 0042 are destructive | H | H | Out of scope (deployment) | Back up, apply in order as DBA/root; rehearsed on scratch copies 2026-10-08 (0029-0038) | Open |
| R-05 | Tunnel starts only as a user process, not a Windows service; does not survive reboot | M | M | Out of scope (deployment) | Run `install-autostart-services.ps1` elevated | Open |
| R-06 | Dispatch offer sweeper scheduled task `BaranguardDispatchOfferSweeper` (and, since 2026-10-28, `BaranguardNotificationWorker` and `BaranguardGsmIngest`) not registered on this machine | M | M | Researcher | Run `install-scheduled-backup-jobs.ps1` | Open |
| R-07 | New code unverified in real conditions: tanod-workflow pages not browser-verified by an agent, mobile screens and offline sync of new kinds never run on a device | M | H | Researcher | Browser pass (user) and device pass | Open |
| R-08 | Concurrency (12 h/day cap race, first-accept-wins offers) reasoned, not demonstrated; `php -S` is single-threaded | L | M | Researcher | Test under real Apache | Open |
| R-09 | Native critical-alert changes (`dispatch_offer` full-screen alert) only syntax-checked, never compiled in Gradle or run | M | M | Researcher | Build and test on device | Open |
| R-10 | Device verification owed: SOS envelope SMS, `sms_failed` path, no-GPS SOS, device-signature keys, FCM end to end, outdoor GPS run | M | H | Researcher | Run the plans in `EVALUATION.md` | Open |
| R-11 | No DPO designated; breach runbook is a draft not adopted by the council; draft privacy notices lack staff hours, availability and school check-ins | M | H | Out of scope (barangay council) | No DPO designation template or breach runbook is adopted; the council would need to adopt both before any deployment. Notice drafts are in the `PRIVACY.md` appendix | Open |
| R-12 | Retention for new tables not decided by council/COA (provisional 365 days, purge OFF); Rule 10 needs architecture review | M | M | Researcher | Council/COA decision | Open |
| R-13 | Legal text unverified: MC 2026-037 and Annex A unreadable; other legal statements from secondary sources | M | M | Researcher | Obtain circular PDFs from dilg.gov.ph; Annex layouts are marked draft | Open |
| R-14 | Kagawad has no role: needs a `secretary` account, which also exposes raw narratives | M | M | Researcher | Owner decision on account model | Open |
| R-15 | Shared barangay-hall PC may stay signed in; 15-min idle lock also signs out an Admin watching Dispatch for SOS | M | M | Researcher | Decide lock duration / Dispatch exemption | Open (decision owed) |
| R-16 | Web maps use third-party OSM tiles (leaks viewed areas, undermines "offline" claim) | M | L | Researcher | Vendored/offline tiles, or disclose in privacy notice | Open (decision owed) |
| R-17 | MFA (C-02) not implemented | L | M | Out of scope (deployment) | Explicitly deferred by user | Deferred |
| R-18 | Operational dependencies: `ext-curl` under Apache needs four `LoadFile` lines outside the repo; breaks silently if XAMPP PHP is swapped | L | M | Researcher | Re-add lines (REFERENCE §8) | Mitigated by documentation |
| R-19 | `mobile/.env.local` leaks `localhost` API URL into release APKs | M | H | Researcher | Always set `VITE_API_BASE_URL` explicitly; grep the bundle | Mitigated by documentation |
| R-20 | Orphaned second tunnel `baranguard-main` on the `danilyn` machine | L | M | Out of scope (deployment) | Ask before touching or deleting | Open |
| R-21 | Positioning risk: duplicating DILG BIMSS records functions would be a legal liability | L | H | Researcher | Settled rule: complement, never replace; no browsable case registry | Mitigated by design rule |
| R-22 | Attendance evidence accepted by treasurer/COA for honoraria unknown | M | M | Out of scope (deployment) | Ask the barangay | Open |
| R-23 | Known npm advisory: react-router v6 (open redirect, SSR constructor injection) blocked by `@ionic/react-router` peer cap | L | L | Researcher | Revisit when Ionic supports v7/v8 | Deferred |
| R-24 | Thesis evaluation: nothing measured yet for ISO 25010 plan | M | M | Researcher | Run `EVALUATION.md`; report only real numbers | Open |
| R-25 | Inbound texts now stored: a citizen's number and message sit in `sms_log` for the 1-year `sms_log` retention; texts may contain personal details | M | M | Researcher | Notice draft C in the `PRIVACY.md` appendix covers inbound texts; DPO review of the retention period and of staff access | Open |
| R-26 | Mobile and messaging fixes of 2026-10-28 are not device-verified: Gradle debug and release (R8) builds not run, data-only FCM alert path, SOS hold button, cleartext debug config, critical alert queue | M | H | Researcher | Build, install and run `EVALUATION.md` on the Infinix; check release APK blocks cleartext | Open |
| R-27 | SOS repeat/escalation widens SOS recipients to the Secretary and Punong Barangay (Rule 89 said Admin only) and depends on `BaranguardNotificationWorker` being registered | M | M | Researcher | Owner to confirm scope; run the installer; check `Get-ScheduledTask` | Open (decision owed) |
| R-28 | `BaranguardGsmIngest`, `BaranguardNotificationWorker` and the offer sweeper run only while the user is logged on; after a reboot SOS-by-SMS and queued broadcasts stop until someone logs in | M | H | Out of scope (deployment) | Install as services or enable auto-logon (`install-autostart-services.ps1` covers only Apache, MySQL, cloudflared); Service Health shows no ingest liveness probe yet | Open |
| R-29 | SMS "Sent" only means the SIM accepted the text; no delivery report. "Sent, not confirmed" texts are not retried | M | M | Researcher | Stated in UI and Rule 100; Chief Tanod phones the tanod for anything critical | Mitigated by wording |
| R-30 | JWT and device id are readable by the native alert service (plain storage); Android Keystore not used | L | M | Researcher | Owner decision; DEVLOG 2026-10-28 | Open |

## 2. Defect log

The source reports (`AUDIT_2026-09-07.md`, `audit-2026-10-09/`, `audit-2026-10-28/`, `REMAINING.md` section F) were deleted 2026-10-28 and are in git history (`git log --diff-filter=D -- docs/`); this section is now the only record.

**Only statuses those documents stated are recorded here**; "not stated" means no source says.
"Verified" means what the source said was run, and none of the 2026-10-09 fixes were
browser-verified (jsdom and scripts only). Severity is the audit's own (P0 worst).

### 2.A Audit of 2026-09-07 (F1-F11)

Numbering below is the audit file's own; the old `REMAINING.md` §F numbered a few items differently (response-time item F8, blotter `200 []` item F9).

| ID | Sev | Found | Status | How fixed / verified |
|---|---|---|---|---|
| F1 | P0 | 2026-09-07 | **Reopened 2026-09-15** | API published to the internet. Closed 2026-09-13 via private VPN, VPN decommissioned 2026-09-15; now a Cloudflare Named Tunnel with no Access policy (see section 1 of this file, R-02 and R-03) |
| F2 | P0 | 2026-09-07 | Closed | Stored XSS from unauthenticated citizen report; shared `escapeHtml.js`, fixed 2026-09-12; endpoint later removed (2026-10-07). Stated as proven with dedicated verify scripts |
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

### 2.B Web audit of 2026-10-09

Nine read-only auditors; totals 6 P0, 92 P1, 85 P2, 36 P3 (219 reported,
fewer distinct). Fixed in three committed waves (`a8de978`, `9176842`,
wave 3), recorded in DEVLOG 2026-10-09. The per-finding IDs (V-, X-, R-,
S-, P-, A-, F-, N- series) live in the nine reports; the P0s and the main
fixed groups are below. The remaining P1-P3 findings are **not itemised
here**; DEVLOG lists which IDs each wave covered.

#### The six P0 findings

| ID | Sev | Found | Status | How fixed / verified |
|---|---|---|---|---|
| V-01 | P0 | 2026-10-09 | Fixed | `?api_base=` credential theft: override honoured only for localhost, the page's own host, or `https://api.<page host>`; bad stored values deleted at startup. `web/tests/unit/sessionSecurity.test.mjs` |
| V-03 / R-01 | P0 | 2026-10-09 | Fixed | `patrolZone` stored XSS in swap requests, plus latent sites (fatigue page, `KpiCard`, `DataTable`) escaped or built with `textContent` |
| P-01 / N-18 | P0 | 2026-10-09 | Fixed | Pre-written sworn attestation and "Attested & Approved" removed from PDF and print sheet; blank signature block. `verify-w2-reports.sh` 41; PDF text checked by grep only |
| X-01 / A-03 | P0 | 2026-10-09 | Fixed | Dispatch Center froze looking live: failed polls now keep last data and show an "updates paused" banner |
| X-02 / X-03 / F-03 | P0 | 2026-10-09 | Partly fixed | 401 now returns to sign-in with a notice; unsaved form text is **not** kept, refresh still signs out (deliberate), no hash routing or draft guard |
| N-04 | P0 | 2026-10-09 | Open | No DPO or adopted breach runbook; runbook and DPO template drafted, council action needed |

#### Main fixed groups (not exhaustive)

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

#### Stated as not fixed or needing a decision

| ID | Status |
|---|---|
| V-05 | Not changed: web maps use third-party OSM tiles and fonts; decision needed |
| Idle lock vs Dispatch | Decision needed: 15-min lock also signs out an Admin watching for SOS |
| N-06 | Kagawad needs a `secretary` account (exposes narratives): decision owed |
| N-08, N-10, N-12 | Reported; N-12 addressed by the idle lock, others not stated |
| `tanodWorkflowApi` / `shellWorkflowApi` 401 handling | Stated as not fixed (caught within ~15 s by shell poll) |
| Delete shift route | "Not done" per DEVLOG |
| Legal claims (report 09) | Unverified against primary sources; MC 2026-037 unreadable |

#### Verification the sources state

Not browser-verified. After the waves: `verify-web-wiring.mjs` 914/0,
`web/tests` 742 (an order-sensitive map test can fail in a full run),
h16 59, wave1a 145, roster-accomplishment 339, paper-approvals 280,
w2-reports 41, pentest-incidents 74, sprint4-phase2-3 73, sprint7-audit
60 (HANDOFF, 2026-10-09 snapshot).

### 2.C Mobile and messaging audit of 2026-10-28

Source: the 2026-10-28 audit reports 01-05 (deleted, in git history) and `backend/DEVLOG.md` 2026-10-28. Fixed in the working tree the same day; verified on disposable DBs, vitest (193 tests, 30 files), `verify-local-schema.mjs` (266) and jsdom only. **None is device-verified; Gradle was not run.** IDs are the audit reports' own.

| ID | Sev | Found | Status | What was found / how fixed |
|---|---|---|---|---|
| 03 P0-1 | P0 | 2026-10-28 | Fixed 2026-10-28 (not browser-verified) | Inbound human SMS never stored, so Conversations and unread counts were empty. Now stored via `POST /internal/sms/inbound-text` |
| 03 P0-2 | P0 | 2026-10-28 | Fixed 2026-10-28 | Unconfirmed SMS shown as "Failed" and a sent SMS shown as "Delivered". Now `pending` = "Sent, not confirmed", `sent` = "Sent", never "Delivered" |
| 03 P1-1/P1-2 | P1 | 2026-10-28 | Fixed 2026-10-28 | Outbound SMS and broadcast ran inside the HTTP request and could re-send. Broadcast is queued (`{recipient_count, queued}`), 10-min duplicate guard, 100 cap, worker sends |
| 03 P1-3 | P1 | 2026-10-28 | Fixed 2026-10-28; replay-then-500 fixed 2026-10-29 | Ingest daemon head-of-line blocking and silent drops. Lock, give-up and `rejected` logging added |
| 03 P1-4 | P1 | 2026-10-28 | Fixed 2026-10-28 | Notification worker and ingest daemon never scheduled. `BaranguardNotificationWorker`, `BaranguardGsmIngest` registered by the installer; launcher starts the daemon |
| 03 P1-5 | P1 | 2026-10-28 | Fixed in code, not device-verified | Critical alerts overwrote each other; FCM notification block bypassed the native service. Alert queue, per-alert tray ids, data-only FCM for `sos`, `priority_alert`, `dispatch`, `dispatch_offer` |
| 03 P1-6/P1-7 | P1 | 2026-10-28 | Fixed 2026-10-28 | Dispatch/SOS texts used raw enum names and unlabelled coordinates. Readable GSM-7 text with `Ref: INC-...`; no names or coordinates in push |
| 03 P1-8/P1-9 | P1 | 2026-10-28 | Fixed 2026-10-28 | Conversation showed the oldest 200 messages and did not refresh. Newest 200, auto-refresh |
| 03 P1-10 | P1 | 2026-10-28 | Partly fixed | STOP/TIGIL/UNSUBSCRIBE opt-out added; no confirmation reply and no "Reply STOP" line in the broadcast text yet |
| 04 #2 | P0 | 2026-10-28 | Fixed 2026-10-28, scope pending owner | Unacknowledged SOS went nowhere further. `SosEscalation` repeats every 2 min, Secretary and Punong Barangay from round 3, max 5 |
| 04 #3 | P0 | 2026-10-28 | Fixed in code, not device-verified | SOS only on Home and waited up to 15 s for GPS. SOS control on every Tanod tab (hold 800 ms), GPS wait at most 2 s, Silent SOS option |
| 04 #1 | P0 | 2026-10-28 | Fixed in code (not run after a reboot) | Background jobs not started by anything; see 03 P1-4 |
| 04 #5 | P1 | 2026-10-28 | Fixed 2026-10-28 | My Shifts not cached; now read-only offline copy |
| 04 #9 | P1 | 2026-10-28 | Fixed 2026-10-28 | New Incident saved with a default type and no location; no default type or barangay, GPS auto-tagged |
| 02 P0-1, P1-1 to P1-3 | P0/P1 | 2026-10-28 | Fixed 2026-10-28 | SQLite writes not serialised; sync trigger dropped during a pass; no upload/download timeouts; calls bypassing the sync mutex. Writes serialised (`withTransaction`), follow-up sync pass, timeouts |
| 02 P1-6, P1-8 | P1 | 2026-10-28 | Fixed 2026-10-28 | Patrol GPS service outlived logout; local data not user-scoped. Logout stops the service and scopes lists per user |
| 02 P1-7 | P1 | 2026-10-28 | Fixed 2026-10-28 | Live Map broadcast GPS regardless of duty. Posts only on duty |
| 02 P1-10 / 05 | P1 | 2026-10-28 | Fixed in code, not built | `allowBackup` on and cleartext allowed in release. `allowBackup` off; cleartext only in a debug config; build 11 MB to 5.8 MB, R8 on release |
| 04 doc drift 10-16 | P3 | 2026-10-28 | Fixed 2026-10-28 (docs) | Seven doc-vs-code drifts (seven signed Admin device writes, sync order, SOS resolve wording, Rule 89, power-cut procedure ingest dependency (document since removed), nav-item and check counts, mobile `noted`/`approved` mapping, which does exist in `apiService.ts`) |

**Open after this pass (from the DEVLOG):** names and coordinates in the SOS SMS, native service token storage, hard-coded 911/160 numbers, phone-number masking, no notification list screen, no retry of a failed alert acknowledge, no on-duty status in the assign picker, no tanod decline of a dispatch, no cancel or swap notification. `verify-web-wiring.mjs` showed 936/32 in the DEVLOG run; re-run 2026-10-28 for this reconciliation it shows 938 passed, 0 failed.
