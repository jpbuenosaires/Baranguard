#!/usr/bin/env bash
# Baranguard — W2 Admin Dashboard / GET /reports/summary validation
# against a REAL local XAMPP MariaDB + PHP (not a cloud sandbox). Safe to
# run: everything happens in a disposable database
# (baranguard_w2_check) with a disposable app-user, disposable test
# accounts, and a PHP dev server on a throwaway local port. Your real
# `baranguard` database, real backend/.env, and Apache are never touched.
# Mirrors backend/scripts/verify-sprint1-auth.sh's structure/conventions.
#
# Usage (from a Git Bash prompt, repo root or anywhere):
#   bash backend/scripts/verify-w2-reports.sh
#
# Override connection defaults if your XAMPP root account has a password:
#   XAMPP_MYSQL_PASSWORD=yourpass bash backend/scripts/verify-w2-reports.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
LOG_FILE="$BACKEND_DIR/scripts/w2-reports-validation-$(date -u +%Y%m%dT%H%M%SZ).log"

exec > >(tee "$LOG_FILE") 2>&1

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_w2_check"
APP_USER="w2_check_app"
APP_PASSWORD="W2CheckDbPw!2026"
API_PORT="8093"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="W2Check#2026Pw"

echo "Baranguard W2 (GET /reports/summary) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for candidate in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"
PHP_BIN="$(find_bin php)"

if [ -z "$MYSQL_BIN" ]; then
  echo "ERROR: mysql client not found on PATH or at C:\\xampp\\mysql\\bin." >&2
  exit 1
fi
if [ -z "$PHP_BIN" ]; then
  echo "ERROR: php not found on PATH or at C:\\xampp\\php. Add C:\\xampp\\php to PATH." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl not found. Git Bash / modern Windows normally ships one." >&2
  exit 1
fi
echo "Using mysql: $MYSQL_BIN"
echo "Using php:   $PHP_BIN ($($PHP_BIN -r 'echo PHP_VERSION;'))"

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  # Belt-and-braces: `(cd dir && php -S ...) &` backgrounds the subshell,
  # not always the php process itself, so $! can outlive `kill "$SERVER_PID"`
  # as an orphan holding the port. Sweep by port too.
  pkill -f "php -S 127.0.0.1:${API_PORT}" 2>/dev/null
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  echo "Stopped the test PHP server, dropped $VALDB and user '$APP_USER'."
  echo "Your real 'baranguard' database and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity check"
if mysql_exec -e "SELECT VERSION();"; then
  pass "Connected to MariaDB at $XAMPP_MYSQL_HOST:$XAMPP_MYSQL_PORT"
else
  fail "Could not connect — is XAMPP's MySQL service running?"
  exit 1
fi

step "1. Set up disposable schema"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "Schema applied" || fail "Schema apply failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" && pass "Barangays seeded" || fail "Seed failed"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

step "2. Seed test accounts + duty status (barangay 1) + a second-barangay admin"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'w2check_admin',     '$HASH', 'W2 Check Admin',     'admin',            1, UTC_TIMESTAMP()),
  (1, 'w2check_pb',        '$HASH', 'W2 Check PB',        'punong_barangay',  1, UTC_TIMESTAMP()),
  (1, 'w2check_secretary', '$HASH', 'W2 Check Secretary', 'secretary',        1, UTC_TIMESTAMP()),
  (1, 'w2check_tanod1',    '$HASH', 'W2 Check Tanod One', 'tanod',            1, UTC_TIMESTAMP()),
  (1, 'w2check_tanod2',    '$HASH', 'W2 Check Tanod Two', 'tanod',            1, UTC_TIMESTAMP()),
  (1, 'w2check_tanod3',    '$HASH', 'W2 Check Tanod Three','tanod',           1, UTC_TIMESTAMP()),
  (2, 'w2check_admin_b2',  '$HASH', 'W2 Check Admin B2',  'admin',            1, UTC_TIMESTAMP());

