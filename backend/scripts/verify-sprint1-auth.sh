#!/usr/bin/env bash
# Baranguard — Sprint 1 "Auth backend + shared middleware" validation
# against a REAL local XAMPP MariaDB + PHP (not a cloud sandbox). Safe to
# run: everything happens in a disposable database
# (baranguard_sprint1_check) with a disposable app-user and a disposable
# test admin account, and a PHP dev server on a throwaway local port. Your
# real `baranguard` database, real backend/.env, and Apache are never
# touched.
#
# Usage (from a Git Bash prompt, repo root or anywhere):
#   bash backend/scripts/verify-sprint1-auth.sh
#
# Override connection defaults if your XAMPP root account has a password:
#   XAMPP_MYSQL_PASSWORD=yourpass bash backend/scripts/verify-sprint1-auth.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
LOG_FILE="$BACKEND_DIR/scripts/sprint1-auth-validation-$(date -u +%Y%m%dT%H%M%SZ).log"

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
VALDB="baranguard_sprint1_check"
APP_USER="sprint1_check_app"
APP_PASSWORD="Sprint1CheckDbPw!"
API_PORT="8091"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"

echo "Baranguard Sprint 1 auth validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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

if ! "$PHP_BIN" -r 'exit(in_array("argon2id", password_algos(), true) ? 0 : 1);'; then
  echo "WARNING: this PHP build does not report argon2id support in password_algos()." >&2
  echo "         password_verify() against Sprint 0's argon2id hashes will fail. This" >&2
  echo "         is exactly the cross-runtime risk flagged when PHP was chosen to serve" >&2
  echo "         the API — you'll need a PHP build with Argon2 support (recent XAMPP" >&2
  echo "         for Windows normally includes it)." >&2
fi

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
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

step "1. Set up disposable schema + test admin"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "Schema applied" || fail "Schema apply failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" && pass "Barangays seeded" || fail "Seed failed"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

TEST_USERNAME="sprint1_check_admin"
TEST_PW="Sprint1Check#2026"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" -e "INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, failed_login_attempts, created_at, updated_at) VALUES (1, '$TEST_USERNAME', '$HASH', 'Sprint1 Check Admin', 'admin', TRUE, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP());"
pass "Test admin created with a real PHP-generated argon2id hash"

step "2. Start the API (PHP built-in server on a throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN='*'
(cd "$BACKEND_DIR/public" && "$PHP_BIN" -S "127.0.0.1:${API_PORT}" >"$BACKEND_DIR/scripts/.sprint1-server.log" 2>&1) &
SERVER_PID=$!
sleep 1
if curl -s -o /dev/null "${BASE_URL}/auth/login" -X POST -d '{}'; then
  pass "PHP dev server responding on port $API_PORT"
else
  fail "PHP dev server did not start — see backend/scripts/.sprint1-server.log"
  exit 1
fi

step "3. Login — validation, unknown user, wrong password, lockout, success"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d '{}')
[ "$CODE" = "400" ] && pass "Empty body -> 400 VALIDATION_ERROR" || fail "Empty body -> $CODE (expected 400)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d '{"username":"nobody_here","password":"whatever12345"}')
[ "$CODE" = "401" ] && pass "Unknown user -> 401 UNAUTHORIZED" || fail "Unknown user -> $CODE (expected 401)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$TEST_USERNAME\",\"password\":\"wrongpassword123\"}")
[ "$CODE" = "401" ] && pass "Wrong password -> 401 UNAUTHORIZED" || fail "Wrong password -> $CODE (expected 401)"

for i in 1 2 3 4; do
  curl -s -o /dev/null "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$TEST_USERNAME\",\"password\":\"wrongpassword123\"}"
