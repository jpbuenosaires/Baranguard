#!/usr/bin/env bash
# Baranguard — W3a/W3b Dispatch Center + W4 GIS Live Tracking backend
# validation against a REAL local XAMPP MariaDB + PHP (not a cloud
# sandbox). Safe to run: everything happens in a disposable database
# (baranguard_w3w4_check) with a disposable app-user, disposable test
# accounts, and a PHP dev server on a throwaway local port. Your real
# `baranguard` database, real backend/.env, and Apache are never touched.
# Mirrors verify-sprint1-auth.sh / verify-w2-reports.sh's conventions.
#
# Usage (from a Git Bash prompt, repo root or anywhere):
#   bash backend/scripts/verify-w3-w4-dispatch-gis.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
LOG_FILE="$BACKEND_DIR/scripts/w3-w4-validation-$(date -u +%Y%m%dT%H%M%SZ).log"

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
VALDB="baranguard_w3w4_check"
APP_USER="w3w4_check_app"
APP_PASSWORD="W3W4CheckDbPw!2026"
API_PORT="8094"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="W3W4Check#2026Pw"

echo "Baranguard W3a/W3b/W4 (Dispatch + GPS/SOS/duty-status) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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

step "2. Seed users, duty status, incidents, GPS tracks, SOS"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'w3check_admin',     '$HASH', 'W3 Check Admin',      'admin',           1, UTC_TIMESTAMP()),
  (1, 'w3check_pb',        '$HASH', 'W3 Check PB',         'punong_barangay', 1, UTC_TIMESTAMP()),
  (1, 'w3check_secretary', '$HASH', 'W3 Check Secretary',  'secretary',       1, UTC_TIMESTAMP()),
  (1, 'w3check_tanod1',    '$HASH', 'W3 Check Tanod One',  'tanod',           1, UTC_TIMESTAMP()),
  (1, 'w3check_tanod2',    '$HASH', 'W3 Check Tanod Two',  'tanod',           1, UTC_TIMESTAMP()),
  (1, 'w3check_tanod3',    '$HASH', 'W3 Check Tanod Three','tanod',           1, UTC_TIMESTAMP()),
  (2, 'w3check_admin_b2',  '$HASH', 'W3 Check Admin B2',   'admin',           1, UTC_TIMESTAMP()),
  (2, 'w3check_tanod_b2',  '$HASH', 'W3 Check Tanod B2',   'tanod',           1, UTC_TIMESTAMP());

-- tanod1 (id 4): on_duty (eligible). tanod2 (id 5): off_duty. tanod3 (id 6): responding.
INSERT INTO duty_status (user_id, status, channel, changed_at) VALUES
  (4, 'off_duty',   'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR)),
  (4, 'on_duty',    'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)),
  (5, 'off_duty',   'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)),
  (6, 'responding', 'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE));

-- 2 pending incidents in barangay 1 (one normal, one critical), 1 pending in barangay 2.
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, latitude, longitude, created_at, updated_at) VALUES
  (1, 3, 'theft',    'normal',   'sandbox test narrative', 'pending', 'web', 12.9186, 123.6667, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, 3, 'fire',      'critical', 'sandbox test narrative', 'pending', 'web', 12.9200, 123.6650, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (2, 7, 'disturbance','normal',  'sandbox test narrative', 'pending', 'web', 12.9000, 123.7000, UTC_TIMESTAMP(), UTC_TIMESTAMP());

-- GPS: tanod1 fresh (10s old), tanod3 stale (5 minutes old). tanod2 has no GPS row at all.
INSERT INTO gps_track (user_id, latitude, longitude, accuracy_m, recorded_at, received_at) VALUES
  (4, 12.9190, 123.6660, 8.5, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 SECOND), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 SECOND)),
  (6, 12.9210, 123.6640, 12.0, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE));

-- One active SOS from tanod1.
INSERT INTO tanod_sos (user_id, barangay_id, latitude, longitude, triggered_at, received_at, status, client_event_id, fallback_channel) VALUES
  (4, 1, 12.9195, 123.6655, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'active', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'app');
SQL
[ $? -eq 0 ] && pass "Seeded 8 users, 4 duty_status events, 3 incidents, 2 GPS tracks, 1 SOS" || fail "Seed SQL failed"

step "3. Start the API (PHP built-in server on a throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN='*'
(cd "$BACKEND_DIR/public" && "$PHP_BIN" -S "127.0.0.1:${API_PORT}" >"$BACKEND_DIR/scripts/.w3w4-server.log" 2>&1) &
SERVER_PID=$!
sleep 1
if curl -s -o /dev/null "${BASE_URL}/auth/login" -X POST -d '{}'; then
  pass "PHP dev server responding on port $API_PORT"
else
  fail "PHP dev server did not start — see backend/scripts/.w3w4-server.log"
  exit 1
fi

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as w3check_admin)
PB_TOKEN=$(login_as w3check_pb)
SEC_TOKEN=$(login_as w3check_secretary)
TANOD1_TOKEN=$(login_as w3check_tanod1)
ADMIN_B2_TOKEN=$(login_as w3check_admin_b2)
[ -n "$ADMIN_TOKEN" ] && pass "Logged in as admin, PB, secretary, tanod1, and barangay-2 admin" || fail "Admin login failed to return a token"

