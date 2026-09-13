#!/usr/bin/env bash
# Baranguard — F5 validation: `PATCH /incidents/:id` idempotency
# (docs/REMAINING.md F5, docs/AUDIT_2026-09-07.md).
#
# Before this fix, the endpoint required and UUID-validated an
# `Idempotency-Key` header, then never stored or replayed it — a retry
# wrote a SECOND `incident_updated` audit row for the same edit, violating
# §2 Rule 3 ("a retry must return the original row, never create a
# second"). This endpoint had never been called over HTTP by any existing
# verify suite (see HANDOFF.md), so nothing else in this repo exercises
# it — this script exists specifically to prove the fix.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-f5-incident-update-idempotency.sh

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
VALDB="baranguard_f5_check"
APP_USER="f5chk_app"
APP_PASSWORD="F5Chk!2026xx"
API_PORT="8127"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="F5#2026Pw"

echo "Baranguard F5 (PATCH /incidents/:id idempotency) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -f "$BACKEND_DIR/scripts/.f5chk-server.log"
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
         0018_sms_subscriber \
         0019_audit_log_idempotency_index; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Migrations 0001-0019 applied"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'f5_admin',     '$HASH', 'F5 Admin',         'admin',     1, UTC_TIMESTAMP()),
  (1, 'f5_secretary', '$HASH', 'F5 Secretary',     'secretary', 1, UTC_TIMESTAMP()),
  (2, 'f5_admin2',    '$HASH', 'F5 Admin Brgy2',   'admin',     1, UTC_TIMESTAMP());
SQL
pass "Seeded admin/secretary (barangay 1) + admin (barangay 2)"

step "2. Seed one incident"
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
  (1, 'theft', 'normal', 'RAW-F5-CHECK', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
INC1=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE incident_type='theft' LIMIT 1;")
echo "  incident: INC1=$INC1"

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.f5chk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as f5_admin)
ADMIN2_TOKEN=$(login_as f5_admin2)
if [ -n "$ADMIN_TOKEN" ]; then
  pass "Logged in as admin (env override reached the disposable DB)"
else
  fail "Login failed — the API is probably talking to the REAL database (see this script's header)"
  exit 1
fi

status_of() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -H "Idempotency-Key: ${4:-}" -d "${5:-}"; }
body_of()   { curl -s -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -H "Idempotency-Key: ${4:-}" -d "${5:-}"; }
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "";'; }
audit_count() {
  mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM audit_log WHERE action='incident_updated' AND entity_id=$INC1;"
}

step "4. No Idempotency-Key -> 400 (unchanged behaviour)"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "${BASE_URL}/incidents/${INC1}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"priority":"critical"}')" "400" "Missing Idempotency-Key is refused"

step "5. Malformed Idempotency-Key -> 400 (unchanged behaviour)"
expect_eq "$(status_of PATCH "/incidents/${INC1}" "$ADMIN_TOKEN" "not-a-uuid" '{"priority":"critical"}')" "400" "Non-UUID Idempotency-Key is refused"

step "6. First PATCH with a real key actually applies the change"
KEY1="11111111-1111-4111-8111-111111111111"
RESP1=$(body_of PATCH "/incidents/${INC1}" "$ADMIN_TOKEN" "$KEY1" '{"priority":"critical"}')
expect_eq "$(echo "$RESP1" | jget updated)" "1" "First PATCH applies the update (updated=true)"
DB_PRIORITY_1=$(mysql_exec -N -s "$VALDB" -e "SELECT priority FROM incident WHERE incident_id=$INC1;")
expect_eq "$DB_PRIORITY_1" "critical" "priority actually changed in the database"
expect_eq "$(audit_count)" "1" "Exactly ONE incident_updated audit row after the first PATCH"

step "7. THE ACTUAL BUG: retry with the SAME key must not write a second audit row"
mysql_exec "$VALDB" -e "UPDATE incident SET priority='normal' WHERE incident_id=$INC1;" >/dev/null
RESP2=$(body_of PATCH "/incidents/${INC1}" "$ADMIN_TOKEN" "$KEY1" '{"priority":"critical"}')
expect_eq "$(echo "$RESP2" | jget updated)" "1" "Replayed PATCH still reports updated=true (returns the original outcome)"
expect_eq "$(audit_count)" "1" "STILL exactly ONE incident_updated audit row — the retry did not write a second one"
DB_PRIORITY_2=$(mysql_exec -N -s "$VALDB" -e "SELECT priority FROM incident WHERE incident_id=$INC1;")
expect_eq "$DB_PRIORITY_2" "normal" "Replay did NOT re-apply the write (DB value is whatever it was BEFORE the replay, proving no second UPDATE ran)"

step "8. A DIFFERENT key on the same incident is a genuinely new edit"
KEY2="22222222-2222-4222-8222-222222222222"
RESP3=$(body_of PATCH "/incidents/${INC1}" "$ADMIN_TOKEN" "$KEY2" '{"priority":"high"}')
expect_eq "$(echo "$RESP3" | jget updated)" "1" "A fresh Idempotency-Key applies a new edit"
expect_eq "$(audit_count)" "2" "A genuinely new key writes a SECOND audit row (2 total)"
DB_PRIORITY_3=$(mysql_exec -N -s "$VALDB" -e "SELECT priority FROM incident WHERE incident_id=$INC1;")
expect_eq "$DB_PRIORITY_3" "high" "priority actually changed for the new key's edit"

step "9. Cross-tenant replay lookup does not leak — barangay 2 Admin gets 404, not a replay"
expect_eq "$(status_of PATCH "/incidents/${INC1}" "$ADMIN2_TOKEN" "$KEY1" '{"priority":"critical"}')" "404" "Cross-tenant PATCH is 404, never a cross-tenant replay"

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