done
LOCKED=$(mysql_exec -N -e "SELECT locked_until IS NOT NULL FROM user WHERE username='$TEST_USERNAME';" "$VALDB")
[ "$LOCKED" = "1" ] && pass "5th failed attempt locked the account (locked_until set)" || fail "Account not locked after 5 failed attempts"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$TEST_USERNAME\",\"password\":\"$TEST_PW\"}")
[ "$CODE" = "401" ] && pass "Correct password while locked -> still 401 (lockout enforced)" || fail "Correct password while locked -> $CODE (expected 401)"

mysql_exec "$VALDB" -e "UPDATE user SET failed_login_attempts=0, login_failure_window_started_at=NULL, locked_until=NULL WHERE username='$TEST_USERNAME';"

RESP=$(curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"  ${TEST_USERNAME^^}  \",\"password\":\"$TEST_PW\"}")
TOKEN=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";')
if [ -n "$TOKEN" ]; then
  pass "Correct login (with un-normalized username casing/whitespace) -> got a token"
else
  fail "Correct login did not return a token: $RESP"
fi

step "4. Logout — success, idempotent retry, garbage token, missing header"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/auth/logout" -X POST -H "Authorization: Bearer $TOKEN")
[ "$CODE" = "200" ] && pass "Logout -> 200" || fail "Logout -> $CODE (expected 200)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/auth/logout" -X POST -H "Authorization: Bearer $TOKEN")
[ "$CODE" = "200" ] && pass "Repeat logout with the same (now-revoked) token -> still 200 (idempotent per §6)" || fail "Repeat logout -> $CODE (expected 200)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/auth/logout" -X POST -H "Authorization: Bearer garbage.not-a.jwt")
[ "$CODE" = "401" ] && pass "Garbage token -> 401" || fail "Garbage token -> $CODE (expected 401)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/auth/logout" -X POST)
[ "$CODE" = "401" ] && pass "Missing Authorization header -> 401" || fail "Missing Authorization header -> $CODE (expected 401)"

step "5. Router edges + CORS"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/nope")
[ "$CODE" = "404" ] && pass "Unknown route -> 404" || fail "Unknown route -> $CODE (expected 404)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/auth/login" -X GET)
[ "$CODE" = "405" ] && pass "Wrong method on known route -> 405" || fail "Wrong method -> $CODE (expected 405)"

CORS_HEADER=$(curl -s -i -X OPTIONS "${BASE_URL}/auth/login" | grep -i "Access-Control-Allow-Origin" || true)
[ -n "$CORS_HEADER" ] && pass "OPTIONS preflight returns CORS headers" || fail "No Access-Control-Allow-Origin on OPTIONS response"

step "6. Audit trail"
LOGIN_SUCCESS_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM audit_log WHERE action='login_success';" "$VALDB")
LOGIN_FAILURE_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM audit_log WHERE action='login_failure';" "$VALDB")
LOGOUT_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM audit_log WHERE action='logout';" "$VALDB")
[ "$LOGIN_SUCCESS_COUNT" -ge 1 ] && pass "login_success audit rows recorded ($LOGIN_SUCCESS_COUNT)" || fail "No login_success audit rows"
[ "$LOGIN_FAILURE_COUNT" -ge 1 ] && pass "login_failure audit rows recorded ($LOGIN_FAILURE_COUNT)" || fail "No login_failure audit rows"
[ "$LOGOUT_COUNT" = "1" ] && pass "Exactly 1 logout audit row despite 2 logout calls (no duplicate on the idempotent retry)" || fail "logout audit row count = $LOGOUT_COUNT (expected 1)"

NO_PW_IN_AUDIT=$(mysql_exec -N -e "SELECT COUNT(*) FROM audit_log WHERE metadata_json LIKE '%$TEST_PW%';" "$VALDB")
[ "$NO_PW_IN_AUDIT" = "0" ] && pass "Test password never appears in audit_log metadata" || fail "Test password found in audit_log metadata!"

step "SUMMARY"
echo "$PASS passed, $FAIL failed."
echo "Full log: $LOG_FILE"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
