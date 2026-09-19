#!/usr/bin/env bash
# Baranguard — device session policy validation (SessionPolicy, migration
# 0022, architecture decision 2026-09-19 — DEVLOG 2026-09-19 (7)).
#
# Proves over real HTTP that:
#   - a Tanod login carrying a well-formed X-Device-Id gets a DEVICE session
#     (24h expiry, auth_session.session_kind='device');
#   - the same login without the header, or with a malformed one, gets a
#     WEB session (JWT_EXPIRES_IN_MINUTES);
#   - an Admin sending X-Device-Id still gets a WEB session (role gate);
#   - sliding renewal of a device session never exceeds issued_at + 7 days
#     (absolute cap), while a web session renews on its own lifetime;
#   - revocation (logout, suspension) kills a device session instantly
#     regardless of its remaining 24h — the whole reason a long token is
#     acceptable here.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard`/`baranguard_uiseed` databases and backend/.env
# are never touched.
#
# Usage: bash backend/scripts/verify-device-session.sh
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
VALDB="baranguard_devsess_check"
APP_USER="devsess_app"
APP_PASSWORD="2ndResp!2026xx"
API_PORT="8132"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="2ndResp#2026Pw"

echo "Baranguard device-session validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"; PHP_BIN="$(find_bin php)"
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
  rm -f "$BACKEND_DIR/scripts/.devsess-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER'."
  echo "Your real databases and backend/.env were never touched."
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
         0019_audit_log_idempotency_index 0020_health_check_log_ors 0021_ai_evaluation_run_generic_metrics 0022_auth_session_kind; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Migrations 0001-0022 applied"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'ds_admin', '$HASH', 'DS Admin', 'admin', 1, UTC_TIMESTAMP()),
  (1, 'ds_tanod', '$HASH', 'DS Tanod', 'tanod', 1, UTC_TIMESTAMP());
SQL
pass "Seeded 1 admin + 1 tanod"

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN='*'
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.devsess-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}

DEVICE_ID="and-$("$PHP_BIN" -r "echo bin2hex(random_bytes(4)).'-'.bin2hex(random_bytes(2)).'-4'.substr(bin2hex(random_bytes(2)),1).'-8'.substr(bin2hex(random_bytes(2)),1).'-'.bin2hex(random_bytes(6));")"
login_with_header() { # $1 username, $2 header value ("" = none)
  if [ -n "$2" ]; then
    curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -H "X-Device-Id: $2" \
      -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}"
  else
    curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
      -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}"
  fi
}
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "";'; }
jwt_claim() { echo "$1" | cut -d. -f2 | "$PHP_BIN" -r '$p=json_decode(base64_decode(strtr(trim(file_get_contents("php://stdin")),"-_","+/")),true); echo $p["'"$2"'"] ?? "";'; }
kind_of_jti() { mysql_exec -N -s "$VALDB" -e "SELECT session_kind FROM auth_session WHERE jti='$1';"; }
# Seconds from now (server UTC clock) to expires_at. Never UNIX_TIMESTAMP() on
# these columns: they are stored UTC and the session zone is the host's +08:00.
exp_in() { mysql_exec -N -s "$VALDB" -e "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), expires_at) FROM auth_session WHERE jti='$1';"; }
cap_in() { mysql_exec -N -s "$VALDB" -e "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), issued_at + INTERVAL 7 DAY) FROM auth_session WHERE jti='$1';"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}$1" -H "Authorization: Bearer $2"; }
NOW=$(date +%s)

step "4. Tanod login WITH X-Device-Id -> device session (24h)"
R=$(login_with_header ds_tanod "$DEVICE_ID"); T_DEV=$(echo "$R" | jget token)
[ -n "$T_DEV" ] && pass "Tanod logged in with device id" || { fail "Tanod login failed: $R"; exit 1; }
JTI_DEV=$(jwt_claim "$T_DEV" jti); EXP_DEV=$(jwt_claim "$T_DEV" exp)
expect_eq "$(kind_of_jti "$JTI_DEV")" "device" "auth_session.session_kind is 'device'"
LIFE=$((EXP_DEV - NOW)); [ "$LIFE" -gt 86000 ] && [ "$LIFE" -le 86460 ] && pass "JWT exp is ~24h out (${LIFE}s)" || fail "JWT exp not ~24h: ${LIFE}s"
expect_eq "$(mysql_exec -N -s "$VALDB" -e "SELECT JSON_EXTRACT(metadata_json,'$.session_kind') FROM audit_log WHERE action='login_success' ORDER BY audit_id DESC LIMIT 1;")" '"device"' "Audit metadata records session_kind (allow-listed enum, no secrets)"

