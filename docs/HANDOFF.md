# Baranguard — Session Handoff

**Last updated: 2026-09-04.** Read this to pick the project up cold.
The full narrative history lives in `backend/DEVLOG.md` (5.9k lines —
`grep` it, don't read it). What's left is in `docs/REMAINING.md`.

---

## Where things stand

**Sprints 0–7 are complete and pushed** (`main`, latest `95c27ec`).
Working tree clean.

Sprint 7 closed on 2026-09-04 with the most thorough verification in the
project's history: **446 checks across seven suites against real XAMPP,
zero failures**, plus a 12/12 restore drill against the real database and
373/373 web wiring checks.

| Sprint | State |
|---|---|
| 0 Schema/bootstrap/backup | ✅ verified |
| 1 Web command center | ✅ verified |
| 2 Mobile core | ✅ code + browser; **device-unverified** |
| 3 GPS/sync | ⚠️ coded, **no dedicated verify script** |
| 4 Notifications/SMS/SOS | ✅ backend verified; mobile device-unverified |
| 5 AI queue/health | ⚠️ coded; **model never called** |
| 6 Redaction/blotter/Lupon | ✅ 112/112; dataset + model run outstanding |
| 7 Retention/audit/pen-test/backup/W17-W20-W9 | ✅ 446 checks |
| 8 UAT | not started |

---

## The three things most likely to bite you

1. **Migration 0007 must be applied before the app will work.**
   `DevicesController` writes `mobile_device.deactivated_at` and **500s
   without it**. Already applied to this workstation's real database; on
   any other machine apply migrations 0001–0007 in order.

2. **The model has never been called.** Every AI claim is verified
   against SQL-seeded rows and a deliberately dead Ollama port. Whether
   the redaction is any *good* is completely unmeasured — that needs the
   200-record dataset (`docs/AI_Evaluation_Dataset_Guide.md`) and a
   machine that can run SEA-LION. `backend/.env` also needs the
   `OLLAMA_*` keys added by hand on any new machine.

3. **A Tanod still cannot raise an SOS from the mobile app.** The
   backend has existed and been verified since Sprint 4 Phase 1, but M2's
   button was never wired to it and its copy still claims the endpoint
   doesn't exist. Rule 27 calls SOS a personal-safety channel — this is
   the most consequential functional gap left.

---

## Recommended next step

Two things can start immediately and in parallel:

- **The 200-record evaluation dataset** — needs people, not machines,
  and blocks the longest chain in the project.
- **Browser-verify the finished-but-unproven screens** — the round-2 UI
  phases (checklist at `.claude/plans/clever-wishing-hummingbird.md`)
  plus W17 and W20. Everything there is wired and wiring-checked but has
  never been opened in a browser.

Full ordered list with reasoning: **`docs/REMAINING.md`**.

---

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

---

## Environment notes

- Real working directory is `C:\xampp\htdocs\baranguard` — an NTFS
  junction onto this repo (same physical files, no sync step). Prefer
  that path in anything shown to the user.
- Web dashboard: `http://localhost/baranguard/web/` (Apache, port 80).
  API: separate vhost on port 8081 (DocumentRoot = `backend/public`).
- XAMPP MySQL isn't always running —
  `tasklist //FI "IMAGENAME eq mysqld.exe"`, start with
  `cmd //c "C:\xampp\mysql_start.bat"`.
- The rest (Apache `Authorization` header, `.env` precedence, empty
  `DB_PASSWORD`, `cygpath`, Windows short paths) is in
  `docs/REFERENCE.md` §8.

---

## Conventions

Commits: `[SprintN] Short description`, ending with the
`Co-Authored-By:` line the current session instructions specify.

Update this file at the end of any session that changes the picture it
describes — a stale HANDOFF is treated as a stale DEVLOG claim: verify
against the repo before trusting it.
