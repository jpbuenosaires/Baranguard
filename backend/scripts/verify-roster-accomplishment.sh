#!/usr/bin/env bash
# Baranguard — roster + approval authority + availability + accomplishment
# report validation (docs/FEATURE_CONTRACT_2026-10.md sections 2, 3, 4, 8;
# migrations 0030 / 0031) against a REAL local XAMPP MariaDB + PHP.
# Safe to run: everything happens in a disposable database
# (baranguard_roster_check) with a disposable app user, disposable test
# accounts and a PHP dev server on a throwaway port (8602). The real
# `baranguard` / `baranguard_uiseed` databases, the real backend/.env and
# Apache are never touched.
#
# Migration order matters here on purpose: the chain up to 0029 is applied
# first, legacy users + a legacy shift are seeded, and ONLY THEN 0030+ is
# applied, so the documented backfills (authority for Punong Barangay/Admin
# accounts, existing shifts -> published) are exercised for real.
#
# Usage (Git Bash, repo root or anywhere):
#   bash backend/scripts/verify-roster-accomplishment.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
LOG_FILE="$BACKEND_DIR/scripts/roster-accomplishment-validation-$(date -u +%Y%m%dT%H%M%SZ).log"

exec > >(tee "$LOG_FILE") 2>&1

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_roster_check"
APP_USER="roster_check_app"
APP_PASSWORD="RosterCheckDbPw!2026"
API_PORT="8602"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="RosterCheck#2026Pw"

echo "Baranguard roster / authority / availability / accomplishment validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
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
db_one() { mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null | tr -d '\r'; }

TMP_DIR="$(mktemp -d)"
TMP_W="$(cygpath -m "$TMP_DIR")"
cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$TMP_DIR"
  echo "Stopped the test PHP server, dropped $VALDB and user '$APP_USER'."
  echo "Your real databases and backend/.env were never touched."
}
trap cleanup EXIT

# ---------------------------------------------------------------- helpers
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }
# Manila calendar date for a relative expression ("today", "+5 days", "-3 days").
dman() { "$PHP_BIN" -r 'date_default_timezone_set("Asia/Manila"); echo date("Y-m-d", strtotime($argv[1]));' -- "$1"; }
# UTC "Y-m-d H:i:s" for a Manila date + time.
mu() { "$PHP_BIN" -r '$d=new DateTime($argv[1]." ".$argv[2]." +08:00"); $d->setTimezone(new DateTimeZone("UTC")); echo $d->format("Y-m-d H:i:s");' "$1" "$2"; }
jget() {
  printf '%s' "$1" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach(explode(".",$argv[1]) as $k){ if(is_array($d)&&array_key_exists($k,$d)){$d=$d[$k];}else{$d=null;break;} } if(is_bool($d)){echo $d?"true":"false";}elseif($d===null){echo "null";}elseif(is_array($d)){echo json_encode($d);}else{echo $d;}' "$2"
}

# api METHOD PATH TOKEN BODY [extra curl args...]  -> sets CODE and BODY
api() {
  local method="$1" path="$2" token="$3" body="$4"
  shift 4
  local args=(-s -w $'\n%{http_code}' -X "$method" "${BASE_URL}${path}" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  RESP=$(curl "${args[@]}" "$@")
  CODE=$(printf '%s' "$RESP" | tail -n 1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
}
expect_code() { # label expected
  [ "$CODE" = "$2" ] && pass "$1 -> $2" || fail "$1 -> $CODE (expected $2): ${BODY:0:240}"
}
expect_eq() { # label actual expected
  [ "$2" = "$3" ] && pass "$1 (= $3)" || fail "$1: got '$2', expected '$3'"
}
login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}

# ---------------------------------------------------------------- 0
step "0. Connectivity + disposable schema (chain <= 0029, seed legacy rows, THEN 0030+)"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
ALL_MIGRATIONS=$(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort)
for m in $ALL_MIGRATIONS; do
  if [[ "$m" < "0030" ]]; then
    mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
  fi
done
pass "Migrations 0001-0029 applied (globbed)"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'rc_admin',  '$HASH', 'RC Admin',        'admin',           1, UTC_TIMESTAMP()),
  (1, 'rc_pb',     '$HASH', 'RC Punong',       'punong_barangay', 1, UTC_TIMESTAMP()),
  (1, 'rc_sec',    '$HASH', 'RC Secretary',    'secretary',       1, UTC_TIMESTAMP()),
  (1, 'rc_sec2',   '$HASH', 'RC Secretary Two','secretary',       1, UTC_TIMESTAMP()),
  (1, 'rc_t1',     '$HASH', 'RC Tanod One',    'tanod',           1, UTC_TIMESTAMP()),
  (1, 'rc_t2',     '$HASH', 'RC Tanod Two',    'tanod',           1, UTC_TIMESTAMP()),
  (1, 'rc_t3',     '$HASH', 'RC Tanod Three',  'tanod',           1, UTC_TIMESTAMP()),
  (1, 'rc_t4',     '$HASH', 'RC Tanod Four',   'tanod',           1, UTC_TIMESTAMP()),
  (2, 'rc_admin2', '$HASH', 'RC Admin B2',     'admin',           1, UTC_TIMESTAMP()),
  (2, 'rc_t_b2',   '$HASH', 'RC Tanod B2',     'tanod',           1, UTC_TIMESTAMP());
SQL
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
ADMIN_ID=$(uid rc_admin); PB_ID=$(uid rc_pb); SEC_ID=$(uid rc_sec); SEC2_ID=$(uid rc_sec2)
T1_ID=$(uid rc_t1); T2_ID=$(uid rc_t2); T3_ID=$(uid rc_t3); T4_ID=$(uid rc_t4)
ADMIN2_ID=$(uid rc_admin2); TB2_ID=$(uid rc_t_b2)
LEGACY_START=$(mu "$(dman '+10 days')" "08:00"); LEGACY_END=$(mu "$(dman '+10 days')" "16:00")
mysql_exec "$VALDB" -e "INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, client_request_id) VALUES (1, $T1_ID, 'Legacy', '$LEGACY_START', '$LEGACY_END', $ADMIN_ID, 'legacy-shift-0000000000000000000000000');"
LEGACY_SHIFT_ID=$(db_one "SELECT shift_id FROM shift_schedule WHERE client_request_id LIKE 'legacy-shift%';")
[ -n "$LEGACY_SHIFT_ID" ] && pass "Seeded 10 pre-0030 users + 1 legacy shift (#$LEGACY_SHIFT_ID)" || fail "Legacy seed failed"

for m in $ALL_MIGRATIONS; do
  if [[ ! "$m" < "0030" ]]; then
    mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 && pass "migration $m applied" || fail "migration $m failed"
  fi
done

# Down migrations round-trip on a scratch copy of the schema (0031 then 0030).
RT_DB="${VALDB}_rt"
mysql_exec -e "DROP DATABASE IF EXISTS \`$RT_DB\`; CREATE DATABASE \`$RT_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $ALL_MIGRATIONS; do
  if [[ "$m" < "0032" ]]; then mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1; fi
done
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0031_accomplishment_reports.down.sql" >/dev/null 2>&1 && pass "0031 .down.sql applies cleanly" || fail "0031 .down.sql failed"
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0030_approval_authority_and_roster.down.sql" >/dev/null 2>&1 && pass "0030 .down.sql applies cleanly" || fail "0030 .down.sql failed"
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0030_approval_authority_and_roster.sql" >/dev/null 2>&1 && mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0031_accomplishment_reports.sql" >/dev/null 2>&1 && pass "0030/0031 re-apply after rollback" || fail "0030/0031 re-apply failed"
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0030_approval_authority_and_roster.sql" >/dev/null 2>&1 && mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0031_accomplishment_reports.sql" >/dev/null 2>&1 && pass "0030/0031 are idempotent (applied twice)" || fail "0030/0031 second apply failed"
mysql_exec -e "DROP DATABASE IF EXISTS \`$RT_DB\`;" >/dev/null 2>&1

step "1. Backfill evidence (migration 0030 on pre-existing rows)"
expect_eq "Punong Barangay official_title backfilled" "$(db_one "SELECT official_title FROM user WHERE user_id=$PB_ID;")" "Punong Barangay"
expect_eq "Punong Barangay authority backfilled" "$(db_one "SELECT approval_authority FROM user WHERE user_id=$PB_ID;")" "note_report,approve_report,approve_roster,approve_annex_d"
expect_eq "Admin official_title backfilled" "$(db_one "SELECT official_title FROM user WHERE user_id=$ADMIN_ID;")" "Chief Tanod"
expect_eq "Admin authority backfilled" "$(db_one "SELECT approval_authority FROM user WHERE user_id=$ADMIN_ID;")" "note_report,prepare_annex_d"
expect_eq "Secretary NOT backfilled" "$(db_one "SELECT CONCAT(IFNULL(official_title,'NULL'),'|',approval_authority) FROM user WHERE user_id=$SEC_ID;")" "NULL|"
expect_eq "Tanod NOT backfilled" "$(db_one "SELECT CONCAT(IFNULL(official_title,'NULL'),'|',approval_authority) FROM user WHERE user_id=$T1_ID;")" "NULL|"
expect_eq "Pre-existing legacy shift backfilled to 'published'" "$(db_one "SELECT approval_status FROM shift_schedule WHERE shift_id=$LEGACY_SHIFT_ID;")" "published"
expect_eq "Column default for NEW shifts is 'draft'" "$(db_one "SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='shift_schedule' AND COLUMN_NAME='approval_status';")" "'draft'"
expect_eq "offline_queue.payload_type knows the four new sync kinds" "$(db_one "SELECT COLUMN_TYPE LIKE '%accomplishment_entry%' AND COLUMN_TYPE LIKE '%availability%' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='offline_queue' AND COLUMN_NAME='payload_type';")" "1"

