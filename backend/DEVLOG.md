# DEVLOG — Sprint 0 (Local MariaDB Setup + Executable Schema)
# then Sprint 1 (Auth backend + shared middleware) below

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

## Real-environment validation (XAMPP MariaDB 10.4.32)
All of the above was originally validated against MariaDB 10.11.14 in a
Linux sandbox, not the actual local XAMPP target — flagged as an open item
at the time. Re-run on 2026-09-01 against the real local XAMPP install
(MariaDB 10.4.32, confirmed via `SELECT VERSION()`), using
`backend/scripts/verify-sprint0.sh` (new — an end-to-end runner that
exercises steps 1-10 below against a disposable `baranguard_sprint0_check`
database plus a disposable `baranguard_sprint0_check_restore_test`
database, so the real `baranguard` database and `backend/backups/` are
never touched, and drops both throwaway databases at the end):

- Empty-DB apply: 0001_baseline_schema.sql — 0 errors, 24 tables, 57 FKs.
- Rollback/reapply: down.sql drops all 24 tables cleanly; forward
  migration re-applies cleanly, 24 tables again.
- Seed idempotency: 0002_seed_barangays.sql run twice — barangay count
  stayed at 4, `user` table stayed empty.
- Bootstrap CLI: happy-path admin creation (role=admin, active, valid
  `$argon2id$` hash), `bootstrap_first_admin` audit_log row present,
  one-time guard correctly refused a second bootstrap for the same
  barangay, and a full grep of `backend/` (excluding the verification
  script and log files themselves) found the test password nowhere.
- Backup/restore: `backup.sh` produced an encrypted `.sql.enc` + `.sha256`
  with no plaintext `.sql` left on disk; `restore.sh` verified the
  checksum, decrypted, and restored into a separate `_restore_test`
  database with 24 tables and the expected 4 barangay rows.

Result: 19/19 checks passed. `backend/scripts/verify-sprint0.sh` is kept
in the repo as a repeatable regression check for future changes to the
Sprint 0 migration/seed/bootstrap/backup chain — it creates its own
disposable MySQL user for the bootstrap/backup steps (since both scripts
correctly reject an empty `DB_PASSWORD`, and XAMPP's default `root` has
no password), and drops that user at cleanup too.

## Not yet done (explicitly out of Sprint 0's cut)
- No API/route/controller code (Sprints 1+).
- No `/sms`, `/dispatch`, `/incidents` endpoints — this session was schema
  + bootstrap + backup only, per the "Sprint 0" scope in the prompt.
- Retention *jobs* (the §11 retention table) are not implemented — Sprint 0
  only seeds barangay rows and explicitly avoids seeding anything the
  retention table would apply to.
- Final backup schedule/retention number is not yet recorded in a
  deployment runbook (§11 requires this before UAT, not before Sprint 0).

---

# DEVLOG — Sprint 1 (Auth backend + shared middleware)

## Today's cut
"Auth backend + middleware" — the item explicitly called out in the sprint
prompt as unblocking every other Sprint 1 item. Nothing else from Sprint
1's checklist (W2 Admin Dashboard, W3a/W3b Dispatch Center, W4 GIS, W5
Heatmap, W6 Blotter, W9 Reports, W15 Settings, W16 Citizen Inbox, W19
Public Report, Scheduler+fatigue) was started this session — stopping
here deliberately, per the sprint prompt's own rule.

## Decision required before coding, now resolved
§1 lists the stack as "PHP 8.2 + Node.js" jointly without saying which one
serves `/api/v1/*`; the sprint prompt requires stopping to ask rather than
assuming. **Answer: PHP 8.2 serves the API.** Node stays for the Sprint 0
CLI tooling (`bootstrap-admin.js`) — no Node HTTP service exists or is
planned from this. Logged here so no later session re-decides this
differently.

## Scope delivered
- `POST /auth/login`, `POST /auth/logout` exactly per §6's "Auth" section.
- Shared middleware (`AuthMiddleware`) implementing §2 Rule 9's full check
  (signature, algorithm, expiry, session existence, revocation, user
  activation, tenant identity) as `authenticate()`, plus `requireRole()`
  and `requireTenant()` helpers every future controller should call —
  this is the reusable piece the rest of Sprint 1 depends on.
- Explicitly NOT delivered this cut (own checklist item / own sprint,
  intentionally): `POST /auth/change-password` (§6 lists it under Auth,
  but it's not part of the "Auth backend + middleware" box specifically
  and fits more naturally under W15 Settings/Account later).

## Files
- `config/env.php` — minimal `.env` loader for PHP (no `vlucas/phpdotenv`
  dependency was ever actually added despite `db.php`'s Sprint 0 comment
  mentioning it — Apache/PHP doesn't read `.env` on its own the way
  Node's `dotenv` does, so without this, `getenv()` returned nothing
  under Apache). Never overrides an already-set env var, same precedence
  as the Node side.
