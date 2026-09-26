#!/usr/bin/env bash
# Baranguard — H-16/M-03 validation: `PATCH /incidents/:id/lifecycle`
# (2026-09-24 external audit, docs/REMAINING.md §H; migration 0025).
#
# Before this fix, `incident.status` had no way to record a duplicate
# report, an invalid one, a cancellation, or a case reopened after being
# closed — the only human-driven transition was `updateStatus()`'s
# Admin-only "resolved". This script proves the new Secretary-only
# `updateLifecycle()` endpoint: role gating, the transition table
# (forward-only within each branch), the "duplicate" merge-as-link
# (not-delete) behaviour, the open-dispatch guard, tenant isolation, and
# Idempotency-Key replay.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-h16-incident-lifecycle.sh

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
# Port default: prefer backend/.env's DB_PORT over the stock-XAMPP
# 3306 guess -- this machine's own XAMPP MariaDB runs on a non-default
# port (an unrelated MySQL80 service owns 3306 here; see
# docs/REFERENCE.md Sec 8), and .env is the one place that's recorded.
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_h16_check"
APP_USER="h16chk_app"
APP_PASSWORD="H16Chk!2026xx"
API_PORT="8131"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="H16#2026Pw"

echo "Baranguard H-16/M-03 (incident lifecycle) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  # Explicit XAMPP path checked FIRST, not `command -v`: this machine
  # (and possibly others) has an unrelated same-named binary earlier on
  # PATH -- a separate MySQL Server install whose client can silently
  # fail against XAMPP's own MariaDB (see docs/REFERENCE.md Sec 8) --
  # that `command -v` would otherwise prefer over the XAMPP install
  # these scripts are meant for. PATH is now only a fallback.
  for candidate in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
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
  rm -f "$BACKEND_DIR/scripts/.h16chk-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER'."
  echo "Your real 'baranguard' database and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (full migration chain incl. 0025) + accounts"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in 0001_baseline_schema 0002_seed_barangays 0003_shift_schedule_nullable_user 0004_blotter_revision \
         0005_sms_envelope_replay 0006_sms_log_barangay 0007_retention_columns 0008_incident_party_fields \
         0009_blotter_case_status 0010_incident_location_description 0011_user_suspension 0012_system_settings \
         0013_sms_manual_send 0014_incident_display_id 0015_ai_tools \
         0016_retention_hold_and_device_scrub \
         0017_health_check_log \
         0018_sms_subscriber \
         0019_audit_log_idempotency_index 0020_health_check_log_ors 0021_ai_evaluation_run_generic_metrics 0022_auth_session_kind 0023_rate_limit_counter 0024_mobile_device_public_key 0025_incident_lifecycle_states 0026_sos_no_fix_fallback; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain 0001-0025 applied"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'h16_admin',     '$HASH', 'H16 Admin',       'admin',     1, UTC_TIMESTAMP()),
  (1, 'h16_secretary', '$HASH', 'H16 Secretary',   'secretary', 1, UTC_TIMESTAMP()),
  (2, 'h16_sec_b2',    '$HASH', 'H16 Secretary B2','secretary', 1, UTC_TIMESTAMP()),
  (1, 'h16_tanod',     '$HASH', 'H16 Tanod',       'tanod',     1, UTC_TIMESTAMP());
SQL
pass "Seeded admin/secretary (barangay 1), secretary (barangay 2), tanod"

step "2. Seed incidents"
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
  (1, 'theft', 'normal', 'RAW-H16-A', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, 'theft', 'normal', 'RAW-H16-B (the original report)', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, 'disturbance', 'normal', 'RAW-H16-C (will get an active dispatch)', 'dispatched', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (2, 'theft', 'normal', 'RAW-H16-D (barangay 2)', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
INC_A=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE raw_narrative='RAW-H16-A';")
INC_B=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE raw_narrative LIKE 'RAW-H16-B%';")
INC_C=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE raw_narrative LIKE 'RAW-H16-C%';")
INC_D=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE raw_narrative LIKE 'RAW-H16-D%';")
echo "  incidents: A=$INC_A B=$INC_B C=$INC_C D(barangay2)=$INC_D"

ADMIN_USER_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='h16_admin';")
TANOD_USER_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='h16_tanod';")
mysql_exec "$VALDB" -e "INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, status, dispatched_at, created_client_request_id) VALUES ($INC_C, $ADMIN_USER_ID, $TANOD_USER_ID, 'normal', 'assigned', UTC_TIMESTAMP(), '99999999-9999-4999-8999-999999999999');"

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.h16chk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as h16_admin)
SEC_TOKEN=$(login_as h16_secretary)
SEC_B2_TOKEN=$(login_as h16_sec_b2)
if [ -n "$SEC_TOKEN" ]; then
  pass "Logged in as admin/secretary/secretary-b2 (env override reached the disposable DB)"
else
  fail "Login failed — the API is probably talking to the REAL database (see this script's header)"
  exit 1
fi

status_of() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -H "Idempotency-Key: ${4:-}" -d "${5:-}"; }
body_of()   { curl -s -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -H "Idempotency-Key: ${4:-}" -d "${5:-}"; }
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "";'; }
db_status_of() { mysql_exec -N -s "$VALDB" -e "SELECT status FROM incident WHERE incident_id=$1;"; }