step "2. Start the API (PHP built-in server on port $API_PORT)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN='*'
(cd "$BACKEND_DIR/public" && "$PHP_BIN" -S "127.0.0.1:${API_PORT}" >"$BACKEND_DIR/scripts/.roster-server.log" 2>&1) &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null "${BASE_URL}/auth/login" -X POST -d '{}' && pass "PHP dev server responding on port $API_PORT" || { fail "PHP dev server did not start"; exit 1; }

ADMIN_T=$(login_as rc_admin); PB_T=$(login_as rc_pb); SEC_T=$(login_as rc_sec); SEC2_T=$(login_as rc_sec2)
T1_T=$(login_as rc_t1); T2_T=$(login_as rc_t2); T3_T=$(login_as rc_t3); T4_T=$(login_as rc_t4)
ADMIN2_T=$(login_as rc_admin2); TB2_T=$(login_as rc_t_b2)
[ -n "$ADMIN_T" ] && [ -n "$PB_T" ] && [ -n "$SEC_T" ] && [ -n "$T1_T" ] && [ -n "$ADMIN2_T" ] && [ -n "$TB2_T" ] && pass "Logged in as every test account" || fail "One or more logins failed"

for pair in "dev-rc-t1:$T1_ID" "dev-rc-t2:$T2_ID" "dev-rc-t3:$T3_ID" "dev-rc-t4:$T4_ID" "dev-rc-tb2:$TB2_ID"; do
  mysql_exec "$VALDB" -e "INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES ('${pair%%:*}', ${pair##*:}, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());"
done
D_T1="X-Device-Id: dev-rc-t1"; D_T2="X-Device-Id: dev-rc-t2"; D_T3="X-Device-Id: dev-rc-t3"; D_T4="X-Device-Id: dev-rc-t4"; D_TB2="X-Device-Id: dev-rc-tb2"

# ================================================================ users
step "3. GET /users, GET /users/:id, PATCH /users/:id authority (contract section 2)"
api GET "/users?limit=100" "$ADMIN_T" ""
expect_code "Admin GET /users" 200
expect_eq "GET /users returns approval_authority as an array (PB)" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $u){ if($u["username"]==="rc_pb"){ echo json_encode($u["approval_authority"]); } }')" '["note_report","approve_report","approve_roster","approve_annex_d"]'
expect_eq "GET /users returns official_title (PB)" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $u){ if($u["username"]==="rc_pb"){ echo $u["official_title"]; } }')" "Punong Barangay"
expect_eq "GET /users: a tanod has an empty authority array" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $u){ if($u["username"]==="rc_t1"){ echo json_encode($u["approval_authority"]); } }')" "[]"

api GET "/users/$SEC_ID" "$SEC_T" ""
expect_code "Secretary GET own /users/:id" 200
expect_eq "  own row: empty authority array" "$(jget "$BODY" approval_authority)" "[]"
api GET "/users/$T1_ID" "$T1_T" ""
expect_code "Tanod GET own /users/:id" 200
api GET "/users/$SEC_ID" "$T1_T" ""
expect_code "Tanod GET someone else's /users/:id" 404
api GET "/users/$PB_ID" "$SEC_T" ""
expect_code "Secretary GET another user's /users/:id (admin-only)" 404
api GET "/users/$T1_ID" "$ADMIN_T" ""
expect_code "Admin GET a same-barangay user" 200
api GET "/users/$TB2_ID" "$ADMIN_T" ""
expect_code "Admin GET a barangay-2 user (cross-tenant)" 404
api GET "/users/999999" "$ADMIN_T" ""
expect_code "Admin GET a nonexistent user" 404

AUTH_KEY=$(uuid)
api PATCH "/users/$SEC2_ID" "$ADMIN_T" '{"official_title":"Kagawad","approval_authority":["note_report","approve_report","approve_roster"]}' -H "Idempotency-Key: $AUTH_KEY"
expect_code "Admin PATCH authority + title on a secretary" 200
expect_eq "  DB approval_authority (canonical SET order)" "$(db_one "SELECT approval_authority FROM user WHERE user_id=$SEC2_ID;")" "note_report,approve_report,approve_roster"
expect_eq "  DB official_title" "$(db_one "SELECT official_title FROM user WHERE user_id=$SEC2_ID;")" "Kagawad"
api GET "/users/$SEC2_ID" "$SEC2_T" ""
expect_eq "  GET /users/:id (self) shows the new authority array" "$(jget "$BODY" approval_authority)" '["note_report","approve_report","approve_roster"]'
api PATCH "/users/$SEC2_ID" "$ADMIN_T" '{"official_title":"Kagawad","approval_authority":["note_report","approve_report","approve_roster"]}' -H "Idempotency-Key: $AUTH_KEY"
expect_code "Same Idempotency-Key replay" 200
expect_eq "  audit rows for that key: still exactly one" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='user_approval_authority_changed' AND entity_id=$SEC2_ID;")" "1"
expect_eq "  audit metadata is {target_user_id,count,approval_authority,idempotency_key} - enum values only, no title text" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='user_approval_authority_changed' LIMIT 1;")" '["target_user_id", "count", "approval_authority", "idempotency_key"]'
expect_eq "  audit metadata records the NEW authority list (closed enum, Rule 8 safe)" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.approval_authority') FROM audit_log WHERE action='user_approval_authority_changed' LIMIT 1;")" '["note_report", "approve_report", "approve_roster"]'
expect_eq "  audit count = number of authorities" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.count') FROM audit_log WHERE action='user_approval_authority_changed' LIMIT 1;")" "3"

api PATCH "/users/$SEC_ID" "$SEC_T" '{"approval_authority":["note_report"]}'
expect_code "Secretary PATCH authority (Admin only)" 403
api PATCH "/users/$T1_ID" "$T1_T" '{"approval_authority":["note_report"]}'
expect_code "Tanod PATCH authority" 403
api PATCH "/users/$SEC_ID" "$ADMIN_T" '{"approval_authority":["note_report","not_a_real_authority"]}'
expect_code "Invalid authority value" 400
api PATCH "/users/$SEC_ID" "$ADMIN_T" '{"approval_authority":"note_report"}'
expect_code "approval_authority not an array" 400
api PATCH "/users/$T1_ID" "$ADMIN_T" '{"approval_authority":["note_report"]}'
expect_code "Authority on a tanod (ineligible role)" 400
api PATCH "/users/$T1_ID" "$ADMIN_T" '{"official_title":"Chief"}'
expect_code "Official title on a tanod (ineligible role)" 400
api PATCH "/users/$SEC_ID" "$ADMIN_T" "{\"official_title\":\"$(printf 'x%.0s' $(seq 1 65))\"}"
expect_code "official_title longer than 64" 400
api PATCH "/users/$TB2_ID" "$ADMIN_T" '{"approval_authority":[]}'
expect_code "PATCH authority on a barangay-2 user (cross-tenant)" 404
api PATCH "/users/$SEC_ID" "$ADMIN_T" '{"approval_authority":["note_report"],"is_active":true}'
expect_code "Authority mixed with is_active" 400
api PATCH "/users/$SEC_ID" "$ADMIN_T" '{"approval_authority":[]}' -H "Idempotency-Key: not-a-uuid"
expect_code "Malformed Idempotency-Key" 400
api PATCH "/users/$T3_ID" "$ADMIN_T" '{"is_active":true}'
expect_code "Existing is_active path still works" 200
api PATCH "/users/$SEC2_ID" "$ADMIN_T" '{"official_title":null}'
expect_code "official_title: null clears the title" 200
expect_eq "  DB official_title cleared" "$(db_one "SELECT IFNULL(official_title,'NULL') FROM user WHERE user_id=$SEC2_ID;")" "NULL"
api PATCH "/users/$ADMIN_ID" "$ADMIN_T" '{"official_title":"Chief Tanod"}'
expect_code "Admin may edit their own title" 200
api PATCH "/users/$ADMIN_ID" "$ADMIN_T" '{"approval_authority":["note_report","prepare_annex_d","approve_roster"]}'
expect_code "Admin grants THEMSELVES approve_roster (segregation of duties)" 403
expect_eq "  authority unchanged in the DB" "$(db_one "SELECT approval_authority FROM user WHERE user_id=$ADMIN_ID;")" "note_report,prepare_annex_d"
api PATCH "/users/$ADMIN_ID" "$ADMIN_T" '{"approval_authority":["note_report","prepare_annex_d","approve_report"]}'
expect_code "Admin grants THEMSELVES approve_report" 403
api PATCH "/users/$ADMIN_ID" "$ADMIN_T" '{"approval_authority":["note_report","prepare_annex_d","approve_annex_d"]}'
expect_code "Admin grants THEMSELVES approve_annex_d" 403
api PATCH "/users/$ADMIN_ID" "$ADMIN_T" '{"approval_authority":["prepare_annex_d","note_report"]}'
expect_code "Admin re-submits their own list with NO approving change (non-approving authorities stay editable)" 200