extract() {
  local resp="$1" key="$2"
  echo "$resp" | "$PHP_BIN" -r "\$d=json_decode(file_get_contents('php://stdin'),true); echo \$d['$key'] ?? 'MISSING';"
}

step "4. GET /users?role=tanod (Tanod-picker plumbing)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $SEC_TOKEN" "${BASE_URL}/users?role=tanod")
[ "$CODE" = "403" ] && pass "Secretary -> 403 (Admin only)" || fail "Secretary -> $CODE (expected 403)"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/users?role=tanod")
TOTAL=$(extract "$RESP" total)
[ "$TOTAL" = "3" ] && pass "GET /users?role=tanod total=3" || fail "GET /users?role=tanod total=$TOTAL (expected 3)"

step "5. GET /incidents?status=pending (W3 queue) + tenant isolation"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/incidents?status=pending")
TOTAL=$(extract "$RESP" total)
[ "$TOTAL" = "2" ] && pass "Barangay-1 admin sees 2 pending incidents" || fail "Barangay-1 pending total=$TOTAL (expected 2)"
RESP_B2=$(curl -s -H "Authorization: Bearer $ADMIN_B2_TOKEN" "${BASE_URL}/incidents?status=pending")
TOTAL_B2=$(extract "$RESP_B2" total)
[ "$TOTAL_B2" = "1" ] && pass "Barangay-2 admin sees only their own 1 pending incident (tenant isolation)" || fail "Barangay-2 pending total=$TOTAL_B2 (expected 1)"

# Both seeded barangay-1 incidents share the same created_at (same INSERT
# statement), so ORDER BY created_at DESC has no guaranteed tie-break —
# select each by its distinct priority value, never by list position, so
# these two variables can never accidentally resolve to the same row.
INCIDENT_ID=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); foreach($d["items"] as $i){ if($i["priority"]==="normal"){ echo $i["incident_id"]; break; } }')
CRITICAL_INCIDENT_ID=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); foreach($d["items"] as $i){ if($i["priority"]==="critical"){ echo $i["incident_id"]; break; } }')

step "6. GET /duty-status?barangay_id= and ?user_id=me"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/duty-status?barangay_id=1")
ON_DUTY_COUNT=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count(array_filter($d["items"], fn($r)=>$r["status"]==="on_duty"));')
[ "$ON_DUTY_COUNT" = "1" ] && pass "Exactly 1 Tanod currently on_duty (tanod1)" || fail "on_duty count=$ON_DUTY_COUNT (expected 1)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TANOD1_TOKEN" "${BASE_URL}/duty-status?barangay_id=1")
[ "$CODE" = "403" ] && pass "Tanod requesting ?barangay_id= -> 403" || fail "Tanod ?barangay_id= -> $CODE (expected 403)"

RESP=$(curl -s -H "Authorization: Bearer $TANOD1_TOKEN" "${BASE_URL}/duty-status?user_id=me")
OWN_TOTAL=$(extract "$RESP" total)
[ "$OWN_TOTAL" = "2" ] && pass "Tanod's own ?user_id=me history returns their 2 duty_status rows" || fail "Own duty history total=$OWN_TOTAL (expected 2)"