-- tanod1: off_duty then on_duty (latest wins) ; tanod2: responding ; tanod3: off_duty
INSERT INTO duty_status (user_id, status, channel, changed_at) VALUES
  (4, 'off_duty',   'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR)),
  (4, 'on_duty',    'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)),
  (5, 'responding', 'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)),
  (6, 'off_duty',   'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR));

-- 8 incidents in barangay 1 spread over the last 9 days; 1 incident in barangay 2.
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
  (1, 1, 'theft',             'normal', 'sandbox test narrative', 'resolved',   'web', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY)),
  (1, 1, 'theft',             'normal', 'sandbox test narrative', 'resolved',   'web', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)),
  (1, 1, 'disturbance',       'normal', 'sandbox test narrative', 'dispatched', 'web', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY)),
  (1, 1, 'fire',              'normal', 'sandbox test narrative', 'resolved',   'web', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY)),
  (1, 1, 'vandalism',         'normal', 'sandbox test narrative', 'pending',    'web', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)),
  (1, 1, 'traffic_incident',  'normal', 'sandbox test narrative', 'pending',    'web', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)),
  (1, 1, 'medical_emergency', 'normal', 'sandbox test narrative', 'resolved',   'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, 1, 'other',             'normal', 'sandbox test narrative', 'pending',    'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (2, 7, 'fire',              'normal', 'sandbox test narrative', 'pending',    'web', UTC_TIMESTAMP(), UTC_TIMESTAMP());

-- Dispatches (reach arrived) for incidents 1,2,4,7 — response times 12,8,20,5 min -> avg 11.25 -> rounds to 11.3.
INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, status, dispatched_at, en_route_at, arrived_at, completed_at, created_client_request_id) VALUES
  (1, 1, 4, 'normal', 'completed', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY) + INTERVAL 1 MINUTE, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY) + INTERVAL 2 MINUTE, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY) + INTERVAL 12 MINUTE, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 DAY) + INTERVAL 30 MINUTE, '11111111-1111-4111-8111-111111111111'),
  (2, 1, 4, 'normal', 'completed', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) + INTERVAL 1 MINUTE, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) + INTERVAL 2 MINUTE, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) + INTERVAL 8 MINUTE,  DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) + INTERVAL 30 MINUTE, '22222222-2222-4222-8222-222222222222'),
  (4, 1, 4, 'normal', 'completed', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY) + INTERVAL 1 MINUTE, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY) + INTERVAL 2 MINUTE, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY) + INTERVAL 20 MINUTE, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY) + INTERVAL 40 MINUTE, '33333333-3333-4333-8333-333333333333'),
  (7, 1, 4, 'normal', 'completed', UTC_TIMESTAMP() + INTERVAL 1 MINUTE, UTC_TIMESTAMP() + INTERVAL 2 MINUTE, UTC_TIMESTAMP() + INTERVAL 5 MINUTE, UTC_TIMESTAMP() + INTERVAL 20 MINUTE, '44444444-4444-4444-8444-444444444444');
SQL
[ $? -eq 0 ] && pass "Seeded 7 users, 4 duty_status events, 9 incidents (8 in barangay 1, 1 in barangay 2), 4 dispatches" || fail "Seed SQL failed"

step "3. Start the API (PHP built-in server on a throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN='*'
(cd "$BACKEND_DIR/public" && "$PHP_BIN" -S "127.0.0.1:${API_PORT}" >"$BACKEND_DIR/scripts/.w2-server.log" 2>&1) &
SERVER_PID=$!
sleep 1
if curl -s -o /dev/null "${BASE_URL}/auth/login" -X POST -d '{}'; then
  pass "PHP dev server responding on port $API_PORT"
else
  fail "PHP dev server did not start — see backend/scripts/.w2-server.log"
  exit 1
fi

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as w2check_admin)
PB_TOKEN=$(login_as w2check_pb)
SEC_TOKEN=$(login_as w2check_secretary)
TANOD_TOKEN=$(login_as w2check_tanod1)
ADMIN_B2_TOKEN=$(login_as w2check_admin_b2)
[ -n "$ADMIN_TOKEN" ] && pass "Logged in as admin, PB, secretary, tanod, and barangay-2 admin" || fail "Admin login failed to return a token"

step "4. Unauthenticated + role enforcement"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/reports/summary")
[ "$CODE" = "401" ] && pass "No Authorization header -> 401" || fail "No Authorization header -> $CODE (expected 401)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $SEC_TOKEN" "${BASE_URL}/reports/summary")
[ "$CODE" = "403" ] && pass "Secretary role -> 403 FORBIDDEN" || fail "Secretary role -> $CODE (expected 403)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TANOD_TOKEN" "${BASE_URL}/reports/summary")
[ "$CODE" = "403" ] && pass "Tanod role -> 403 FORBIDDEN" || fail "Tanod role -> $CODE (expected 403)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PB_TOKEN" "${BASE_URL}/reports/summary")
[ "$CODE" = "200" ] && pass "Punong Barangay (read-only role) -> 200" || fail "Punong Barangay -> $CODE (expected 200)"

step "5. Response shape + computed values (default range covers all 8 seeded incidents)"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/reports/summary")
extract() { echo "$RESP" | "$PHP_BIN" -r "\$d=json_decode(file_get_contents('php://stdin'),true); echo \$d['$1'] ?? 'MISSING';"; }

