# Baranguard — Personal Data Breach Response Runbook

**DRAFT for the barangay council and the Data Protection Officer to review.
Not yet adopted.** Status: drafted 2026-10-09 from the repo's own audit
(`docs/audit-2026-10-09/09-barangay-norms-standards.md`, finding N-04).

Use this when you think personal data may have been seen, copied, lost,
changed or destroyed by someone who should not have had it.

---

## 1. Is it a personal data breach?

Treat it as a possible breach if ANY of these is true:

| Example from this system | Why it counts |
|---|---|
| A phone with the Tanod app is lost or stolen (it holds encrypted offline data and a signed-in session) | Device may expose GPS, incidents, shifts |
| The workstation (or its disk / backup drive) is stolen | Whole database and backups may be readable |
| Ransomware or a virus locks the workstation files | Records are unavailable or may leak |
| Someone who is not the Secretary opened or printed a confidential narrative | Narratives are Secretary-only by law and by design |
| A backup file or a backup passphrase is found or shared where it should not be | Full copy of records exposed |
| The public tunnel address (`baranguardph.win` / `api.baranguardph.win`) is found exposing live records | Anyone with the URL may see data |
| A printed report or CSV export is left in a public place or sent to the wrong person | Personal data disclosed |
| A user account is used by someone else, or a password is shared | Access by an unauthorised person |

If you are not sure, treat it as a breach and start the checklist. A
false alarm costs an hour; a missed breach can cost the barangay its
legal standing.

---

## 2. First-hour checklist

Do these in order. Write the time of each step in the breach log (section 5).

**A. Contain (first 15 minutes)**

1. **Stop further access.** Suspend the user account involved
   (Admin: Users tab, *Suspend*). This ends its sessions on the next request.
2. **Deactivate the phone** if a Tanod device is lost or stolen (Admin:
   Devices, *Deactivate*). This stops the device session and its push
   tokens.
3. **Change the password** of any account that may be known to others
   (Admin or the user: *Change password*).
4. **Take the workstation offline** from the public tunnel if the exposure
   is online (stop the tunnel with the Baranguard launcher, or the
   Cloudflare tunnel service). Do not delete anything.
5. **Do not wipe, reinstall or "clean up"** the machine yet. That destroys
   evidence.

**B. Preserve evidence (next 15 minutes)**

6. **Save the audit log.** Admin: Audit Log, filter by the date range and
   the user or device. Export it and keep the file outside the shared folder.
   The audit log holds ids and statuses only, not narratives.
7. **Note what you saw**: date, time, who found it, what was seen, which
   device or account. Write it on paper too.
8. **Keep the backups.** Do not prune or delete them. Backup pruning
   is blocked while a legal hold exists (REFERENCE.md, migration 0035).
   If the incident may lead to a case, put the affected incident(s) on
   **legal hold** (assumed to be a Secretary action; confirm in the app).
9. **Photograph** the lost device's last known state or the screen showing
   the exposure (no personal data in the photo beyond what is needed).

**C. Tell the right people (within the hour)**

10. Tell the **Punong Barangay** and the **Data Protection Officer** (see
    `docs/DPO_DESIGNATION_TEMPLATE.md`). If no DPO has been designated yet,
    tell the Punong Barangay and the Secretary.
11. Tell the **Chief Tanod** if a device or account is involved.
12. Ask the Secretary to confirm which records and people are involved.

**Phone numbers and contacts to fill in before use (not verified):**

- NPC contact: ______________________ (to verify at privacy.gov.ph)
- PNP (if theft or a crime is suspected): ______________________
- Municipal ICT / system administrator: ______________________
- Cloudflare / internet provider: ______________________

---

## 3. Notification steps

> **72-hour clock — SECONDARY SOURCE, verify against privacy.gov.ph before
> relying on it.** NPC Circular 16-03 is reported to require notice to the
> NPC within 72 hours after the controller knows of a notifiable breach,
> and notice to affected people without undue delay. The exact trigger
> conditions, the form, and whether a written report is needed within
> the 72 hours must be confirmed from the circular itself.

1. **Decide if it is notifiable.** Ask: does it involve sensitive personal
   information (health, criminal-allegation content, the narrative) or
   information that could enable identity fraud, AND is there a real risk
   of serious harm to the people involved? Write the decision and the
   reason in the breach log, even if the answer is "no".
2. **Record the time you learned of the breach.** The 72-hour clock is
   counted from then (verify).
3. **Notify the NPC** through its official channel (verify the form and
   address at privacy.gov.ph). Include: what happened, when, what data,
   how many people, what was done to contain it, and who to contact.
4. **Notify affected people** in plain language, in the way the barangay
   can reach them. Say what happened, what data, what the barangay is
   doing, and how to ask questions.
5. **Keep copies** of everything sent, with dates.
6. **Follow up.** Record the outcome and any NPC instruction in the log.

---

## 4. Lessons and fixes

Within 30 days, the DPO and Punong Barangay write a short note: cause,
what changed, and whether the PIA (`docs/PRIVACY_IMPACT_ASSESSMENT.md`)
or the data inventory needs updating.

---

## 5. Breach log (one row per event; keep this table in a locked file)

| Log no. | Date / time discovered (Manila) | Discovered by | What happened (no names of affected people) | Data and no. of people affected (estimate) | Account / device involved | Contained at (time, step taken) | Notifiable? (yes / no, reason) | NPC notified (date/time, ref) | Affected people notified (date/time, how) | Lessons / fix (date) | Closed by (name, date) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BR-001 | | | | | | | | | | | |
| BR-002 | | | | | | | | | | | |

---

## 6. Roles

Fill in the names. Do not fill in a name for a role that has not been
designated.

| Role | Responsibility in a breach | Name | Contact |
|---|---|---|---|
| Data Protection Officer (to be designated by the Sangguniang Barangay) | Leads the response, decides notifiability with the PB, keeps the breach log, sends NPC and public notices | __________________ | __________________ |
| Punong Barangay | Approves notifications, speaks for the barangay, decides on any outside referral | __________________ | __________________ |
| Chief Tanod | Handles lost or stolen devices, suspends and deactivates accounts and devices | __________________ | __________________ |
| Secretary (records custodian) | Confirms which records and people are involved; the only role that reads narratives; applies legal hold | __________________ | __________________ |

---

## 7. Items to verify before adopting this runbook

- NPC Circular 16-03: 72-hour clock, trigger conditions, form (verify at privacy.gov.ph).
- RA 10173 Sec 20(f) breach-notification duty and Sec 21 accountable person (verify wording against the Act).
- Whether a barangay's breach notice goes to the NPC directly or through the municipality.
- Local emergency and police contacts (section 2).
