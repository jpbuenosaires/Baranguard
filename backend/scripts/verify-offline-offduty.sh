#!/usr/bin/env bash
# Baranguard — offline OFF-duty (closes WORKFLOWS_AND_RULES assumption A4).
#
# Going OFF duty may be queued on the device while offline and reach the
# server later through POST /sync/batch's `duty_status_updates[]`, carrying
# the device's real tap time as `changed_at`. Going ON duty stays
# online-only. This suite proves the server side:
#
#   - a back-dated off-duty is recorded at the CLIENT time, not arrival time
#   - a future time (beyond the 5-minute skew) is rejected
#   - a time before the Tanod's last on_duty record is rejected
#   - a time older than 62 days is rejected
#   - changed_at is refused for on_duty (going on duty stays online-only)
#   - replaying the same client_event_id is idempotent (one row)
#   - an active dispatch on the server rejects it (a 'failed' sync result,
#     which the app treats as non-transient)
#   - the suggested duty duration (accomplishment entries) ends at the
#     client time, including entries written BEFORE the off-duty synced
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage: bash backend/scripts/verify-offline-offduty.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }
expect_contains() { case "$1" in *"$2"*) pass "$3";; *) fail "$3 — '$1' does not contain '$2'";; esac; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_offline_offduty_check"
APP_USER="ooffchk_app"
APP_PASSWORD="OffDutyChk!2026"
API_PORT="${API_PORT_OVERRIDE:-8641}"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="OffDuty#2026Pw"
DEVICE_ID="ooff-device-0001"

echo "Baranguard offline off-duty verification — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"; PHP_BIN="$(find_bin php)"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
db_one() { mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null; }
body_for() { # method path token body [extra_header]
  local args=(-s -X "$1" "$BASE_URL$2" -H "Authorization: Bearer $3")
  [ -n "${5:-}" ] && args+=(-H "$5")
  [ -n "${4:-}" ] && args+=(-H 'Content-Type: application/json' -d "$4")
  curl "${args[@]}"
}
code_for() {
  local args=(-s -o /dev/null -w '%{http_code}' -X "$1" "$BASE_URL$2" -H "Authorization: Bearer $3")
  [ -n "${5:-}" ] && args+=(-H "$5")
  [ -n "${4:-}" ] && args+=(-H 'Content-Type: application/json' -d "$4")
  curl "${args[@]}"
}
json_field() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $v=$d; foreach(explode(".",$argv[1]) as $p){$v=is_array($v)?($v[$p]??null):null;} echo $v===null?"null":(is_scalar($v)?$v:json_encode($v));' "$1"; }
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }
# Manila date N days from today, and a Manila wall-clock time on a date as UTC 'Y-m-d H:i:s'.
dman() { "$PHP_BIN" -r 'date_default_timezone_set("Asia/Manila"); echo date("Y-m-d", strtotime($argv[1]));' -- "$1"; }
mu() { "$PHP_BIN" -r '$d=new DateTime($argv[1]." ".$argv[2]." +08:00"); $d->setTimezone(new DateTimeZone("UTC")); echo $d->format("Y-m-d H:i:s");' "$1" "$2"; }
# ISO-8601 UTC for "now + N seconds".
iso_in() { "$PHP_BIN" -r 'echo gmdate("Y-m-d\TH:i:s\Z", time() + (int)$argv[1]);' -- "$1"; }

DEVHDR="X-Device-Id: $DEVICE_ID"
# sync_off <client_event_id> <changed_at|-> [status]  -> prints the batch response
sync_off() {
  local item
  if [ "$2" = "-" ]; then
    item="{\"status\":\"${3:-off_duty}\",\"client_event_id\":\"$1\"}"
  else
    item="{\"status\":\"${3:-off_duty}\",\"client_event_id\":\"$1\",\"changed_at\":\"$2\"}"
  fi
  body_for POST /sync/batch "$TANOD" "{\"device_id\":\"$DEVICE_ID\",\"duty_status_updates\":[$item]}" "$DEVHDR"
}

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.ooffchk-server.log"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

step "0. Setup — disposable schema, an Admin + a Tanod, a registered device"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain applied"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'ooff_admin','$HASH','OOff Admin','admin',1,UTC_TIMESTAMP()),
 (1,'ooff_tanod','$HASH','OOff Tanod','tanod',1,UTC_TIMESTAMP());
SQL
ADMIN_ID=$(db_one "SELECT user_id FROM user WHERE username='ooff_admin';")
TANOD_ID=$(db_one "SELECT user_id FROM user WHERE username='ooff_tanod';")
mysql_exec "$VALDB" -e "INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES ('$DEVICE_ID', $TANOD_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());"

