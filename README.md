# Baranguard

Purpose: project overview and map of the docs.
Status / Last updated: 2026-10-28. Thesis defense, ISO 25010 evaluation and UAT scope; not deployed.

Barangay Intelligence and Emergency Dispatch System — offline-first,
locally hosted incident reporting and emergency dispatch platform for four
barangays (Dao, Binanuahan, Marifosque, Banuyo) in Pilar, Sorsogon,
Philippines. IT capstone project, Bicol University.

## Getting started

New machine: **[`docs/SETUP.md`](docs/SETUP.md)** — clone, bootstrap the
database, run the API and dashboard (section 1), build the mobile app
(section 2). Every step in it has actually been run against a disposable
database, not just described.

## Start here (for working on the codebase)

`CLAUDE.md` (repo root) auto-loads three docs at the start of every AI
coding session — read those, not this file, for the actual reference:

- `docs/REFERENCE.md` — schema, API, roles, screens, non-negotiable rules
- `docs/ROADMAP_TO_COMPLETION.md` — what's left (defense, ISO 25010, UAT)
- `docs/HANDOFF.md` — current state, replaced fresh each session

Full detail and history live under `docs/`, opened deliberately (not
auto-loaded — see `CLAUDE.md` for when to open each):

- `docs/Baranguard_Master_Reference_FINAL .md` — section numbers and DDL.
  If it and `REFERENCE.md` disagree, `REFERENCE.md` wins for removed
  features (blotter, AI, fatigue flags) and this file wins elsewhere
- `backend/DEVLOG.md` — every decision and why (huge, append-only —
  grep for what you're touching, don't read front to back)

## Folder structure

```
/backend    PHP 8.2 (Node.js is CLI tooling only) — routes, controllers,
            models, middleware, services (sms/sync), config, migrations
/web        Vanilla JS + plain CSS — dispatcher/admin command center
/mobile     Ionic React 9 + Capacitor 8.5 — tanod operations app (Android)
/sms-gateway  Android app that sends SMS over its own SIM
/docs       Reference, setup, defense and evaluation docs, /evidence
            (screenshots/test logs). The decision log is backend/DEVLOG.md
```

The Electronic Blotter and the local-AI pipeline were removed in
migration 0029 (see `docs/REFERENCE.md` §1); Baranguard complements DILG
BIMSS and does not replace it.

## Documentation

Requirements and quality: [`docs/SRS.md`](docs/SRS.md),
[`docs/TRACEABILITY_MATRIX.md`](docs/TRACEABILITY_MATRIX.md),
[`docs/RISK_REGISTER.md`](docs/RISK_REGISTER.md),
[`docs/DEFECT_LOG.md`](docs/DEFECT_LOG.md) and
[`SECURITY.md`](SECURITY.md). User manuals are in `docs/manuals/`.
Data and privacy: [`docs/DATA_INVENTORY.md`](docs/DATA_INVENTORY.md),
[`docs/PRIVACY_IMPACT_ASSESSMENT.md`](docs/PRIVACY_IMPACT_ASSESSMENT.md).
Evaluation: [`docs/ISO25010_EVALUATION_PLAN.md`](docs/ISO25010_EVALUATION_PLAN.md),
[`docs/UAT_DATA_REQUIREMENTS.md`](docs/UAT_DATA_REQUIREMENTS.md),
[`docs/DEFENSE_DB_RUNBOOK.md`](docs/DEFENSE_DB_RUNBOOK.md).
Quick card for tanods: [`docs/manuals/TANOD_QUICK_CARD.md`](docs/manuals/TANOD_QUICK_CARD.md).
Defense material: [`docs/DEFENSE_QA.md`](docs/DEFENSE_QA.md) and
[`docs/MANUSCRIPT_AUDIT_2026-10-28.md`](docs/MANUSCRIPT_AUDIT_2026-10-28.md).
