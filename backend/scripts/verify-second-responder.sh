#!/usr/bin/env bash
# Baranguard — second responder / backup dispatch validation
# (docs/REMAINING.md G-backlog "Backup/second responder on critical
# incidents", closed 2026-09-13 by explicit user architecture sign-off —
# no incident-type/priority gate, unbounded concurrent dispatches,
# Admin's own judgment call).
#
# Before this fix, DispatchController::create() rejected a second
# POST /dispatch on any incident once its status left 'pending' — a
# hard "at most one active dispatch per incident" rule. This script
# proves the new behavior end-to-end over real HTTP: a second (and
# third) concurrent responder can be added to an already-dispatched
# incident, a Tanod cannot be double-assigned to the same incident, and
# DispatchController::cancel()'s incident-revert-to-pending logic now
# correctly accounts for OTHER still-active dispatches rather than
# unconditionally reverting on any single cancellation.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard`/`baranguard_uiseed` databases and backend/.env
# are never touched.
#
# Usage: bash backend/scripts/verify-second-responder.sh

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
VALDB="baranguard_2ndresp_check"
APP_USER="2ndresp_app"
APP_PASSWORD="2ndResp!2026xx"
API_PORT="8131"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="2ndResp#2026Pw"

echo "Baranguard second-responder validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -f "$BACKEND_DIR/scripts/.2ndresp-server.log"
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
         0019_audit_log_idempotency_index; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Migrations 0001-0019 applied"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, '2r_admin',  '$HASH', '2R Admin',  'admin', 1, UTC_TIMESTAMP()),
  (1, '2r_admin2', '$HASH', '2R Admin B2', 'admin', 1, UTC_TIMESTAMP()),
  (1, '2r_tanod_a','$HASH', 'Tanod Alpha','tanod', 1, UTC_TIMESTAMP()),
  (1, '2r_tanod_b','$HASH', 'Tanod Bravo','tanod', 1, UTC_TIMESTAMP()),
  (2, '2r_admin_b2brgy', '$HASH', '2R Admin Brgy2', 'admin', 1, UTC_TIMESTAMP());
SQL
mysql_exec "$VALDB" -e "UPDATE user SET barangay_id=2 WHERE username='2r_admin_b2brgy';"
TANOD_A=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='2r_tanod_a';")
TANOD_B=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='2r_tanod_b';")
mysql_exec "$VALDB" <<SQL
INSERT INTO duty_status (user_id, status, channel, changed_at) VALUES
  ($TANOD_A, 'on_duty', 'app', UTC_TIMESTAMP()),
  ($TANOD_B, 'on_duty', 'app', UTC_TIMESTAMP());
SQL
pass "Seeded 2 admins (barangay 1 + 2) and 2 on-duty Tanods"

step "2. Seed one pending incident"
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
  (1, 'fire', 'critical', 'RAW-2RESP-CHECK', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
INC1=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE raw_narrative='RAW-2RESP-CHECK';")
echo "  incident: INC1=$INC1"

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.2ndresp-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as 2r_admin)
ADMIN2_TOKEN=$(login_as 2r_admin_b2brgy)
if [ -n "$ADMIN_TOKEN" ]; then
  pass "Logged in as admin (env override reached the disposable DB)"
else
  fail "Login failed"; exit 1
fi

