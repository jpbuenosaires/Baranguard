# Baranguard — Everything left before Sprint 8

Sprints 0–7 are complete. This is the honest list of what still stands
between here and a UAT sign-off, ordered by what blocks what.

**Legend:** 🔴 blocks Sprint 8 · 🟠 needed for a credible UAT ·
🟢 polish / nice-to-have

---

## A. Blocked on hardware or accounts you have to provide

Nothing in this group can be finished by a coding session alone. These
are the long poles — start them first, because everything downstream
waits on them.

### 🔴 A1. Android device/emulator run (blocks ALL mobile verification)
**Blocked on:** JDK 21 (Temurin) + an API 36 emulator, both part-installed.
Environment bugs are already solved and documented (`C:\gtmp` for
`java.io.tmpdir`, short paths for the space in the username, `sdk.dir`
format) — see DEVLOG's "Android SDK / native build environment" entry.

Once it runs, this clears **six** outstanding verifications at once:
- SQLCipher actually encrypts the DB file (pull it off the device and
  confirm it isn't readable plaintext SQLite)
- Offline capture survives app kill
- Photo/voice capture produces a real playable file
- Keystore passphrase round-trip + the legacy-migration path
- M5/M6/M7 (Sprint 3) and M12/M13 (Sprint 4) on a real screen
- `runSyncPass()` draining a queue after a forced offline→online cycle

**Also outstanding here:** nothing calls `runSyncPass()` yet — no timer,
no app-foreground hook. Wiring a trigger is a small code task that only
makes sense to verify on a device.

### 🔴 A2. Run the AI model end-to-end (blocks the AI evaluation box)
**Blocked on:** a machine that can run SEA-LION at usable speed.
**The model has still never been called.** Everything AI-related is
verified against SQL-seeded rows and a dead Ollama port.

Must confirm on the capable machine:
- No `<think>` block survives into `draft_redacted_narrative`
  (`stripReasoning()` is reasoned-from-docs, never observed)
- Planted PII is actually removed
- **Kill Ollama mid-job → the row returns to `queued`, not `failed`**
  (the single most important untested behaviour in the pipeline)
- `model_version` records what really ran

Remember: `backend/.env` needs the `OLLAMA_*` keys added by hand on any
new machine (they're only in `.env.example`).

### 🔴 A3. The 200-record evaluation dataset
**Blocked on:** ~3 people doing manual labelling —
`docs/AI_Evaluation_Dataset_Guide.md` has the method. **Startable right
now, no model needed.** Until it exists, Sprint 6's headline claim
(recall ≥95% / precision ≥90%) is unmeasured.

Baseline already established: the regex comparator scores **39.13%
recall / 100% precision** on a 10-record smoke fixture, with every miss a
NAME or ADDRESS — the concrete argument for the model over a pattern list.

### 🟠 A4. Real FCM + Semaphore credentials
A Firebase project (`google-services.json` + `FCM_SERVICE_ACCOUNT_PATH`)
and a funded Semaphore account. Rule 12's fallback ladder is fully
verified *logically*, but **no Tanod's phone has ever actually buzzed.**

### 🟢 A5. GSM modem hardware
Only needed if you want the tethered-phone inbound path. The contract is
already proven — `scripts/sms-envelope-build.php` produces exactly what
the ingestion daemon would.

---

## B. Verification a coding session can do now

### 🔴 B1. Browser-verify the unverified screens
Two batches, both wired and wiring-checked but **never opened in a
browser**:
- **Round-2 UI (9 phases):** Dispatch queue fix, Blotter Entry two-column
  + timeline rail, avatar/bell topbar, KPI convention, Incident
  Management, rebuilt Electronic Blotter, Settings rail, SMS log
  filters/stats, Analytics charts. Checklist ready at
  `.claude/plans/clever-wishing-hummingbird.md`.
- **Sprint 7:** W17 Audit Log Viewer, W20 Service Health.

This is the largest pile of unverified-but-finished work in the project.

### 🟠 B2. Pen-test the other resource types
Incidents passed 68/68. Dispatch, shifts, citizen reports, SMS logs and
map packages have had **no equivalent pass**. Reuse
`verify-sprint7-pentest-incidents.sh`'s four-dimension structure (no
token / wrong role / cross-tenant / wrong owner) — it's designed to be
copied.

### 🟠 B3. Run the restore drill with your own passphrase
The drill is proven (12/12 against the real database) but this session
used a scratch backup dir deliberately, so **W20 still shows "Never"**:
```
BACKUP_ENCRYPTION_PASSPHRASE=your-passphrase bash backend/scripts/restore-drill.sh
```

### 🟠 B4. Verify Sprint 3's backend against real XAMPP
`POST /gps`, `PATCH /dispatch/:id/status`, `POST /sync/batch`,
`GET /incidents/nearby`, and the mobile `POST /incidents` branch were
coded in one sitting and **never got their own verify script**. They're
exercised incidentally by later suites, but there is no
`verify-sprint3.sh`. Interrupted-sync resume and duplicate-GPS handling
are specifically unproven.

### 🟢 B5. Roles other than Admin in a browser
Almost all browser verification has been done as Admin (plus one
Secretary pass on W7/W8). Punong Barangay and Secretary have never been
walked through the full nav.

---

## C. Real gaps in shipped behaviour

### ✅ C1. Backup file expiry (§11 / Rule 11) — DONE
`backup.sh` now computes the earliest `created_at`/`uploaded_at` among
rows currently under `legal_hold` (incident/citizen_report/
evidence_attachment) and refuses to prune any backup file timestamped
on/after that floor, regardless of age — and fails closed (prunes
nothing) if the hold check itself can't run. Verified against a
disposable DB + scratch backup dir; see `backend/DEVLOG.md`'s "backup
legal-hold expiry" entry.

### 🟠 C2. Nothing is scheduled
`retention-job.php` and `restore-drill.sh` are both CLI-only by design.
Neither runs on its own. Wiring them to Windows Task Scheduler (daily /
weekly) is a runbook step, and until it happens retention never actually
fires in production. **Deliberately still not done**: creating a
Windows Scheduled Task is a system-settings change outside what a
coding session can execute on the user's behalf — this needs a human at
the keyboard running the final `schtasks` command.

### ✅ C3. Mobile SOS button — DONE (code-complete, device-unverified)
`POST /tanod-sos` is now wired end-to-end: online-first via
`apiService.postSos()`, falling back to `offlineQueueRepository`'s new
`enqueueSosItem`/`listPendingSosItems` (draining through
`syncService.runSyncPass()` → `/sync/batch`'s `sos[]`, live since
Sprint 4 but previously always sent empty) when offline. `home.tsx`'s
button is a real `color="danger"` action behind an `IonAlert` confirm.
`npx tsc --noEmit` compiles clean; **not device-verified** — same A1
blocker as everything else mobile. Also still true: nothing calls
`runSyncPass()` automatically yet (see A1), so a queued-offline SOS
drains on whatever next sync trigger exists.

### 🟢 C4. Smaller known gaps
- `LineChart` has no data-gap concept — a null response-time day renders
  as 0 on Analytics.
- Evidence files can't be downloaded from W7 (no authorized byte-serving
  endpoint; the screen says so honestly).
