# Baranguard — Naming & Folder Conventions

Lock these in before Sprint 0. The #1 cause of vibe-coding drift across
sessions is inconsistent naming — fix it once here, paste into every session.

---

## Naming Conventions

| Layer | Convention | Example |
|---|---|---|
| Database tables/fields | snake_case | `incident_id`, `raw_narrative` |
| API JSON request/response keys | snake_case (matches DB directly — no translation layer, fewer bugs) | `{ "incident_id": 1, "raw_narrative": "..." }` |
| PHP variables/functions | snake_case (idiomatic PHP) | `$incident_id`, `function get_incident_by_id()` |
| JS/TS variables/functions (web & mobile) | camelCase (idiomatic JS) | `incidentId`, `getIncidentById()` |
| JS component/class names | PascalCase | `IncidentForm`, `DispatchMap` |
| JS file names | kebab-case for pages/routes, PascalCase for components | `incident-log.js`, `IncidentForm.jsx` |
| CSS classes (plain CSS, no framework) | kebab-case, BEM-style modifiers | `.dispatch-card`, `.dispatch-card__header`, `.dispatch-card--priority` |
| CSS custom properties (theming) | kebab-case, `--` prefix | `--color-primary`, `--spacing-md` |
| Git branches | `sprint-N/feature-short-name` | `sprint-3/gps-live-tracking` |
| Git commits | `[SprintN][USx] Short description` | `[Sprint2][US3] Add offline SQLite incident capture` |

**Boundary rule:** since API JSON uses snake_case (matching the DB) but JS
code is camelCase internally, define **one central API client function**
(e.g. `apiClient.js` on web, `apiService.ts` on mobile) that all network
calls go through. Convert snake_case → camelCase there, once, so the rest of
the JS codebase never touches snake_case keys directly. Never let this
conversion happen ad-hoc in multiple components — that's how inconsistency
creeps in across AI sessions.

---

## Folder Structure

```
/baranguard
├── /backend                  (PHP 8.2 + Node.js)
│   ├── /routes                (endpoint definitions, thin — call controllers)
│   ├── /controllers           (request handling, calls services/models)
│   ├── /models                (DB access layer, one file per table)
│   ├── /middleware             (auth, RBAC enforcement — see Role Matrix)
│   ├── /services
│   │   ├── /sms                (Semaphore integration: messages, priority, otp)
│   │   ├── /ai                 (Ollama/SEA-LION calls: redact, summarize, translate)
│   │   └── /sync                (offline batch reconciliation logic)
│   ├── /config                 (env, DB connection, constants)
│   └── /migrations             (SQL schema migration files, versioned)
│
├── /web                       (Vanilla JS + plain CSS, dispatcher/admin side)
│   ├── /public
│   └── /src
│       ├── /pages               (one folder per screen from Screen Inventory, e.g. /dispatch-center)
│       ├── /components          (shared UI: MapView, IncidentCard, StatusBadge)
│       ├── /styles              (plain CSS — no framework)
│       │   ├── base.css           (resets, custom properties, typography)
│       │   ├── layout.css         (grid/flex page shells)
│       │   ├── components.css     (buttons, cards, badges, forms)
│       │   └── /pages              (per-screen overrides, e.g. dispatch-center.css)
│       ├── /services            (apiClient.js — the snake_case→camelCase boundary)
│       └── /assets
│
├── /mobile                    (Ionic 8.8.5 + Capacitor 8.0)
│   ├── /src
│   │   ├── /pages               (one folder per mobile screen, e.g. /log-incident)
│   │   ├── /components
│   │   ├── /services             (apiService.ts, syncService.ts, smsListener.ts)
│   │   └── /db                   (SQLite schema + migrations, mirrors backend /migrations)
│   └── /android                  (native config: SMS listener permissions, alarm audio stream)
│
├── /ai
│   ├── /prompts                 (redaction/summarization/translation prompt templates, versioned)
│   └── /test-data                (200-record synthetic PII dataset, Sprint 6)
│
├── /docs
│   ├── PROJECT_CONTEXT.md        (master AI reference — paste into every session)
│   ├── Baranguard_Database_Schema.md
│   ├── Baranguard_API_Contract.md
│   ├── Baranguard_Feature_Backlog.md
│   ├── Baranguard_Screen_Inventory.md
│   ├── Baranguard_Role_Permission_Matrix.md
│   ├── DEVLOG.md                 (per-session build log)
│   └── /evidence                 (screenshots, test logs, per sprint)
│
└── .gitignore                   (never commit .env, API keys, or synthetic test data with real-looking PII)
```

---

## Rules to Enforce

1. **One table = one model file** on the backend — don't let AI combine
   multiple table access logic into a single "god file."
2. **Migrations, not manual schema edits.** Every schema change goes through
   a numbered migration file, never a direct `ALTER TABLE` typed into a
   terminal and forgotten. This is what makes Sprint 7 integration testing
   survivable.
3. **Prompt templates are versioned files, not inline strings.** Keep your
   SLM redaction/summarization prompts in `/ai/prompts` as their own files,
   not hardcoded inside service functions — you'll be iterating on these a
   lot in Sprint 6, and you want a clean diff history for your manuscript's
   discussion of prompt refinement (mentioned in your own Sprint Retrospective
   section 3.2.5).
4. **Synthetic test data never touches production folders.** Keep the
   200-record PII test set entirely inside `/ai/test-data`, never seeded into
   the actual cloud MySQL instance, to avoid any ambiguity about what's real
   vs. synthetic data during audits.
5. **No CSS framework — plain CSS only.** Define the color palette, spacing
   scale, and typography once as CSS custom properties in `base.css`
   (`:root { --color-primary: ...; --spacing-md: ...; }`), and reference those
   variables everywhere instead of hardcoding values per component. This is
   what replaces Tailwind's config as the single source of truth for design
   tokens. Component-specific styles go in `components.css`; page-specific
   overrides go in their own file under `/styles/pages`. Never inline styles
   in JS except for values computed at runtime (e.g. a marker's map position).
