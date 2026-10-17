# What to revise in the capstone manuscript (as of 2026-10-17)

Compared against: the manuscript HTML (`Baranguard_Capstone_Manuscript.html`), `docs/REFERENCE.md`, `docs/WORKFLOWS_AND_RULES.md` (rules 1-88), `docs/THESIS_OBJECTIVES_ALIGNMENT.md`. The four objectives (1.2) still match the system, so the structure stays; the changes are in what the system does and how it is tested.

## A. Remove or replace (the system no longer does this)

| Where | What the paper says | What is true now |
|---|---|---|
| Title area, 1.1, 1.3, 1.4, 2.1.3, 2.2, 2.3, 2.4 (about 60 mentions) | AI/SLM: Llama-SEA-LION-v3.5-8B-R via Ollama summarizes narratives and redacts PII | Removed 2026-10-01 (migration 0029). No AI of any kind. |
| 1.1, 1.4, 2.2, 2.4, 3.2.0, 3.3.1, 3.3.3, 3.4, Appendix D-5 | Electronic blotter with human-reviewed redaction before a "public-facing record" | Removed. Barangays keep blotter and Lupon records in binders; DILG BIMSS/KPIS is the case ledger. Baranguard complements it. |
| 2.2 table row, 2.4, 3.3.1 (4 mentions) | Lupon packet generation; 4 Lupon respondents | No Lupon account, no packet. Lupon is not a user. |
| 3.1.1, Appendix A | Semaphore SMS gateway | Local GSM gateway: a tethered Android phone with its own SIM (`sms-gateway/`). |
| 3.1.2 | Whole subsection "SLM Model Selection Rationale" and Table 2 | Delete. |
| 3.1.3, Table 3 | Workstation sized for 4-bit AI inference | Re-size for the real load: PHP, MariaDB, Apache, tunnel. |
| Table 5 stories 5 and 6; Table 6 sprints 5 and 6 | PII redaction and SLM stories; Ollama and redaction-pipeline sprints | Remove or replace (see C). |
| Table 7 | SLM validation testing, summarisation fidelity, "AI omission, missed redaction" safety scenarios, 4-bit inference performance test | Delete those rows; see D. |
| 3.3.3 (whole), 3.3.4 | PII Masking Validation (350-record dataset, recall 95 percent, precision 90 percent) | Delete 3.3.3. Rewrite 3.3.4 acceptance criteria without the AI and PII-masking items. |
| 3.4 Ethical considerations | "No citizen data transmitted to an AI provider", synthetic redaction data | Keep the consent, voluntary and synthetic-data points. Replace the AI sentence with: "no AI is used; only route requests leave the system (see B)". |
| 2.1.3 | Literature review on AI, SLMs and PII redaction | Replace with literature on data privacy and records handling in LGUs. Keep only citations you still use. |
| References | About 11 entries on AI, PII redaction, SLMs | Remove the ones no longer cited. Keep RA 10173, ISO 25010, offline-first and barangay-system sources. |

## B. Correct (the idea stays, the facts changed)

- **Data leaving the system.** One external cloud call exists: OpenRouteService route requests (GPS position and incident location). Also OpenStreetMap map tiles and FCM push. The paper says everything stays local.
- **Table 1 versions.** Ionic is React 9 (not 8.8.5), Capacitor 8.5 (not 8.0), MariaDB 10.4 (XAMPP, not MySQL 8.0 in the text), PHP 8.2/8.3, SQLCipher encrypted SQLite. Re-check every row against `package.json` and `composer`/XAMPP.
- **Offline-first and SMS fallback (Objectives 2 and 3).** Keep, but state what is built: an encrypted SOS text to the gateway phone plus a plain text to a backup contact; location uses the last known fix or "no fix"; best-effort only; SOS, not general reporting. Say "implemented, not yet device-verified" until the device test is done.
- **Real-time tracking (Objective 1).** Say near-real-time by polling (about 15 s dashboard, 30-90 s phone GPS), not real-time.
- **Population and barangay facts.** Check the PhilAtlas/PSA numbers and source dates.
- **Appendices A-D.** The DFD, use-case, ER diagram and screenshots show the old design: Semaphore, AI assistant, Electronic Blotter screen (D-5), Redaction. Redraw them from the current system. Screenshots of the login, dashboard, dispatch, GIS and tanod app can be retaken.

## C. Add (built since the paper, worth describing)

- **Roles and authority:** Admin (Chief Tanod), Secretary (records officer), Punong Barangay, Tanod; approval authority as a setting, not a role.
- **Tanod workflow:** roster (draft, published), availability, monthly accomplishment report, referrals, night dispatch offers, school zones (Annexes B, C-1, D, draft layout).
- **Paper-first signing:** reports and rosters are printed and signed on paper; the app does not track signatures.
- **Privacy and retention:** one-year retention, `raw_narrative` never leaves the system, audit log with identifiers only, device-signed writes.
- **New user stories** to replace 5 and 6: for example "As a Chief Tanod I want to assign the nearest on-duty tanod and send an offer at night", "As a Secretary I want reports printed for paper signing".
- **Report intake:** staff log walk-in, phone, Facebook and SMS reports; no public form.

## D. Evaluation chapter (3.3): what changes

- Keep: ISO/IEC 25010:2023 (nine characteristics), Likert scale and Table 9, weighted mean, 27 respondents. Re-count respondents without the 4 Lupon members, or say who replaces them (Kagawad, Secretary, Punong Barangay in groups).
- Keep as real methods you can run: unit and integration tests (about 38 backend suites and 732 web tests exist), UAT scenarios (`docs/chapter4-instruments/04-uat-signoff.html`), safety scenarios without the AI rows (GPS error, duplicate alerts, delayed SMS, misassigned dispatch).
- Replace the AI validation with: security tests (tenant isolation, auth and lockout), offline duplicate tests, performance (API response time, GPS delivery delay, sync success).
- **Do not report any number you have not measured.** Performance, reliability and SUS results come after the device test day and the UAT.

## E. Smaller edits

- Abstract and any keywords that mention AI, SLM or redaction.
- 1.3 Significance: remove "automated PII redaction" and "AI" benefits; keep tanods, administrators, researchers, community.
- 1.4 Scope and Delimitations: rewrite the delimitations. State what is out of scope: no case registry, no blotter, no Katarungang Pambarangay records, no AI, one workstation, four barangays, SMS fallback for SOS only.
- Definition of Terms: delete SLM, human-in-the-loop, PII (if unused), edge AI; add Chief Tanod, accomplishment report, roster.
- Figure 1 and Figure 2 (situational awareness, IPO): remove the AI redaction and summarization boxes.

## Suggested order
1. Settle the barangay interview answers and run the device test day (so facts are final).
2. Rewrite Chapters 1 and 2 (A, B, E).
3. Rewrite Chapter 3 (materials, methods, evaluation) (A, C, D).
4. Redraw appendix diagrams and retake screenshots.
5. Fill Chapter 4 only with measured results.
