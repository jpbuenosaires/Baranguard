# Baranguard

Purpose: project overview.
Status / Last updated: 2026-11-09. Thesis defense, ISO 25010 evaluation and UAT scope; not deployed.

Barangay Intelligence and Emergency Dispatch System — offline-first,
locally hosted incident reporting and emergency dispatch platform for four
barangays (Dao, Binanuahan, Marifosque, Banuyo) in Pilar, Sorsogon,
Philippines. IT capstone project, Bicol University.

The `docs/` folder (setup, reference, defense and evaluation docs) and
`backend/DEVLOG.md` were removed from this repo on 2026-11-09 and are kept
outside it; the manuscript is in Google Docs. Recover the old files with
`git log --diff-filter=D -- docs/ backend/DEVLOG.md`.

## Working on the codebase

- `CLAUDE.md` (repo root) — short context for AI coding sessions.
- `backend/routes/*.php` and `backend/migrations/` — the routes and schema.
- `SECURITY.md` — security policy.

## Folder structure

```
/backend    PHP 8.2 (Node.js is CLI tooling only) — routes, controllers,
            models, middleware, services (sms/sync), config, migrations
/web        Vanilla JS + plain CSS — dispatcher/admin command center
/mobile     Ionic React 9 + Capacitor 8.5 — tanod operations app (Android)
/sms-gateway  Android app that sends SMS over its own SIM
```

The Electronic Blotter and the local-AI pipeline were removed in
migration 0029; Baranguard keeps no case registry or blotter.
