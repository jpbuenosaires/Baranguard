# Baranguard — Project Context

Purpose: map of the project docs, auto-loaded each session.
Status / Last updated: 2026-10-28.

Auto-loads every session. Read the two imports below before doing
anything — they carry the schema, API, roles, screens, and current status
plus what is left (scoped to the defense, ISO/IEC 25010 evaluation and
UAT; the system is not being deployed at a barangay). This file is a map
to what else exists, not a summary of what they already say — confirm
architectural decisions with the user before writing code.

@docs/REFERENCE.md
@docs/HANDOFF.md

**Docs were pruned 2026-10-28** to what the defense, evaluation and UAT
need. Removed (recoverable with `git log --diff-filter=D -- docs/`):
`SPRINTS.md`, `REMAINING.md`, `TODO_TO_FINISH.md`, the sprint prompts,
the 2026-09 and 2026-10 audit reports, the October feature plan and
contract, the AI dataset guide, the deployment-only docs (power cut,
deployment checklist, turnover, breach runbook, DPO template, operations
manual) and old instrument versions. References to them in older docs and
code comments are historical.

## Not auto-loaded — open deliberately

- **`docs/Baranguard_Master_Reference_FINAL .md`** — section numbers and
  DDL; `REFERENCE.md` summarises it. **Where they differ, `REFERENCE.md`
  wins for removed features (Electronic Blotter, Lupon packet, AI/Ollama
  pipeline, Fatigue Flags: migrations 0029 and 0042) and the Master
  Reference wins elsewhere**; correct whichever is wrong. Its closing
  "Document status" note says how current it is.
- **`backend/DEVLOG.md`** (huge, append-only) — every decision and why.
  **Log new work here.** Never read front-to-back — `grep` for the
  feature you're touching.
- **`docs/WORKFLOWS_AND_RULES.md`** — workflows, state machines, numbered
  business rules, and Part 9, the offline sync and conflict rules.
- **`docs/SRS.md`**, **`docs/PRIVACY.md`**, **`docs/RISKS_AND_DEFECTS.md`**,
  **`docs/EVALUATION.md`**, **`docs/DEFENSE.md`**, **`docs/SETUP.md`**,
  **`docs/manuals/`** — requirements, privacy, risks and defects,
  ISO 25010/UAT evaluation, defense material, setup, user manuals.

`HANDOFF.md` is a **replaced-in-place snapshot, not a log** — rewrite its
current-state section fresh each update; don't stack a new banner on the
old one. Session history lives in DEVLOG, not here.

## Skills and token-saving defaults

Use ONE skill per task; don't load several that overlap. Never skip the
rules above to follow a skill.

- **Before building:** a feature or change touching more than one file →
  `/plan`, then `/build` (add `auto` only if the user says so). Bugs →
  `/test` (reproduce first). Before finishing → `/review`; for bloat
  checks `/ponytail-review`. Keep changes minimal (ponytail).
- **Mobile/web UI work:** use `impeccable` (read `.impeccable.md` if it
  exists; run `/teach-impeccable` once if not). `design-taste-frontend` is
  for public marketing pages only — not the dashboard or the mobile app.
- **Finding code:** read `C:\Users\Jayson Buenosaires\Documents\graphify-mobile-app\GRAPH_REPORT.md`
  before exploring `mobile/src`. If stale (commit differs from `git rev-parse HEAD`),
  refresh with `graphify update mobile/src` and move the new `graphify-out/`
  out of the repo. Otherwise `grep` before opening files.
- **Notes/memory:** the user's Obsidian vault is `C:\Users\Jayson Buenosaires\Documents\SecondBrain`;
  read its `Index.md` first, never the whole vault. Project decisions still
  go in `backend/DEVLOG.md`.

## Working directory

`C:\xampp\htdocs\baranguard` is an NTFS junction onto this repo (same
files, two paths, no sync step) — prefer that path in anything shown to
the user; a session's shell `cwd` may open at `Videos\Baranguard` instead,
which is fine, both resolve identically. `http://localhost/baranguard/web/`
(Apache :80) serves the web dashboard through the junction; `backend/` is
a separate vhost on :8081 (DocumentRoot `backend/public`). `mobile/` does
**not** run as a static-served app — it needs `npm run dev` or a device
build. A repo-root `.htaccess` blocks `.git`/`.claude`/dotfiles from ever
being served — don't remove it.
