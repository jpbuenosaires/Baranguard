# Baranguard

Barangay Intelligence and Emergency Dispatch System — offline-first,
locally hosted incident reporting and emergency dispatch platform for four
barangays (Dao, Binanuahan, Marifosque, Banuyo) in Pilar, Sorsogon,
Philippines. IT capstone project, Bicol University.

## Getting started

New machine, backend + web dashboard only: **[`docs/SETUP.md`](docs/SETUP.md)**
— clone, bootstrap the database, run the API and dashboard. Every step in
it has actually been run against a disposable database, not just
described. Mobile (Ionic/Capacitor/Android) isn't covered there yet; see
`docs/HANDOFF.md`'s operational reference for the build commands.

## Start here (for working on the codebase)

`CLAUDE.md` (repo root) auto-loads three docs at the start of every AI
coding session — read those, not this file, for the actual reference:

- `docs/REFERENCE.md` — schema, API, roles, screens, non-negotiable rules
- `docs/ROADMAP_TO_COMPLETION.md` — what's left (defense, ISO 25010, UAT)
- `docs/HANDOFF.md` — current state, replaced fresh each session

Full detail and history live under `docs/`, opened deliberately (not
auto-loaded — see `CLAUDE.md` for when to open each):

- `docs/Baranguard_Master_Reference_FINAL .md` — the authority; if it and
  `REFERENCE.md` disagree, this file wins
- `backend/DEVLOG.md` — every decision and why (huge, append-only —
  grep for what you're touching, don't read front to back)

## Folder structure

```
/backend    PHP 8.2 (Node.js is CLI tooling only) — routes, controllers,
            models, middleware, services (sms/sync), config, migrations
/web        Vanilla JS + plain CSS — dispatcher/admin command center
/mobile     Ionic React 9 + Capacitor 8.5 — tanod operations app (Android)
/sms-gateway  Android app that sends SMS over its own SIM
/docs       All planning docs, DEVLOG.md, /evidence (screenshots/test logs)
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
Defense material: [`docs/DEFENSE_QA.md`](docs/DEFENSE_QA.md) and
[`docs/MANUSCRIPT_AUDIT_2026-10-28.md`](docs/MANUSCRIPT_AUDIT_2026-10-28.md).
