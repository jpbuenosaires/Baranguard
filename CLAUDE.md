# Baranguard — Project Context

Auto-loads every session. Read the three imports below before doing
anything — they carry the schema, API, roles, screens, sprint
discipline, and current status. This file is a map to what else exists,
not a summary of what they already say — confirm architectural decisions
with the user before writing code.

@docs/REFERENCE.md
@docs/SPRINTS.md
@docs/HANDOFF.md

Current P0 status is in `HANDOFF.md` (loaded above) — not restated here
to avoid saying the same thing twice in the same context. File:line
evidence: `docs/AUDIT_2026-09-07.md`; remediation list: `docs/REMAINING.md`
§F. Neither is auto-loaded.

## Not auto-loaded — open deliberately

- **`docs/REMAINING.md`** — full ordered list of what's left before
  Sprint 8, including hardware/account-blocked items. Open when picking
  Sprint 8 work or planning.
- **`docs/AUDIT_2026-09-07.md`** — the P0/P1 evidence above. Dated and
  self-expiring: once `REMAINING.md` §F closes, remove this bullet and
  the "Current P0 status" line above rather than leaving them citing a
  resolved audit as if still open.
- **`docs/Baranguard_Master_Reference_FINAL .md`** — the real source of
  truth; `REFERENCE.md` summarises it with section numbers. **If the two
  disagree, this file wins** and `REFERENCE.md` should be corrected. Its
  own closing "Document status" note says how current it is.
- **`docs/Baranguard_Sprint_Prompts.md`** — Sprints 0–7 verbatim, all
  complete; pure history.
- **`backend/DEVLOG.md`** (huge, append-only) — every decision and why.
  **Log new work here.** Never read front-to-back — `grep` for the
  feature you're touching.
- **`docs/AI_Evaluation_Dataset_Guide.md`** — superseded by
  `backend/scripts/generate-eval-dataset.php`; kept short, for the PII
  category/judgement-call definitions only.

`HANDOFF.md` is a **replaced-in-place snapshot, not a log** — rewrite its
current-state section fresh each update; don't stack a new banner on the
old one. Session history lives in DEVLOG, not here.

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