body_of() { curl -s -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "${4:-}"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "${4:-}"; }
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "";'; }
incident_status() { mysql_exec -N -s "$VALDB" -e "SELECT status FROM incident WHERE incident_id=$INC1;"; }
active_dispatch_count() { mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM dispatch WHERE incident_id=$INC1 AND status IN ('assigned','en_route','arrived');"; }
uuid() { "$PHP_BIN" -r "echo bin2hex(random_bytes(4)).'-'.bin2hex(random_bytes(2)).'-4'.substr(bin2hex(random_bytes(2)),1).'-8'.substr(bin2hex(random_bytes(2)),1).'-'.bin2hex(random_bytes(6));"; }

step "4. First dispatch to a pending incident still works exactly as before (regression)"
REQ1=$(uuid)
RESP1=$(body_of POST "/dispatch" "$ADMIN_TOKEN" "{\"incident_id\":$INC1,\"tanod_id\":$TANOD_A,\"request_id\":\"$REQ1\"}")
DISPATCH1=$(echo "$RESP1" | jget dispatch_id)
expect_eq "$([ -n "$DISPATCH1" ] && echo yes || echo no)" "yes" "First dispatch created ($DISPATCH1)"
expect_eq "$(incident_status)" "dispatched" "Incident flipped to dispatched"

step "5. THE ACTUAL NEW CAPABILITY: a second responder on an already-dispatched incident"
REQ2=$(uuid)
RESP2=$(body_of POST "/dispatch" "$ADMIN_TOKEN" "{\"incident_id\":$INC1,\"tanod_id\":$TANOD_B,\"request_id\":\"$REQ2\"}")
DISPATCH2=$(echo "$RESP2" | jget dispatch_id)
expect_eq "$([ -n "$DISPATCH2" ] && echo yes || echo no)" "yes" "Second dispatch (different Tanod) succeeds on a 'dispatched' incident ($DISPATCH2)"
expect_eq "$(active_dispatch_count)" "2" "Two active dispatches now exist on the same incident"
expect_eq "$(incident_status)" "dispatched" "Incident stays dispatched (unchanged, regression)"

step "6. A Tanod cannot be double-assigned to the same incident"
REQ3=$(uuid)
expect_eq "$(status_of POST "/dispatch" "$ADMIN_TOKEN" "{\"incident_id\":$INC1,\"tanod_id\":$TANOD_A,\"request_id\":\"$REQ3\"}")" "409" "Tanod Alpha already active on this incident -> 409"

step "7. GET /incidents/:id returns BOTH responders in a real dispatches[] array"
DETAIL=$(body_of GET "/incidents/$INC1" "$ADMIN_TOKEN")
DISPATCH_COUNT_IN_RESPONSE=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["dispatches"] ?? []);' <<< "$DETAIL")
expect_eq "$DISPATCH_COUNT_IN_RESPONSE" "2" "GET /incidents/:id's dispatches[] has both responders"
NAMES_MATCH=$("$PHP_BIN" -r '
$d=json_decode(file_get_contents("php://stdin"),true);
$names = array_column($d["dispatches"] ?? [], "tanod_name");
sort($names);
echo implode(",", $names);
' <<< "$DETAIL")
expect_eq "$NAMES_MATCH" "Tanod Alpha,Tanod Bravo" "Both real Tanod names present, no fabricated fallback"

step "8. Cancelling ONE of two active dispatches leaves the incident 'dispatched'"
CANCEL1=$(body_of PATCH "/dispatch/$DISPATCH2/cancel" "$ADMIN_TOKEN")
expect_eq "$(echo "$CANCEL1" | jget incident_status)" "dispatched" "Cancel response reports incident_status='dispatched' (not the old hardcoded 'pending')"
expect_eq "$(incident_status)" "dispatched" "DB confirms incident is still dispatched — Tanod Alpha's dispatch is untouched"
expect_eq "$(active_dispatch_count)" "1" "Exactly one active dispatch remains"

step "9. Cancelling the LAST active dispatch DOES revert to pending (regression on single-responder path)"
CANCEL2=$(body_of PATCH "/dispatch/$DISPATCH1/cancel" "$ADMIN_TOKEN")
expect_eq "$(echo "$CANCEL2" | jget incident_status)" "pending" "Cancel response reports incident_status='pending'"
expect_eq "$(incident_status)" "pending" "DB confirms incident reverted to pending — no active dispatch remains"
expect_eq "$(active_dispatch_count)" "0" "Zero active dispatches remain"

step "10. Resolve requires ALL active dispatches cleared, not just one (regression, already-correct logic)"
# 'arrived' is still an ACTIVE status for the resolve gate's own
# definition (assigned/en_route/arrived) — only 'completed' (or
# 'cancelled') clears it. Set both to 'arrived' first to prove the gate
# still blocks correctly, then 'completed' to prove it clears.
REQ4=$(uuid); REQ5=$(uuid)
D3=$(body_of POST "/dispatch" "$ADMIN_TOKEN" "{\"incident_id\":$INC1,\"tanod_id\":$TANOD_A,\"request_id\":\"$REQ4\"}" | jget dispatch_id)
D4=$(body_of POST "/dispatch" "$ADMIN_TOKEN" "{\"incident_id\":$INC1,\"tanod_id\":$TANOD_B,\"request_id\":\"$REQ5\"}" | jget dispatch_id)
mysql_exec "$VALDB" -e "UPDATE dispatch SET status='arrived', arrived_at=UTC_TIMESTAMP() WHERE dispatch_id=$D3;"
expect_eq "$(status_of PATCH "/incidents/$INC1/status" "$ADMIN_TOKEN" '{"status":"resolved"}')" "409" "Cannot resolve while Tanod Alpha is only 'arrived', not 'completed', and Bravo hasn't arrived at all"
mysql_exec "$VALDB" -e "UPDATE dispatch SET status='arrived', arrived_at=UTC_TIMESTAMP() WHERE dispatch_id=$D4;"
expect_eq "$(status_of PATCH "/incidents/$INC1/status" "$ADMIN_TOKEN" '{"status":"resolved"}')" "409" "Still blocked — both 'arrived' is not the same as both 'completed'"
mysql_exec "$VALDB" -e "UPDATE dispatch SET status='completed', completed_at=UTC_TIMESTAMP() WHERE dispatch_id IN ($D3, $D4);"
expect_eq "$(status_of PATCH "/incidents/$INC1/status" "$ADMIN_TOKEN" '{"status":"resolved"}')" "200" "Resolves once BOTH responders are completed"

step "11. Cross-tenant: an Admin from another barangay cannot add a responder here"
REQ6=$(uuid)
expect_eq "$(status_of POST "/dispatch" "$ADMIN2_TOKEN" "{\"incident_id\":$INC1,\"tanod_id\":$TANOD_A,\"request_id\":\"$REQ6\"}")" "404" "Cross-tenant dispatch attempt is 404, never a 403 (Rule 2)"

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