# Day D (3 Manila days ago): the Tanod went on duty at 08:00 and — offline —
# off duty at 12:00. The server only has the on_duty row so far.
D=$(dman "-3 days"); D1=$(dman "-2 days")
mysql_exec "$VALDB" -e "INSERT INTO duty_status (user_id, status, channel, client_event_id, changed_at) VALUES ($TANOD_ID,'on_duty','app',NULL,'$(mu "$D" "08:00")');"
pass "Seeded: tanod #$TANOD_ID on_duty since $D 08:00 Manila (never went off duty on the server)"

( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="ooffchk-verify-secret-key-not-real-0123456789" \
  exec "$PHP_BIN" -S 127.0.0.1:$API_PORT -t public public/dev-router.php > "$BACKEND_DIR/scripts/.ooffchk-server.log" 2>&1 ) &
# `exec` makes SERVER_PID the PHP server itself, so cleanup's `kill` stops it
# on Linux too (otherwise it outlives the run and keeps any flock held).
SERVER_PID=$!
sleep 2

token_for() {
  curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | json_field token
}
ADMIN=$(token_for ooff_admin); TANOD=$(token_for ooff_tanod)
[ -n "$ADMIN" ] && [ "$ADMIN" != "null" ] && [ -n "$TANOD" ] && [ "$TANOD" != "null" ] && pass "Tokens acquired" || { fail "Login failed — see .ooffchk-server.log"; exit 1; }

mkentry() { # work_date duration -> prints response
  body_for POST /accomplishment-entries "$TANOD" "{\"work_date\":\"$1\",\"accomplishment_text\":\"Patrol log $1\",\"duration_minutes\":$2,\"client_event_id\":\"$(uuid)\"}" "$DEVHDR"
}

# ============================================================
step "1. Before the queued off-duty arrives: the open shift inflates the suggestion"
# ============================================================
E_D=$(mkentry "$D" 240)
E_D_ID=$(echo "$E_D" | json_field entry.entry_id)
expect_eq "$(echo "$E_D" | json_field entry.suggested_duration_minutes)" "960" "Entry for D written while the shift still looks open: suggested 08:00-24:00"
expect_eq "$(echo "$E_D" | json_field entry.duration_flag)" "1" "  ...and the Tanod's honest 240 is flagged against it"
E_D1=$(mkentry "$D1" 60)
E_D1_ID=$(echo "$E_D1" | json_field entry.entry_id)
expect_eq "$(echo "$E_D1" | json_field entry.suggested_duration_minutes)" "1440" "Entry for D+1: the open shift counts the whole day"

# ============================================================
step "2. Rejections — the item fails (non-transient) and writes no row"
# ============================================================
ROWS_BEFORE=$(db_one "SELECT COUNT(*) FROM duty_status WHERE user_id=$TANOD_ID;")

FUT_ID=$(uuid)
R=$(sync_off "$FUT_ID" "$(iso_in 3600)")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "Off-duty dated 1 hour in the future is rejected"
expect_contains "$(echo "$R" | json_field results.0.reason)" "future" "  reason names the future time"

BEFORE_ID=$(uuid)
R=$(sync_off "$BEFORE_ID" "${D}T07:00:00+08:00")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "Off-duty dated before the last on_duty record (07:00 < 08:00) is rejected"
expect_contains "$(echo "$R" | json_field results.0.reason)" "last on-duty" "  reason names the last on-duty record"

OLD_ID=$(uuid)
R=$(sync_off "$OLD_ID" "$(iso_in -6048000)")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "Off-duty dated 70 days ago (older than 62 days) is rejected"

BAD_ID=$(uuid)
R=$(sync_off "$BAD_ID" "yesterday-ish")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "Malformed changed_at is rejected"

ON_ID=$(uuid)
R=$(sync_off "$ON_ID" "${D}T13:00:00+08:00" "on_duty")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "A client-dated ON duty is refused (going on duty stays online-only)"

expect_eq "$(db_one "SELECT COUNT(*) FROM duty_status WHERE user_id=$TANOD_ID;")" "$ROWS_BEFORE" "None of the rejected items wrote a duty_status row"
expect_eq "$(db_one "SELECT reconciliation_status FROM offline_queue WHERE client_event_id='$FUT_ID';")" "failed" "Server sync ledger marks the rejected item 'failed'"

# ============================================================
step "3. Back-dated off-duty recorded at the CLIENT time"
# ============================================================
OFF_ID=$(uuid)
R=$(sync_off "$OFF_ID" "${D}T12:00:00+08:00")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "Queued off-duty (D 12:00 Manila) syncs"
OFF_SERVER_ID=$(echo "$R" | json_field results.0.server_id)
expect_eq "$(db_one "SELECT changed_at FROM duty_status WHERE client_event_id='$OFF_ID';")" "$(mu "$D" "12:00")" "duty_status.changed_at is the client time (D 12:00 Manila), not the arrival time"
expect_eq "$(db_one "SELECT CONCAT(status,'/',channel) FROM duty_status WHERE client_event_id='$OFF_ID';")" "off_duty/app" "Row is off_duty via the app channel"
CUR=$(body_for GET "/duty-status?barangay_id=1" "$ADMIN")
expect_contains "$CUR" "\"user_id\":$TANOD_ID,\"status\":\"off_duty\"" "Admin's current-status view shows the Tanod off duty"

