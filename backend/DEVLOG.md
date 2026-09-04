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

---

# DEVLOG — Sprint 2 continued: M2 Home, photo/voice capture, bottom-nav
# tabs, POST /duty-status + POST /map-packages, Keystore passphrase, Inter
# vendoring

## Today's cut

The full "Sprint 2 (Mobile) — remaining" list from the working checklist,
taken together at the user's explicit direction (same documented exception
as prior multi-box Sprint 1/2 sessions): M2 Home, `POST /duty-status`,
`POST /map-packages`, the two blocking decisions (bottom-nav slot,
photo/voice scope), and the two small debts (Inter font vendoring, DB
passphrase → Android Keystore). `evidence_attachment_local` + full
photo/voice capture (not schema-only) followed from the photo/voice
decision below.

## Decisions required before coding, now resolved (asked via AskUserQuestion, not picked silently)

1. **Bottom-nav slot: Log Incident replaces Schedule.** §8 flagged this as
   an open question. User chose Log Incident, on the Figma reference's
   reasoning that a field emergency app should put its most time-critical
   action one tap away at all times. Schedule (M8, unbuilt) now belongs
   behind Profile instead of a persistent tab. §8 updated.
2. **Photo/voice capture: build in full now, not schema-only.** Weighed
   against deferring (avoids stacking a device-dependent feature on top of
   already-unverified M1/M3/M4) — user chose to build it in full, accepting
   it joins M3/M4 as untested until the Android SDK exists.

## Scope delivered

**Backend** (fully verified against real XAMPP — see Tests below):
`POST /duty-status` (M2's duty toggle, idempotent via `client_event_id`),
`POST /map-packages` (Admin multipart upload, MBTiles structure
validation, atomic single-published-package-per-barangay enforcement).

**Mobile local schema**: migration 2 adds `evidence_attachment_local`
(`LOCAL_SCHEMA_VERSION` 1 → 2), verified via the existing Node-based
harness (no device needed for the schema half, same as migration 1).

**Mobile frontend**: M2 Home (real duty toggle, SOS visibly disabled),
bottom-nav tab bar (`TabbedShell` in `App.tsx`) with honest placeholders
for unbuilt destinations, photo/voice capture wired into M3 (`Camera`,
`capacitor-voice-recorder`, `Filesystem` plugins → `evidenceRepository.ts`
→ `evidence_attachment_local`), DB passphrase moved to an Android
Keystore-backed plugin, Inter font vendored into the app bundle.

## Files

- `backend/controllers/DutyStatusController.php` (MODIFIED, additive) —
  `create()`.
- `backend/routes/duty-status.php` (MODIFIED) — POST route registered.
- `backend/controllers/MapPackagesController.php` (MODIFIED, additive) —
  `create()`, `validateMbtilesStructure()`, `baseStorageDir()` (also
  de-duplicated `resolvePackagePath()`'s copy of the same base-dir logic).
- `backend/routes/map-packages.php` (MODIFIED) — POST route registered.
- `backend/scripts/verify-duty-status-map-upload.sh` (NEW) — disposable-DB
  end-to-end validation script, same pattern as every prior verify script;
  builds a real, structurally valid MBTiles fixture via PHP's own
  `pdo_sqlite` (the same driver the controller uses) rather than faking
  bytes by hand.
- `mobile/src/services/db/localSchema.ts` (MODIFIED, additive) —
  `MIGRATION_002_EVIDENCE`, `EvidenceAttachmentLocalRow`,
  `LOCAL_SCHEMA_VERSION` bumped to 2.
- `mobile/scripts/verify-local-schema.mjs` (MODIFIED, additive) —
  evidence_attachment_local column/default assertions, plus a new v1->v2
  in-place upgrade test (a device already on schema v1 keeps its rows).
- `mobile/src/services/db/evidenceRepository.ts` (NEW) —
  `saveEvidenceLocally()`, `getEvidenceForIncident()`.
- `mobile/src/services/evidenceCapture.ts` (NEW) — `capturePhoto()`,
  `startVoiceRecording()`/`stopVoiceRecording()`/`cancelVoiceRecording()`,
  `isRecordingVoice()`. The Capacitor/plugin platform edge, deliberately
  separate from the repository layer (same split as `localDatabase.ts` vs
  `localSchema.ts`).
- `mobile/src/services/uuid.ts` (NEW) — shared UUID helper, extracted now
  that a third/fourth caller needed one (same precedent as
  `backend/lib/Audit.php`'s own extraction; the two existing private
  copies in `incidentRepository.ts`/`deviceIdentity.ts` were left alone).
- `mobile/src/services/apiService.ts` (MODIFIED, additive) —
  `setDutyStatus()`, `getOwnDutyStatus()`, `DutyStatus`/`DutyStatusEntry`.
- `mobile/src/services/db/passphrase.ts` (MODIFIED) — Keystore upgrade,
  see decisions below.
- `mobile/src/pages/home.tsx` (REWRITTEN) — was the M1-era minimal
  placeholder; now the real M2 Home.
- `mobile/src/pages/new-incident.tsx` (MODIFIED, additive) — Add
  Photo/Record Voice Note buttons, staged-attachment list, evidence
  persisted after the incident saves.
- `mobile/src/components/NotBuiltYetPage.tsx` (NEW) — shared honest
  placeholder for an unbuilt tab destination.
- `mobile/src/App.tsx` (MODIFIED) — `TabbedShell` (IonTabs + nested
  IonRouterOutlet), `RequireSession` changed to check once per mount
  instead of on every navigation (see bug note below).
- `mobile/src/theme/variables.css` (MODIFIED) — `@font-face` rules for the
  four vendored Inter weights actually used (400/500/600/700).
- `mobile/src/theme/fonts/*.woff2` (NEW) — the vendored font files
  themselves, pulled once from the `@fontsource/inter` npm package.
- `mobile/package.json` (MODIFIED) — `@capacitor/camera`,
  `@capacitor/filesystem`, `capacitor-voice-recorder`,
  `@aparajita/capacitor-secure-storage` (dependencies); `@fontsource/inter`
  (devDependency — only ever used to source the vendored files, nothing
  in app code imports it).
- `.claude/launch.json` (NEW) — dev-server config so the mobile app can be
  previewed via the Browser tool (`npm run dev --prefix mobile`); didn't
  exist before this session.
- `docs/Baranguard_Master_Reference_FINAL .md` (MODIFIED) — §8 bottom-nav
  question marked RESOLVED.
- `docs/Baranguard_Sprint_Prompts.md` (MODIFIED) — Sprint 2 menu + working
  checklist updated throughout to reflect everything above.

## Resolved decisions not stated in the reference (logged, don't reopen without review)

- **`POST /duty-status` idempotency key.** §5's `duty_status` table already
  has `UNIQUE(user_id,client_event_id)` — a retried toggle with the same
  `client_event_id` returns the original row (200) rather than erroring on
  the constraint or creating a duplicate status change (201 on the real
  first write). Same pattern as `POST /dispatch`/`POST /shifts`'s
  `request_id`.
- **MBTiles structure validation is two-tier.** Every upload's first 16
  bytes are checked against the SQLite file-format magic header (MBTiles
  IS a SQLite database). If this PHP build's `pdo_sqlite` driver is
  available (confirmed present on this XAMPP install), a stricter check
  additionally opens the file and confirms `tiles`/`metadata` tables exist
  in `sqlite_master`. If the driver is absent, the endpoint still accepts
  the upload on the header check alone rather than hard-failing — logged
  via `error_log` so the gap is visible, not silently assumed away.
- **"Exactly one published package per barangay" (§5's own invariant, not
  previously implemented)** is enforced transactionally: `SELECT ...
  FOR UPDATE` locks the barangay's existing package rows, any currently-
  published version is flipped to `is_published=0`, then the new row is
  inserted published — all in one transaction, with the uploaded file
  deleted if the transaction rolls back.
- **500MB package size ceiling** — no §5/§6 number exists for this; picked
  as a sane ceiling for a barangay basemap hosted on a local XAMPP disk.
- **`evidence_attachment_local.incident_local_id` is the FK, not a server
  incident id** — a Tanod can attach a photo/voice note to an incident
  that has only ever been saved locally, and that link must resolve
  without a network round trip; mirrors how the incident itself is
  identified before it has a server id.
- **Evidence capture is staged in component state, then persisted only
  after the incident saves.** An evidence-save failure is logged but does
  NOT block navigation to M4 — the incident record (the actual atomicity
  guarantee M3 exists to provide) is already safe either way. This mirrors
  §6's own framing of evidence as a separate, best-effort upload channel
  from the incident's own sync.
- **Voice recording writes directly to app-private storage via the
  plugin's own `directory`/`subDirectory` options** (returns a real file
  path) rather than holding the whole recording as base64 in memory — the
  plugin's own README flags the base64 path as a real performance cost for
  longer recordings; the base64 fallback is kept only for the platform
  case (declared web behavior) where no `path` comes back.
- **Photo capture copies out of the Camera plugin's own temp file into
  `Directory.Data` immediately** — the temp URI is never referenced again,
  and every `StagedAttachment`'s `sha256`/`byteSize` are computed from the
  bytes actually on disk after the copy, not trusted from the plugin.
- **DB passphrase → Android Keystore, via `@aparajita/capacitor-secure-
  storage`.** Confirmed against the plugin's own README (not assumed):
  "data is encrypted using AES in GCM mode with a secret key generated by
  the Android KeyStore, then stored in SharedPreferences" — exactly the
  upgrade path `passphrase.ts`'s own prior doc comment named. Only that
  one file changed; `localDatabase.ts` still only asks for a
  `PassphraseProvider`. A one-time migration reads an existing install's
  passphrase out of the old `@capacitor/preferences` key, writes it into
  secure storage, and deletes the old copy — generating a second
  passphrase would orphan the already-encrypted database.
- **Inter vendored via `@fontsource/inter`, not hand-downloaded.** Same
  precedent as vendoring MapLibre GL JS for the web dashboard: a one-time
  build-time npm fetch, not a runtime CDN dependency. Only the four
  weights the app actually uses (400/500/600/700) were copied into
  `theme/fonts/`, keeping the addition to ~100KB.
- **Bottom-nav's three not-yet-built destinations (Assignments/Map/
  Profile) are real, reachable tabs that route to an honest placeholder**,
  not hidden tabs and not fake functional-looking screens — same
  precedent as the web dashboard's `renderUnavailable()` and this app's
  own original M1-era `home.tsx`.

## Bugs found and fixed during this session's own testing (not just claimed)

**A real app bug, caught only by testing the bottom-nav tabs in a live
browser, not by inspection or `tsc`/`eslint`:** `RequireSession`'s
"is the session live" check originally re-ran on every `location.pathname`
change. Before this session, each protected route had its own separate
`RequireSession` instance, so that was harmless — a location-keyed effect
only fired on an actual top-level route change. Once `TabbedShell` wrapped
the whole tabbed area in a SINGLE `RequireSession` for its entire
lifetime, the same dependency would have re-run the async session check —
and flashed a loading spinner — on every tab switch, something a Tanod
would hit dozens of times a shift. Fixed by checking once per mount
(`useEffect(..., [])`) instead of per-navigation; a fresh mount (login, or
sign-out then back in) still checks again correctly. Caught while manually
exercising the new tab bar in a real browser session, not from a type
error or lint warning — neither would have flagged this.

**A test-environment artifact, not an application bug, that cost real
debugging time and is worth recording so a future session doesn't chase
it again:** driving the mobile app through this session's headless
Browser tool, a client-side route transition (login → `/home` via a
programmatic form submit) left the DOM in a state where BOTH the old and
new `<ion-page>` were present with the new one's Ionic-managed wrapper
still carrying `ion-page-invisible`/`opacity:0`, while `location.href` had
already correctly changed to `/home` and the actual page content was
already correct in the DOM. Screenshots and `computer` actions kept
showing the stale login page; `get_page_text` and direct DOM inspection
via `javascript_tool` showed the true state. Root-caused to Chrome
throttling `requestAnimationFrame`/CSS-transition completion callbacks for
a backgrounded/hidden tab (the tool's own status line repeatedly reported
"The Browser pane is currently hidden" right before this), which is
exactly what Ionic's page-transition system depends on to finish and
un-hide the new page. Worked around by navigating directly to the target
URL (a full page load bypasses the client-side transition entirely) for
verification purposes; not a fix to any application file, since real
device usage doesn't background the tab mid-transition the way this
automation environment did.

## Tests performed (with evidence)

1. **`php -l` clean** on `DutyStatusController.php`, `MapPackagesController.php`,
   `routes/duty-status.php`, `routes/map-packages.php`.
2. **`backend/scripts/verify-duty-status-map-upload.sh` against real XAMPP
   (MariaDB 10.4.32 + PHP 8.2.12, pdo_sqlite confirmed present) — 40/40
   passed**: role gating (Admin blocked from duty-toggle, Tanod blocked
   from map upload); invalid status/missing-client_event_id/malformed-UUID
   all 400; happy-path toggle returns `channel:"app"`; **idempotent retry
   on the same `client_event_id` returns the identical `status_id`, and
   exactly 1 DB row exists for it (verified in the DB, not just the
   response)**; a second real toggle creates a second row; `GET
   /duty-status?barangay_id=` reflects the latest toggle; map-package
   upload validation (missing version, illegal version characters, missing
   file, non-SQLite garbage all 400); happy-path upload's
   `checksum_sha256` matches the real uploaded file's hash (computed
   independently); duplicate `(barangay,version)` → 409; **publishing a
   second version automatically unpublishes the first — verified in the
   DB that exactly one row stays `is_published=1` for that barangay**; the
   newly published package is immediately servable via the pre-existing
   GET/download endpoints; barangay-2 admin's upload is scoped to their
   own `barangay_id` server-side (not client-suppliable) and does not
   disturb barangay-1's published package.
3. **`node scripts/verify-local-schema.mjs` — 65/65 passed** (up from
   47/47): all prior checks still pass, plus `evidence_attachment_local`
   column-for-column against §5, its `synced`/`attempts` defaults, and a
   new upgrade-path test — a database seeded at schema v1 with an existing
   `incident_local` row correctly reaches v2, keeps that row, and gains
   the new table.
4. **`npm run build` (tsc + vite) and `npm run lint` — both clean** after
   fixing one real type error (Camera's `MediaResult` has no `format`
   field in this plugin version — moved to `metadata.format` via
   `includeMetadata: true`) and one lint warning (an unused
   `eslint-disable` comment).
5. **Real browser walkthrough** (disposable DB `baranguard_m2_browser_check`
   + disposable PHP dev server on a throwaway port + the Vite dev server,
   `.claude/launch.json` created for this and left in the repo as reusable
   tooling) — login as a real Tanod account renders M2 Home with the
   authenticated user's real name (not a placeholder) and a real
   `OFF DUTY` status read from `GET /duty-status?user_id=me`; the bottom
   tab bar shows all 5 tabs with Log Incident correctly in the persistent
   slot; clicking "Go On Duty" produces a live `POST /duty-status` (201),
   the UI updates to `ON DUTY`/"Go Off Duty" from the SERVER's response
   (not an optimistic local flip), and **the resulting row was confirmed
   directly in the database** (`status='on_duty', channel='app'`); SOS
   renders disabled with its explanatory note; the Assignments tab renders
   the honest "isn't built yet" placeholder; the Log Incident tab shows
   the new Add Photo/Record Voice Note buttons and the "not uploaded yet"
   note. Zero unexpected console errors — the only ones logged were the
   expected, already-documented non-blocking 404 from M1's map-package
   version check (no package published in this throwaway DB). All test
   infrastructure (disposable database, disposable app-user, both dev
   servers, `.env.local`) was torn down after — the real `baranguard`
   database and `backend/.env` were never touched.

## NOT verified this session (stated plainly)

- **Photo/voice capture has never executed on a device.** `evidenceCapture.ts`
  compiles and type-checks against `@capacitor/camera`,
  `capacitor-voice-recorder`, and `@capacitor/filesystem`'s documented
  contracts; nothing in it has run. No microphone/camera permission flow,
  no actual file write, no sha256-of-a-real-file has been exercised.
- **The Keystore passphrase upgrade has never executed on a device.**
  `@aparajita/capacitor-secure-storage`'s `getItem`/`setItem` are asserted
  by its README, not by running this app's code against a real Android
  Keystore. The legacy-migration path (existing `@capacitor/preferences`
  value → secure storage) is similarly unexercised.
- **`evidence_attachment_local`'s schema half IS verified** (65/65, no
  device needed — same split as every other local table), but the
  end-to-end "capture a photo, save the incident, confirm the evidence row
  and the file both exist" flow is not.
- All of the above are blocked on the same, already-tracked Android SDK
  install — nothing new here, just a longer list of what's now waiting on
  it.

## Not yet done (explicitly out of this cut)

- Mobile branch of `POST /incidents` (device_id + client_event_id
  idempotency path — the web path from Sprint 1 is a different code path
  that has never been exercised from mobile).
- The `dispatch_local` cache-shape ambiguity (Sprint 2 vs Sprint 3) is
  still unresolved.
- M5/M6/M7 (Assignments/Assignment Detail/Live Map), `/sync/batch`,
  `POST /gps` — Sprint 3, untouched.
- Every item under "NOT verified this session" above.

---

# DEVLOG — Sprint 2 continued: Android SDK / native build environment
# setup (in progress — device verification not yet reached)

## Today's cut

