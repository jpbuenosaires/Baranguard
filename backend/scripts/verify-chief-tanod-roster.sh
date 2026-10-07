#!/usr/bin/env bash
# Baranguard — Chief Tanod on the roster (Wave 3b-K, review decision 21).
#
# Proves over real HTTP that an ADMIN account (the Chief Tanod, one account)
# can be rostered, with every existing shift rule applying to it unchanged:
#   1. POST/PATCH /shifts accept an active same-barangay admin user_id;
#      secretary/PB/inactive/other-barangay/unknown users are still refused;
#   2. 12 h / Manila-day cap counts across the admin's shifts (a cross-
#      midnight shift is split at the Manila boundary); no overlaps;
#   3. draft/published: admin shift is a draft until an approve_roster holder
#      publishes; editing a published admin shift reverts it to draft;
#      NO_COVERAGE warning still computed; unassigning allowed;
#   4. swap requests stay tanod-to-tanod (target admin is refused);
#   5. admin is NOT dispatchable and never qualifies for a dispatch offer;
#   6. segregation of duties: assertNotPreparer throws for the same user; an
#      admin still cannot edit their OWN approve_* authorities (403) but
#      another admin can;
#   7. KNOWN GAP (asserted, not built): an admin cannot create accomplishment
#      entries (tanod-only), so an admin is never a report preparer today.
#
# Disposable DB + app user + port (Wave 3b agent K range 9301-9399). FULL
# migration chain. Real databases and backend/.env are never touched.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
PASS=0; FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }
expect_in() { case " $2 " in *" $1 "*) pass "$3 ($1)";; *) fail "$3 — got '$1', wanted one of: $2";; esac; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_ctr_check"
APP_USER="ctr_app"
APP_PASSWORD="ChiefRoster!2026"
API_PORT="9301"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="ChiefRoster#2026Pw"

echo "Baranguard Chief-Tanod-roster validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"; PHP_BIN="$(find_bin php)"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }

mysql_exec() { MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"; }
db_one() { mysql_exec -N -s "$VALDB" -e "$1"; }

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.ctr-server.log" "$BACKEND_DIR/scripts/.ctr-body.json" "$BACKEND_DIR/scripts/.ctr-unit.php"
  echo "Dropped $VALDB / user '$APP_USER'. Real databases and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (FULL migration chain) + accounts"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort | awk -v s=0001_baseline_schema '$0 >= s'); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain applied (globbed)"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, is_suspended, official_title, approval_authority, created_at) VALUES
  (1, 'chief',    '$HASH', 'Chief Alpha',     'admin',           1, 0, 'Chief Tanod',     'note_report,prepare_annex_d,approve_report', UTC_TIMESTAMP()),
  (1, 'chief2',   '$HASH', 'Chief Beta',      'admin',           1, 0, 'Deputy Chief',    '', UTC_TIMESTAMP()),
  (1, 'chief_off','$HASH', 'Chief Inactive',  'admin',           0, 0, NULL,              '', UTC_TIMESTAMP()),
  (2, 'chief_b2', '$HASH', 'Other Chief',     'admin',           1, 0, 'Chief Tanod',     '', UTC_TIMESTAMP()),
  (1, 'sec1',     '$HASH', 'Sec One',         'secretary',       1, 0, NULL,              '', UTC_TIMESTAMP()),
  (1, 'pb1',      '$HASH', 'Punong One',      'punong_barangay', 1, 0, 'Punong Barangay', 'approve_roster,approve_report', UTC_TIMESTAMP()),
  (1, 'tan1',     '$HASH', 'Tanod One',       'tanod',           1, 0, NULL,              '', UTC_TIMESTAMP()),
  (1, 'tan2',     '$HASH', 'Tanod Two',       'tanod',           1, 0, NULL,              '', UTC_TIMESTAMP());
SQL
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
CHIEF=$(uid chief); CHIEF2=$(uid chief2); CHIEF_OFF=$(uid chief_off); CHIEF_B2=$(uid chief_b2)
SEC=$(uid sec1); PBID=$(uid pb1); TAN1=$(uid tan1); TAN2=$(uid tan2)
pass "Seeded admins (3 in barangay 1, 1 in barangay 2), secretary, PB, 2 tanods"

step "2. Start API"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15 CORS_ALLOWED_ORIGIN='*' GSM_GATEWAY_ENABLED=false
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.ctr-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

