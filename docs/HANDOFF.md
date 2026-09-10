# Baranguard — Session Handoff

**This file is a replaced-in-place snapshot, not a log.** Rewrite the
sections below fresh each time something changes the picture — never
stack a new dated banner on an old one. Full session-by-session history
lives in `backend/DEVLOG.md` (grep it; don't read it front to back).

**Last updated: 2026-09-10.**

## Where things stand

**Sprints 0–7 are complete.** Sprint 8 (UAT/evaluation) is open but
**still gated** by `docs/REMAINING.md` §F — do not open a Sprint 8 box
while F1-F4 are unresolved.

**The DILG BIMSS question is settled, and it changed the product.**
BIMSS/BIMS is mandated for all barangays by DILG Memorandum Circular, and
one of its 11 subsystems (**KPIS**) already *is* the Katarungang
Pambarangay case database; BIMS ships its own electronic blotter too.
Baranguard **complements BIMSS and may never be positioned as replacing
it** — the user's legal constraint, not a preference. Consequences
shipped 2026-09-10:

- **`POST /blotter` (walk-in entry) removed.** A walk-in with no prior
  incident is a native KPIS case.
- **W6 Electronic Blotter records list removed.** It was the screen that
  competed with KPIS. **W7 survives and is load-bearing** — it is the
  app's only per-incident detail view (still routed `blotter-detail`).
- **Punong Barangay lost list-of-cases access** as a result. Real
  reduction, recorded in `REFERENCE.md` §3/§7, not an accident.
- What stays is incident-originated: dispatch → AI redaction → finalize →
  Lupon packet. BIMSS has no dispatch layer to feed that.

**Four local-AI drafting aids shipped (migration 0015) — and they live
inside their host screens, not on an AI screen.** A standalone "AI Tools"
screen was built and dissolved the same day on the user's call (an
operator is mid-task and wants help with *that* task). Each is a
`components/AiToolPanel.js`: **Classifier** in Incident Management's
detail pane ("Apply in Edit" prefills the Edit form, which also gained
the Incident Type select the API always accepted); **Blotter Assistant**
in incident detail, Secretary-only, drafting the BIMSS/KPIS handoff
text; **Message Composer** at the top of SMS Monitor's feed pane ("Use
this draft" fills the compose box; no send button); **Threat Analyzer**
as Analytics' third tab with a non-forecast label. None writes a record.
The AI pipeline's *stated purpose* is repositioned to match: PII firewall
plus drafting aid. Its mechanics are unchanged.

**If you touch a screen that hosts a panel:** call the panel's `stop()`
before wiping its DOM and chain it into the page's stop — `innerHTML=''`
does not clear a poll interval. Three pages (Incident Management,
incident detail, Analytics) returned no stop handle at all until today.

**Two P0s are still open** (`docs/AUDIT_2026-09-07.md`):
1. The API is reachable over a public Cloudflare tunnel on a system §1
   defines as LAN-only, and `web/index.html` still points there.
2. An unauthenticated citizen report can execute script in the Secretary
   session via unescaped `innerHTML` in `blotter-detail.js`.

Of the four P1s, **F7 and F9's first bullet are now closed by removal**;
evidence upload (F4), `PATCH /incidents/:id` idempotency (F5) and
`avg_response_time_minutes` (F8) remain.

**Two defects were found this session that were on no list:**
- **`IncidentsController::updateStatus()` did not exist** while
  `routes/incidents.php:19` routed to it and the client called it twice —
  a live 500, and why `case_status` was never set to `resolved`. Written,
  and its contract is now enforced by `verify-sprint6.sh`.
- **Every verify suite that logs in had been broken since 2026-09-05.**
  Migration 0011 added `user.is_suspended`; `AuthController::login()`
  selects it; the four suites each applied only their own sprint's subset
  of migrations. All four exited at setup without reaching one assertion,
  while `REFERENCE.md` §9 listed them green. All now apply 0001-0015.

**Migration 0015 is NOT yet applied to the real `baranguard` DB.** It is
verified up, down and idempotent against a disposable MariaDB 10.4, but
every AI panel will 500 against the real database until someone applies
it as DBA (`baranguard_app` has no `ALTER`).

**`eval-kit/` still needs capable hardware.** Unchanged: Ollama is
installed here and the model is pulled, but a real `generate()` has never
completed on this workstation (300s timeout, zero bytes). What IS now
proven is the failure path — `verify-ai-tools.sh` points `OLLAMA_URL` at
a dead port and asserts jobs come back `queued`, never `failed`, which
`REMAINING.md` A2 called the single most important untested behaviour in
the pipeline.

## Three things most likely to bite you

1. **Every static check in this project can be green on code with a P0
   defect.** `node --input-type=module --check`, `verify-web-wiring.mjs`,
   `php -l` all parse-and-resolve; none can see an unescaped
   `${narrative}` inside `innerHTML`, or an API base URL pointing at the
   public internet. Green means "it parses," not "it's safe to ship."
   **Nor do they validate a `navigate()` key** — a mistyped page key is a
   silently dead nav item that only a browser pass finds.
2. **A verification suite pinned to a partial migration chain expires
   silently.** That is what hid four broken suites for five days, and it
   fails in the way that looks like infrastructure trouble rather than a
   stale script. All four now apply the full chain; keep it that way.
3. **A dead web screen with every check passing usually means an
   undeclared identifier**, not a CSS problem. The browser console names
   it instantly; nothing else in this stack will.

## Recommended next step

0. **Apply migration 0015 to the real `baranguard` DB** as DBA — every
   AI panel 500s against the real database until you do. It is verified
   up/down/idempotent; `baranguard_app` has no `ALTER`.
1. **`REMAINING.md` §F1-F4 first** — the API base URL, the XSS sweep,
   and the evidence-upload scope decision. Nothing else can be trusted
   as "verified against production" until F1 is settled. (F1 also blocks
   a real browser pass: this session had to point the app at a local API
   temporarily to verify anything, and restored the tunnel URL after.)
2. **Hand `eval-kit/` to a friend with capable hardware** (or wait for
   her run) — it can proceed in parallel with everything else here.
3. **Browser-verify the screens nobody has opened yet**: Dispatch
   Center, GIS Live Tracking, Analytics > Heatmap, the Dashboard
   tooltips/attention banner, Citizen Reports' Convert-to-Incident
   dialog. See `REMAINING.md` B1 for the full list. *(The authenticated
   sidebar/topbar, incident detail, AI review, SMS Monitor › Conversations,
   Analytics › Threat Analyzer and all four embedded AI panels were
   browser-verified 2026-09-10, as Admin and as Secretary — including a
   measured timer-leak check and probe-cache check across remounts.)*
4. **Two open one-line design calls**: `backdrop-filter` blur panels
   compositing over the live map canvas, and `marker-pulse` owning
   `transform` so marker hover no longer fires.
5. **Decide the untracked design-doc artifacts** at the repo root
   (`Baranguard_System_Design_Document.docx/.pdf`, four `diagram_*.png`,
   `scratch_diagrams.py`) — commit under `docs/`, or gitignore them.
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
```

Neither the retention job nor the restore drill is **scheduled** — both
are CLI-only by design; wiring them to Task Scheduler is an outstanding
runbook step.

## Conventions

Commits: `[SprintN] Short description`, ending with the
`Co-Authored-By:` line the current session instructions specify.

Rewrite this file — don't append to it — at the end of any session that
changes the picture it describes. A stale `HANDOFF.md` is treated like a
stale DEVLOG claim: verify against the repo before trusting it.
