# Baranguard — Project Context
*Paste this file (or point to it) at the start of every AI coding session.*
*Full detail lives in the companion docs listed at the bottom — this file is
the condensed version for quick reference.*

---

## What This Is

Baranguard: Barangay Intelligence and Emergency Dispatch System. Offline-first,
cloud-assisted incident reporting and emergency dispatch platform for four
barangays (Dao, Binanuahan, Marifosque, Banuyo) in Pilar, Sorsogon, Philippines.
IT capstone project, Bicol University.

---

## Stack

- **Backend:** PHP 8.2 + Node.js
- **Web frontend:** Vanilla JS (ES2023+), plain CSS (no framework — custom
  properties for theming, kebab-case classes, no build step required)
- **Mobile:** Ionic Framework 8.8.5 + Capacitor 8.0 (Android)
- **Cloud DB:** MySQL 8.0 (AWS/Azure) — central database + web dashboard only
- **Mobile local DB:** SQLite / Room — offline incident cache
- **AI:** Llama-SEA-LION-v3.5-8B-R via Ollama, self-hosted on the unified
  administrative workstation — **never** call external AI APIs
- **SMS:** Semaphore SMS Gateway + tethered mobile phone as local GSM modem

---

## Non-Negotiable Architecture Rules

1. **No unredacted PII ever leaves the local environment.** Raw incident
   narratives are never sent to external APIs — only the locally-hosted SLM
   touches them.
2. **All incident capture works fully offline, zero data loss.** SQLite
   local cache is the source of truth until sync; sync is opportunistic.
3. **AI redaction requires human approval before permanent storage.** Only
   the barangay secretary's explicit approval action
   (`POST /incidents/:id/ai-draft/approve`) may write to
   `incident.redacted_narrative`. No other code path may write that field.
4. **SMS fallback triggers only after failed connectivity check** — see
   trigger rule below. Don't fall back prematurely or leave it hanging too long.
5. **No Class 0/Flash SMS, no telecom-layer silent SMS.** Confirmed
   unsupported by Semaphore or any comparable gateway (requires direct SMSC
   access). Critical alerts use Semaphore's `/priority` endpoint + app-layer
   full-screen overlay instead. "Background" coordinate pings are regular
   SMS parsed silently server-side, not silent at the protocol level.
6. **RBAC enforced server-side only.** Client-side role checks are UX only,
   never the actual security boundary. See Role & Permission Matrix.
7. **Cloud hosts the database + dashboard; AI inference is local**, on the
   same unified administrative workstation — not split across separate
   servers.

---

## Offline-Detection Trigger (Decided)

3 consecutive failed API health-check pings, 5-second timeout each, spaced 2
seconds apart → declare offline after ~21 seconds, then trigger SMS fallback.
Recheck connectivity on next user action + a background ping every ~30s;
revert to normal mode as soon as one succeeds. (Rationale: no fixed industry
standard exists; this is adapted from general short-timeout/limited-retry/
fast-fallback mobile connectivity practice, tightened for the safety-critical
dispatch use case — see Feature Backlog for full reasoning.)

---

## Fatigue Flag Threshold (Decided)

Flag when a tanod's rolling 7-day total exceeds **48 hours**. Adapted
analogously from the Labor Code's general 8-hr/day standard — tanods are
honorarium-based barangay personnel, not Labor Code employees, so this is a
safety benchmark, not a claimed legal requirement. State this distinction
explicitly in Chapter 3 methodology.

---

## Roles

`admin`, `dispatcher`, `secretary`, `tanod`, `punong_barangay`, `lupon`
— full permission matrix in `Baranguard_Role_Permission_Matrix.md`. Quick
summary: Secretary is the only role that can approve PII redaction. Tanod is
mobile-only, field data capture + own dispatch/duty status. Admin has full
system + scheduling control. Dispatcher manages live dispatch/GPS/reports.
Punong Barangay and Lupon are mostly read-only (Lupon sees redacted
narratives only, for dispute resolution cases).

---

## Naming Conventions (quick reference — full detail in Naming Conventions doc)

- DB fields + API JSON keys: `snake_case`
- PHP: `snake_case` · JS/TS: `camelCase`
- **Boundary rule:** snake_case → camelCase conversion happens in ONE central
  API client file per platform (`apiClient.js` web, `apiService.ts` mobile).
  Never convert ad-hoc inside components.
- Git commits: `[SprintN][USx] Short description`

---

## Folder Structure (summary — full tree in Naming Conventions doc)

```
/backend    → /routes /controllers /models /middleware /services(/sms /ai /sync) /config /migrations
/web        → /src/pages /src/components /src/styles /src/services /src/assets
/mobile     → /src/pages /src/components /src/services /src/db /android
/ai         → /prompts /test-data
/docs       → PROJECT_CONTEXT.md + all planning docs + DEVLOG.md + /evidence
```

---

## Sprint Map (Table 6, manuscript)

| Sprint | Weeks | Focus |
|---|---|---|
| 0 | 1–2 | Cloud setup, DB schema |
| 1 | 3–4 | Web command center + GIS dashboard |
| 2 | 5–6 | Mobile UI + offline SQLite cache |
| 3 | 7–8 | GPS tracking + async cloud sync |
| 4 | 9–10 | SMS gateway integration |
| 5 | 11–12 | Ollama + Llama-SEA-LION setup |
| 6 | 13–14 | PII redaction pipeline + validation |
| 7 | 15–16 | RBAC, security hardening, integration testing |
| 8 | 17–18 | UAT + ISO/IEC 25010:2023 evaluation |

---

## Companion Documents (full detail — reference as needed per task)

- `Baranguard_Feature_Backlog.md` — full sprint-mapped feature list, all
  acceptance criteria, resolved technical decisions
- `Baranguard_Database_Schema.md` — field-level schema, cloud + local mirror
- `Baranguard_API_Contract.md` — every endpoint, request/response shapes,
  Security Design Rationale
- `Baranguard_Screen_Inventory.md` — every screen, web + mobile
- `Baranguard_Role_Permission_Matrix.md` — full action × role access table
- `DEVLOG.md` — session-by-session build log (create/maintain during dev)

---

## Daily Session Checklist

- [ ] Re-share this file (or relevant sections) if starting a new AI session
- [ ] Confirm current schema/API state hasn't drifted (check migrations)
- [ ] Scope today's task to ONE backlog item, not multiple
- [ ] Test manually after AI builds it — don't just trust it
- [ ] Commit with `[SprintN][USx]` message
- [ ] Log bugs/deviations/future-work ideas in DEVLOG.md
- [ ] Save evidence (screenshot/test log) for demoable features