step "4. Role gating — Admin and Tanod are both refused"
K_ROLE_A="10000000-0000-4000-8000-000000000001"
K_ROLE_T="10000000-0000-4000-8000-000000000002"
expect_eq "$(status_of PATCH "/incidents/${INC_A}/lifecycle" "$ADMIN_TOKEN" "$K_ROLE_A" '{"status":"invalid"}')" "403" "Admin -> 403 (Secretary only)"
TANOD_TOKEN=$(login_as h16_tanod)
expect_eq "$(status_of PATCH "/incidents/${INC_A}/lifecycle" "$TANOD_TOKEN" "$K_ROLE_T" '{"status":"invalid"}')" "403" "Tanod -> 403 (Secretary only)"

step "5. Idempotency-Key required"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "${BASE_URL}/incidents/${INC_A}/lifecycle" -H "Authorization: Bearer $SEC_TOKEN" -H "Content-Type: application/json" -d '{"status":"invalid"}')" "400" "Missing Idempotency-Key -> 400"

step "6. Illegal target status is rejected"
K6="20000000-0000-4000-8000-000000000001"
expect_eq "$(status_of PATCH "/incidents/${INC_A}/lifecycle" "$SEC_TOKEN" "$K6" '{"status":"resolved"}')" "400" "status=resolved (not a lifecycle-endpoint value) -> 400"

step "7. pending -> invalid (legal transition)"
K7="30000000-0000-4000-8000-000000000001"
RESP7=$(body_of PATCH "/incidents/${INC_A}/lifecycle" "$SEC_TOKEN" "$K7" '{"status":"invalid"}')
expect_eq "$(echo "$RESP7" | jget status)" "invalid" "Response reports status=invalid"
expect_eq "$(db_status_of "$INC_A")" "invalid" "DB status actually changed to invalid"

step "8. invalid -> invalid again is illegal (must reopen first) -> 409"
K8="30000000-0000-4000-8000-000000000002"
expect_eq "$(status_of PATCH "/incidents/${INC_A}/lifecycle" "$SEC_TOKEN" "$K8" '{"status":"invalid"}')" "409" "Repeating the same terminal transition -> 409"

step "9. invalid -> reopened -> cancelled (both legal)"
K9A="30000000-0000-4000-8000-000000000003"
expect_eq "$(body_of PATCH "/incidents/${INC_A}/lifecycle" "$SEC_TOKEN" "$K9A" '{"status":"reopened"}' | jget status)" "reopened" "invalid -> reopened"
expect_eq "$(db_status_of "$INC_A")" "reopened" "DB status = reopened"
K9B="30000000-0000-4000-8000-000000000004"
expect_eq "$(body_of PATCH "/incidents/${INC_A}/lifecycle" "$SEC_TOKEN" "$K9B" '{"status":"cancelled"}' | jget status)" "cancelled" "reopened -> cancelled"
expect_eq "$(db_status_of "$INC_A")" "cancelled" "DB status = cancelled"