# ================================================================ availability
step "4. Availability — POST /availability, GET /availability, PATCH /availability/:id"
P_START=$(dman "+15 days"); P_END=$(dman "+21 days"); P_MID=$(dman "+17 days")
AV_EVT=$(uuid)
AV_BODY="{\"period_start\":\"$P_START\",\"period_end\":\"$P_END\",\"windows\":[{\"date\":\"$P_MID\",\"start\":\"08:00\",\"end\":\"16:00\"},{\"date\":\"$P_END\",\"start\":\"20:00\",\"end\":\"23:30\"}],\"client_event_id\":\"$AV_EVT\"}"
api POST "/availability" "$T1_T" "$AV_BODY"
expect_code "POST /availability without X-Device-Id" 400
api POST "/availability" "$T1_T" "$AV_BODY" -H "X-Device-Id: not-registered"
expect_code "POST /availability with an unregistered device" 422
api POST "/availability" "$T1_T" "$AV_BODY" -H "$D_T2"
expect_code "POST /availability with ANOTHER tanod's device" 422
api POST "/availability" "$ADMIN_T" "$AV_BODY" -H "$D_T1"
expect_code "Admin POST /availability (tanod only)" 403
api POST "/availability" "$T1_T" "{\"period_start\":\"$P_START\",\"period_end\":\"$P_END\",\"windows\":[],\"client_event_id\":\"$(uuid)\"}" -H "$D_T1"
expect_code "Empty windows" 400
api POST "/availability" "$T1_T" "{\"period_start\":\"$P_END\",\"period_end\":\"$P_START\",\"windows\":[{\"date\":\"$P_MID\",\"start\":\"08:00\",\"end\":\"09:00\"}],\"client_event_id\":\"$(uuid)\"}" -H "$D_T1"
expect_code "period_end before period_start" 400
api POST "/availability" "$T1_T" "{\"period_start\":\"$P_START\",\"period_end\":\"$P_END\",\"windows\":[{\"date\":\"$(dman '+40 days')\",\"start\":\"08:00\",\"end\":\"09:00\"}],\"client_event_id\":\"$(uuid)\"}" -H "$D_T1"
expect_code "Window date outside the period" 400
api POST "/availability" "$T1_T" "{\"period_start\":\"$P_START\",\"period_end\":\"$P_END\",\"windows\":[{\"date\":\"$P_MID\",\"start\":\"16:00\",\"end\":\"08:00\"}],\"client_event_id\":\"$(uuid)\"}" -H "$D_T1"
expect_code "Window end before start" 400
api POST "/availability" "$T1_T" "{\"period_start\":\"$P_START\",\"period_end\":\"$P_END\",\"windows\":[{\"date\":\"$P_MID\",\"start\":\"8am\",\"end\":\"9am\"}],\"client_event_id\":\"$(uuid)\"}" -H "$D_T1"
expect_code "Malformed HH:MM" 400
MANY=$("$PHP_BIN" -r '$w=[]; for($i=0;$i<63;$i++){$w[]=["date"=>$argv[1],"start"=>"08:00","end"=>"09:00"];} echo json_encode($w);' "$P_MID")
api POST "/availability" "$T1_T" "{\"period_start\":\"$P_START\",\"period_end\":\"$P_END\",\"windows\":$MANY,\"client_event_id\":\"$(uuid)\"}" -H "$D_T1"
expect_code "63 windows (max 62)" 400
api POST "/availability" "$T1_T" "{\"period_start\":\"$P_START\",\"period_end\":\"$P_END\",\"windows\":[{\"date\":\"$P_MID\",\"start\":\"08:00\",\"end\":\"09:00\"}],\"client_event_id\":\"nope\"}" -H "$D_T1"
expect_code "client_event_id not a UUID" 400

api POST "/availability" "$T1_T" "$AV_BODY" -H "$D_T1"
expect_code "T1 POST /availability" 201
AV1_ID=$(jget "$BODY" avail_id)
expect_eq "  status submitted, version 1" "$(jget "$BODY" status)/$(jget "$BODY" version)" "submitted/1"
api POST "/availability" "$T1_T" "$AV_BODY" -H "$D_T1"
expect_code "Replay of the same client_event_id" 200
expect_eq "  same avail_id returned" "$(jget "$BODY" avail_id)" "$AV1_ID"
expect_eq "  exactly one DB row for that event" "$(db_one "SELECT COUNT(*) FROM tanod_availability WHERE client_event_id='$AV_EVT';")" "1"
AV_BODY2="{\"period_start\":\"$P_START\",\"period_end\":\"$P_END\",\"windows\":[{\"date\":\"$P_MID\",\"start\":\"09:00\",\"end\":\"15:00\"}],\"client_event_id\":\"$(uuid)\"}"
api POST "/availability" "$T1_T" "$AV_BODY2" -H "$D_T1"
expect_code "Same period, changed windows while submitted" 200
expect_eq "  same row, version 2" "$(jget "$BODY" avail_id)/$(jget "$BODY" version)" "$AV1_ID/2"
expect_eq "  windows replaced" "$(jget "$BODY" windows)" "[{\"date\":\"$P_MID\",\"start\":\"09:00\",\"end\":\"15:00\"}]"
AV_BODY3=$(printf '%s' "$AV_BODY2" | sed "s/\"client_event_id\":\"[^\"]*\"/\"client_event_id\":\"$(uuid)\"/")
api POST "/availability" "$T1_T" "$AV_BODY3" -H "$D_T1"
expect_code "Same period, SAME windows, new event id" 200
expect_eq "  no extra version bump" "$(jget "$BODY" version)" "2"
expect_eq "  still one row for the period" "$(db_one "SELECT COUNT(*) FROM tanod_availability WHERE user_id=$T1_ID;")" "1"

api GET "/availability" "$T1_T" ""
expect_code "Tanod GET /availability" 200
expect_eq "  tanod sees own 1 row" "$(jget "$BODY" total)" "1"
api GET "/availability" "$T2_T" ""
expect_eq "Other tanod sees 0 rows (own only)" "$(jget "$BODY" total)" "0"
api GET "/availability?user_id=$T1_ID" "$T2_T" ""
expect_code "Tanod GET /availability?user_id=<other tanod>" 404
api GET "/availability?status=submitted" "$ADMIN_T" ""
expect_eq "Admin GET ?status=submitted" "$(jget "$BODY" total)" "1"
api GET "/availability?user_id=$T1_ID&period_start=$P_START" "$SEC_T" ""
expect_eq "Secretary GET filtered by user_id+period_start" "$(jget "$BODY" total)" "1"
api GET "/availability" "$PB_T" ""
expect_code "Punong Barangay GET /availability" 200
api GET "/availability" "$ADMIN2_T" ""
expect_eq "Barangay-2 admin sees 0 (tenant isolation)" "$(jget "$BODY" total)" "0"
api GET "/availability?status=bogus" "$ADMIN_T" ""
expect_code "Bad status filter" 400

AV_REV_KEY=$(uuid)
api PATCH "/availability/$AV1_ID" "$T1_T" '{"status":"accepted"}' -H "Idempotency-Key: $AV_REV_KEY"
expect_code "Tanod PATCH /availability/:id" 403
api PATCH "/availability/$AV1_ID" "$PB_T" '{"status":"accepted"}' -H "Idempotency-Key: $AV_REV_KEY"
expect_code "Punong Barangay PATCH /availability/:id (admin or secretary only)" 403
api PATCH "/availability/$AV1_ID" "$ADMIN_T" '{"status":"accepted"}'
expect_code "PATCH without Idempotency-Key" 400
api PATCH "/availability/$AV1_ID" "$ADMIN_T" '{"status":"submitted"}' -H "Idempotency-Key: $AV_REV_KEY"
expect_code "PATCH with an invalid status value" 400
api PATCH "/availability/$AV1_ID" "$ADMIN2_T" '{"status":"accepted"}' -H "Idempotency-Key: $AV_REV_KEY"
expect_code "Barangay-2 admin PATCH (cross-tenant)" 404
api PATCH "/availability/999999" "$ADMIN_T" '{"status":"accepted"}' -H "Idempotency-Key: $AV_REV_KEY"
expect_code "PATCH a nonexistent availability" 404
api PATCH "/availability/$AV1_ID" "$ADMIN_T" '{"status":"accepted","review_note":"ok"}' -H "Idempotency-Key: $AV_REV_KEY"
expect_code "Admin accepts" 200
expect_eq "  status/reviewed_by" "$(jget "$BODY" status)/$(jget "$BODY" reviewed_by)" "accepted/$ADMIN_ID"
api PATCH "/availability/$AV1_ID" "$ADMIN_T" '{"status":"accepted","review_note":"ok"}' -H "Idempotency-Key: $AV_REV_KEY"
expect_code "Replay of the review (same key)" 200
expect_eq "  exactly one review audit row" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='availability_reviewed' AND entity_id=$AV1_ID;")" "1"
api PATCH "/availability/$AV1_ID" "$ADMIN_T" '{"status":"revised"}' -H "Idempotency-Key: $(uuid)"
expect_code "Reviewing an already-accepted row (new key)" 409
api POST "/availability" "$T1_T" "$AV_BODY3" -H "$D_T1"
expect_code "Replay of the accepted period's event id stays idempotent" 200
api POST "/availability" "$T1_T" "$(printf '%s' "$AV_BODY" | sed "s/\"client_event_id\":\"[^\"]*\"/\"client_event_id\":\"$(uuid)\"/")" -H "$D_T1"
expect_code "Changing an ACCEPTED period" 409

# revised -> resubmit flow (T2, secretary reviews)
P2_START=$(dman "+30 days"); P2_END=$(dman "+36 days")
AV2_BODY="{\"period_start\":\"$P2_START\",\"period_end\":\"$P2_END\",\"windows\":[{\"date\":\"$P2_START\",\"start\":\"06:00\",\"end\":\"12:00\"}],\"client_event_id\":\"$(uuid)\"}"
api POST "/availability" "$T2_T" "$AV2_BODY" -H "$D_T2"
AV2_ID=$(jget "$BODY" avail_id)
api PATCH "/availability/$AV2_ID" "$SEC_T" '{"status":"revised","review_note":"please add weekends"}' -H "Idempotency-Key: $(uuid)"
expect_code "Secretary marks T2's availability 'revised'" 200
expect_eq "  review_note stored" "$(jget "$BODY" review_note)" "please add weekends"
AV2_BODY_B=$(printf '%s' "$AV2_BODY" | sed "s/\"client_event_id\":\"[^\"]*\"/\"client_event_id\":\"$(uuid)\"/; s/06:00/05:00/")
api POST "/availability" "$T2_T" "$AV2_BODY_B" -H "$D_T2"
expect_code "T2 resubmits a 'revised' period" 200
expect_eq "  back to submitted, version 3, review cleared" "$(jget "$BODY" status)/$(jget "$BODY" version)/$(jget "$BODY" reviewed_by)" "submitted/3/null"

