# Baranguard

Barangay Intelligence and Emergency Dispatch System — offline-first,
cloud-assisted incident reporting and emergency dispatch platform for four
barangays (Dao, Binanuahan, Marifosque, Banuyo) in Pilar, Sorsogon,
Philippines. IT capstone project, Bicol University.

## Start here

Read `/docs/PROJECT_CONTEXT.md` first — it's the condensed reference to
paste/link at the start of every AI coding session. Full detail lives in the
companion docs also under `/docs`:

- `Baranguard_Database_Schema.md`
- `Baranguard_API_Contract.md`
- `Baranguard_Feature_Backlog.md`
- `Baranguard_Screen_Inventory.md`
- `Baranguard_Role_Permission_Matrix.md`
- `Baranguard_Naming_Conventions.md`
- `Baranguard_Phase2_VibeCoding_Guide.md`
- `DEVLOG.md` — session-by-session build log, update every session

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
