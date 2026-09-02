# mobile — Baranguard Tanod app

Ionic React + Capacitor (Android) app, per §1 of the Master Reference.
Scaffolded 2026-09-02 (Sprint 2).

## Installed baseline

| Package | Version |
|---|---|
| `@ionic/react` / `@ionic/react-router` | 9.0.1 |
| `react` / `react-dom` | 19.0.0 |
| `@capacitor/core` / `cli` / `android` | 8.5.1 |
| `@capacitor-community/sqlite` | 8.1.1 |
| Vite | 8.2.2 |
| TypeScript | 5.9.3 |

> §1 originally pinned **Ionic 8.8.5**. The current Ionic starter generates
> Ionic 9, and adopting it was a deliberate, user-confirmed decision on
> 2026-09-02 — §1 has been updated to match. Don't "fix" this back to 8
> without re-opening that decision.

## Commands

```bash
npm install            # install dependencies
npm run dev            # Vite dev server (browser)
npm run build          # tsc + vite build
npm run verify.schema  # verify the local SQLite schema against §5
npm run lint
```

## Local database (§5 "Mobile Local")

Encrypted SQLite via `@capacitor-community/sqlite` (SQLCipher-backed on
Android; enabled by `androidIsEncryption: true` in `capacitor.config.ts`).

- `src/services/db/localSchema.ts` — the schema itself: migration
  statements, row types, `LOCAL_SCHEMA_VERSION`. **Imports nothing from
  Capacitor on purpose**, so the exact DDL that ships can be executed
  against a real SQLite engine and asserted against §5 without a device.
- `src/services/db/localDatabase.ts` — the platform edge: opens the
  encrypted DB and runs migrations via `PRAGMA user_version`. Requires a
  real Android device/emulator to exercise.
- `scripts/verify-local-schema.mjs` — runs the real migration statements
  through Node's built-in `node:sqlite` and asserts every table, column,
  type, nullability, default, and the `client_event_id` UNIQUE constraint
  against §5 (47 checks).

Tables created so far: `incident_local`, `mobile_device_local`,
`offline_map_package_local`. The other §5 local tables (`dispatch_local`,
`gps_track_local`, `duty_status_local`, `evidence_attachment_local`,
`offline_queue_local`) belong to later sprint boxes and are deliberately
not created yet.

Migrations are **append-only** and applied in place — never drop and
recreate the local store. Rule 2 makes this non-negotiable: a rebuild
would destroy field captures not yet reconciled with the server.

## Not done yet

- **The Android platform is not added** (`npx cap add android`). This
  machine has no Android SDK/Studio/adb, so it could not be built or
  verified — adding an unbuildable native project would be an unverifiable
  claim. Run `npx cap add android && npx cap sync` on a workstation with
  the Android SDK. (`mobile/android/` is already gitignored.)
- **SQLCipher encryption-at-rest is unverified.** It requires opening the
  DB file on a real device and confirming it isn't readable plaintext.
- **The DB passphrase source is an unresolved design decision** — see the
  `PassphraseProvider` comment in `localDatabase.ts`. It is deliberately
  *not* defaulted; a hardcoded key would make "encrypted at rest" hollow.
  Must be resolved before M1/M3 persist a real `raw_narrative`.
- No screens yet — the scaffold's blank starter page is still in place.
