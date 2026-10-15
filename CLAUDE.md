# Baranguard — Project Context

Auto-loads every session. Read the three imports below before doing
anything — they carry the schema, API, roles, screens, sprint
discipline, and current status. This file is a map to what else exists,
not a summary of what they already say — confirm architectural decisions
with the user before writing code.

@docs/REFERENCE.md
@docs/SPRINTS.md
@docs/HANDOFF.md

`docs/REMAINING.md` §F (the 2026-09-07 audit's remediation list) closed
in full on 2026-09-13, but F1 (API base URL, both mobile and web) was
reopened 2026-09-15 — see `REFERENCE.md` §1. `docs/AUDIT_2026-09-07.md`'s
other findings are still historical only; current status lives in
`HANDOFF.md` (loaded above), not restated here to avoid saying the same
thing twice in the same context.

## Not auto-loaded — open deliberately

- **`docs/REMAINING.md`** — full ordered list of what's left before
  Sprint 8, including hardware/account-blocked items. Open when picking
  Sprint 8 work or planning.
- **`docs/Baranguard_Master_Reference_FINAL .md`** — the real source of
  truth; `REFERENCE.md` summarises it with section numbers. **If the two
  disagree, this file wins** and `REFERENCE.md` should be corrected —
  **except** where it describes the Electronic Blotter, the Lupon packet,
  the AI/Ollama pipeline or Fatigue Flags: it predates migrations 0029
  (2026-10-01) and 0042 (2026-10-13), which removed those, so
  `REFERENCE.md` wins there. Its own
  closing "Document status" note says how current it is.
- **`docs/Baranguard_Sprint_Prompts.md`** — Sprints 0–7 verbatim, all
  complete; pure history.
- **`backend/DEVLOG.md`** (huge, append-only) — every decision and why.
  **Log new work here.** Never read front-to-back — `grep` for the
  feature you're touching.
- **`docs/AI_Evaluation_Dataset_Guide.md`** — historical only: the AI
  pipeline and its eval scripts (incl. `generate-eval-dataset.php`) were
  deleted by migration 0029. Kept for the PII category definitions.

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