# ================================================================ device signature
step "5. Device signature convention on availability writes (H-09)"
OPENSSL_BIN="$(command -v openssl || true)"
[ -z "$OPENSSL_BIN" ] && { fail "openssl CLI not found"; }
"$OPENSSL_BIN" ecparam -name prime256v1 -genkey -noout -out "$TMP_DIR/t4.key" 2>/dev/null
"$OPENSSL_BIN" ec -in "$TMP_DIR/t4.key" -pubout -out "$TMP_DIR/t4.pub" 2>/dev/null
"$PHP_BIN" -r 'echo bin2hex(file_get_contents($argv[1]));' "$TMP_W/t4.pub" > "$TMP_DIR/t4.pubhex"
mysql_exec "$VALDB" -e "UPDATE mobile_device SET device_public_key_pem = CONVERT(UNHEX('$(cat "$TMP_DIR/t4.pubhex")') USING utf8mb4) WHERE device_id='dev-rc-t4';"
P4_START=$(dman "+40 days")
SIG_BODY="{\"period_start\":\"$P4_START\",\"period_end\":\"$P4_START\",\"windows\":[{\"date\":\"$P4_START\",\"start\":\"08:00\",\"end\":\"10:00\"}],\"client_event_id\":\"$(uuid)\"}"
api POST "/availability" "$T4_T" "$SIG_BODY" -H "$D_T4"
expect_code "Device WITH a registered key but NO signature" 401
TS=$(date +%s)
SIG=$(printf 'POST
/api/v1/availability
dev-rc-t4
%s' "$TS" | "$OPENSSL_BIN" dgst -sha256 -sign "$TMP_DIR/t4.key" | base64 -w0)
api POST "/availability" "$T4_T" "$SIG_BODY" -H "$D_T4" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $SIG"
expect_code "Same request with a valid signature" 201

# ================================================================ shifts
step "6. Shifts — draft/published, tanod visibility, 12h/day cap (contract sections 3 and 8)"
D1=$(dman "+20 days"); D2=$(dman "+21 days"); D3=$(dman "+22 days"); D5=$(dman "+25 days")
mkshift() { # token user_id date start end [source_availability_id] -> api result
  local src=""; [ -n "${6:-}" ] && src=",\"source_availability_id\":$6"
  api POST "/shifts" "$1" "{\"user_id\":$2,\"patrol_zone\":\"Zone R\",\"start_at\":\"$3T$4:00+08:00\",\"end_at\":\"${7:-$3}T$5:00+08:00\",\"request_id\":\"$(uuid)\"$src}"
}
mkshift "$ADMIN_T" "$T1_ID" "$D1" "08:00" "16:00" "$AV1_ID"
expect_code "Admin POST /shifts (with source_availability_id)" 201
S1_ID=$(jget "$BODY" shift_id)
expect_eq "  new shift is a draft" "$(jget "$BODY" approval_status)" "draft"
expect_eq "  source_availability_id echoed" "$(jget "$BODY" source_availability_id)" "$AV1_ID"
expect_eq "  DB row is a draft with no approver" "$(db_one "SELECT CONCAT(approval_status,'|',IFNULL(approved_by,'NULL')) FROM shift_schedule WHERE shift_id=$S1_ID;")" "draft|NULL"
mkshift "$ADMIN_T" "$T2_ID" "$D3" "10:00" "11:00" "$AV1_ID"
expect_code "source_availability_id belonging to ANOTHER tanod" 422
mkshift "$ADMIN_T" "$T1_ID" "$D3" "10:00" "11:00" "999999"
expect_code "source_availability_id that does not exist" 422
mkshift "$ADMIN_T" "$T1_ID" "$D3" "08:00" "16:00"
expect_code "T1 second shift on D3" 201
S2_ID=$(jget "$BODY" shift_id)
IDEM_REQ=$(uuid)
api POST "/shifts" "$ADMIN_T" "{\"user_id\":$T3_ID,\"start_at\":\"${D5}T01:00:00+08:00\",\"end_at\":\"${D5}T02:00:00+08:00\",\"request_id\":\"$IDEM_REQ\"}"
S_UN_ID=$(jget "$BODY" shift_id)
api POST "/shifts" "$ADMIN_T" "{\"user_id\":$T3_ID,\"start_at\":\"${D5}T01:00:00+08:00\",\"end_at\":\"${D5}T02:00:00+08:00\",\"request_id\":\"$IDEM_REQ\"}"
expect_code "POST /shifts replay of request_id" 200
expect_eq "  replay returns the same shift incl. approval_status" "$(jget "$BODY" shift_id)/$(jget "$BODY" approval_status)" "$S_UN_ID/draft"
api PATCH "/shifts/$S_UN_ID" "$ADMIN_T" '{"user_id":null,"version":1}'
expect_code "Unassigning the ONLY shift in that window is no longer blocked (old H-17 -> 200)" 200
expect_eq "  user_id is NULL" "$(db_one "SELECT IFNULL(user_id,'NULL') FROM shift_schedule WHERE shift_id=$S_UN_ID;")" "NULL"

# overlap still enforced
mkshift "$ADMIN_T" "$T1_ID" "$D1" "12:00" "13:00"
expect_code "Overlapping shift for the same tanod still rejected" 409

# visibility
api GET "/shifts?limit=100" "$T1_T" ""
expect_code "Tanod GET /shifts" 200
expect_eq "  tanod sees ONLY published own shifts (legacy only, drafts hidden)" "$(jget "$BODY" total)" "1"
expect_eq "  ...and it is the legacy one" "$(jget "$BODY" items.0.shift_id)" "$LEGACY_SHIFT_ID"
api GET "/shifts?limit=100&approval_status=draft" "$ADMIN_T" ""
expect_eq "Admin ?approval_status=draft sees the 3 drafts" "$(jget "$BODY" total)" "3"
api GET "/shifts?limit=100&approval_status=published" "$ADMIN_T" ""
expect_eq "Admin ?approval_status=published sees the legacy shift" "$(jget "$BODY" total)" "1"
api GET "/shifts?approval_status=weird" "$ADMIN_T" ""
expect_code "Bad approval_status filter" 400
api GET "/shifts?limit=100" "$PB_T" ""
expect_code "Punong Barangay GET /shifts" 200
expect_eq "  PB sees all 4" "$(jget "$BODY" total)" "4"
api GET "/shifts?limit=100" "$SEC_T" ""
expect_code "Secretary GET /shifts" 200
expect_eq "  every row carries approval_status/approved_by/approved_at/source_availability_id" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $ok=true; foreach($d["items"] as $r){ foreach(["approval_status","approved_by","approved_at","source_availability_id"] as $k){ if(!array_key_exists($k,$r)){$ok=false;} } } echo $ok?"yes":"no";')" "yes"

# 12h/day cap
D6=$(dman "+26 days"); D7=$(dman "+27 days"); D8=$(dman "+28 days"); D9=$(dman "+29 days")
mkshift "$ADMIN_T" "$T2_ID" "$D6" "06:00" "15:00"
expect_code "T2 9h shift on D6" 201
mkshift "$ADMIN_T" "$T2_ID" "$D6" "21:00" "03:00" "" "$D7"
expect_code "T2 21:00-03:00 -> D6 total 9h+3h = 12h exactly (cap is inclusive)" 201
mkshift "$ADMIN_T" "$T2_ID" "$D6" "15:30" "16:00"
expect_code "T2 +30min on D6 -> 12.5h" 422
expect_eq "  error code DAILY_HOURS_EXCEEDED" "$(jget "$BODY" error.code)" "DAILY_HOURS_EXCEEDED"
mkshift "$ADMIN_T" "$T2_ID" "$D7" "03:00" "13:00"
expect_code "T2 D7 10h after the 3h spill = 13h" 422
mkshift "$ADMIN_T" "$T2_ID" "$D7" "03:00" "12:00"
expect_code "T2 D7 9h after the 3h spill = 12h" 201
mkshift "$ADMIN_T" "$T3_ID" "$D9" "06:00" "10:00"
expect_code "T3 D9 06:00-10:00" 201
mkshift "$ADMIN_T" "$T3_ID" "$D9" "11:00" "15:00"
expect_code "T3 D9 11:00-15:00 only 1h after the previous (old 8h-rest rule removed)" 201
mkshift "$ADMIN_T" "$T3_ID" "$D8" "06:00" "12:00"
expect_code "T3 D8 6h" 201
S8B=$(jget "$BODY" shift_id)
mkshift "$ADMIN_T" "$T3_ID" "$D8" "13:00" "17:00"
expect_code "T3 D8 +4h (10h)" 201
S8C=$(jget "$BODY" shift_id)
api PATCH "/shifts/$S8C" "$ADMIN_T" "{\"end_at\":\"${D8}T21:00:00+08:00\",\"version\":1}"
expect_code "PATCH extending that shift to 8h -> 14h on D8" 422
api PATCH "/shifts/$S8C" "$ADMIN_T" "{\"end_at\":\"${D8}T19:00:00+08:00\",\"version\":1}"
expect_code "PATCH extending it to 6h -> exactly 12h" 200
api PATCH "/shifts/$S8B" "$ADMIN_T" "{\"user_id\":$T3_ID,\"version\":1}"
expect_code "PATCH reassign same user, no change in load" 200
mkshift "$ADMIN2_T" "$T1_ID" "$D9" "06:00" "07:00"
expect_code "Barangay-2 admin scheduling a barangay-1 tanod" 422

# ================================================================ publish
step "7. POST /shifts/publish — authority, tenant, replay, warnings"
api POST "/shifts/publish" "$ADMIN_T" "{\"shift_ids\":[$S1_ID]}" -H "Idempotency-Key: $(uuid)"
expect_code "Admin WITHOUT approve_roster" 403
api POST "/shifts/publish" "$SEC_T" "{\"shift_ids\":[$S1_ID]}" -H "Idempotency-Key: $(uuid)"
expect_code "Secretary WITHOUT approve_roster" 403
api POST "/shifts/publish" "$T1_T" "{\"shift_ids\":[$S1_ID]}" -H "Idempotency-Key: $(uuid)"
expect_code "Tanod" 403
api POST "/shifts/publish" "$PB_T" "{\"shift_ids\":[$S1_ID]}"
expect_code "Publish without Idempotency-Key" 400
api POST "/shifts/publish" "$PB_T" '{"shift_ids":[]}' -H "Idempotency-Key: $(uuid)"
expect_code "Empty shift_ids" 400
api POST "/shifts/publish" "$PB_T" '{"shift_ids":["a"]}' -H "Idempotency-Key: $(uuid)"
expect_code "Non-integer shift id" 400
BIG=$("$PHP_BIN" -r 'echo json_encode(range(1,101));')
api POST "/shifts/publish" "$PB_T" "{\"shift_ids\":$BIG}" -H "Idempotency-Key: $(uuid)"
expect_code "101 shift ids (max 100)" 400
B2_SHIFT_START=$(mu "$D1" "08:00"); B2_SHIFT_END=$(mu "$D1" "16:00")
mysql_exec "$VALDB" -e "INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, client_request_id) VALUES (2, $TB2_ID, 'B2', '$B2_SHIFT_START', '$B2_SHIFT_END', $ADMIN2_ID, 'b2-shift-00000000000000000000000000000');"
SB2_ID=$(db_one "SELECT shift_id FROM shift_schedule WHERE barangay_id=2;")
api POST "/shifts/publish" "$PB_T" "{\"shift_ids\":[$S1_ID,$SB2_ID]}" -H "Idempotency-Key: $(uuid)"
expect_code "Batch containing a barangay-2 shift (whole call 404)" 404
expect_eq "  the barangay-1 shift in that call stayed a draft" "$(db_one "SELECT approval_status FROM shift_schedule WHERE shift_id=$S1_ID;")" "draft"
api POST "/shifts/publish" "$PB_T" "{\"shift_ids\":[$S1_ID,999999]}" -H "Idempotency-Key: $(uuid)"
expect_code "Batch containing a nonexistent shift" 404

PUB_KEY=$(uuid)
api POST "/shifts/publish" "$PB_T" "{\"shift_ids\":[$S1_ID,$S2_ID]}" -H "Idempotency-Key: $PUB_KEY"
expect_code "Punong Barangay publishes D1 + D3 shifts" 200
PUB_FIRST="$BODY"
expect_eq "  published ids" "$(jget "$BODY" published)" "[$S1_ID,$S2_ID]"
expect_eq "  already_published empty" "$(jget "$BODY" already_published)" "[]"
expect_eq "  NO_COVERAGE warning for the uncovered middle day only" "$(jget "$BODY" warnings)" "[{\"code\":\"NO_COVERAGE\",\"date\":\"$D2\"}]"
expect_eq "  DB: published + approver + timestamp" "$(db_one "SELECT CONCAT(approval_status,'|',approved_by,'|',approved_at IS NOT NULL) FROM shift_schedule WHERE shift_id=$S1_ID;")" "published|$PB_ID|1"
expect_eq "  audit roster_published count" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.count') FROM audit_log WHERE action='roster_published' LIMIT 1;")" "2"
api POST "/shifts/publish" "$PB_T" "{\"shift_ids\":[$S1_ID,$S2_ID]}" -H "Idempotency-Key: $PUB_KEY"
expect_code "Replay with the same Idempotency-Key" 200
expect_eq "  replay returns the ORIGINAL outcome" "$BODY" "$PUB_FIRST"
expect_eq "  still exactly one roster_published audit row" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='roster_published';")" "1"
api POST "/shifts/publish" "$PB_T" "{\"shift_ids\":[$S1_ID]}" -H "Idempotency-Key: $(uuid)"
expect_code "Publishing an already-published shift (new key)" 200
expect_eq "  reported under already_published, not an error" "$(jget "$BODY" already_published)/$(jget "$BODY" published)" "[$S1_ID]/[]"
expect_eq "  version was not bumped again" "$(db_one "SELECT version FROM shift_schedule WHERE shift_id=$S1_ID;")" "2"
api GET "/shifts?limit=100" "$T1_T" ""
expect_eq "Tanod now sees the legacy + 2 newly published shifts" "$(jget "$BODY" total)" "3"
api POST "/shifts/publish" "$PB_T" "{\"shift_ids\":[$S_UN_ID]}" -H "Idempotency-Key: $(uuid)"
expect_code "Publishing an unassigned shift" 200
expect_eq "  unassigned shift does not provide coverage -> NO_COVERAGE for its date" "$(jget "$BODY" warnings)" "[{\"code\":\"NO_COVERAGE\",\"date\":\"$D5\"}]"
# authority, not role: grant the secretary approve_roster and she can publish
api POST "/shifts/publish" "$SEC2_T" "{\"shift_ids\":[$S8B]}" -H "Idempotency-Key: $(uuid)"
expect_code "Secretary holding approve_roster (granted in section 3) publishes" 200
expect_eq "  approved_by is that secretary" "$(db_one "SELECT approved_by FROM shift_schedule WHERE shift_id=$S8B;")" "$SEC2_ID"
api PATCH "/users/$SEC2_ID" "$ADMIN_T" '{"approval_authority":["note_report","approve_report"]}'
api POST "/shifts/publish" "$SEC2_T" "{\"shift_ids\":[$S8C]}" -H "Idempotency-Key: $(uuid)"
expect_code "...and after the authority is removed she cannot" 403
api PATCH "/users/$SEC2_ID" "$ADMIN_T" '{"approval_authority":["note_report","approve_report","approve_roster"]}'

# --- fix review finding 1: material edits to a PUBLISHED shift drop the approval
api PATCH "/shifts/$S2_ID" "$ADMIN_T" '{"patrol_zone":"Zone R edited","version":2}'
expect_code "PATCH only patrol_zone on a published shift" 200
expect_eq "  stays published, approver kept (not a material change)" "$(db_one "SELECT CONCAT(approval_status,'|',approved_by) FROM shift_schedule WHERE shift_id=$S2_ID;")" "published|$PB_ID"
api PATCH "/shifts/$S2_ID" "$ADMIN_T" "{\"user_id\":$T4_ID,\"version\":3}"
expect_code "Admin reassigns a PUBLISHED shift to another tanod" 200
expect_eq "  reverted to draft, approved_by/approved_at cleared" "$(db_one "SELECT CONCAT(approval_status,'|',IFNULL(approved_by,'NULL'),'|',IFNULL(approved_at,'NULL')) FROM shift_schedule WHERE shift_id=$S2_ID;")" "draft|NULL|NULL"
expect_eq "  audit shift_updated records approval_reset=true" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.approval_reset') FROM audit_log WHERE action='shift_updated' AND entity_id=$S2_ID ORDER BY audit_id DESC LIMIT 1;")" "true"
api GET "/shifts?limit=100" "$T4_T" ""
expect_eq "  the new assignee does not see it (draft)" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=0; foreach($d["items"] as $r){ if($r["shift_id"]==(int)$argv[1]) $n++; } echo $n;' "$S2_ID")" "0"
api POST "/shifts/publish" "$PB_T" "{\"shift_ids\":[$S2_ID]}" -H "Idempotency-Key: $(uuid)"
expect_code "Re-publish it" 200
api PATCH "/shifts/$S2_ID" "$ADMIN_T" "{\"start_at\":\"${D3}T09:00:00+08:00\",\"version\":5}"
expect_code "Admin moves the start time of a PUBLISHED shift" 200
expect_eq "  reverted to draft again" "$(db_one "SELECT CONCAT(approval_status,'|',IFNULL(approved_by,'NULL')) FROM shift_schedule WHERE shift_id=$S2_ID;")" "draft|NULL"

# swap on a draft shift is refused (a Tanod cannot even see it); on a published one it works and un-publishes
api POST "/shift-swap-requests" "$T3_T" "{\"shift_id\":$S8C,\"client_request_id\":\"$(uuid)\"}"
expect_code "Tanod requests a swap on their own DRAFT shift" 404
api POST "/shift-swap-requests" "$T1_T" "{\"shift_id\":$S1_ID,\"target_user_id\":$T4_ID,\"client_request_id\":\"$(uuid)\"}"
expect_code "Tanod requests a swap on their PUBLISHED shift" 201
SWP_ID=$(jget "$BODY" request_id)
api PATCH "/shift-swap-requests/$SWP_ID" "$ADMIN_T" '{"status":"approved","version":1}'
expect_code "Admin approves the swap (named target)" 200
expect_eq "  shift reassigned AND reverted to draft with the approval cleared" "$(db_one "SELECT CONCAT(user_id,'|',approval_status,'|',IFNULL(approved_by,'NULL')) FROM shift_schedule WHERE shift_id=$S1_ID;")" "$T4_ID|draft|NULL"
expect_eq "  audit swap_request_resolved records approval_reset=true" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.approval_reset') FROM audit_log WHERE action='swap_request_resolved' AND entity_id=$SWP_ID LIMIT 1;")" "true"

# swap approval uses the same daily cap (named target) and no coverage block
api GET "/shifts?limit=100" "$ADMIN_T" ""

# ================================================================ accomplishment
step "8. Accomplishment entries — validation, suggested duration, flag, idempotency"
TODAY=$(dman "today")
W1=$(dman "-3 days"); W3=$(dman "-2 days"); W4=$(dman "-8 days"); W4M=$(dman "-9 days")
# T1 duty history: W1 on_duty 08:00 -> off_duty 16:00 (480 min); W4M 22:00 -> W4 02:00 (carries over midnight)
mysql_exec "$VALDB" <<SQL
INSERT INTO duty_status (user_id, status, channel, client_event_id, changed_at) VALUES
 ($T1_ID, 'on_duty',  'app', NULL, '$(mu "$W4M" "22:00")'),
 ($T1_ID, 'off_duty', 'app', NULL, '$(mu "$W4" "02:00")'),
 ($T1_ID, 'on_duty',  'app', NULL, '$(mu "$W1" "08:00")'),
 ($T1_ID, 'off_duty', 'app', NULL, '$(mu "$W1" "16:00")');
SQL
mkentry() { # token device date text duration [extra json]
  api POST "/accomplishment-entries" "$1" "{\"work_date\":\"$3\",\"accomplishment_text\":\"$4\",\"duration_minutes\":$5,\"client_event_id\":\"$(uuid)\"${6:-}}" -H "$2"
}
mkentry "$T1_T" "$D_T1" "$W1" "Patrolled Purok 1 SECRETWORDS" 480
expect_code "T1 entry on W1, 480 min confirmed" 201
E1_ID=$(jget "$BODY" entry.entry_id); R1_ID=$(jget "$BODY" report.report_id)
expect_eq "  server-suggested duration from duty_status" "$(jget "$BODY" entry.suggested_duration_minutes)" "480"
expect_eq "  not flagged" "$(jget "$BODY" entry.duration_flag)" "false"
expect_eq "  report opened for the month, status open" "$(jget "$BODY" report.status)/$(jget "$BODY" report.month)" "open/${W1:0:7}"
mkentry "$T1_T" "$D_T1" "$W1" "Boundary exactly 30 off" 510
expect_eq "|510-480| = 30 is NOT flagged (margin is strictly greater)" "$(jget "$BODY" entry.duration_flag)" "false"
mkentry "$T1_T" "$D_T1" "$W1" "Boundary 31 off" 511
expect_eq "|511-480| = 31 IS flagged" "$(jget "$BODY" entry.duration_flag)" "true"
mkentry "$T1_T" "$D_T1" "$W3" "Claimed work on an off-duty day" 120
expect_eq "Day with history but no on_duty time: suggested 0" "$(jget "$BODY" entry.suggested_duration_minutes)" "0"
expect_eq "  120 vs 0 is flagged" "$(jget "$BODY" entry.duration_flag)" "true"
mkentry "$T1_T" "$D_T1" "$W4" "Overnight carry-over" 120
expect_eq "On-duty interval carried over midnight counts for the NEXT day (22:00-02:00 -> 120)" "$(jget "$BODY" entry.suggested_duration_minutes)" "120"
mkentry "$T1_T" "$D_T1" "$W4M" "Evening part" 120
expect_eq "...and the evening part counts for the first day (120)" "$(jget "$BODY" entry.suggested_duration_minutes)" "120"
mkentry "$T2_T" "$D_T2" "$TODAY" "T2 first entry SECRETWORDS" 240
expect_code "T2 (no duty_status rows at all) entry for today" 201
E2A_ID=$(jget "$BODY" entry.entry_id); R2_ID=$(jget "$BODY" report.report_id)
expect_eq "  nothing to suggest -> NULL, flag false" "$(jget "$BODY" entry.suggested_duration_minutes)/$(jget "$BODY" entry.duration_flag)" "null/false"
mkentry "$T2_T" "$D_T2" "$TODAY" "T2 second entry (several per day allowed)" 60 ",\"start_time\":\"08:00\",\"end_time\":\"09:00\""
expect_code "Second entry on the same work_date" 201
E2B_ID=$(jget "$BODY" entry.entry_id)
expect_eq "  same report" "$(jget "$BODY" report.report_id)" "$R2_ID"
expect_eq "  times stored" "$(jget "$BODY" entry.start_time)-$(jget "$BODY" entry.end_time)" "08:00:00-09:00:00"

EVT=$(uuid)
api POST "/accomplishment-entries" "$T3_T" "{\"work_date\":\"$TODAY\",\"accomplishment_text\":\"Replay test\",\"duration_minutes\":30,\"client_event_id\":\"$EVT\"}" -H "$D_T3"
expect_code "T3 entry" 201
E3_ID=$(jget "$BODY" entry.entry_id); R3_ID=$(jget "$BODY" report.report_id)
api POST "/accomplishment-entries" "$T3_T" "{\"work_date\":\"$TODAY\",\"accomplishment_text\":\"Replay test\",\"duration_minutes\":30,\"client_event_id\":\"$EVT\"}" -H "$D_T3"
expect_code "Replay of the same client_event_id" 200
expect_eq "  same entry id" "$(jget "$BODY" entry.entry_id)" "$E3_ID"
expect_eq "  one DB row" "$(db_one "SELECT COUNT(*) FROM accomplishment_entry WHERE client_event_id='$EVT';")" "1"

mkentry "$T1_T" "" "$W1" "x" 60
expect_code "POST entry without X-Device-Id" 400
mkentry "$T1_T" "$D_T2" "$W1" "x" 60
expect_code "POST entry with another tanod's device" 422
mkentry "$ADMIN_T" "$D_T1" "$W1" "x" 60
expect_code "Admin POST entry (tanod only)" 403
mkentry "$T1_T" "$D_T1" "$(dman '+1 day')" "x" 60
expect_code "work_date in the future (Manila)" 400
mkentry "$T1_T" "$D_T1" "$(dman '-63 days')" "x" 60
expect_code "work_date 63 days back (window is 62)" 400
mkentry "$T3_T" "$D_T3" "$(dman '-62 days')" "oldest allowed" 60
expect_code "work_date exactly 62 days back" 201
mkentry "$T1_T" "$D_T1" "2026-02-30" "x" 60
expect_code "Impossible calendar date" 400
mkentry "$T1_T" "$D_T1" "$W1" "   " 60
expect_code "Blank accomplishment_text" 400
BIGTEXT=$("$PHP_BIN" -r 'echo str_repeat("a",2001);')
mkentry "$T1_T" "$D_T1" "$W1" "$BIGTEXT" 60
expect_code "accomplishment_text over 2000 chars" 400
mkentry "$T1_T" "$D_T1" "$W1" "x" 0
expect_code "duration_minutes 0" 400
mkentry "$T1_T" "$D_T1" "$W1" "x" 1441
expect_code "duration_minutes 1441" 400
mkentry "$T1_T" "$D_T1" "$W1" "x" 1440
expect_code "duration_minutes 1440 (max)" 201
mkentry "$T1_T" "$D_T1" "$W1" "x" 60 ",\"start_time\":\"08:00\""
expect_code "start_time without end_time" 400
mkentry "$T1_T" "$D_T1" "$W1" "x" 60 ",\"start_time\":\"8am\",\"end_time\":\"9am\""
expect_code "Malformed times" 400
api POST "/accomplishment-entries" "$T1_T" "{\"work_date\":\"$W1\",\"accomplishment_text\":\"x\",\"duration_minutes\":60,\"client_event_id\":\"bad\"}" -H "$D_T1"
expect_code "client_event_id not a UUID" 400

# fix review finding 8: a late retry of an already-stored entry returns the original, never a 400/409
mysql_exec "$VALDB" -e "INSERT INTO accomplishment_report (barangay_id, user_id, month, status, created_at, updated_at) VALUES (1, $T3_ID, '2025-03', 'approved', UTC_TIMESTAMP(), UTC_TIMESTAMP());"
OLD_R=$(db_one "SELECT report_id FROM accomplishment_report WHERE user_id=$T3_ID AND month='2025-03';")
OLD_EVT=$(uuid)
mysql_exec "$VALDB" -e "INSERT INTO accomplishment_entry (report_id, barangay_id, user_id, work_date, accomplishment_text, duration_minutes, client_event_id, created_at, updated_at) VALUES ($OLD_R, 1, $T3_ID, '2025-03-10', 'stored long ago', 60, '$OLD_EVT', UTC_TIMESTAMP(), UTC_TIMESTAMP());"
OLD_E=$(db_one "SELECT entry_id FROM accomplishment_entry WHERE client_event_id='$OLD_EVT';")
api POST "/accomplishment-entries" "$T3_T" "{\"work_date\":\"2025-03-10\",\"accomplishment_text\":\"stored long ago\",\"duration_minutes\":60,\"client_event_id\":\"$OLD_EVT\"}" -H "$D_T3"
expect_code "Retry of a stored entry whose work_date is now outside the 62-day window (and whose report is approved)" 200
expect_eq "  the ORIGINAL entry is returned" "$(jget "$BODY" entry.entry_id)" "$OLD_E"
api POST "/accomplishment-entries" "$T3_T" "{\"work_date\":\"2025-03-10\",\"accomplishment_text\":\"  \",\"duration_minutes\":0,\"client_event_id\":\"$OLD_EVT\"}" -H "$D_T3"
expect_code "Retry of the same client_event_id with a body that would now fail validation" 200
expect_eq "  still the original entry, text untouched" "$(db_one "SELECT accomplishment_text FROM accomplishment_entry WHERE entry_id=$OLD_E;")" "stored long ago"
expect_eq "  no second row" "$(db_one "SELECT COUNT(*) FROM accomplishment_entry WHERE client_event_id='$OLD_EVT';")" "1"
api POST "/accomplishment-entries" "$T3_T" "{\"work_date\":\"2025-03-10\",\"accomplishment_text\":\"brand new\",\"duration_minutes\":60,\"client_event_id\":\"$(uuid)\"}" -H "$D_T3"
expect_code "A NEW event id with that stale date is still rejected" 400

step "9. PATCH /accomplishment-entries/:id"
api PATCH "/accomplishment-entries/$E2A_ID" "$T2_T" '{"duration_minutes":300,"accomplishment_text":"T2 first entry edited"}' -H "$D_T2"
expect_code "Owner edits an entry while the report is open" 200
expect_eq "  duration + text updated" "$(jget "$BODY" entry.duration_minutes)/$(jget "$BODY" entry.accomplishment_text)" "300/T2 first entry edited"
api PATCH "/accomplishment-entries/$E2A_ID" "$T3_T" '{"duration_minutes":10}' -H "$D_T3"
expect_code "Another tanod edits it" 404
api PATCH "/accomplishment-entries/$E2A_ID" "$TB2_T" '{"duration_minutes":10}' -H "$D_TB2"
expect_code "Barangay-2 tanod edits it (cross-tenant)" 404
api PATCH "/accomplishment-entries/$E2A_ID" "$ADMIN_T" '{"duration_minutes":10}'
expect_code "Admin edits it (tanod only)" 403
api PATCH "/accomplishment-entries/$E2A_ID" "$T2_T" '{}' -H "$D_T2"
expect_code "Empty PATCH body" 400
api PATCH "/accomplishment-entries/$E2A_ID" "$T2_T" '{"duration_minutes":0}' -H "$D_T2"
expect_code "PATCH invalid duration" 400
api PATCH "/accomplishment-entries/999999" "$T2_T" '{"duration_minutes":10}' -H "$D_T2"
expect_code "PATCH nonexistent entry" 404
api PATCH "/accomplishment-entries/$E1_ID" "$T1_T" '{"duration_minutes":600}' -H "$D_T1"
expect_eq "Editing the duration recomputes the flag (600 vs 480)" "$(jget "$BODY" entry.duration_flag)" "true"
api PATCH "/accomplishment-entries/$E1_ID" "$T1_T" '{"duration_minutes":480}' -H "$D_T1"
expect_eq "...and clears it again (480 vs 480)" "$(jget "$BODY" entry.duration_flag)" "false"

step "10. GET /accomplishment-reports (+ :id) — scoping, aggregates, text visibility"
api GET "/accomplishment-reports" "$T2_T" ""
expect_code "Tanod GET /accomplishment-reports" 200
expect_eq "  own report only" "$(jget "$BODY" total)" "1"
expect_eq "  entry_count/total_minutes/flagged_entries" "$(jget "$BODY" items.0.entry_count)/$(jget "$BODY" items.0.total_minutes)/$(jget "$BODY" items.0.flagged_entries)" "2/360/0"
api GET "/accomplishment-reports?user_id=$T2_ID" "$T1_T" ""
expect_code "Tanod GET ?user_id=<other tanod>" 404
api GET "/accomplishment-reports?month=${TODAY:0:7}" "$ADMIN_T" ""
expect_code "Admin GET ?month=" 200
expect_eq "  barangay-wide: T2 + T3 reports for the current month" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=[]; foreach($d["items"] as $r){ $n[]=$r["user_id"]; } sort($n); echo count($n)>=2 && in_array((int)$argv[1],$n) && in_array((int)$argv[2],$n) ? "yes":"no";' "$T2_ID" "$T3_ID")" "yes"
api GET "/accomplishment-reports?user_id=$T1_ID&status=open" "$PB_T" ""
expect_code "Punong Barangay GET ?user_id=&status=" 200
expect_eq "  T1 has open reports (W1/W3/W4/W4M months)" "$([ "$(jget "$BODY" total)" -ge 1 ] && echo yes || echo no)" "yes"
expect_eq "  a T1 report shows flagged_entries (W1 report: 511 flagged)" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $r){ if($r["report_id"]==(int)$argv[1]){ echo $r["flagged_entries"]>=1 ? "yes":"no"; } }' "$R1_ID")" "yes"
api GET "/accomplishment-reports?status=weird" "$ADMIN_T" ""
expect_code "Bad status filter" 400
api GET "/accomplishment-reports?month=2026-13" "$ADMIN_T" ""
expect_code "Bad month filter" 400
api GET "/accomplishment-reports" "$ADMIN2_T" ""
expect_eq "Barangay-2 admin sees 0 reports (tenant isolation)" "$(jget "$BODY" total)" "0"

