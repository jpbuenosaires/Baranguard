# Baranguard

Barangay Intelligence and Emergency Dispatch System — offline-first,
cloud-assisted incident reporting and emergency dispatch platform for four
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
- `docs/SPRINTS.md` — sprint discipline, what's left
- `docs/HANDOFF.md` — current state, replaced fresh each session

Full detail and history live under `docs/`, opened deliberately (not
auto-loaded — see `CLAUDE.md` for when to open each):

- `docs/Baranguard_Master_Reference_FINAL .md` — the authority; if it and
  `REFERENCE.md` disagree, this file wins
- `docs/REMAINING.md` — full ordered backlog before Sprint 8
- `docs/Baranguard_Sprint_Prompts.md` — Sprints 0–7 verbatim, pure history
- `backend/DEVLOG.md` — every decision and why (huge, append-only —
  grep for what you're touching, don't read front to back)

## Folder structure

```
/backend    PHP 8.2 + Node.js — routes, controllers, models, middleware,
            services (sms/ai/sync), config, migrations
/web        Vanilla JS + plain CSS — dispatcher/admin command center
/mobile     Ionic 8.8.5 + Capacitor 8.0 — tanod operations app (Android)
/ai         Prompt templates + synthetic PII test data (Sprint 6)
/docs       All planning docs, DEVLOG.md, /evidence (screenshots/test logs)
```

See `Baranguard_Naming_Conventions.md` for the full annotated tree and
naming rules (snake_case DB/API, camelCase JS, the apiClient/apiService
boundary rule, etc.).
