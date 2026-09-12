# Baranguard — Session Handoff

**This file is a replaced-in-place snapshot, not a log.** Rewrite the
sections below fresh each time something changes the picture — never
stack a new dated banner on an old one. Full session-by-session history
lives in `backend/DEVLOG.md` (grep it; don't read it front to back).

**Last updated: 2026-09-12.**

## Where things stand

**Sprints 0–7 are complete.** Sprint 8 (UAT/evaluation) is open but
**still gated** by `docs/REMAINING.md` §F — do not open a Sprint 8 box
while F1 or F4 are unresolved (F2/F3/F5/F6 closed this session — see
below).

**§F's audit remediation: F2/F3/F5/F6/F8 fixed and proven this session.
F1 and F4 remain — both are decisions, not code.**

- **F2/F3 (the XSS sweep) — CLOSED.** All eleven `innerHTML`
  interpolation sites from `docs/AUDIT_2026-09-07.md` are now escaped via
  the existing shared `web/src/utils/escapeHtml.js`. One site
  (`blotter-list.js`) no longer exists — closed by W6's 2026-09-10
  removal, not by fix. `verify-web-wiring.mjs` 536/536, no regressions.
- **F5 (`PATCH /incidents/:id` idempotency) — CLOSED.** Was validated but
  never stored/replayed; now replays off `audit_log` (same shape
  `SmsController::broadcast()` already uses — there's no natural unique
  column an UPDATE can dedupe on the way a CREATE dedupes on
  `client_event_id`). Proven by a new script,
  `verify-f5-incident-update-idempotency.sh` (16/16) — this endpoint had
  never been called over HTTP by any existing suite, so nothing else
  exercised it.
- **F6 (`is_suspended` not checked on authenticated requests) — CLOSED.**
  `AuthMiddleware::authenticate()` now checks it exactly like `is_active`.
  Proven by a new script, `verify-f6-suspended-request-rejected.sh`
  (8/8), which suspends a user via direct SQL (session deliberately left
  un-revoked) to isolate this check from session-revocation covering for
  it.
- **F8 (`avg_response_time_minutes` double-counts multi-dispatch
  incidents) — CLOSED.** All three call sites (`summary()`'s scalar,
  `response_time_trend[]`, and the export path) now join against a
  per-incident `MIN(arrived_at)` subquery instead of the raw `dispatch`
  table. Proven two ways: an isolated SQL demonstration (old query gives
  17.5 on a 2-dispatch fixture, new gives the correct 10.0) and a new
  HTTP-level script, `verify-f8-response-time-dedup.sh` (8/8).
- **F1 still open** — the real `BARANGUARD_API_BASE_URL` for a genuine
  deployment has never been decided, only ever pointed at disposable
  preview/local values. This is a decision for the user, not something a
  coding session can settle on its own.
- **F4 still open** — evidence attachment upload is unbuilt end-to-end
  server-side (no route, no `INSERT`, no sync channel). Needs an explicit
  scope call: build it, or formally descope and correct §11's retention
  table, which currently governs a table nothing can ever populate.

**Not done this session, logged rather than silently skipped:** B2
(pen-test dispatch/shifts/citizen-reports/SMS/map-packages — Incidents'
own 68-check pass is the template) and B4 (`verify-sprint3.sh`, which
has never existed) are each their own substantial new-suite-writing
session and were left for one, rather than rushed. Three new verify
scripts this session (`verify-f5-*`, `verify-f6-*`, `verify-f8-*`) join
the existing eighteen — none of the counts in `REFERENCE.md` §9 changed,
since those three are new files, not adjustments to existing suites.

**Housekeeping (§E):** the stray `baranguard_device_check` DB no longer
exists (already dropped by an earlier session). The eight untracked
design-doc files that had been sitting at the repo root
(`Baranguard_System_Design_Document.docx`/`.pdf`, four `diagram_*.png`,
`scratch_diagrams.py`) are real deliverables, not scratch — moved into
`docs/design/` and committed. `mobile/android/`'s "commit or not"
decision is deliberately still open — see §E's own note in
`REMAINING.md` for why that one wasn't just acted on.

**⚠️ There is a SEPARATE body of uncommitted mobile UI work in this
working tree that this session did NOT touch, review, or commit** — 14
files under `mobile/src` (`App.tsx`, several pages, `apiService.ts`,
theme CSS, `vite.config.ts`) show as modified, and four new files exist
(`components/MobileHeader.tsx`, `components/SyncQueueModal.tsx`,
`pages/profile.tsx`, and a new `utils/` directory) that were not present
at the start of the previous session. `pages/profile.tsx` in particular
is notable: `REFERENCE.md` §7 and `App.tsx`'s own routing currently say
M10 Profile is **not built yet** (`NotBuiltYetPage`) — if this file
actually implements it, that is real, unlogged scope that predates this
handoff entry and needs the same file-by-file review the six-sessions'
land in the 2026-09-12 (1) DEVLOG entry got, before anyone trusts or
commits it. **Do not assume it is safe to commit as-is** — verify it
first, the same way that entry did. This session's own commits were
scoped narrowly to specific backend/web files by path for exactly this
reason: an unreviewed parallel change sitting in the same working tree
is not something to sweep in with a broad `git add`.

**The §G feature backlog is worked to completion** (unchanged this
session). All 14 candidates resolved: 7 built, 4 found already shipped,
3 deliberately not built with reasons. Detail: `backend/DEVLOG.md`
2026-09-12 (3), statuses in `REMAINING.md` §G.

**⚠️ Nine verify suites were dead, not green, until 2026-09-12** —
unchanged this session, still the most important piece of *prior*
context if you haven't read it yet. All nine now apply the full
0001-0018 chain and every §9 count was re-measured. Detail:
`backend/DEVLOG.md` 2026-09-12 and 2026-09-12 (3), `REFERENCE.md` §9's
warning box.

**The A1-A7 logic-gap backlog is swept; G1 (SOS third fallback tier) is
the one item still open**, blocked on a native SMS plugin + device and
an unmade decision about where the backup contact number lives.
Unchanged this session. Detail: `backend/DEVLOG.md` 2026-09-12 (2).

**Migrations 0016, 0017, 0018 are applied to both the real `baranguard`
DB and the demo `baranguard_uiseed` DB.** Unchanged this session.

**AI Classifier auto-checks itself; a real layout bug in
`incident-management.css` was found and fixed; a demo-DB migration gap
was found and fixed.** All unchanged this session — full detail in the
2026-09-12 (1) DEVLOG entry if you need it.

**`eval-kit/` still needs capable hardware.** Unchanged: no
`generate()` has ever completed on this workstation.

## Three things most likely to bite you

1. **Every static check in this project can be green on code with a P0
   defect.** `node --input-type=module --check`, `verify-web-wiring.mjs`,
   `php -l` all parse-and-resolve; none of them caught the eleven XSS
   sites this session fixed, or would have caught F5/F6/F8 either — all
   three needed a real HTTP call against a real database to prove, which
   is why each got its own new verify script rather than a claim.
2. **A verify script proves nothing about an endpoint it never calls.**
   F5 and F6 were both provably broken for a long time specifically
   *because* no existing suite exercised the code path — `grep` for the
   route across every `*.sh` before trusting a suite's green result to
   mean "this endpoint works," not just "the suites that happen to touch
   it pass."
3. **Finished work sitting uncommitted is a standing risk, not a
   curiosity** — see the mobile UI work flagged above. Review it
   file-by-file before committing it, the same way the six-sessions'
   backlog was reviewed on 2026-09-12, rather than either ignoring it
   indefinitely or sweeping it in blind.
4. **`backend/.env` may still be pointed at `baranguard_uiseed`, not
   `baranguard`**, from earlier browser-verification sessions, and it is
   NOT tracked by git so nothing will remind you. `DB_NAME=baranguard
   php backend/scripts/...` overrides it for one command; check the file
   itself before trusting any CLI run against "the real database."

## Recommended next step

**F1 is now the most valuable open item.** Every other §F code defect is
closed; F1 is purely a decision (the real `BARANGUARD_API_BASE_URL`) and
F4 purely a scope call (build evidence upload, or descope it and correct
§11). Neither needs more investigation — both need the user to decide.

1. **Settle F1** (the real deployment API base URL) and **F4** (build
   evidence upload, or formally descope it). Nothing can be called
   "verified against production" until F1 is settled.
2. **Review and decide on the parallel mobile UI work** flagged above
   (`MobileHeader.tsx`, `SyncQueueModal.tsx`, `pages/profile.tsx`,
   `utils/`, and the modified files around them) before it becomes a
   sixth "six sessions of uncommitted work" story.
3. **B1** — browser-verify the screens nobody has opened yet (Dispatch
   Center, GIS Live Tracking, Analytics > Heatmap, the Dashboard
   tooltips/attention banner, Citizen Reports' Convert-to-Incident
   dialog). See `REMAINING.md` B1.
4. **B2, B4** — pen-test the non-incident resource types, and write the
   Sprint-3-endpoint verify script that has never existed.
5. **Hand `eval-kit/` to a friend with capable hardware** for A2.
6. Then **Sprint 8** proper — pick exactly one box from `SPRINTS.md`.

Full ordered list with reasoning, including the hardware/account-blocked
items: **`docs/REMAINING.md`**.

## Operational quick reference

```bash
# Retention (dry-run FIRST on real data — deletion is irreversible by design)
php backend/scripts/retention-job.php --dry-run
php backend/scripts/retention-job.php --list

# Restore drill (records the drill; W20 shows "Never" until you run it)
BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh

# AI worker
cd backend && php scripts/ai-worker.php --status

# Web wiring check — run after ANY web change
node web/scripts/verify-web-wiring.mjs

# This session's new verify scripts
bash backend/scripts/verify-f5-incident-update-idempotency.sh
bash backend/scripts/verify-f6-suspended-request-rejected.sh
bash backend/scripts/verify-f8-response-time-dedup.sh
```

Neither the retention job nor the restore drill is **scheduled** — both
are CLI-only by design; wiring them to Task Scheduler is an outstanding
runbook step.

## Conventions

Commits: `[Tag] Short description`, ending with the `Co-Authored-By:`
line the current session instructions specify. Repo has a real remote
(`origin` → `github.com/jpbuenosaires/Baranguard`) — push before ending
a session that adds real work, not just when asked.

Rewrite this file — don't append to it — at the end of any session that
changes the picture it describes. A stale `HANDOFF.md` is treated like a
stale DEVLOG claim: verify against the repo before trusting it.