api GET "/accomplishment-reports/$R2_ID" "$T2_T" ""
expect_code "Owner GET /accomplishment-reports/:id" 200
expect_eq "  entries returned, text visible to the owner" "$(jget "$BODY" entries.0.accomplishment_text)/$(jget "$BODY" text_visible)" "T2 first entry edited/true"
api GET "/accomplishment-reports/$R2_ID" "$T3_T" ""
expect_code "Another tanod GET it" 404
api GET "/accomplishment-reports/$R2_ID" "$ADMIN2_T" ""
expect_code "Barangay-2 admin GET it (cross-tenant)" 404
api GET "/accomplishment-reports/999999" "$ADMIN_T" ""
expect_code "GET nonexistent report" 404
api GET "/accomplishment-reports/$R2_ID" "$SEC_T" ""
expect_code "Secretary WITHOUT note/approve authority GET it" 200
expect_eq "  structure visible, text withheld" "$(jget "$BODY" entries.0.accomplishment_text)/$(jget "$BODY" text_visible)/$(jget "$BODY" entries.0.duration_minutes)" "null/false/300"
api GET "/accomplishment-reports/$R2_ID" "$ADMIN_T" ""
expect_eq "Admin (holds note_report) sees the text" "$(jget "$BODY" text_visible)" "true"
expect_eq "  entry duration_flag / suggested exposed" "$(jget "$BODY" entries.0.duration_flag)/$(jget "$BODY" entries.0.suggested_duration_minutes)" "false/null"