Not a new feature box — this is the environment-setup prerequisite the
Sprint 2 checklist has been waiting on since the local-schema cut: get an
actual Android build working on this workstation so M1/M3/M4/M2 and the
new photo/voice capture can finally be device-verified. The user installed
Android Studio this session; this entry covers everything from `npx cap
add android` through to the exact point where the build is blocked on a
JDK 21 install (in progress on the user's own machine as of this entry).

## Four real, non-obvious environment bugs found and fixed (each confirmed via `--stacktrace`/direct source inspection, not guessed)

1. **Gradle daemon: `java.io.IOException: Unable to establish loopback
   connection` on every single invocation, including `gradlew help`.**
   Root-caused via `--stacktrace`, not assumed: JDK 17's `PipeImpl`
   (used internally by `Selector.open()` for the daemon's wakeup pipe)
   tries a Unix Domain Socket connection first
   (`sun.nio.ch.UnixDomainSockets.connect0`), which failed with
   `SocketException: Invalid argument: connect`. Two wrong theories were
   tried and ruled out first (IPv6 loopback preference; forcing the legacy
   `WindowsSelectorProvider` — the *same* `PipeImpl` code path is shared by
   both selector providers, so switching providers changed nothing). The
   actual cause: the Windows user profile path contains a space
   (`C:\Users\Jayson Buenosaires\...`), and the JVM's default
   `java.io.tmpdir` — where the AF_UNIX socket file gets created — inherits
   that space. **Fix**: redirect `TMPDIR`/`TEMP`/`TMP` and
   `-Djava.io.tmpdir` to a short, space-free path (`C:\gtmp`) for every
   Gradle invocation. Confirmed by watching the failure disappear the
   moment the redirect was correctly escaped (an earlier attempt using a
   single backslash silently became `C:gtmp`, a different, equally
   diagnostic failure).
2. **`local.properties`' `sdk.dir` was malformed** by an earlier heredoc
   write that produced escaped-backslash garbage
   (`C\:\Users\Jayson Buenosaires\...`) — Java `.properties` files treat
   backslash as an escape character, so this never resolved to a real
   path. Manifested as a much later, more confusing error
   (`SdkLocator...validateSdkPath`: "The filename, directory name, or
   volume label syntax is incorrect") on a *specific* plugin subproject's
   task, not obviously an SDK-path problem at all. **Fix**: rewrite using
   the Windows 8.3 short path with forward slashes
   (`C:/Users/JAYSON~1/AppData/Local/Android/Sdk`) — sidesteps both the
   backslash-escaping hazard and the space-in-username hazard at once.
3. **The same space-in-username hazard broke `sdkmanager.bat`/
   `avdmanager.bat` outright** ("'C:\Users\Jayson' is not recognized as an
   internal or external command") — these `.bat` wrappers don't quote
   their own internal path variables safely. **Fix**: same short-path
   form (`C:\Users\JAYSON~1\...`) for every SDK cmdline-tools invocation.
   General lesson for this machine, recorded here so it isn't
   rediscovered a third time: **verify a path-sensitive Windows tool
   against the short-path form whenever the long form contains a space**,
   don't assume quoting alone will save it.
4. **Every one of the app's 6 Capacitor native plugins requires an exact
   Java 21 toolchain** (`sourceCompatibility`/`targetCompatibility
   JavaVersion.VERSION_21`, confirmed by grepping all 6 plugins' own
   `android/build.gradle` files — not just Camera, all of them). Only
   JDK 17 was installed. **Registering Android Studio's bundled JBR
   (JDK 25) as an additional toolchain candidate did NOT work** — Gradle's
   toolchain resolution for a `languageVersion` request is an exact
   major-version match, not "≥ requested"; a real JDK 21 install is
   required, there is no way around it with a newer or older JDK.
   Confirmed empirically (not just from Gradle's docs): registering JBR 25
   via `org.gradle.java.installations.paths` produced the identical error,
   unchanged. **Fix in progress**: user is installing the official Temurin
   21 `.msi` (this session's own `curl` attempts to fetch the JDK zip
   directly were abandoned — this network sustained only ~105 KB/s on that
   transfer, making a ~195MB download impractically slow; the user's own
   connection is expected to do much better).

## A real gap this surfaced, not yet resolved: `mobile/android/` is gitignored but now holds real fixes

`.gitignore` line 39 (`mobile/android/`) predates any native customization
existing — the original reasoning (a prior DEVLOG entry) was "nothing
tracked is lost by adding it, since nothing in it is customized yet."
That's no longer true: `gradle.properties` (the JDK-toolchain-selector
workaround) and `AndroidManifest.xml` (CAMERA/RECORD_AUDIO permissions,
added earlier this Sprint 2 cut for photo/voice capture) are both real,
necessary, non-regeneratable-by-default fixes now living in a gitignored
directory.

**The routine case is safe**: `npx cap sync` (run often) never touches
either file — confirmed by reading Capacitor CLI's own behavior, not
assumed. **The risk is narrow but real**: `npx cap add android` (a rare,
one-time operation — already run exactly once, tonight) deletes and fully
regenerates `android/` from scratch, which would silently lose both fixes
and force a future session to rediscover bugs #1/#2/#3 above and re-add
the manifest permissions from zero. Flagged to the user rather than
silently deciding either way (commit `android/` now that it holds real
fixes, vs. keep it gitignored and accept the regeneration risk) — this
is a real repo-convention decision, not a mechanical one.

## Files changed (all currently gitignored — see gap above)

- `mobile/android/gradle.properties` — added
  `org.gradle.java.installations.paths` listing both the JDK 17 and JBR 25
  locations (kept even though JBR 25 alone didn't resolve issue #4, since
  registering JDK 17 there doesn't hurt and JBR 25 may still help other
  toolchain requests below 21). The `java.io.tmpdir` fix for issue #1 is
  NOT in this file — it has to be set via `TMPDIR`/`TEMP`/`TMP`/`JAVA_OPTS`
  environment variables on every invocation instead, since the failure
  happens in the wrapper's own launching JVM before `gradle.properties`
  (which only configures the daemon it's about to spawn) is even read.
- `mobile/android/local.properties` — corrected `sdk.dir`, see fix #2.
- `mobile/android/app/src/main/AndroidManifest.xml` — added
  `android.permission.CAMERA`, `android.permission.RECORD_AUDIO`, and a
  `required="false"` camera `<uses-feature>` (so the app doesn't refuse to
  install on a cameraless device/emulator) — both confirmed necessary by
  reading `capacitor-voice-recorder`'s and `@capacitor/camera`'s own
  Java/Kotlin source for their exact runtime-permission requests, not
  assumed from the plugin names.

## Also verified this session (real, static checks — not device-dependent)

- **No plugin declares a `minSdkVersion` above the project's own 24** —
  checked directly in all 6 plugins' `android/build.gradle` files; each
  either inherits `rootProject.ext.minSdkVersion` or falls back to
  23/24. Structural evidence that Android 7 (API 24) support isn't broken
  at the dependency level — NOT a substitute for either Lint's `NewApi`
  check (not yet run — needs the same blocked JDK 21) or an actual
  low-API device/emulator run (not yet done either), both logged as
  outstanding below.
- `@capacitor/camera`'s required `file_paths.xml` FileProvider resource
  exists at `android/app/src/main/res/xml/file_paths.xml` with sane
  defaults (plugin-template-generated, untouched) — the concrete failure
  mode if this were missing would be a runtime crash the instant a Tanod
  taps "Add Photo," not a build-time error, so worth having actually
  looked rather than assumed present.

## Not yet done (explicitly out of this cut — this is infrastructure, not verification)

- Everything Sprint 2's checklist already lists as blocked on the Android
  SDK: SQLCipher encryption-at-rest, offline-capture-survives-kill,
  photo/voice capture end-to-end, the Keystore passphrase migration path —
  none of these have executed yet. This entry only gets the BUILD working;
  the actual M1/M2/M3/M4 device run is the next session's work once the
  JDK 21 install and the API 36 (not 34 — see decision below) emulator
  are both ready.
- `./gradlew lintDebug` — the static `NewApi` check that would give real
  confidence on the minSdk=24 floor. Blocked on the same JDK 21 install.
- An actual low-API (e.g. API 24–26) emulator/device run, for the same
  reason a lint pass isn't a full substitute for it.
- The `mobile/android/` gitignore-vs-commit decision above.

## Resolved decision: emulator API level is 36, not 34

First attempt at this (before checking the project's own config) picked
API 34 as "a reasonable modern default" — wrong, caught before it wasted
more than a partial background download. `mobile/android/variables.gradle`
states `compileSdkVersion = targetSdkVersion = 36` (`minSdkVersion = 24`
is the compatibility floor, not a test target). Android's runtime
behavior changes (permission dialogs, background/storage restrictions)
are gated by the emulator's actual OS build, not just what the app
declares — testing on 34 would under-test exactly what `targetSdk=36`
opts the app into, and a real Tanod's phone bought today runs something
close to 36, not 34. Corrected to API 36 (Google APIs, x86_64) before the
user started that download; the partial API 34 download was abandoned and
cleaned up (`.temp` staging directory removed) rather than left as dead
weight.

---

# DEVLOG — Sprint 2's leftover mobile POST /incidents branch, then all of
# Sprint 3 in one session (explicit user direction: code first, test after)

## Today's cut

Explicit user direction, given twice: (1) finish whatever Sprint 2 left
undone before moving on, (2) then code the WHOLE of Sprint 3 — all five
menu boxes (M5, M6, M7, `POST /gps`, `POST /sync/batch`) — in one sitting,
**deliberately deferring every verification step** (no `php -l`/`tsc`
beyond a bare parse/type check, no `verify-*.sh`, no browser walkthrough,
no device run) to a follow-up session. This is a real, acknowledged
departure from this project's own normal "prove it, don't claim it"
discipline — done because the user explicitly asked for it, not because
verification stopped mattering. **Nothing below is claimed tested beyond
what the "Static checks actually run" section says.** Sprint 3's own
"Today's cut" boxes in `Baranguard_Sprint_Prompts.md` are deliberately
left UNCHECKED by this entry — a checked box in that file has always meant
real verification evidence, and this session has none to offer yet.

Sprint 2's carryover: the mobile branch of `POST /incidents` (device_id +
client_event_id idempotency), previously listed as "Not yet done" because
the direct-POST mobile path had never been exercised — it is still
unexercised, but the code now exists and is also reachable through
`/sync/batch`'s `incidents[]` array, which is how this app actually
reaches it in practice (M3 only ever saves locally; nothing calls
`POST /incidents` directly from a screen).

## Schema gap found and resolved before writing any mobile-cache code

§5 defines `dispatch_local` fully (it was never actually missing, despite
an earlier DEVLOG entry flagging "the dispatch_local cache-shape
ambiguity... is still unresolved" — re-reading §5 line-by-line this
session found the full column list was there all along; the "ambiguity"
was only ever about which SPRINT it belonged to, now resolved as Sprint
3). No schema deviation was needed for `dispatch_local`/`gps_track_local`/
`offline_queue_local` — all three are exactly as documented.

## A real, undocumented API gap found while designing the mobile screens

`GET /dispatch`'s documented item shape (§6) has no `incident_type`,
`latitude`, or `longitude` — only dispatch-table fields. Without them, M5
Assignments List and M6 Assignment Detail have no redacted-safe way to
show what/where a cached assignment even is (§9 M5's own UI reference
explicitly wants "type, location" on every card). Resolved the same way
`GET /incidents`'s own `officer_name` field was added in an earlier
session: extended `DispatchController::index()`'s query with a plain join
back to `incident` for these three fields only. Never `raw_narrative`, and
both fields are already exposed to a Tanod via `GET /incidents`'s own list
item shape — this doesn't disclose anything new, it just reaches the same
allow-listed data from the dispatch side too.

## Resolved decisions not stated in the reference (logged, don't reopen without review)

**Mobile `POST /incidents` idempotency source.** §6 fixes the idempotency
key as "authenticated device_id + client_event_id" but the documented
request body has no `device_id` field, and the JWT itself carries no
device identity. Resolved with a new `X-Device-Id` request header,
mirroring the existing `Idempotency-Key` header precedent exactly. The
server verifies that device_id actually belongs to the calling Tanod
(`mobile_device.user_id = caller`, `is_active=1`) before trusting it —
the "authenticated" half of "authenticated device_id". Added to
`index.php`'s CORS `Access-Control-Allow-Headers`.

**`POST /gps`'s request body** (§6 states the endpoint in prose only):
`{latitude,longitude,accuracy_m,recorded_at,dispatch_id?,client_event_id}`.
`client_event_id` is always required (not just "for offline/retryable
writes" as §6's prose hedges) — every other mobile write in this codebase
already requires one, and a broadcast-cadence endpoint is retried by
definition. "Active" dispatch (for the optional `dispatch_id` ownership
check) means `status IN ('assigned','en_route','arrived')`, the same
definition `DispatchController` already uses elsewhere.

**`PATCH /dispatch/:id/status`'s transition rule applies identically to
both roles.** Re-reading §6 closely: "Allowed transitions only:
assigned→en_route, en_route→arrived, arrived→completed" is NOT relaxed
for Admin — an Admin acting on someone else's dispatch still only reaches
the next matrix state, they just need an explicit `override_reason` (and
get an audit row) because they aren't the assigned Tanod. This
simplified what had originally looked like it needed two different
matrices into one shared `applyStatusTransition()` used by the direct
PATCH endpoint, M6's mobile status button (via the sync path below), and
`SyncController`.

**`POST /sync/batch`'s per-item body shapes** (§6 only says "every item
has client_event_id"): resolved as exactly each item type's own
single-item endpoint body — `incidents[]` = `POST /incidents` (mobile)
body, `gps_tracks[]` = `POST /gps` body, `duty_status_updates[]` =
`POST /duty-status` body, `dispatch_status_updates[]` =
`{dispatch_id,status,client_event_id}` (no `override_reason` — a sync
item is always the owning Tanod moving their own dispatch, never an Admin
override).

**"Oldest-first per device"** (§6): with no shared timestamp field across
five differently-shaped item types, and no license to invent one outside
each endpoint's own documented body, this is interpreted as: the five
arrays are processed in the fixed order §6's own body lists them
(incidents, gps_tracks, duty_status_updates, dispatch_status_updates,
sos), and within each array, in the client-supplied order — i.e. each
array is already "oldest-first" because that's the order a client
naturally appends to it while queuing offline.

**`offline_queue` (server) is the idempotency ledger for `/sync/batch`
specifically**, keyed on `(device_id, client_event_id)`, independent of
whatever dedup column the underlying business table has. This matters
most for `dispatch_status_updates` — `dispatch` has NO client_event_id
column at all, so without this ledger a retried sync of the same
status-change event would attempt the identical transition twice and hit
a real `409` on the second attempt. `incidents`/`gps_tracks`/
`duty_status_updates` already self-dedupe via their own business-table
UNIQUE constraints; the ledger check there is a harmless fast path that
also correctly reports `'duplicate'` for a retried *sync call itself*,
not only a cross-transport duplicate. `sync_metadata_json` holds only
`{"server_id": ...}` — per §5, "server mirror never stores original raw
payload".

**`sos[]` in `/sync/batch` is explicitly unsupported this cut** —
`POST /tanod-sos` and its notification/FCM/SMS transport are Sprint 4
scope. Every `sos[]` item returns `status:"failed"` with an explanatory
reason (`503 SERVICE_UNAVAILABLE` internally) rather than being silently
dropped or half-implemented — same "don't jump the dependency chain"
precedent `DispatchController` already set for notification creation.

**Mobile local schema, Sprint 3 (migration 3): `dispatch_local`,
`gps_track_local`, `offline_queue_local` — NOT `duty_status_local`.**
M2's duty toggle already always calls `POST /duty-status` directly online
(Sprint 2); nothing in this cut adds an offline duty-toggle path, so
creating that table now would repeat the exact "empty table nothing
reads" mistake this project's own Sprint 2 entry already flagged and
avoided. `offline_queue_local` is used for exactly one payload type this
cut — `dispatch_status` — because `dispatch_local` has only a single
`last_status_event_id` slot (§5), not room for a queue of multiple
pending offline status changes; `incident_local`/`gps_track_local`
instead use their own existing `synced` columns directly, the same
pattern `incident_local` already established in Sprint 2.

**M6's status button advances exactly one step, always.** §9 M6: "A
client must not locally skip states." `dispatchRepository.nextStatusFor()`
returns the single next state or `null` at a terminal one — there is no
UI path to request any other target, so "must not skip states" is
enforced structurally on the client, not just left to server-side
rejection (which still independently enforces it either way).

**M6's Navigate action opens the device's own map app via a `geo:` URI**
rather than adding a mapping SDK. This works identically whether the
cached route is fresh or stale — a `geo:` intent lets the map app route
live from wherever it actually is, which is the correct fallback for "new
OSRM routing is unavailable offline" (§9 M6).

**M7 Live Map ships without a rendered basemap.** Rendering real tiles
from a downloaded MBTiles package needs a native, offline-tile-capable
map renderer (e.g. MapLibre Native via a Capacitor plugin) — a
materially bigger native dependency than anything else in this cut, and
not something to add silently without the user scoping it explicitly (the
same reasoning that kept `POST /map-packages` upload and OSRM routing out
of earlier cuts). Rather than fake a map with a static image (a demo-tell
§8 forbids), M7 is built as a real, fully-functional STATUS VIEW: GPS
broadcast, real freshness, and a real nearby-incidents list — everything
§6 actually wires up — with the rendered map surface tracked as explicit
follow-up work below, not silently skipped.

**M7's GPS broadcast is foreground-only.** Tracking starts when the
screen mounts and stops on unmount via the stop function
`geolocation.ts`'s `watchPosition()` returns. A background location
service (tracking while the app is closed) needs a foreground-service
notification, battery-optimization exemptions, and Android 10+'s separate
background-location consent flow — none of it in this cut's scope. If
continuous background GPS is wanted later, that's a separate, explicitly
scoped decision.

**Broadcast/nearby-refresh cadence** (not numbers §6 states for the
mobile side): GPS broadcast throttled to at most once per 15s (same order
of magnitude as the web dashboard's own GIS Live Tracking poll), nearby
incidents refreshed every 30s. `STALE_AFTER_SECONDS = 120` for M7's own
Live/Stale pill matches `GpsController`'s existing §6 threshold exactly,
rather than inventing a second number.

**`@capacitor/geolocation` added to `package.json`** — the only new
native dependency this cut. `npm install` has NOT been run (see Static
checks below); it joins Camera/voice-recorder/secure-storage on the list
of native plugins added but not yet exercised through `npx cap sync` +
a real build.

## Files

**Backend:**
- `backend/controllers/IncidentsController.php` (MODIFIED) — `create()`
  now branches web (Admin/Secretary, existing `Idempotency-Key` path,
  renamed `createWeb()`) vs. mobile (Tanod, new `createMobile()` +
  `createMobileItem()`); new `nearby()` for `GET /incidents/nearby`
  (M7); `assertDeviceOwnership()` helper.
- `backend/controllers/GpsController.php` (MODIFIED) — new `create()`
  (`POST /gps`) + `createItem()` (the reusable core `SyncController`
  also calls).
- `backend/controllers/DutyStatusController.php` (MODIFIED) — `create()`'s
  inline lookup-then-insert logic extracted into `applyToggle()`
  (`public`), reused by `SyncController`.
- `backend/controllers/DispatchController.php` (MODIFIED) — new
  `updateStatus()` (`PATCH /dispatch/:id/status`) +
  `applyStatusTransition()` (the shared core); `index()`'s SELECT extended
  with `incident_type`/`latitude`/`longitude` (see API gap above).
- `backend/controllers/SyncController.php` (NEW) — `POST /sync/batch`,
  the `offline_queue`-backed reconciliation ledger described above.
- `backend/routes/gps.php`, `incidents.php`, `dispatch.php` (MODIFIED),
  `backend/routes/sync.php` (NEW) — route registrations for all of the
  above.
- `backend/public/index.php` (MODIFIED) — `X-Device-Id` added to
  `Access-Control-Allow-Headers`.

**Mobile:**
- `mobile/src/services/db/localSchema.ts` (MODIFIED) — migration 3
  (`dispatch_local`, `gps_track_local`, `offline_queue_local`);
  `LOCAL_SCHEMA_VERSION` 2 → 3; new row-type interfaces.
- `mobile/scripts/verify-local-schema.mjs` (MODIFIED) — EXPECTED-column
  assertions and default-value checks extended for all three new tables,
  and the v1→latest upgrade-path check extended to assert all three
  survive an in-place upgrade. **Written, not run this session** — see
  Static checks below.
- `mobile/src/services/db/dispatchRepository.ts` (NEW) — `dispatch_local`
  cache: `cacheDispatchesFromServer()` (upsert), `listActiveCachedDispatches()`,
  `getCachedDispatch()`, `isCacheStale()`, `nextStatusFor()`,
  `applyLocalStatusChange()`, `markStatusSynced()`.
- `mobile/src/services/db/gpsTrackRepository.ts` (NEW) — `gps_track_local`
  staging: `saveGpsPointLocally()`, `listUnsyncedGpsPoints()`,
  `markGpsPointSynced()`.
- `mobile/src/services/db/offlineQueueRepository.ts` (NEW) —
  `offline_queue_local` for `dispatch_status` items only:
  `enqueueDispatchStatusChange()`, `listPendingDispatchStatusUpdates()`,
  `markQueueItemResolved()`.
- `mobile/src/services/db/incidentRepository.ts` (MODIFIED, additive) —
  `listUnsyncedIncidents()`, `markIncidentSynced()`,
  `markIncidentSyncFailed()` for the sync worker below.
- `mobile/src/services/syncService.ts` (NEW) — `runSyncPass()`: gathers
  unsynced incidents/GPS/queued dispatch-status changes, calls
  `apiService.syncBatch()` once, applies per-item results back to local
  state. Nothing calls this yet (see Not yet done).
- `mobile/src/services/geolocation.ts` (NEW) — `getCurrentPosition()`,
  `watchPosition()` (foreground-only, see decisions above).
- `mobile/src/services/apiService.ts` (MODIFIED, additive) —
  `getDispatches`, `updateDispatchStatus`, `postGps`,
  `getNearbyIncidents`, `syncBatch`, plus the `DispatchEntry`/
  `SyncBatchResult`/etc. types backing them.
- `mobile/src/pages/assignments.tsx` (NEW) — M5.
- `mobile/src/pages/assignment-detail.tsx` (NEW) — M6.
- `mobile/src/pages/live-map.tsx` (NEW) — M7 (status-view, no rendered
  map — see decisions above).
- `mobile/src/App.tsx` (MODIFIED) — `/assignments`, `/assignments/:localId`,
  `/map` now route to the real pages instead of `NotBuiltYetPage`.
- `mobile/src/theme/app.css` (MODIFIED, additive) — `.card`/`.card-list`/
  `.priority-dot`/`.card__meta--warning` etc., built from existing §8
  tokens only, no new hardcoded values.
- `mobile/package.json` (MODIFIED) — `@capacitor/geolocation` dependency
  added.
- `mobile/README.md` (MODIFIED) — table/screen inventory corrected; it had
  drifted out of date since the initial scaffold entry and was actively
  misleading about "no screens yet".

## Static checks actually run (the only verification this session performed)

1. **`php -l` on every new/modified PHP file** (10 files) — all clean, no
   syntax errors. This is a PARSE check only; it proves nothing about
   correctness, authorization, or the actual SQL executing successfully.
2. **`tsc --noEmit` across the whole mobile project** — clean except for
   `geolocation.ts`, which fails with exactly the expected
   `Cannot find module '@capacitor/geolocation'` (its `npm install` was
   never run this session) plus two derived implicit-`any` errors on that
   same missing type. Every other new/modified file in this cut —
   `apiService.ts`, all three new repositories, `incidentRepository.ts`'s
   additions, `syncService.ts`, `App.tsx`, and all three new pages —
   type-checks cleanly against the project's existing dependencies. This
   is a real signal (a type-checker catches a class of mistake `php -l`
   cannot), but it is still not behavior verification.

## NOT done this session — stated plainly, not glossed over

- **No `verify-*.sh` script was run** against the new backend endpoints
  (`POST /gps`, `PATCH /dispatch/:id/status`, `POST /sync/batch`, the
  mobile `POST /incidents` branch, `GET /incidents/nearby`,
  `GET /dispatch`'s extended fields). Nothing here has executed against a
  real database. A dedicated verify script for these five endpoints
  together is the natural next step, following the exact pattern every
  earlier sprint's own `verify-*.sh` already established.
- **`npm run verify.schema` was NOT run** — the migration-3 additions to
  `localSchema.ts` and the corresponding assertions in
  `verify-local-schema.mjs` have never executed against a real SQLite
  engine, unlike every prior schema migration in this codebase (which
  were always run and reported with a pass count the same session they
  were written).
- **`npm install` was NOT run** — `@capacitor/geolocation` exists only as
  a `package.json` entry; nothing has resolved or installed it.
- **No browser walkthrough** (the Playwright/Browser-tool pattern every
  earlier sprint used for at least a smoke pass) was performed for any of
  the three new mobile screens.
- **No device/emulator run** — unchanged from the prior entry's "Android
  native build environment" blockers; nothing in this cut moves that
  forward, and everything new here (dispatch/GPS caching, the sync
  worker, M5/M6/M7) is exactly as unverified on a real device as M1/M3/M4
  already were.
- **`syncService.ts` is not wired to anything yet.** No screen, timer, or
  app-lifecycle hook calls `runSyncPass()` — it exists as a callable
  module, not yet a running worker. M5/M7 do their own direct
  online-or-local-fallback writes (`postGps`, `cacheDispatchesFromServer`)
  independent of it; only `runSyncPass()` actually drains what those
  fallbacks accumulate. Wiring a real trigger (app foreground, a timer, a
  manual "Sync now" action) is unstarted.
- **Nothing from this session has been committed.** It is sitting in the
  working tree pending the user's review, consistent with how every prior
  session's uncommitted work has been handled in this repo.

## Suggested order for the follow-up verification session

1. `npm install` in `mobile/` (resolves the one outstanding `tsc` gap).
2. `npm run verify.schema` — confirm migration 3 passes for real.
3. A new `backend/scripts/verify-sprint3.sh` against real XAMPP, covering:
   mobile `POST /incidents` idempotency + device-ownership rejection,
   `POST /gps` (happy path, idempotent retry, invalid/foreign
   `dispatch_id` rejection), `PATCH /dispatch/:id/status` (Tanod own vs.
   Admin-with-reason vs. wrong-role vs. skip-a-state rejection),
   `POST /sync/batch` (mixed batch with a genuine duplicate and a genuine
   failure in the same call, device-ownership mismatch rejection),
   `GET /incidents/nearby` (radius cap, tenant isolation),
   `GET /dispatch`'s new fields.
4. Browser/Playwright pass for M5/M6's data flow against a disposable DB
   (M5 and the `PATCH .../status` half of M6 don't need SQLite — only the
   `dispatch_local` cache read/write does, which needs a device).
5. Once the Android SDK/JDK 21 blocker from the prior entry clears: a real
   device run exercising M5 → M6 → M7 → forced-offline status change →
   reconnect → confirm `syncService.ts`'s `runSyncPass()` actually drains
   the queue — plus wiring `runSyncPass()` to something that calls it.

---

# DEVLOG — Sprint 5 (Ollama/SEA-LION setup + AI health/queue), coded ahead
# of Sprints 2–4's outstanding verification, at the user's direction

## Today's cut

All four of Sprint 5's menu boxes, in one session:

  - Queue infra: `ai_processing_log` + a job queue that survives Ollama
    being unreachable
  - `GET /system/health`'s `ollama` field
  - Translation scaffold: `POST /incidents/:id/ai-draft/translate`
  - Voice-to-text scope decision (documentation, not code)

Plus `POST /incidents/:id/redact` and `GET /incidents/:id/ai-draft` — see
"Scope note" below for why those two came along.

**Same standing arrangement as the previous entry: coding only, checking
deferred.** The only verification performed was `php -l` on every new and
modified file (all clean). No verify script, no live request, no worker
run, no model call. Sprint 5's boxes in `Baranguard_Sprint_Prompts.md`
are marked `[~]`, not `[x]`, for exactly that reason.

**Sprint ordering note:** the user asked to jump here with Sprints 2–4
outstanding. That is sound and worth recording so a later session doesn't
"fix" it: the AI pipeline depends only on Sprint 0's schema and Sprint 1's
incidents (`incident.raw_narrative` is its whole input). It has no
dependency on the mobile app (S2), GPS/sync (S3), or notifications (S4).
Sprints 2 and 3 are coded-but-unverified (previous two entries); Sprint 4
is untouched.

## Scope note (why two Sprint 6 endpoints landed here)

Sprint 5's box is "ai_processing_log table + job queue"; the endpoints
that *produce* queue rows (`POST /incidents/:id/redact`) and *read* the
result (`GET /incidents/:id/ai-draft`) are the first box of Sprint 6.
Built here anyway, because a queue with no producer and no reader cannot
be exercised at all — the box would ship as an untestable abstraction.
Same "necessary plumbing" precedent as W2's minimal login page (Sprint 1)
and the Ionic scaffold (Sprint 2). What was NOT pulled forward, and is
still genuinely Sprint 6: `regenerate-summary`, and `approve` — the
latter being the sole endpoint permitted to commit
`incident.redacted_narrative` (§2 Rule 3), which deserves its own review
rather than being folded into a queue cut.

## What already existed (checked before writing anything)

- **`ai_processing_log` and `ai_evaluation_run` were already migrated** in
  Sprint 0's baseline schema (`0001_baseline_schema.sql` lines 397/419) —
  confirmed by reading the migration, not by trusting DEVLOG. So Sprint
  5's "ai_processing_log table" half was already done; only the queue was
  missing. **No new migration was needed for any of this cut.**
- **`GET /system/health` already had an `ollama` field**, but it was an
  env-var-presence check (`OLLAMA_URL` set ⇒ `healthy`) — honest for a
  sprint where nothing could talk to Ollama, but wrong now that something
  can. Upgraded to a real probe.

## Resolved decisions (logged, don't reopen without review)

**The queue IS `ai_processing_log`, not a second store.** §5 already
gives that table a `status` ENUM of exactly
`queued|processing|completed|failed|superseded` — a state machine,
already designed and migrated. Adding Redis/a jobs table beside it would
create two sources of truth for "what is the current draft", and §5's own
invariant ("one current redaction/summary pipeline row is enforced
transactionally per incident") would then be enforceable in neither.

**The API never calls Ollama. Only the worker does.** `POST
/incidents/:id/redact` INSERTs a `queued` row and returns; nothing in any
request path touches the model. This is what makes Rule 15's "AI jobs
queue" structural rather than aspirational — a workstation with Ollama
stopped, uninstalled, or still pulling accepts redaction requests
identically and drains them whenever `backend/scripts/ai-worker.php` next
runs. It also means no web request can ever hang for the minutes an 8B
CPU inference legitimately takes.

**Claiming a job is a compare-and-set UPDATE, not `SELECT … FOR UPDATE
SKIP LOCKED`.** `SKIP LOCKED` is MariaDB 10.6+/MySQL 8+; §1 pins this
deployment to MariaDB 10.4 via XAMPP. This codebase has already been
bitten once by assuming a newer engine feature (Sprint 0's `CHECK`
constraint trap, `ERROR 1901`). So the worker selects a candidate id, then
runs `UPDATE … SET status='processing' WHERE log_id=? AND
status='queued'` and treats `rowCount()===1` as winning the row — atomic
on any engine, no lock hints needed.

**`not_configured` and `unhealthy` are answered differently, everywhere.**
§6 draws that distinction and this cut honours it in three places:
`OLLAMA_URL`/`OLLAMA_MODEL` unset ⇒ health reports `not_configured` AND
`POST …/redact` returns `503` (we cannot record an *intended* model when
`ai_processing_log.model_version` is NOT NULL and no model is named —
queueing would mean inventing one). Configured but the service is down ⇒
health reports `unhealthy`, and redaction still queues happily, because
that is precisely the case Rule 15 exists for.

**A reachable Ollama with the model not pulled is `unhealthy`, not
`healthy`.** Every AI job on that workstation will fail until someone runs
`ollama pull`; a green badge there would be exactly the fabricated status
§8 forbids. The health probe uses `GET /api/tags`, which proves service
reachability and model presence in one cheap call.

**`model_version` is written twice, deliberately.** At enqueue time it is
the *intended* model (best available answer while a job is queued); the
worker overwrites it with the model the server reports it actually ran.
Rule 16 requires recording the model version of a run — the run's own
report is the authoritative one.

**Reasoning-trace stripping is a security control, not formatting.** §1
pins the model to `Llama-SEA-LION-v3.5-8B-R` — the `-R` is the REASONING
variant, which emits `<think>…</think>` blocks. A reasoning trace
routinely restates the original narrative while working through it, so
persisting it verbatim into `draft_redacted_narrative` would put the exact
names the redaction just removed straight back into the draft, defeating
the pipeline and violating Rule 1. `AiPrompts::stripReasoning()` runs on
every completion before anything is persisted, and fails safe on a
truncated/unclosed `<think>` by dropping rather than keeping.

**Summary failure keeps the redaction and blocks approval.** If step 1
succeeds and step 2 fails (Ollama dies between the two calls), the row
completes with `draft_summary_stale=true` rather than failing outright.
§6 makes `draft_summary_stale=false` a hard prerequisite for approval, so
this is visible and correctable via regenerate-summary — strictly better
than discarding a good redaction because a second call timed out. This
also finally gives `draft_summary_stale` a reachable producer: no
documented endpoint edits a draft *without* regenerating, so a failed
summary step is the realistic way that flag becomes true.

**A rerun starts at `draft_version = 1`.** Rule 23 ties the version to
"every ACTIVE draft", and a new pipeline run supersedes the old draft
entirely — continuing the superseded row's numbering would imply the new
draft is a revision of text it never saw.

**Prompts live in one versioned file with a closed placeholder
vocabulary.** `AiPrompts::PROMPT_VERSION` exists so Sprint 6's evaluation
harness can say *which* prompt produced a precision/recall number; a
prompt edited inline in the worker would silently invalidate every prior
`ai_evaluation_run` with no trace. The placeholder set
(`[NAME] [ADDRESS] [PHONE] [EMAIL] [ID_NUMBER] [DATE_OF_BIRTH]
[PLATE_NUMBER] [ACCOUNT]`) is closed for the same reason — Sprint 6's
baseline regex comparator has to score the same categories the model was
asked to produce, or the two are incomparable.

**`GET .../ai-draft` returns `error_code` beyond §6's listed shape.** A
Secretary looking at `status:"failed"` with no reason has a dead end, and
§9's Loading/Empty/Error/Populated rule exists to prevent exactly that.
Same precedent as `officer_name` on `GET /incidents`.

**Translation responses carry `language_validated`.** Rule 16 treats Bikol
as unvalidated pending empirical testing, and Sprint 5's own prompt says
not to let the UI imply Bikol is production-quality. A boolean a screen
can actually read is the only form of that warning which survives contact
with a real UI; `en`/`fil` are true, `bcl` is false until a real
`ai_evaluation_run` says otherwise.

**Voice-to-text: OUT of scope for the capstone (§10 updated).** This was
flagged as an open S5–6 "scope confirmation"; leaving it implicit would
let it drift into an assumed deliverable. Voice *capture* stays (already
built in Sprint 2 as evidence attachments); *transcription* is out, for
four reasons recorded in full in §10 of the Master Reference: (1)
Android's default `SpeechRecognizer` sends audio to Google, which is Rule
1's exact prohibition; (2) server-side ASR means a second self-hosted
model (SEA-LION is text-only) on the workstation §15 already calls a
single point of failure; (3) Bikol ASR is even less validated than Bikol
text, compounding two unknowns; (4) voice notes already attach as evidence
and are playable, so transcription is a convenience on a working path, not
an unblocker. If revisited, the only acceptable shape is self-hosted ASR
as a second queued `task_type` on this same queue — never a cloud speech
API. **The user can overturn this; it is recorded as resolved rather than
left open because the sprint prompt explicitly requires a decision.**

## Files

**New:**
- `backend/services/ai/OllamaClient.php` — the only place this codebase
  talks to the model. `isConfigured()`, `listModels()`,
  `isModelAvailable()`, `generate()`. No fallback branch exists that could
  reach a hosted provider (Rule 1 made structural).
- `backend/services/ai/OllamaUnavailableException.php` — "requeue the job".
- `backend/services/ai/OllamaException.php` — "fail the job". Separate
  files, one class each: this codebase already lost time to an
  autoloader/one-class-per-file violation once (Sprint 1's entry).
- `backend/services/ai/AiPrompts.php` — the three prompts, `PROMPT_VERSION`,
  the closed placeholder set, and `stripReasoning()`.
- `backend/services/ai/AiJobQueue.php` — `enqueueRedaction()` (with the
  transactional supersede that enforces §5's one-current-pipeline
  invariant), `enqueueTranslation()`, `currentDraft()`,
  `currentDraftForUpdate()` (row-locked, ready for Sprint 6's
  regenerate/approve), `claimNextQueuedJob()`, `rawNarrativeFor()`,
  `completeRedaction()`, `completeTranslation()`, `fail()`, `requeue()`,
  `requeueStaleProcessing()`, `depth()`.
- `backend/controllers/AiDraftController.php` — `redact()`, `draft()`,
  `translate()`.
- `backend/routes/ai.php` — the three routes.
- `backend/scripts/ai-worker.php` — the CLI worker. `--once`, `--max=N`,
  `--daemon`, `--status`, `--recover`.
- `backend/scripts/README-ai.md` — how to run Ollama + the worker, the
  three health states, and what the pipeline actually does.

**Modified:**
- `backend/controllers/SystemHealthController.php` — `ollama` upgraded
  from env-presence to a real probe.
- `backend/.env.example` — `OLLAMA_URL`, `OLLAMA_MODEL`,
  `OLLAMA_TIMEOUT_SECONDS`, with an explicit note that leaving them blank
  is a valid honest state.
- `docs/Baranguard_Master_Reference_FINAL .md` — §10's voice-to-text item
  marked resolved, with the full reasoning.

## Output discipline (worth stating explicitly)

The worker prints identifiers, statuses, timings and character COUNTS
only — never `raw_narrative`, a draft, a summary, or a translation. A
worker that echoed drafts would leak into terminal scrollback, a
redirected logfile, or a CI transcript exactly what the redaction pipeline
exists to remove. Audit metadata follows Rule 17's allow-list the same
way: `pipeline_run_id`, `log_id`, `target_language` — no content.

## Static checks actually run (the only verification this session performed)

`php -l` on all nine new/modified PHP files — all clean. That is a PARSE
check; it proves nothing about authorization, SQL correctness, the queue's
concurrency behaviour, or whether the model produces usable redactions.

## NOT done this session — stated plainly

- **No `verify-*.sh` for any of this**, and no live HTTP request against
  `POST /incidents/:id/redact`, `GET /incidents/:id/ai-draft`,
  `POST /incidents/:id/ai-draft/translate`, or the upgraded
  `GET /system/health`.
- **The worker has never been executed** — not against a real Ollama, not
  against a stub. Every claim about claim/requeue/fail behaviour is
  design intent, not observed behaviour.
- **The model has never been called.** No redaction, summary, or
  translation has been generated. Prompt quality is completely unmeasured
  — and prompt quality is the entire deliverable of Sprint 6's evaluation
  harness, so nothing here should be read as "the redaction works".
  `stripReasoning()`'s handling of real SEA-LION `-R` output is
  reasoned-from-documentation, not observed.
- **`draft_summary_stale`'s failure path is untested**, as is the
  Ollama-dies-mid-pipeline case that produces it.
- **Nothing is committed.** This sits in the working tree alongside the
  uncommitted Sprint 2/3 work from the previous session.

## Suggested order for the follow-up verification session

1. `php scripts/ai-worker.php --status` — cheapest possible smoke test;
   proves env loading, DB access, and Ollama reachability in one command.
2. `GET /system/health` as an Admin, three times: with `OLLAMA_URL`
   unset (`not_configured`), set with Ollama stopped (`unhealthy`), and
   set with it running and the model pulled (`healthy`).
3. A `backend/scripts/verify-sprint5.sh` against real XAMPP: Secretary-only
   gating on all three endpoints (Admin/Tanod/PB → 403), cross-tenant →
   404, `redact` on a finalized-blotter incident → 409, rerun supersedes
   the prior row (verify in the DB that exactly one non-superseded
   pipeline row remains), `translate` without approval → 409, bad
   `target_language` → 400, and `503` on all of it with `OLLAMA_MODEL`
   unset.
4. **Then the real model run** — the part nothing else substitutes for:
   queue a redaction against a seeded incident containing deliberately
   planted PII (names, a phone number, a house address), run the worker,
   and read the resulting row. Check specifically that (a) no `<think>`
   block survived into `draft_redacted_narrative`, (b) the planted
   identifiers are gone, (c) the summary contains no identifier the draft
   didn't, and (d) `model_version` records what actually ran.
5. Kill Ollama mid-job and confirm the row returns to `queued`, not
   `failed` — the single most important behaviour in this cut.

---

# DEVLOG — Sprint 6: approval loop, blotter finalization, W8 review screen

## Today's cut

Worked from an approved written plan (`.claude/plans/`), which split Sprint
6 into five phases. This session built **Phase 1 (approval loop), Phase 2
(blotter finalization), and Phase 4 (W8 screen + `GET /incidents/:id`)**.

Two phases were deliberately NOT built, both at the user's explicit
direction mid-session:
- **Phase 0 (execute the Sprint 5 pipeline against the real model)** —
  stopped after the first smoke test; the user is running the model on a
  more capable laptop instead.
- **Phase 3 (evaluation harness)** — it is evaluation work that only means
  anything once the model can actually be run, so it belongs with that
  same machine.

Sprint 6's first menu box (`POST /incidents/:id/redact` +
`GET /incidents/:id/ai-draft`) was already built in Sprint 5.

## What Phase 0 did establish before it was stopped

This is the first time any of the Sprint 5 AI code has EVER executed, so
the little that ran is worth recording precisely:

- `php scripts/ai-worker.php --status` → **worked**:
  `Queue: 0 queued, 0 processing, 0 completed, 0 failed.` /
  `Ollama: reachable, model 'aisingapore/Llama-SEA-LION-v3.5-8B-R' present.`
  That single command proves env loading, the `$_ENV`/`getenv()`
  precedence chain, DB connectivity, the queue-depth query, Ollama
  reachability over HTTP, and model presence.
- It also exercised `OllamaClient::isModelAvailable()`'s tag-stripping:
  `.env` names the model without a tag, `ollama list` reports
  `...-R:latest`. A naive string comparison would have reported the model
  missing on a perfectly good install; the pre-tag comparison handled it.
- `backend/.env` had no `OLLAMA_*` keys (Sprint 5 only added them to
  `.env.example`). Appended them; a `.env.bak-preollama` backup was left
  behind and is covered by `.gitignore`'s `.env.*`.
- **The model itself was never invoked.** No redaction, summary, or
  translation has been generated. `stripReasoning()`'s handling of real
  SEA-LION `-R` output remains reasoned-from-documentation, not observed —
  and it is the single highest-risk untested thing in the AI pipeline.

## Verification actually performed this session

**`backend/scripts/verify-sprint6.sh` — 112/112 checks passed against real
XAMPP (MariaDB + PHP 8.2), zero failures** (it grew from 79 to 112 across
this entry as W7's endpoints and the browser-found fix were added).** This is a genuine verification
pass, not a parse check, and it covers every backend endpoint in this cut.

**It runs without Ollama, on purpose.** The approval gate does not care HOW
a draft reached `ai_processing_log` — only what the row says. So the script
seeds completed draft rows with SQL and exercises the gates against them.
Better still, it exports `OLLAMA_URL` pointing at a **dead port** for the
whole run: every endpoint still behaved correctly, which is positive proof
that the request path only ever enqueues (Rule 15) rather than calling the
model. That makes this script runnable on any machine, forever, including
CI.

What it actually proved, beyond role/tenant gating on all five new
endpoints:

- **Optimistic concurrency really works.** A stale `draft_version` gets 409
  AND `draft_version` in the database is verifiably unchanged afterwards —
  checked by direct SELECT, not by trusting the response.
- **Every approval prerequisite blocks independently**: status still
  `queued` → 409; wrong version → 409; text not matching the stored draft →
  409; `draft_summary_stale=true` → 409. After all four rejections,
  `redacted_narrative` was still NULL — no partial write leaked through.
- **The happy path commits correctly**: `redacted_narrative`,
  `redaction_approved_by`, and `redaction_approved_at` all set, confirmed by
  SELECT, with exactly one audit row.
- **Idempotent replay behaves as designed**: repeating an approval with
  identical text returns 200 and writes **no second audit row**; repeating
  with different text is a 409.
- **`blotter_revision` earns its migration**: after an amendment, the
  current row holds the new text and revision 1's original text is still
  retrievable from `blotter_revision` — §6's "never deletes the previous
  finalized value", demonstrated rather than asserted.
- **Double-finalize is refused and the original summary survives it.**
- **The Lupon packet is a real PDF** (`%PDF-` magic bytes), written to
  protected storage, downloadable by the Secretary, 403 for Admin — and
  grepping the file confirms **the raw narrative does not appear in it**.
- **Bikol honestly reports `language_validated:false`** while Filipino
  reports true (Rule 16).

Also executed: **migration 0004 against a live disposable MariaDB** — applies
on top of 0001, `DESCRIBE` returns the expected seven columns, re-running is
a no-op (`IF NOT EXISTS`), the down migration drops it cleanly, and both
foreign keys were accepted by MariaDB 10.4.

Also executed: **the PDF writer's output was structurally validated** — a
generated packet was parsed byte-wise to confirm the `%PDF-1.4` header, the
`%%EOF` trailer, that `startxref` points at the literal `xref` keyword, and
that **all 8 cross-reference offsets point exactly at their `N 0 obj`
markers** (zero mismatches). A wrong xref offset is the most common way a
hand-written PDF fails to open, so this was the check worth automating.
Long text correctly paginated to 2 pages.

## Resolved decisions (logged, don't reopen without review)

**`regenerate-summary` queues; it does not generate inline.** §6's response
shape reads as though a finished summary comes back, but an 8B CPU model
takes minutes and Sprint 5 made "the API never calls Ollama" structural
(Rule 15). So the endpoint does the *concurrency-critical* work
synchronously inside one transaction — version equality check, save the
Secretary's edited text, increment `draft_version`, set
`draft_summary_stale=true`, re-queue — and the worker produces the summary.
This finally gives `draft_summary_stale` a natural producer: between the
edit and the regeneration the stored summary genuinely does describe
superseded text, and §6 makes that a hard block on approval for exactly
that window.

**The worker tells a summary-only run from a full redaction by the DATA,
not a flag.** A queued row that already has a `draft_redacted_narrative`
can only be a regeneration; a fresh redact enqueue has that column NULL.
Chosen over adding a marker column because it makes the guarantee
structural: the summary-only path physically cannot read `raw_narrative`
(Rule 16) or overwrite the Secretary's edits.

**Approval replays idempotently on identical text, 409s on different
text.** A Secretary double-clicking Approve, or a retried request, would
otherwise get a conflict for an operation that already succeeded — the
same replay pattern `POST /dispatch` and `POST /incidents` already use. A
repeat with *different* text is a real 409: changing an approved redaction
is the amendment workflow's job.

**Approval does NOT delete `raw_narrative`.** §11 gives a 30-day
post-approval grace period; that deletion belongs to Sprint 7's retention
jobs, not to the approval transaction.

**Blotter amendment needed a new table (migration 0004).** §6 says an
amendment "never deletes the previous finalized value", but
`blotter_record` has a single `narrative_summary` column, so an amendment
necessarily overwrites it — the prior text had nowhere to live. Rejected
storing it in `audit_log.metadata_json`: Rule 17 allow-lists audit metadata
to identifiers and statuses. `blotter_revision` holds each superseded
version; `amend()` copies the current text there *before* overwriting, so
the live row is always current and every prior version stays retrievable.

**`finalize`/`amend` are Secretary-only, and Admin is deliberately
excluded** even though Admin outranks Secretary everywhere else. §3: RA
7160 §394(c) makes the Barangay Secretary the statutory custodian of
barangay records. Flagged in the controller doc so a later session doesn't
"fix" the asymmetry.

**`GET /incidents/:id` is the only endpoint that returns `raw_narrative`,
and only to a Secretary.** The allow-listed payload is built first and the
raw field is appended last, inside a single role check — so the safe shape
is the default and raw access is the visible exception rather than
something to notice by its absence.

**`POST /incidents/:id/lupon-packet` was NOT built.** It needs PDF
generation and this repo has no PDF library and no Composer. Vendoring one
(FPDF) or rendering print-styled HTML is its own scoped decision, not a
rider on this cut. No route was registered — an honest 404 beats a route
that 500s.

**W8 has no sidebar nav entry.** It is a per-incident detail view and
cannot render without an incident id, so a nav item would link to a broken
screen. It is reached by clicking a row in W6 Electronic Blotter (Secretary
only; for other roles the rows stay non-interactive rather than opening a
screen the server would refuse), and reports `blotter` as the active nav
item. `main.js` gained a `DETAIL_PAGES` set so such a page is never chosen
as a role's default landing page and falls back if reached without its
parameter.

**W8 shows no confidence score at all.** §8 explicitly calls out the Figma
mockup's fabricated 94%/95%/78-out-of-100 numbers. None is backed by an
`ai_evaluation_run` yet, and a plausible-looking percentage would be
fabricated data — worse than none. The model badge shows the row's real
`model_version`, and the "generating" state polls the server's actual
`status` rather than running a `setTimeout`.

## Bug caught while writing (before it ever ran)

`ai-review.js`'s first draft declared `let this_textarea` and
`let actionRefs` *after* the function's `return` statement. Function
declarations hoist, but `let` does not initialise until control flow
reaches it — and control flow never does, because `return` exits first. The
async `render()` that assigns to them would have thrown
`ReferenceError: Cannot access 'this_textarea' before initialization` on
every single load. Moved both declarations above the `return` and renamed
to `draftTextarea`. Worth remembering as a category: in this codebase's
"return a handle, then declare helpers below" page pattern, only *function*
declarations are safe below the return — `let`/`const` are not.

Also caught before running: the first draft used `.muted`,
`.card__header`, and `.card__actions` — classes that exist in the MOBILE
app's `theme/app.css`, not the web dashboard's `base.css`. Replaced with
the web's real `.note` plus two new page-scoped classes.

## Files

**New:**
- `backend/controllers/BlotterController.php` — `finalize()`, `amend()`,
  `show()`.
- `backend/routes/blotter.php`.
- `backend/migrations/0004_blotter_revision.sql` + `.down.sql`.
- `backend/services/ai/RegexRedactor.php` — the Phase 3 baseline
  comparator. **Nothing references it yet**; written before Phase 3 was
  deferred, kept because the evaluation harness will need it verbatim.
  Remove it if the orphan bothers you.
- `web/src/pages/ai-review.js` + `ai-review.css` — W8.

**Modified:**
- `backend/controllers/AiDraftController.php` — `regenerateSummary()`,
  `approve()`.
- `backend/controllers/IncidentsController.php` — `show()`.
- `backend/services/ai/AiJobQueue.php` — `saveEditedDraftForSummary()`,
  `completeSummary()`.
- `backend/scripts/ai-worker.php` — `runSummaryOnlyJob()` + dispatch.
- `backend/routes/ai.php`, `backend/routes/incidents.php`.
- `web/src/api/apiClient.js` — 8 methods (incident detail, draft, redact,
  regenerate, approve, translate, finalize, amend).
- `web/src/main.js` — `ai-review` route, `DETAIL_PAGES`, parameterised
  `navigate`.
- `web/src/pages/blotter-list.js` — Secretary row-click into W8.
- `web/index.html` — page stylesheet link.

## Follow-up in the same session: W7, W8's post-approval controls, and a web wiring check

The entry above closed with "finalize/amend are verified endpoints with no
UI calling them" as Sprint 6's biggest gap. That is now closed too.

- **W7 Electronic Blotter Detail** (`web/src/pages/blotter-detail.js`) —
  the Secretary's finalize/amend screen, plus a real timestamp timeline
  built only from API values (§9 W7: "never a scripted one"; a stage that
  has not happened shows as pending rather than being invented). Finalize
  and amend both go through `confirmDialog()` first, since neither is
  reversible in the ordinary way.
- **`GET /incidents/:id/blotter`** — built after all, because W7 works
  from an incident id and `GET /blotter/:id` needs an id it does not have.
  It stopped being unused scaffolding the moment W7 existed.
- **W8 gained its post-approval controls** (§9 puts them there): a
  language picker + queue-translation button that surfaces
  `language_validated:false` for Bikol in the toast rather than hiding it,
  and generate/download for the Lupon packet.
- **Row-click flow corrected.** Blotter rows now open W7 for every role
  that can read the list, and W7 links to W8 — matching the real workflow
  (review entry -> approve redaction -> finalize -> packet). Previously
  rows opened W8 directly and only for Secretary.
- **`web/scripts/verify-web-wiring.mjs`** (NEW) — a static wiring check
  for a stack with no bundler and no test runner: it resolves every
  relative import against the target module's actual exports, and verifies
  every literal CSS class used from JS is defined in a stylesheet
  `index.html` actually links. **286 checks, 0 failures** across all web
  modules. This exists because the first draft of W8 used `.muted` /
  `.card__header` / `.card__actions` — real classes, but from the MOBILE
  app's stylesheet, which would have rendered as unstyled text with no
  error anywhere. `node --check` cannot see that; this can.
  - Writing it surfaced two genuine false-positive classes that were
    fixed rather than papered over: a computed class like
    `` `toast--${variant}` `` leaves a dangling `toast--` literal (now
    skipped), and `kpi-card` is a real marker class with no styles of its
    own (allowlisted, with the reason written next to it).
  - Honest limit, recorded in the script's own header: it does NOT catch
    undefined identifiers. The other W8 bug — `${API_BASE_URL}` where the
    constant is named `BASE_URL` — needs real scope analysis, i.e. a
    linter dependency this project has not taken on.

### W7 was still incomplete — finished in the same session

A check of W7 against §9's actual wording (rather than against memory)
found three gaps. §9 lists five APIs for W7 and only three were wired:

- **`GET /incidents/:id/evidence`** — endpoint did not exist. Built.
  §6's "never returns filesystem paths" is honoured by omitting
  `file_path` from the response shape entirely rather than filtering it
  late; the test asserts the path string cannot be found anywhere in the
  body. Punong Barangay is deliberately NOT on the role list — §6 names
  only Secretary/Admin/Tanod, and PB's access elsewhere is "redacted
  read-only", which evidence files are not.
- **`PATCH /incidents/:id/status`** — endpoint did not exist. Built,
  Admin-only, body exactly `{status:"resolved"}` and nothing else, with
  §6's two prerequisites enforced transactionally: the incident must be
  `dispatched`, and no dispatch may still be active. A repeated resolve
  falls out as 409 naturally, since an already-resolved incident is no
  longer `dispatched`.
- **The timeline was missing `dispatched_at` and `arrived_at`**, both
  named explicitly in §9. Those live on the dispatch row, so
  `GET /dispatch` gained an `incident_id` filter — narrowing an
  already-tenant-scoped list discloses nothing the caller could not
  already fetch unfiltered.

W7 now also carries the Admin resolve control, shown only when the real
dispatch/state prerequisites are met (§9: "Admin incident resolution is
shown only when the dispatch/state prerequisites are met") and disabled
with the specific reason otherwise, so it can never be a button that 409s
on click.

Verification at this point in the session: `verify-sprint6.sh` 104/104 and
the wiring check's 287, both green on consecutive runs. (Both counts moved
again afterwards — see the browser-pass section below for the final
112/112 and 286.)

**One flaky observation, recorded rather than hidden:** on a single run,
the "Approval wrote an audit row" check returned an empty string instead
of a count — an empty result implies the query itself failed, not that the
audit row was missing. It has not reproduced across three subsequent full
runs (104/104 each). Most likely this project's already-documented stale
`php.exe`-bound-to-the-port issue, but that is a hypothesis, not a
diagnosis — if it recurs, capture the mysql stderr before assuming the
approval path is at fault.

## The browser pass — and the two real bugs only it could find

The user asked whether the UI actually worked, so W7/W8 were finally driven
in a real browser against a disposable rig (own database, own API port on
8137, a repointed copy of `web/` on 8138, throwaway Secretary/Admin
accounts, all torn down afterwards; the real `baranguard` database was
never touched). It immediately found two things every static check had
passed:

**1. A Secretary gets 403 on `GET /dispatch`, so W7's timeline was
fabricated.** §6 lists that endpoint as Admin/PB/Tanod only — Secretary is
not on it. W7 called it for the `dispatched_at`/`arrived_at` stages §9
requires, the call 403'd, and a `.catch(() => [])` swallowed it. The
timeline then rendered **"Not yet" for stages that had definitely
happened** — precisely the scripted/fabricated timeline §9 forbids, and
invisible to `php -l`, `node --check`, the wiring check, and the 104-check
backend suite, because every one of those components was individually
correct.

Fixed by moving the two timestamps (plus a derived `has_active_dispatch`)
onto `GET /incidents/:id`, which the Secretary may read. Widening
`GET /dispatch`'s role list was rejected: it would hand the Secretary the
whole dispatch record — assignments, route, tanod ids — to obtain two
timestamps §9 says must be on screen. W7 now makes no `/dispatch` call at
all, which also removed the swallowed-error path entirely.

**2. A patch of mine silently no-oped, and my own check of it was a false
positive.** The `getDispatches({incidentId})` edit targeted a multi-line
form of a call that is actually written on one line, so `str.replace` did
nothing. The verification line I printed — `"incident_id: incidentId" in s`
→ True — matched `createDispatch`'s *body* elsewhere in the file, not the
edit. I reported it as applied when it was not. The lesson is specific and
worth keeping: **assert on the thing you changed, not on a substring that
can occur elsewhere** — later patches in this session were changed to
`assert s != before` and to re-grep the exact target.

What the browser pass confirmed working, with hard assertions rather than
a glance at a screenshot:

- W7: all five §9 timeline stages populate in chronological order
  (reported → dispatched → arrived → approved → finalized); `Evidence (2)`
  lists real attachments; the evidence filesystem path appears **nowhere**
  in the DOM; the amend form appears only because the blotter is finalized.
- W8: the model badge shows the real `aisingapore/Llama-SEA-LION-v3.5-8B-R`
  — no vendor name; **no confidence/accuracy number anywhere**; Approve is
  disabled with the true reason ("This incident already has an approved
  redaction"); the raw panel shows the real names while the draft textarea
  holds `[NAME] [ADDRESS] [PHONE]`, i.e. side-by-side genuinely works.
- Row-click into W7 works, with the new open-hint affordance rendering on
  every row.

**Browser-tool flakiness, recorded so it isn't re-diagnosed:** the pane
navigated the app between separate `javascript_exec` calls more than once
(landing on Settings, and on a detail screen, unprompted). The prior
DEVLOG entry documents the same class of problem with this tool. The
workaround that made the pass reliable was doing an entire flow —
navigate, click, assert — inside ONE evaluation, so nothing could
intervene mid-sequence.

Suite after the fix: **`verify-sprint6.sh` 112/112** (eight new checks,
including that a Secretary really does get 403 on `/dispatch` — the
reason those fields live on the incident endpoint — and that a
never-dispatched incident reports `null` rather than a fabricated time)
and **286 wiring checks**.

## NOT done — stated plainly

- **Only W7 and W8 were opened, and only as a Secretary and against seeded
  data.** No Admin or Punong Barangay browser pass, and no pass over the
  other nine screens.
- **Evidence files cannot be downloaded from W7.** The list is there, but
  §6's evidence endpoint returns no path by design and no authorized
  byte-serving endpoint exists yet (Sprint 7). W7 says so in plain text
  rather than offering a link that would 404.
- **Phase 3 (evaluation harness)** — deferred by decision. No dataset, no
  scoring, no `ai_evaluation_run` row has ever been written; the ≥95%/≥90%
  target is unmeasured. `docs/AI_Evaluation_Dataset_Guide.md` was written
  this session so the three-person dataset build can start immediately
  without the model.
- **The model still has never been called.** Everything verified above was
  verified with seeded rows and a dead Ollama port. Whether the redaction
  is any *good* is a completely separate question that only the evaluation
  harness can answer.

## Suggested order for the follow-up session

1. On the capable laptop: finish Phase 0 (queue a redaction with planted
   PII, run the worker, confirm no `<think>` survives and the identifiers
   are gone; then kill Ollama mid-job and confirm the row returns to
   `queued`).
2. Apply migration 0004 to the real database — nothing else in Sprint 6
   works without `blotter_revision`.
3. `verify-sprint6.sh`: role gating on all five new endpoints, stale
   `draft_version` → 409 **with the incident row verifiably unchanged**,
   approval blocked while `draft_summary_stale=true`, text-mismatch → 409,
   successful approval confirmed by direct SELECT, double-finalize → 409,
   and an amendment leaving the prior text retrievable from
   `blotter_revision`.
4. Browser pass on W8 as a real Secretary account.
5. Then Phase 3's evaluation harness, which is the only thing that can
   answer whether the redaction is actually good enough to rely on.

---

# DEVLOG — Sprint 4 Phase 1: notification model, Tanod SOS, acknowledgment

## Today's cut

Worked from an approved written plan that split Sprint 4 into five phases.
This entry covers **Phase 1 — the notification core and SOS**, taken first
because it is the one gap with real-world safety consequences: §2 Rule 27
calls SOS a personal-safety channel, and until now `POST /tanod-sos` did
not exist, M2's SOS button was visibly disabled, and `/sync/batch` answered
every `sos[]` item with "not supported until Sprint 4".

Phases 2–5 (FCM/SMS transports, the ack-timeout worker, the inbound
`/sms/*` handlers and envelope crypto, W14, M12/M13) are NOT in this cut.

## Verification

**`backend/scripts/verify-sprint4.sh` — 48/48 against real XAMPP.**

**No transport is configured when it runs, deliberately.** There is no GSM
modem, no funded Semaphore account and no FCM credentials on this machine,
and per Rule 12 "no active FCM registration" is a legitimate state the
model must record rather than paper over. So the suite asserts the LOGICAL
layer, which is fully determinable without sending anything — and it
therefore runs anywhere, forever.

What it actually pins down:

- **Rule 27's fan-out, exactly**: an SOS targets the Admin and the *other*
  on-duty Tanod, and the suite asserts the off-duty Tanod is **not**
  targeted and the raiser is **not** alerted to their own emergency.
- **SOS never depends on dispatch triage** — asserted by checking that
  raising one creates **zero** incidents.
- **Coordinates are never audited.** Rule 17 allow-lists audit metadata and
  an SOS location is a person's position; the suite greps the audit row for
  the seeded latitude and asserts it is absent.
- Idempotent replay on `client_event_id` returns the original `sos_id` and
  **raises no second alarm**.
- Acknowledge does **not** resolve (§9's W3 banner must stay up), and a
  repeat acknowledge keeps the ORIGINAL timestamp.
- `POST /notifications/:id/ack` is idempotent and keeps the first
  timestamp — which matters because overwriting it would corrupt §6's
  `avg_ack_seconds` by rewarding a duplicate tap.
- **Rule 24 made concrete**: acknowledgment creates **no**
  `notification_delivery` row. Logical acknowledgment and transport
  outcome are separate truths.
- `POST /dispatch` now creates its notification, targeting exactly the
  assigned Tanod — closing the deferral Sprint 1 wrote into
  `DispatchController`'s own class doc.
- `/sync/batch`'s `sos[]` works, and a queued offline SOS fans out
  identically to a live one.

## Resolved decisions (logged, don't reopen without review)

**The entity-integrity matrix is enforced in PHP, and the suite proves why
that is necessary rather than lazy.** §5 states the matrix but also says a
table-level CHECK cannot express it — Sprint 0 confirmed MariaDB rejects
that CHECK with ERROR 1901, because `dispatch_id`/`sos_id`/`incident_id`
all carry `ON DELETE SET NULL`. Step 8 of the suite therefore inserts a
malformed notification **directly via SQL and asserts the database ACCEPTS
it**, then asserts `NotificationService` rejects all four bad type/entity
combinations. That is the difference between claiming an application-level
invariant and demonstrating the application is genuinely the only thing
holding it.

**SOS "on-duty" includes `responding`; dispatch assignment does not.**
`DispatchController` excludes `responding` because it needs a *free* Tanod.
An SOS wants every able body nearby, including one already handling
something else — so `NotificationService::sosRecipients()` accepts
`on_duty` OR `responding`. Same words, deliberately different meaning;
worth not "harmonising" later.

**The SOS row and its fan-out share one transaction.** A notification that
outlived a rolled-back SOS would be worse than none. Conversely the fan-out
must never fail the request on transport grounds — with nothing configured
to send, the SOS is still recorded and still shows on W3's banner, because
answering 500 would tell the app "SOS failed" for an emergency the server
actually knows about.

**A repeat acknowledge uses `COALESCE`** rather than overwriting, so two
Admins reacting simultaneously is a non-event rather than a race.

## A recurring test-harness flake, diagnosed enough to mitigate

A `db_one` COUNT returned an **empty string** instead of a number — once in
`verify-sprint6.sh`'s audit check, once here. An empty result from
`mysql -N -s` means the client failed, not that the count was zero, and
neither case reproduced in isolation (the exact failing JOIN was re-run
standalone and returned the right answer). The likely cause is connection
churn: every call spawns a fresh `mysql.exe` and TCP connection, and a long
suite makes dozens in quick succession on Windows.

`db_one` in **both** suites now retries once. That is a mitigation, not a
root-cause fix, and it says so in the code — but it removes a false failure
that would otherwise be mistaken for a real bug in the code under test,
which is the more expensive outcome.

## Files

**New:** `services/notifications/NotificationService.php`,
`controllers/NotificationsController.php`, `routes/notifications.php`,
`scripts/verify-sprint4.sh`.

**Modified:** `controllers/TanodSosController.php` (create/acknowledge/
resolve added to the Sprint 1 read-only shell),
`controllers/DispatchController.php` (notification on create; the stale
"deferred" note retired), `controllers/SyncController.php` (`sos[]` now
works), `routes/tanod-sos.php`, `scripts/verify-sprint6.sh` (db_one retry).

## NOT done — stated plainly

- **Nothing is actually delivered to anyone.** Phase 1 records who should
  be told; no FCM or SMS attempt is made, `notification_delivery` is still
  never written, and a Tanod's phone does not buzz.
- **Rule 12's fallback ladder is unbuilt** (no-registration ⇒ SMS
  immediately; error ⇒ retry once ⇒ SMS; sent-but-unacked ⇒ 60s
  `ack_timeout` with no SMS). That is Phase 2.
- **The inbound `/sms/*` handlers and the encrypted envelope do not exist**
  (Phase 3), so the offline SMS fallback Rule 27 requires is still only a
  local queue on the device.
- **M2's SOS button is still disabled in the mobile app** — the endpoint
  now exists, but wiring the app to it was not part of this cut.
- No live send/receive verification is possible on this machine; that
  remains a workstation task, as Sprint 4's own prompt anticipates.

---

# DEVLOG — Sprint 4 Phases 2-5: FCM/SMS transport, Rule 12 ladder,
# encrypted SMS envelopes + internal router, W14, M12/M13 (closes Sprint 4)

## Today's cut

The user asked to continue through Phase 2 to the end of Sprint 4 in one
session — an explicit multi-box exception, same documented category as
Sprint 3's and Sprint 5's own all-at-once sessions. Unlike those two, the
BACKEND half here (Phases 2-3) is genuinely verified against real XAMPP —
321 checks passing across five suites, zero failures (see Tests below) —
because everything in Phases 2-3 is exercisable without live external
credentials (see the two "no live creds" notes below for exactly why).
Only the mobile half (Phase 5) is coded-but-unverified, for the same
standing reason every mobile cut since Sprint 3 has been: no Android SDK/
emulator exists in this environment.

**Phase 2** — FCM HTTP v1 client, Semaphore SMS client, `NotificationDispatcher`
(Rule 12's fallback ladder), `scripts/notification-worker.php` (the 60s
ack-timeout sweep), wired into SOS/dispatch creation.
**Phase 3** — device secret provisioning (`DeviceSecretVault`), AES-256-GCM
SMS envelope crypto (`EnvelopeCrypto`), the internal-only `/internal/sms/*`
router (`public/internal.php`, structurally separate from `/api/v1`), all
six §6-documented internal endpoints, `GET /sms/logs`.
**Phase 4** — W14 SMS Activity Log (Admin-only, read-only, exactly per
Sprint_Prompts.md's own scoping note).
**Phase 5** — mobile M12 Critical Alert Overlay + M13 SMS Fallback
Confirmation, plus the real `getFcmToken()` implementation neither could
exist without.

**Two deliberate scope trims, both logged rather than silently absorbed:**
GSM-modem OUTBOUND sending (the "+ tethered phone as GSM modem fallback"
half of §1's SMS transport line) and on-device SMS SENDING (Android's
SmsManager, the mobile-side mechanism M13's `sent_by_sms`/`sms_pending`/
`sms_failed` states would eventually come from) are both NOT built this
cut — neither has any hardware/credentials to develop or test against in
this environment, and both are separate, sizeable native/hardware
integrations rather than a rider on this cut (same category judgment as
M7 Live Map's deferred basemap rendering). GSM-modem INBOUND ingestion
(the tethered phone RECEIVING SMS) is NOT trimmed — it's the actual
Phase 3 deliverable, exercised via a real AES-256-GCM envelope built by
`scripts/sms-envelope-build.php`, standing in for hardware that doesn't
exist, the same way this project has always substituted a disposable
database for one it shouldn't touch.

## Two "no live credentials, verify it anyway" notes — read before assuming untested means unverified

**FCM/Semaphore being "not configured" is itself a fully deterministic
code path.** Rule 12's ladder ("no active FCM registration -> SMS
immediately; FCM error -> retry once -> SMS on second failure") treats a
config-absence failure identically to a live-service rejection — neither
distinction exists anywhere in `NotificationDispatcher`. So
`verify-sprint4-phase2-3.sh` genuinely exercises every branch of the
ladder (2 FCM attempts recorded, then exactly 1 SMS attempt, all with
correct `failure_reason`s) with zero live credentials, runnable on any
machine, forever — same principle `verify-sprint6.sh` already established
by pointing `OLLAMA_URL` at a dead port.

**`DEVICE_SECRET_MASTER_KEY` and `INTERNAL_SERVICE_TOKEN` are real local
secrets this suite generates and uses for real.** Envelope crypto, replay
protection, AAD binding, and the internal router's auth gate are not
approximated or mocked anywhere — they are exercised with genuine
AES-256-GCM operations end to end.

## Resolved decisions (logged, don't reopen without review)

**The Rule 12 ladder runs SYNCHRONOUSLY, right after the notification
transaction commits — not queued.** §6 says SOS "immediately attempts
configured FCM/SMS channels," and the same urgency applies to a dispatch
assignment; unlike the AI pipeline (Rule 15: never call the model inline),
nothing in §2 says notifications must be queue-only. Only the one piece
that genuinely cannot happen synchronously — the 60s ack-timeout wait —
is deferred to `notification-worker.php`. A transport failure never
throws out of `dispatchAll()`; every branch is caught internally and
recorded as a `failed` delivery row, and the calling controller
(`TanodSosController`, `DispatchController`) wraps the whole call in
try/catch again as a second line of defence, matching the SOS class doc's
existing "a missing transport is never allowed to fail the request"
principle.

**FCM auth is hand-rolled OAuth2 service-account JWT signing (RS256 via
`openssl_sign`), not a vendor SDK.** No Composer dependency exists in this
repo (same reasoning as `Jwt.php`), and there is no legacy FCM server-key
API left to use — Google shut it down in June 2024, so HTTP v1's
service-account flow is the only option, real or not.

**FCM `data` payload always carries `notification_id`/`notification_type`
as strings.** FCM requires every `data` value to be a string; the mobile
client (`criticalAlertStore.ts`) parses `notification_id` back to a
number before using it, and rejects anything that doesn't parse or isn't
a recognised critical type — never trusts the payload shape blindly.

**The device's SMS-envelope symmetric key is server-generated and returned
ONCE, at a device_id's first-ever registration, in the SAME
`POST /devices/register` response — never a separate endpoint.** §6
defines no key-provisioning endpoint at all; asked-and-resolved the same
way Sprint 2's DB-passphrase-source gap was, except here the "ask" was
answered by the constraint itself: this is genuinely the only point in the
protocol where the device is both authenticated (device ownership already
validated in `DevicesController`) and hasn't yet needed the key. A
re-registration (ordinary FCM-token-refresh) reuses the SAME stored
secret via `COALESCE(device_secret_ref, VALUES(device_secret_ref))` in
one UPSERT — no branch in the SQL, no race window between "check if it
exists" and "write it." Verified in the DB, not just the response: see
Tests below.

**`device_secret_ref` is encrypted at rest under a SEPARATE server-only
master key (`DEVICE_SECRET_MASTER_KEY`), never the device's own key in
plaintext in the database.** `DeviceSecretVault` wraps/unwraps with its
own AES-256-GCM operation, independent of `EnvelopeCrypto`'s (which uses
the device's raw key). Losing the master key doesn't expose past
envelopes retroactively — it only means already-registered devices' rows
can no longer be decrypted server-side, forcing re-registration.

**The SMS envelope's cleartext header fields are bound to the ciphertext
as GCM Additional Authenticated Data (AAD), not left as unauthenticated
metadata.** `device_id` has to travel in the clear — the server needs it
to know which device's key to try before it can decrypt anything — but
binding it as AAD means a captured envelope's ciphertext can't be replayed
under a DIFFERENT device_id header to attempt impersonation; the GCM tag
fails immediately. Verified directly: step 13 of the suite takes a real
envelope, swaps only the header's `device_id` (leaving the ciphertext
untouched), and confirms it's rejected — not by inspection, by actually
doing the attack and watching it fail.

**Envelope replay protection is a DEDICATED table
(`sms_envelope_replay`), not reused from `sms_log.correlation_id`.**
`sms_log.correlation_id` is nullable and shared across many message
types/directions/transports — not a clean fit for a fast, exclusive
"have I seen this exact `message_id` before" check. The dedup itself is
the table's own PRIMARY KEY doing the work: `resolveAndDecrypt()` inserts
the message_id FIRST, before any decryption happens, and a duplicate-key
exception IS the rejection — no separate SELECT-then-INSERT race.

**Envelope max lifetime is capped at 30 minutes (`expiry - created_at`),
independent of whether `message_id` replay-dedup would already catch a
literal replay.** A sender that set a year-long expiry would otherwise
let a leaked device key forge delayed messages within a technically-valid
window; capping the WINDOW itself, not just the specific message_id, is
the more defensible security posture.

**A genuine, undocumented schema gap: `sms_log` had no `barangay_id`.**
§6's `GET /sms/logs` says "Admin own barangay," but `report_id`/
`incident_id`/`dispatch_id` are all nullable and a `duty_status`/
`coord_ping` message can legitimately have all three NULL at once — no
reliable derivation path existed for tenant-scoping those rows at all.
Resolved with migration `0006_sms_log_barangay.sql` (ALTER TABLE, nullable
column, new FK+index) rather than editing the completed 0001 baseline,
same convention as 0003/0004/0005. Every write site in
`NotificationDispatcher`/`SmsGatewayService` now populates it explicitly.

**`GET /sms/logs`'s response NEVER includes `sender_number`/
`receiver_number`, at all — not "returned but masked."** §6's own
documented item shape for this endpoint genuinely omits both fields; "phone
numbers are masked in UI" is read as belt-and-braces guidance for a screen
that might need them later, not license to add an unlisted field on top of
an already-exact contract (§10's own rule: "Do not invent missing API
fields"). Verified directly: the suite asserts neither string appears
anywhere in a real response body.

**The internal `/internal/sms/*` router is a STRUCTURALLY separate front
controller (`public/internal.php`), not a special-cased prefix inside
`index.php`.** §6: "never exposed on the public API surface." `index.php`
only ever globs `backend/routes/*.php`; `internal.php` only ever globs
`backend/routes-internal/*.php` — the two directories never merge, so a
route can never end up reachable from both surfaces by a future edit
mistake. Two independent gates, both required: `REMOTE_ADDR` must be
loopback (127.0.0.1/::1), AND an `X-Internal-Token` header must match
`INTERNAL_SERVICE_TOKEN` — defense in depth, since this XAMPP install's
Apache binding isn't guaranteed loopback-only by configuration alone.

**`dispatch-payload`/`priority-alert` (the two OUTBOUND internal
endpoints) are real, curl-able, and independently testable, but they are
NOT the production trigger for outbound SMS.** `NotificationDispatcher`
calls `SmsGatewayService::sendOutbound()` directly, in-process — looping
back through HTTP to itself would add latency and a second failure mode
for no benefit, since both are the same trusted PHP process. The two
endpoints exist so §6's documented contract is real and independently
verifiable (step 19 of the suite exercises them directly, never through a
notification), and so a genuinely separate future ingestion process
COULD call them if this were ever deployed that way.

**PHP's built-in server (`php -S`, used by every `verify-*.sh` in this
repo) does NOT read `.htaccess`, so `/internal/*` needed a second,
TEST-ONLY router script (`public/dev-router.php`) to be testable at all.**
Confirmed empirically before writing it: a bare `php -S -t public` with no
router script automatically falls back to `index.php` for any
non-existent path (which is WHY every existing verify script's
`/api/v1/*` calls already worked without one) — but that automatic
fallback only ever targets `index.php`, never a second file. Real Apache
never uses `dev-router.php` at all; it reads `public/.htaccess` directly.

**Inbound SMS handlers reuse the EXACT SAME core methods
`SyncController` already reuses** (`IncidentsController::createMobileItem()`,
`GpsController::createItem()`, `DutyStatusController::applyToggle()`,
`TanodSosController::createItem()`) rather than a second copy of any of
that logic. Two of those four needed a small additive signature change
first: `createMobileItem()` gained a `string $source = 'app'` trailing
param (an SMS-originated incident must record `source='sms'`, not `'app'`
— §5's own enum already anticipates this), and `applyToggle()` gained a
`string $channel = 'app'` trailing param (Rule 13: `duty_status.channel =
'sms'` is written ONLY by the validated internal SMS handler). Both
defaults preserve every existing caller's behaviour unchanged — verified
by re-running every pre-existing suite that touches either method
(`verify-sprint4.sh`, `verify-sprint6.sh`, `verify-devices-map-packages.sh`,
`verify-duty-status-map-upload.sh`) and confirming all four still pass in
full after the change.

**Sender identity for every inbound envelope is resolved from the device
mapping BEFORE the decrypted payload is ever read**, and no `receive*`
method in `SmsGatewayService` ever looks for a user id inside that
payload at all — Rule 13 ("any user ID included in the SMS payload is
ignored for authorization") is structural here, not a filter applied
after the fact. Verified directly: step 10 sends a real envelope from
tanod_a's device and confirms the resulting `duty_status` row belongs to
tanod_a, by device mapping, with nothing in the payload asserting who the
sender is.

**Every envelope rejection reason collapses into the SAME generic 422** —
malformed shape, unknown device, wrong key, tampered ciphertext, expired,
replayed, or message_type mismatch all produce identical HTTP output. A
more specific error would let a probing attacker distinguish "this device
doesn't exist" from "this envelope's tag failed," the same reasoning
`DevicesController`/`DispatchController` already apply to ownership
checks elsewhere in this codebase.

**W14 stays exactly "read-only, Admin only," per Sprint_Prompts.md's own
explicit standing note** — no reply/send/broadcast UI, matching the
existing exclusion already recorded against the Figma reference's
two-way-chat pattern.

**M12's "full-screen presentation" is approximated as a fixed, full-
viewport, highest-z-index overlay component mounted at the App root,
NOT a native Android full-screen-intent activity.** The real native
mechanism needs manifest/notification-channel configuration this cut does
not add — logged as follow-up, same category as M7's deferred basemap
rendering, not silently substituted without a note.

**M12's Acknowledge button is fire-and-forget on failure.** If
`POST /notifications/:id/ack` fails (workstation unreachable, session
expired), the overlay still dismisses — §2 Rule 7/15's offline-first
stance applies here too: a Tanod must be able to dismiss and act on a
critical alert regardless of API reachability. The ack itself is already
idempotent server-side (§6), so a background retry mechanism is
straightforward, unscoped follow-up work, not something this overlay
needs to solve by blocking the dismiss.

**M13's `sent_by_sms`/`sms_pending`/`sms_failed` states are implemented
in full and correctly typed, but are NOT reachable in this build** — only
`saved_locally_for_retry` is, because nothing yet performs on-device SMS
sending (see the scope-trim note above). `deriveSmsFallbackState()` never
lies about this: it only ever returns a state that reflects what
`smsAttempted`/`smsStatus` actually say, and today nothing sets those to
anything but their "never attempted" defaults. The component and its
state model are ready the moment SMS sending is wired up; nothing about
this screen needs to change when that happens.

## Files

**Backend, new:**
- `services/notifications/FcmClient.php` + `FcmException.php` — FCM HTTP
  v1, hand-rolled OAuth2 JWT signing.
- `services/notifications/SemaphoreClient.php` + `SemaphoreException.php`
  — Semaphore `/messages` + `/priority` endpoints.
- `services/notifications/NotificationDispatcher.php` — Rule 12's ladder;
  Phase 2 of the split `NotificationService` its own class doc already
  anticipated.
- `services/sms/DeviceSecretVault.php` — device-secret at-rest encryption.
- `services/sms/EnvelopeCrypto.php` + `EnvelopeException.php` —
  AES-256-GCM envelope encrypt/decrypt, AAD binding.
- `services/sms/SmsGatewayService.php` — inbound envelope resolution +
  reconstruction (4 message types) and the shared outbound send/log core.
- `controllers/InternalSmsController.php` — the 6 `/internal/sms/*`
  handlers (thin wrappers over `SmsGatewayService`).
- `controllers/SmsController.php` — `GET /sms/logs`.
- `public/internal.php` — the internal-only front controller.
- `public/dev-router.php` — TEST-ONLY router for `php -S`, mirrors
  `.htaccess`; never used by real Apache.
- `routes-internal/sms.php`, `routes/sms.php`.
- `scripts/notification-worker.php` — the 60s ack-timeout sweep worker.
- `scripts/sms-envelope-build.php` — test/dev tooling: builds a real,
  valid encrypted envelope from a device's own key, standing in for the
  GSM ingestion hardware this environment doesn't have.
- `scripts/verify-sprint4-phase2-3.sh` — 68 checks.
- `migrations/0005_sms_envelope_replay.sql` (+`.down.sql`),
  `0006_sms_log_barangay.sql` (+`.down.sql`) — both applied to the real
  local `baranguard` database this session, confirmed via
  `SHOW TABLES`/`DESCRIBE`, not just written.

**Backend, modified (all additive):**
- `controllers/TanodSosController.php`, `controllers/DispatchController.php`
  — call `NotificationDispatcher::dispatchAll()` after commit.
- `controllers/IncidentsController.php` — `createMobileItem()` gained
  `string $source = 'app'`.
- `controllers/DutyStatusController.php` — `applyToggle()` gained
  `string $channel = 'app'`.
- `controllers/DevicesController.php` — device-secret provisioning in
  `register()`.
- `controllers/SystemHealthController.php` — fixed a pre-existing wrong
  env-var name (`FCM_SERVICE_ACCOUNT_JSON` -> `FCM_SERVICE_ACCOUNT_PATH`,
  never previously exercised so never previously caught); added `fcm`/
  `sms_semaphore` fields; `gsm_ingestion` now reflects
  `INTERNAL_SERVICE_TOKEN` instead of a var (`GSM_MODEM_DEVICE`) that was
  never actually defined anywhere.
- `public/.htaccess` — new `^internal/` rewrite rule, checked first.
- `.env.example` — `FCM_SERVICE_ACCOUNT_PATH`, `SEMAPHORE_API_KEY`,
  `SEMAPHORE_SENDER_NAME`, `INTERNAL_SERVICE_TOKEN`,
  `DEVICE_SECRET_MASTER_KEY`.
- `scripts/verify-sprint4.sh` — one assertion fixed (see Tests below);
  everything else unchanged.

**Web, new:** `web/src/pages/sms-log.js` (W14).
**Web, modified:** `web/src/api/apiClient.js` (`getSmsLogs`, extended
`getSystemHealth`), `web/src/components/AppShell.js` (nav item),
`web/src/components/icons.js` (`messageSquare`/`arrowDownLeft`/
`arrowUpRight`), `web/src/main.js` (route wiring).

**Mobile, new:**
- `src/services/messageEncryptionKey.ts` — Keystore-backed storage for
  the per-device symmetric key, same pattern as `db/passphrase.ts`.
- `src/services/criticalAlertStore.ts` — push-listener registration +
  the minimal hand-rolled subscribe/notify store behind M12.
- `src/services/smsFallbackState.ts` — M13's state model (4 states, only
  1 reachable today — see decisions above).
- `src/components/CriticalAlertOverlay.tsx` — M12.
- `src/components/SmsFallbackBadge.tsx` — M13's display half.
- `src/components/NotificationDiagnostics.tsx` — the "visible in
  diagnostics" half of M12, mounted on the still-unbuilt Profile/M10 tab.

**Mobile, modified:**
- `src/services/deviceIdentity.ts` — `getFcmToken()` replaced: real
  `@capacitor/push-notifications` permission request + registration flow,
  never throws, resolves `null` on any failure mode.
- `src/services/apiService.ts` — `registerDevice()` returns
  `messageEncryptionKey?`; new `acknowledgeNotification()`.
- `src/pages/login.tsx` — stores the key when a registration response
  includes one.
- `src/pages/incident-submitted.tsx` — mounts `SmsFallbackBadge` beside
  M4's existing sync-state pill.
- `src/components/NotBuiltYetPage.tsx` — additive `children` prop (a real
  working sub-section on an otherwise-unbuilt page, not a second
  placeholder).
- `src/App.tsx` — mounts `CriticalAlertOverlay` at the root, outside the
  tab router; registers push listeners once on app mount.
- `src/theme/app.css` — `.critical-alert-overlay*` classes, built from
  existing §8 tokens only.
- `package.json` — `@capacitor/push-notifications` dependency added.

## Tests performed (with evidence)

1. **`php -l` clean on every new/modified backend PHP file** (26 files).
2. **`backend/scripts/verify-sprint4-phase2-3.sh` — 68/68 against real
   XAMPP** (MariaDB 10.4.32 + PHP 8.2.12), covering: device-secret
   provisioning (first-registration-only, verified unchanged in the DB
   across a re-registration) · `GET /system/health`'s new fields · the
   full Rule 12 ladder for a target WITH a device (2 FCM attempts, both
   `FCM_NOT_CONFIGURED`, then exactly 1 SMS attempt,
   `SEMAPHORE_NOT_CONFIGURED`) AND for a target with NO device (0 FCM
   attempts, straight to SMS) AND for a target with neither device nor
   contact_number (`NO_CONTACT_NUMBER`, correctly never reaching
   `SmsGatewayService` at all) · dispatch creation also triggering the
   ladder · the ack-timeout worker (a 90s-stale row swept, a 10s-fresh row
   left alone, re-running the sweep is a no-op, an ALREADY-ACKNOWLEDGED
   target's stale row is NEVER swept — Rule 24) · the internal router's
   loopback+token gate (both factors independently tested, plus
   confirming a valid Bearer token alone does NOT reach it) · a REAL
   AES-256-GCM envelope decrypting and reconstructing a duty_status row
   with `channel='sms'` and the correct sender identity · replay
   rejection (identical envelope twice, second rejected, DB confirms only
   1 row) · tampered-ciphertext rejection (one flipped byte, GCM tag
   fails) · AAD-binding rejection (swapped `device_id` header, same
   ciphertext, fails authentication — a real attempted impersonation,
   defeated) · expired-envelope rejection · message_type-mismatch
   rejection · incident-fallback producing `source='sms'` · SOS-fallback
   producing a real SOS with the SAME Rule 27 fan-out as an app-originated
   one · inbound rows correctly logged with `barangay_id` · the two
   outbound internal endpoints tested in isolation (502 on unconfigured
   Semaphore, still logs the attempt; 400 on missing required fields) ·
   `GET /sms/logs` role gating, tenant scoping, filter params, and the
   confirmed ABSENCE of `sender_number`/`receiver_number` in the response.
   Two rounds of real test-script bugs were found and fixed BEFORE the
   clean run (both in the test's own setup, not the application): step
   4's first assertion assumed only 1 outbound sms_log row would exist
   for the SOS's 2 targets, not realising `dispatchAll()` is synchronous
   and processes every target before the creating request even returns;
   step 6 forgot to put `tanod_b` on-duty before raising the SOS meant to
   target them, so `NotificationService::sosRecipients()` correctly
   excluded them (working as designed) and the test's own expectation was
   wrong, not the code.
3. **Every pre-existing verify script that touches something Phase 2/3
   changed was re-run in full, to confirm zero regression:**
   - `verify-sprint4.sh` (Phase 1) — **48/48**, after fixing ONE assertion
     that had genuinely gone stale (not a regression): it asserted a
     GLOBAL zero `notification_delivery` row count as proof
     acknowledgment isn't a transport record, which was only true before
     Phase 2 existed. Fixed to capture the count immediately before the
     ack call and assert it's UNCHANGED after — the actual invariant Rule
     24 requires, now correctly isolated from the fact that Phase 2's SOS
     creation legitimately produces delivery rows earlier in the same run.
   - `verify-sprint6.sh` — **112/112**, untouched, confirming the AI
     pipeline/blotter/approval work is unaffected.
   - `verify-devices-map-packages.sh` — **53/53**.
   - `verify-duty-status-map-upload.sh` — **40/40**.
   - Combined with this session's own 68, **321 checks passing across
     five suites, zero failures**, against real XAMPP.
4. **`node scripts/verify-web-wiring.mjs` — 300/300**, up from 297 before
   this cut. Caught two real bugs in `sms-log.js` before they shipped:
   `.filter-panel__field` was invented without checking (the real pattern
   is a bare `<select>` as a direct child of `.filter-panel`, already
   styled in `AppShell.css`), and `status-pill--warning` doesn't exist
   (the tinted-warning class is named `status-pill--pending`, matching
   the web dashboard's own §8 naming exactly). Both are exactly the class
   of bug this tool was built to catch, per its own Sprint 6 origin story
   — `node --check`/`tsc` cannot see either one.
5. **`node --check` clean** on every new/modified web JS file.
6. **Real browser walkthrough of W14** (disposable DB + disposable admin +
   two throwaway PHP servers, `web/index.html`'s API base URL temporarily
   repointed and reverted afterward — confirmed via `git diff --stat`
   showing no residual change): real seeded rows render with correct
   direction icons/labels, transport names, and status pills; the
   direction filter round-trips a REAL `GET /sms/logs?direction=inbound`
   request and the table updates to show only the matching row; zero
   console errors; network tab shows clean 200s throughout. Only the
   Admin role and this one screen were exercised.
7. **`tsc --noEmit` across the whole mobile project** — clean except for
   the expected `Cannot find module '@capacitor/push-notifications'`
   (its `npm install` was never run this session, same as
   `@capacitor/geolocation` in Sprint 3) plus its two derived
   implicit-`any` errors on that same missing type. Every other
   new/modified mobile file — `messageEncryptionKey.ts`,
   `criticalAlertStore.ts`, `smsFallbackState.ts`,
   `CriticalAlertOverlay.tsx`, `SmsFallbackBadge.tsx`,
   `NotificationDiagnostics.tsx`, `NotBuiltYetPage.tsx`, `App.tsx`,
   `login.tsx`, `incident-submitted.tsx`, `apiService.ts` — type-checks
   cleanly.
8. **`eslint` clean** on every new/modified mobile file (via the real CLI
   entry point directly, since the installed `.bin/eslint` shell wrapper
   isn't `node`-executable in this shell — a tooling quirk, not a code
   issue).

## NOT done this session — stated plainly

- **The model, FCM, and Semaphore have all still never been called with
  real credentials.** Every "sent" outcome in this cut's tests is a
  logical/local-crypto success (real AES-256-GCM, real replay/AAD
  checks); every actual external send is a deliberately-unconfigured
  `failed` outcome, proven correct rather than assumed.
- **GSM-modem OUTBOUND sending** — not built, see the scope-trim note.
- **A real Firebase project / `google-services.json` / a real Semaphore
  account** — none exist on this workstation; `getFcmToken()` and
  `FcmClient`/`SemaphoreClient` are all written against each provider's
  real documented contract but have never executed against it.
- **`npm install` in `mobile/`** was NOT run — `@capacitor/push-
  notifications` exists only as a `package.json` entry. `npx cap sync`
  and the AndroidManifest.xml `POST_NOTIFICATIONS` permission (Android
  13+) are both still outstanding, same category as every other
  native-plugin addition this repo has made without a working Android
  build environment.
- **No device run of anything in this cut.** M12/M13, the real
  `getFcmToken()` flow, and the message-encryption-key storage are all
  unverified on a real device — same standing blocker as M1/M3/M4 since
  Sprint 2 (Android SDK/JDK 21).
- **M12's presentation is a JS overlay, not a native full-screen-intent
  activity** — see the decisions section above.
- **On-device SMS sending is not built**, so M13 can only ever show
  `saved_locally_for_retry` in this build — see the decisions section.
- **Only W14 and only the Admin role were browser-verified on the web
  side** — no Punong Barangay/Secretary/Tanod pass, and no other screen
  was re-tested.
- **Nothing from this session has been committed yet.**

## Suggested order for the follow-up session

1. Real Firebase project + `google-services.json` + `FCM_SERVICE_ACCOUNT_PATH`
   on the backend, and a funded Semaphore account — only once BOTH exist
   does a live send/receive test become possible at all.
2. Resolve the Android SDK/JDK 21 blocker (already tracked since Sprint 2),
   then `npm install` + `npx cap sync android` + add the
   `POST_NOTIFICATIONS` manifest permission + a real device run through
   M1 login (confirm `getFcmToken()` actually resolves a token and
   `message_encryption_key` round-trips through `SecureStorage`) -> M12
   (send a real test push, confirm the overlay renders and Acknowledge
   round-trips) -> M13 (still only `saved_locally_for_retry` until SMS
   sending exists).
3. If GSM-modem hardware becomes available: build the real ingestion
   daemon that reads the tethered phone and POSTs to `/internal/sms/*` —
   `scripts/sms-envelope-build.php` already proves the exact contract it
   needs to produce.
4. If on-device SMS sending is wanted: a native SmsManager integration,
   `SEND_SMS` runtime permission, wiring `smsFallbackState.ts`'s
   `smsAttempted`/`smsStatus` to something real.
5. Browser-verify W14 for Punong Barangay/Secretary/Tanod (403 expected
   for all three) and spot-check the other 12 web screens for any
   regression from this session's `AppShell.js`/`icons.js` changes.

---

# DEVLOG — Mobile build fix: `npm install` was never run for two declared
# dependencies (root cause of "Sprint 3 doesn't compile"), plus one real
# type error, plus a full live-browser verification pass

## Today's cut

The user asked why the mobile app couldn't compile and to confirm it
actually works before ending the session. Not a Sprint Prompts "Today's
cut" box — a targeted diagnose-and-fix, plus verification.

## Root cause (exactly what it looked like — nothing subtler)

`@capacitor/geolocation` (added to `package.json` in the Sprint 3 session)
and `@capacitor/push-notifications` (added in the Sprint 4 Phases 2-5
session, this same day) were both **declared but never installed** —
every prior DEVLOG entry that touched either one said so explicitly
("`npm install` was NOT run"). `node_modules/@capacitor/` had no
directory for either package. Every other declared dependency (SQLite,
secure-storage, voice-recorder, Ionic, camera, filesystem, preferences)
was genuinely present — confirmed by listing `node_modules/@capacitor/`
and checking each package individually before assuming `npm install`
alone would fix everything.

## Fix

1. `npm install` in `mobile/` — resolved cleanly, 2 packages added, 778
   audited (13 pre-existing moderate/high advisories, none touched by
   this fix, not addressed here — a separate `npm audit` pass is its own
   scoped decision, not a silent side effect of a compile fix).
2. That surfaced ONE real type error, invisible until the real package
   types existed: `PushNotifications.addListener()` in
   `@capacitor/push-notifications` v8 returns
   `Promise<PluginListenerHandle>`, not a handle directly — this session's
   own `deviceIdentity.ts` (written against the plugin's prose docs, not
   its actual `.d.ts`) called `.remove()` on the unresolved Promise.
   Fixed by awaiting both `addListener()` calls before constructing the
   token-resolution `Promise`, with a plain `resolveToken`/`finish`
   closure instead of the broken ref-hack the first fix attempt produced
   (caught and corrected before running `tsc` again, not left in).
   `criticalAlertStore.ts` calls the same API but never stored/awaited
   the handle at all (fire-and-forget listeners for the app's whole
   lifetime, which is what it actually wants), so it was never affected.

## Tests performed (with evidence)

1. **`tsc --noEmit`** — clean, zero errors, entire project.
2. **`eslint` across all of `src/`** — clean, zero warnings.
3. **`npm run build`** (`tsc && vite build`) — succeeds, `dist/` produced.
   The only warnings are pre-existing Ionic/lightningcss vendor CSS
   warnings (`host-context` pseudo-class) and a chunk-size-limit notice,
   both unrelated to any of this session's code.
4. **`npm run verify.schema`** — 113/113, confirming the local SQLite
   schema layer (unaffected by this fix, but a real "does the mobile app
   actually work" check) is still sound.
5. **A full live browser walkthrough**, not just a build — disposable
   database + disposable Tanod account + a throwaway PHP API server
   (`public/dev-router.php`, port 8150) + the real Vite dev server via
   `.claude/launch.json`:
   - Login renders correctly (confirmed via DOM inspection after
     re-fronting the tab — the Browser tool's own documented quirk of a
     backgrounded tab showing a stale/blank screenshot while the DOM is
     already correct recurred here exactly as described in an earlier
     session's DEVLOG entry; re-selecting the tab and re-screenshotting
     resolved it, not an application bug).
   - A real login (`POST /auth/login` → 200) reaches Home with the
     authenticated Tanod's real name and real duty status.
   - **Assignments (M5)** — the actual Sprint 3 screen in question —
     renders "No Active Assignments" correctly. Two console errors
     appeared and are BY DESIGN: `localDatabase.ts` deliberately throws
     on the web platform rather than opening an unencrypted SQLite store
     (documented repeatedly in this DEVLOG), and `assignments.tsx`
     correctly catches it and falls back to the empty state instead of
     crashing — confirmed this is the intended behaviour, not treated as
     a bug to fix.
   - **Map (M7)** — the other Sprint 3 screen — renders its real
     status-view content ("Could not read this device's location. Check
     location permission." + "No incidents reported nearby."), no crash.
   - **Profile** — this session's new `NotificationDiagnostics` (M12)
     correctly reports "Push notification permission: Not available on
     this platform" on the web platform, rather than faking a granted/
     denied state.
   - **Log Incident (M3)** — renders correctly, Add Photo/Record Voice
     Note buttons intact.
   - Network tab: every module file 200, `POST /auth/login` 200,
     `GET /duty-status` 200, `GET /dispatch` 200 (Assignments' real data
     source), and the one expected 404 (`GET /map-packages/1` — no
     package published in this disposable DB, already documented as
     non-fatal to login since Sprint 2). No 500s anywhere.
   - All test infrastructure (disposable database, disposable app-user,
     the throwaway PHP server, the Vite preview) was torn down after —
     the real `baranguard` database was never touched.

## Not done / still standing (unchanged by this fix)

- `npx cap sync android` and the `POST_NOTIFICATIONS` manifest permission
  (Android 13+) are still outstanding — this fix gets the WEB-PREVIEW/
  TypeScript layer working, not a native Android build. The Android SDK/
  JDK 21 blocker from Sprint 2 is unchanged.
- Noticed in passing, NOT fixed here (a scope decision, not an oversight):
  Home's SOS button copy still reads "it needs the Sprint 4 alert backend
  (`POST /tanod-sos`)" — that backend has existed and been verified since
  the Sprint 4 Phase 1 session. The button itself staying disabled is
  correct and already tracked in HANDOFF.md ("M2's SOS button in the
  mobile app is STILL disabled"); the stale WORDING is a small, separate
  follow-up, not touched in this fix since actually wiring the button is
  the real work that copy is honestly describing as not done.

---

# DEVLOG — UI/UX completion pass: dark mode, DataTable, sidebar badges,
# map clustering, KPI sparklines, PWA manifest, mobile parity (web +
# mobile, 9-phase approved plan)

## Today's cut

Not a Sprint Prompts "Today's cut" box — a user-directed UI/UX completion
pass, scoped and approved in advance via a written 9-phase plan (the user
was asked three explicit scoping questions first: whether to build dark
mode at all — yes; which "bigger" web items to include — DataTable
completion, sidebar badge counts, and map clustering/click-to-zoom, all
three; which "small extras" — KPI sparklines and a PWA manifest, both).
Everything below was authorized in that plan before any code was written.
Explicitly NOT in this pass (stays deferred): Dashboard auto-refresh/
quick-dispatch/response-time gauge/activity feed, Dispatch Center
drag-and-drop/audio alerts/timeline/resizable pane, GIS animated
markers/trails/geofence/search/follow mode, Scheduler calendar view,
Citizen Report photo upload, real-time refresh indicators, keyboard
shortcuts, breadcrumbs.

Dark mode is a deliberate, explicit reversal of a decision already on
record in this file (the mobile-side entry's "Light, not dark... there is
no documented dark variant" note) — recorded here so a later session
doesn't "fix" it back citing that older note.

## Phase 1 — Dark mode token infrastructure

`web/src/styles/base.css`'s `:root` block already held every color as a
custom property (§8's own rule) — dark mode is a second value set for the
same tokens, applied two ways: `@media (prefers-color-scheme: dark) {
:root:not([data-theme="light"]) {...} }` for the system-default case, and
`:root[data-theme="dark"] {...}` for an explicit user choice, so an
explicit choice always wins over system preference in both directions.
`web/index.html` gained a small inline bootstrap `<script>` in `<head>`
(before any stylesheet) that reads `localStorage.baranguard.theme` and
sets `data-theme` before first paint — a `<script type="module">` runs
deferred-by-spec and would have painted the wrong theme first on every
load for a user who'd chosen dark.

**A new token, not a repurposed one.** `--color-white` already meant
"literal white, theme-invariant" (text/icons on a saturated brand color,
e.g. a primary button's label) — overloading it to also mean "card/panel
background" would have made every one of those literal uses turn white-
on-white in dark mode. Added `--color-surface` instead (`#FFFFFF` in
light, `#1E293B` in dark) and reclassified every actual *surface*
background across `base.css`/`AppShell.css`/`ConfirmDialog.css`/
`Toast.css`/`PageHeader.css`/`DonutChart.css`/`dispatch-center.css`/
`login.css` to it, leaving `--color-white` alone everywhere it was
correctly literal (button labels, `Avatar.css`, the critical-alert
overlay's accent). Also fixed one real pre-existing bug found while
doing this: `.status-pill--pending` hardcoded `color: #92400E` directly —
the one raw hex in the whole file — promoted to a `--color-warning-text`
token so dark mode can override it like everything else. And one
hardcoded literal in `AppShell.css`: `.status-badge--ok`'s `#DCFCE7` →
`var(--tint-success-solid)`.

**CSS `transition` clobbering, caught before it shipped.** A blanket
`transition: background-color .2s, color .2s, border-color .2s` rule
across every themed surface would have silently DELETED the more
specific transitions `button`/`input`/`.card` already had (press-feedback
transform, focus box-shadow, hover shadow) — `transition` is a shorthand,
and a later rule wins the whole property, not just the parts it mentions.
Caught by grepping for existing `transition:` declarations before writing
the new rule; fixed by excluding those selectors from the blanket rule
and extending their existing declarations in place instead. The blanket
rule itself is wrapped in `@media (prefers-reduced-motion: no-preference)`,
extending the same reduced-motion discipline the rest of the app already
had rather than adding a second, separate check.

**`LiveMap.js`'s MapLibre paint colors** (`#3B82F6`/`#1D4ED8`/`#E0F2FE`)
were hardcoded JS string literals, invisible to the CSS-token retrofit
entirely — a `themeToken(name, fallback)` helper reads the live computed
CSS custom property value at render/theme-change time instead.

Toggle: a sun/moon icon button in `AppShell.js`'s topbar
(`localStorage.baranguard.theme`: `'light'|'dark'`, no third "system"
value stored — omitting the key at all is what "system" means).

## Phase 2 — Toast/ConfirmDialog rollout completion

`scheduler.js`, `fatigue-flags.js`, `swap-requests.js` — each had exactly
one `alert(...)` call for its own error path, replaced with
`showToast(message, {variant:'error'})`. `dispatch-center.js`'s one
remaining `window.confirm(...)` (cancel-dispatch) replaced with
`ConfirmDialog`, matching the pattern the file already used elsewhere.
Verified live in the Final sweep below — see "Cancel dispatch #1?" there.

## Phase 3 — Accessibility completion

`DataTable.js` gained a `role="status" aria-live="polite"` row-count
summary (e.g. "5 rows in Electronic blotter entries.") so a screen reader
hears the result of a filter/reload without re-navigating to it.
`main.js` gained `focusPageHeading(root)`, called once at the end of
`boot()`'s dispatch chain: finds `.page-header__title, h1, h2` in the
newly-rendered page, gives it `tabindex="-1"` if it doesn't already have
one, and focuses it — so a keyboard/screen-reader user isn't left
attached to a DOM node `root.innerHTML = ''` just deleted. The `h1, h2`
fallback (not just `.page-header__title`) turned out to matter for real —
see Historical Heatmap below.

## Phase 4 — DataTable completion

`DataTable.js` gained optional `emptyIcon`/`emptyMessage`/`page`/
`totalItems`/`pageSize`/`onPageChange` props (Prev/Next + a "Showing X-Y
of Z" indicator, wired to each page's own `load()` re-fetching with a
`page` param rather than DataTable inventing client-side pagination on
top of an already-capped fetch) and a new exported `exportRowsToCsv
(columns, rows, filename)` helper (RFC 4180 escaping). `DataTable.css`
gained zebra striping via `color-mix` against `--color-bg` (so it
respects dark mode automatically) and empty-state icon/pagination
styling. Wired into `sms-log.js` (real server-side pagination —
`GET /sms/logs?page=&limit=25`, the first page consumer with more than
one page of real data) and `blotter-list.js` (CSV export).

## Phase 5 — Sidebar badge counts

New endpoint `GET /reports/nav-counts` (`backend/controllers/
ReportsController.php`, Admin-only, tenant-scoped) — one round trip
returning `{pending_incidents, unconverted_citizen_reports,
pending_swap_requests, unacknowledged_fatigue_flags}` rather than four
separate sidebar-driven fetches on every page load. `shift_swap_request`/
`fatigue_flag` have no direct `barangay_id` column, so their counts join
through `shift_schedule`. `AppShell.js`'s `NAV_ITEMS` gained an optional
`countKey`; a small badge renders beside the icon when count > 0, fetched
once on mount and polled every 60s (slower than GIS's 15s — count badges
aren't time-critical), with the interval's own tick checking
`el.isConnected` to self-stop rather than a second interval whose only
job was clearing the first.

## Phase 6 — Map clustering + click-to-zoom

**Deviated from the plan's literal text.** The plan specified MapLibre's
native GeoJSON `cluster:true` source/layer clustering; building it turned
up that this would mean abandoning `LiveMap.js`'s existing DOM-marker
approach entirely (CSS pulse animation, native browser tooltips, the
staleness-pill treatment) in favor of GeoJSON-driven canvas layers — a
materially bigger rewrite of already-tested, working code for the same
user-facing outcome. Built a hand-rolled DOM-based screen-pixel clustering
algorithm instead (`clusterByScreenDistance()`, `CLUSTER_RADIUS_PX=44`):
groups markers whose projected screen positions fall within the radius,
renders a numbered cluster marker in place of the individual ones,
`getClusterExpansionZoom`-equivalent click-to-zoom via `flyTo`, individual
markers keep their existing popup/tooltip/staleness behavior unchanged.
Re-clusters on map move via `scheduleRecluster()` (debounced). This
preserves every already-tested marker behavior while still delivering
real clustering — verified live in the Final sweep: two Tanods seeded at
near-identical coordinates rendered as one cluster marker reading "2",
with the third (further away) Tanod as its own individual marker showing
a real freshness pill.

## Phase 7 — KPI sparklines

**Deviated from the plan's literal text.** The plan named "Total Incidents
AND Resolved" for sparklines; `ReportsController.php`'s `GET
/reports/summary` only ever returns a `trend[]` series for incidents
CREATED per day — there's no matching day-by-day series for "resolved,"
so applying a sparkline to that card would mean drawing invented data.
Scoped to Total Incidents only, and said so in a code comment rather than
misapplying the trend series to a card it doesn't describe.
`KpiCard.js` gained an optional `sparkline?: number[]` prop
(`buildSparkline()` — a small inline SVG polyline, 0–100 normalized
viewBox, no charting library, consistent with the existing hand-rolled
`TrendChart`/`DonutChart` approach). `admin-dashboard.js` passes
`summary.trend.map(d => d.count)` into both the initial and
delta-refreshed Total Incidents card.

## Phase 8 — PWA manifest + Apple touch icon

`web/manifest.json` (name/short_name/icons — an inline SVG data URI
reusing the exact same navy shield as the existing favicon, no new binary
asset/build step — theme_color/background_color/display:standalone),
linked from `index.html` alongside a matching `apple-touch-icon` link and
a `theme-color` meta tag. Honest limitation noted inline: an SVG
apple-touch-icon has patchier iOS Safari support than a PNG, acceptable
for a locally-hosted internal admin tool, not a consumer app.

## Phase 9 — Mobile UI/UX parity pass

`mobile/src/theme/app.css` had zero gradients, zero animation rules, and
zero `alert()`/`confirm()` calls anywhere in `mobile/src/` before this —
confirmed by inspection, not assumed. Added: a card gradient sheen
matching web's `.card` treatment at the same visual weight; a
`.status-pill--critical` left-border accent (mirroring web's) plus an
opt-in `.is-urgent` pulse animation (a class, not baked into the base
critical pill, so an ordinary historical record doesn't pulse forever),
wrapped in `prefers-reduced-motion`. `home.tsx` (M2) gained an `IonToast`
for duty-toggle success feedback and an `IonAlert` confirmation gate on
Sign Out — previously immediate/unguarded, now "You'll need to sign in
again..." with Cancel/Sign out. Verified live (disposable rig, real
Tanod account): the duty toggle produces a real `{"toastPresent":true,
"message":"You're now on duty."}`; clicking Sign Out opens the alert
(`{"header":"Sign out?","urlStillHome":true}`) rather than signing out
immediately; clicking the alert's own "Sign out" button (its Cancel and
confirm buttons render as plain `<button>`s with no accessible
`shadowRoot`, so located via the `find` tool's text search rather than
`alert.shadowRoot.querySelectorAll`) actually cleared the session and
navigated to `/login`, confirmed via
`{"alertStillOpen":false,"href":"http://localhost:5173/login",
"hasSession":false}`. The two console errors during that pass were the
already-documented, intentional "encrypted local store is Android-only"
web-platform guard on `assignments.tsx` — not new bugs.

**Skipped, and said so rather than silently dropped**: an `IonAlert` for
discarding an in-progress incident draft (M3) — `new-incident.tsx` has no
existing "leave without saving" trigger to gate (no back/cancel action
that discards a draft exists on that screen yet), so there is nothing to
guard; adding one would be new scope, not a UI/UX polish pass on
something that already existed.

## Final step — cross-theme, cross-platform QA sweep (real browser, real backend)

Built a disposable rig (`baranguard_qa_final` database, all 6 migrations
applied, disposable `qafinal_app` user, PHP dev server on port 8230,
static `web/` server on port 8231 — `web/index.html`'s API base URL
temporarily repointed and reverted after) seeded with realistic data
across every table this pass touches: 6 users (admin/secretary/PB/3
tanods), 2 clustered + 1 distant GPS point, 5 incidents spanning every
status, 2 dispatches, a finalized blotter record with an approved AI
redaction, a second incident with a completed-but-unapproved AI draft (so
both W7/W8 states were real, not just the happy path), a pending shift
swap request, an unacknowledged fatigue flag, 2 unconverted citizen
reports, and 30 `sms_log` rows (enough to exercise Phase 4's real
pagination). The session was interrupted partway through by an
environment restart (MySQL and both disposable servers went down); on
resume, MySQL and both servers were restarted and the disposable DB
(which had survived on disk) was found to be missing migrations 0005/0006
— applied, then the sweep continued rather than restarted from scratch.

**Two real bugs found and fixed during this sweep, not just claimed:**

1. **`GET /sms/logs` 500'd on this rig at first** — `SQLSTATE[42S22]:
   Unknown column 'barangay_id'`. Root cause was entirely in the QA rig,
   not the app: the disposable database was only migrated through 0004,
   missing 0005/0006 (the migrations that add `sms_log.barangay_id`) —
   `SmsController.php` itself is correct against the real, fully-migrated
   schema. Applied the missing migrations and backfilled the already-
   seeded rows' `barangay_id`; confirmed fixed via a real page-2
   pagination round trip afterward.
2. **A GPS marker showed "LIVE · -27648S AGO"** — a negative age.
   Root cause was also entirely in the QA rig's seed script: it used
   `NOW()`, and on this machine MySQL's session `NOW()` returns local
   wall-clock time (~8h ahead of true UTC) while every other timestamp
   this application writes and reads is naive-but-UTC (an established,
   repeatedly-documented convention in this file). Fixed by rewriting the
   seed script to use `UTC_TIMESTAMP()` throughout and reloading; GPS
   freshness then computed correctly (`LIVE · 22S AGO` / `STALE · 5M
   AGO`, correctly crossing the documented 120s threshold for the
   distant point).

**One real, pre-existing gap found and fixed, unrelated to either bug
above:** `historical-heatmap.js` (W5) was the one screen this project's
own earlier "every AppShell page migrated to PageHeader" pass
(documented several entries back in this file) had missed — it still
built its heading as a raw `<h2 style="margin-bottom:16px; display:flex;
...">` written straight into the content area, in direct violation of
§8's "never hardcode... in a component file" rule, and it duplicated its
own "historical, not predictive" disclosure as a second `<p class="note">`
right below. Migrated to the shared `PageHeader` component (title +
subtitle carrying that same disclosure, once) matching all ten other
already-migrated screens. `node scripts/verify-web-wiring.mjs` went from
300 to 311 checks passing (0 failed) after this fix. This also means
Phase 3's `focusPageHeading` now correctly targets `.page-header__title`
on this screen instead of falling back to a bare `h2` — confirmed live:
`{"focusedAfterNav":true, "headerBg":"rgb(30, 41, 59)"}` (the correct
dark-mode surface token).

**What the sweep actually verified, with evidence, not just claimed:**
- **All 12 Admin-visible screens, dark mode**: an automated in-page audit
  clicked through every sidebar nav item and scanned every visible
  element for a "near-white background while dark mode is active"
  anomaly (a literal leftover from the pre-retrofit codebase). Zero found
  across all 12, both before and after the Historical Heatmap fix.
- **The same 12 screens, explicit light mode** (inverse audit — scanning
  for leftover near-black backgrounds): zero found.
- **The explicit toggle itself**: clicking it twice round-trips
  light→dark→light correctly, each click persisting to `localStorage`
  and updating `document.documentElement`'s `data-theme` and the live
  computed body background in the same call.
- **The no-flash bootstrap script**: a fresh page LOAD (not a client-side
  toggle) with `baranguard.theme=dark` already in `localStorage` renders
  `data-theme="dark"` and the correct dark body/card colors from the
  first paint — checked on the unauthenticated login page specifically,
  since that's the page most likely to flash (nothing else has rendered
  yet to hide behind).
- **Sidebar badge counts (Phase 5), against real seeded data**: the nav
  itself read "Dispatch Center2", "Citizen Reports2", "Swap Requests1",
  "Fatigue Flags1" — matching the seeded 2 pending incidents, 2
  unconverted citizen reports, 1 pending swap request, and 1
  unacknowledged fatigue flag exactly.
- **DataTable pagination + CSV (Phase 4), against 30 real `sms_log`
  rows**: page 1 showed "Showing 1-25 of 30 · Page 1 of 2"; clicking Next
  correctly showed "Showing 26-30 of 30 · Page 2 of 2" and the ARIA live
  region updated to "5 rows in SMS activity log."; clicking Export CSV
  produced zero console errors.
- **Map clustering (Phase 6), against real coordinates**: two Tanods
  seeded ~5m apart clustered into one marker reading "2"; a third,
  ~250m away, rendered as its own marker with a correct, independent
  freshness pill.
- **ConfirmDialog (Phase 2), live interaction**: clicking Dispatch
  Center's Cancel button opened a real component (not `window.confirm`)
  reading "Cancel dispatch #1? / The incident will return to the pending
  queue." with "Keep it" / "Cancel dispatch" buttons, correctly
  dark-themed (red-accented destructive button, dimmed backdrop);
  dismissed via "Keep it" without actually cancelling, to leave the rest
  of the rig's data intact for further checks.
- **W7 Blotter Detail and W8 AI Redaction Review, both roles, both dark
  and light mode**: W7 on a still-pending incident correctly showed "Not
  yet" for every timeline stage that hadn't happened yet (the exact
  fabricated-timeline class of bug an earlier Sprint 6 session already
  fixed once — confirmed the fix still holds); W8 showed the real raw
  narrative beside the real AI draft, the real self-hosted model name
  (`aisingapore/Llama-SEA-LION-v3.5-8B-R`), and no confidence/accuracy
  number anywhere (§8's own explicit rule) — both screens' dark-mode
  audits came back clean.
- **Mobile Phase 9**: re-confirmed from the pre-interruption pass above
  (this entry's own "Phase 9" section) — not re-run in this Final sweep,
  since it already has direct, real interaction evidence of its own.

All disposable infrastructure (database, app user, both PHP dev servers,
the browser tab) was torn down after; `web/index.html`'s API base URL and
`mobile/.env.local` were both reverted to their real values; the real
`baranguard` database was never touched.

## Not done / explicitly out of this pass

- Every item the plan's own "Explicitly NOT in this round" list already
  named (Dashboard auto-refresh, Dispatch Center drag-and-drop/audio
  alerts, GIS animated markers/trails/geofence/search, Scheduler calendar
  view, citizen-report photo upload, keyboard shortcuts, breadcrumbs) —
  unchanged, still deferred.
- M3's discard-draft `IonAlert` — see Phase 9's own note above for why.
- No native Android device run of Phase 9's mobile additions — same
  standing Android SDK/JDK 21 blocker as every mobile cut since Sprint 3;
  Phase 9 was verified via the Vite web-preview build only, same
  verification tier as the "Mobile build fix" entry immediately above
  this one in this file.
- Nothing from this pass has been committed yet — sitting in the working
  tree pending the user's explicit go-ahead, per this project's own
  standing convention.

---

# DEVLOG — UI/UX audit remediation: contrast tokens, the dead scale knob,
# DataTable/AppShell accessibility, Dispatch Center polling, and the
# reported-vs-resolved line chart

## Today's cut

User-directed: "do it all" against the interface audit written earlier the
same session, plus two explicit design requests — replace the bar chart
with a two-series line chart matching a supplied reference, and give the
donut card the same treatment. Not a Sprint Prompts box.

## The finding the audit itself got wrong

**The `html { font-size: 75% }` scale knob has never worked, and the audit
repeated its own documentation as if it had.** `html, body { … font-size:
var(--font-size-md) }` further down `base.css` also sets font-size on the
root, at equal specificity and later in the file, so it won — and `rem` on
the ROOT element resolves against the browser's initial 16px, not against
the declaration being computed. Measured live: computed `html` font-size
16px, `1rem` = 16px.

The app has therefore always rendered at a 16px root. Every figure in the
audit's A3 ("body 12px, --font-size-sm 10.5px, .label 9px") was wrong; the
real values have always been 16 / 14 / 12px. The earlier browser
measurements in that same audit are consistent with this in hindsight — a
34px input height only works out at a 14px font, not 10.5px.

Fixed by removing `font-size` from the `html, body` rule (it applies to
`body` alone now) so the knob genuinely controls the root, and setting it
to **100%** — exactly what the app has been rendering at all along. Making
a dormant knob live must not silently resize a UI nobody asked to change.
The spacing-token trim that had been made on the assumption the root was
growing was reverted for the same reason. Net visual change: none. Net
behaviour change: the knob now actually responds if it is turned.

## A1 — solid status fills inverted in dark mode (highest severity)

Dark mode correctly lightens the status colours so they read as TEXT on a
dark ground. The same tokens were also used as solid backgrounds under
white text, where lightening is exactly backwards. Eight elements were
affected; the SOS banner — the most urgent element in the system — sat at
**2.77:1**, and the KPI icon glyphs at **1.67:1**.

Resolved with a `--color-*-solid` set locked to the light values in both
themes, which is the same distinction this codebase already drew once
between `--color-white` (literal) and `--color-surface` (theme-aware).
Applied to `.sos-banner`, `.sidebar__nav-badge`, `button.danger:hover`,
the four `.icon-badge--kpi` accents, and LiveMap's three marker fills.

## A2 — fifteen failing contrast pairs

Seven in light, eight in dark, each replaced with a verified value.
Notable: dark primary `#3B82F6` to `#2563EB` (3.68 to 5.17), and its hover
`#60A5FA` to `#1D4ED8` — the hover state used to get LIGHTER under white
text, the wrong direction entirely. Pill label colours were split onto
their own `--pill-*-text` axis, since text-on-tint and text-on-surface are
different contrast problems that were being answered with one value.

**Re-audited against the shipped tokens after the change: 46 pairs, 0
failures, both themes.**

## A structural fix that fell out of making that change

The dark palette was written out TWICE — once in the
`prefers-color-scheme` block, once in `[data-theme="dark"]`. Applying the
corrections to one copy and missing the other happened immediately and
silently while making this very change. The values now live once, in
`:root` as `--dark-*`, and the two blocks only remap onto them. A colour
changes in one place and both paths follow.

## Everything else from the audit

- **A5 landmarks**: `<aside>` / `<header>` / `<main>` in AppShell. The app
  had none — one `<nav>`, and otherwise all `div`.
- **A6 `document.title`**: now "Page — Baranguard"; every screen, history
  entry and bookmark previously read the same string.
- **A7 targets**: checkbox 13 to 18px inside a 24px label hit area, inputs
  `min-height: 2.5rem`, nav rows 44px.
- **A8/A9 DataTable honesty**: sorting is suppressed while paginated (it
  sorted one page and presented it as the whole set), and a new
  `ExportCsvButton` states what it will actually write —
  "Export CSV (25 of 30)" — instead of quietly emitting a partial file.
- **A10 `aria-sort`** moved from the button onto the `th`, where ARIA
  requires it; where it sat, nothing reported it at all.
- **A11 row semantics**: clickable rows no longer take `role="button"`,
  which overrode the row role and destroyed header/cell association. The
  first cell now carries a real activator button instead.
- **A13 mobile drawer**: below 768px the sidebar was a permanent rail of
  twelve unlabelled icons, with the collapse toggle ALSO hidden by
  `.sidebar__brand > :not(:first-child)` — no labels, no tooltips on
  touch, no way out. Now an off-canvas drawer with scrim and Escape.
- **A14**: collapsed-rail badges render as a corner pip rather than
  `display:none`, with the count carried in the item's `aria-label`.
- **A16**: `refreshNavCounts()` on the shell handle, called after
  acknowledge / approve / assign, so a badge cannot contradict the screen
  for up to 60 seconds.
- **A17**: roughly 35 lines of dead `.dispatch-card*` CSS removed.
- **A4**: all 27 hardcoded pixel inline styles replaced with tokens or
  named utility classes.

Per-screen: the SOS banner is actionable (names the Tanod, Acknowledge
wired to the Sprint 4 endpoint, "Show on map", `role="alert"`); W2's KPI
cards mutate in place instead of being replaced, which made them visibly
blink; W2 gained range presets, a freshness stamp and client-side range
validation; W4 roster rows centre the map; W6 states its 100-row cap
instead of silently truncating; W13 shows hours against the 56-hour
threshold with a proportional bar; W15 gained the password-rule checklist
and a note that changing a password signs out other devices; W19 gained a
copyable reference number and a "what happens next" line.

## W3 — the blocking defect

Dispatch Center loaded once and then only on an assign or cancel. A new
incident, or a new **Tanod SOS**, never reached the dispatcher until they
happened to act or navigate away and back — on the one screen whose entire
job is watching the queue. It now polls at 15s (matching GIS), with the
same contract: a failed background poll leaves a populated queue alone and
simply stops advancing the timestamp.

Two related fixes: the LiveMap instance is preserved across reloads (it
was destroyed and rebuilt every time, discarding the dispatcher's pan and
zoom — which polling would have made unusable), and the pending queue is
ordered critical-first, then oldest-first within a priority.

**Verified live:** the freshness stamp advanced 05:38:04 to 05:38:19
without any interaction.

## The charts

`TrendChart` (divs, one bar per day, single series) is replaced by
`LineChart` — inline SVG, multi-series, nice-rounded y-axis, at most six
x labels always including first and last, an area fill under each line,
point markers only when they will not collide, and colours read from
`--chart-line-*` at render time so a theme change is followed rather than
baked in. The donut legend is restyled to dot + category caption + bold
percentage, with the raw count kept alongside (a percentage alone hides
how small the sample is on a quiet week).

**The second series needed real data, and getting it honestly was the
interesting part.** `incident` has no `resolved_at`, and `updated_at`
moves on any write, so neither can answer "resolved on which day".
`GET /reports/summary`'s `trend[]` now carries `resolved`, bucketed on
`dispatch.completed_at` — the only resolution moment §5 actually records.
Stated in both the controller and the API client: an incident closed by
the Admin resolve action without a completed dispatch contributes to
`resolved_count` (a state count) but not to this series (a timing series),
so the two are not expected to reconcile. Confirmed against real seeded
data — 5 reported / 1 resolved-in-range against a `resolved_count` of 2,
exactly the documented divergence.

Nothing on either chart is invented, and `trend[].count` keeps its
existing meaning, so every prior consumer is unaffected.

## W8 — the redaction diff

The screen where a person certifies that personal information has been
removed presented the original and the draft as two plain blocks of prose;
finding what changed was a manual character-by-character read. A
word-level LCS diff now marks the removed spans inside the original, and a
count states what to check for ("4 identifiers removed: 2 name, 1 address,
1 phone"). No library and no model call — it runs over one narrative at a
time. Removal is marked by strikethrough and underline as well as colour,
so it survives greyscale and colour-blindness. Every token is written via
`textContent`; no reported text is ever parsed as markup.

Unit-tested in Node against six cases (name, address, phone, multiple
identifiers, no-op, empty draft) — 6/6.

## Tests performed (with evidence)

1. `node --check` clean on every JS file; `php -l` clean on
   `ReportsController.php`.
2. `node scripts/verify-web-wiring.mjs` — **313 checks, 0 failed** (up
   from 300).
3. **Token contrast re-audit against the shipped values — 46 pairs, 0
   failures**, both themes, WCAG 2.x relative-luminance formula. It was 23
   failures before this pass.
4. **Diff algorithm unit test — 6/6.**
5. **Live browser pass** against a disposable database and disposable API,
   with `web/` served from a scratch copy so the live setup on 8081 was
   never repointed: login, dashboard (line chart renders two series with
   correct axis ticks, donut legend restyled, presets, freshness stamp),
   Dispatch Center (self-refresh proven across a real poll interval, ID
   column, triage order, `aria-sort` present on 7 `th` elements, map
   canvas alive), landmarks present, `document.title` correct.
6. **All 12 screens swept in dark mode for un-themed light patches — 0
   found. Zero console errors across the entire pass.**
7. All disposable infrastructure torn down; `web/index.html` and
   `mobile/.env.local` verified back at their real values; the real
   `baranguard` database was never touched.

## One bug introduced and caught during this pass

Dispatch Center's `renderPopulated` clears `pageHeader.actions` on every
render to rebuild the StatStrip, which silently removed the freshness
stamp appended at construction time. Caught because the verification probe
returned no value for it; re-attached inside `renderPopulated`.

Also caught before running: a temporal-dead-zone reference in `KpiCard`
(`sparklineEl` used by `applyDelta` before its `let` was reached), and a
`shell` reference from inside a module-level function in
`dispatch-center.js` where it is not in scope.

## Not done

- The audit's remaining lower-priority per-screen items: W7/W9 print
  stylesheets, W14's date filter and `failure_reason` surfacing, W16
  triage affordances, W11 schedule grouping, the topbar avatar dropdown.
- Nothing from this pass has been committed.

---

# DEVLOG — Mockup-driven UI round 2: IN PROGRESS, session ended mid-phase
# for a conversation handoff. Read the "Not done" section before touching
# any of this.

## Today's cut

Not a Sprint Prompts box. The user supplied ten reference-design mockups
(pending-incidents table, blotter entry, a desired topbar treatment, four
KPI cards, Settings, SMS Monitor, three Analytics screens, plus — mid-turn
— an Electronic Blotter list+detail mockup and an Incident Management
mockup) and asked for nine changes together. A written 9-phase plan was
produced, reviewed against the actual schema/endpoints/§8 rules, and
**approved by the user** before any code was written. The approved plan
lives at `C:\Users\Jayson Buenosaires\.claude\plans\clever-wishing-hummingbird.md`
— **read that file first**, it is the actual scope contract for this
work, not just planning scratch.

**The session was interrupted by the user asking to hand off to a new
conversation before the phases were finished.** This entry exists so the
next session does not have to reconstruct scope or re-derive the
mockup-vs-schema conflicts from scratch. Phases 1, 3, 4 are code-complete
per their own scope (see caveats below); Phase 2 is half-done and
currently **fails the wiring check**; Phases 5-9 have not been started at
all.

## The constraint that shapes the whole plan (read this before building anything from the mockups)

Investigation before writing the plan found that several mockup elements
show data this system does not have, and two of them the Master Reference
has already explicitly refused:

- **"Performance by Barangay" bar chart** — §8: *"a cross-barangay
  comparison chart is architecturally impossible under the current tenant
  model, not just unbuilt"* (Rule 8 scopes every session to one barangay).
  **Not building this, ever, under the current tenant model.**
- **"Overall Performance Score" radar** — §8: axes are *"arbitrary demo
  numbers with no defined formula … never ship a chart backed by an
  undefined number."* Two of its axes (Coverage, Incident Prevention) have
  no §5 schema representation at all. **Not building this** without a
  scoring-formula design pass first (§10 item 7).
- **SMS composer / quick replies / Broadcast Alert** — §9 W14 literally:
  *"Do not build a compose/send UI against this endpoint."* User chose to
  keep W14 read-only and improve the existing table instead (Phase 8) —
  **do not build a two-way console**.
- **Settings mockup's system-wide sections** (notification rules, security
  policy, GIS parameters, SMS gateway credentials, backups) are **W21**,
  which the Master Reference says has *"no sprint assignment, schema, or
  endpoints"* and warns never to store gateway credentials in a settings
  row. User chose: adopt the mockup's rail+panel LAYOUT for W15's real
  fields only (Profile / Password / Appearance) — **do not build the W21
  sections**.

Full table of every mockup element that needed a substitution, and what it
was mapped to instead (real ENUM values, coordinates instead of invented
"Brgy. Dao, Zone 1" text, no delete action since none exists, etc.), is in
the plan file itself under "What the mockups show that the data cannot
back" — that table is the authoritative substitution list, not this entry.

Two backend extensions WERE approved and are still outstanding (Phase 9):
`by_hour[]` and `response_time_trend[]` on `GET /reports/summary`, both
bucketed Asia/Manila like the existing `trend[]`/`trend[].resolved`
precedent.

## What is actually done in this session

### Phase 1 — Dispatch queue double-scrollbar — CODE COMPLETE, not browser-verified

Root cause was two independent scroll containers: `.dispatch-queue`'s own
`overflow-y:auto` on a height-clamped column, and every `DataTable`'s
`.data-table-wrap { overflow-x:auto }` fighting a fixed 26.25rem column
whose dominant width cost was a full-name `<select>` **plus** a button
rendered inline in every pending row.

Fix: the Tanod picker moved OUT of the row into a dialog.
`ConfirmDialog.js` gained a second export, `promptSelect()`, sharing the
existing modal shell (`openDialog()` internal helper, focus trap now
queries live focusables instead of hardcoding two buttons) — returns
`Promise<string|null>`. `renderAssignCell()` in `dispatch-center.js` now
renders one compact `.dispatch-assign-button` and opens
`promptSelect({...})` on click; the row-width cost that was forcing
horizontal scroll is gone.

Layout: `.dispatch-layout` grid changed from a fixed `26.25rem 1fr` to
`minmax(24rem, 34rem) minmax(18rem, 1fr)`; `.dispatch-queue` no longer
sets `overflow-y` (the queue now scrolls the PAGE, via `.page-content`,
which is what `base.css` already documented as the intended single scroll
region); `.dispatch-map-pane` became `height:32rem; position:sticky;
top:0` so it doesn't stretch to match a long queue and stays in view while
the queue scrolls beside it. The `grow`/`flex-col` classes that used to
clamp the whole page to 100% height were removed from
`dispatch-center.js`'s wrapper/body/container/layout elements, since
nothing needs the page height-clamped anymore.

**Files:** `web/src/components/ConfirmDialog.js` (+`.css`),
`web/src/pages/dispatch-center.js`, `dispatch-center.css`.

**Verified:** `node --check` clean, `verify-web-wiring.mjs` clean at the
time this phase landed. **NOT verified:** no live browser pass yet — the
plan's own verification section calls for measuring
`scrollWidth === clientWidth` on `.data-table-wrap` and confirming the
Assign flow completes end-to-end through the new dialog. Neither has been
done.

### Phase 3 — Avatar menu + notification bell — CODE COMPLETE, not browser-verified, backend not integration-tested

New `web/src/components/Menu.js` (+`.css`) — extracted from the pattern
the topbar's own search-results dropdown already used inline (anchored
panel, Escape, outside-click, arrow-key roving). Two exports: `Menu()`
returns `{el, panel, open, close, isOpen}`; `MenuItem()` builds one
`role="menuitem"` row. Deliberately NOT a modal — no backdrop, no focus
trap, dismissible without blocking, which is why it's a separate
component from `ConfirmDialog`.

**Backend:** `GET /notifications` added — genuinely new, not in §6.
`NotificationsController::index()` reads the CALLER'S OWN
`notification_target` rows (joined to `notification`, tenant + user
double-scoped, neither half client-suppliable), returns
`{items[], unread_count}`. No narrative text of any kind is returned by
design (Rule 1). Same "real gap, real endpoint, same precedent as
GET /barangays / GET /search / GET /reports/nav-counts" reasoning already
established in this codebase. Route added to `routes/notifications.php`
alongside the existing Tanod-only `POST /notifications/:id/ack`.
`php -l` clean. **NOT tested against a live database** — no seed data
exists yet for `notification`/`notification_target` in any disposable rig
from this session, and the endpoint has never been curled.

**Frontend:** `AppShell.js`'s `.topbar__user` rebuilt — the old
avatar+name+separate-Sign-out-button became a bell (`Menu` instance,
`GET /notifications` on open, unread-count pip, click-through to
`blotter-detail` or `dispatch` depending on notification type) and an
avatar-menu (`Menu` instance containing a header with name/role, a
Settings item gated on the same role check the sidebar nav uses, the
theme toggle relocated in as a menu item, and Sign Out as a `danger`
`MenuItem`). `shell.logoutButton` is still exported and still the actual
button other pages disable during sign-out — it's just a `MenuItem` now
instead of a bare `<button class="ghost">`.

**Files:** new `Menu.js`/`.css`, `AppShell.js`/`.css`,
`backend/controllers/NotificationsController.php`,
`backend/routes/notifications.php`, `web/src/api/apiClient.js`
(`getNotifications()`), `web/index.html` (Menu.css link).

**Verified:** `node --check` / `php -l` clean, `verify-web-wiring.mjs`
clean at the time this phase landed. **NOT verified:** no browser pass —
open/close on Escape and outside-click, arrow-key nav, and the bell count
actually matching a seeded row are all still unconfirmed. No integration
test of `GET /notifications` itself.

### Phase 4 — KPI card convention — CODE COMPLETE, not browser-verified

`KpiCard.js` reordered from icon→label→value→delta to the mockup's
header-row (icon left, delta right) → value → label. `delta` is now
percentage-based when a new `previousValue` argument is supplied (falls
back to the raw absolute difference when the prior period was zero, since
a percentage against zero is meaningless). New `trend` argument —
`'up-good' | 'down-good'` — colours the delta only when the caller states
which direction is actually good for that specific metric; omitted
entirely, the delta stays neutral. This is a **deliberate deviation from
the mockup**, logged in the component's own doc comment: the mockup tints
`+12%` on Total Incidents green, but more incidents is not good news, and
blanket green-up/red-down would encode a judgement the data doesn't
support. `admin-dashboard.js` updated: Resolved Cases gets `trend:
'up-good'`, Avg Response Time gets `trend: 'down-good'` (lower is
better), Total Incidents gets no `trend` (stays neutral). `setDelta()`'s
signature changed to `(delta, previousValue)` — both call sites in
`loadDeltas()` updated to pass the prior period's raw value.

**Files:** `KpiCard.js`/`.css`, `admin-dashboard.js`.

**Verified:** `node --check` clean, `verify-web-wiring.mjs` clean.
**NOT verified:** no browser pass confirming the visual reorder or the
percentage math against real seeded data. `statistical-reports.js` (which
also renders `KpiCard`s per the plan's Phase 9 scope) has **not** been
touched yet — it still calls the old prop shape, which still works
(no new required props) but doesn't get the reordered header/delta
treatment until Phase 9 lands.

### Phase 2 — Blotter Entry reorganised — **HALF DONE, CURRENTLY BREAKS THE WIRING CHECK**

`blotter-detail.js`'s `render()` was restructured from six full-width
`.card`s stacked vertically into the existing `.split-panel` utility
(`1fr 20rem`, already collapses to one column at 1024px): left column
gets Overview/Narrative/Evidence/the Secretary's finalize-amend panel,
right column gets the Timeline and the Admin resolve panel. The function
now wraps everything in `layout` > `main`/`aside` divs with classes
`split-panel`, `stack--md blotter-detail__main`, `stack--md`.

**`blotter-detail__main` is not defined anywhere.** The plan called for a
new `blotter-detail.css` file (this screen has never had one — it was
built entirely from `base.css` utilities) and it was never created, and
never linked into `index.html`. Confirmed right now:

```
node scripts/verify-web-wiring.mjs
[FAIL] src/pages/blotter-detail.js uses undefined CSS class(es): blotter-detail__main
318 checks passed, 1 failed
```

**This is the very next thing to do.** `blotter-detail__main` doesn't
strictly need any rules (it exists so the left column has a hook for
future styling), so the minimal fix is either give it an empty/trivial
rule in a new `blotter-detail.css` (linked in `index.html`) or drop the
class from the `main` div if nothing ends up needing it. The original
timeline (today's plain key/value `.row-between` rows) was also meant to
become a real vertical rail with connector + filled/hollow stage nodes
per the plan — **that visual change has not been started**, only the
two-column wrapping around the existing `buildTimeline()` output.

**Files touched so far:** `web/src/pages/blotter-detail.js` only.
`blotter-detail.css` does not exist yet.

## What has NOT been started at all

- **Phase 2's remainder** — the CSS file, the real vertical timeline
  visual (rail + nodes), and all verification.
- **Phase 5 — Incident Management (new screen).** No file created. Needs
  `GET /incidents` wired with status/priority filters + status chips
  (counts from `by_status`) + pagination, new nav entry.
- **Phase 6 — Electronic Blotter (W6) rebuilt as a records view + details
  panel.** Needs a new `GET /blotter` LIST endpoint (only
  `GET /blotter/:id` and `GET /incidents/:id/blotter` exist today) —
  `BlotterController::index()` does not exist. No frontend work started.
- **Phase 7 — Settings (W15) rail+panel layout.** No file changes.
- **Phase 8 — SMS log date filter, inline failure_reason, expandable row
  detail, stat strip.** No file changes. `SmsController.php` does not yet
  accept `date_from`/`date_to`.
- **Phase 9 — Analytics (W9 upgraded) + BarChart + ChartTooltip
  components + `by_hour[]`/`response_time_trend[]` on
  `GET /reports/summary`.** Nothing built. `statistical-reports.js` is
  still the pre-existing screen.

## Environment state at handoff

- No disposable servers left listening (checked `8230/8231/8240/8241/8250/8251`
  — all clear).
- **A stray database `baranguard_device_check` exists** on the local
  MySQL instance, alongside the real `baranguard` DB. It was not created
  by anything in this documented session and its origin wasn't
  investigated — flagged for a future cleanup pass, not dropped
  speculatively.
- The real `baranguard` database and `backend/.env` were not touched by
  anything in this entry.
- **Nothing in this entire round-2 body of work is committed.** It sits
  in the working tree alongside the already-uncommitted round-1 UI/UX
  audit remediation (dark mode, contrast tokens, Dispatch polling, the
  line chart — see the DEVLOG entry immediately above this one) and the
  older uncommitted mobile build-fix files
  (`mobile/package-lock.json`, `mobile/src/pages/home.tsx`,
  `mobile/src/services/deviceIdentity.ts`, `mobile/src/theme/app.css`).

## Suggested order for the next session

1. Fix the immediate break: create `blotter-detail.css`, link it in
   `index.html`, re-run `verify-web-wiring.mjs` until clean.
2. Finish Phase 2's real timeline visual, then browser-verify Phases 1-4
   together on one disposable rig (they all touch the same nav shell and
   dashboard) before moving on — per this project's own standing
   discipline, don't stack more unverified phases on top of unverified
   ones.
3. Phases 5-9 in the plan's own order — Phase 6 depends on nothing else
   and unblocks the biggest visible mockup (Electronic Blotter); Phase 9
   is the largest single phase (two new chart components + a backend
   extension) and is naturally last.
4. Re-run the full verification section at the bottom of the plan file
   once all nine phases are code-complete — it has not been run even
   once yet, since no phase has reached that point.

---

# DEVLOG — Sprint 7: Retention jobs (§11's retention table, all record types)

## Today's cut

Sprint 7's **"Retention jobs (§11's table, all record types)"** box — one
box, picked and stopped at, per the sprint prompt's own rule. None of the
other four Sprint 7 boxes (audit completeness, backup/restore drill,
pen-test pass, W17/W20/W9-export) were started.

## Four schema gaps found before any job code was written

§11's retention table is not implementable against the 0001 baseline.
Found by reading the actual DDL rather than trusting that a documented
policy had backing columns — all four fixed in **migration 0007** (a new
file, never editing the completed 0001, same convention as
0003/0004/0005/0006):

1. **`incident.raw_narrative` was `TEXT NOT NULL`.** The single most
   important rule in §11 — delete raw narrative 30 days after approved
   redaction, 90-day hard ceiling if never approved — was *literally
   unexecutable*: there was no value the job could write that means
   "purged". Made nullable. Writing an empty string instead was
   rejected: it is indistinguishable from a bug that saved a blank
   narrative.
2. **`incident` had no `legal_hold`**, yet §11 names legal hold as "the
   only exception" to both the raw-narrative rule and the 7-year rule.
   `evidence_attachment` and `citizen_report` already had one; the one
   table that matters most did not.
3. **No way to record that a purge happened** — added
   `raw_narrative_purged_at`, the per-record evidence Rule 17 wants from
   a retention job, which also makes re-scans cheap.
4. **`mobile_device` had `is_active` but no deactivation timestamp**, so
   §11's "deleted 90 days after deactivation" had no clock to count
   from. Added `deactivated_at`; `DevicesController` now sets it on both
   deactivation paths and CLEARS it on re-registration (a device that
   comes back is not on a retention clock).

Backfill decision for rows already inactive at migration time:
`deactivated_at = UTC_TIMESTAMP()`, i.e. the clock starts *now* rather
than being back-dated. We genuinely do not know when those rows were
deactivated, and starting now can only ever delay a deletion, never
cause an early one.

## Resolved decisions (logged; don't reopen without review)

- **An incident's `legal_hold` covers its dependent case records.**
  `blotter_record`, `blotter_revision`, `dispatch` and
  `ai_processing_log` have no `legal_hold` of their own. A hold is placed
  on a *case*, not a row — holding the incident while its blotter entry
  stayed purgeable would be an obviously wrong reading of §11.
- **Retention periods are `const`s, not env vars.** §11 says these
  "implement directly as retention-job constants; a later change requires
  the same architecture-review process as any other resolved decision,
  not a runbook edit." An operator cannot quietly shorten the
  raw-narrative ceiling by editing a config file.
- **Legal-hold skips are counted and reported, never silent.** A run that
  did nothing because everything was held is otherwise indistinguishable
  from a broken job; every rule reports `purged` *and* `held`.
- **The 7-year case purge is one transaction per incident, in dependency
  order** — `ai_processing_log` → `blotter_revision` → `blotter_record` →
  `evidence_attachment` → `dispatch` → `incident`, because all five are
  `ON DELETE RESTRICT` against incident in §5. Slower than one bulk
  DELETE, and the only way a failure part-way rolls back a whole case
  instead of leaving half of one committed.
- **Evidence bytes are unlinked from disk**, with the resolved path
  asserted to stay inside `EVIDENCE_DIR` — the same containment check
  `MapPackagesController` uses. A retention job steerable into unlinking
  arbitrary files via a crafted `file_path` would be far worse than the
  data it is trying to remove.
- **One audit row per rule per run, carrying counts** (Rule 17), not one
  per deleted record: a 7-year purge can touch thousands of rows, and
  `audit_log` is itself on a 7-year clock. Per-record evidence for the
  rule that most needs it already exists as `raw_narrative_purged_at`.
  Audit rows carry NULL actor/barangay — this is the system acting on a
  schedule, and inventing an actor would make the trail lie.
- **`--dry-run` is a first-class mode**, so an operator can see the blast
  radius of the first-ever run on real data before committing to it.
- **CLI-only, no HTTP endpoint.** §6 documents none, and a web-reachable
  "delete everything past its date" action has no upside on a LAN system
  (Rule 7). Same reasoning that keeps `ai-worker.php` off the API.
- **Backups are explicitly OUT of scope**, and the job says so on every
  run. §11/Rule 11 make backups part of retention, but they are encrypted
  files produced by `scripts/backup.sh`, not rows — expiring them is a
  runbook step with its own restore-safety implications. A standing
  reminder on every run beats silently implying the data is gone
  everywhere.
- **The offline mirror is a documented NO-OP** (`purgeOfflineQueue()`), so
  a future session doesn't read the absence as an oversight and invent a
  clock §11 explicitly declines to define.

## Files

**New:** `migrations/0007_retention_columns.sql` (+ `.down.sql`),
`services/retention/RetentionService.php`, `scripts/retention-job.php`,
`scripts/verify-sprint7-retention.sh`.

**Modified:** `controllers/DevicesController.php` (sets/clears
`deactivated_at`); `scripts/verify-devices-map-packages.sh`,
`verify-sprint4.sh`, `verify-sprint4-phase2-3.sh` (each now applies 0007
— see the regression below).

## A real regression this session caused, caught and fixed

Adding `deactivated_at` to `DevicesController`'s SQL broke **10 checks in
`verify-devices-map-packages.sh`** — device registration started
returning 500. Not a logic bug: those suites build their disposable
database from 0001+0002 only, so the column the controller now writes did
not exist there. Fixed by having every suite that registers a device
apply 0007 too, the same way suites already apply 0004/0006 when they
need them. Worth recording as a category: **adding a column to a
controller's SQL silently breaks every verify script whose disposable
schema predates it** — app code and test schema are two things to keep in
step, and only re-running the older suites catches the drift.

## Tests performed (with evidence)

1. `php -l` clean on all three new/modified PHP files.
2. **`backend/scripts/verify-sprint7-retention.sh` — 66/66 against real
   XAMPP** (MariaDB 10.4.32 + PHP 8.2.12), disposable database +
   disposable app-user + throwaway port, all torn down after.

   Every §11 window is long (90 days is the shortest), so the suite seeds
   rows with **back-dated timestamps on both sides of each boundary** and
   asserts the job takes exactly the outside one — testing the real
   boundary in seconds instead of waiting a year. What it proves:
   - Migration 0007's four columns exist and `raw_narrative` is nullable,
     asserted against `information_schema`, not assumed from the
     migration file's intent. Re-running 0007 is a clean no-op.
   - `--dry-run` reports `2 eligible, 1 on legal hold` and **deletes
     nothing** (all 5 raw narratives verified intact afterwards).
   - The 30-day grace: a 40-day-approved incident is purged
     (`raw_narrative` NULL **and** `raw_narrative_purged_at` set); a
     10-day-approved one is kept.
   - The 90-day ceiling fires on an unapproved 100-day incident and
     spares an unapproved 30-day one.
   - **Legal hold blocked an otherwise-eligible purge** on incident,
     citizen_report, and the 7-year cascade, each independently.
   - Approved redactions survive the raw purge (the entire point of it).
   - Rule 17: exactly one audit row, NULL actor/barangay, count in
     metadata, and the row **grepped to confirm no narrative text leaked
     into it**.
   - Re-running any rule is a no-op.
   - `citizen_report`: 400-day unconverted purged, 100-day kept, and a
     **converted** report ignored the rule entirely (§11: it follows its
     incident).
   - `ai_processing_log`: a 400-day-old draft was **kept**, because its
     incident's 7-year clock is the longer of the two — "whichever is
     longer" demonstrated, not merely coded.
   - `mobile_device`: 120-day-deactivated purged (its secret with it),
     30-day-deactivated kept, active device untouched.
   - `audit_log`: a 3000-day row purged, a 100-day row kept, and the
     purge audited itself *after* the delete so it cannot catch its own
     row.
   - **The 7-year cascade**, seeded with all five RESTRICT dependents:
     incident, dispatch, evidence row, blotter record, blotter revision
     history and AI drafts all gone; **the evidence FILE confirmed
     unlinked from disk**; an 8-year-old **legal-hold twin of the same
     age survived**; and the converted citizen_report survived with
     `incident_id` SET NULL, then was purged by the *next* run under its
     own 1-year clock — §11's "converted reports follow the incident"
     shown end to end.
   - `DevicesController` really sets the clock: a freshly registered
     device has NULL `deactivated_at`, the deactivate endpoint sets it,
     and re-registering clears it — driven through the real HTTP
     endpoints, because the 90-day rule is worthless if nothing sets that
     column in production.
3. **Every pre-existing suite that touches devices re-run to confirm the
   regression above is closed:** `verify-devices-map-packages.sh`
   **54/54**, `verify-sprint4.sh` all passed,
   `verify-sprint4-phase2-3.sh` **69/69**, `verify-sprint6.sh` all
   passed.
4. **Migration 0007 applied to the REAL local `baranguard` database** —
   all four columns confirmed present via `information_schema`,
   `raw_narrative` confirmed nullable, and all 7 existing incidents
   intact afterwards.
5. **`--dry-run` executed against the real database**: runs clean,
   correctly reports 0 eligible for every rule (nothing on this
   workstation has aged past even the 90-day ceiling yet), and prints the
   backup reminder.

## Two test-script bugs found and fixed before the clean run (not app bugs)

Both mine, both in the suite's own expectations: a miscounted survivor
total (6 is correct — 5 in-window incidents plus the legal-hold twin, not
5), and a case-sensitivity assertion (`Legal hold` starts a sentence in
the real output; the check looked for lowercase). The second is the
**third** time this repo has logged a case-sensitivity assertion bug — a
genuinely recurring category, not a one-off.

## NOT done (explicitly out of this cut)

- **Backup expiry** — see the resolved decision above; out of scope for a
  database job by design, and flagged on every run instead.
- **No scheduled trigger is installed.** The job is a CLI script; wiring
  it to Windows Task Scheduler (daily) is a deployment/runbook step, not
  a code one. It is safe to run repeatedly and safe to miss days —
  nothing is keyed to "ran yesterday".
- **The 7-year rules have never fired on real data** and cannot for
  years — they are proven only against back-dated fixtures, which is the
  only way they *can* be proven today.
- Sprint 7's other four boxes: audit completeness, backup/restore drill,
  pen-test pass, W17/W20/W9-export. None started.

---

# DEVLOG — Sprint 7 completed: audit completeness, backup/restore drill,
# incident penetration pass, W17/W20/W9 (closes Sprint 7)

## Today's cut

The four remaining Sprint 7 boxes, in one session at the user's explicit
direction ("complete all the sprint 7") — the same documented multi-box
exception as prior sessions, not a drift from the "pick exactly ONE"
rule:

  - Audit completeness (§2 Rule 17's full action list)
  - Backup/restore drill (restore actually tested)
  - Pen-test pass — incidents (the box's own one-resource scoping)
  - W17 Audit Log Viewer / W20 Service Health / W9 Export button

With the retention box from earlier the same day, **Sprint 7 is closed.**

Unlike the earlier all-at-once sessions (Sprint 3, Sprint 5), everything
here is genuinely verified: **446 checks passing across seven suites,
zero failures**, all against real XAMPP.

## Box: Audit completeness

Rule 17 names sixteen action classes. Mapping them against the code
found **six real gaps** — not missing plumbing, but actions that
happened silently:

  - `dispatch_created` / `dispatch_cancelled` — Rule 17 says "dispatch
    create/override/cancel"; only *override* was audited. Assigning a
    Tanod to an incident, and cancelling that assignment, left no trace.
  - `shift_created` / `shift_updated` — `ShiftsController` had **no audit
    coverage at all**, despite Rule 17 naming "shift changes" explicitly.
  - `swap_request_resolved` — `ShiftSwapRequestsController` likewise had
    none. An approved swap silently reassigned a shift with nothing
    recording who decided it.
  - `user_updated` — `UsersController` had none, against Rule 17's "user
    changes/deactivation".
  - `fatigue_flag_acknowledged` — not named verbatim in Rule 17, added
    anyway: it is a safety decision an Admin makes about a specific
    Tanod, which is what the rule's "shift changes" clause is for, and §9
    W13 wants that record permanent.
  - `report_exported` — new, required by §6's "request is scoped and
    audited" for the export endpoint built in the same session.

`user_updated`'s metadata records **which fields changed, never the
values** — `contact_number` is personal data and Rule 17 allow-lists
metadata to identifiers and statuses. The suite asserts exactly that: it
greps the audit row for the contact number it just set and fails if it
appears.

## Box: W17 / W20 / W9 — three screens, two new endpoints

**`GET /audit-log`** (new, `AuditLogController`) — Admin, own barangay,
newest-first, §9 W17's 7-day default applied server-side as a DEFAULT not
a cap (an Admin investigating something older passes a date range;
capping the window would make the viewer useless for the exact
investigation an audit log exists for). Read-only by construction: one
method, no write routes, and the suite asserts POST/PATCH/DELETE/PUT on
`/audit-log` are all unrouted.

Rows written by system jobs carry NULL `barangay_id` and are therefore
**not** visible to a barangay Admin. That is a deliberate consequence,
documented rather than discovered later: those rows describe
workstation-wide maintenance, not that barangay's operations, and
`NULL = 1` is false in SQL rather than a leak.

**`GET /reports/export`** (new, + a protected download route) — §6's
"{file_url,format,generated_at} for approved formats; request is scoped
and audited". CSV is the only approved format, and an unsupported one is
a **400 naming what is supported, never a silent fallback to CSV** — a
caller asking for XLSX and receiving CSV bytes is worse than a refusal.
Content is exactly `GET /reports/summary`'s aggregates for the same
range, so file and screen cannot disagree, and the file is written
outside the web root and served through an authorized route (same
precedent as the Lupon packet). The suite greps the exported CSV for the
seeded raw narrative and asserts it is absent.

**W20 Service Health** closed a gap it inherited: `restore_test_at` was
honestly hardcoded `null` with a comment explaining that nothing ever
recorded a drill. The drill script below now records one, and
`SystemHealthController` reads the marker's own `drill_completed_at`
line rather than the file's mtime — so copying or touching the file
cannot make a stale drill look recent.

The screen's whole design point is honesty about what is not wired up:
`not_configured` renders **neutral with an explanation, never red and
never green**. An OSRM that was never installed is not an outage, and
showing it as one would train an operator to ignore the screen; showing
it green would be the fabricated "all systems operational" §8 forbids.

## Box: Backup/restore drill

`backup.sh` already proved a file can be written; `restore.sh` already
proved it can be decrypted and loaded. **Neither proved the restored data
is the same data.** `scripts/restore-drill.sh` does: it fingerprints the
live database per-table, restores into a throwaway `<db>_drill`,
fingerprints that, and fails loudly if they disagree.

Row counts per table, not a dump hash — a dump embeds a timestamp and its
row order is not guaranteed stable, so comparing dumps byte-for-byte
would produce false failures while missing the failure that matters (data
missing after a restore).

**Verified against the REAL `baranguard` database**: 26 tables, every row
count matching, the four deterministic barangay rows identical, and 61
foreign keys restored. 12/12.

Non-destructive by construction: the live database is only ever READ, and
there is no flag to restore over it — a real disaster recovery is a
supervised operation, not something to make one typo away.

### Three real environment findings while building it

1. **The app's DB user cannot `CREATE DATABASE`** — correct
   least-privilege, exactly as Sprint 0's DEVLOG recorded. The fix was
   NOT to grant it more: the script now takes separate `DRILL_DB_USER`/
   `DRILL_DB_PASSWORD` (DBA) used *only* to create/drop the drill
   database and load the dump, while the dump itself still runs as the
   app user — which is what a real scheduled backup runs as.
2. **My first version sourced `.env` in a way that OVERRODE the
   environment**, inverting the precedence `config/env.php` documents and
   applies. It silently ignored `DB_USER=root`, which is exactly the
   override a drill needs. Fixed to capture-then-restore preset values.
   Worth remembering: `set -a; . .env` is the wrong default in this repo.
3. **`restore.sh` refuses an empty `DB_PASSWORD`** by design, and XAMPP's
   stock root has none — so the drill mints a throwaway user with a real
   password scoped to the drill database only and drops it afterwards,
   the same pattern every `verify-*.sh` here already uses for the same
   reason.

## Box: Pen-test pass — incidents

Incidents were the right first resource: `raw_narrative` is the most
sensitive field in the schema, and §6 gives the incident family the most
intricate authorization in the system — eleven endpoints, four roles,
with the Secretary deliberately holding access the higher-privileged
Admin does not.

**68/68, and it found nothing broken on the first run.** That is a real
result, not a weak test: every check is an outside-in HTTP request with a
real token, across four attack dimensions —

  - **No token → 401** on all thirteen incident endpoints, plus a forged
    JWT, a garbage token, and an **`alg:none` token** (the classic bypass
    — the algorithm allow-list holds). A deactivated Admin cannot log in
    at all.
  - **Wrong role → 403**, including the §3 asymmetry asserted in the
    direction that matters: **Admin is REFUSED** finalize, amend, Lupon
    packet, redact and ai-draft. Someone "fixing" that asymmetry later
    now breaks a test.
  - **Cross-tenant → 404, never 403** — a 403 would confirm the incident
    exists. Asserted on read, evidence, blotter, resolve, finalize,
    redact and packet, plus that the list endpoint excludes it entirely
    and a client-supplied `barangay_id` in the body is ignored.
  - **Wrong owner (Tanod) → 404** on read/evidence/blotter, an empty
    list, and a 422 when claiming an unregistered device id.

Plus the disclosure test the whole suite exists for: `raw_narrative`
reaches the Secretary and **no one else** — asserted individually for
Admin, PB and the reporting Tanod — never appears in the list endpoint
even for the Secretary, and never appears in a cross-tenant 404 body.
Evidence responses carry no filesystem path (§6). Workflow prerequisites
cannot be skipped by calling out of order, and after every refused call
`redacted_narrative` is verified still NULL — no partial write leaked
through.

## Files

**New:** `controllers/AuditLogController.php`, `routes/audit-log.php`,
`scripts/restore-drill.sh`, `scripts/verify-sprint7-audit.sh`,
`scripts/verify-sprint7-pentest-incidents.sh`,
`web/src/pages/audit-log.js`, `web/src/pages/service-health.js`,
`web/src/pages/service-health.css`.

**Modified:** `controllers/DispatchController.php`, `ShiftsController.php`,
`ShiftSwapRequestsController.php`, `UsersController.php`,
`FatigueFlagsController.php` (the six audit gaps);
`controllers/ReportsController.php` (+`export`, `exportDownload`);
`controllers/SystemHealthController.php` (`restore_test_at` now real);
`routes/reports.php`; `web/src/api/apiClient.js`, `main.js`,
`components/AppShell.js`, `pages/settings.js`,
`pages/statistical-reports.js` (Export button), `web/index.html`.

## Tests performed (with evidence)

`php -l` and `node --check` clean across every touched file;
**`verify-web-wiring.mjs` 373/373**; and seven suites against real XAMPP:

| Suite | Result |
|---|---|
| `verify-sprint7-retention.sh` | **66/66** |
| `verify-sprint7-audit.sh` | **56/56** (20 distinct audited actions) |
| `verify-sprint7-pentest-incidents.sh` | **68/68** |
| `verify-sprint4.sh` | all passed |
| `verify-sprint6.sh` | all passed (112) |
| `verify-devices-map-packages.sh` | **54/54** |
| `verify-scheduler-fatigue.sh` | **42/42** |

Plus the restore drill itself: **12/12 against the real database.**

## One test-script bug found and fixed (not an app bug)

The audit suite initially failed one check: a non-Admin got 401 instead
of 403 on `/audit-log`. The cause was the suite's own account reuse — it
changed a password on the same account whose token a later role-gate
check used, and **changing a password correctly revokes that user's other
sessions** (verified back in Sprint 1). The application was right; the
test was wrong. Fixed by giving the password-change check its own
account, with a comment explaining why it cannot share one.

## NOT done (stated plainly)

- **No browser pass on W17 or W20.** Both screens are wired, lint-clean
  and wiring-checked, and their endpoints are verified end-to-end — but
  neither has been opened in a browser. They join the round-2 UI phases
  on the same outstanding checklist.
- **The real backups directory was deliberately left untouched.** The
  drill was proven against the real database using a scratch backup
  directory and a throwaway passphrase, because writing a backup
  encrypted under a passphrase the user does not know into their own
  backups folder would be a liability, not an asset. **Consequence,
  stated rather than hidden: `GET /system/health` still reports
  `restore_test_at: null` and W20 still shows "Never"** until the user
  runs the drill once with their own `BACKUP_ENCRYPTION_PASSPHRASE`:
  `BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh`
- **The pen-test covers incidents only** — that is the box's own scoping
  ("testing every §6 endpoint in one sitting isn't a single cut").
  Dispatch, shifts, citizen reports, SMS and map packages have had no
  equivalent pass.
- **Backup file expiry is still not implemented** (§11/Rule 11 —
  unchanged from the retention entry; `backup.sh` prunes on age only).
- W10, W18, W21 remain unbuilt; W21 is still blocked on an architecture
  review by its own §9 note.