step "7. GET /gps/live (freshness/staleness)"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/gps/live?barangay_id=1")
TANOD1_STALE=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); foreach($d["items"] as $i){ if($i["user_id"]==4){ echo $i["is_stale"] ? "true":"false"; } }')
TANOD3_STALE=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); foreach($d["items"] as $i){ if($i["user_id"]==6){ echo $i["is_stale"] ? "true":"false"; } }')
ITEM_COUNT=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["items"]);')
[ "$ITEM_COUNT" = "2" ] && pass "gps/live returns 2 items (tanod2 correctly absent — no GPS row yet)" || fail "gps/live item count=$ITEM_COUNT (expected 2)"
[ "$TANOD1_STALE" = "false" ] && pass "tanod1 (10s old) is_stale=false" || fail "tanod1 is_stale=$TANOD1_STALE (expected false)"
[ "$TANOD3_STALE" = "true" ] && pass "tanod3 (5min old) is_stale=true" || fail "tanod3 is_stale=$TANOD3_STALE (expected true)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/gps/live?barangay_id=2")
[ "$CODE" = "404" ] && pass "Cross-tenant barangay_id -> 404" || fail "Cross-tenant barangay_id -> $CODE (expected 404)"

step "8. GET /gps/history"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/gps/history?user_id=4")
HIST_TOTAL=$(extract "$RESP" total)
[ "$HIST_TOTAL" = "1" ] && pass "gps/history for tanod1 returns their 1 track" || fail "gps/history total=$HIST_TOTAL (expected 1)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PB_TOKEN" "${BASE_URL}/gps/history?user_id=4")
[ "$CODE" = "403" ] && pass "Punong Barangay -> 403 on gps/history (Admin only)" || fail "PB gps/history -> $CODE (expected 403)"

step "9. GET /tanod-sos"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/tanod-sos?status=active")
SOS_TOTAL=$(extract "$RESP" total)
[ "$SOS_TOTAL" = "1" ] && pass "1 active SOS visible to Admin" || fail "SOS total=$SOS_TOTAL (expected 1)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TANOD1_TOKEN" "${BASE_URL}/tanod-sos")
[ "$CODE" = "403" ] && pass "Tanod -> 403 on GET /tanod-sos" || fail "Tanod GET /tanod-sos -> $CODE (expected 403)"

step "10. POST /dispatch — validation + idempotency"
REQ_ID="10000000-0000-4000-8000-000000000001"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"incident_id\":${INCIDENT_ID},\"tanod_id\":4,\"request_id\":\"${REQ_ID}\"}" "${BASE_URL}/dispatch")
DISPATCH_ID=$(extract "$RESP" dispatch_id)
ROUTE_STATUS=$(extract "$RESP" route_status)
[ -n "$DISPATCH_ID" ] && [ "$DISPATCH_ID" != "MISSING" ] && pass "Dispatch created (id=$DISPATCH_ID)" || fail "Dispatch creation failed: $RESP"
[ "$ROUTE_STATUS" = "unavailable" ] && pass "route_status=unavailable (no OSRM wired up, as documented)" || fail "route_status=$ROUTE_STATUS (expected unavailable)"

INCIDENT_STATUS=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/incidents?status=dispatched" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["items"]);')
[ "$INCIDENT_STATUS" = "1" ] && pass "Incident correctly moved to dispatched status" || fail "Incidents with status=dispatched count=$INCIDENT_STATUS (expected 1)"

RETRY_RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"incident_id\":${INCIDENT_ID},\"tanod_id\":4,\"request_id\":\"${REQ_ID}\"}" "${BASE_URL}/dispatch")
RETRY_DISPATCH_ID=$(extract "$RETRY_RESP" dispatch_id)
[ "$RETRY_DISPATCH_ID" = "$DISPATCH_ID" ] && pass "Retry with same request_id returns the SAME dispatch (idempotent, no duplicate)" || fail "Retry returned dispatch_id=$RETRY_DISPATCH_ID (expected $DISPATCH_ID)"

