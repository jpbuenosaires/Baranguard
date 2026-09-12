# Baranguard — Session Handoff

**This file is a replaced-in-place snapshot, not a log.** Rewrite the
sections below fresh each time something changes the picture — never
stack a new dated banner on an old one. Full session-by-session history
lives in `backend/DEVLOG.md` (grep it; don't read it front to back).

**Last updated: 2026-09-12.**

## Where things stand

**Sprints 0–7 are complete.** Sprint 8 (UAT/evaluation) is open but
**still gated** by `docs/REMAINING.md` §F — do not open a Sprint 8 box
while F1-F4 are unresolved. Nothing this session changed that gate.

**The A1-A7 logic-gap backlog is now swept, and only one item survives.**
Of the seven: A2/A3/A6 were already done (pure doc fixes applied to the
Master Reference on 2026-09-07 — verified still present, not taken on
trust); **G2 and G3 are now built** (migration 0016 — `sms_log.legal_hold`
so a legal hold on a case protects its SMS trail, and `mobile_device`
secrets scrubbed in place instead of the row being deleted, which used to
strip device provenance off 7-year records); **G4 is closed as obsolete**
(its walk-in-born-`resolved` path stopped existing when `POST /blotter`
was removed — all three creation sites now hardcode `pending`, so there
is nothing left to discriminate and adding the enum value would be a
Rule 6 violation); **G1 (SOS third fallback tier) is the one still open**,
blocked on a native SMS plugin + device *and* an unmade decision about
where the backup contact number lives. Full reasoning, including why
building G1's logic without its send path was rejected: `backend/DEVLOG.md`
2026-09-12 (2).

**Migration 0016 is applied to BOTH the real `baranguard` DB and the demo
`baranguard_uiseed` DB** (2026-09-12, as root; verified up/down/re-up and
idempotent on a disposable DB first). `verify-sprint7-retention.sh` is
**76/76**, up from 62.

**Six sessions' worth of finished, uncommitted work landed and pushed to
`origin/main` this session** (repo: `github.com/jpbuenosaires/Baranguard`).
`git status` at the start showed ~28 modified files across backend
controllers, the AI worker, and a dozen web files that were never staged
— all reviewed file-by-file, found coherent and complete, split into six
independent commits:

- `69c7bf3` Friend-runnable AI evaluation kit (`--resume`/checkpoint,
  `--batch-size`/`--rest-seconds` pacing, `--save-results`) + `eval-kit/`
  — this is `REMAINING.md` A3's actual deliverable, previously claimed
  done in this file without ever reaching git.
- `ae200aa` Threat Analyzer accepts a custom date range (7/30/90-day
  presets or custom, via the existing `DateRangePicker`).
- `58b5e17` Topbar AI-readiness badge for Secretary/PB (Ollama-probe
  backed, matches Admin's health badge honesty); dark-mode fixes for
  MapLibre's vendored chrome and the shared dropdown menu.
- `27d6cc9` AI Review workflow stepper; "Use in Broadcast" (SMS Composer)
  and "Copy for BIMSS" (Blotter Assistant) draft actions; GIS Live
  Tracking's floating widget made collapsible, its private `escapeHtml()`
  swapped for the shared `web/src/utils/escapeHtml.js`.
- `496e18f` `docs/AUDIT_2026-09-07.md` committed for the first time (the
  other docs had cited it by path since 2026-09-07 while it sat
  uncommitted); `CLAUDE.md`/`SPRINTS.md` brought to the state those
  citations already assumed.
- `dab2032` This session's own feature — see below.

Full narrative and the two bugs found doing this: `backend/DEVLOG.md`'s
2026-09-12 entry.

**AI Classifier now auto-checks itself instead of waiting for a click.**
The four local-AI drafting aids from 2026-09-10 (`components/AiToolPanel.js`,
embedded in host screens, not a standalone AI screen — Classifier in
Incident Management, Blotter Assistant in incident detail (Secretary
only), Message Composer in SMS Monitor, Threat Analyzer in Analytics)
are unchanged in that respect. What's new: the Classifier auto-runs once
per incident per visit as soon as an approved redaction exists (`AiToolPanel`
gained generic `tool.autoRun` + `options.onResult` hooks other panels can
reuse), and shows a small "AI suggests: {type} · {priority}" chip only
when its suggestion disagrees with what's already on record — a match
stays silent. Clicking the chip expands the panel; "Apply in Edit" is
unchanged. Reasoning for *why* this beats a manual button: the intake
pick is a rough guess from a raw call before the full story is known,
and the auto-check is the only way Admin gets a second look without ever
touching `raw_narrative`.

**If you touch a screen that hosts a panel:** call the panel's `stop()`
before wiping its DOM and chain it into the page's stop — `innerHTML=''`
does not clear a poll interval. (Fixed for all four host screens
2026-09-10; still true.)

**A real layout bug was found and fixed:** `.incident-layout.has-detail`
in `incident-management.css` squeezed the detail pane to ~78px at any
viewport under 1024px — its own two-class `grid-template-columns` rule
out-specifies the mobile single-column override sitting in the same
file's own media query, and hiding the left panel via `display:none`
compounded it by dropping it from the grid so the visible right panel
landed in the *wrong*, squeezed track. This is the default width of this
project's own browser-pane tooling, so it wasn't an edge case — it hit
every session that opened an incident detail this way. Fixed by adding
`.incident-layout.has-detail` to the mobile media query.

**A second, unrelated gap was found and fixed:** the disposable
`baranguard_uiseed` demo DB never had migration 0015 applied, so
`ai_processing_log` was missing the columns/enum values the four AI
Tools need — any of them 500'd the moment Generate was actually clicked
against seeded data, not just the new auto-check. Applied 0015 to
`baranguard_uiseed` directly (idempotent, disposable-DB-only; the real
`baranguard` DB already had it per the 2026-09-10 entry).

**Two P0s are still open** (`docs/AUDIT_2026-09-07.md`):
1. **F1, still unresolved.** `web/index.html` no longer points at the
   public Cloudflare tunnel (that uncommitted value is gone), but nothing
   has replaced it with a real decision either — the working tree
   currently carries a temporary `http://localhost:8081/api/v1` pointer
   used only to browser-verify this session's work, and it is
   deliberately **uncommitted**. The underlying question — what should
   `BARANGUARD_API_BASE_URL` actually be in a real deployment — is still
   open and still gates Sprint 8.
2. An unauthenticated citizen report can still execute script in the
   Secretary session via unescaped `innerHTML` in `blotter-detail.js`
   (unchanged; not touched this session).

Of the four P1s, F7 and F9's first bullet are closed by removal (see the
2026-09-10 entry); evidence upload (F4), `PATCH /incidents/:id`
idempotency (F5) and `avg_response_time_minutes` (F8) remain.

**`eval-kit/` still needs capable hardware.** Unchanged: Ollama is
installed here and the model is pulled, but a real `generate()` has
never completed on this workstation (300s timeout, zero bytes). The
eval-kit's `--resume`/checkpoint support (this session, see above) is
specifically what makes handing it to someone with capable hardware
practical — a multi-hour run surviving interruption instead of needing
to finish in one sitting.

## Three things most likely to bite you

1. **Every static check in this project can be green on code with a P0
   defect.** `node --input-type=module --check`, `verify-web-wiring.mjs`,
   `php -l` all parse-and-resolve; none can see an unescaped
   `${narrative}` inside `innerHTML`, or an API base URL pointing
   somewhere it shouldn't. Green means "it parses," not "it's safe to
   ship." Nor do they validate a `navigate()` key or a CSS specificity
   fight between two rules that both technically apply — a browser pass
   is what caught both real bugs this session.
2. **Finished work sitting uncommitted is a standing risk, not a
   curiosity.** Six sessions' worth of it accumulated silently while
   `HANDOFF.md` kept claiming a different, older commit was current.
   Commit and push before a session ends.
3. **A verification suite pinned to a partial migration chain expires
   silently** — this bit the demo `baranguard_uiseed` DB the same way it
   bit four verify suites in an earlier session (2026-09-05 → -10 entry).
   A disposable/demo database needs the *full* current migration chain,
   not whatever subset it was seeded with originally.
4. **`backend/.env` is currently pointed at `baranguard_uiseed`, not
   `baranguard`** — left that way from this session's browser
   verification, and it is NOT tracked by git so nothing will remind
   you. It already caused one confusing failure: a freshly-migrated
   database reporting `Unknown column` because the CLI job was quietly
   running somewhere else. `DB_NAME=baranguard php backend/scripts/...`
   overrides it for one command (an already-set env var beats `.env`,
   per `REFERENCE.md` §8); change the file itself before trusting any
   CLI run against "the real database."

## Recommended next step

1. **`REMAINING.md` §F1-F4 first** — settle the real `BARANGUARD_API_BASE_URL`
   value (F1 is a decision now, not a leftover tunnel to rip out), the
   XSS sweep (F2/F3), and the evidence-upload scope call (F4). Nothing
   else can be trusted as "verified against production" until F1 is
   settled.
2. **Hand `eval-kit/` to a friend with capable hardware** (or wait for
   her run) — the new checkpoint/resume support means an interrupted run
   is no longer a lost run.
3. **Browser-verify the screens nobody has opened yet**: Dispatch
   Center, GIS Live Tracking, Analytics > Heatmap, the Dashboard
   tooltips/attention banner, Citizen Reports' Convert-to-Incident
   dialog. See `REMAINING.md` B1 for the full list.
4. **Decide the untracked design-doc artifacts** at the repo root
   (`Baranguard_System_Design_Document.docx/.pdf`, four `diagram_*.png`,
   `scratch_diagrams.py`, `docs/progress-tracker.html`) — commit under
   `docs/`, or gitignore them. Still undecided; still sitting untracked.
5. Then **Sprint 8** proper — pick exactly one box from `SPRINTS.md`.

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
