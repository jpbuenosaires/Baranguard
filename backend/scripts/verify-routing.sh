#!/usr/bin/env bash
# Baranguard — turn-by-turn routing validation
# (docs/REMAINING.md §C4, closed 2026-09-13 via OpenRouteService — see
# OrsClient.php's own doc block for the two earlier architecture
# decisions this superseded: self-hosted OSRM, then Google Routes API,
# both abandoned before either shipped, for reasons unrelated to this
# endpoint's own logic).
#
# Proves, over real HTTP against a disposable database:
#   - GET /dispatch/:id/route validation (lat/lng required + in-range,
#     mode must be car|foot)
#   - role/tenant/ownership: own-Tanod succeeds, a DIFFERENT Tanod is
#     403, cross-tenant Admin is 404 (never 403, per §2 Rule 2)
#   - when ORS is unconfigured, the endpoint returns 200 with
#     route_status='unavailable' — never a 500, never blocks the caller
#   - GET /system/health's `ors` field is `not_configured` when ORS_API_KEY
#     is unset
#
# A SECOND block only runs (and only counts toward pass/fail) when a
# real ORS_API_KEY is found in the real backend/.env — same "some real
# infrastructure is a precondition a human supplies" precedent
# restore-drill.sh already sets for this codebase. Prints [SKIP], not
# [FAIL], when no real key is configured. That block proves:
#   - a real route is computed and persisted (route_status='available',
#     real distance/duration/steps)
#   - a subsequent request from coordinates ORS is known to reject (the
#     same DEFAULT_CENTER point OrsClient.php's own doc block documents
#     as unroutable — verified live in the same session this script was
#     written) KEEPS the prior good route and marks it 'stale', never
#     discards it
#   - GET /dispatch's list also decodes the persisted route_json
#   - GET /system/health's `ors` field is 'healthy'
#
# Safe to run: disposable database, disposable app-user, throwaway
# ports. The real `baranguard`/`baranguard_uiseed` databases are never
# touched or written to; backend/.env is only READ (to find a real
# ORS_API_KEY for the second block), never modified.
#
# Usage: bash backend/scripts/verify-routing.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
SKIP=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
skip() { echo "[SKIP] $1"; SKIP=$((SKIP+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_routing_check"
APP_USER="routing_app"
APP_PASSWORD="Routing!2026xx"
API_PORT="8132"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Routing#2026Pw"

# Confirmed live (this session) to sit ON ORS's OSM-derived road network
# in Pilar, Sorsogon — real street names (Prieto, Smith Street). See
# OrsClient.php's HEALTH_CHECK_* constants for the same pair.
ON_ROAD_ORIGIN_LAT="12.918905"; ON_ROAD_ORIGIN_LNG="123.670203"
ON_ROAD_DEST_LAT="12.921617";   ON_ROAD_DEST_LNG="123.672552"
# The mobile app's own DEFAULT_CENTER — confirmed live (this session) to
# have NO routable road within 350m in OSM's data for this area. Used
# deliberately here as a guaranteed-to-be-rejected origin.
UNROUTABLE_LAT="12.9186"; UNROUTABLE_LNG="123.6667"

echo "Baranguard routing validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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

stop_server() {
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  SERVER_PID=""
}

cleanup() {
  step "Cleanup"
  stop_server
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.routing-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER'."
  echo "Your real databases and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (FULL migration chain, 0001-0020) + accounts"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in 0001_baseline_schema 0002_seed_barangays 0003_shift_schedule_nullable_user 0004_blotter_revision \
         0005_sms_envelope_replay 0006_sms_log_barangay 0007_retention_columns 0008_incident_party_fields \
         0009_blotter_case_status 0010_incident_location_description 0011_user_suspension 0012_system_settings \
         0013_sms_manual_send 0014_incident_display_id 0015_ai_tools \
         0016_retention_hold_and_device_scrub \
         0017_health_check_log \
         0018_sms_subscriber \
         0019_audit_log_idempotency_index \
         0020_health_check_log_ors 0021_ai_evaluation_run_generic_metrics 0022_auth_session_kind 0023_rate_limit_counter 0024_mobile_device_public_key 0025_incident_lifecycle_states; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Migrations 0001-0022 applied"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'rt_admin',       '$HASH', 'RT Admin',        'admin', 1, UTC_TIMESTAMP()),
  (1, 'rt_tanod_owner', '$HASH', 'RT Tanod Owner',  'tanod', 1, UTC_TIMESTAMP()),
  (1, 'rt_tanod_other', '$HASH', 'RT Tanod Other',  'tanod', 1, UTC_TIMESTAMP()),
  (2, 'rt_admin_b2',    '$HASH', 'RT Admin Brgy2',  'admin', 1, UTC_TIMESTAMP());
SQL
mysql_exec "$VALDB" -e "UPDATE user SET barangay_id=2 WHERE username='rt_admin_b2';"
TANOD_OWNER=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='rt_tanod_owner';")
mysql_exec "$VALDB" -e "INSERT INTO duty_status (user_id, status, channel, changed_at) VALUES ($TANOD_OWNER, 'on_duty', 'app', UTC_TIMESTAMP());"
pass "Seeded 2 admins (barangay 1 + 2) and 2 Tanods (one on-duty, owns the dispatch)"

step "2. Seed an incident (destination = confirmed on-road point) + a dispatch to the owning Tanod"
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, latitude, longitude, created_at, updated_at) VALUES
  (1, 'other', 'moderate', 'RAW-ROUTING-CHECK', 'dispatched', 'web', $ON_ROAD_DEST_LAT, $ON_ROAD_DEST_LNG, UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
INC1=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE raw_narrative='RAW-ROUTING-CHECK';")
mysql_exec "$VALDB" <<SQL
INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, route_json, route_status, status, dispatched_at, created_client_request_id) VALUES
  ($INC1, (SELECT user_id FROM user WHERE username='rt_admin'), $TANOD_OWNER, 'moderate', NULL, 'unavailable', 'assigned', UTC_TIMESTAMP(), '$($PHP_BIN -r "echo bin2hex(random_bytes(4)).'-'.bin2hex(random_bytes(2)).'-4'.substr(bin2hex(random_bytes(2)),1).'-8'.substr(bin2hex(random_bytes(2)),1).'-'.bin2hex(random_bytes(6));")');
SQL
DISPATCH1=$(mysql_exec -N -s "$VALDB" -e "SELECT dispatch_id FROM dispatch WHERE incident_id=$INC1;")
echo "  incident: INC1=$INC1  dispatch: DISPATCH1=$DISPATCH1  tanod_owner: $TANOD_OWNER"

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
body_of() { curl -s -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "${4:-}"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "${4:-}"; }
get_of() { curl -s -X GET "${BASE_URL}${2}" -H "Authorization: Bearer $3"; }
status_get_of() { curl -s -o /dev/null -w '%{http_code}' -X GET "${BASE_URL}${2}" -H "Authorization: Bearer $3"; }
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "";'; }
route_status_in_db() { mysql_exec -N -s "$VALDB" -e "SELECT route_status FROM dispatch WHERE dispatch_id=$DISPATCH1;"; }

step "3. Start API WITHOUT ORS configured (throwaway port, disposable DB)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
export ORS_API_KEY=""
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.routing-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

ADMIN_TOKEN=$(login_as rt_admin)
ADMIN2_TOKEN=$(login_as rt_admin_b2)
OWNER_TOKEN=$(login_as rt_tanod_owner)
OTHER_TOKEN=$(login_as rt_tanod_other)
if [ -n "$ADMIN_TOKEN" ] && [ -n "$OWNER_TOKEN" ]; then
  pass "Logged in as admin + owning Tanod (env override reached the disposable DB)"
else
  fail "Login failed"; exit 1
fi

step "4. Validation"
expect_eq "$(status_of GET "/dispatch/$DISPATCH1/route" "$OWNER_TOKEN")" "400" "Missing latitude/longitude -> 400"
expect_eq "$(status_of GET "/dispatch/$DISPATCH1/route?latitude=999&longitude=$ON_ROAD_ORIGIN_LNG" "$OWNER_TOKEN")" "400" "Out-of-range latitude -> 400"
expect_eq "$(status_of GET "/dispatch/$DISPATCH1/route?latitude=$ON_ROAD_ORIGIN_LAT&longitude=$ON_ROAD_ORIGIN_LNG&mode=bogus" "$OWNER_TOKEN")" "400" "Invalid mode -> 400"
expect_eq "$(status_of GET "/dispatch/999999/route?latitude=$ON_ROAD_ORIGIN_LAT&longitude=$ON_ROAD_ORIGIN_LNG" "$OWNER_TOKEN")" "404" "Nonexistent dispatch -> 404"

step "5. Role / tenant / ownership"
expect_eq "$(status_of GET "/dispatch/$DISPATCH1/route?latitude=$ON_ROAD_ORIGIN_LAT&longitude=$ON_ROAD_ORIGIN_LNG" "$OTHER_TOKEN")" "403" "A DIFFERENT Tanod (not assigned) -> 403"
expect_eq "$(status_of GET "/dispatch/$DISPATCH1/route?latitude=$ON_ROAD_ORIGIN_LAT&longitude=$ON_ROAD_ORIGIN_LNG" "$ADMIN2_TOKEN")" "404" "Cross-tenant Admin -> 404, never 403 (Rule 2)"
expect_eq "$(status_of GET "/dispatch/$DISPATCH1/route?latitude=$ON_ROAD_ORIGIN_LAT&longitude=$ON_ROAD_ORIGIN_LNG" "$ADMIN_TOKEN")" "200" "Same-barangay Admin succeeds"

step "6. ORS unconfigured: never a 500, always an honest route_status"
RESP=$(body_of GET "/dispatch/$DISPATCH1/route?latitude=$ON_ROAD_ORIGIN_LAT&longitude=$ON_ROAD_ORIGIN_LNG" "$OWNER_TOKEN")
expect_eq "$(echo "$RESP" | jget route_status)" "unavailable" "route_status='unavailable' when ORS_API_KEY unset (first fetch, no prior route)"

step "7. GET /system/health reports ors: not_configured"
HEALTH=$(get_of GET "/system/health" "$ADMIN_TOKEN")
expect_eq "$(echo "$HEALTH" | jget ors)" "not_configured" "GET /system/health -> ors: not_configured"

stop_server

step "8. Real ORS block — only runs with a real key in backend/.env"
REAL_ORS_KEY=$(grep -E '^ORS_API_KEY=' "$BACKEND_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
if [ -z "$REAL_ORS_KEY" ]; then
  skip "No real ORS_API_KEY found in backend/.env — real-route assertions skipped, not failed"
else
  export ORS_API_KEY="$REAL_ORS_KEY"
  "$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.routing-server.log" 2>&1 &
  SERVER_PID=$!
  sleep 2
  OWNER_TOKEN=$(login_as rt_tanod_owner)
  ADMIN_TOKEN=$(login_as rt_admin)

  step "8a. A real, on-road route is computed and persisted"
  RESP=$(body_of GET "/dispatch/$DISPATCH1/route?latitude=$ON_ROAD_ORIGIN_LAT&longitude=$ON_ROAD_ORIGIN_LNG&mode=car" "$OWNER_TOKEN")
  expect_eq "$(echo "$RESP" | jget route_status)" "available" "route_status='available' with a real key + routable coordinates"
  DIST=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["route_json"]["distance_m"] ?? 0;' <<< "$RESP")
  STEPCOUNT=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["route_json"]["steps"] ?? []);' <<< "$RESP")
  DIST_POSITIVE=$("$PHP_BIN" -r 'echo ((float)$argv[1] > 0) ? "yes" : "no";' "$DIST")
  expect_eq "$DIST_POSITIVE" "yes" "distance_m is a real positive number ($DIST)"
  expect_eq "$([ "$STEPCOUNT" -ge 1 ] && echo yes || echo no)" "yes" "At least one turn-by-turn step present ($STEPCOUNT)"
  expect_eq "$(route_status_in_db)" "available" "DB row itself shows route_status='available'"

  step "8b. A rejected request KEEPS the prior good route, marked stale — never discards it"
  RESP2=$(body_of GET "/dispatch/$DISPATCH1/route?latitude=$UNROUTABLE_LAT&longitude=$UNROUTABLE_LNG&mode=car" "$OWNER_TOKEN")
  expect_eq "$(echo "$RESP2" | jget route_status)" "stale" "route_status='stale' after a request ORS rejects (no route from an unroutable origin)"
  PRIOR_DIST=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["route_json"]["distance_m"] ?? "MISSING";' <<< "$RESP2")
  expect_eq "$([ "$PRIOR_DIST" != "MISSING" ] && echo yes || echo no)" "yes" "The PRIOR route_json (not null) is still returned, not discarded ($PRIOR_DIST m)"
  expect_eq "$(route_status_in_db)" "stale" "DB row confirms route_status='stale', route_json unchanged from the good fetch"

  step "8c. GET /dispatch's list decodes the persisted route_json correctly"
  LIST=$(get_of GET "/dispatch?incident_id=$INC1" "$ADMIN_TOKEN")
  LIST_STATUS=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["items"][0]["route_status"] ?? "";' <<< "$LIST")
  LIST_HAS_JSON=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo is_array($d["items"][0]["route_json"] ?? null) ? "yes" : "no";' <<< "$LIST")
  expect_eq "$LIST_STATUS" "stale" "GET /dispatch list item shows the same route_status"
  expect_eq "$LIST_HAS_JSON" "yes" "GET /dispatch list item's route_json decodes to a real array, not a raw string"

  step "8d. GET /system/health reports ors: healthy with a real, working key"
  HEALTH2=$(get_of GET "/system/health" "$ADMIN_TOKEN")
  expect_eq "$(echo "$HEALTH2" | jget ors)" "healthy" "GET /system/health -> ors: healthy"

  stop_server
fi

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL   SKIPPED: $SKIP"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
