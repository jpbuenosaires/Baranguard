# DEVLOG — Sprint 0 (Local MariaDB Setup + Executable Schema)

## Scope delivered
(a) env-driven DB connection (Node + PHP), (b) migrations for §5, applied in
the mandated dependency order, (c) seed script for the four deterministic
barangay rows only, (d) interactive first-admin bootstrap CLI, (e)
backup/restore baseline.

## Environment used for validation
- MariaDB 10.11.14 (Ubuntu 24.04 package) — newer patch than the XAMPP
  10.4 target, but MySQL-protocol/DDL-compatible for everything used here
  (no MariaDB 10.5+-only syntax was used). Master Reference §16 also
  validates against 10.11 for the same reason.
- Node.js v22.22.2, `mysql2` (promise pool), `argon2`, `dotenv`.
- PHP 8.3 CLI with `pdo_mysql`.

## Files
- `config/db.js` — env-driven Node connection pool (`mysql2`), UTC timezone.
- `config/db.php` — env-driven PHP PDO connection.
- `migrations/0001_baseline_schema.sql` — all 24 server-side tables, 57
  foreign keys, dependency order per §5: `barangay → user → mobile_device →
  incident → dispatch → tanod_sos → notification → notification_target →
  notification_delivery → remaining dependent tables`. `auth_session` is
  created immediately after `user` (only depends on it); `evidence_attachment`
  / `blotter_record` / `citizen_report` are created immediately after
  `incident`/`dispatch` since they depend on those.
- `migrations/0001_baseline_schema.down.sql` — rollback, exact reverse drop
  order. Tested: drops all 24 tables cleanly, forward migration re-applies
  cleanly afterward.
- `migrations/0002_seed_barangays.sql` — seeds only the 4 deterministic
  barangay rows (Dao=1, Binanuahan=2, Marifosque=3, Banuyo=4; municipality
  Pilar, province Sorsogon). Uses `ON DUPLICATE KEY UPDATE` on the fixed
  `barangay_id` PK so re-running is a no-op, never a duplicate or an ID
  drift. Does **not** seed any incident/user/PII data.
- `scripts/bootstrap-admin.js` — interactive first-Admin CLI. Refuses to run
  if the chosen barangay already has an active Admin (one-time-per-barangay
  guard). Argon2id hashing. Password entry is masked on a real TTY; never
  echoed, logged, or written to any file in either TTY or piped mode.
  Records a `bootstrap_first_admin` audit_log row (no password/secret in
  metadata).
- `scripts/backup.sh` / `scripts/restore.sh` — `mysqldump` piped straight
  into AES-256-CBC (pbkdf2) encryption via `openssl`; plaintext dump is
  `shred -u`'d immediately after encryption. SHA-256 checksum written
  alongside. `restore.sh` verifies the checksum, decrypts to a temp file
  (also shredded on exit via `trap`), and restores into a **separate**
  `<db>_restore_test` database by default so a routine drill can't
  overwrite production.

## Tests performed (with evidence)
1. **Empty-DB apply**: dropped and recreated an empty `baranguard` schema,
   applied `0001_baseline_schema.sql` — 0 errors. `SHOW TABLES` → 24 rows.
   `information_schema.KEY_COLUMN_USAGE` FK count → 57 (matches Master
   Reference §15/§16's stated "24 tables, 57 foreign keys").
2. **Rollback/reapply**: ran `0001_baseline_schema.down.sql` — all 24
   tables dropped with 0 errors; re-ran the forward migration — 0 errors,
   24 tables again.
3. **Seed idempotency**: ran `0002_seed_barangays.sql` twice — row count
   stayed at 4 both times; confirmed `incident`/`user` tables remained
   empty after seeding.
4. **DB connection modules**: both `config/db.js` (Node/mysql2) and
   `config/db.php` (PHP/PDO) connected using only `.env`-sourced
   credentials and read the seeded barangay count successfully.
5. **Bootstrap CLI — happy path**: created barangay-1 Admin via piped
   stdin; verified `user` row (`role='admin'`, `is_active=1`,
   `password_hash` is a valid `$argon2id$...` string) and the
   `bootstrap_first_admin` audit_log row.
6. **Bootstrap CLI — one-time guard**: re-running for the same barangay
   (id 1) correctly refused with a stderr error and exit code 1, without
   touching the database.
7. **Bootstrap CLI — password policy**: submitted a weak password twice
   (rejected both times with a specific reason), then a compliant one,
   which succeeded — confirms the retry loop and validation both work.
8. **No plaintext password leakage**: `grep`'d the entire `backend/`
   source tree for the test plaintext password after both bootstrap runs
   — zero matches in any source or log file.
9. **Backup**: ran `scripts/backup.sh` against the live seeded+bootstrapped
   database — produced an encrypted `.sql.enc` + `.sql.enc.sha256`; no
   plaintext `.sql` file was left on disk (shredded immediately).
10. **Restore drill**: ran `scripts/restore.sh` against that backup —
    checksum verified OK, decrypted, restored into
    `baranguard_restore_test` — 24 tables recreated. Verified the restored
    `barangay` rows and `user` count matched the source exactly, then
    dropped the verification database.

## Deviations from the reference / decisions made
- **MariaDB version**: validated against 10.11.14 rather than the XAMPP
  10.4 the reference names, because that's what `apt` provides in this
  sandbox. No 10.5+-only feature was used in the migration; this mirrors
  the choice the Master Reference's own §16 trace already made and flags
  for the same reason. Flagging here per the reference's own instruction
  to log any environment deviation.
- **Restore target DB privilege**: the scoped `baranguard_app` user
  initially lacked `CREATE DATABASE` (correct, least-privilege default).
  For local restore-drill testing only, a grant was added scoped to
  `baranguard_restore_test.*`. This is a dev-only convenience for running
  `restore.sh`'s default (non-destructive) verification-DB path; a real
  disaster-recovery restore onto the production database name would use
  DBA/root credentials, not this app user, and that path was not
  additionally tested here.
- **CHECK constraint trap**: confirmed by inspection (not re-attempted)
  that a table-level CHECK on `notification`'s entity-integrity matrix
  would hit MariaDB `ERROR 1901`, per the Master Reference §16 note. The
  migration does not include that CHECK; the matrix is left for
  application-code + transaction-level enforcement in a later sprint, as
  directed.
- **Password policy baseline**: `bootstrap-admin.js` enforces a minimum
  12-char / upper+lower+digit password policy for the bootstrap flow
  specifically, since §6's full password policy isn't wired into any
  endpoint yet in Sprint 0. This is a bootstrap-only stopgap, not a claim
  that it satisfies §6 in full — revisit when `POST /auth/login` /
  password-policy enforcement is implemented.

## Not yet done (explicitly out of Sprint 0's cut)
- No API/route/controller code (Sprints 1+).
- No `/sms`, `/dispatch`, `/incidents` endpoints — this session was schema
  + bootstrap + backup only, per the "Sprint 0" scope in the prompt.
- Retention *jobs* (the §11 retention table) are not implemented — Sprint 0
  only seeds barangay rows and explicitly avoids seeding anything the
  retention table would apply to.
- Final backup schedule/retention number is not yet recorded in a
  deployment runbook (§11 requires this before UAT, not before Sprint 0).