step "11. Report state machine — submit / note / approve / return, segregation of duties"
# an empty report (cannot arise through the API: a report is only created with its first entry)
mysql_exec "$VALDB" -e "INSERT INTO accomplishment_report (barangay_id, user_id, month, status, created_at) VALUES (1, $T3_ID, '2025-01', 'open', UTC_TIMESTAMP());"
EMPTY_R=$(db_one "SELECT report_id FROM accomplishment_report WHERE user_id=$T3_ID AND month='2025-01';")
api POST "/accomplishment-reports/$EMPTY_R/submit" "$T3_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Submit a report with no entries" 422

SUB_KEY=$(uuid)
api POST "/accomplishment-reports/$R2_ID/submit" "$T3_T" "" -H "Idempotency-Key: $SUB_KEY"
expect_code "Another tanod submits T2's report" 404
api POST "/accomplishment-reports/$R2_ID/submit" "$ADMIN_T" "" -H "Idempotency-Key: $SUB_KEY"
expect_code "Admin submits (tanod only)" 403
api POST "/accomplishment-reports/$R2_ID/submit" "$T2_T" ""
expect_code "Submit without Idempotency-Key" 400
api POST "/accomplishment-reports/$R2_ID/note" "$PB_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Note an 'open' report" 409
api POST "/accomplishment-reports/$R2_ID/submit" "$T2_T" "" -H "Idempotency-Key: $SUB_KEY"
expect_code "T2 submits the month" 200
expect_eq "  status prepared, total_minutes_confirmed = 300+60" "$(jget "$BODY" status)/$(jget "$BODY" total_minutes_confirmed)" "prepared/360"
api POST "/accomplishment-reports/$R2_ID/submit" "$T2_T" "" -H "Idempotency-Key: $SUB_KEY"
expect_code "Replay of the submit (same key)" 200
expect_eq "  one submitted audit row" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='accomplishment_report_submitted' AND entity_id=$R2_ID;")" "1"
api POST "/accomplishment-reports/$R2_ID/submit" "$T2_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Submit again with a NEW key (already prepared)" 409
mkentry "$T2_T" "$D_T2" "$TODAY" "late entry" 30
expect_code "New entry on a prepared report" 409
api PATCH "/accomplishment-entries/$E2A_ID" "$T2_T" '{"duration_minutes":10}' -H "$D_T2"
expect_code "Edit an entry of a prepared report" 409