uuid() { "$PHP_BIN" -r '$h=bin2hex(random_bytes(16)); echo substr($h,0,8)."-".substr($h,8,4)."-4".substr($h,13,3)."-8".substr($h,17,3)."-".substr($h,20,12);'; }
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=$argv[1]; echo is_array($d) && array_key_exists($k,$d) ? (is_scalar($d[$k]) ? $d[$k] : json_encode($d[$k])) : "MISSING";' "$1"; }
BODY_FILE="$BACKEND_DIR/scripts/.ctr-body.json"
bj() { printf "%s" "$BODY" | jget "$1"; }
login_tok() { curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | jget token; }
req() {
  local method="$1" path="$2" token="$3" body="${4:-}"; shift 4 2>/dev/null || shift $#
  local args=(-s -o "$BODY_FILE" -w '%{http_code}' -X "$method" "${BASE_URL}${path}" -H "Authorization: Bearer $token")
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" -d "$body"); fi
  CODE=$(curl "${args[@]}" "$@"); BODY=$(cat "$BODY_FILE" 2>/dev/null)
}
err_code() { echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["error"]["code"] ?? "";'; }
shift_body() { echo "{\"user_id\":$1,\"start_at\":\"$2\",\"end_at\":\"$3\",\"patrol_zone\":\"Zone A\",\"request_id\":\"$(uuid)\"}"; }

ADM=$(login_tok chief); ADM2=$(login_tok chief2); SECT=$(login_tok sec1); PBT=$(login_tok pb1)
[ -n "$ADM" ] && [ "$ADM" != "MISSING" ] && pass "Logged in as the Chief Tanod admin" || { fail "admin login failed"; exit 1; }

step "3. POST /shifts: who can be rostered"
req POST /shifts "$ADM" "$(shift_body $CHIEF '2027-01-12T08:00:00+08:00' '2027-01-12T18:00:00+08:00')"
expect_eq "$CODE" "201" "Admin (Chief Tanod) account can be assigned a shift"
S1=$(bj shift_id)
expect_eq "$(bj approval_status)" "draft" "  new admin shift is a draft"
expect_eq "$(db_one "SELECT user_id FROM shift_schedule WHERE shift_id=$S1;")" "$CHIEF" "  stored against the admin's user_id"
req POST /shifts "$SECT" "$(shift_body $CHIEF2 '2027-01-12T08:00:00+08:00' '2027-01-12T12:00:00+08:00')"
expect_eq "$CODE" "201" "Secretary may roster an admin too (shift writers unchanged)"
req POST /shifts "$ADM" "$(shift_body $TAN1 '2027-01-12T08:00:00+08:00' '2027-01-12T16:00:00+08:00')"
expect_eq "$CODE" "201" "Tanod rostering unchanged"
S_TAN=$(bj shift_id)
req POST /shifts "$ADM" "$(shift_body $SEC '2027-01-13T08:00:00+08:00' '2027-01-13T16:00:00+08:00')"
expect_eq "$CODE" "422" "Secretary account is still not rosterable"
req POST /shifts "$ADM" "$(shift_body $PBID '2027-01-13T08:00:00+08:00' '2027-01-13T16:00:00+08:00')"
expect_eq "$CODE" "422" "Punong Barangay account is still not rosterable"
req POST /shifts "$ADM" "$(shift_body $CHIEF_OFF '2027-01-13T08:00:00+08:00' '2027-01-13T16:00:00+08:00')"
expect_eq "$CODE" "422" "Inactive admin is refused"
req POST /shifts "$ADM" "$(shift_body $CHIEF_B2 '2027-01-13T08:00:00+08:00' '2027-01-13T16:00:00+08:00')"
expect_eq "$CODE" "422" "Admin of ANOTHER barangay is refused (not eligible in this tenant)"
req POST /shifts "$ADM" "$(shift_body 999999 '2027-01-13T08:00:00+08:00' '2027-01-13T16:00:00+08:00')"
expect_eq "$CODE" "422" "Unknown user id is refused"
req POST /shifts "$PBT" "$(shift_body $CHIEF '2027-01-13T08:00:00+08:00' '2027-01-13T16:00:00+08:00')"
expect_eq "$CODE" "403" "Punong Barangay still cannot write shifts"

step "4. Existing shift rules apply to the admin unchanged"
req POST /shifts "$ADM" "$(shift_body $CHIEF '2027-01-12T09:00:00+08:00' '2027-01-12T10:00:00+08:00')"
expect_eq "$CODE" "409" "Overlap with the admin's own shift -> 409"
req POST /shifts "$ADM" "$(shift_body $CHIEF '2027-01-12T19:00:00+08:00' '2027-01-12T23:00:00+08:00')"
expect_eq "$CODE" "422" "10 h + 4 h on one Manila day -> 422 (12 h cap counts across the admin's shifts)"
expect_eq "$(err_code)" "DAILY_HOURS_EXCEEDED" "  error code"
req POST /shifts "$ADM" "$(shift_body $CHIEF '2027-01-12T19:00:00+08:00' '2027-01-12T21:00:00+08:00')"
expect_eq "$CODE" "201" "10 h + 2 h = exactly 12 h is allowed"
S2=$(bj shift_id)
req POST /shifts "$ADM" "$(shift_body $CHIEF '2027-01-12T22:00:00+08:00' '2027-01-12T22:30:00+08:00')"
expect_eq "$CODE" "422" "Any further minute that Manila day is over the cap"
req POST /shifts "$ADM" "$(shift_body $CHIEF '2027-01-12T23:00:00+08:00' '2027-01-13T03:00:00+08:00')"
expect_eq "$CODE" "422" "Cross-midnight shift is split at the Manila boundary; the full day still counts"
req POST /shifts "$ADM" "$(shift_body $CHIEF '2027-01-13T06:00:00+08:00' '2027-01-13T14:00:00+08:00')"
expect_eq "$CODE" "201" "The next Manila day has its own 12 h budget"
S3=$(bj shift_id)
VER=$(db_one "SELECT version FROM shift_schedule WHERE shift_id=$S2;")
req PATCH "/shifts/$S2" "$ADM" "{\"version\":$VER,\"end_at\":\"2027-01-12T22:00:00+08:00\"}"
expect_eq "$CODE" "422" "PATCH extending the admin's shift past 12 h -> 422"
req PATCH "/shifts/$S2" "$ADM" "{\"version\":$VER,\"end_at\":\"2027-01-12T20:00:00+08:00\"}"
expect_eq "$CODE" "200" "PATCH within the cap is fine"
VERT=$(db_one "SELECT version FROM shift_schedule WHERE shift_id=$S_TAN;")
req PATCH "/shifts/$S_TAN" "$ADM" "{\"version\":$VERT,\"user_id\":$CHIEF}"
expect_eq "$CODE" "409" "PATCH reassigning a tanod shift onto the admin's overlapping time -> 409"
req PATCH "/shifts/$S_TAN" "$ADM" "{\"version\":$VERT,\"user_id\":$CHIEF_B2}"
expect_eq "$CODE" "422" "PATCH to another barangay's admin -> 422"
req PATCH "/shifts/$S_TAN" "$ADM" "{\"version\":$VERT,\"user_id\":$SEC}"
expect_eq "$CODE" "422" "PATCH to a secretary -> 422"

step "5. Draft/published, re-draft on edit, NO_COVERAGE"
req GET "/shifts?approval_status=draft&limit=100" "$ADM"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count(array_filter($d["items"],fn($i)=>(int)$i["user_id"]===(int)$argv[1]));' "$CHIEF")" "3" "Admin's 3 shifts are listed as drafts"
req POST /shifts/publish "$PBT" "{\"shift_ids\":[$S1,$S2,$S3]}" -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "200" "approve_roster holder (PB) publishes the admin's shifts"
expect_eq "$(db_one "SELECT approval_status FROM shift_schedule WHERE shift_id=$S1;")" "published" "  admin shift is published"
req POST /shifts "$ADM" "$(shift_body $CHIEF '2027-01-15T08:00:00+08:00' '2027-01-15T10:00:00+08:00')"
S4=$(bj shift_id)
req POST /shifts "$ADM" "$(shift_body $CHIEF '2027-01-17T08:00:00+08:00' '2027-01-17T10:00:00+08:00')"
S5=$(bj shift_id)
VER5=$(db_one "SELECT version FROM shift_schedule WHERE shift_id=$S5;")
req PATCH "/shifts/$S5" "$ADM" "{\"version\":$VER5,\"user_id\":null}"
expect_eq "$CODE" "200" "Unassigning an admin shift is allowed"
req POST /shifts/publish "$PBT" "{\"shift_ids\":[$S4,$S5]}" -H "Idempotency-Key: $(uuid)"
expect_eq "$(bj warnings)" "[{\"code\":\"NO_COVERAGE\",\"date\":\"2027-01-16\"},{\"code\":\"NO_COVERAGE\",\"date\":\"2027-01-17\"}]" "NO_COVERAGE for the uncovered 16th and the unassigned 17th, not the 15th the admin covers"
VER1=$(db_one "SELECT version FROM shift_schedule WHERE shift_id=$S1;")
req PATCH "/shifts/$S1" "$ADM" "{\"version\":$VER1,\"end_at\":\"2027-01-12T17:00:00+08:00\"}"
expect_eq "$CODE" "200" "Editing a published admin shift's time"
expect_eq "$(db_one "SELECT approval_status FROM shift_schedule WHERE shift_id=$S1;")" "draft" "  reverts to draft (needs a fresh publish)"

step "6. Swaps stay tanod-to-tanod; admin is not dispatchable / offerable"
TAN1T=$(login_tok tan1)
req POST /shift-swap-requests "$TAN1T" "{\"shift_id\":$S_TAN,\"target_user_id\":$CHIEF,\"request_id\":\"$(uuid)\"}"
expect_in "$CODE" "400 404 422" "Swap request targeting an admin is not accepted"
mysql_exec "$VALDB" -e "INSERT INTO incident (barangay_id, reported_by, incident_type, priority, status, location_description, created_at) VALUES (1, $TAN1, 'theft', 'normal', 'pending', 'seed', UTC_TIMESTAMP());"
INC=$(db_one "SELECT MAX(incident_id) FROM incident;")
req POST /dispatch "$ADM" "{\"incident_id\":$INC,\"tanod_id\":$CHIEF,\"request_id\":\"$(uuid)\",\"override_reason\":\"test\"}"
expect_in "$CODE" "400 404 422" "POST /dispatch to the admin account is refused (admins are not dispatchable)"
mysql_exec "$VALDB" -e "INSERT INTO duty_status (user_id, status, channel, changed_at) VALUES ($CHIEF, 'on_duty', 'app', UTC_TIMESTAMP());"
cat > "$BACKEND_DIR/scripts/.ctr-unit.php" <<'PHP'
<?php
declare(strict_types=1);
$backend = dirname(__DIR__);
require $backend . '/config/env.php';
baranguard_load_env();
require $backend . '/config/autoload.php';
require $backend . '/config/db.php';
use Baranguard\Services\Dispatch\OfferService;
use Baranguard\Lib\ApprovalAuthority;
$pdo = baranguard_db_fresh();
// The admin is on_duty with a PUBLISHED shift covering this instant (S3, 2027-01-13 06:00-14:00 +08:00): must still not qualify.
$q = OfferService::qualifyingTanods($pdo, 1, new DateTimeImmutable('2027-01-13T00:00:00Z'));
echo 'Q=' . implode(',', $q) . "\n";
try { ApprovalAuthority::assertNotPreparer((int) $argv[1], (int) $argv[1]); echo "PREP=NO_THROW\n"; }
catch (\Throwable $e) { echo 'PREP=THROWN' . "\n"; }
PHP
UNIT=$(DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB" APP_ENV=test "$PHP_BIN" "$BACKEND_DIR/scripts/.ctr-unit.php" "$CHIEF" 2>&1)
expect_eq "$(printf '%s' "$UNIT" | grep '^Q=')" "Q=" "An on_duty admin with a published shift is NOT an offer recipient (offers stay tanod-only)"

step "7. Segregation of duties + accomplishment gap"
expect_eq "$(printf '%s' "$UNIT" | grep '^PREP=')" "PREP=THROWN" "assertNotPreparer(X, X) throws (a preparer can never note/approve their own report)"
req PATCH "/users/$CHIEF" "$ADM" '{"approval_authority":["note_report","approve_report","approve_roster","prepare_annex_d"]}' -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "403" "Admin cannot grant THEMSELVES a new approve_* authority"
req PATCH "/users/$CHIEF" "$ADM" '{"approval_authority":["note_report","prepare_annex_d"]}' -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "403" "Admin cannot REVOKE their own approve_report either"
req PATCH "/users/$CHIEF" "$ADM" '{"approval_authority":["note_report","approve_report"]}' -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "200" "Admin may still change their own non-approving authorities"
req PATCH "/users/$CHIEF" "$ADM2" '{"approval_authority":["note_report","approve_report","approve_roster"]}' -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "200" "ANOTHER admin can change the Chief's approving authorities"
# Known gap: admin has no way to prepare an accomplishment report.
DEVX="and-$(uuid)"
req POST /accomplishment-entries "$ADM" "{\"work_date\":\"2027-01-12\",\"accomplishment_text\":\"x\",\"confirmed_duration_minutes\":60,\"client_event_id\":\"$(uuid)\"}" -H "X-Device-Id: $DEVX"
expect_eq "$CODE" "403" "KNOWN GAP: an admin cannot create accomplishment entries (tanod-only), so cannot be a preparer today"

echo
echo "Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL CHECKS PASSED" || exit 1
