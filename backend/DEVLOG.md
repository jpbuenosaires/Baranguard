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

---

# DEVLOG — Sprint 1 continued: W2 Admin Dashboard

## Today's cut
"W2 Admin Dashboard — wire existing frontend to real GET /reports/summary"
— one box from Sprint 1's menu. Nothing else from the remaining checklist
(W3a/W3b Dispatch Center, W4 GIS, W5 Heatmap, W6 Blotter, W9 Reports,
W15 Settings, W16 Citizen Inbox, W19 Public Report, Scheduler+fatigue) was
started this session.

**Scope note, not a deviation from "pick exactly ONE":** the box's own
name ("wire *existing* frontend") assumed a frontend to wire into. There
wasn't one — `web/src/{api,components,pages,styles}` were empty README
stub folders (confirmed by listing the actual directory before writing
any code, per this sprint's "ALREADY BUILT — DO NOT RECREATE" rule cutting
both ways: nothing existed to avoid recreating). W2 is unreachable/
untestable without *some* way to authenticate first, so this session also
built a minimal W1 login page — not a full W1 polish pass, just the form
+ generic-failure message + redirect the spec requires — as necessary
plumbing for W2 to exist as a working screen, the same way Sprint 1's
auth *middleware* wasn't its own checked box but was built alongside
auth's endpoints as required infrastructure.

## Scope delivered
Backend: `GET /reports/summary` (§6 Audit/reports, §9 W2). Frontend:
`apiClient.js` (the one central `/api/v1` boundary per §4), a minimal W1
login page, and the full W2 dashboard (KPI cards, trend chart,
by-status/by-incident-type breakdowns, date-range controls, Loading/
Empty/Error/Populated states per §8).

## Files
- `backend/lib/Http.php` (MODIFIED, additive) — added `Http::query(string
  $name): ?string` for reading `$_GET` params. No prior endpoint read a
  query string; this is new scope on top of an already-shipped file, not
  a rewrite of it.
- `backend/routes/reports.php` (NEW) — `GET /reports/summary` route entry.
- `backend/controllers/ReportsController.php` (NEW) — `ReportsController::summary(PDO $pdo, array $identity): void`.
- `backend/scripts/verify-w2-reports.sh` (NEW) — disposable-DB validation
  script, same pattern as `verify-sprint0.sh`/`verify-sprint1-auth.sh`.
- `web/index.html` (NEW) — page shell; sets `window.BARANGUARD_API_BASE_URL`.
- `web/README-serving.md` (NEW) — how to serve the static frontend locally.
- `web/src/api/apiClient.js` (NEW) — `login()`, `logout()`,
  `getReportsSummary()`, `getSession()`, `isAuthenticated()`,
  `ApiClientError`. Session (token/expiry/user) lives in `sessionStorage`.
- `web/src/styles/base.css` (NEW) — §8 design tokens + shared layout/card/
  status-pill/state-block/trend-chart styles.
- `web/src/components/KpiCard.js`, `web/src/components/TrendChart.js` (NEW)
  — PascalCase per §4; plain DOM-returning functions, no framework.
- `web/src/pages/login.js`, `web/src/pages/admin-dashboard.js` (NEW) —
  kebab-case per §4.
