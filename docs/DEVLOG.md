# Baranguard — Development Log

Session-by-session build log. One entry per work session, filed under its
sprint. This is your evidence trail for Chapter 4 (Sprint Review minutes) and
Chapter 3.2.5 (Sprint Retrospective) — keep it honest and specific, not vague.

**Entry format:**
```
### [Date] — SprintN — Short title
- What was built/attempted
- Issues encountered
- AI tool used
- Status: Done / In Progress / Blocked
```

---

## Pre-Sprint (Week 0) — Baseline Measurement

*(Log baseline data collection sessions here — see Phase 1 guide)*

---

## Sprint 0 (Weeks 1–2) — Cloud Setup + DB Schema

### Example entry — delete once you start logging real sessions
```
### 2026-09-01 — Sprint 0 — Cloud environment + initial schema
- Set up AWS RDS MySQL 8.0 instance
- Ran initial migration from Baranguard_Database_Schema.md (barangay, user,
  incident tables)
- Issue: RDS free-tier connection limit hit during testing — switched to
  connection pooling
- AI tool used: Claude Code
- Status: Done
```

---

## Sprint 1 (Weeks 3–4) — Web Command Center + GIS Dashboard

---

## Sprint 2 (Weeks 5–6) — Mobile UI + Offline SQLite Cache

---

## Sprint 3 (Weeks 7–8) — GPS Tracking + Async Cloud Sync

---

## Sprint 4 (Weeks 9–10) — SMS Gateway Integration

---

## Sprint 5 (Weeks 11–12) — Ollama + Llama-SEA-LION Setup

---

## Sprint 6 (Weeks 13–14) — PII Redaction Pipeline + Validation

---

## Sprint 7 (Weeks 15–16) — RBAC, Security Hardening, Integration Testing

---

## Sprint 8 (Weeks 17–18) — UAT + ISO/IEC 25010:2023 Evaluation

---

## Deviations / Scope Changes Log

*(Track anything that diverged from the original manuscript here — useful
for your defense so nothing surprises you. E.g. Flash SMS → priority SMS +
in-app overlay, approved shift-swap scope addition, etc.)*

| Date | Original plan | What changed | Reason | Adviser informed? |
|---|---|---|---|---|
| — | Flash SMS (Class 0) | Semaphore `/priority` endpoint + app-layer full-screen overlay | Class 0 requires direct SMSC access, unsupported by third-party gateways | ☐ |
| — | Silent SMS location ping | Regular SMS parsed silently server-side | Telecom-layer silent SMS unsupported by consumer gateway APIs | ☐ |
| — | N/A | Shift schedule, shift swap, drag-drop scheduler, fatigue flag added | Approved scope addition | ✓ |

---

## Future Work / Ideas (for Chapter 5 Recommendations)

*(Capture anything tempting-but-out-of-scope here as you build, instead of
scope-creeping mid-sprint — this becomes free material for your Chapter 5.)*

-