step "5. Tanod login WITHOUT the header, and with a malformed one -> web session (15m)"
R=$(login_with_header ds_tanod ""); T_WEB=$(echo "$R" | jget token); JTI_WEB=$(jwt_claim "$T_WEB" jti); EXP_WEB=$(jwt_claim "$T_WEB" exp)
expect_eq "$(kind_of_jti "$JTI_WEB")" "web" "No header -> 'web'"
LIFE=$((EXP_WEB - NOW)); [ "$LIFE" -gt 840 ] && [ "$LIFE" -le 960 ] && pass "JWT exp is ~15m out (${LIFE}s)" || fail "JWT exp not ~15m: ${LIFE}s"
R=$(login_with_header ds_tanod "not-a-device-id"); JTI_BAD=$(jwt_claim "$(echo "$R" | jget token)" jti)
expect_eq "$(kind_of_jti "$JTI_BAD")" "web" "Malformed X-Device-Id -> 'web'"

step "6. Admin login WITH a well-formed X-Device-Id -> still web (role gate)"
R=$(login_with_header ds_admin "$DEVICE_ID"); T_ADM=$(echo "$R" | jget token); JTI_ADM=$(jwt_claim "$T_ADM" jti)
expect_eq "$(kind_of_jti "$JTI_ADM")" "web" "Admin cannot obtain a device session by adding the header"

step "7. Sliding renewal respects the 7-day absolute cap for device sessions"
# Age the device session: issued 6d22h ago (cap in 2h), 1h from expiry (renewal threshold is remaining < 50% of 24h).
mysql_exec "$VALDB" -e "UPDATE auth_session SET issued_at = UTC_TIMESTAMP() - INTERVAL 166 HOUR, expires_at = UTC_TIMESTAMP() + INTERVAL 1 HOUR WHERE jti='$JTI_DEV';"
HDR=$(curl -s -D - -o /dev/null "${BASE_URL}/notifications" -H "Authorization: Bearer $T_DEV" | grep -i "^X-Renewed-Token:" | cut -d' ' -f2 | tr -d '')
[ -n "$HDR" ] && pass "Renewal issued (remaining 1h < 50% of 24h)" || fail "No X-Renewed-Token on a renewable device session"
EXP_IN=$(exp_in "$JTI_DEV"); CAP_IN=$(cap_in "$JTI_DEV")
# 2h to the cap: renewed expiry must land AT the cap (~7200s), NOT at +24h.
[ "$EXP_IN" -gt 7000 ] && [ "$EXP_IN" -le "$CAP_IN" ] && [ "$EXP_IN" -lt 10000 ] && pass "Renewed expires_at capped at issued_at+7d (expires in ${EXP_IN}s, cap in ${CAP_IN}s, not +24h)" || fail "Cap not applied: expires in ${EXP_IN}s, cap in ${CAP_IN}s"
if [ -n "$HDR" ]; then
  JWT_EXP_IN=$(( $(jwt_claim "$HDR" exp) - $(date +%s) ))
  D=$(( JWT_EXP_IN - EXP_IN )); [ "${D#-}" -le 5 ] && pass "Renewed JWT exp matches the capped DB expiry (Δ${D}s)" || fail "Renewed JWT exp (${JWT_EXP_IN}s) != DB (${EXP_IN}s)"
fi
# Once AT the cap, no further renewal is ever issued.
T_DEV2="${HDR:-$T_DEV}"
HDR2=$(curl -s -D - -o /dev/null "${BASE_URL}/notifications" -H "Authorization: Bearer $T_DEV2" | grep -ic "^X-Renewed-Token:")
expect_eq "$HDR2" "0" "At the cap: no further renewal header (session will simply run out)"
expect_eq "$(http_code /notifications "$T_DEV2")" "200" "...but the token is still valid until then"

step "8. Web session renews on its own 15m lifetime (unchanged behaviour)"
mysql_exec "$VALDB" -e "UPDATE auth_session SET expires_at = UTC_TIMESTAMP() + INTERVAL 5 MINUTE WHERE jti='$JTI_WEB';"
curl -s -o /dev/null "${BASE_URL}/notifications" -H "Authorization: Bearer $T_WEB"
LIFE=$(exp_in "$JTI_WEB")
[ "$LIFE" -gt 840 ] && [ "$LIFE" -le 960 ] && pass "Web session renewed to ~15m (${LIFE}s), not 24h" || fail "Web renewal wrong: ${LIFE}s"

step "9. Revocation is instant for a device session (why a 24h token is acceptable)"
R=$(login_with_header ds_tanod "$DEVICE_ID"); T_DEV3=$(echo "$R" | jget token)
expect_eq "$(http_code /notifications "$T_DEV3")" "200" "Fresh device session works"
curl -s -o /dev/null -X POST "${BASE_URL}/auth/logout" -H "Authorization: Bearer $T_DEV3"
expect_eq "$(http_code /notifications "$T_DEV3")" "401" "After logout the 24h device token is rejected immediately"
R=$(login_with_header ds_tanod "$DEVICE_ID"); T_DEV4=$(echo "$R" | jget token)
mysql_exec "$VALDB" -e "UPDATE user SET is_suspended=1, suspended_at=UTC_TIMESTAMP(), suspended_reason='test' WHERE username='ds_tanod';"
expect_eq "$(http_code /notifications "$T_DEV4")" "401" "Suspending the user kills the live device session on the next request"

echo; echo "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