- On-device SMS sending was never built, so M13 can only ever show
  `saved_locally_for_retry`. **Deferred** — needs a native SMS plugin
  and device verification (A1).
- M12 is a JS overlay, not a native full-screen-intent activity.
  **Deferred** — needs a native Android activity and device
  verification (A1).
- M7 Live Map has no rendered basemap (status view only). **Deferred**
  — needs a real MapLibre/tile integration and device verification (A1).
- ✅ `npx cap sync android` run + the `POST_NOTIFICATIONS` manifest
  permission added — `@capacitor/geolocation` and
  `@capacitor/push-notifications` are now registered native plugins
  (6 → 8). `gradle.properties`' hand-fixed JDK paths confirmed intact.
- 13 pre-existing npm advisories in `mobile/` — never triaged.

---

## D. Unbuilt screens

| Screen | Status |
|---|---|
| **W10 User Management** | ✅ Built: Admin can create an account (`POST /users`, own barangay, admin sets the initial password, no forced-change flow), and deactivate/reactivate a same-barangay user with session revocation and a "one active Admin must remain" guard. Role CHANGES to an existing account remain out of scope (a deliberate decision, not an oversight) — `PATCH /users/:id`'s self-edit path is unchanged. 19+17 ad hoc checks + browser-verified; see DEVLOG's two W10 entries. |
| **W18 Map Package Management** | ✅ Built. Both endpoints already existed; new web screen shows published version/checksum (or an honest empty state) and an upload form that surfaces the server's real validation errors verbatim. Browser-verified end-to-end (empty state, invalid-file rejection, real MBTiles upload) against a disposable backend. |
| **W21 System Settings** | Still **blocked by its own §9 note** — no schema, no endpoints, no sprint assignment. Needs an architecture review first (and gateway credentials must never live in a settings row). Explicitly skipped this session per the user's own decision, not attempted. |

---

## E. Housekeeping

- 🟢 A stray `baranguard_device_check` database exists locally — flagged,
  never investigated, safe to drop after a look.
- 🟢 Three empty untracked files in the repo root (`cls`, `git`, `main)`)
  from an old mis-paste. Don't let `git add -A` sweep them in.
- 🟢 `mobile/android/` is gitignored but now holds real, non-regeneratable
  fixes (`gradle.properties`, manifest permissions). `npx cap sync` is
  safe; `npx cap add android` would destroy them. Decide whether to
  commit it.

---

## Suggested order

1. **Start A3 (dataset)** — it needs people, not machines, and blocks the
   longest chain.
2. **A1 (Android)** in parallel — it unblocks six verifications at once,
   plus device-verifying C3's SOS wiring (code-complete, done above).
3. **B1 (browser-verify)** — biggest pile of finished-but-unproven work,
   and needs nothing but a session.
4. **B3, C2** — quick, and they make W20 tell the truth. (C2's Task
   Scheduler wiring still needs a human to run the final command —
   see C2's own note.)
5. **B2, B4** — close the verification gaps Sprint 8 will otherwise
   inherit.
6. **A2 (model run)** once a capable machine is available → then Sprint
   8's AI evaluation box.
