#!/usr/bin/env bash
# Baranguard — F8 validation: `avg_response_time_minutes` no longer
# double-counts an incident with more than one arrived dispatch
# (docs/REMAINING.md F8, docs/AUDIT_2026-09-07.md).
#
# Before this fix, `GET /reports/summary`'s AVG(...) joined `incident` to
# EVERY arrived `dispatch` row with no de-dup, so an incident dispatched
# twice (both reaching `arrived`) was averaged in twice, weighting it
# double against §6's "per incident" definition. This exercises the fix
# through the real HTTP endpoint (verify-w2-reports.sh already covers the
# single-dispatch-per-incident shape and passes unchanged; this script
# adds the one seed scenario that actually exercises the bug: TWO arrived
# dispatches on the SAME incident).
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-f8-response-time-dedup.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_f8_check"
APP_USER="f8chk_app"
APP_PASSWORD="F8Chk!2026xx"
API_PORT="8129"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="F8#2026Pw"

echo "Baranguard F8 (avg_response_time_minutes de-dup) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }
echo "Using mysql: $MYSQL_BIN"
echo "Using php:   $PHP_BIN ($($PHP_BIN -r 'echo PHP_VERSION;'))"

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.f8chk-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER'."
  echo "Your real 'baranguard' database and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (FULL migration chain) + accounts"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in 0001_baseline_schema 0002_seed_barangays 0003_shift_schedule_nullable_user 0004_blotter_revision \
         0005_sms_envelope_replay 0006_sms_log_barangay 0007_retention_columns 0008_incident_party_fields \
         0009_blotter_case_status 0010_incident_location_description 0011_user_suspension 0012_system_settings \
         0013_sms_manual_send 0014_incident_display_id 0015_ai_tools \
         0016_retention_hold_and_device_scrub \
         0017_health_check_log \
         0018_sms_subscriber; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Migrations 0001-0018 applied"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'f8_admin', '$HASH', 'F8 Admin', 'admin', 1, UTC_TIMESTAMP()),
  (1, 'f8_tanod1', '$HASH', 'F8 Tanod One', 'tanod', 1, UTC_TIMESTAMP()),
  (1, 'f8_tanod2', '$HASH', 'F8 Tanod Two', 'tanod', 1, UTC_TIMESTAMP());
SQL
pass "Seeded admin + two tanods (barangay 1)"

step "2. Seed the bug scenario: ONE incident, TWO dispatches that BOTH reached arrived"
# incident.created_at fixed at a known instant; two dispatches arrive at
# +10 minutes and +40 minutes. A correct per-incident metric (first
# arrival) = 10. The pre-fix bug averaged 10 and 40 together = 25.
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
  (1, 'fire', 'critical', 'RAW-F8-CHECK', 'dispatched', 'web', '2026-06-01 08:00:00', '2026-06-01 08:00:00');
SQL
INC1=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE incident_type='fire' LIMIT 1;")
ADMIN_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='f8_admin';")
TANOD1=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='f8_tanod1';")
TANOD2=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='f8_tanod2';")
mysql_exec "$VALDB" <<SQL
INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, status, dispatched_at, arrived_at, created_client_request_id) VALUES
  ($INC1, $ADMIN_ID, $TANOD1, 'critical', 'arrived', '2026-06-01 08:01:00', '2026-06-01 08:10:00', '44444444-4444-4444-8444-444444444441'),
  ($INC1, $ADMIN_ID, $TANOD2, 'critical', 'arrived', '2026-06-01 08:05:00', '2026-06-01 08:40:00', '44444444-4444-4444-8444-444444444442');
SQL
pass "Incident #$INC1 has TWO arrived dispatches: +10min and +40min"

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.f8chk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as f8_admin)
if [ -n "$ADMIN_TOKEN" ]; then
  pass "Logged in as admin (env override reached the disposable DB)"
else
  fail "Login failed — the API is probably talking to the REAL database (see this script's header)"
  exit 1
fi

jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "NULL";'; }

step "4. GET /reports/summary must report 10.0, not 25.0 (the pre-fix double-counted average)"
RESP=$(curl -s "${BASE_URL}/reports/summary?date_from=2026-06-01&date_to=2026-06-01" -H "Authorization: Bearer $ADMIN_TOKEN")
AVG=$(echo "$RESP" | jget avg_response_time_minutes)
expect_eq "$AVG" "10" "avg_response_time_minutes = 10 (first arrival only), NOT 25 (the two-dispatch average the bug produced)"

step "5. GET /reports/export?format=pdf still works after the query rewrite (it is the ONLY caller of averageResponseTimeMinutes() — §6's PDF report shows it, CSV does not)"
EXPORT_RESP=$(curl -s -o /dev/null -w '%{http_code}' -X GET "${BASE_URL}/reports/export?format=pdf&date_from=2026-06-01&date_to=2026-06-01" -H "Authorization: Bearer $ADMIN_TOKEN")
expect_eq "$EXPORT_RESP" "201" "PDF export generates successfully (no regression in the rewritten averageResponseTimeMinutes() query)"
DOWNLOAD_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/reports/export/download?format=pdf" -H "Authorization: Bearer $ADMIN_TOKEN")
expect_eq "$DOWNLOAD_CODE" "200" "PDF export downloads successfully"

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
