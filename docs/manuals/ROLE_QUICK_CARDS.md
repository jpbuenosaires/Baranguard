# Baranguard — Role Quick Cards

One page per role. Print each on A4 (one card per page). Full steps are in the manuals. Written from the code of 2026-10-23; screens not checked in a browser or on a phone by the writer. Never write a password on a card.

<div style="page-break-after: always;"></div>

## CHIEF TANOD (Admin) — quick card

**Web:** Dispatch Center, Incident Management, Personnel, Approvals.  **Phone console tabs:** SOS, Dispatch, Incidents, Profile.

**Sign in.** Wrong password 5 times locks 15 minutes. Web signs out after 15 minutes without input.

**Assign a tanod.** Dispatch Center, card PENDING, **Dispatch Tanod**, pick on-duty tanod, confirm. No published shift: write the override reason.
**More help:** **Add Responder**.  **Pull off:** **Cancel**, write a reason (works even after arrival).

**Night offer (18:00 to 06:00).** Opens by itself. First tanod to accept wins. 180 seconds, 3 rounds, then escalated: assign someone yourself. By day: **Broadcast to on-duty tanods**. Withdraw: **Cancel broadcast**.

**SOS.** **Locate**, **Acknowledge** (alert stays), contact the tanod, **Resolve** only when safe. "No location": phone the tanod now.

**Resolve an incident.** Tanod sent, all dispatches ended: **Resolve Incident**. Nobody sent: **Resolve without dispatch** plus a reason.
**Cannot:** mark duplicate, invalid, cancelled or reopened (Secretary). Cannot edit the complainant name.

**Roster.** Personnel, Scheduler: **+** adds a draft (Morning 06-14, Afternoon 14-22, Night 22-06). Max 12 hours per tanod per day. **Print preview**, officials sign the paper, **Publish week**. Editing a published shift's tanod or time makes it Draft again. Swaps: **Approve** or **Deny**.

**Users.** Personnel, Users: **Add User** (password at least 12 characters, mixed case, a digit). **Suspend** signs the person out at once.

**Phone.** Needs a connection. SOS: **Acknowledge**, then **Mark resolved**. Dispatch: **Cancel dispatch** (reason), **Cancel offer**. Incident sheet: **Assign more responders**, **Take over (offer to on-duty Tanods)**. **Log an incident** (saved on the phone if there is no signal). No narratives on the phone.

**Power or internet down.** Paper logbook, then enter afterwards. See `docs/POWER_CUT_PROCEDURE.md`.

<div style="page-break-after: always;"></div>

## SECRETARY — quick card

**Web:** Incident Management (your home), Accomplishment Reports, Safer School Zones, Referral Log, Personnel, Dispatch Center. No phone console.

**Sign in.** Wrong password 5 times locks 15 minutes. Web signs out after 15 minutes without input.

**Log a report.** Incident Management, **New Incident**: type, priority, **Report channel** (walk-in, phone call, Facebook, SMS, other), place, description, **Log an Incident**.

**Narrative.** You and the Chief Tanod (web only) read it. Never send it by SMS or chat. Deleted after one year. Not shown to the Punong Barangay.

**Lifecycle (only you).** Incident record, **Case lifecycle**:
- Pending, Dispatched or Reopened: **Mark as duplicate** (type the original number, for example INC-2026-048), **Mark invalid**, **Cancel this incident**.
- Closed (Resolved, Cancelled, Invalid, Duplicate): **Reopen this case** only.
- Blocked while a dispatch is still active (reopen is always allowed).
- **Related incident**: link two incidents without changing status.

**Refer.** Incident record, Referrals: pick the office (PNP, BFP, EMS, Lupon/KP and others), **Record referral**. It means handed over, not accepted. No names.

**Print accomplishment reports (A4).** Accomplishment Reports, open a Prepared report, **Preview & print**, or tick several and **Batch Preview & print**. Sign on paper outside the app. Wrong report: **Return to tanod** with a reason.

**Schools.** Safer School Zones: **Add school** (Annex B). C-1 text on the incident record (short, no student names). Annex D: dates, **Create draft term report**, **Mark as prepared**, print and sign, enter who at the Mayor's office received it, **Mark submitted** (cannot be undone). All annexes are draft layouts.

**Back-up dispatcher.** **Dispatch Tanod** or **Add Responder**; **Cancel** needs a reason; **Broadcast to on-duty tanods**; resolve from Incident Management (the record page shows Dispatch and Resolve to the Admin only). SOS and offer alerts go to Admin accounts, so keep Dispatch Center open.

<div style="page-break-after: always;"></div>

## PUNONG BARANGAY — quick card

**Web:** Dashboard (your home), Live Map, Analytics, Approvals, Accomplishment Reports, Referral Log, Safer School Zones, Personnel (Scheduler, read only).

**Sign in.** Wrong password 5 times locks 15 minutes. Web signs out after 15 minutes without input.

**Dashboard.** Attention banner (SOS, waiting dispatch, reopened). Cards: Total Incidents, Avg. Response Time (reported to first arrival, never a ranking), Tanods On Duty (count only). Recent incidents: open plus last 30 days. **Download Weekly Digest PDF**: system-generated, unsigned.

**Live Map.** Your barangay only. Stale position (older than about 2 minutes) is not live. SOS always on top. You cannot call or dispatch: tell the Chief Tanod.

**Analytics.** Reports: pick dates, **Print preview**, **Export CSV**, **Download PDF**. Sign the blank "Reviewed and approved by" block on paper. Heatmap: past patterns only.

**One incident.** Open from the dashboard. You see the operational summary. You do not see the narrative, complainant, respondent or evidence. Search by exact incident number only.

**Sign on paper.** The Chief Tanod or Secretary prints the roster, accomplishment reports and Annex D on A4. You review and sign the paper. The app does not record signatures. Approvals usually shows "Nothing waiting for you".

**You cannot:** dispatch, resolve, edit incidents, see Users, SMS Monitor, Audit Log, Service Health, Map Packages, or tanod names on the dashboard.

**Problem?** SOS banner: tell the Chief Tanod at once. Wrong record: ask the Secretary.
