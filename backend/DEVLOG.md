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
