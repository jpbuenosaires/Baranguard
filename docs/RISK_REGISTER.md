# Baranguard — Risk Register

Compiled 2026-10-23 from `HANDOFF.md` (open decisions and unresolved
items), `REMAINING.md`, `REFERENCE.md` §1, and `audit-2026-10-09/`.
Likelihood and impact are the compiler's judgement (H/M/L), not measured;
the source docs do not rate them. Owners are TBD unless a doc names one.
Status reflects what the source docs say as of their last update; verify
before relying on it.

| ID | Risk | Likelihood | Impact | Owner | Mitigation | Status |
|---|---|---|---|---|---|---|
| R-01 | Single point of failure: everything depends on one workstation being powered and online | M | H | TBD | SOS has a device-local SMS fallback; `POWER_CUT_PROCEDURE.md`; UPS / backup internet is unsolved; cloud hosting was considered and rejected by the user | Open |
| R-02 | Public tunnel (`baranguardph.win`) currently reaches the demo DB `baranguard_uiseed`, not real data; switching `DB_NAME` is deferred | H | M | TBD | Decide which DB backs the tunnel; check `DB_NAME` before any real-data claim | Open (deliberate user decision) |
| R-03 | No Cloudflare Access policy: API reachable by anyone with the URL | M | H | TBD | Scope any Access policy to the web host only, never the API (breaks mobile and public endpoints); steps worked out in DEVLOG | Deferred by user |
| R-04 | Migrations 0029-0045 not applied to the real `baranguard` DB; code paths will 500 against it; 0029, 0041, 0042 are destructive | H | H | TBD | Back up, apply in order as DBA/root; rehearsed on scratch copies 2026-10-08 (0029-0038) | Open |
| R-05 | Tunnel starts only as a user process, not a Windows service; does not survive reboot | M | M | TBD | Run `install-autostart-services.ps1` elevated | Open |
| R-06 | Dispatch offer sweeper scheduled task `BaranguardDispatchOfferSweeper` not registered on this machine | M | M | TBD | Run `install-scheduled-backup-jobs.ps1` | Open |
| R-07 | New code unverified in real conditions: tanod-workflow pages not browser-verified by an agent, mobile screens and offline sync of new kinds never run on a device | M | H | TBD | Browser pass (user) and device pass | Open |
| R-08 | Concurrency (12 h/day cap race, first-accept-wins offers) reasoned, not demonstrated; `php -S` is single-threaded | L | M | TBD | Test under real Apache | Open |
| R-09 | Native critical-alert changes (`dispatch_offer` full-screen alert) only syntax-checked, never compiled in Gradle or run | M | M | TBD | Build and test on device | Open |
| R-10 | Device verification owed: SOS envelope SMS, `sms_failed` path, no-GPS SOS, device-signature keys, FCM end to end, outdoor GPS run | M | H | TBD | Run the plans in `SPRINT8_DEVICE_TEST_PLANS.md` | Open |
| R-11 | No DPO designated; breach runbook is a draft not adopted by the council; privacy notices lack staff hours, availability and school check-ins | M | H | TBD (barangay council action) | `DPO_DESIGNATION_TEMPLATE.md`, `BREACH_RESPONSE_RUNBOOK.md`; update `PRIVACY_NOTICES.md` | Open |
| R-12 | Retention for new tables not decided by council/COA (provisional 365 days, purge OFF); Rule 10 needs architecture review | M | M | TBD | Council/COA decision | Open |
| R-13 | Legal text unverified: MC 2026-037 and Annex A unreadable; other legal statements from secondary sources | M | M | TBD | Obtain circular PDFs from dilg.gov.ph; Annex layouts are marked draft | Open |
| R-14 | Kagawad has no role: needs a `secretary` account, which also exposes raw narratives | M | M | TBD | Owner decision on account model | Open |
| R-15 | Shared barangay-hall PC may stay signed in; 15-min idle lock also signs out an Admin watching Dispatch for SOS | M | M | TBD | Decide lock duration / Dispatch exemption | Open (decision owed) |
| R-16 | Web maps use third-party OSM tiles (leaks viewed areas, undermines "offline" claim) | M | L | TBD | Vendored/offline tiles, or disclose in privacy notice | Open (decision owed) |
| R-17 | MFA (C-02) not implemented | L | M | TBD | Explicitly deferred by user | Deferred |
| R-18 | Operational dependencies: `ext-curl` under Apache needs four `LoadFile` lines outside the repo; breaks silently if XAMPP PHP is swapped | L | M | TBD | Re-add lines (REFERENCE §8) | Mitigated by documentation |
| R-19 | `mobile/.env.local` leaks `localhost` API URL into release APKs | M | H | TBD | Always set `VITE_API_BASE_URL` explicitly; grep the bundle | Mitigated by documentation |
| R-20 | Orphaned second tunnel `baranguard-main` on the `danilyn` machine | L | M | TBD | Ask before touching or deleting | Open |
| R-21 | Positioning risk: duplicating DILG BIMSS records functions would be a legal liability | L | H | TBD | Settled rule: complement, never replace; no browsable case registry | Mitigated by design rule |
| R-22 | Attendance evidence accepted by treasurer/COA for honoraria unknown | M | M | TBD | Ask the barangay | Open |
| R-23 | Known npm advisory: react-router v6 (open redirect, SSR constructor injection) blocked by `@ionic/react-router` peer cap | L | L | TBD | Revisit when Ionic supports v7/v8 | Deferred |
| R-24 | Thesis evaluation: nothing measured yet for ISO 25010 plan | M | M | TBD | Run `ISO25010_EVALUATION_PLAN.md`; report only real numbers | Open |