DISPATCH_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM \`$VALDB\`.dispatch WHERE incident_id=${INCIDENT_ID};")
[ "$DISPATCH_COUNT" = "1" ] && pass "Exactly 1 dispatch row exists for the incident (no duplicate created)" || fail "dispatch row count=$DISPATCH_COUNT (expected 1)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"incident_id\":${CRITICAL_INCIDENT_ID},\"tanod_id\":5,\"request_id\":\"10000000-0000-4000-8000-000000000002\"}" "${BASE_URL}/dispatch")
[ "$CODE" = "422" ] && pass "Assigning an off-duty Tanod (tanod2) -> 422 UNPROCESSABLE_ENTITY" || fail "Off-duty Tanod assignment -> $CODE (expected 422)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"incident_id\":${INCIDENT_ID},\"tanod_id\":4,\"request_id\":\"10000000-0000-4000-8000-000000000003\"}" "${BASE_URL}/dispatch")
[ "$CODE" = "409" ] && pass "Assigning an already-dispatched incident (new request_id) -> 409 CONFLICT" || fail "Already-dispatched incident -> $CODE (expected 409)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"incident_id\":${CRITICAL_INCIDENT_ID},\"tanod_id\":8,\"request_id\":\"10000000-0000-4000-8000-000000000004\"}" "${BASE_URL}/dispatch")
[ "$CODE" = "422" ] && pass "Assigning a barangay-2 Tanod to a barangay-1 incident -> 422" || fail "Cross-tenant Tanod assignment -> $CODE (expected 422)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $SEC_TOKEN" -H "Content-Type: application/json" \
  -d "{\"incident_id\":${CRITICAL_INCIDENT_ID},\"tanod_id\":4,\"request_id\":\"10000000-0000-4000-8000-000000000005\"}" "${BASE_URL}/dispatch")
[ "$CODE" = "403" ] && pass "Secretary -> 403 on POST /dispatch (Admin only)" || fail "Secretary POST /dispatch -> $CODE (expected 403)"

step "11. GET /dispatch"
RESP=$(curl -s -H "Authorization: Bearer $TANOD1_TOKEN" "${BASE_URL}/dispatch")
TANOD_DISPATCH_TOTAL=$(extract "$RESP" total)
[ "$TANOD_DISPATCH_TOTAL" = "1" ] && pass "Tanod1 sees exactly their own 1 dispatch (forced own tanod_id)" || fail "Tanod1 dispatch total=$TANOD_DISPATCH_TOTAL (expected 1)"

RESP=$(curl -s -H "Authorization: Bearer $ADMIN_B2_TOKEN" "${BASE_URL}/dispatch")
B2_DISPATCH_TOTAL=$(extract "$RESP" total)
[ "$B2_DISPATCH_TOTAL" = "0" ] && pass "Barangay-2 admin sees 0 dispatches (tenant isolation)" || fail "Barangay-2 dispatch total=$B2_DISPATCH_TOTAL (expected 0)"

step "12. PATCH /dispatch/:id/cancel"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH -H "Authorization: Bearer $ADMIN_B2_TOKEN" "${BASE_URL}/dispatch/${DISPATCH_ID}/cancel")
[ "$CODE" = "404" ] && pass "Cross-tenant cancel attempt -> 404" || fail "Cross-tenant cancel -> $CODE (expected 404)"

RESP=$(curl -s -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/dispatch/${DISPATCH_ID}/cancel")
CANCEL_STATUS=$(extract "$RESP" status)
CANCEL_INCIDENT_STATUS=$(extract "$RESP" incident_status)
[ "$CANCEL_STATUS" = "cancelled" ] && pass "Dispatch cancelled successfully" || fail "Cancel response status=$CANCEL_STATUS (expected cancelled): $RESP"
[ "$CANCEL_INCIDENT_STATUS" = "pending" ] && pass "Incident reverted to pending" || fail "Cancel response incident_status=$CANCEL_INCIDENT_STATUS (expected pending)"

PENDING_AFTER_CANCEL=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/incidents?status=pending" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["total"];')
[ "$PENDING_AFTER_CANCEL" = "2" ] && pass "Incident is back in the pending queue (2 pending again in barangay 1)" || fail "Pending total after cancel=$PENDING_AFTER_CANCEL (expected 2)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/dispatch/${DISPATCH_ID}/cancel")
[ "$CODE" = "409" ] && pass "Cancelling an already-cancelled dispatch -> 409 CONFLICT" || fail "Re-cancel -> $CODE (expected 409)"

step "SUMMARY"
echo "$PASS passed, $FAIL failed."
echo "Full log: $LOG_FILE"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
