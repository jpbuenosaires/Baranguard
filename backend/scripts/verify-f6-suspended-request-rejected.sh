#!/usr/bin/env bash
# Baranguard — F6 validation: `AuthMiddleware::authenticate()` now checks
# `user.is_suspended`, not just `is_active` (docs/REMAINING.md F6,
# docs/AUDIT_2026-09-07.md).
#
# Before this fix, only `AuthController::login()` checked `is_suspended`
# (migration 0011) — an ALREADY-authenticated request from a session that
# existed before the suspension (or one suspended by direct SQL/restore,
# bypassing `UsersController::updateStatus()`'s transactional session
# revocation) sailed through every protected endpoint. No existing verify
# suite calls a non-login endpoint with a suspended user's token — this
# script exists specifically to close that gap and prove the fix.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-f6-suspended-request-rejected.sh

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
VALDB="baranguard_f6_check"
APP_USER="f6chk_app"
APP_PASSWORD="F6Chk!2026xx"
API_PORT="8128"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="F6#2026Pw"

echo "Baranguard F6 (is_suspended checked on authenticated requests) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -f "$BACKEND_DIR/scripts/.f6chk-server.log"
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
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, is_suspended, created_at) VALUES
  (1, 'f6_admin', '$HASH', 'F6 Admin', 'admin', 1, 0, UTC_TIMESTAMP());
SQL
pass "Seeded one active, not-yet-suspended admin"

step "2. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.f6chk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
TOKEN=$(login_as f6_admin)
if [ -n "$TOKEN" ]; then
  pass "Logged in while not suspended (env override reached the disposable DB)"
else
  fail "Login failed — the API is probably talking to the REAL database (see this script's header)"
  exit 1
fi

step "3. A live session works normally BEFORE suspension"
CODE_BEFORE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/incidents" -H "Authorization: Bearer $TOKEN")
expect_eq "$CODE_BEFORE" "200" "GET /incidents succeeds with a not-suspended, still-valid token"

step "4. THE ACTUAL GAP: suspend the user OUTSIDE UsersController::updateStatus() (direct SQL, as a restore or an out-of-band admin action would) — the session row is deliberately NOT revoked, to isolate is_suspended's own check from session revocation"
mysql_exec "$VALDB" -e "UPDATE user SET is_suspended = 1, suspended_at = UTC_TIMESTAMP(), suspended_reason = 'F6 check' WHERE username = 'f6_admin';" >/dev/null
LIVE_SESSION_COUNT=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM auth_session WHERE revoked_at IS NULL;")
expect_eq "$LIVE_SESSION_COUNT" "1" "Session was NOT revoked by this direct-SQL suspension (confirms the test isolates is_suspended's own check)"

step "5. The SAME still-technically-valid token must now be rejected"
CODE_AFTER=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/incidents" -H "Authorization: Bearer $TOKEN")
expect_eq "$CODE_AFTER" "401" "GET /incidents with the SAME token is now 401 — is_suspended is checked on the authenticated request, not just at login"

step "6. Un-suspending restores access with the same token"
mysql_exec "$VALDB" -e "UPDATE user SET is_suspended = 0, suspended_at = NULL, suspended_reason = NULL WHERE username = 'f6_admin';" >/dev/null
CODE_RESTORED=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/incidents" -H "Authorization: Bearer $TOKEN")
expect_eq "$CODE_RESTORED" "200" "Un-suspending restores access with the same still-live token"

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