# ============================================================
step "4. Replay is idempotent"
# ============================================================
R=$(sync_off "$OFF_ID" "${D}T12:00:00+08:00")
expect_eq "$(echo "$R" | json_field results.0.status)" "duplicate" "Re-sending the same queued item answers 'duplicate'"
expect_eq "$(echo "$R" | json_field results.0.server_id)" "$OFF_SERVER_ID" "  ...pointing at the original row"
expect_eq "$(db_one "SELECT COUNT(*) FROM duty_status WHERE client_event_id='$OFF_ID';")" "1" "Still exactly one row for that client_event_id"
DIRECT=$(body_for POST /duty-status "$TANOD" "{\"status\":\"off_duty\",\"client_event_id\":\"$OFF_ID\"}")
expect_eq "$(echo "$DIRECT" | json_field status_id)" "$OFF_SERVER_ID" "The same event id via POST /duty-status (response lost, retried live) returns the same row"

# ============================================================
step "5. Suggested duration uses the recorded off-duty time"
# ============================================================
expect_eq "$(db_one "SELECT suggested_duration_minutes FROM accomplishment_entry WHERE entry_id=$E_D_ID;")" "240" "Entry for D written BEFORE the sync is refreshed to 08:00-12:00 = 240"
expect_eq "$(db_one "SELECT duration_flag FROM accomplishment_entry WHERE entry_id=$E_D_ID;")" "0" "  ...and its mismatch flag clears"
expect_eq "$(db_one "SELECT suggested_duration_minutes FROM accomplishment_entry WHERE entry_id=$E_D1_ID;")" "0" "Entry for D+1 is refreshed to 0 (the shift ended on D)"
E_D_NEW=$(mkentry "$D" 30)
expect_eq "$(echo "$E_D_NEW" | json_field entry.suggested_duration_minutes)" "240" "A new entry for D also suggests 240"

# ============================================================
step "6. Active dispatch on the server rejects the queued off-duty"
# ============================================================
mysql_exec "$VALDB" -e "INSERT INTO duty_status (user_id, status, channel, client_event_id, changed_at) VALUES ($TANOD_ID,'on_duty','app',NULL, UTC_TIMESTAMP() - INTERVAL 2 HOUR);"
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
 (1, $ADMIN_ID, 'theft','normal','ooffchk dispatch raw','dispatched','web',UTC_TIMESTAMP(),UTC_TIMESTAMP());
SQL
INC_ID=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='ooffchk dispatch raw';")
mysql_exec "$VALDB" -e "INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, status, dispatched_at, created_client_request_id) VALUES ($INC_ID, $ADMIN_ID, $TANOD_ID, 'normal','en_route',UTC_TIMESTAMP(),UUID());"
DISP_ID=$(uuid)
R=$(sync_off "$DISP_ID" "$(iso_in -1800)")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "Queued off-duty is rejected while a dispatch is en_route"
expect_contains "$(echo "$R" | json_field results.0.reason)" "dispatch" "  reason names the active dispatch"
expect_eq "$(db_one "SELECT COUNT(*) FROM duty_status WHERE client_event_id='$DISP_ID';")" "0" "  ...and wrote no row"
expect_eq "$(db_one "SELECT status FROM duty_status WHERE user_id=$TANOD_ID ORDER BY changed_at DESC, status_id DESC LIMIT 1;")" "on_duty" "  ...so the Tanod is still on duty on the server"

# ============================================================
step "7. Small forward clock skew is tolerated, but never stored in the future"
# ============================================================
mysql_exec "$VALDB" -e "UPDATE dispatch SET status='completed', completed_at=UTC_TIMESTAMP() WHERE incident_id=$INC_ID;"
SKEW_ID=$(uuid)
R=$(sync_off "$SKEW_ID" "$(iso_in 120)")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "Off-duty 2 minutes ahead of the server clock is accepted"
expect_eq "$(db_one "SELECT changed_at <= UTC_TIMESTAMP() FROM duty_status WHERE client_event_id='$SKEW_ID';")" "1" "  ...stored at (clamped to) the server time, not in the future"

# ============================================================
step "8. Live POST /duty-status is unchanged (server time, no changed_at)"
# ============================================================
LIVE_ID=$(uuid)
expect_eq "$(code_for POST /duty-status "$TANOD" "{\"status\":\"on_duty\",\"client_event_id\":\"$LIVE_ID\"}")" "201" "Live on_duty toggle still works"
expect_eq "$(db_one "SELECT ABS(TIMESTAMPDIFF(SECOND, changed_at, UTC_TIMESTAMP())) < 60 FROM duty_status WHERE client_event_id='$LIVE_ID';")" "1" "  ...recorded at server time"

echo
echo "==================== RESULT ===================="
echo "$PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ] || exit 1