for key in total_incidents resolved_count avg_response_time_minutes active_tanods by_incident_type by_status trend; do
  echo "$RESP" | "$PHP_BIN" -r "\$d=json_decode(file_get_contents('php://stdin'),true); exit(array_key_exists('$key', \$d) ? 0 : 1);" \
    && pass "Response includes '$key'" || fail "Response missing '$key'"
done

[ "$(extract total_incidents)" = "8" ] && pass "total_incidents = 8" || fail "total_incidents = $(extract total_incidents) (expected 8)"
[ "$(extract resolved_count)" = "4" ] && pass "resolved_count = 4" || fail "resolved_count = $(extract resolved_count) (expected 4)"
[ "$(extract avg_response_time_minutes)" = "11.3" ] && pass "avg_response_time_minutes = 11.3 ((12+8+20+5)/4=11.25, rounds to 11.3)" || fail "avg_response_time_minutes = $(extract avg_response_time_minutes) (expected 11.3)"
[ "$(extract active_tanods)" = "2" ] && pass "active_tanods = 2 (tanod1 on_duty, tanod2 responding; tanod3 off_duty excluded)" || fail "active_tanods = $(extract active_tanods) (expected 2)"

TREND_SUM=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo array_sum(array_column($d["trend"], "count"));')
[ "$TREND_SUM" = "8" ] && pass "sum(trend[].count) = 8 (matches total_incidents — no incident lost/double-counted in bucketing)" || fail "sum(trend[].count) = $TREND_SUM (expected 8)"

BYSTATUS_SUM=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo array_sum($d["by_status"]);')
[ "$BYSTATUS_SUM" = "8" ] && pass "sum(by_status values) = 8" || fail "sum(by_status values) = $BYSTATUS_SUM (expected 8)"

BYTYPE_KEYCOUNT=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["by_incident_type"]);')
[ "$BYTYPE_KEYCOUNT" = "11" ] && pass "by_incident_type has all 11 §5 enum members present (zero-filled, none omitted)" || fail "by_incident_type has $BYTYPE_KEYCOUNT keys (expected 11)"

step "6. Tenant isolation"
B2_TOTAL=$(curl -s -H "Authorization: Bearer $ADMIN_B2_TOKEN" "${BASE_URL}/reports/summary" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["total_incidents"];')
[ "$B2_TOTAL" = "1" ] && pass "Barangay-2 admin sees only their own 1 incident" || fail "Barangay-2 admin total_incidents = $B2_TOTAL (expected 1)"

B1_TOTAL_AFTER=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/reports/summary" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["total_incidents"];')
[ "$B1_TOTAL_AFTER" = "8" ] && pass "Barangay-1 admin still sees exactly 8 (no cross-tenant leakage)" || fail "Barangay-1 admin total_incidents = $B1_TOTAL_AFTER (expected 8, tenant isolation may be broken)"

step "7. date_from / date_to validation"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/reports/summary?date_from=not-a-date")
[ "$CODE" = "400" ] && pass "Malformed date_from -> 400 VALIDATION_ERROR" || fail "Malformed date_from -> $CODE (expected 400)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/reports/summary?date_from=2026-09-05&date_to=2026-09-01")
[ "$CODE" = "400" ] && pass "date_from after date_to -> 400 VALIDATION_ERROR" || fail "date_from after date_to -> $CODE (expected 400)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/reports/summary?date_from=2020-01-01&date_to=2026-01-01")
[ "$CODE" = "400" ] && pass "Range exceeding 366 days -> 400 VALIDATION_ERROR" || fail "Oversized range -> $CODE (expected 400)"

# Use PHP's Asia/Manila "today" (matching exactly how ReportsController
# buckets days), not the shell's `date -u` — the two are only the same
# calendar date outside a ~16:00-23:59 UTC window, and this script has
# already been bitten once by that gap during its own development.
MANILA_TODAY=$("$PHP_BIN" -r 'echo (new DateTimeImmutable("now", new DateTimeZone("Asia/Manila")))->format("Y-m-d");')
NARROW=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/reports/summary?date_from=${MANILA_TODAY}&date_to=${MANILA_TODAY}" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["total_incidents"];')
[ "$NARROW" = "2" ] && pass "Narrow range (today only, Asia/Manila) = 2 incidents (the two seeded with UTC_TIMESTAMP())" || fail "Narrow range (today only, Asia/Manila) = $NARROW (expected 2)"

step "SUMMARY"
echo "$PASS passed, $FAIL failed."
echo "Full log: $LOG_FILE"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
