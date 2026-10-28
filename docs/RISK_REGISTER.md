# Baranguard — Risk Register

Purpose: list of known project risks with likelihood, impact and status.
Status: compiled 2026-10-23 from `HANDOFF.md`, `REFERENCE.md` §1 and `DEFECT_LOG.md`; last updated 2026-10-28.
Likelihood and impact are the compiler's judgement (H/M/L), not measured; the source docs do not rate them.
Owner "Researcher" = the thesis author, for risks that fall inside the evaluated scope; "Out of scope" = needs a deployment or a barangay council action, and the system is not deployed.
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
| R-10 | Device verification owed: SOS envelope SMS, `sms_failed` path, no-GPS SOS, device-signature keys, FCM end to end, outdoor GPS run | M | H | Researcher | Run the plans in `SPRINT8_DEVICE_TEST_PLANS.md` | Open |
| R-11 | No DPO designated; breach runbook is a draft not adopted by the council; draft privacy notices lack staff hours, availability and school check-ins | M | H | Out of scope (barangay council) | No DPO designation template or breach runbook is adopted; the council would need to adopt both before any deployment. Notice drafts are in the `PRIVACY_IMPACT_ASSESSMENT.md` appendix | Open |
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
| R-24 | Thesis evaluation: nothing measured yet for ISO 25010 plan | M | M | Researcher | Run `ISO25010_EVALUATION_PLAN.md`; report only real numbers | Open |
| R-25 | Inbound texts now stored: a citizen's number and message sit in `sms_log` for the 1-year `sms_log` retention; texts may contain personal details | M | M | Researcher | Notice draft C in the PIA appendix covers inbound texts; DPO review of the retention period and of staff access | Open |
| R-26 | Mobile and messaging fixes of 2026-10-28 are not device-verified: Gradle debug and release (R8) builds not run, data-only FCM alert path, SOS hold button, cleartext debug config, critical alert queue | M | H | Researcher | Build, install and run `SPRINT8_DEVICE_TEST_PLANS.md` on the Infinix; check release APK blocks cleartext | Open |
| R-27 | SOS repeat/escalation widens SOS recipients to the Secretary and Punong Barangay (Rule 89 said Admin only) and depends on `BaranguardNotificationWorker` being registered | M | M | Researcher | Owner to confirm scope; run the installer; check `Get-ScheduledTask` | Open (decision owed) |
| R-28 | `BaranguardGsmIngest`, `BaranguardNotificationWorker` and the offer sweeper run only while the user is logged on; after a reboot SOS-by-SMS and queued broadcasts stop until someone logs in | M | H | Out of scope (deployment) | Install as services or enable auto-logon (`install-autostart-services.ps1` covers only Apache, MySQL, cloudflared); Service Health shows no ingest liveness probe yet | Open |
| R-29 | SMS "Sent" only means the SIM accepted the text; no delivery report. "Sent, not confirmed" texts are not retried | M | M | Researcher | Stated in UI and Rule 100; Chief Tanod phones the tanod for anything critical | Mitigated by wording |
| R-30 | JWT and device id are readable by the native alert service (plain storage); Android Keystore not used | L | M | Researcher | Owner decision; DEVLOG 2026-10-28 | Open |
