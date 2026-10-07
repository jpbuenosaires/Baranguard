#!/usr/bin/env bash
# Baranguard — Wave 1 / Agent A validation (review decisions 2026-10-07):
# dispatch cancel reason + cancel-from-arrived, dispatch needs a PUBLISHED
# shift (NO_PUBLISHED_SHIFT / override_reason), Secretary may create/update
# shifts and review swap requests, approved swap -> draft +
# pending_reapproval (Tanod keeps seeing it, publish clears it), migrations
# 0034/0035 (+ down), and backup.sh's "legal hold prunes nothing" rule.
#
# Safe to run: disposable database, disposable app-user, throwaway port. The
# real `baranguard`/`baranguard_uiseed` databases and backend/.env are never
# touched.
#
# Usage: bash backend/scripts/verify-wave1a-dispatch-roster.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

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
VALDB="baranguard_wave1a_check"
APP_USER="wave1a_app"
APP_PASSWORD="Wave1aDbPw!2026"
API_PORT="8701"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Wave1a#2026Pw"

echo "Baranguard Wave 1A (dispatch / roster) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; DROP DATABASE IF EXISTS \`${VALDB}_rt\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$TMP_DIR"
  rm -f "$BACKEND_DIR/scripts/.wave1a-server.log"
  echo "Stopped the test PHP server, dropped $VALDB and user '$APP_USER'."
  echo "Your real databases and backend/.env were never touched."
}
trap cleanup EXIT