- `web/src/main.js` (NEW) — bootstrap/router: login page if no session;
  W2 dashboard for `admin`/`punong_barangay`; an honest "not built yet"
  screen for any other role that successfully authenticates (Secretary/
  Tanod can log in — §6 doesn't gate login by role, only `lupon` is
  blocked at the account level — but their screens don't exist yet).

## Resolved decisions not stated in the reference (logged, don't reopen without review)
- **`GET /reports/summary` query params**: `date_from`/`date_to`,
  optional, `YYYY-MM-DD`, inclusive, Asia/Manila calendar days. Default
  (both omitted) is trailing 30 days. Range capped at 366 days → 400
  VALIDATION_ERROR if exceeded, same as a malformed date or `date_from`
  after `date_to`.
- **`by_incident_type` / `by_status` shape**: objects keyed by every §5
  enum member, value = count, always present at 0 (never omitted) — so
  the client never has to assume which keys can appear.
- **`trend[]` shape**: one `{date, count}` entry per calendar day in the
  range, in order, every day present even at `count:0` — no gaps for the
  chart to infer.
- **`avg_response_time_minutes` is `null`, not `0`**, when no incident in
  range reached `arrived` — a real zero-minute average and "no data" must
  not collide on the same value. Rounded to 1 decimal otherwise.
- **`active_tanods` is a current-state snapshot**, not filtered by the
  date range (same-barangay active Tanods whose most recently recorded
  `duty_status` is `on_duty`/`responding`). Sprint 1 hasn't built
  duty-toggle yet (mobile M2, Sprint 2), so this legitimately reads 0
  until then.
- **Day-bucketing uses a fixed Asia/Manila = UTC+8 offset in PHP**, not
  MariaDB's `CONVERT_TZ()` — that function depends on the
  `mysql.time_zone_name` tables being loaded, which is not guaranteed on
  a stock XAMPP install. `incident.created_at` is fetched as its stored
  UTC value and converted in PHP per row instead.
- **Web API base URL is a page-level global**
  (`window.BARANGUARD_API_BASE_URL` in `index.html`), not a build-time env
  var — §1's stack has no bundler to inject one. Defaults to the PHP
  built-in server's URL (`backend/scripts/README-serving.md` Option B).
- **Session storage is `sessionStorage`, not `localStorage`** — a session
  that dies with the tab is the safer default for a shared-workstation
  CAD-style system (§8 tone), while still surviving an accidental reload.
- **`apiClient.js` hand-maps each endpoint's snake_case↔camelCase fields
  rather than deep-recursively converting every object key.** A blind
  recursive converter would rewrite `by_incident_type`'s enum-valued keys
  (`physical_injury`, `traffic_incident`, ...) into `physicalInjury` etc.,
  corrupting data identity, not just formatting a field name. Structural
  keys convert; enum-valued keys pass through unchanged.
- **W2's "fresh deployment" empty state** (§9: "Fresh deployments show an
  intentional empty state") triggers on `totalIncidents === 0 &&
  activeTanods === 0` for the *current* dashboard load — not on a
  separate "has this barangay ever had any data" signal the API doesn't
  provide. A quiet barangay with real historical data but zero activity
  in a narrow selected date range still renders real (all-zero) KPI
  cards, not the empty state — those are different facts.

## Bug found and fixed during this session's own testing
**Initial dashboard load computed its own "default 30-day range" in the
browser's local timezone and sent it explicitly, instead of ever actually
using the server's default.** `ReportsController`'s default range is
correct (Asia/Manila-based), but `admin-dashboard.js` originally
pre-filled the date inputs via client-side `Date` math and always sent
`date_from`/`date_to` on the very first load — meaning the *client's*
timezone, not the server's, silently defined "the last 30 days" for a
new page load. Caught by the Playwright end-to-end check
(`Total Incidents` KPI: expected 8, got 7) right at a UTC/Asia-Manila
day-boundary, not by inspection. Fixed: the initial load now omits
`date_from`/`date_to` entirely so the server's real default wins; once
the response comes back, the date inputs are corrected to the range the
server actually used, so a later manual "Apply" starts from truth. The
same class of bug was caught a second time while writing
`verify-w2-reports.sh` itself (a curl date built from `date -u`, not
Asia/Manila) — fixed there too, both logged as the identical lesson:
never assume the caller's "today" matches the server's Asia/Manila
"today" without converting.

## Tests performed (with evidence)
1. **Sandbox setup**: disposable `baranguard_w2_check` DB, disposable app
   user, PHP 8.4.21 + MariaDB 10.11.14 (this session's cloud sandbox, not
   XAMPP — flagged below as the same "needs real-XAMPP re-run" pattern as
   Sprint 0/1).
2. **`verify-w2-reports.sh`** (30 checks, all passing): connectivity;
   schema/seed setup; 401 with no `Authorization` header; 403 for
   `secretary` and `tanod` roles; 200 for `punong_barangay` (read-only
   role, same GET); all 7 response keys present; `total_incidents=8`,
   `resolved_count=4`, `avg_response_time_minutes=11.3` (known dispatch
   times 12/8/20/5 min → 11.25 → rounds to 11.3), `active_tanods=2`
   (one `on_duty`, one `responding`, one `off_duty` correctly excluded);
   `sum(trend[].count)` and `sum(by_status)` both equal `total_incidents`
   (no incident lost/double-counted in bucketing); `by_incident_type` has
   all 11 §5 enum members present; **tenant isolation** — a second
   barangay's admin sees only their own 1 incident, and the first
   barangay's count is unaffected (no cross-tenant leakage); malformed
   `date_from`, `date_from` after `date_to`, and a >366-day range all
   400; a same-day narrow range returns exactly the incidents created
   that Asia/Manila day.
3. **Playwright end-to-end browser test** (throwaway script, not
   committed — no browser-automation dependency exists in this project
   yet and one script shouldn't introduce it unasked): real Chromium
   against the real PHP server and the real static `web/` files, not a
   DOM-less unit test. 15/15 checks: login form has no role selector; a
   wrong password shows the exact generic W1 message; correct login
   (with mixed-case username, exercising server-side normalization
   end-to-end) reaches the dashboard; all 4 KPI cards show the values
   the seeded data implies; trend bars and status-pill breakdowns render;
   changing the date range via Apply changes the KPIs; sign-out returns
   to the login page; a page reload after sign-out stays on the login
   page (session actually cleared, not just hidden); Punong Barangay
   reaches the same dashboard labeled "(read-only)"; Secretary
   authenticates successfully but sees the honest "not built yet" screen,
   never a blank page or a crash.
4. **PHP lint**: `php -l` clean on every new/modified PHP file.
5. **JS syntax**: `node --check` clean on every new JS module.

## Known environment risk to verify (same pattern as Sprint 0/1)
All of the above ran against this cloud sandbox's MariaDB 10.11.14 + PHP
8.4.21, not the real local XAMPP (MariaDB 10.4.32 + PHP 8.2.12). Nothing
in `ReportsController.php` uses a MariaDB 10.5+-only feature or a
PHP-8.3+-only language feature, but per this project's own established
practice, this needs a real-XAMPP re-run before being trusted —
`backend/scripts/verify-w2-reports.sh` is built for exactly that, same
disposable/re-runnable/non-destructive pattern as the Sprint 0/1 scripts.

## Not yet done (explicitly out of this cut)
- `GET /reports/heatmap`, `GET /reports/export` — separate Sprint 1/7
  boxes, not built here.
- Every other Sprint 1 checklist item (W3a/W3b/W4/W5/W6/W9/W15/W16/W19,
  scheduler+fatigue) — none started.
- W1's full spec beyond the minimal plumbing built here (no "forgot
  password", no further branding).
- A nav-shell entry for anything beyond Dashboard — deliberately not
  added, since a link to a screen that doesn't exist yet is its own kind
  of demo tell (§8).
- No automated JS test runner/browser-automation dependency was added to
  the repo — the Playwright check above was this session's own
  verification tooling, not a shipped artifact. If a future sprint wants
  a real regression suite for the web frontend, that's a decision to make
  explicitly, not one to back into via a leftover script.

---

# DEVLOG — Sprint 1 continued: W4 GIS Live Tracking + W3a/W3b Dispatch Center

## Today's cut

Three Sprint 1 boxes together — **W4 (GIS Live Tracking / shared LiveMap
component)**, **W3a (Dispatch Center — pending queue + Tanod picker,
read-only)**, and **W3b (Dispatch Center — create/cancel actions)** — per
a deliberate, explicit exception to the "pick exactly ONE" rule that the
user confirmed twice in the prior (Claude Desktop) session, continued
here in Claude Code. Each of the three is tested individually below with
real evidence, same discipline as every other entry — the exception is
only about how many get built before the next check-in, not about
skipping tests.

## Bug found before any new code was written (blocking, not part of this
## cut's own scope, fixed anyway)

`web/index.html` and every existing page/component (`admin-dashboard.js`,
`login.js`, `KpiCard.js`, `TrendChart.js`, `main.js`) referenced
`web/src/styles/base.css` and its class names from the moment they were
written, but the file was never actually committed — confirmed via
`git show <W2 commit> --stat`, which touched 13 files and never touched
`web/src/styles/`. The dashboard as committed was unstyled. Recreated
from §8's tokens plus every class name the existing files already
depended on (see Frontend section below) — necessary infrastructure, not
new scope creep, the same category as W2's own minimal login page.

## Resolved decisions (logged per this project's own convention; not to
## be re-opened without explicit review)

- **Router path params.** `backend/public/index.php`'s router previously
  discarded `preg_match` capture groups since no route needed one yet.
  `PATCH /dispatch/:id/cancel` does. Fixed by capturing groups and
  forwarding them as trailing handler args
  (`$handler($pdo, $identity, ...$routeParams)`); PHP silently ignores
  extra args on handlers that don't declare them, so `auth.php`/
  `reports.php`'s existing 2-arg handlers are unaffected.
- **LiveMap rendering.** Real MapLibre GL JS v4.7.1, vendored locally
  under `web/vendor/maplibre-gl/` (fetched once during this build, no
  runtime CDN dependency — consistent with this being a locally hosted
  system, §2 Rule 7) rather than loaded from a public CDN or hand-rolled
  as a non-MapLibre canvas. No basemap tile source is wired up (none
  exists for the web dashboard yet, online or offline — that's a
  distinct, undocumented-for-Sprint-1 dependency): the style is a flat
  background color plus GeoJSON layers for the barangay boundary (when a
  future endpoint provides `boundary_geojson`) and DOM markers for
  Tanods/SOS. No barangay-metadata endpoint exists yet either, so the map
  falls back to a fixed default view centered on Pilar, Sorsogon
  (~12.9186°N, 123.6667°E) and fits bounds to whatever markers are
  actually present.
- **Notification creation is explicitly NOT done in `POST /dispatch`.**
  §6 says dispatch creation "records notification creation," but the
  notification/notification_target/notification_delivery data model and
  FCM/SMS transports are their own separate, not-yet-built Sprint 4
  boxes. Writing a bare `notification` row now, with no transport able to
  attempt delivery, would jump ahead of that dependency chain. Deferred
  deliberately.
- **OSRM is not wired up.** Every new dispatch gets
  `route_status="unavailable"`, `route_json=NULL` — treated identically
  to a documented OSRM failure (§6 already says this doesn't roll back
  dispatch creation).
- **Tanod eligibility ("on-duty")** for assignment means the Tanod's most
  recent `duty_status` row is exactly `on_duty` — `responding` (already
  engaged) and `off_duty` are excluded. Every reason a `tanod_id` is
  unusable (wrong barangay, wrong role, inactive, not on-duty, doesn't
  exist) collapses into the same generic `422 UNPROCESSABLE_ENTITY` so
  error-message differences can't leak cross-tenant information.
  Incident not-found/wrong-barangay uses the existing `requireTenant()`
  404 pattern.
- **`GET /users?role=`** (§6 "Users & device lifecycle") was added this
  session even though CLAUDE.md's original endpoint list didn't name it —
  necessary plumbing, same precedent as W2's login page: the Tanod picker
  needs Tanod full names, and `GET /duty-status?barangay_id=`'s
  documented shape (§6) is fixed to `{user_id,status,channel,changed_at}`
  with no name. Only list (`index`) is built.
- **`GET /gps/live`'s response shape** (§6 only describes it in prose):
  one row per same-barangay active Tanod who has *ever* recorded a GPS
  point — their single latest `gps_track` row plus freshness. A Tanod
  with no GPS row at all is simply absent from `items`, which is the
  correct, expected state until Sprint 3's mobile GPS broadcast exists.
  `age_seconds`/`is_stale` are computed against `recorded_at`, not
  `received_at`.
- **`GET /gps/history`'s date-range cap** reuses `ReportsController`'s
  366-day cap for consistency.
- **`GET /duty-status`'s two query shapes** (`?user_id=me` vs.
  `?barangay_id=`) are dispatched inside one controller method rather
  than two routes, since they share a path per §6.
- **Dispatch queue empty-state / SOS banner:** the pending queue and
  active-dispatch sections each show their own inline empty note rather
  than taking over the whole screen (the map pane is a permanent
  operational surface, not conditionally hidden). SOS banner text is
  driven by `status !== 'resolved'` (acknowledged still shows, per §9's
  explicit note that acknowledging an SOS doesn't clear the banner).
- **GIS Live Tracking polling:** §6 doesn't specify a refresh cadence for
  `GET /gps/live`; resolved at 15 seconds — same order of magnitude as
  the 120-second staleness threshold without being wasteful. A background
  poll failure doesn't blank an already-populated map; only the first
  load shows the Error state.

## Scope delivered

Backend: `GET /incidents` (tenant-scoped queue read), `POST /dispatch` +
`GET /dispatch` + `PATCH /dispatch/:id/cancel` (full create/list/cancel
per §6, idempotent via `request_id`), `GET /gps/live` + `GET /gps/history`
(freshness/staleness per §6), `GET /tanod-sos` (read-only), `GET
/duty-status` (both query shapes), `GET /users?role=` (Tanod-picker
plumbing). Frontend: `base.css` (recreated — see bug above), vendored
MapLibre GL JS, the shared `LiveMap` component, `AppShell` component
(extracted sidebar/topbar, now shared by all three screens instead of
duplicated), `dispatch-center.js` (W3a+W3b), `gis-live-tracking.js` (W4),
and `apiClient.js`/`main.js` updates to wire it all together.

## Files

- `backend/public/index.php` (MODIFIED, additive) — router now forwards
  regex capture groups to handlers as trailing args.
- `backend/controllers/IncidentsController.php` (NEW) — `GET /incidents`.
- `backend/controllers/DispatchController.php` (NEW) — `create()`,
  `index()`, `cancel()`.
- `backend/controllers/GpsController.php` (NEW) — `live()`, `history()`.
- `backend/controllers/TanodSosController.php` (NEW) — `index()` only.
- `backend/controllers/DutyStatusController.php` (NEW) — `index()`
  dispatching both query shapes.
- `backend/controllers/UsersController.php` (NEW) — `index()` only.
- `backend/routes/incidents.php`, `dispatch.php`, `gps.php`,
  `tanod-sos.php`, `duty-status.php`, `users.php` (NEW) — one route table
  per resource, same shape as `routes/reports.php`.
- `backend/scripts/verify-w3-w4-dispatch-gis.sh` (NEW) — disposable-DB
  end-to-end validation script, same pattern as the three prior verify
  scripts.
- `web/src/styles/base.css` (NEW — recreated, see bug above).
- `web/vendor/maplibre-gl/maplibre-gl.js` + `.css` (NEW) — vendored
  v4.7.1.
- `web/src/components/LiveMap.js` (NEW) — the shared map component;
  `setMarkers()`, `setSosMarkers()`, `setBoundary()`, `destroy()`.
- `web/src/components/AppShell.js` (NEW) — sidebar+topbar, extracted from
  `admin-dashboard.js`'s previously inlined version now that 3 screens
  need it; role-filters nav items per §9 (Dispatch Center hidden from PB,
  who has no read-only variant built this session).
- `web/src/pages/dispatch-center.js` (NEW) — W3a+W3b.
- `web/src/pages/gis-live-tracking.js` (NEW) — W4.
- `web/src/pages/admin-dashboard.js` (MODIFIED) — now uses `AppShell`
  instead of its own inlined sidebar/topbar.
- `web/src/api/apiClient.js` (MODIFIED, additive) — `getUsers`,
  `getIncidents`, `getDispatches`, `createDispatch`, `cancelDispatch`,
  `getGpsLive`, `getGpsHistory`, `getTanodSos`, `getDutyStatus`.
- `web/src/main.js` (MODIFIED) — routes between all 3 built screens by
  role, stops a page's polling handle before navigating away.
- `web/index.html` (MODIFIED) — added vendored MapLibre `<link>`/
  `<script>` tags.

## Bug found and fixed during this session's own testing (not just
## claimed — here's what a real browser run actually caught)

**Sign-out from the GIS Live Tracking page crashed instead of returning
to the login page.** `gis-live-tracking.js`'s own sign-out handler calls
`stopPolling()` immediately (for responsiveness) before calling
`logout()`; `main.js`'s `boot()` *also* calls the page's stored stop
handle at the start of every navigation, including the one that follows
sign-out — so `stopPolling()` legitimately runs twice for the same
`LiveMap` instance. `LiveMap.destroy()` wasn't idempotent: a second
`map.remove()` threw inside MapLibre's own teardown ("Cannot read
properties of undefined (reading 'destroy')"), which aborted `boot()`
before it could render the login page, leaving `#app` empty. Caught by a
real Playwright run against a live Chromium browser (not a stub), not by
inspection — the first two run attempts also surfaced two flaws in the
*test script itself* (a fixed 500ms wait that was occasionally too short
for the login-error assertion, and a GPS-freshness assertion that broke
because real wall-clock time had passed between seeding "15 seconds ago"
and actually running the check) before this real app bug surfaced as a
`pageerror` in the browser console. Fixed by making `LiveMap.destroy()`
idempotent (guards on a `destroyed` flag) — the more robust fix than
trying to guarantee every caller invokes it exactly once.

## Tests performed (with evidence)

1. **PHP lint** (`php -l`) and **JS syntax check** (`node --check`) clean
   on every new/modified file.
2. **`backend/scripts/verify-w3-w4-dispatch-gis.sh` against the real
   local XAMPP install (MariaDB 10.4.32 + PHP 8.2.12)** — 37/37 checks
   passed: `GET /users?role=tanod` role-gating + count; `GET /incidents`
   pending-queue count + tenant isolation; `GET /duty-status` both query
   shapes + role-gating; `GET /gps/live` freshness/staleness (fresh vs.
   5-minute-old point) + tenant isolation (404 cross-tenant); `GET
   /gps/history` + Admin-only gating (PB correctly 403); `GET /tanod-sos`
   + role-gating; `POST /dispatch` create + `route_status=unavailable` +
   incident transitions to `dispatched` + **idempotent retry returns the
   same dispatch (verified only 1 row exists in the DB, not just that the
   response looked right)** + off-duty-Tanod rejection (422) +
   already-dispatched-incident rejection (409) + cross-tenant-Tanod
   rejection (422) + Secretary role-gating (403); `GET /dispatch` tenant/
   ownership scoping (Tanod forced to own, cross-tenant Admin sees 0);
   `PATCH /dispatch/:id/cancel` cross-tenant rejection (404) + successful
   cancel + incident reverts to `pending` + re-cancel rejection (409).
   One real bug was caught and fixed *while writing this script*: two
   incidents seeded with identical `created_at` timestamps meant `ORDER
   BY created_at DESC` had no guaranteed tie-break, so a test variable
   selecting "the first pending incident" could nondeterministically
   resolve to either row — fixed by selecting each incident by its
   distinct `priority` value instead of list position, in the test script
   only (not an application bug).
3. **Real browser walkthrough via Playwright (`playwright-core` driving a
   pre-cached local Chromium, throwaway tooling — not committed, same
   precedent as W2's own Playwright script)** against the real PHP dev
   server + real static `web/` files, using a fresh disposable database
   (`baranguard_browser_check`, dropped after) with realistic seed data —
   23/23 checks passed after two real bugs were found and fixed (one in
   this session's application code, `LiveMap.destroy()` above; the rest
   were flaws in the test script itself, corrected before the final run):
   login form has no role selector; wrong password shows the exact
   generic W1 message; correct login reaches the Dashboard; Admin sees
   all 3 real nav items; Dashboard KPI cards render; Dispatch Center shows
   the 2 seeded pending incidents; the SOS banner renders for the seeded
   active SOS; a MapLibre `<canvas>` actually renders inside the map
   pane; the Tanod picker shows exactly the 1 on-duty Tanod by name;
   assigning moves the incident from pending to active and it reflects
   live in the UI without a page reload; cancelling returns it to
   pending; navigating to GIS Live Tracking renders its own MapLibre
   canvas + roster; a fresh (seconds-old) GPS point shows "Live"; sign-out
   returns to the login page; a reload after sign-out stays on the login
   page (session actually cleared, not just hidden); zero *unexpected*
   console/page errors across the entire run (the only two logged were
   the intentional wrong-password 401 and the browser's own automatic
   `/favicon.ico` 404 — confirmed via direct `curl`, not assumed).
4. All test infrastructure (disposable database, disposable app-user,
   throwaway Playwright script/scratch directory, both dev-server
   processes) was torn down after — the real `baranguard` database and
   `backend/.env` were never touched, same as every prior verify script
   in this repo.

## Known environment note (same pattern as every prior entry)

Both the shell-script and browser validation above ran directly against
this session's real local XAMPP install (MariaDB 10.4.32 + PHP 8.2.12) —
not a cloud sandbox — since this session runs as Claude Code on the
actual workstation. No separate "real-XAMPP re-run" caveat applies here,
unlike Sprint 0/1/W2's first passes.

## Not yet done (explicitly out of this cut)

- Real basemap tiles (online or offline/MBTiles) for the web LiveMap —
  distinct, undocumented-for-Sprint-1 dependency; the map currently shows
  a flat background + boundary/marker layers only.
- A barangay-metadata endpoint (so `boundary_geojson` can actually reach
  the frontend) — `LiveMap.setBoundary()` exists and is ready for one.
- `POST /dispatch/:id/status` (Tanod/Admin status transitions
  assigned→en_route→arrived→completed) — a separate, unbuilt §6 endpoint;
  W3's active-dispatch cards show status but have no transition UI yet
  beyond Cancel.
- Notification creation on dispatch (Sprint 4, see resolved decisions).
- `POST /tanod-sos`, acknowledge/resolve endpoints (Sprint 4).
- `POST /duty-status` (Tanod toggle, mobile M2/Sprint 2).
- `GET /users` create/edit/reset-password (separate §6 endpoints; only
  list was built, as Tanod-picker plumbing).
- W5–W20 web screens and all mobile screens — untouched.

---

# DEVLOG — Sprint 1 continued: W5/W6/W9/W15/W16/W19 (remaining "Today's cut" items)

## Today's cut

Six items in one session, not the usual one — an explicit user decision
to go through Sprint 1's remaining unchecked boxes in sequence rather
than stop-and-ask per item, since the sprint prompt's own "pick exactly
ONE" convention was flagged to them first and they chose to proceed with
all six: W5 Historical Heatmap, W6 Electronic Blotter List, W9
Statistical Reports (Generate only), W15 Settings/Account, W16 Citizen
Reports Inbox (list only), W19 Public Citizen Report. Each was built,
then validated together against real XAMPP (backend) and a real browser
(frontend) before moving to the next.

Deliberately NOT built this cut (see "Not yet done" below and each
item's own file-level doc comment for why): `GET /reports/export` (S7),
`GET /reports/notifications-summary` (not in Sprint 1's own listed
endpoint set; its data model is S4), `POST /citizen-reports/:id/convert`
(W16 is explicitly "list only"), and the admin-editing-another-user half
of `PATCH /users/:id` (W10, a separate unbuilt screen).

## Scope delivered

**Backend** — `GET /reports/heatmap` (W5), `POST /incidents` web path with
`Idempotency-Key` header support (W6), `POST /auth/change-password` +
`PATCH /users/:id` self-only (W15), `POST /citizen-reports` (public, W19)
+ `GET /citizen-reports` (W16). W9 needed no new endpoint — it's a fuller
presentation of the already-built `GET /reports/summary`.

**Frontend** — `icons.js` (small inline-SVG icon set — this app has no
npm/bundler step, so lucide-react itself isn't an option; see the file's
own doc), `HeatmapMap.js` (a MapLibre `heatmap`-layer component, kept
separate from the shared `LiveMap.js` since §9 reserves that component
for W3/W4's live-tracking maps specifically), 6 new pages
(`historical-heatmap.js`, `blotter-list.js`, `statistical-reports.js`,
`settings.js`, `citizen-reports-inbox.js`, `citizen-report.js`), `AppShell`
nav extended to 8 items total (role-filtered), and `main.js` extended
with a hash-route (`#/citizen-report`) for the one public, session-less
screen.

Also folded in: the Figma-driven `base.css`/markup reskin from earlier in
this session (icon badges throughout, the login page's two-column hero
panel) — see that work's own commit/description; not re-described here.

## Files

- `backend/controllers/ReportsController.php` (MODIFIED, additive) —
  `heatmap()`.
- `backend/controllers/IncidentsController.php` (MODIFIED, additive) —
  `create()` + `mapIncident()`/`validateCoordinates()` helpers.
- `backend/controllers/AuthController.php` (MODIFIED, additive) —
  `changePassword()`.
- `backend/controllers/UsersController.php` (MODIFIED, additive) —
  `update()` (self-only).
- `backend/controllers/CitizenReportsController.php` (NEW) — `submit()`,
  `index()`.
- `backend/routes/reports.php`, `incidents.php`, `auth.php`, `users.php`
  (MODIFIED, additive routes) — `backend/routes/citizen-reports.php` (NEW).
- `backend/scripts/verify-sprint1-remaining.sh` (NEW) — disposable-DB
  end-to-end validation script, same pattern as the four prior verify
  scripts; 34/34 checks passed against real XAMPP.
- `web/src/components/icons.js` (MODIFIED, additive icons: flame,
  fileText, barChart, settings, inbox, megaphone).
- `web/src/components/HeatmapMap.js` (NEW).
- `web/src/components/AppShell.js` (MODIFIED) — nav extended; `ROLE_LABELS`
  generalized beyond admin/PB now that Secretary is a real web user;
  `setFullName()` added to the returned handle (see bug below).
- `web/src/pages/historical-heatmap.js`, `blotter-list.js`,
  `statistical-reports.js`, `settings.js`, `citizen-reports-inbox.js`,
  `citizen-report.js` (all NEW).
- `web/src/api/apiClient.js` (MODIFIED, additive) — `idempotencyKey`
  option on the low-level `request()` helper; `getReportsHeatmap`,
  `createIncident`, `changePassword`, `updateProfile`,
  `submitCitizenReport`, `getCitizenReports`.
- `web/src/main.js` (MODIFIED) — new `PAGE_ROLES` entries; hash-route
  check for `#/citizen-report` before the session-gated `boot()`;
  `renderUnavailable()`'s copy generalized (Secretary now has real
  screens, so the old "only Admin/PB screens exist" text was no longer
  accurate for every non-covered role, just Tanod).

## Resolved decisions not stated in the reference (logged, don't reopen without review)

- **Web-path incident idempotency storage.** §6 requires the
  `Idempotency-Key` header for trusted web incident creation but the only
  existing idempotency column (`incident.client_event_id`) is paired with
  `device_id` in a nullable composite UNIQUE key that doesn't dedupe
  across `device_id IS NULL` rows (NULL ≠ NULL in a unique index) — §5's
  own schema note anticipates exactly this ("nullable composite UNIQUE
  constraints plus transactional checks are used where a partial
  constraint would otherwise be required"). Web creates store the header
  value in `client_event_id` with `device_id` NULL, and a
  lookup-then-insert-inside-one-transaction (mirroring
  `DispatchController::create()`'s own replay pattern) supplies the
  "transactional check" half. Verified in the DB, not just the response:
  a retried create leaves exactly 1 row for that key.
- **No `priority` field on `POST /incidents`.** §6's documented body for
  this endpoint has no `priority` key; the schema already defaults it to
  `'normal'`. Never accepted, rather than inventing an unlisted field.
- **`GET /reports/heatmap`'s `weight`** is always `1` per point (one row
  per incident with known coordinates in range) rather than a
  pre-aggregated grid count — MapLibre's `heatmap` layer (like most GIS
  heatmap renderers) computes visual density itself from overlapping
  weighted points; §6 doesn't describe a grid/cell shape to bin into, and
  "historical coordinates only" reads as "source from `incident.
  latitude/longitude`, never `gps_track`" (that's W4's live-tracking data,
  a different concept).
- **Citizen-report rate limiting** reuses `audit_log` (has `ip_address`,
  `action`, `created_at`) rather than adding a new table —
  `citizen_report` itself has no IP column to key a limiter off of. Every
  *accepted* submission writes an `audit_log` row
  (`action='citizen_report_submitted'`); a 4th submission from the same
  IP inside a rolling 15-minute window gets `429 RATE_LIMITED`. Validation
  failures (bad barangay, empty description) never reach that write, so
  they don't consume quota — verified by testing exactly this sequence,
  not assumed.
- **`citizen_report.confirmation`** is always `null` in the response — no
  SMS/GSM transport exists yet (Sprint 4 dependency), so there is no
  optional confirmation SMS to report the outcome of. Same "don't claim a
  side effect that never happened" precedent as `dispatch.route_status
  ="unavailable"` for the not-yet-built OSRM integration.
- **The four barangays are hardcoded in the public W19 form.** §6 never
  documents a `GET /barangays` (or similar) endpoint anywhere, and §5
  states the four rows are deterministic/fixed — matching
  `migrations/0002_seed_barangays.sql` exactly (Dao=1, Binanuahan=2,
  Marifosque=3, Banuyo=4) is the only way this public, unauthenticated
  screen can offer a barangay choice without inventing a new endpoint
  outside this sprint's scope.
- **`#/citizen-report` hash routing.** This app has no bundler/URL router
  and no server-side rewrite configured for the static `web/` folder —
  rather than requiring a new server path, W19 is reached via a hash
  fragment on the same `index.html`, checked before `main.js`'s normal
  session-gated `boot()`. Hash fragments never reach the server, so this
  works identically under the PHP built-in server, Apache, or any static
  host with zero rewrite configuration. Caveat found during testing (see
  below): this only works on an actual navigation (a fresh tab/reload) —
  a same-tab, hash-only URL change while the app is already loaded is a
  same-document navigation and doesn't re-run `main.js`. That matches
  W19's real-world entry point exactly (someone opens a shared link/QR
  code in a new tab), so it was left as-is rather than adding a
  `hashchange` listener nothing currently needs.
- **`PATCH /users/:id` is self-only this cut.** §6/§7 describe this
  endpoint serving two paths — Admin editing same-barangay others (with a
  role/`is_active`/session-revocation cascade), and self editing only
  `full_name`/`contact_number`. W10 User Management (the admin-editing-
  others screen) isn't one of this sprint's six items and needs its own
  design pass (which fields toggle `is_active`, "at least one active
  Admin must remain," the device/session revocation transaction).
  Building that half now risked getting it wrong; a caller here may only
  ever edit their own row, and any other `user_id` is rejected with `403`
  — verified, not just assumed correct.
- **W9 omits notification reliability.** `GET /reports/notifications-summary`
  isn't in Sprint 1's own listed endpoint set (only `GET /reports/summary`,
  `/heatmap`, and the incidents/dispatch/citizen-reports endpoints are),
  and its data model (`notification`/`notification_target`/
  `notification_delivery`) is Sprint 4 scope — nothing would ever populate
  it yet. Building an endpoint outside this sprint's listed set risked the
  same "jumping ahead of a dependency chain" problem `DispatchController`
  deliberately avoided by not writing bare `notification` rows for
  dispatch creation.

## Bug found and fixed during this session's own testing (not just claimed — here's what a real browser run actually caught)

**The topbar's signed-in-user name went stale after a Settings profile
save.** `AppShell.js` only ever set the topbar `userLabel` text once, from
the `user` object it was constructed with; `apiClient.updateProfile()`
correctly updated `sessionStorage`, but nothing re-rendered the
already-mounted DOM text node from that updated session — so the name in
the top-right corner kept showing the old value until the next full page
navigation happened to reconstruct `AppShell` from a freshly-read
session. Caught by a real Playwright run (not just inspection): the test
changed the profile's `full_name`, then read the topbar text back and
compared it, rather than only checking for the "Profile updated." success
message. Fixed by having `AppShell` return a `setFullName()` handle that
`settings.js` calls right after a successful save — updates the topbar in
place without a full navigation, so the success message on the same page
stays visible too.

Two flaws in the *test script itself* were also found and fixed before
the final run, not application bugs: (1) a Statistical Reports assertion
checked for Title-Case label text (`"Total Incidents"`), but
`page.innerText()` reflects the *rendered* text — the KPI labels sit
inside a `.label` element with CSS `text-transform:uppercase`, so the
visible text is `"TOTAL INCIDENTS"` even though the DOM string isn't;
fixed by matching case-insensitively. (2) the change-password assertion
used a fixed 500ms wait, which was occasionally too short — Argon2id
hashing is deliberately memory-hard/slow, and the combined
hash+session-revocation+audit transaction can take longer than a
plain-UPDATE request; fixed by waiting for the submit button to
re-enable instead of guessing a duration.

A real environment issue was also found and fixed in the test harness
(not the app): earlier throwaway test runs' `pkill -f "php -S ..."`
cleanup silently failed to actually terminate the native Windows `php.exe`
processes spawned from Git Bash, leaving up to five stale dev-server
processes all still bound to port 8080 across runs. Windows apparently
tolerated multiple processes listening on the same address:port here, and
requests got inconsistently routed to whichever process happened to
handle them — including stale ones still holding a since-dropped
disposable database's credentials, which is what produced a real-looking
500 on `/auth/login` in an otherwise-correct test run. Fixed the
throwaway harness's own cleanup to kill by actual port ownership
(`netstat`/`taskkill`) as a fallback, not just by the PID bash thinks it
started.

## Tests performed (with evidence)

1. **PHP lint** (`php -l`) and **JS syntax check** (`node --check`) clean
   on every new/modified file.
2. **`backend/scripts/verify-sprint1-remaining.sh` against the real local
   XAMPP install (MariaDB 10.4.32 + PHP 8.2.12)** — 34/34 checks passed:
   `GET /reports/heatmap` own-barangay count + role gating (Tanod → 403)
   + tenant isolation (barangay-2 admin sees only their own point); `POST
   /incidents` web-path create (Secretary and Admin both → 201, Tanod →
   403) + **idempotent retry returns the same incident_id (verified only
   1 DB row exists for that Idempotency-Key, not just that the response
   looked right)** + missing-header → 400; `GET /incidents` (blotter list,
   no status filter) total count; `GET /reports/summary` PB role-gate
   spot check; `POST /auth/change-password` wrong-current-password → 401,
   weak-new-password → 400, correct change → 200, **current session
   survives the change while a second concurrent session gets revoked
   (verified both directions)**, re-login with the new password works;
   `PATCH /users/:id` self-edit persists to the DB (verified via direct
   SELECT, not just the response) + editing a different user_id → 403;
   `POST /citizen-reports` public (no Authorization header) → 201 with a
   `report_id`, unknown barangay_id → 400, empty description → 400, **4th
   submission from the same IP inside the rate-limit window → 429** (with
   the 3 prior *accepted* submissions actually counted, and the earlier
   *rejected* 400 attempts correctly NOT counted, per the resolved
   decision above); `GET /citizen-reports` inbox total + Tanod role-gate
   (403) + cross-tenant isolation (barangay-2 admin sees 0).
3. **Real browser walkthrough via Playwright (`playwright-core` driving a
   pre-cached local Chromium, throwaway tooling — not committed, same
   precedent as every prior session's own Playwright script)** against
   the real PHP dev server + real static `web/` files, using a fresh
   disposable database (`baranguard_s1rem_browser_check`, dropped after)
   with realistic seed data — 13/13 checks passed after the one real app
   bug above was found and fixed, plus the two test-script flaws and one
   test-harness environment issue also described above: admin login
   reaches the dashboard; the Heatmap page renders an actual MapLibre
   `<canvas>` (not just an empty container) once incidents with
   coordinates exist; the Blotter list shows seeded incidents and a
   newly-submitted entry actually appears after submit (not just that the
   POST returned 201); Statistical Reports' Generate button produces the
   full KPI/breakdown report, not the "choose a range" prompt; the Citizen
   Reports inbox shows the seeded report's real description text; a
   Settings profile save updates the topbar name in place (the bug above)
   and a password change both shows its own success message *and* the new
   password actually works on a fresh login afterward; **a Secretary
   account — the first time this role has ever reached a real screen in
   this web app — lands on Electronic Blotter (not the old "not built
   yet" message) and its sidebar shows exactly Blotter/Citizen
   Reports/Settings, never Dashboard/Dispatch Center/Heatmap/Statistical
   Reports**; the public `#/citizen-report` screen is reachable with zero
   session from a fresh tab and a real submission shows a success
   confirmation with a `#<number>` reference; zero *unexpected*
   console/page errors across the entire run (the only one logged was the
   browser's own automatic `/favicon.ico` 404 — confirmed via the dev
   server's own access log line, not assumed).
4. All test infrastructure (disposable databases, disposable app-users,
   throwaway Playwright scripts/scratch directory, all dev-server
   processes including the stale ones found during debugging) was torn
   down after — the real `baranguard` database and `backend/.env` were
   never touched, same as every prior verify script in this repo.

## Known environment note (same pattern as every prior entry)

All testing above ran directly against this session's real local XAMPP
install (MariaDB 10.4.32 + PHP 8.2.12) — not a cloud sandbox — since this
session runs as Claude Code on the actual workstation. No separate
"real-XAMPP re-run" caveat applies here.

## Not yet done (explicitly out of this cut)

- `GET /reports/export` + audited export (Sprint 7, per Sprint_Prompts.md
  explicitly excluding it from Sprint 1).
- `GET /reports/notifications-summary` and the notification reliability
  section of W9 (Sprint 4 dependency — see resolved decisions).
- `POST /citizen-reports/:id/convert` (W16 was explicitly "list only" this
  cut) — the inbox has no convert action/button yet.
- The admin-editing-another-user half of `PATCH /users/:id`, and the rest
  of W10 User Management generally (create/reset-password too).
- W7, W8, W10–W14, W17, W18, W20 web screens, and all mobile screens —
  still untouched.
- Nothing in this cut, nor the earlier CSS/markup reskin from this same
  session, has been committed yet — both are sitting in the working tree
  pending the user's explicit go-ahead to commit.

---

# DEVLOG — Sprint 1 continued: W11/W12/W13 Scheduler + Swap Requests + Fatigue Flags (Sprint 1's last "Today's cut" box)

## Today's cut

The one remaining Sprint 1 checklist item — "Scheduler + fatigue calc
(optional this sprint per §10)" — built at the user's explicit request to
finish out the rest of Sprint 1. With this, every box in Sprint 1's
"Today's cut" list is done: Auth, W2, W3a/W3b, W4, W5, W6, W9, W15, W16,
W19, and now this.

## Schema conflict found before writing any code (stopped and asked)

§5 originally fixed `shift_schedule.user_id` as `NOT NULL`, but §6's
`PATCH /shift-swap-requests/:id` explicitly documents that an approved
swap request with no named target "leaves the shift unassigned" — a
`NOT NULL` column cannot represent "unassigned" at all. This wasn't a
judgment call to make silently: it changes the schema of an
already-migrated, already-tested table. Presented to the user as a
choice (make the column nullable vs. keep it NOT NULL and deviate from
§6's literal wording); they chose nullable. Resolved via a NEW migration
(`0003_shift_schedule_nullable_user.sql` + its own `.down.sql`), not by
editing the completed `0001_baseline_schema.sql`, per this project's own
convention. Verified directly against `information_schema.COLUMNS` that
the column is actually nullable post-migration, not just assumed from
the migration file's intent.

## Scope delivered

**Backend** — `POST/GET /shifts`, `PATCH /shifts/:id` (W11); `POST/GET
/shift-swap-requests`, `PATCH /shift-swap-requests/:id` (W12); `GET
/shifts/fatigue-flags`, `PATCH /fatigue-flags/:id/acknowledge` (W13). A
shared `FatigueCalculator` service (Section 6: "fatigue recalculated for
affected user" on shift create/edit/reassignment) used by both the
shifts and swap-request controllers.

**Frontend** — three new pages: `scheduler.js` (list + new-shift form +
per-row inline edit, all using the API's own `version` optimistic
concurrency), `swap-requests.js` (Admin approve/deny, since Tanod-side
request creation isn't reachable from this web app — Tanod is mobile-only
and unbuilt), `fatigue-flags.js` (list + acknowledge, PB read-only). Two
new icons (`calendar`, `repeat`, `batteryWarning`). `AppShell`/`main.js`
extended with 3 more nav items/routes.

## Resolved decisions not stated in the reference (logged, don't reopen without review)

- **Fatigue threshold: 56 scheduled hours in a rolling 7-day window**
  (~8h/day average) — §10 explicitly says "Fatigue threshold is a project
  safety rule, not a statutory claim about tanods," i.e. the reference
  deliberately leaves the actual number unstated. A project safety
  default, not a labor-law citation, same spirit as `AuthController`'s
  login-lockout numbers.
- **Fatigue window anchors to the triggering shift's own `end_at`**, not
  "the 7 days ending right now." A scheduler mostly assigns *future*
  shifts — anchoring to "now" would never count a newly-created
  week-from-now shift. Anchoring to the shift's own end_at correctly
  covers both a retrospective edit and a prospective assignment. Full
  reasoning in `FatigueCalculator.php`'s own doc comment.
- **A flag once raised is never deleted or un-raised** by a later
  recalculation that drops back under threshold — only an explicit
  acknowledge touches an existing row (§9 W13's "never deletes or hides
  the historical record," extended to recalculation too). Verified
  directly: after reassigning a fatigued Tanod's flagged shift away from
  them, their fatigue_flag row still exists in the DB, not silently
  removed just because they're no longer over threshold from that shift.
- **`version` added to `GET /shifts`/`POST /shifts` responses** even
  though §6's documented list item shape omits it — a mechanical spec
  gap, not an architectural fork: `version` already exists on the table
  and the very next endpoint in the same section (`PATCH /shifts/:id`)
  cannot function without the client knowing the current value first.
  Fixed without pausing to ask, unlike the `user_id` nullability
  question above, which changed the schema itself. Logged in
  `ShiftsController.php`'s own doc comment too.
- **Shift-swap wire field is `client_request_id`**, not `request_id` —
  §6 is explicit about this name specifically for this endpoint, unlike
  `POST /dispatch`/`POST /shifts` which both use `request_id` in the body
  for their own differently-named columns. Kept as documented rather than
  normalized to match the other two.
- **`barangay_id?` in `POST /shifts`'s body is accepted but ignored** —
  every other write endpoint in this codebase derives tenant strictly
  from the caller's own session; the `?` marking it optional in §6
  doesn't carry license to trust a client-supplied barangay over the
  Admin's own token.
- **Approve-with-no-target releases the shift to unassigned** (`user_id
  = NULL`) rather than leaving the requester's name on a shift they were
  just released from — matches §6's literal wording, made possible by the
  schema change above. No fatigue recalculation is triggered for the
  released user in this path (no new/changed assignment to anchor a flag
  to for someone being removed from one) — their historical flags, if
  any, are untouched.
- **Revalidation on swap-request approval**: if the shift's *current*
  occupant no longer matches `requesting_user_id` (an Admin reassigned it
  via a normal edit after the request was submitted, before it was
  resolved), approval is rejected with `409` rather than silently
  approving a swap for a shift the requester no longer holds — matches
  §9's "revalidate current users, assignment, time overlap, and
  fatigue." Verified with a real interleaved sequence (create request →
  reassign the shift out from under it → attempt approve → 409), not
  just read from the code.
- **Timezone handling for shift times.** §5: "operational shift times
  are interpreted in Asia/Manila." An HTML `datetime-local` input value
  carries no offset of its own — treated as Asia/Manila wall-clock time
  by default and converted to UTC before storage; a DB round-trip value
  (an `update()` field the caller didn't touch) is already a naive UTC
  string, so it's re-parsed with UTC as the default instead — same
  parser (`ShiftsController::parseTimestamp()`), different default
  depending on the value's actual source, per PHP's own
  `DateTimeImmutable` rule that an explicit offset/zone in the string
  always wins over whichever default was passed in. A real gap in the
  first draft (both call sites originally parsed with no explicit
  default at all, which would have silently used PHP's ambient
  `date.timezone` ini setting rather than a value tied to the data's
  actual source) was found and fixed before any test ran against it, not
  after.

## Bugs found and fixed during this session's own testing (not just claimed — here's what real runs actually caught)

**A real app bug:** `scheduler.js`'s new-shift form pane was replaced via
`layout.replaceChild(formPane, layout.children[1] ?? document.createElement('div'))`
on every `load()` call — but on the *first* load, `layout` only had one
child (the list pane), so `layout.children[1]` was `undefined` and the
`??` fallback created a orphan `<div>` that was never actually a child of
`layout`. Calling `replaceChild` with a node that isn't a real child
throws `NotFoundError`, which would have crashed the Scheduler page on
every single visit. Caught by a real Playwright run, not by inspection —
fixed by appending a real placeholder `formPane` alongside the list pane
at construction time and always replacing that same tracked reference on
each load, rather than guessing at `layout.children[1]`.

**A real app bug, caught before it ever reached a browser:** `fatigue-
flags.js` originally called `getUsers({role:'tanod'})` unconditionally to
build a name lookup — but `GET /users` is Admin-only server-side
(`UsersController.php`), and this screen's own role matrix (§9 W13) grants
Punong Barangay read-only access to it. A PB session would have gotten a
403 on that call, and since it was inside the same `Promise.all` as the
actual fatigue-flags fetch, the *entire* page would have failed to render
for a role the reference explicitly says should be able to view it. Found
by re-reading the role matrix against the code before testing, not by a
PB-specific test case — fixed by only requesting the name lookup as
Admin; PB falls back to "Tanod #id" labels instead of a crashed page.

**Three flaws in the test scripts themselves**, not application bugs,
found and fixed before the final passing runs:
1. `verify-scheduler-fatigue.sh` checked a NULL column value with `[ -z
   "$DB_USER" ]` — but `mysql -N -s` prints the literal text `"NULL"` for
   a SQL NULL, not an empty string (confirmed directly, not assumed) —
   fixed to compare against that literal string.
2. The same script asserted a `fatigue_flag` row should exist for a
   Tanod who received a reassigned shift contributing only 10 hours to
   their own 7-day window — but 10 hours is correctly *under* the 56-hour
   threshold, so no flag should exist; the assertion itself encoded a
   wrong expectation, not a wrong implementation. Fixed to assert the
   *absence* of a flag instead, which is the actually-meaningful check
   here (recalculation must not over-flag someone who isn't fatigued).
3. `scheduler-browser-check.js` (Playwright) checked page text for
   `"Unassigned"`/`"Acknowledged"` in mixed case, but both sit inside a
   `.status-pill` element with CSS `text-transform:uppercase` —
   `page.innerText()` reflects the *rendered* text ("UNASSIGNED"), not
   the DOM string. Same class of flaw as a case-sensitivity issue caught
   in the previous session's own Playwright script against Statistical
   Reports' KPI labels — fixed by matching case-insensitively, and worth
   remembering as a recurring category, not just a one-off.

**One real environment/tooling issue, not an application bug:** an
earlier interrupted verification run left one or more stale `php.exe`
processes still bound to a throwaway port from a *previous* run (this
project's recurring `pkill -f` unreliability against Git-Bash-spawned
native Windows processes — see the previous DEVLOG entry's own note on
this). One `verify-scheduler-fatigue.sh` run produced a real-looking
`VALIDATION_ERROR` ("start_at must be before end_at") on a request whose
inputs were independently verified correct in isolation; a second run
against freshly-cleared ports passed the identical step cleanly,
confirming the transient stale-process explanation rather than a logic
bug in the request itself.

## Tests performed (with evidence)

1. **PHP lint** and **JS syntax check** clean on every new/modified file.
2. **`backend/scripts/verify-scheduler-fatigue.sh` against the real
   local XAMPP install (MariaDB 10.4.32 + PHP 8.2.12)** — 42/42 checks
   passed: migration 0003 applied and confirmed nullable via
   `information_schema` (not assumed); `POST /shifts` create + idempotent
   retry (**verified only 1 DB row exists for the request_id, not just
   that the response looked right**) + overlap rejection (409) +
   role-gating (Tanod → 403) + cross-tenant Tanod → 422; `GET /shifts`
   role scoping (Admin sees all barangay shifts, Tanod forced to own);
   `PATCH /shifts/:id` stale-version → 409, correct-version → 200 with
   the new `patrol_zone` verified via direct SELECT, and unassign
   (`user_id:null`) verified as an actual SQL NULL afterward; a real
   fatigue-triggering sequence (48 pre-existing hours + one new 10-hour
   shift = 58h) produces a `fatigue_flag` row keyed to the triggering
   shift with the exact computed `hours_worked_7day` (58.00, verified in
   the DB); `GET /shifts/fatigue-flags` + role gating (Tanod → 403) +
   tenant isolation + `PATCH /fatigue-flags/:id/acknowledge` with the
   flag row confirmed to still exist afterward (never deleted); `POST
   /shift-swap-requests` ownership check (403 for a non-owner) + a named
   target correctly echoed back; approving a request **with** a named
   target actually reassigns the shift in the DB and correctly
   recalculates fatigue for *both* the outgoing and incoming Tanod (the
   incoming one correctly gets *no* flag, since their own total is under
   threshold); the revalidation path (shift reassigned out from under a
   pending request → approval → 409) exercised with a real interleaved
   sequence; version conflict and already-resolved conflict on
   deny/re-approve; `GET /shift-swap-requests` role scoping.
3. **Real browser walkthrough via Playwright** (throwaway tooling, not
   committed) against the real PHP dev server + real static `web/`
   files, disposable database (`baranguard_sched_browser_check`, dropped
   after) — 6/6 checks passed after the two real app bugs above were
   found and fixed, plus the test-script case-sensitivity issue also
   described above: the Scheduler lists real seeded shifts for two
   different Tanods; an inline per-row edit (renaming a patrol zone)
   actually persists and is visible after save without a page reload;
   Swap Requests shows a real requester name and reason; approving a
   no-target request shows "Unassigned — Admin action required" exactly
   per §6's wording; Fatigue Flags shows a real seeded over-threshold
   flag; acknowledging it shows the "Acknowledged" state while the row
   itself stays visible (never disappears). Zero unexpected console/page
   errors (only the browser's own automatic `/favicon.ico` 404).
4. All test infrastructure (disposable databases, disposable app-users,
   throwaway Playwright scripts, all dev-server processes — including
   the stale ones found during debugging) was torn down after — the real
   `baranguard` database and `backend/.env` were never touched.

## Known environment note (same pattern as every prior entry)

All testing above ran directly against this session's real local XAMPP
install (MariaDB 10.4.32 + PHP 8.2.12) — not a cloud sandbox.

## Not yet done (explicitly out of this cut)

- W7, W8, W10, W14, W17, W18, W20 web screens, and all mobile screens —
  still untouched. Sprint 1 itself is now fully complete (every "Today's
  cut" box checked, including the optional one).
- Nothing from this session — this cut, the earlier 6-item cut, or the
  CSS/markup reskin — has been committed yet; all of it is sitting in
  the working tree pending the user's explicit go-ahead to commit.

---

# DEVLOG — Sprint 1 continued: real search/system-health, UI-scale knob,
# Figma pixel-alignment pass, and three production bugs found post-XAMPP

## Today's cut

Not one Sprint-Prompt box — a user-directed sequence of fixes/polish on
top of the already-complete Sprint 1, across several sessions: (1) make
the dashboard's global search and "system operational" badge real instead
of decorative, and remove remaining hardcoded UI data; (2) a CSS density/
responsiveness pass after the user flagged the dashboard as "too big" and
"not responsive"; (3) a full pixel-alignment pass against the actual
Figma Make export (installed and run locally, not inferred from
screenshots) — new shared components, a global UI-scale mechanism, and a
Blotter→DataTable migration extended to every other list-style screen;
(4) three real bugs found only once the app was served through real
Apache/XAMPP rather than PHP's built-in dev server or a cloud sandbox.

## Scope delivered

**Real backend behind previously-decorative UI:**
- `GET /barangays` (public) — `backend/controllers/BarangaysController.php`
  + `routes/barangays.php`. Backs the public citizen-report barangay
  picker with the real seeded table instead of a hardcoded 4-item array.
- `GET /search?q=` (authenticated) — `backend/controllers/SearchController.php`
  + `routes/search.php`. Same tenant/ownership scoping as `GET /incidents`;
  searches incidents by ID/type/status. Backs the topbar's search box,
  which previously had no backing endpoint at all.
- `GET /system/health` — `backend/controllers/SystemHealthController.php`
  + `routes/system.php`. Real `SELECT 1` DB check, real backup-file
  `filemtime()`, and an honest `not_configured` status (derived from
  actual env-var absence) for every dependency not wired up yet
  (OSRM/Ollama/GSM/notification transports) — replaces a hardcoded
  "All Systems Operational" badge, which §8 already forbids as a
  demo/prototype tell.
- `GET /incidents` extended with `officer_name` — a LEFT JOIN to each
  incident's most recent `dispatch` row, resolving the assigned Tanod's
  `full_name`. Required qualifying every `WHERE` column with `i.` (the
  join brings in `dispatch`/`user` columns — `status`, `priority`,
  `barangay_id` — that collide with `incident`'s own, so an unqualified
  column became ambiguous, not just wrong). Added to both the list items
  and `create()`'s response shape (always `null` there — a just-created
  incident has no dispatch yet).

**UI Scale Knob** (`web/src/styles/base.css`): the fix for "the UI is too
big at 100% view, but looks right at 75% zoom." Rather than hand-tuning
individual values (which the project's own density pass earlier had
already found to cause drift/inconsistency), every size token
(`--spacing-*`, `--font-size-*`, `--radius-*`, every component dimension)
was converted from `px` to `rem`, and `html { font-size: 75%; }` became
the single global density control — one line scales the whole app
proportionally, and it's a percentage (not a fixed px) so it still
respects a user's own browser-level accessibility font-size preference.
1px borders and `50%`/`999px` shape radii were deliberately left
unscaled; media-query breakpoints stay in `px` since they test real
viewport pixels, not the scaled root.

**Shared components added** (Figma-alignment, co-located `.js`+`.css`
per file, all explicitly `<link>`ed in `web/index.html` — no bundler):
- `PageHeader.js`/`.css` — white full-bleed title bar (24px title + 14px
  subtitle + a right-aligned actions slot), mounted in a new `header`
  slot `AppShell` now returns (between the topbar and the scrolling
  content area) so it stays fixed while content scrolls. Replaces the
  old per-page pattern of an inline-styled `<h2>` written straight into
  the content area, which produced a different header treatment on every
  screen and ate ~140px of vertical space before any data appeared.
- `DataTable.js`/`.css` — a real `<table>` (not divs), ~44px rows against
  the old stacked-card pattern's ~90px — roughly half the information
  density, and the main reason the UI read as oversized regardless of
  font size. `scope="col"` headers, keyboard-operable clickable rows,
  wraps itself in its own horizontally-scrollable container.
- `StatStrip.js`/`.css` — inline "12 · 3 · 2"-style count row for a page
  header's actions slot; values are always caller-computed real counts,
  never invented.
- `Avatar.js`/`.css` extracted to its own file (was inline in AppShell).
- `AppShell.css`, `DonutChart.css`, `LiveMap.css`, `KpiCard.css`,
  `TrendChart.css`, `dispatch-center.css`, `gis-live-tracking.css`,
  `login.css` split out of the old monolithic `base.css` into
  co-located files as part of the same pass.
- `icons.js` — `svg()` helper switched from `px` to `rem` sizing (so
  icons scale with the root knob too) and 8 new icons added
  (`x`, `menu`, `search`, `chevronDown`, `eye`, `plus`, `download`,
  `mapPin`).

**Every AppShell page migrated to `PageHeader`**: `admin-dashboard.js`,
`dispatch-center.js`, `gis-live-tracking.js`, `statistical-reports.js`,
`citizen-reports-inbox.js`, `blotter-list.js`, `scheduler.js`,
`swap-requests.js`, `fatigue-flags.js`, `settings.js`. `login.js` and
the public `citizen-report.js` are unauthenticated, use no `AppShell`,
and already had their own hero/card layout from the earlier Figma
markup reskin — left as-is.

**Card lists migrated to `DataTable`**: `blotter-list.js` (ID/Type/
Officer/Location/Date/Status — Location as raw lat,lng per an explicit
decision below), `citizen-reports-inbox.js` (ID/Description/Contact/
Submitted/Status), `swap-requests.js` (Requester/Shift/Target/Status/
Actions, with Approve/Deny buttons in the Actions cell), `fatigue-flags.js`
(Tanod/Hours/Flagged/Status, Acknowledge button folded into the Status
cell). `dispatch-center.js`'s queue cards and `scheduler.js`'s
edit-in-place rows were deliberately **not** migrated — see decisions
below.

**Dispatch Center** additionally got a `StatStrip` in its `PageHeader`
actions slot (Pending / Active / Critical / SOS — all real counts,
recomputed on every load/poll, not static).

**`statistical-reports.js`** had its own duplicate inline `kpiTile()`
helper replaced with the shared `KpiCard` component (same icons/accents
as the Dashboard) — same data, less duplicated markup code.

## Resolved decisions not stated in the reference (logged, don't reopen without review)

- **Blotter table's location column shows raw coordinates**, not a
  reverse-geocoded address — `incident` stores lat/lng only, and adding
  reverse geocoding means a new backend dependency this offline-first
  system doesn't currently have wired up. Confirmed with the user rather
  than guessed (asked: raw coordinates vs. reverse-geocoded address vs.
  coordinates-as-a-map-link; raw coordinates was chosen).
- **Blotter table's Officer column was confirmed in-scope**, not skipped
  — the user explicitly asked for it over leaving the column out, which
  is what justified the `GET /incidents` backend extension above rather
  than treating it as unlisted scope creep.
- **`officer_name` is the incident's most recent dispatch's Tanod, any
  status including cancelled** — an incident that was dispatched then
  cancelled still meaningfully "had an officer handle it" for blotter
  purposes; a never-dispatched incident correctly shows none.
- **Scheduler's list was not migrated to `DataTable`.** Its per-row
  inline edit (click a row → swap its content for a live edit form, using
  the shift's own `version` for optimistic concurrency) doesn't map
  cleanly onto `DataTable`'s static `renderCell` model without a larger,
  riskier rework of a screen that already works correctly. Left as
  compact cards; flagged as remaining work rather than silently skipped.
- **Dispatch Center's queue cards were not migrated to `DataTable`**
  either — each card carries a live Tanod-picker `<select>` + Assign
  button (pending) or a Cancel button (active), which reads more like the
  Figma reference's own queue-card pattern than a table row; only the
  page's header/stat-strip were migrated.
- **`html, body { overflow: hidden; }` added**, with `#app` matching —
  `height: 100%` alone sets a box's size but doesn't clip a taller child,
  so any page whose stacked content was even slightly taller than the
  viewport pushed `body` past 100vh, producing an outer page-level
  scrollbar *in addition to* `.page-content`'s own intended
  `overflow: auto` region. `.page-content` is now the only scroll region
  on any page. Same root cause, applied at the document level, as the
  next bug.
- **`.sidebar` got `min-height: 0`, `.sidebar__nav` got `flex: 1` +
  `overflow-x: hidden`.** Without `min-height: 0`, `.sidebar` had no
  height ceiling of its own and just grew to fit its content, pushing the
  page taller than the viewport instead of letting `.sidebar__nav`'s own
  `overflow-y: auto` do the scrolling. Separately, setting only
  `overflow-y` (with no explicit `overflow-x`) forces the browser to
  compute `overflow-x` as `auto` too per the CSS spec — that's what was
  producing the sidebar's horizontal scrollbar with no visible horizontal
  overflow cause.

## Bugs found and fixed (real, found only against real Apache/XAMPP —
## not caught by the PHP built-in dev server every verify-*.sh script uses)

1. **`DB_HOST` intermittent 500s under real concurrent load.**
   `putenv()`/`getenv()` operate on the single OS-level process
   environment table, shared across every thread of one Apache worker
   process under `mpm_winnt` (150 threads/process on this XAMPP install)
   — neither call is documented thread-safe. Concurrent requests calling
   `baranguard_load_env()` raced on that shared table and intermittently
   produced "Missing required environment variable: DB_HOST" even though
   the value was correctly in `.env` — caught via the real Apache error
   log, not a hunch (an earlier session had wrongly dismissed the same
   symptom as transient). Fixed by rewriting `backend/config/env.php` to
   populate only `$_ENV`/`$_SERVER` (per-request-safe PHP superglobals,
   not shared OS state) and never call `putenv()`; added a
   `baranguard_env()` helper every consumer (`config/db.php`,
   `controllers/AuthController.php`, `middleware/AuthMiddleware.php`,
   `public/index.php`, `controllers/SystemHealthController.php`) now
   calls instead of raw `getenv()`. Verified: `php -l` clean on all 6
   files; `grep -rn "getenv("` confirms no remaining raw consumer call
   site (only the helper's own internal fallback).
2. **Every authenticated request 401'd under real Apache
   ("Missing or malformed Authorization header") despite a correct
   token.** Apache/mod_php doesn't forward the `Authorization` header
   into `$_SERVER['HTTP_AUTHORIZATION']` by default — unlike PHP's
   built-in dev server, which every `backend/scripts/verify-*.sh` script
   uses, so this never surfaced in any of those runs. Fixed with a
   `RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]` line
   in `backend/public/.htaccess`, ahead of the existing front-controller
   rewrite.
3. **A prior session's `sidebar__nav` scrollbar fix was only half-done**
   (see decisions above) — actually two separate bugs, not one; both
   needed fixing, not just the one that happened to be diagnosed first.

## Tests performed (with evidence — and what was **not** verified this session)

1. `php -l` clean on every modified/new PHP file
   (`IncidentsController.php`, `SystemHealthController.php`,
   `BarangaysController.php`, `SearchController.php`, `config/env.php`,
   `config/db.php`, `controllers/AuthController.php`,
   `middleware/AuthMiddleware.php`, `public/index.php`).
2. `node --check` clean on every modified/new JS file (all 9 migrated
   page files, `DataTable.js`, `PageHeader.js`, `StatStrip.js`,
   `apiClient.js`, `icons.js`).
3. **The scrollbar and `overflow:hidden` fixes were verified live**,
   against the real served app at `http://localhost/baranguard/` (Apache/
   XAMPP, not a dev server) — fetched `base.css` directly with
   `cache: 'no-store'` to confirm the fix was actually served (not just
   present on disk), then read `document.documentElement.scrollHeight`
   vs. `window.innerHeight` via the live page's own computed styles: they
   matched exactly (720/720) with `overflow: hidden` computed on both
   `html` and `body` — zero document-level overflow.
4. **The `DataTable`/`PageHeader`/`StatStrip` migrations (admin-dashboard,
   dispatch-center, gis-live-tracking, statistical-reports,
   citizen-reports-inbox, blotter-list, scheduler, swap-requests,
   fatigue-flags, settings) were NOT verified in a real logged-in browser
   session this pass** — no test-admin credentials were available to this
   session (the real `baranguard` database's Admin was bootstrapped
   interactively by the user in Sprint 0, and the password is
   correctly never stored anywhere). Verification here is code-level
   only: syntax checks above, and manual re-reading of each `renderCell`
   against the exact fields `apiClient.js` returns. The user was asked to
   spot-check the rendered pages manually rather than this session
   building throwaway seed data + a disposable test admin for a pure
   styling pass — flagged explicitly here rather than claimed tested.
5. `GET /incidents`'s new `officer_name` join was checked by inspection
   (qualified `WHERE` columns against the join's added tables) and
   reasoned through for the ambiguous-column failure mode it fixes, but
   **not executed against a live database this session** — same
   credentials gap as above. Should be spot-checked against a real
   incident with a cancelled-then-reassigned dispatch history before
   being trusted at UAT time.

## Not yet done (explicitly out of this pass)

- Dashboard (W2) still doesn't have a "Recent Incidents" or "Tanods On
  Duty" panel, or KPI period-over-period deltas, or a real axis-labeled
  line chart — all discussed as Figma-alignment "Phase 1" targets but
  deliberately deferred: the KPI-delta and Recent-Incidents panels need
  new backend fields/joins nobody has explicitly approved yet, and
  inventing that scope silently was exactly the kind of unlisted-field
  addition this project's own rules warn against.
- Scheduler's shift list and Dispatch Center's queue cards remain
  card-based, not `DataTable` — see decisions above for why.
- `GET /reports/export`, `GET /reports/notifications-summary`, W7/W8/W10/
  W14/W17/W18/W20, all mobile screens — unchanged from the prior entry's
  "not yet done" list.
- The docs reorganization (11 old fragmented `docs/*.md` files deleted, 2
  new consolidated ones added) remains deliberately uncommitted per the
  user's own earlier instruction — untouched by this pass, not part of
  the commit this entry describes.

---

# DEVLOG — Post-Sprint-1 continued: officer_name/UI-migration verification,
# docs consolidation committed, Dashboard "Phase 1"

## Today's cut

Three follow-ups the user explicitly directed, in order: (1) verify the
previous entry's two unverified claims (`officer_name` join, the
PageHeader/DataTable/StatStrip page migrations) with real evidence
instead of leaving them flagged as untested; (2) review and commit the
docs reorganization that had been sitting uncommitted on purpose; (3)
build the deferred Dashboard "Phase 1" — Recent Incidents panel, Tanods
On Duty panel, KPI period-over-period deltas.

## 1. Verification of the previous entry's two flagged-unverified items

Built a disposable-DB + disposable-app-user + PHP-dev-server rig (same
non-destructive pattern as `backend/scripts/verify-*.sh`, kept in the
session's own scratch directory rather than committed — this was a
one-off check, not a persisted regression script) and drove it two ways:
direct `curl` calls for the API-level claim, and the in-app Browser tool
logged in as a throwaway admin for the UI-level claim.

**officer_name join** — seeded one incident with two dispatch rows (an
older one to "Juan Dela Cruz," both later marked `cancelled`, then a
newer one to "Maria Santos," also `cancelled`), one incident with a
single active dispatch, and one incident never dispatched. `GET
/incidents` returned `officer_name: "Maria Santos"` for the first
(proving "most recent by dispatched_at, any status including cancelled"
— not just "most recent active"), `"Juan Dela Cruz"` for the second, and
`null` for the third. All three matched the documented behavior exactly.

**UI migrations** — logged in as the throwaway admin and clicked through
all 10 migrated screens (Dashboard, Dispatch Center, GIS Live Tracking,
Blotter, Statistical Reports, Citizen Reports Inbox, Scheduler, Swap
Requests, Fatigue Flags, Settings) with realistic seeded data (incidents,
shifts, a pending swap request, an unacknowledged fatigue flag, an
unconverted citizen report). Zero console errors on any screen. Notable:
Blotter's `DataTable` visually showed the exact officer_name results from
the join test above; Dispatch Center's `StatStrip` read "2 Pending · 1
Active · 0 Critical · 0 SOS," matching the seed data exactly; Fatigue
Flags' Acknowledge button was actually clicked (not just screenshotted)
and the row flipped to "Acknowledged" while staying visible — a real
end-to-end interaction, not just a render check.

One transparency note: the rig's first attempt used `php -S` without
`-d variables_order=EGPCS`. This XAMPP install's php.ini ships
`variables_order=GPCS` (no `E`), so `$_ENV` never picked up the
disposable-DB credentials this rig exported via the shell — and since
`config/env.php`'s `baranguard_load_env()` only skips loading the real
`backend/.env` when `$_ENV`/`$_SERVER` already has the key, it silently
fell through and loaded the real `backend/.env`, pointing the throwaway
server at the real `baranguard` database for two login attempts before
this was caught. Both attempts used a username (`ui_admin`) that doesn't
exist in the real database, so `AuthController::recordFailure()` took its
`$user === false` path — one harmless `login_failure` audit_log row
written (user_id/barangay_id both null), no real user or data touched.
Fixed by adding `-d variables_order=EGPCS` to the rig's `php -S`
invocation; not an application bug, purely a test-harness one, disclosed
here for the same reason every other bug in this log is.

## 2. Docs reorganization — reviewed, then committed

Read every old file's line count and section headers, then confirmed
each subject area maps onto a specific section of the new
`Baranguard_Master_Reference_FINAL .md` (§1-3 stack/architecture/roles,
§4 naming, §5 schema, §6 API, §7 roles, §9 screens, §10 backlog, §12-14
prompt library/checklists/integrity note) with `docs/DEVLOG.md` (91
lines, stale duplicate) correctly superseded by this file
(`backend/DEVLOG.md`, the one CLAUDE.md actually imports and the one
every session has been appending to). No content gaps found. Committed
as a separate commit from the code-only push (per the user's own
"redo/re-verify before committing, not as-is" instruction — this
required their explicit go-ahead, given after the review, not assumed).

## 3. Dashboard "Phase 1" — Recent Incidents, Tanods On Duty, KPI deltas

The prior entry flagged this as needing new backend fields/joins "nobody
had approved yet." On actually designing it, that turned out to be
wrong for all three pieces — every one is buildable from endpoints that
already exist, so nothing new was added to the API surface:

- **Recent Incidents panel**: `GET /incidents?limit=6` (already
  default-sorted `created_at DESC`, already tenant/role-scoped) rendered
  through the shared `DataTable` component (ID/Type/Status/Date).
- **Tanods On Duty panel**: `GET /duty-status?barangay_id=` (already
  returns one row per active Tanod's *current* status —
  `DutyStatusController::currentByBarangay()`, not raw history) joined
  client-side to `GET /users?role=tanod` for names — same pattern
  `dispatch-center.js` already uses for its Tanod picker.
  Deliberately has no delta ("vs previous period" doesn't mean anything
  for a live current-state snapshot, same reasoning already applied to
  the existing "Tanods On Duty" KPI card).
- **KPI deltas**: computed by calling the *existing* `GET
  /reports/summary` a second time, for the immediately-preceding period
  of equal length to whatever range is currently selected (e.g. a 10-day
  selection compares against the 10 days immediately before it), then
  subtracting client-side. Only added to Total Incidents and Resolved —
  Avg. Response Time's null-handling and Tanods On Duty's snapshot nature
  both make a delta either awkward or meaningless for those two, so
  neither got one.

All three are wired as best-effort follow-up fetches *after* the core
KPI/trend/breakdown data has already rendered (`loadDeltas`/
`loadRecentIncidents`/`loadTanodsOnDuty`, each in their own try/catch) —
a slow or failed previous-period/roster/recent-incidents call degrades
that one panel to a "could not load" note, it never blocks or blanks the
rest of the dashboard.

## Files

- `web/src/components/KpiCard.js` (MODIFIED, additive) — new optional
  `delta`/`deltaLabel` props; renders a small "+2 vs previous period"
  line under the value. Deliberately no green/red coloring — a KPI like
  Total Incidents going up isn't inherently good or bad, so the delta
  stays neutral-toned rather than encoding a value judgment the data
  doesn't support.
- `web/src/components/KpiCard.css` (MODIFIED, additive) — `.kpi-card__delta`.
- `web/src/pages/admin-dashboard.js` (MODIFIED) — `previousPeriodRange()`
  helper, `loadDeltas()`/`loadRecentIncidents()`/`loadTanodsOnDuty()`,
  two new panel renderers (`renderRecentIncidentsTable`,
  `renderTanodsOnDutyList`) in a new `.two-col-grid` row under the
  existing By-Status/By-Incident-Type row.

## Tests performed (with evidence)

1. `node --check` clean on `admin-dashboard.js` and `KpiCard.js`.
2. **Live browser verification** against the same disposable-DB rig from
   part 1 above (fresh reseed): KPI cards read "Total Incidents 5 (+5 vs
   previous period)" and "Resolved 2 (+2 vs previous period)" — correct,
   since the seeded previous period had zero incidents, so the delta
   equals the full current-period count, not a coincidental match.
   Recent Incidents table showed all 5 seeded incidents, newest first,
   with real type/status/date per row. Tanods On Duty showed "Juan Dela
   Cruz — ON DUTY," matching the one seeded `duty_status` row. Zero
   console errors. Disposable DB, app-user, and both dev servers torn
   down afterward — the real `baranguard` database and `backend/.env`
   were not touched by this second rig run (only the earlier verification
   pass's variables_order bug touched the real DB, see part 1, and only
   with one harmless audit row).

## Not yet done (explicitly out of this cut)

- Avg. Response Time and (deliberately) Tanods On Duty still have no
  delta — see reasoning above.
- W7, W8, W10, W14, W17, W18, W20 web screens, all mobile screens,
  `GET /reports/export`, `GET /reports/notifications-summary` — all
  unchanged from prior entries.

---

# DEVLOG — Scheduler + Dispatch Center migrated to DataTable (the two
# screens the prior "Figma pixel-alignment pass" entry deliberately
# skipped as riskier)

## Today's cut

The one item the "Figma pixel-alignment pass" entry explicitly deferred:
migrate Scheduler's shift list and Dispatch Center's Pending/Active queue
lists from stacked cards to the shared `DataTable` component too, at the
user's explicit direction to go back and finish it. Both were skipped in
that earlier pass specifically because they carry live inline-edit/action
UX (per-row edit-in-place for Scheduler, a Tanod-picker + Assign or a
Cancel button per row for Dispatch Center) that doesn't map onto
`DataTable`'s plain `renderCell(row, columnKey)` contract as cleanly as a
read-only list does.

## Resolved decisions (logged, don't reopen without review)

- **Scheduler's per-row edit state lives in the page, not in
  `DataTable`.** `DataTable` itself gained no new API — no per-row
  "editing" concept, no new prop. Instead `scheduler.js` keeps an
  `editingShiftId` variable in its own closure; "Edit" sets it and
  re-renders the *same* in-memory `shifts`/`tanods` arrays (no refetch),
  "Cancel" clears it and re-renders, and a successful "Save" triggers a
  real `load()` (full refetch, which also naturally resets
  `editingShiftId` to `null`). This keeps `DataTable` a dumb, reusable
  renderer rather than growing it a stateful-row mode that only this one
  screen would ever use.
- **A single row's edit-mode input elements are built once and shared
  across that row's cells via a closure variable
  (`editFields`), populated on the first cell `DataTable` asks for
  (`tanod`, since that's first in `SCHEDULE_COLUMNS`) and read back by
  the later cells in the same row (`zone`, `timeRange`, `actions`).**
  This relies on `DataTable.js`'s existing column-iteration order being
  stable and predictable (it always renders columns in exactly the array
  order passed in) — true today and not something this change needed to
  modify, just something worth documenting since a future edit to
  `DataTable.js`'s iteration order would silently break this.
- **Save/Cancel failures now use `alert()`, not an inline error box.**
  The original card-based edit form had its own `errorBox` div. Dropped
  in favor of `alert()`, matching the pattern every other DataTable
  migration this session already established for row-level actions
  (Swap Requests' Approve/Deny, Fatigue Flags' Acknowledge) — one
  consistent failure-affordance across every table-row action in the
  app, rather than a bespoke inline box for just this one screen.
- **Dispatch Center's priority signal moved from a card-level colored
  dot (`.dispatch-card--critical`/`--high`'s `::before` accent on the
  incident-type text) to the dedicated Priority column's pill color.**
  Same information, now in an actual column instead of a decorative
  pseudo-element attached to a different field — arguably clearer (a
  labeled "HIGH"/"CRITICAL" pill beats an unlabeled colored dot), and
  nothing was dropped to make room for it.
- **Active Dispatches' Tanod column still shows `Tanod #<id>`, not a
  resolved name.** The original card version never resolved this to a
  name either (Dispatch Center's `eligibleTanods` list only contains
  *currently on-duty* Tanods, and an active dispatch's Tanod may no
  longer be on duty by the time the page re-renders) — preserved exactly
  as-is rather than silently changing behavior while migrating the
  markup.

## Files

- `web/src/pages/scheduler.js` (MODIFIED) — `renderList()` now builds a
  `DataTable` (Tanod/Patrol Zone/Time Range/Actions columns) instead of a
  `.stack` of cards; `buildEditFields()`/`buildEditActions()` replace the
  old `buildEditForm()`; `renderShiftRow()`/`toDatetimeLocal`'s old
  direct-DOM-swap `Edit` handler is gone, replaced by the
  `editingShiftId`/`startEdit`/`cancelEdit` closure state described
  above. `escapeHtml()` no longer needed — `DataTable`'s renderCell
  returns text-node-bearing `<span>` elements for name/zone instead of
  interpolated HTML strings.
- `web/src/pages/dispatch-center.js` (MODIFIED) — `renderPendingCard()`/
  `renderActiveCard()` (per-item card builders) replaced by
  `renderPendingIncidentsTable()`/`renderActiveDispatchesTable()` (each
  builds one `DataTable` for the whole list) plus
  `renderAssignCell()`/`renderCancelCell()` for the per-row action cells.
  Added `PRIORITY_PILL_CLASS` mapping (normal→neutral, high→pending/
  orange, critical→critical/red).

## Tests performed (with evidence)

1. `node --check` clean on both files.
2. **Live browser verification**, disposable-DB rig (same one from the
   prior two entries, fresh reseed), real interactions — not just
   screenshots:
   - **Dispatch Center Assign**: clicked "Assign" on the seeded "Theft"
     pending incident with "Juan Dela Cruz" selected in the row's Tanod
     picker. `StatStrip` updated from "2 Pending · 1 Active" to
     "1 Pending · 2 Active" live, the incident disappeared from Pending
     Incidents, and a new row appeared in Active Dispatches
     ("#4 · Incident #1", "Tanod #4", "ASSIGNED", "Route unavailable") —
     a real `POST /dispatch` round-trip through the new `Assign` cell.
   - **Dispatch Center Cancel**: the button's own `confirm()` dialog is
     auto-dismissed (returns `false`) by this browser-automation
     environment by default — first click correctly did *nothing*
     (verified via `read_network_requests`: zero requests fired),
     proving the existing "cancel requires confirmation" guard still
     works, not a new bug. Overrode `window.confirm` to return `true` via
     the dev-tools JS console *only* to get past that automation
     limitation, then re-clicked the same button: `StatStrip` went back
     to "2 Pending · 1 Active," the dispatch disappeared from Active
     Dispatches, and the Theft incident reappeared in Pending Incidents —
     a real `PATCH /dispatch/:id/cancel` round-trip through the new
     `Cancel` cell.
   - **Scheduler inline edit**: clicked "Edit" on the seeded "Juan Dela
     Cruz / Zone A" shift — row correctly swapped to a Tanod `<select>`,
     Patrol Zone `<input>`, and two `datetime-local` inputs, all
     pre-filled with the shift's real current values, while the *other*
     row (Maria Santos) stayed in view mode — confirming per-row edit
     state doesn't leak across rows. Changed the Patrol Zone field to
     "Zone A-Verified" and clicked Save: the row exited edit mode, and
     the table's next full reload (a real `GET /shifts` call, not an
     optimistic local patch) showed "Zone A-Verified" — proving the save
     actually persisted server-side, not just updated in memory.
   - Zero console errors across all three flows.
3. Disposable database, app-user, and both throwaway dev servers torn
   down afterward — the real `baranguard` database and `backend/.env`
   were not touched by this pass.

## Not yet done (explicitly out of this cut)

- W7, W8, W10, W14, W17, W18, W20 web screens, all mobile screens,
  `GET /reports/export`, `GET /reports/notifications-summary` — all
  unchanged from prior entries. Every screen originally flagged for a
  `DataTable`/`PageHeader` migration is now migrated; no further screens
  are queued for this specific pass.

---

# DEVLOG — Sprint 2 (Mobile): scaffold + local schema
# (incident_local / mobile_device_local / offline_map_package_local)

## Today's cut

Sprint 2's **"Local schema: incident_local + mobile_device_local +
offline_map_package_local"** box, plus the Ionic/Capacitor scaffold that
box necessarily sits on (the `/mobile` folder was a bare placeholder —
README + empty `src/` — so there was nothing to build into). Scaffolding
is prerequisite plumbing, not a second box, same precedent as W2's login
page in Sprint 1.

Explicitly NOT built: M1/M2/M3/M4 screens, and
`evidence_attachment_local` (Sprint 2's own menu defers it unless the
same cut ships photo/voice capture — it doesn't).

## Decisions required before coding, now resolved

1. **Ionic flavor: React.** §1 said only "Ionic 8.8.5 + Capacitor 8.0",
   which left Angular vs React vs Vue undecided — the same class of gap
   as Sprint 1's "PHP or Node serves the API?". Asked rather than
   assumed. **React** chosen: the web dashboard is vanilla JS built from
   plain functions returning DOM nodes, which maps onto React function
   components far more directly than Angular's modules/DI/RxJS, and
   §14's integrity rule (be able to explain every module) favors the
   smaller conceptual jump. §1 updated to name the flavor.
2. **Ionic 9, not the pinned 8.8.5.** The current Ionic starter generates
   Ionic 9 + React 19 + react-router 6. This was surfaced as a conflict
   with §1's pin rather than silently accepted *or* silently downgraded.
   The user first chose "pin to 8.8.5", then changed to **"use version
   9"** — so the scaffold's Ionic 9 output was kept and §1 was updated to
   `Ionic React 9.0.1 + Capacitor 8.5.1`, with the previous pin and the
   date of the change recorded inline in §1 so a future session doesn't
   "fix" it back.
3. **DB passphrase source: deliberately unresolved, left as a seam.** §5
   requires the local store encrypted at rest but neither §5 nor §6 says
   where the key comes from, and §6 defines no key-provisioning endpoint.
   `localDatabase.ts` exposes a `PassphraseProvider` and **throws** if it
   is not configured, rather than defaulting to a constant — a hardcoded
   key ships inside the APK and would make "encrypted at rest" a demo
   tell (§8). Flagged as must-resolve before M1/M3 persist a real
   `raw_narrative`; candidates noted in the file (device-keystore secret
   generated at registration, or a server-issued per-device secret
   delivered by `POST /devices/register`).

## Scope decisions (logged, don't reopen without review)

- **Only the three tables in the box were created.** `dispatch_local`,
  `gps_track_local`, `duty_status_local`, `offline_queue_local`, and
  `evidence_attachment_local` are all in §5 but belong to later boxes
  (M5/M6 + `/sync/batch` are Sprint 3). Creating them now would mean
  empty tables no code reads and would claim schema coverage this cut
  never tested.
- **Schema is split from the platform edge on purpose.**
  `localSchema.ts` imports nothing from Capacitor — pure SQL strings +
  row types — so the *exact DDL that ships to a device* can be executed
  against a real SQLite engine and asserted against §5 with no device in
  the loop. `localDatabase.ts` holds all Capacitor/SQLCipher wiring. This
  is what makes the verification below real rather than a copy-paste of
  the schema into a test.
- **Migrations are append-only and applied in place** via
  `PRAGMA user_version`, mirroring `backend/migrations/000N_*.sql`.
  Rule 2 forbids drop-and-recreate: it would destroy field captures not
  yet reconciled with the server.
- **`fcm_token_ref` stores a reference, never the raw FCM token** (§5
  "protected at rest"; §6 `POST /devices/register` "Returns no FCM
  token").
- **`offline_map_package_local.package_id` is the server's id**, not a
  device-local autoincrement (§6 map packages returns it), so it is a
  plain `INTEGER PRIMARY KEY` with no AUTOINCREMENT.

## Files

- `mobile/` — Ionic React scaffold (blank starter): `package.json`
  (renamed `ionic-app-base` → `baranguard-mobile`, added a
  `verify.schema` script), `vite.config.ts`, `tsconfig*.json`,
  `index.html`, `src/` starter page, `cypress/`, eslint config.
- `mobile/capacitor.config.ts` (NEW) — `appId: ph.baranguard.tanod`,
  `androidIsEncryption: true` (this is what puts the SQLite plugin into
  SQLCipher mode; without it the plugin silently creates a plaintext
  file). Biometric DB unlock deliberately disabled — not required by
  §5/§6, and a Tanod must be able to capture one-handed in the field.
- `mobile/src/services/db/localSchema.ts` (NEW) — §5 DDL for the three
  tables, two supporting indexes, `LOCAL_SCHEMA_VERSION`, row types.
- `mobile/src/services/db/localDatabase.ts` (NEW) — encrypted open +
  `PRAGMA user_version` migration runner + close.
- `mobile/scripts/verify-local-schema.mjs` (NEW) — the verification
  harness described below; kept in-repo as a repeatable regression check,
  same precedent as `backend/scripts/verify-*.sh`.
- `mobile/README.md` (REWRITTEN) — real installed versions, commands,
  and an explicit "not done yet" list.
- `docs/Baranguard_Master_Reference_FINAL .md` (MODIFIED) — §1 mobile row
  updated per decisions 1 and 2 above.

## Tests performed (with evidence)

1. **`npm run verify.schema` — 47/47 checks passed.** Executes the REAL
   migration statements (imported from `localSchema.ts`, not duplicated)
   against a real SQLite engine via Node 24's built-in `node:sqlite`,
   in-memory, no device and no network. Asserts: all migrations execute;
   `user_version` ends at 1; exactly the three expected tables exist;
   every column of all three tables matches §5 for name/type/nullability/
   default/primary-key (31 individual column assertions); the
   `client_event_id` UNIQUE constraint **actually rejects** a duplicate
   insert (not just that it's declared); every declared default really
   applies on insert; and re-running the migrations is a no-op that
   leaves existing rows intact (Rule 2).
2. **`npm run build` — exit 0.** `tsc && vite build` compiles the whole
   app including both new modules, so `localDatabase.ts`'s Capacitor/
   plugin API usage at least type-checks against the installed
   `@capacitor-community/sqlite` 8.1.1 typings.

## NOT verified this session (stated plainly, not glossed over)

- **SQLCipher encryption-at-rest was not verified.** Sprint 2's own
  prompt demands "encrypted store actually encrypted — verify, don't
  assume." This machine has **no Android SDK, no Android Studio, no
  adb** (checked: `ANDROID_HOME`/`ANDROID_SDK_ROOT` unset, no SDK
  directory, `adb` not found), so no APK could be built and no database
  file could be pulled off a device and inspected. This is a workstation
  task: install the Android SDK, `npx cap add android && npx cap sync`,
  run on a device/emulator, then confirm the DB file is not readable as
  plaintext SQLite.
- **Nothing in `localDatabase.ts` was executed.** It type-checks; it has
  never run. Every runtime claim about it (secret storage, connection
  mode `'secret'`, transaction/rollback behaviour) is unverified.
- **The Android platform was not added.** `npx cap add android` was
  deliberately skipped rather than committing a native project that
  cannot be built or tested here. `mobile/android/` is already
  gitignored, so adding it later changes nothing tracked.

## Environment notes

- `npm`/`npx` shell wrappers fail under Git Bash on this machine
  ("Could not determine Node.js install directory" — the space in
  `C:\Program Files\nodejs`). Workaround used throughout: invoke the CLI
  JS directly, `node "/c/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" …`.
- The network dropped repeatedly mid-install (`ENETUNREACH`, then a
  10-minute hang). The scaffold had to be restarted and `npm install`
  resumed in the background before it completed. Node's own
  `node:sqlite` was used for verification partly because it adds no
  dependency to fetch.
- Scratch paths under the session temp directory exceeded Windows'
  working-directory length limit, so scaffolding had to happen inside the
  repo rather than a temp folder.

## Not yet done (explicitly out of this cut)

- M1 Login (needs `POST /devices/register`, `PATCH /devices/:id/deactivate`,
  `GET /map-packages/:barangay_id`, `GET /map-packages/:barangay_id/download`
  — all documented in §6, none built yet on the PHP side).
- M2/M3/M4 screens; `POST /duty-status`; the §8 open question of whether
  "Log Incident" or "Schedule" takes the persistent bottom-nav slot
  (still unresolved — must be decided before M3/M8 nav is wired).
- The remaining §5 local tables, and `apiService.ts` (the single mobile
  API boundary named in §4) — no mobile screen calls the server yet.

---

# DEVLOG — Sprint 2 backend: device lifecycle + map packages
# (M1's prerequisites), plus a real env-loading regression fix

## Today's cut

Continuing Sprint 2 at the user's explicit direction to work the agreed
order "until M4" rather than stopping after one box — same documented
exception as Sprint 1's multi-box sessions. This entry covers the backend
prerequisites M1 Login cannot exist without: `POST /devices/register`,
`PATCH /devices/:id/deactivate`, `GET /map-packages/:barangay_id`, and
`GET /map-packages/:barangay_id/download`.

## REGRESSION FOUND AND FIXED — introduced by this session's own earlier
## env.php change (commit d38f524), with a live-data risk

The `$_ENV`/`$_SERVER` thread-safety rewrite made `baranguard_load_env()`
skip the `.env` file only when `isset($_ENV[$name]) || isset($_SERVER[$name])`.
Under **PHP's built-in server (cli-server SAPI) — which every
`backend/scripts/verify-*.sh` uses** — a shell-exported variable reaches
`getenv()` but **neither** superglobal. Verified empirically with a probe
served through `php -S`: `$_ENV` NULL, `$_SERVER` NULL, `getenv()` correct.
(Plain `php -r` behaves differently — `$_SERVER` *is* populated there —
which is exactly why this was easy to miss.)

Consequence: every verify script's `export DB_NAME=<disposable>` was
silently discarded, `.env` won, and the test API server pointed at the
**real `baranguard` database**. Scripts like `verify-sprint1-remaining.sh`
POST incidents and citizen reports — those writes would have landed in
real data.

Fixed in `backend/config/env.php` by adding `getenv($name) !== false` to
the skip condition, restoring the precedence that file's own doc comment
already promised ("never overrides an already-set env var"). Reading
`getenv()` reintroduces none of the original hazard: that was about
`putenv()` *writes* to the shared process environment, and nothing calls
`putenv()` any more. Proven after the fix: with `DB_NAME=disposable_test_db`
exported, a `php -S` request resolved `DB_NAME` to `disposable_test_db`
while `.env` said `baranguard`.

The new verify script deliberately does **not** pass
`-d variables_order=EGPCS`, so it depends on this fix and will fail its
very first login if the fix is ever reverted — an intentional canary.

## Scope decisions (logged, don't reopen without review)

- **`POST /map-packages` (Admin upload) was NOT built.** It needs
  multipart upload + MBTiles structure validation + atomic publish, has no
  §9 web screen consuming it, and M1 only ever *reads* packages.
  Consequence stated rather than hidden: on a fresh install both
  map-package endpoints legitimately 404 until rows are created
  out-of-band. Tracked on the Sprint 2 checklist.
- **`POST /duty-status` not built** — it belongs to M2, which the agreed
  order puts last (its SOS half is Sprint-4-blocked anyway).
- **Re-registering the same device by its own owner is an update, not a
  409.** This is the ordinary FCM-token-refresh path; treating it as a
  conflict would strand a Tanod whose token rotated. A device owned by a
  *different* user is 409 — that is §6's "device ownership is validated",
  and silently reassigning would break Rule 13's server-derived SMS
  sender identity.
- **Unknown device and someone-else's device both return 404** — a
  distinct 403 would confirm a guessed device_id exists.
- **`deactivate` is idempotent**, and a repeat writes no second audit row.
- **`download_url` is API-relative**; the server has no reliable
  externally-visible host under Rule 7 (LAN-only), and the client knows
  its own API base.
- **Package files resolve under `MAP_PACKAGE_DIR`** (env, default
  `backend/storage/map-packages`), with `file_path` treated as relative
  and the resolved real path asserted to stay inside that directory.
- **`X-Checksum-SHA256` is served on download** so §6's mandatory
  pre-activation verification needs no second request.
- **`backend/lib/Audit.php` extracted.** `audit()` was already duplicated
  privately in AuthController and CitizenReportsController; these two new
  controllers would have made copies three and four. New code uses the
  shared helper; the two existing controllers were deliberately left
  alone rather than restructured.

## Files

- `backend/config/env.php` (MODIFIED) — the regression fix above.
- `backend/lib/Audit.php` (NEW) — shared `audit_log` writer.
- `backend/controllers/DevicesController.php` (NEW) — `register()`,
  `deactivate()`.
- `backend/controllers/MapPackagesController.php` (NEW) — `show()`,
  `download()`, plus path-containment resolution.
- `backend/routes/devices.php`, `backend/routes/map-packages.php` (NEW).
- `backend/scripts/verify-devices-map-packages.sh` (NEW).

## Tests performed (with evidence)

`php -l` clean on every new/modified file, then
**`backend/scripts/verify-devices-map-packages.sh` against real XAMPP
(MariaDB + PHP 8.2.12) — 53/53 passed**, disposable DB + disposable
app-user + disposable package files + throwaway port, all torn down after:

- Role gating: Admin and Secretary both 403 on device registration;
  Secretary 403 on map metadata; Admin 403 on package *download* but 200
  on metadata (§6 splits these two differently).
- Validation: short device_id, non-`android` platform, missing
  `fcm_token`, and illegal device_id characters all 400.
- Happy path: `{device_id, registered:true}`; **response contains no FCM
  token** and **audit metadata contains no FCM token** (both asserted by
  grepping the actual response/row, per §6 and Rule 17).
- Registering a second device deactivates the first **verified in the
  DB**, not just from the response.
- Token refresh on the same device returns 200, updates `fcm_token`/
  `app_version`, and **does not deactivate itself**.
- Hijack attempt by another Tanod → 409, with the DB confirming the row
  still belongs to the original owner and the attacker's token was never
  written.
- Deactivate: own device 200 → `is_active=0`; second call idempotent 200
  with **no second audit row**; another Tanod's device 404 **and that
  device still active afterwards**; unknown id 404; malformed id in the
  URL 404 (route miss, not a 400 that would confirm the route).
- Map packages: 404 before anything is published (M1 must treat this as
  non-fatal); after publishing, metadata returns version/checksum/
  download_url/is_published with the checksum **matching the real file's
  hash**; cross-tenant reads 404 both directions; download bytes hash
  **identical to the source file**; `X-Checksum-SHA256` header matches;
  unpublished packages serve neither metadata nor bytes.
- **Path-traversal containment**: a hostile `file_path` of `../../.env`
  returns 503 and the response body was grepped to confirm it contains no
  `DB_PASSWORD`/`JWT_SECRET`.

Two failures during development were **the test's own wrong expectations**,
corrected rather than papered over: Git-Bash `/c/...` paths passed to
native `php.exe` (fixed with `cygpath -m`), and expecting 404 for a
malformed `device_id` on `POST /devices/register`, whose path is fixed —
the id is in the body, so 400 is correct there.

## Not yet done (explicitly out of this cut)

- `POST /map-packages`, `POST /duty-status` — see decisions above.
- The mobile-side work this unblocks: `apiService.ts`, on-device session
  storage, M1/M3/M4 screens.

---

# DEVLOG — Sprint 2 mobile: apiService + session, M1 Login, M3 Log New
# Incident (local write path), M4 Submitted Confirmation

## Today's cut

Continuing the user-directed run "in recommended order until M4". Covers
the mobile boxes M1, M3, M4 plus the `apiService.ts`/session
infrastructure §4 requires. Multiple boxes in one session is again an
explicit user decision, same documented exception as Sprint 1's multi-box
sessions.

## Decision required before coding, now resolved

**DB passphrase source: a device-generated random secret.** Asked rather
than assumed (§5 mandates encryption at rest but names no key source, and
§6 has no key-provisioning endpoint). 32 random bytes from
`crypto.getRandomValues`, generated at first run and persisted
app-privately via `@capacitor/preferences`.

Rejected alternatives, with reasons: a **server-issued** secret would
leave a brand-new install unable to capture anything until it had first
reached the workstation, contradicting Rule 2 and Rule 7's offline-first
guarantee, and would require changing §6's documented
`POST /devices/register` response; **deriving from the user's password**
fails because the password is unavailable offline after login and a
password change would orphan the database.

Storage caveat recorded honestly in `passphrase.ts` rather than
overstated: SharedPreferences is app-private on a non-rooted device but
is **not** hardware-backed. That is a large improvement over a key
hardcoded in the APK and is not equivalent to Android Keystore; the
documented upgrade path swaps that one function for a Keystore-backed
plugin, since `localDatabase.ts` only ever asks for a
`PassphraseProvider`.

## Conflict found: M1's "registers FCM" step is Sprint-4-blocked

§9 M1 says the app "validates the device, registers FCM" at login, but
`POST /devices/register` requires `fcm_token` and §5's
`mobile_device.fcm_token` is NOT NULL — while FCM registration itself is
Sprint 4 (§10 "FCM registration/critical notifications (S4)"). So device
registration genuinely cannot complete honestly in Sprint 2.

Resolved by shipping `getFcmToken()` as a seam that returns `null` until
Sprint 4, with M1 skipping registration while it is null. Sending a
placeholder token was explicitly rejected: it would write a row claiming
the device is push-reachable when it is not, producing silent delivery
failures for a Tanod the system believes it can reach — and §2 Rule 12
depends on "no active FCM registration" being a *truthful* signal that
routes straight to SMS. Sprint 4 replaces the function body only; no
calling code changes.

## Scope decisions (logged, don't reopen without review)

- **`home.tsx` is NOT M2.** M1 has to navigate somewhere and M3 has to be
  reachable, so a minimal landing screen was built as necessary plumbing
  (same precedent as Sprint 1's minimal login page for W2). It
  deliberately has **no duty toggle, no SOS button, and no stats** —
  `POST /duty-status` isn't built and SOS is Sprint 4, so those controls
  would look functional and do nothing (§8). The screen says so in plain
  words instead. The displayed name comes from the authenticated session,
  never a placeholder (§9 M2 warns about the Figma reference's fake
  identity).
- **No GPS captured in M3.** `latitude`/`longitude` are written as NULL.
  GPS is Sprint 3, the columns are nullable, and adding a geolocation
  plugin this cut cannot verify on a device would be unverifiable scope.
- **`client_event_id` is minted at first save inside the insert
  transaction**, per §5's sync invariants — not at sync time and not
  regenerated on retry, so Sprint 3's `/sync/batch` and Sprint 4's SMS
  fallback can reuse the same identity. M4 surfaces it as the user-facing
  reference.
- **M4 derives its state from the stored row** (`deriveSyncState`) rather
  than trusting a "submitted" flag handed over by M3 — that is precisely
  §9 M4's "never claims server submission when only local persistence has
  occurred". In Sprint 2 only `saved_locally` is reachable; the other
  states are implemented but unreachable until a sync worker exists.
- **The session gate is UX only** (§2 Rule 6), and is deliberately not
  consulted by the local-capture path: Rule 9 requires offline capture to
  keep working with an expired session.
- **Sliding renewal keeps the later-expiring token.** `storeRenewedToken`
  refuses to replace a stored token with one expiring earlier, so an
  out-of-order response cannot roll a session backwards (Rule 9).
- **`apiService.ts` hand-maps snake_case→camelCase per endpoint**, never
  a recursive key walker — same resolved decision as the web client, for
  the same reason: a blind converter would rewrite enum VALUES like
  `physical_injury` and corrupt data identity.
- **Windows case-collision handled:** writing `pages/home.tsx` replaced
  the scaffold's `pages/Home.tsx` (same file on a case-insensitive
  filesystem). The rename was recorded explicitly in git so the tree is
  correct on case-sensitive systems too, and the orphaned 0-byte
  `Home.css` plus the now-unimported `ExploreContainer` scaffold
  component were removed (the latter was also the only eslint failure).

## Files

- `mobile/src/services/apiService.ts` (NEW) — the single §4 API boundary:
  `login`, `logout`, `registerDevice`, `deactivateDevice`,
  `getMapPackage`, `mapPackageDownloadUrl`; `X-Renewed-Token` handling;
  `ApiError` with a distinct `NETWORK_ERROR`/`isOffline` signal.
- `mobile/src/services/session.ts` (NEW) — app-private session storage,
  JWT `exp` decoding, non-decreasing-expiry renewal, `hasLiveSession`.
- `mobile/src/services/deviceIdentity.ts` (NEW) — stable client-generated
  `device_id`; `getFcmToken()` seam.
- `mobile/src/services/db/passphrase.ts` (NEW) — the key provisioning
  decision above.
- `mobile/src/services/db/incidentRepository.ts` (NEW) — transactional
  `saveIncidentLocally`, `getLocalIncident`, `deriveSyncState`.
- `mobile/src/pages/login.tsx`, `home.tsx`, `new-incident.tsx`,
  `incident-submitted.tsx` (NEW) — M1, the minimal landing screen, M3, M4.
- `mobile/src/App.tsx`, `main.tsx` (MODIFIED) — routes + `RequireSession`
  gate; passphrase provider registered once at startup.
- Removed: `mobile/src/components/ExploreContainer.{tsx,css}`,
  `mobile/src/pages/Home.css` (orphaned scaffold).

## Tests performed (with evidence)

1. **`npm run build` (tsc + vite) — exit 0.** Type-checks every new
   module against the installed `@capacitor-community/sqlite` 8.1.1 and
   `@capacitor/preferences` 8.0.1 typings. One real type error was found
   and fixed this way (`autocorrect` on `IonInput` is boolean in Ionic 9,
   not `"off"`), and a bundler warning about a needless dynamic import of
   `session.ts` was cleaned up rather than ignored.
2. **`npm run lint` — exit 0**, after removing the orphaned scaffold
   component that was its only failure.
3. **`npm run verify.schema` — 47/47 still passing**, confirming the
   local schema this work builds on is unchanged.

## UPDATE — M1 has since been browser-verified (same session)

The "never executed" statement below was true when written and is now
superseded for M1. Verified against a disposable database + PHP API on a
throwaway port + the Vite dev server, driving a real browser:

- `/` with no session redirects to `/login` (the gate works).
- Wrong password → exactly **"Unable to sign in with those
  credentials."**, the generic message §2 Rule 9 requires, with the
  password field cleared and the username kept.
- Correct password → reaches `/home` showing **"Rodrigo Bautista"**, the
  real `full_name` from the authenticated session (not a placeholder —
  the thing §9 M2 warns about).
- Network trace proves M1's documented sequence: `POST /auth/login` 401,
  then 200, then `GET /map-packages/1` **404 — and login still
  completed**, which is §9 M1's "enters M2 without blocking on map
  download", demonstrated rather than asserted.
- No `POST /devices/register` call appears, confirming the Sprint-4-blocked
  FCM path is genuinely skipped rather than sending a placeholder token.
- Session persists across reload; sign-out returns to `/login`; a reload
  after sign-out **stays** on `/login` (session actually cleared).
- M3's form renders and its fields bind; pressing Save hits the
  deliberate web-platform guard and shows an honest
  "encrypted local store is Android-only" error instead of crashing or
  falsely reporting a save.

### TWO REAL BUGS this browser test caught (neither was visible to tsc/eslint)

1. **Ionic React 9 + React 19 never invoked `onIonInput`/`onIonChange`.**
   The props type-check and the component renders, but the handler was
   never called: the login form rejected a fully filled-in form as blank.
   Diagnosed by attaching a raw listener in the page — the `ionInput` DOM
   event fired and the web component held the right value while React
   state stayed empty, with a clean console (nothing was throwing).
   Fixed with `mobile/src/components/FormFields.tsx`, which binds to the
   real DOM events; that is version-proof, since it depends on the
   Stencil component's documented event rather than on how the React
   wrapper of the day maps props.
2. **A timing bug in that very fix, caught only on a COLD LOAD.** The
   first version used `useRef`, but `ref.current` was still null when the
   effect first ran (the wrapper assigns the element afterwards), and
   with stable dependencies the effect never re-ran — so no listener was
   ever attached. It worked under hot-reload (the element already existed
   on remount) and failed on a fresh page load. Fixed by storing the
   element in state via a callback ref, making its arrival a dependency
   change. Worth remembering as a category: HMR can mask mount-order bugs
   entirely, so a cold reload is a distinct test, not a redundant one.

M3 and M4 remain unexecuted beyond their form rendering — actually
writing to the encrypted store still requires a device.

### §8 design system ported to mobile (same session)

The scaffold shipped stock Ionic theming — its own blue, and
`dark.system.css` following the OS — so the Tanod app looked nothing like
the light navy/blue web dashboard. §8's heading is explicit that the
design system is "Global — applies to every screen", and it forbids
hardcoding "a hex value, pixel spacing, or font name in a component
file". The first version of these screens violated that directly with
inline `style={{ maxWidth: 420, paddingTop: 48 }}` objects; this pass
corrects both.

- `mobile/src/theme/variables.css` — §8's tokens verbatim, plus the Ionic
  theming variables (`--ion-color-primary` etc., with the `-rgb`
  companions Ionic needs) mapped onto them. Navy is carried on Ionic's
  "secondary", critical on its "danger".
- `mobile/src/theme/app.css` — shared utility classes (`app-column`,
  `app-title`, `app-note`, `app-error`, `status-pill--*`) built only from
  tokens, mirroring the web's `base.css` in spirit. Status pills follow
  §8's rule exactly: fully-rounded, uppercase, tinted background with
  solid-colour text, never a flat solid fill. Tints use `color-mix` so
  they derive from the status token rather than a second hardcoded hex.
- M4's sync states now render as §8 status pills, mapped through the
  §8 status table: saved-locally → warning, queued → info, synced /
  duplicate-reconciled → success, needs-attention → critical. Deliberately
  NOT success for the local-only states, since §9 M4 forbids implying
  server acceptance before it has happened.

**Scope of "match the web", decided deliberately:** the design LANGUAGE
transfers (palette, type scale, radii, shadows, status pills); the
desktop LAYOUT does not. A sidebar, dense `DataTable` rows, and the web's
`html { font-size: 75% }` density knob are all wrong on a phone — that
knob was tuned for desktop information density, and shrinking a touch UI
by a quarter would undercut minimum touch-target sizes. Mobile uses §8's
spacing scale at full size.

**Two decisions recorded (reversible, but deliberate):**

1. **Light, not dark.** The dark palette import was removed. §8 defines
   exactly ONE palette and it is light (`--color-bg: #F8FAFC`); there is
   no documented dark variant, and inventing one would mean inventing
   tokens the reference doesn't define. If night-shift readability later
   argues for dark, that needs its own token set, not a default inherited
   from a starter template.
2. **Inter is requested but never fetched over the network.** §8 names
   Inter and the web dashboard loads it from Google Fonts; doing that
   here would put a CDN dependency inside an offline-first field app,
   which §2 Rule 7 rules out — a Tanod with no connectivity would
   silently get a different typeface. The stack asks for Inter and falls
   back to the platform UI font. Vendoring the Inter files into the
   bundle is the correct completion (a file addition, not a network
   dependency) and is still outstanding.

Verified in the browser at both desktop and a 375x812 phone viewport:
light §8 palette, `#1D4ED8` primary, white surfaces on `#F8FAFC`, and
login still working after the theme change (no regression). `npm run
build` and `npm run lint` both clean.

## NOT verified — stated plainly (as written before the M1 test above)

**None of M1, M3, or M4 has ever been executed.** They type-check, lint,
and build; no screen has been rendered and no local write has actually
run. Two separate reasons:

- There is still **no Android SDK/emulator on this machine**, so the app
  cannot be built or run on a device.
- M3/M4 additionally **cannot be exercised in a browser at all**:
  `localDatabase.ts` deliberately throws on the web platform, because the
  plugin's web target is not SQLCipher-encrypted and would otherwise open
  an unencrypted store that behaves like the real one. That guard was
  kept rather than relaxed for testing convenience.

M1 alone *could* be browser-verified against a dev API server (it touches
no SQLite) — not done this session; noted as the cheapest next
verification step. Everything device-side (SQLCipher actually encrypting,
offline capture surviving app kill — both explicitly demanded by Sprint
2's own prompt) remains outstanding and is gated on the Android SDK.

## Not yet done (explicitly out of this cut)

- M2 Home (duty toggle + SOS), `POST /duty-status`, `POST /map-packages`.
- Actually downloading/SHA-256-verifying a map package (M1 only *checks*
  the version, per §9).
- `evidence_attachment_local` + photo/voice capture; the §8 bottom-nav
  slot question ("Log Incident" vs "Schedule") is still unresolved and
  still gates M3/M8 nav.
- Everything under "NOT verified" above.
