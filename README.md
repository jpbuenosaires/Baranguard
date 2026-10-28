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

`CLAUDE.md` (repo root) auto-loads two docs at the start of every AI
coding session — read those, not this file, for the actual reference:

- `docs/REFERENCE.md` — schema, API, roles, screens, non-negotiable rules
- `docs/HANDOFF.md` — current state and what's left (defense, ISO 25010, UAT), replaced fresh each session

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

Opened deliberately: [`docs/WORKFLOWS_AND_RULES.md`](docs/WORKFLOWS_AND_RULES.md)
(workflows, rules, offline sync rules), [`docs/SRS.md`](docs/SRS.md),
[`docs/PRIVACY.md`](docs/PRIVACY.md),
[`docs/RISKS_AND_DEFECTS.md`](docs/RISKS_AND_DEFECTS.md),
[`docs/EVALUATION.md`](docs/EVALUATION.md),
[`docs/DEFENSE.md`](docs/DEFENSE.md), [`docs/SETUP.md`](docs/SETUP.md),
user manuals in `docs/manuals/`, and [`SECURITY.md`](SECURITY.md).