step "10. duplicate requires duplicate_of_incident_id, merge = link not delete"
K10A="40000000-0000-4000-8000-000000000001"
expect_eq "$(status_of PATCH "/incidents/${INC_B}/lifecycle" "$SEC_TOKEN" "$K10A" '{"status":"duplicate"}')" "400" "duplicate with no target -> 400"
K10B="40000000-0000-4000-8000-000000000002"
expect_eq "$(status_of PATCH "/incidents/${INC_B}/lifecycle" "$SEC_TOKEN" "$K10B" "{\"status\":\"duplicate\",\"duplicate_of_incident_id\":${INC_B}}")" "400" "duplicate of self -> 400"
K10C="40000000-0000-4000-8000-000000000003"
expect_eq "$(status_of PATCH "/incidents/${INC_B}/lifecycle" "$SEC_TOKEN" "$K10C" "{\"status\":\"duplicate\",\"duplicate_of_incident_id\":99999}")" "400" "duplicate_of_incident_id pointing at a nonexistent incident -> 400"

K10D="40000000-0000-4000-8000-000000000004"
RESP10D=$(body_of PATCH "/incidents/${INC_B}/lifecycle" "$SEC_TOKEN" "$K10D" "{\"status\":\"duplicate\",\"duplicate_of_incident_id\":${INC_A}}")
expect_eq "$(echo "$RESP10D" | jget status)" "duplicate" "INC_B marked duplicate of INC_A"
expect_eq "$(echo "$RESP10D" | jget duplicate_of_incident_id)" "$INC_A" "Response echoes duplicate_of_incident_id"
DB_DUP=$(mysql_exec -N -s "$VALDB" -e "SELECT duplicate_of_incident_id FROM incident WHERE incident_id=$INC_B;")
expect_eq "$DB_DUP" "$INC_A" "DB duplicate_of_incident_id points at INC_A"
INC_A_STATUS_UNCHANGED=$(db_status_of "$INC_A")
expect_eq "$INC_A_STATUS_UNCHANGED" "cancelled" "MERGE=LINK: the TARGET incident (A) is completely untouched by marking B a duplicate of it"
STILL_QUERYABLE=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM incident WHERE incident_id IN ($INC_A,$INC_B);")
expect_eq "$STILL_QUERYABLE" "2" "Both incidents still independently exist (no delete, no row merge)"

step "11. Reopening clears the duplicate pointer"
K11="40000000-0000-4000-8000-000000000005"
expect_eq "$(body_of PATCH "/incidents/${INC_B}/lifecycle" "$SEC_TOKEN" "$K11" '{"status":"reopened"}' | jget duplicate_of_incident_id)" "" "reopened response has no duplicate_of_incident_id"
DB_DUP_AFTER=$(mysql_exec -N -s "$VALDB" -e "SELECT duplicate_of_incident_id FROM incident WHERE incident_id=$INC_B;")
expect_eq "$DB_DUP_AFTER" "NULL" "DB duplicate_of_incident_id cleared to NULL on reopen"

step "12. Open-dispatch guard blocks a lifecycle change"
K12="50000000-0000-4000-8000-000000000001"
expect_eq "$(status_of PATCH "/incidents/${INC_C}/lifecycle" "$SEC_TOKEN" "$K12" '{"status":"cancelled"}')" "409" "Cannot cancel an incident with an active dispatch -> 409"

step "13. Idempotency-Key replay returns the original outcome, no second audit row"
AUDIT_COUNT_BEFORE=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM audit_log WHERE action='incident_lifecycle_changed' AND entity_id=$INC_B;")
K13="40000000-0000-4000-8000-000000000005"
RESP13=$(body_of PATCH "/incidents/${INC_B}/lifecycle" "$SEC_TOKEN" "$K13" '{"status":"cancelled"}')
expect_eq "$(echo "$RESP13" | jget status)" "reopened" "Replay with K11's key returns the ORIGINAL outcome (reopened), ignoring this call's differing body"
AUDIT_COUNT_AFTER=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM audit_log WHERE action='incident_lifecycle_changed' AND entity_id=$INC_B;")
expect_eq "$AUDIT_COUNT_AFTER" "$AUDIT_COUNT_BEFORE" "No new audit row was written on replay"

step "14. Cross-tenant is 404, never 403"
K14="60000000-0000-4000-8000-000000000001"
expect_eq "$(status_of PATCH "/incidents/${INC_D}/lifecycle" "$SEC_TOKEN" "$K14" '{"status":"invalid"}')" "404" "Barangay-1 secretary against barangay-2 incident -> 404 (Rule 2)"
K14B="60000000-0000-4000-8000-000000000002"
expect_eq "$(status_of PATCH "/incidents/${INC_D}/lifecycle" "$SEC_B2_TOKEN" "$K14B" '{"status":"invalid"}')" "200" "Barangay-2 secretary against their own incident -> 200"

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