- `config/autoload.php` — minimal PSR-4-ish autoloader for the
  `Baranguard\` namespace. No Composer dependency (nothing else in
  `backend/` uses one yet). One class per file, enforced by hand — see
  the ApiError/JwtException bug below for what happens when that's
  violated.
- `services/auth/Jwt.php` — HS256 JWT encode/decode, explicit `alg`
  allow-list (never trusts a token-supplied algorithm), `hash_equals` for
  signature comparison. `services/auth/JwtException.php` — split out
  after a real bug (see below).
- `services/auth/PasswordPolicy.php`, `services/auth/Username.php` — the
  password composition rule (12+ chars, upper+lower+digit) and username
  normalization rule (trim, lowercase, `^[a-z0-9._-]{3,64}$`), extracted
  as the canonical definitions matching Sprint 0's `bootstrap-admin.js`
  exactly, since PHP and Node can't literally share code. If this policy
  ever changes, update both by hand.
- `lib/Http.php` — JSON body/header helpers, response envelope.
  `lib/ApiError.php` — the exception used to short-circuit to a standard
  error response. Split into its own file for the same reason as
  JwtException.
- `middleware/AuthMiddleware.php` — `authenticate()` (strict gate for
  ordinary protected endpoints), `resolveForLogout()` (deliberately
  looser — see logout idempotency bug below), `requireRole()`,
  `requireTenant()`.
- `controllers/AuthController.php` — `login()`, `logout()`.
- `routes/auth.php` — route table consumed by `public/index.php`'s
  router; the pattern every future `routes/*.php` file should follow.
- `public/index.php` — front controller. All `/api/v1/*` traffic routes
  through here. `public/.htaccess` — rewrites everything to `index.php`.
  `backend/.htaccess` — defense-in-depth `Require all denied` in case the
  Apache DocumentRoot ever gets pointed at `backend/` instead of
  `backend/public/`.
- `scripts/README-serving.md` — how to actually serve this under XAMPP
  (vhost pointed at `backend/public`) or via PHP's built-in server for
  quick local testing.
- `scripts/verify-sprint1-auth.sh` — new end-to-end validation script,
  same pattern as `verify-sprint0.sh`: disposable database
  (`baranguard_sprint1_check`), disposable app-user, disposable test
  admin (hashed with PHP's own `password_hash()`, not Node's argon2 —
  deliberately, to prove PHP `password_verify()` actually accepts the
  hash format this app will really store), a PHP dev server on a
  throwaway port, then cleans up everything including the process.
- `.env.example` — added `CORS_ALLOWED_ORIGIN` (default `*`, fine for a
  local-only/LAN system per Rule 7) and a one-liner for generating a real
  `JWT_SECRET`.

## Resolved decisions not stated in the reference (flagging per the
## prompt's own instruction to log deviations)
- **Error envelope shape**: §6 lists the error *codes* but never the JSON
  shape. Chosen: `{"error":{"code":"...","message":"..."}}`. Every future
  controller must reuse this exact shape via `Http::sendError()`, not
  invent a new one.
- **Login lockout numbers**: the `user` table schema clearly expects a
  lockout policy (`failed_login_attempts`,
  `login_failure_window_started_at`, `locked_until`) but no section
  states the actual thresholds. Chosen: 5 failed attempts inside a
  rolling 15-minute window locks the account for 15 minutes.
- **CORS**: not addressed anywhere in the reference. Chosen: permissive
  default (`*`) since this is a locally-hosted, LAN-only system (Rule 7),
  overridable via `.env`.
- **`backend/public/` folder**: §4's folder list doesn't include
  `/public`, but serving PHP directly out of `backend/` (which also holds
  `.env`, `config/`, `migrations/`, `scripts/`) from the web root would
  expose all of that over HTTP. `backend/public/index.php` as the actual
  Apache DocumentRoot, with a defense-in-depth `backend/.htaccess`
  denying everything, is the standard fix — added deliberately, not an
  oversight of the documented structure.
- **No Composer / no model layer yet**: JWT and autoloading are hand
  -rolled (see Jwt.php's own comment) rather than pulling in
  `firebase/php-jwt` and Composer for one algorithm. `AuthController`
  talks to PDO directly rather than through a `models/` abstraction —
  reasonable for two endpoints; revisit if `models/` earns its keep once
  more controllers exist.
- **405 for wrong-method-on-known-route**: §6's standard error list
  doesn't include 405; used it anyway with `VALIDATION_ERROR` as the
  closest documented code, since it's a real, correct HTTP status the
  router needs to return.

## Bugs found and fixed during this session's own testing (not just
## claimed — here's what testing against a real server actually caught)
1. **Logout idempotency**: §6 requires "the server ignores a second
   logout safely" (`{success:true}` both times). The first implementation
   ran `logout()` through the same strict `AuthMiddleware::authenticate()`
   gate as every other protected endpoint — which correctly rejects an
   already-revoked session with 401. That's right for ordinary endpoints,
   wrong for logout's own idempotency requirement. Fixed with a separate
   `AuthMiddleware::resolveForLogout()` that still requires a validly
   -signed, unexpired token tied to a real session row (a forged/garbage
   token still gets 401), but tolerates the session already being
   revoked. Caught by testing logout twice in a row against a live
   server, not by inspection.
2. **Autoloader / one-class-per-file violation**: `ApiError` was
   originally declared inside `lib/Http.php` alongside the `Http` class,
   and `JwtException` inside `services/auth/Jwt.php` alongside `Jwt`. The
   autoloader maps class name -> exact filename, so this only "worked" by
   accident whenever something loaded `Http`/`Jwt` first (which every
   end-to-end HTTP request through `index.php` does, since `index.php`
   uses `Http::` constantly). A direct unit test of
   `AuthMiddleware::requireRole()` in isolation — which never touches
   `Http` — hit a fatal "Class ApiError not found". Fixed by splitting
   both exception classes into their own files
   (`lib/ApiError.php`, `services/auth/JwtException.php`). Caught by
   testing the middleware directly, not only through the full HTTP path
   — worth remembering for future sessions: end-to-end tests can mask
   autoloading bugs that only show up when a class is used from an
   unexpected entry point.

## Tests performed (with evidence)
All of the above was built and first validated in a Linux sandbox running
MariaDB 10.11 + PHP 8.4 (not the real XAMPP target) — same caveat as
Sprint 0's first pass. Ran there: empty-body validation, unknown-user and
wrong-password both returning the identical generic 401 (Rule 9's
externally-indistinguishable requirement), 5-failed-attempts lockout then
still-denied on the 6th attempt with the *correct* password, successful
login with un-normalized username casing/whitespace, logout, idempotent
repeat logout, garbage-token and missing-header both 401, unknown route
404, wrong method 405, CORS preflight headers present, sliding renewal
(`X-Renewed-Token`) verified directly against `AuthMiddleware::authenticate()`
once remaining session life dropped below 50%, and audit_log rows for
`login_success`/`login_failure`/`logout` present with no password ever
appearing in `metadata_json`. `scripts/verify-sprint1-auth.sh` automates
all of the HTTP-level checks (22 checks) and is safely re-runnable.

**Still needs to be re-run against the real local XAMPP MariaDB 10.4 +
PHP install** — `backend/scripts/verify-sprint1-auth.sh` is written for
exactly that, same non-destructive disposable-database pattern as
`verify-sprint0.sh`. Not yet run there as of this entry.

## Known environment risk to verify on the real XAMPP install
PHP's `password_verify()` must support `argon2id` for login to work
at all (Sprint 0's `bootstrap-admin.js` hashes with Node's argon2
library; Sprint 1's login verifies with PHP's native `password_verify()`
— the hash format is a standard PHC string so this should just work, but
older/minimal PHP builds sometimes lack Argon2 support compiled in).
`verify-sprint1-auth.sh` checks `password_algos()` up front and prints a
warning if `argon2id` isn't listed, rather than failing silently later.

## Real-environment validation (XAMPP MariaDB 10.4.32 + PHP 8.2.12)
Re-run on 2026-09-01 against the real local XAMPP install via
`backend/scripts/verify-sprint1-auth.sh` — MariaDB 10.4.32 and PHP
8.2.12, both matching this sprint's actual targets (not just
version-compatible substitutes, unlike Sprint 0's first sandbox pass).
All 22 checks passed: schema/seed/test-admin setup, empty-body
validation, unknown-user and wrong-password both 401 with the identical
message, 5-attempt lockout enforced (6th attempt denied even with the
correct password), successful login with un-normalized username
casing/whitespace, logout, idempotent repeat logout (200 both times, one
audit row), garbage-token and missing-header both 401, unknown route 404,
wrong method 405, CORS preflight headers, and full audit trail with no
password ever appearing in `metadata_json`. The `password_algos()`
argon2id check passed silently (no warning) — confirms the Node
(bootstrap) → PHP (login) argon2id hash handoff works on the actual
target environment, not just in the sandbox. This closes out the one
environment risk flagged earlier in this entry.

## Not yet done (explicitly out of this cut)
- `POST /auth/change-password` (§6 Auth section, but not in today's box).
- Every other Sprint 1 checklist item (W2/W3a/W3b/W4/W5/W6/W9/W15/W16/
  W19, scheduler+fatigue) — none started.
- User/device-lifecycle endpoints, incidents, dispatch, GPS, everything
  else in §6 — all later sprints per the Sprint Map.
- `models/` layer — direct PDO in the controller for now (see decisions
  above).