# ---------------------------------------------------------------- helpers
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }
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
expect_code() { [ "$CODE" = "$2" ] && pass "$1 -> $2" || fail "$1 -> $CODE (expected $2): ${BODY:0:240}"; }
expect_eq() { [ "$2" = "$3" ] && pass "$1 (= $3)" || fail "$1: got '$2', expected '$3'"; }
login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
# true when the JSON array $1 (items[]) holds a shift_id equal to $2
shift_visible() { printf '%s' "$1" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=0; foreach(($d["items"] ?? []) as $r){ if($r["shift_id"]==(int)$argv[1]) $n++; } echo $n;' "$2"; }
shift_field() { printf '%s' "$1" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach(($d["items"] ?? []) as $r){ if($r["shift_id"]==(int)$argv[1]){ $v=$r[$argv[2]] ?? null; echo is_bool($v)?($v?"true":"false"):($v===null?"null":$v); } }' "$2" "$3"; }

# ---------------------------------------------------------------- 0
step "0. Disposable schema (FULL migration chain) + migrations 0034/0035"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort | awk -v s=0001_baseline_schema '$0 >= s'); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain applied (all migrations/*.sql, globbed)"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

col_info() { db_one "SELECT CONCAT(COLUMN_TYPE,'|',IS_NULLABLE,'|',IFNULL(COLUMN_DEFAULT,'NULL')) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='$1' AND COLUMN_NAME='$2';"; }
expect_eq "0034: dispatch.cancel_reason VARCHAR(255) NULL" "$(col_info dispatch cancel_reason)" "varchar(255)|YES|NULL"
expect_eq "0034: dispatch.override_reason VARCHAR(255) NULL" "$(col_info dispatch override_reason)" "varchar(255)|YES|NULL"
expect_eq "0035: shift_schedule.pending_reapproval TINYINT(1) NOT NULL DEFAULT 0" "$(col_info shift_schedule pending_reapproval)" "tinyint(1)|NO|0"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0034_dispatch_cancel_and_override_reason.sql" >/dev/null 2>&1 \
  && mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0035_shift_pending_reapproval.sql" >/dev/null 2>&1 \
  && pass "0034/0035 are idempotent (re-applied cleanly)" || fail "0034/0035 re-apply failed"

# Down migrations round-trip on a scratch copy of the schema.
RT_DB="${VALDB}_rt"
mysql_exec -e "DROP DATABASE IF EXISTS \`$RT_DB\`; CREATE DATABASE \`$RT_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort); do
  mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1
done
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0035_shift_pending_reapproval.down.sql" >/dev/null 2>&1 && pass "0035 .down.sql applies cleanly" || fail "0035 .down.sql failed"
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0034_dispatch_cancel_and_override_reason.down.sql" >/dev/null 2>&1 && pass "0034 .down.sql applies cleanly" || fail "0034 .down.sql failed"
GONE=$(mysql_exec -N -s -e "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$RT_DB' AND ((TABLE_NAME='dispatch' AND COLUMN_NAME IN ('cancel_reason','override_reason')) OR (TABLE_NAME='shift_schedule' AND COLUMN_NAME='pending_reapproval'));" | tr -d '\r')
expect_eq "Down migrations removed all three columns" "$GONE" "0"
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0034_dispatch_cancel_and_override_reason.sql" >/dev/null 2>&1 \
  && mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0035_shift_pending_reapproval.sql" >/dev/null 2>&1 \
  && pass "0034/0035 re-apply after rollback" || fail "0034/0035 re-apply after rollback failed"
mysql_exec -e "DROP DATABASE IF EXISTS \`$RT_DB\`;" >/dev/null 2>&1

# ---------------------------------------------------------------- 1 seed
step "1. Seed accounts, shifts, incidents"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'wa_admin',  '$HASH', 'WA Admin',      'admin',           1, UTC_TIMESTAMP()),
  (1, 'wa_pb',     '$HASH', 'WA Punong',     'punong_barangay', 1, UTC_TIMESTAMP()),
  (1, 'wa_sec',    '$HASH', 'WA Secretary',  'secretary',       1, UTC_TIMESTAMP()),
  (1, 'wa_t1',     '$HASH', 'WA Tanod One',  'tanod',           1, UTC_TIMESTAMP()),
  (1, 'wa_t2',     '$HASH', 'WA Tanod Two',  'tanod',           1, UTC_TIMESTAMP()),
  (1, 'wa_t3',     '$HASH', 'WA Tanod Three','tanod',           1, UTC_TIMESTAMP()),
  (1, 'wa_t4',     '$HASH', 'WA Tanod Four', 'tanod',           1, UTC_TIMESTAMP()),
  (1, 'wa_t5',     '$HASH', 'WA Tanod Five', 'tanod',           1, UTC_TIMESTAMP()),
  (1, 'wa_t6',     '$HASH', 'WA Tanod Six',  'tanod',           1, UTC_TIMESTAMP()),
  (2, 'wa_admin2', '$HASH', 'WA Admin B2',   'admin',           1, UTC_TIMESTAMP()),
  (2, 'wa_sec2',   '$HASH', 'WA Secretary B2','secretary',      1, UTC_TIMESTAMP()),
  (2, 'wa_t_b2',   '$HASH', 'WA Tanod B2',   'tanod',           1, UTC_TIMESTAMP());
SQL
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
ADMIN_ID=$(uid wa_admin); PB_ID=$(uid wa_pb); SEC_ID=$(uid wa_sec)
T1=$(uid wa_t1); T2=$(uid wa_t2); T3=$(uid wa_t3); T4=$(uid wa_t4); T5=$(uid wa_t5); T6=$(uid wa_t6)
ADMIN2_ID=$(uid wa_admin2); TB2=$(uid wa_t_b2)
# PB holds approve_roster (authority is an attribute, not a role); the Secretary deliberately holds none.
mysql_exec "$VALDB" -e "UPDATE user SET approval_authority='approve_roster' WHERE user_id=$PB_ID; UPDATE user SET approval_authority='' WHERE user_id=$SEC_ID;"
# Every tanod on duty so duty eligibility is never the reason for a refusal.
for t in $T1 $T2 $T3 $T4 $T5 $T6; do
  mysql_exec "$VALDB" -e "INSERT INTO duty_status (user_id, status, channel, changed_at) VALUES ($t, 'on_duty', 'app', UTC_TIMESTAMP());"
done
# T1, T2: PUBLISHED shift covering now.  T3: DRAFT shift covering now.
# T4: PUBLISHED but ended 2h ago.  T5: PUBLISHED but starts in 3h.
mysql_exec "$VALDB" <<SQL
INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, approval_status, approved_by, approved_at) VALUES
  (1, $T1, 'Z1', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 6 HOUR), $ADMIN_ID, 'published', $PB_ID, UTC_TIMESTAMP()),
  (1, $T2, 'Z2', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 6 HOUR), $ADMIN_ID, 'published', $PB_ID, UTC_TIMESTAMP());
INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, approval_status) VALUES
  (1, $T3, 'Z3', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 6 HOUR), $ADMIN_ID, 'draft');
INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, approval_status, approved_by, approved_at) VALUES
  (1, $T4, 'Z4', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 HOUR), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR), $ADMIN_ID, 'published', $PB_ID, UTC_TIMESTAMP()),
  (1, $T5, 'Z5', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 3 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR), $ADMIN_ID, 'published', $PB_ID, UTC_TIMESTAMP());
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
  (1, 'theft', 'normal',   'WA-INC-1', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, 'fire',  'critical', 'WA-INC-2', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, 'noise', 'low',      'WA-INC-3', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
S1=$(db_one "SELECT shift_id FROM shift_schedule WHERE user_id=$T1;")
S2=$(db_one "SELECT shift_id FROM shift_schedule WHERE user_id=$T2;")
S3=$(db_one "SELECT shift_id FROM shift_schedule WHERE user_id=$T3;")
INC1=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='WA-INC-1';")
INC2=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='WA-INC-2';")
INC3=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='WA-INC-3';")
[ -n "$S1" ] && [ -n "$S3" ] && [ -n "$INC3" ] && pass "Seeded 11 users, 5 shifts (#$S1 #$S2 published, #$S3 draft), 3 incidents" || fail "Seed failed"

step "2. Start the API (PHP built-in server on port $API_PORT)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
(cd "$BACKEND_DIR/public" && "$PHP_BIN" -S "127.0.0.1:${API_PORT}" >"$BACKEND_DIR/scripts/.wave1a-server.log" 2>&1) &
SERVER_PID=$!
sleep 2
ADMIN_T=$(login_as wa_admin); PB_T=$(login_as wa_pb); SEC_T=$(login_as wa_sec)
T1_T=$(login_as wa_t1); T2_T=$(login_as wa_t2); T3_T=$(login_as wa_t3); T4_T=$(login_as wa_t4); T5_T=$(login_as wa_t5); T6_T=$(login_as wa_t6)
ADMIN2_T=$(login_as wa_admin2); SEC2_T=$(login_as wa_sec2); TB2_T=$(login_as wa_t_b2)
[ -n "$ADMIN_T" ] && [ -n "$PB_T" ] && [ -n "$SEC_T" ] && [ -n "$T1_T" ] && [ -n "$SEC2_T" ] && [ -n "$TB2_T" ] && pass "Logged in as every test account" || { fail "One or more logins failed"; exit 1; }

# ================================================================ dispatch create
step "3. POST /dispatch needs a PUBLISHED shift covering now"
dispatch_body() { printf '{"incident_id":%s,"tanod_id":%s,"request_id":"%s"%s}' "$1" "$2" "$(uuid)" "${3:-}"; }

api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC1 $T3)"
expect_code "Tanod with only a DRAFT shift covering now" 422
expect_eq "  error code is NO_PUBLISHED_SHIFT" "$(jget "$BODY" error.code)" "NO_PUBLISHED_SHIFT"
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC1 $T4)"
expect_code "Tanod whose published shift already ENDED" 422
expect_eq "  error code is NO_PUBLISHED_SHIFT" "$(jget "$BODY" error.code)" "NO_PUBLISHED_SHIFT"
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC1 $T5)"
expect_code "Tanod whose published shift has NOT started yet" 422
expect_eq "No dispatch rows were created by the refusals" "$(db_one "SELECT COUNT(*) FROM dispatch;")" "0"
expect_eq "Incident untouched (still pending)" "$(db_one "SELECT status FROM incident WHERE incident_id=$INC1;")" "pending"

# override_reason validation (400 whether or not it would be needed)
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC1 $T3 ',"override_reason":""')"
expect_code "override_reason blank" 400
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC1 $T3 ',"override_reason":"   "')"
expect_code "override_reason whitespace only" 400
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC1 $T3 ',"override_reason":12345')"
expect_code "override_reason not a string" 400
LONG256=$(printf 'x%.0s' $(seq 1 256))
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC1 $T3 ",\"override_reason\":\"$LONG256\"")"
expect_code "override_reason 256 chars (too long)" 400
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC1 $T1 ',"override_reason":""')"
expect_code "override_reason blank is a 400 even for a Tanod who HAS a published shift" 400

# override path
OVR_REQ=$(uuid)
OVR_TEXT="Fire alarm at the market; nearest tanod, not rostered"
api POST /dispatch "$ADMIN_T" "{\"incident_id\":$INC1,\"tanod_id\":$T3,\"request_id\":\"$OVR_REQ\",\"override_reason\":\"$OVR_TEXT\"}"
expect_code "Draft-shift Tanod WITH override_reason" 201
D_OVR=$(jget "$BODY" dispatch_id)
expect_eq "  override_reason stored on the dispatch row" "$(db_one "SELECT override_reason FROM dispatch WHERE dispatch_id=$D_OVR;")" "$OVR_TEXT"
expect_eq "  incident moved to dispatched" "$(db_one "SELECT status FROM incident WHERE incident_id=$INC1;")" "dispatched"
expect_eq "  audit dispatch_created records shift_override=true" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.shift_override') FROM audit_log WHERE action='dispatch_created' AND entity_id=$D_OVR;")" "true"
META=$(db_one "SELECT metadata_json FROM audit_log WHERE action='dispatch_created' AND entity_id=$D_OVR;")
case "$META" in *"Fire alarm"*|*"not rostered"*) fail "AUDIT LEAK: override reason text is in audit metadata";; *) pass "  audit metadata never contains the override reason text";; esac
api POST /dispatch "$ADMIN_T" "{\"incident_id\":$INC1,\"tanod_id\":$T3,\"request_id\":\"$OVR_REQ\"}"
expect_code "Retry of the SAME request_id (no override this time) returns the original dispatch" 200
expect_eq "  same dispatch_id" "$(jget "$BODY" dispatch_id)" "$D_OVR"

# normal path with a covering published shift
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC2 $T1)"
expect_code "Tanod with a published shift covering now, no override" 201
D_T1=$(jget "$BODY" dispatch_id)
expect_eq "  override_reason is NULL (not needed)" "$(db_one "SELECT IFNULL(override_reason,'NULL') FROM dispatch WHERE dispatch_id=$D_T1;")" "NULL"
expect_eq "  audit shift_override=false" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.shift_override') FROM audit_log WHERE action='dispatch_created' AND entity_id=$D_T1;")" "false"
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC2 $T2 ',"override_reason":"belt and braces"')"
expect_code "Covered Tanod + an unneeded override_reason" 201
D_T2=$(jget "$BODY" dispatch_id)
expect_eq "  unneeded override_reason is NOT stored" "$(db_one "SELECT IFNULL(override_reason,'NULL') FROM dispatch WHERE dispatch_id=$D_T2;")" "NULL"

api POST /dispatch "$ADMIN2_T" "$(dispatch_body $INC3 $T1)"
expect_code "Cross-tenant admin POST /dispatch" 404
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC3 $TB2)"
expect_code "Other-barangay Tanod is still the generic 422 (not a NO_PUBLISHED_SHIFT oracle)" 422
expect_eq "  generic error code" "$(jget "$BODY" error.code)" "UNPROCESSABLE_ENTITY"

# ================================================================ dispatch cancel
step "4. PATCH /dispatch/:id/cancel — reason required, allowed from arrived"
api PATCH "/dispatch/$D_T1/cancel" "$ADMIN_T" ""
expect_code "Cancel with no body" 400
api PATCH "/dispatch/$D_T1/cancel" "$ADMIN_T" '{}'
expect_code "Cancel with {} " 400
api PATCH "/dispatch/$D_T1/cancel" "$ADMIN_T" '{"reason":"   "}'
expect_code "Cancel with blank reason" 400
api PATCH "/dispatch/$D_T1/cancel" "$ADMIN_T" '{"reason":42}'
expect_code "Cancel with non-string reason" 400
api PATCH "/dispatch/$D_T1/cancel" "$ADMIN_T" "{\"reason\":\"$LONG256\"}"
expect_code "Cancel with 256-char reason" 400
LONG255=$(printf 'y%.0s' $(seq 1 255))
expect_eq "Dispatch still active after every rejected cancel" "$(db_one "SELECT status FROM dispatch WHERE dispatch_id=$D_T1;")" "assigned"
api PATCH "/dispatch/$D_T1/cancel" "$ADMIN2_T" ""
expect_code "Cross-tenant cancel (even with NO reason) is 404, never 400/403" 404
api PATCH "/dispatch/$D_T1/cancel" "$T1_T" '{"reason":"nope"}'
expect_code "Tanod cannot cancel" 403
api PATCH "/dispatch/$D_T1/cancel" "$SEC_T" '{"reason":"nope"}'
expect_code "Secretary cannot cancel" 403
api PATCH "/dispatch/$D_T1/cancel" "$PB_T" '{"reason":"nope"}'
expect_code "Punong Barangay cannot cancel" 403

# T1 -> en_route -> arrived (as the Tanod), second responder T2 stays 'assigned'
api PATCH "/dispatch/$D_T1/status" "$T1_T" '{"status":"en_route"}'
expect_code "T1 en_route" 200
api PATCH "/dispatch/$D_T1/status" "$T1_T" '{"status":"arrived"}'
expect_code "T1 arrived" 200
expect_eq "Incident #$INC2 now has TWO active dispatches (one arrived)" "$(db_one "SELECT COUNT(*) FROM dispatch WHERE incident_id=$INC2 AND status IN ('assigned','en_route','arrived');")" "2"

api PATCH "/dispatch/$D_T1/cancel" "$ADMIN_T" "{\"reason\":\"  $LONG255  \"}"
expect_code "Cancel an ARRIVED dispatch with a 255-char reason (trimmed, boundary accepted)" 200
expect_eq "  status cancelled" "$(jget "$BODY" status)" "cancelled"
expect_eq "  incident stays dispatched (second responder still active)" "$(jget "$BODY" incident_status)" "dispatched"
expect_eq "  DB incident status" "$(db_one "SELECT status FROM incident WHERE incident_id=$INC2;")" "dispatched"
expect_eq "  cancel_reason stored (trimmed to 255)" "$(db_one "SELECT CHAR_LENGTH(cancel_reason) FROM dispatch WHERE dispatch_id=$D_T1;")" "255"
expect_eq "  arrived_at kept (the arrival really happened)" "$(db_one "SELECT arrived_at IS NOT NULL FROM dispatch WHERE dispatch_id=$D_T1;")" "1"
expect_eq "  cancelled_by recorded" "$(db_one "SELECT cancelled_by FROM dispatch WHERE dispatch_id=$D_T1;")" "$ADMIN_ID"
CMETA=$(db_one "SELECT metadata_json FROM audit_log WHERE action='dispatch_cancelled' AND entity_id=$D_T1;")
expect_eq "  audit has_reason" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.has_reason') FROM audit_log WHERE action='dispatch_cancelled' AND entity_id=$D_T1;")" "true"
expect_eq "  audit reason_length" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.reason_length') FROM audit_log WHERE action='dispatch_cancelled' AND entity_id=$D_T1;")" "255"
expect_eq "  audit from_status" "$(db_one "SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'\$.from_status')) FROM audit_log WHERE action='dispatch_cancelled' AND entity_id=$D_T1;")" "arrived"
case "$CMETA" in *yyyyyyyyyy*) fail "AUDIT LEAK: cancel reason text in audit metadata";; *) pass "  audit metadata never contains the cancel reason text";; esac
api PATCH "/dispatch/$D_T1/cancel" "$ADMIN_T" '{"reason":"again"}'
expect_code "Cancelling an already-cancelled dispatch" 409

# Cancel the last active dispatch from ARRIVED -> incident back to pending, guard released, re-dispatch + resolve work
api PATCH "/dispatch/$D_T2/status" "$T2_T" '{"status":"en_route"}'; api PATCH "/dispatch/$D_T2/status" "$T2_T" '{"status":"arrived"}'
expect_code "T2 arrived" 200
api PATCH "/incidents/$INC2/status" "$ADMIN_T" '{"status":"resolved"}'
expect_code "Resolve is blocked while the arrived dispatch is active" 409
api PATCH "/dispatch/$D_T2/cancel" "$ADMIN_T" '{"reason":"Tanod found the call was a hoax"}'
expect_code "Cancel the LAST active dispatch while arrived" 200
expect_eq "  incident_status in response" "$(jget "$BODY" incident_status)" "pending"
expect_eq "  incident reverted to pending in the DB" "$(db_one "SELECT status FROM incident WHERE incident_id=$INC2;")" "pending"
expect_eq "  no active dispatch remains (resolve guard released)" "$(db_one "SELECT COUNT(*) FROM dispatch WHERE incident_id=$INC2 AND status IN ('assigned','en_route','arrived');")" "0"
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC2 $T2)"
expect_code "Same Tanod can be re-dispatched after the cancel" 201
D_T2B=$(jget "$BODY" dispatch_id)
for st in en_route arrived completed; do api PATCH "/dispatch/$D_T2B/status" "$T2_T" "{\"status\":\"$st\"}"; done
expect_code "Re-dispatch walked to completed" 200
api PATCH "/dispatch/$D_T2B/cancel" "$ADMIN_T" '{"reason":"too late"}'
expect_code "A COMPLETED dispatch cannot be cancelled" 409
api PATCH "/incidents/$INC2/status" "$ADMIN_T" '{"status":"resolved"}'
expect_code "Incident resolves once nothing is active" 200

step "5. GET /dispatch exposes cancel_reason to Admin and Punong Barangay only"
api GET "/dispatch?status=cancelled&limit=100" "$ADMIN_T" ""
expect_code "Admin GET /dispatch" 200
expect_eq "  Admin sees cancel_reason for the arrived-cancelled dispatch" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $r){ if($r["dispatch_id"]==(int)$argv[1]) echo $r["cancel_reason"]; }' "$D_T2")" "Tanod found the call was a hoax"
api GET "/dispatch?status=cancelled&limit=100" "$PB_T" ""
expect_eq "  Punong Barangay sees cancel_reason too" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $r){ if($r["dispatch_id"]==(int)$argv[1]) echo $r["cancel_reason"]; }' "$D_T2")" "Tanod found the call was a hoax"
api GET "/dispatch?limit=100" "$T2_T" ""
expect_eq "  Tanod's own list has NO cancel_reason key at all" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=0; foreach($d["items"] as $r){ if(array_key_exists("cancel_reason",$r)) $n++; } echo $n;')" "0"
expect_eq "  ... and the Tanod's own cancelled dispatch IS in that list" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=0; foreach($d["items"] as $r){ if($r["status"]==="cancelled") $n++; } echo $n;')" "1"
case "$BODY" in *"hoax"*) fail "LEAK: cancel reason text reached the Tanod's own dispatch list";; *) pass "  cancel reason text absent from the Tanod's response body";; esac

# ================================================================ shifts: secretary
step "6. Secretary may create/update shifts, but not publish without approve_roster"
D1=$("$PHP_BIN" -r 'echo gmdate("Y-m-d", time()+86400*3);')
api POST /shifts "$SEC_T" "{\"user_id\":$T4,\"start_at\":\"${D1}T08:00:00+08:00\",\"end_at\":\"${D1}T14:00:00+08:00\",\"request_id\":\"$(uuid)\",\"patrol_zone\":\"Purok 1\"}"
expect_code "Secretary POST /shifts" 201
SS_NEW=$(jget "$BODY" shift_id)
expect_eq "  new shift is a draft, pending_reapproval false in the response" "$(jget "$BODY" approval_status)/$(jget "$BODY" pending_reapproval)" "draft/false"
expect_eq "  created_by is the secretary" "$(db_one "SELECT created_by FROM shift_schedule WHERE shift_id=$SS_NEW;")" "$SEC_ID"
api PATCH "/shifts/$SS_NEW" "$SEC_T" '{"patrol_zone":"Purok 2","version":1}'
expect_code "Secretary PATCH /shifts/:id" 200
expect_eq "  patrol_zone changed" "$(db_one "SELECT patrol_zone FROM shift_schedule WHERE shift_id=$SS_NEW;")" "Purok 2"
expect_eq "  audit shift_updated actor is the secretary" "$(db_one "SELECT actor_user_id FROM audit_log WHERE action='shift_updated' AND entity_id=$SS_NEW LIMIT 1;")" "$SEC_ID"
api POST /shifts/publish "$SEC_T" "{\"shift_ids\":[$SS_NEW]}" -H "Idempotency-Key: $(uuid)"
expect_code "Secretary WITHOUT approve_roster cannot publish" 403
expect_eq "  shift still draft" "$(db_one "SELECT approval_status FROM shift_schedule WHERE shift_id=$SS_NEW;")" "draft"
api POST /shifts "$SEC2_T" "{\"user_id\":$T4,\"start_at\":\"${D1}T15:00:00+08:00\",\"end_at\":\"${D1}T16:00:00+08:00\",\"request_id\":\"$(uuid)\"}"
expect_code "Other-barangay Secretary cannot schedule this barangay's Tanod (generic 422)" 422
api PATCH "/shifts/$SS_NEW" "$SEC2_T" '{"patrol_zone":"x","version":2}'
expect_code "Other-barangay Secretary PATCH is 404" 404
api POST /shifts "$PB_T" "{\"user_id\":$T4,\"start_at\":\"${D1}T15:00:00+08:00\",\"end_at\":\"${D1}T16:00:00+08:00\",\"request_id\":\"$(uuid)\"}"
expect_code "Punong Barangay still cannot create shifts" 403
api POST /shifts "$T1_T" "{}"
expect_code "Tanod still cannot create shifts" 403
api PATCH "/shifts/$SS_NEW" "$T4_T" '{"patrol_zone":"x","version":2}'
expect_code "Tanod still cannot update shifts" 403
api GET /shifts "$SEC_T" ""
expect_code "Secretary GET /shifts (unchanged)" 200
api POST /shifts/publish "$PB_T" "{\"shift_ids\":[$SS_NEW]}" -H "Idempotency-Key: $(uuid)"
expect_code "PB holding approve_roster publishes the Secretary's draft" 200
expect_eq "  published" "$(db_one "SELECT approval_status FROM shift_schedule WHERE shift_id=$SS_NEW;")" "published"

# ================================================================ swaps
step "7. Swap review by Secretary; approved swap -> draft + pending_reapproval"
api POST /shift-swap-requests "$T1_T" "{\"shift_id\":$S1,\"target_user_id\":$T4,\"reason\":\"family event\",\"client_request_id\":\"$(uuid)\"}"
expect_code "T1 requests a swap on their PUBLISHED shift (target T4)" 201
SW1=$(jget "$BODY" request_id)
api GET /shift-swap-requests "$SEC_T" ""
expect_code "Secretary GET /shift-swap-requests" 200
expect_eq "  sees the pending request" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=0; foreach($d["items"] as $r){ if($r["request_id"]==(int)$argv[1]) $n++; } echo $n;' "$SW1")" "1"
api GET /shift-swap-requests "$SEC2_T" ""
expect_code "Other-barangay Secretary GET /shift-swap-requests" 200
expect_eq "  sees none of this barangay's requests (tenant-scoped)" "$(jget "$BODY" total)" "0"
api GET /shift-swap-requests "$PB_T" ""
expect_code "Punong Barangay GET /shift-swap-requests (still not allowed)" 403
api PATCH "/shift-swap-requests/$SW1" "$SEC2_T" '{"status":"approved","version":1}'
expect_code "Other-barangay Secretary PATCH swap is 404" 404
api PATCH "/shift-swap-requests/$SW1" "$T1_T" '{"status":"approved","version":1}'
expect_code "Tanod cannot approve a swap" 403
api PATCH "/shift-swap-requests/$SW1" "$PB_T" '{"status":"approved","version":1}'
expect_code "Punong Barangay cannot approve a swap" 403

api PATCH "/shift-swap-requests/$SW1" "$SEC_T" '{"status":"approved","version":1}'
expect_code "SECRETARY approves the swap" 200
expect_eq "  shift reassigned to T4, draft, approval cleared, pending_reapproval=1" \
  "$(db_one "SELECT CONCAT(user_id,'|',approval_status,'|',IFNULL(approved_by,'NULL'),'|',pending_reapproval) FROM shift_schedule WHERE shift_id=$S1;")" "$T4|draft|NULL|1"
expect_eq "  audit swap_request_resolved actor is the secretary" "$(db_one "SELECT actor_user_id FROM audit_log WHERE action='swap_request_resolved' AND entity_id=$SW1;")" "$SEC_ID"

api GET "/shifts?limit=100" "$T4_T" ""
expect_eq "New holder T4 SEES the awaiting-re-approval shift" "$(shift_visible "$BODY" $S1)" "1"
expect_eq "  its pending_reapproval is true" "$(shift_field "$BODY" $S1 pending_reapproval)" "true"
expect_eq "  its approval_status is draft" "$(shift_field "$BODY" $S1 approval_status)" "draft"
expect_eq "  every shift object carries the boolean (published one is false)" "$(shift_field "$BODY" $SS_NEW pending_reapproval)" "false"
api GET "/shifts?limit=100" "$T1_T" ""
expect_eq "Previous holder T1 no longer sees it" "$(shift_visible "$BODY" $S1)" "0"
api GET "/shifts?limit=100" "$T2_T" ""
expect_eq "An unrelated Tanod (T2) does not see it" "$(shift_visible "$BODY" $S1)" "0"
api GET "/shifts?limit=100" "$ADMIN_T" ""
expect_eq "Admin list shows pending_reapproval=true" "$(shift_field "$BODY" $S1 pending_reapproval)" "true"
api GET "/shifts?approval_status=draft&limit=100" "$SEC_T" ""
expect_eq "Secretary sees it under approval_status=draft" "$(shift_visible "$BODY" $S1)" "1"

api POST /shift-swap-requests "$T4_T" "{\"shift_id\":$S1,\"client_request_id\":\"$(uuid)\"}"
expect_code "New swap request on a pending_reapproval shift" 409
api POST /shift-swap-requests "$T3_T" "{\"shift_id\":$S3,\"client_request_id\":\"$(uuid)\"}"
expect_code "Swap request on an ordinary DRAFT shift (not pending) is still 404" 404

# dispatch does not count a pending_reapproval draft as a published shift
mysql_exec "$VALDB" -e "INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES (1,'theft','low','WA-INC-4','pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP());"
INC4=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='WA-INC-4';")
api POST /dispatch "$ADMIN_T" "$(dispatch_body $INC4 $T4)"
expect_code "A draft shift awaiting re-approval does not satisfy the dispatch shift rule" 422
expect_eq "  NO_PUBLISHED_SHIFT" "$(jget "$BODY" error.code)" "NO_PUBLISHED_SHIFT"

api POST /shifts/publish "$PB_T" "{\"shift_ids\":[$S1]}" -H "Idempotency-Key: $(uuid)"
expect_code "Re-approval: PB publishes the shift" 200
expect_eq "  published, pending_reapproval cleared, approved_by = PB" "$(db_one "SELECT CONCAT(approval_status,'|',pending_reapproval,'|',approved_by) FROM shift_schedule WHERE shift_id=$S1;")" "published|0|$PB_ID"
api GET "/shifts?limit=100" "$T4_T" ""
expect_eq "T4 sees it as published, pending false" "$(shift_field "$BODY" $S1 approval_status)/$(shift_field "$BODY" $S1 pending_reapproval)" "published/false"
api POST /shift-swap-requests "$T4_T" "{\"shift_id\":$S1,\"client_request_id\":\"$(uuid)\"}"
expect_code "T4 can request a swap on it again once re-published" 201
SW2=$(jget "$BODY" request_id)
api PATCH "/shift-swap-requests/$SW2" "$SEC_T" '{"status":"denied","version":1}'
expect_code "Secretary DENIES it" 200
expect_eq "  denied swap leaves the shift published, pending 0, owner T4" "$(db_one "SELECT CONCAT(user_id,'|',approval_status,'|',pending_reapproval) FROM shift_schedule WHERE shift_id=$S1;")" "$T4|published|0"

# unassigned swap (no target) also flags re-approval
api POST /shift-swap-requests "$T2_T" "{\"shift_id\":$S2,\"client_request_id\":\"$(uuid)\"}"
expect_code "T2 requests a release (no target) on S2" 201
SW3=$(jget "$BODY" request_id)
api PATCH "/shift-swap-requests/$SW3" "$ADMIN_T" '{"status":"approved","version":1}'
expect_code "Admin approves the release" 200
expect_eq "  S2 unassigned, draft, pending_reapproval=1" "$(db_one "SELECT CONCAT(IFNULL(user_id,'NULL'),'|',approval_status,'|',pending_reapproval) FROM shift_schedule WHERE shift_id=$S2;")" "NULL|draft|1"
api GET "/shifts?limit=100" "$T2_T" ""
expect_eq "  the releasing Tanod no longer sees it" "$(shift_visible "$BODY" $S2)" "0"

# other material edits keep today's behaviour: draft, hidden, flag stays 0
step "8. Other material edits: draft + hidden, pending_reapproval stays 0; reassigning a pending shift clears the flag"
api PATCH "/shifts/$SS_NEW" "$ADMIN_T" "{\"start_at\":\"${D1}T09:00:00+08:00\",\"version\":3}"
expect_code "Admin moves the start of a PUBLISHED shift (SS_NEW, owner T4)" 200
expect_eq "  reverted to draft, pending_reapproval 0" "$(db_one "SELECT CONCAT(approval_status,'|',pending_reapproval) FROM shift_schedule WHERE shift_id=$SS_NEW;")" "draft|0"
api GET "/shifts?limit=100" "$T4_T" ""
expect_eq "  owner does NOT see it (hidden, as before)" "$(shift_visible "$BODY" $SS_NEW)" "0"
api PATCH "/shifts/$S2" "$ADMIN_T" "{\"user_id\":$T6,\"version\":$(db_one "SELECT version FROM shift_schedule WHERE shift_id=$S2;")}"
expect_code "Admin assigns the released (pending_reapproval) shift S2 to T6" 200
expect_eq "  pending_reapproval cleared by the reassignment, still draft" "$(db_one "SELECT CONCAT(user_id,'|',approval_status,'|',pending_reapproval) FROM shift_schedule WHERE shift_id=$S2;")" "$T6|draft|0"
api GET "/shifts?limit=100" "$T6_T" ""
expect_eq "  T6 does not see it" "$(shift_visible "$BODY" $S2)" "0"

# ================================================================ backup.sh hold rule
step "9. backup.sh: ANY legal hold -> prune nothing; no hold -> age-based pruning; query error -> fail closed"
if ! command -v openssl >/dev/null 2>&1 || [ ! -x /c/xampp/mysql/bin/mysqldump.exe ]; then
  fail "openssl/mysqldump not available — cannot exercise backup.sh"
else
  BK_DIR="$TMP_DIR/backups"
  mkdir -p "$BK_DIR"
  mkold() { # name days_old
    local ts; ts="$(date -u -d "-$2 days" +%Y%m%dT%H%M%SZ)"
    : > "$BK_DIR/${VALDB}_${ts}.sql.enc"; : > "$BK_DIR/${VALDB}_${ts}.sql.enc.sha256"
    echo "$BK_DIR/${VALDB}_${ts}.sql.enc"
  }
  # root has an empty password here and backup.sh insists on a non-empty
  # DB_PASSWORD, so run it as the disposable app user. XAMPP's mysql client
  # goes first on PATH (this machine has an unrelated MySQL80 client too).
  run_backup_app() {
    ( export PATH="/c/xampp/mysql/bin:$PATH"
      BACKUP_DIR="$BK_DIR" BACKUP_RETENTION_DAYS=30 BACKUP_ENCRYPTION_PASSPHRASE="wave1a-check" \
      DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" \
      bash "$BACKEND_DIR/scripts/backup.sh" 2>&1 )
  }
  OLD_A=$(mkold a 90); OLD_B=$(mkold b 45); RECENT=$(mkold c 3)

  # (a) legal hold on ONE table (sms_log) -> nothing is deleted, even a backup older than every held record.
  mysql_exec "$VALDB" -e "INSERT INTO sms_log (barangay_id, sender_number, transport, message_type, direction, status, legal_hold, created_at) VALUES (1,'09170000099','gsm_modem','incident','inbound','received',1,UTC_TIMESTAMP());"
  OUT=$(run_backup_app)
  echo "$OUT" | grep -q "pruning NOTHING" && pass "Hold on sms_log: script says it prunes nothing" || fail "No 'pruning NOTHING' line: $OUT"
  { [ -e "$OLD_A" ] && [ -e "$OLD_B" ] && [ -e "$RECENT" ]; } && pass "  90-day-old and 45-day-old backups SURVIVE (old rule would have deleted ones older than the held row)" || fail "A backup was deleted despite an active legal hold"
  echo "$OUT" | grep -q "Deleting" && fail "A Deleting line was printed during a hold" || pass "  no 'Deleting' line printed"

  # (b) hold on a different table (incident) alone behaves the same.
  mysql_exec "$VALDB" -e "UPDATE sms_log SET legal_hold=0; UPDATE incident SET legal_hold=1 WHERE incident_id=$INC3;"
  OUT=$(run_backup_app)
  echo "$OUT" | grep -q "pruning NOTHING" && { [ -e "$OLD_A" ] && pass "Hold on incident alone also prunes nothing"; } || fail "Hold on incident did not stop pruning: $OUT"

  # (c) no hold anywhere -> existing age-based pruning
  mysql_exec "$VALDB" -e "UPDATE incident SET legal_hold=0;"
  OUT=$(run_backup_app)
  echo "$OUT" | grep -q "No legal hold" && pass "No hold: script reports normal pruning" || fail "Expected 'No legal hold' line: $OUT"
  { [ ! -e "$OLD_A" ] && [ ! -e "${OLD_A}.sha256" ] && [ ! -e "$OLD_B" ]; } && pass "  backups older than 30 days (and their .sha256) were deleted" || fail "Old backups survived without any hold"
  [ -e "$RECENT" ] && pass "  the 3-day-old backup survived" || fail "The recent backup was deleted"

  # (d) hold query cannot run (table missing) -> fail closed, nothing pruned
  OLD_C=$(mkold d 120)
  mysql_exec "$VALDB" -e "ALTER TABLE sms_log RENAME TO sms_log_gone;"
  OUT=$(run_backup_app)
  mysql_exec "$VALDB" -e "ALTER TABLE sms_log_gone RENAME TO sms_log;"
  echo "$OUT" | grep -q "could not check legal_hold" && pass "Query error: warns and skips pruning" || fail "No fail-closed warning: $OUT"
  [ -e "$OLD_C" ] && pass "  120-day-old backup survives a failed hold check (fail closed)" || fail "Backup deleted although the hold check failed"
fi

step "SUMMARY"
echo "$PASS passed, $FAIL failed."
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