api POST "/accomplishment-reports/$R2_ID/approve" "$PB_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Approve a 'prepared' report (must be noted first)" 409
api POST "/accomplishment-reports/$R2_ID/note" "$T2_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Tanod notes" 403
api POST "/accomplishment-reports/$R2_ID/note" "$SEC_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Secretary WITHOUT note_report notes" 403
api POST "/accomplishment-reports/$R2_ID/note" "$ADMIN2_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Barangay-2 admin (holds note_report) notes B1's report (cross-tenant)" 404
api POST "/accomplishment-reports/$R2_ID/note" "$PB_T" ""
expect_code "Note without Idempotency-Key" 400
NOTE_KEY=$(uuid)
api POST "/accomplishment-reports/$R2_ID/note" "$ADMIN_T" "" -H "Idempotency-Key: $NOTE_KEY"
expect_code "Admin holding note_report notes" 200
expect_eq "  status noted, noted_by" "$(jget "$BODY" status)/$(jget "$BODY" noted_by)" "noted/$ADMIN_ID"
api POST "/accomplishment-reports/$R2_ID/note" "$ADMIN_T" "" -H "Idempotency-Key: $NOTE_KEY"
expect_code "Replay of the note (same key)" 200
api POST "/accomplishment-reports/$R2_ID/note" "$ADMIN_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Note an already-noted report (new key)" 409
api POST "/accomplishment-reports/$R2_ID/approve" "$ADMIN_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Admin WITHOUT approve_report approves" 403
api POST "/accomplishment-reports/$R2_ID/approve" "$T2_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Tanod approves" 403
APP_KEY=$(uuid)
api POST "/accomplishment-reports/$R2_ID/approve" "$PB_T" "" -H "Idempotency-Key: $APP_KEY"
expect_code "Punong Barangay approves" 200
expect_eq "  status approved, approved_by" "$(jget "$BODY" status)/$(jget "$BODY" approved_by)" "approved/$PB_ID"
api POST "/accomplishment-reports/$R2_ID/approve" "$PB_T" "" -H "Idempotency-Key: $APP_KEY"
expect_code "Replay of the approval (same key)" 200
api POST "/accomplishment-reports/$R2_ID/approve" "$PB_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Approve an already-approved report" 409
api POST "/accomplishment-reports/$R2_ID/return" "$PB_T" '{"reason":"too late"}' -H "Idempotency-Key: $(uuid)"
expect_code "Return an approved report" 409
mkentry "$T2_T" "$D_T2" "$TODAY" "after approval" 30
expect_code "New entry on an approved report" 409
api GET "/accomplishment-reports/$R2_ID" "$PB_T" ""
expect_eq "Detail shows noted/approved by name + official_title for the print layout" "$(jget "$BODY" noted_by_title)|$(jget "$BODY" approved_by_title)|$(jget "$BODY" approved_by_name)" "Chief Tanod|Punong Barangay|RC Punong"
expect_eq "Audit metadata of report transitions carries only ids/statuses (no text)" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action LIKE 'accomplishment_report_%' AND metadata_json LIKE '%SECRETWORDS%';")" "0"
expect_eq "  keys are exactly report_id/month/status/idempotency_key" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='accomplishment_report_approved' LIMIT 1;")" '["report_id", "month", "status", "idempotency_key"]'
expect_eq "No audit row anywhere contains the entry text" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE metadata_json LIKE '%SECRETWORDS%';")" "0"

# return flow on T3's report
api POST "/accomplishment-reports/$R3_ID/return" "$ADMIN_T" '{"reason":"x"}' -H "Idempotency-Key: $(uuid)"
expect_code "Return an 'open' report" 409
api POST "/accomplishment-reports/$R3_ID/submit" "$T3_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "T3 submits" 200
api POST "/accomplishment-reports/$R3_ID/return" "$ADMIN_T" '' -H "Idempotency-Key: $(uuid)"
expect_code "Return without a reason" 400
api POST "/accomplishment-reports/$R3_ID/return" "$ADMIN_T" '{"reason":"   "}' -H "Idempotency-Key: $(uuid)"
expect_code "Return with a blank reason" 400
api POST "/accomplishment-reports/$R3_ID/return" "$ADMIN_T" "{\"reason\":\"$("$PHP_BIN" -r 'echo str_repeat("r",256);')\"}" -H "Idempotency-Key: $(uuid)"
expect_code "Return with a 256-char reason" 400
api POST "/accomplishment-reports/$R3_ID/return" "$SEC_T" '{"reason":"fix"}' -H "Idempotency-Key: $(uuid)"
expect_code "Secretary WITHOUT note/approve authority returns" 403
api POST "/accomplishment-reports/$R3_ID/return" "$T3_T" '{"reason":"fix"}' -H "Idempotency-Key: $(uuid)"
expect_code "Tanod returns" 403
RET_KEY=$(uuid)
api POST "/accomplishment-reports/$R3_ID/return" "$ADMIN_T" '{"reason":"Please add the Tuesday patrol"}' -H "Idempotency-Key: $RET_KEY"
expect_code "Admin (note_report) returns a prepared report" 200
expect_eq "  status returned + reason" "$(jget "$BODY" status)/$(jget "$BODY" return_reason)" "returned/Please add the Tuesday patrol"
api POST "/accomplishment-reports/$R3_ID/return" "$ADMIN_T" '{"reason":"Please add the Tuesday patrol"}' -H "Idempotency-Key: $RET_KEY"
expect_code "Replay of the return (same key)" 200
api PATCH "/accomplishment-entries/$E3_ID" "$T3_T" '{"duration_minutes":45}' -H "$D_T3"
expect_code "Entries are editable again after a return" 200
mkentry "$T3_T" "$D_T3" "$TODAY" "added after return" 20
expect_code "New entry on a returned report" 201
api POST "/accomplishment-reports/$R3_ID/submit" "$T3_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Resubmit after return" 200
expect_eq "  prepared again, return_reason cleared, total recomputed (45+20+...)" "$(jget "$BODY" status)/$(jget "$BODY" return_reason)/$(jget "$BODY" total_minutes_confirmed)" "prepared/null/65"
api POST "/accomplishment-reports/$R3_ID/note" "$ADMIN_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Noted (round 2)" 200
api POST "/accomplishment-reports/$R3_ID/return" "$PB_T" '{"reason":"Approver sends it back"}' -H "Idempotency-Key: $(uuid)"
expect_code "A noted report can be returned by an approver" 200
expect_eq "  return clears noted_by/noted_at" "$(db_one "SELECT CONCAT(IFNULL(noted_by,'NULL'),'|',IFNULL(noted_at,'NULL')) FROM accomplishment_report WHERE report_id=$R3_ID;")" "NULL|NULL"

# segregation of duties: a report PREPARED BY an official who also holds the authority
mysql_exec "$VALDB" -e "INSERT INTO accomplishment_report (barangay_id, user_id, month, status, prepared_at, created_at) VALUES (1, $SEC2_ID, '2025-02', 'prepared', UTC_TIMESTAMP(), UTC_TIMESTAMP());"
SEG_R=$(db_one "SELECT report_id FROM accomplishment_report WHERE user_id=$SEC2_ID;")
api POST "/accomplishment-reports/$SEG_R/note" "$SEC2_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Preparer (holds note_report) notes their OWN report" 409
expect_eq "  stayed prepared" "$(db_one "SELECT status FROM accomplishment_report WHERE report_id=$SEG_R;")" "prepared"
api POST "/accomplishment-reports/$SEG_R/note" "$PB_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "A different official notes it" 200
api POST "/accomplishment-reports/$SEG_R/approve" "$SEC2_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Preparer (holds approve_report) approves their OWN report" 409
api POST "/accomplishment-reports/$SEG_R/approve" "$PB_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "The noter (also holds approve_report) MAY approve - officials are few" 200

# ================================================================ sync
step "12. POST /sync/batch — availability[] and accomplishment_entries[] (createItem / createEntryItem)"
SY_AV_EVT=$(uuid); SY_AC_EVT=$(uuid)
SY_START=$(dman "+50 days")
SY_BODY="{\"device_id\":\"dev-rc-t3\",\"availability\":[{\"period_start\":\"$SY_START\",\"period_end\":\"$SY_START\",\"windows\":[{\"date\":\"$SY_START\",\"start\":\"08:00\",\"end\":\"12:00\"}],\"client_event_id\":\"$SY_AV_EVT\"}],\"accomplishment_entries\":[{\"work_date\":\"$(dman '-4 days')\",\"accomplishment_text\":\"Synced entry\",\"duration_minutes\":90,\"client_event_id\":\"$SY_AC_EVT\"},{\"work_date\":\"$(dman '+5 days')\",\"accomplishment_text\":\"Future entry\",\"duration_minutes\":90,\"client_event_id\":\"$(uuid)\"}]}"
api POST "/sync/batch" "$T3_T" "$SY_BODY"
expect_code "Sync batch with both new groups" 200
expect_eq "  availability item: success" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["results"] as $r){ if($r["client_event_id"]===$argv[1]) echo $r["status"]; }' "$SY_AV_EVT")" "success"
expect_eq "  accomplishment entry item: success" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["results"] as $r){ if($r["client_event_id"]===$argv[1]) echo $r["status"]; }' "$SY_AC_EVT")" "success"
expect_eq "  invalid item (future work_date) fails individually, not the batch" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $f=0; foreach($d["results"] as $r){ if($r["status"]==="failed") $f++; } echo $f;')" "1"
expect_eq "  DB rows written" "$(db_one "SELECT (SELECT COUNT(*) FROM tanod_availability WHERE client_event_id='$SY_AV_EVT') + (SELECT COUNT(*) FROM accomplishment_entry WHERE client_event_id='$SY_AC_EVT');")" "2"
api POST "/sync/batch" "$T3_T" "$SY_BODY"
expect_eq "Re-sending the same batch: items report duplicate, no second rows" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=0; foreach($d["results"] as $r){ if($r["status"]==="duplicate") $n++; } echo $n;')/$(db_one "SELECT COUNT(*) FROM accomplishment_entry WHERE client_event_id='$SY_AC_EVT';")" "2/1"

step "12b. H-09 device signature is checked PER ITEM on availability[] / accomplishment_entries[] (fix review finding 4)"
SIGV_AV=$(uuid); SIGV_AC=$(uuid); SIGV_SOS=$(uuid)
SIGV_P=$(dman "+60 days")
SIGV_BODY=$("$PHP_BIN" -r '
echo json_encode([
  "device_id" => "dev-rc-t4",
  "sos" => [["latitude"=>12.9,"longitude"=>123.6,"triggered_at"=>gmdate("Y-m-d\\TH:i:s\\Z"),"client_event_id"=>$argv[4]]],
  "availability" => [["period_start"=>$argv[1],"period_end"=>$argv[1],"windows"=>[["date"=>$argv[1],"start"=>"08:00","end"=>"10:00"]],"client_event_id"=>$argv[2]]],
  "accomplishment_entries" => [["work_date"=>$argv[5],"accomplishment_text"=>"sig item","duration_minutes"=>45,"client_event_id"=>$argv[3]]],
]);' "$SIGV_P" "$SIGV_AV" "$SIGV_AC" "$SIGV_SOS" "$(dman '-3 days')")
api POST "/sync/batch" "$T4_T" "$SIGV_BODY"
expect_code "Unsigned batch from a device that HAS a registered key" 200
res_of() { printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["results"] as $r){ if($r["client_event_id"]===$argv[1]) echo $r[$argv[2]] ?? "null"; }' "$1" "$2"; }
expect_eq "  SOS item is still accepted (never rejected on the signature check)" "$(res_of "$SIGV_SOS" status)" "success"
expect_eq "  availability item rejected per item" "$(res_of "$SIGV_AV" status)" "failed"
expect_eq "  accomplishment item rejected per item" "$(res_of "$SIGV_AC" status)" "failed"
expect_eq "  reason is the signature failure" "$(res_of "$SIGV_AV" reason)" "Device signature verification failed."
expect_eq "  nothing written" "$(db_one "SELECT (SELECT COUNT(*) FROM tanod_availability WHERE client_event_id='$SIGV_AV') + (SELECT COUNT(*) FROM accomplishment_entry WHERE client_event_id='$SIGV_AC');")" "0"
TS=$(date +%s)
SIG=$(printf 'POST\n/api/v1/sync/batch\n%s\n%s' "dev-rc-t4" "$TS" | "$OPENSSL_BIN" dgst -sha256 -sign "$TMP_DIR/t4.key" | base64 -w0)
api POST "/sync/batch" "$T4_T" "$SIGV_BODY" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $SIG"
expect_eq "Same batch with a valid signature: availability item succeeds" "$(res_of "$SIGV_AV" status)" "success"
expect_eq "  accomplishment item succeeds" "$(res_of "$SIGV_AC" status)" "success"

step "13. Final spot checks"
api GET "/shifts?limit=100&approval_status=draft" "$ADMIN_T" ""
expect_code "Admin GET drafts after everything" 200
api GET "/fatigue-flags" "$ADMIN_T" ""
api GET "/shifts/fatigue-flags" "$ADMIN_T" ""
expect_code "Fatigue endpoints untouched (GET /shifts/fatigue-flags)" 200

step "Summary"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
[ "$FAIL" -eq 0 ]
