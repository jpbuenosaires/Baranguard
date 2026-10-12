#!/usr/bin/env bash
# Baranguard — thesis objective 2 (offline-first sync): pins down what
# POST /sync/batch actually does when a record created/changed offline reaches
# a server whose state has moved on. Companion to docs/OFFLINE_SYNC_CONFLICT_RULES.md
# (every [PASS] line here backs a row in that document; a [FAIL] means the
# document is wrong or the product changed).
#
# This suite adds only what verify-sprint3.sh does NOT already cover (same-event
# replay of incident/gps and the 2-day-old GPS case are covered there):
#   dispatch cancelled/advanced/completed by an Admin before the Tanod's queued
#   status arrives; out-of-order status steps; the dispatch_status ledger
#   (dispatch has no client_event_id column); retry of a failed item; SOS-first
#   ordering; the 200-item cap; device_offline_created_at handling; expired /
#   revoked / wrong-owner sessions; the 7-day device-session cap; late GPS and
#   SOS pointing at a no-longer-active dispatch; client event times (created_offline_at) and
#   implausible incident dates (step 7b).
#
# It changes no product code (it only exercises it). Server-side "state moved on" is produced through
# the real Admin endpoints where one exists (PATCH /dispatch/:id/cancel,
# PATCH /dispatch/:id/status with override_reason); where none exists
# (incident resolved, session clock) it is a direct SQL UPDATE on the
# disposable database, and the document says so.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage: bash backend/scripts/verify-offline-sync-conflicts.sh
# Env overrides: XAMPP_MYSQL_HOST/PORT/USER/PASSWORD (admin account that can
# CREATE DATABASE / CREATE USER), PHP_BIN, MYSQL_BIN.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }
expect_contains() { if [[ "$1" == *"$2"* ]]; then pass "$3"; else fail "$3 — '$2' not found in: $1"; fi; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_syncrules_check"
APP_USER="syncrules_app"
APP_PASSWORD="SyncRules!2026"
API_PORT="8176"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="SyncRules#2026Pw"

echo "Baranguard offline-sync conflict-rule verification — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  echo ""
}
MYSQL_BIN="${MYSQL_BIN:-$(find_bin mysql)}"; PHP_BIN="${PHP_BIN:-$(find_bin php)}"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
db_one() { mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null; }
code_for() { # method url [token] [body] [extra_header]
  local method="$1" url="$2" token="${3:-}" body="${4:-}" hdr="${5:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$hdr" ] && args+=(-H "$hdr")
  # Body goes through stdin: a 200-item batch (~35 KB) exceeds the Windows 32 KB command-line limit as a -d argument.
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary @-)
    printf '%s' "$body" | curl "${args[@]}"
  else
    curl "${args[@]}"
  fi
}
body_for() {
  local method="$1" url="$2" token="${3:-}" body="${4:-}" hdr="${5:-}"
  local args=(-s -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$hdr" ] && args+=(-H "$hdr")
  # Body goes through stdin: a 200-item batch (~35 KB) exceeds the Windows 32 KB command-line limit as a -d argument.
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary @-)
    printf '%s' "$body" | curl "${args[@]}"
  else
    curl "${args[@]}"
  fi
}
json_field() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=explode(".",$argv[1]); $v=$d; foreach($k as $p){$v=is_array($v)?($v[$p]??null):null;} echo is_scalar($v)?$v:json_encode($v);' "$1"; }
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }
iso_ago() { date -u -d "-$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-"$1" +%Y-%m-%dT%H:%M:%SZ; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.syncrules-server.log"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

step "0. Setup — one barangay, an Admin, two Tanods, one registered device (Tanod A)"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort | awk -v s=0001_baseline_schema '$0 >= s'); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain applied"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'sr_admin','$HASH','SR Admin','admin',1,UTC_TIMESTAMP()),
 (1,'sr_tanod','$HASH','SR Tanod A','tanod',1,UTC_TIMESTAMP()),
 (1,'sr_tanod_b','$HASH','SR Tanod B','tanod',1,UTC_TIMESTAMP());
SQL
ADMIN_ID=$(db_one "SELECT user_id FROM user WHERE username='sr_admin';")
TANOD_ID=$(db_one "SELECT user_id FROM user WHERE username='sr_tanod';")
OTHER_ID=$(db_one "SELECT user_id FROM user WHERE username='sr_tanod_b';")

# Mobile device ids are and-<uuid>; only that shape earns a 24h/7d DEVICE session.
DEVICE_ID="and-$(uuid)"
mysql_exec "$VALDB" -e "INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES ('$DEVICE_ID', $TANOD_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());"

new_dispatch() { # tanod_id -> prints dispatch_id (fresh incident + 'assigned' dispatch)
  local tid="$1" tag="sr-$(uuid)"
  mysql_exec "$VALDB" -e "INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, latitude, longitude, created_at, updated_at) VALUES (1, $ADMIN_ID, 'theft','normal','$tag','dispatched','app',12.9,123.6,UTC_TIMESTAMP(),UTC_TIMESTAMP());"
  local inc; inc=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='$tag';")
  mysql_exec "$VALDB" -e "INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, status, dispatched_at, created_client_request_id) VALUES ($inc, $ADMIN_ID, $tid, 'normal','assigned',UTC_TIMESTAMP(),UUID());"
  db_one "SELECT dispatch_id FROM dispatch WHERE incident_id=$inc;"
}

( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="syncrules-verify-secret-key-not-real-0123456789" \
  "$PHP_BIN" -S 127.0.0.1:$API_PORT -t public public/dev-router.php > "$BACKEND_DIR/scripts/.syncrules-server.log" 2>&1 ) &
SERVER_PID=$!
sleep 2

DEVHDR="X-Device-Id: $DEVICE_ID"
login_body() { curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' ${2:+-H "$2"} -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}"; }
ADMIN=$(login_body sr_admin | json_field token)
TANOD=$(login_body sr_tanod "$DEVHDR" | json_field token)     # DEVICE session (device header at login)
[ -n "$ADMIN" ] && [ -n "$TANOD" ] && pass "Tokens acquired (admin web session, tanod device session)" || { fail "Login failed — see .syncrules-server.log"; exit 1; }
expect_eq "$(db_one "SELECT session_kind FROM auth_session WHERE user_id=$TANOD_ID ORDER BY session_id DESC LIMIT 1;")" "device" "Login with an and-<uuid> X-Device-Id header creates a 'device' session (24h sliding / 7d cap)"

sync() { body_for POST "$BASE_URL/sync/batch" "${2:-$TANOD}" "$1" "$DEVHDR"; }
sync_code() { code_for POST "$BASE_URL/sync/batch" "${2:-$TANOD}" "$1" "$DEVHDR"; }
ds_item() { echo "{\"dispatch_id\":$1,\"status\":\"$2\",\"client_event_id\":\"$3\"}"; }
batch_ds() { echo "{\"device_id\":\"$DEVICE_ID\",\"dispatch_status_updates\":[$1]}"; }

# ============================================================
step "1. Same event sent twice"
# ============================================================
INC_E=$(uuid)
B="{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"first version\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$INC_E\"}]}"
R=$(sync "$B")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "incident: first send"
B2="{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"fire\",\"raw_narrative\":\"EDITED version\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$INC_E\"}]}"
R=$(sync "$B2")
expect_eq "$(echo "$R" | json_field results.0.status)" "duplicate" "incident: same client_event_id with DIFFERENT content -> 'duplicate'"
expect_eq "$(db_one "SELECT CONCAT(incident_type,'|',raw_narrative) FROM incident WHERE client_event_id='$INC_E';")" "theft|first version" "...and the stored row is NOT overwritten (first write wins; no merge)"

DP1=$(new_dispatch "$TANOD_ID")
E1=$(uuid)
R=$(sync "$(batch_ds "$(ds_item "$DP1" en_route "$E1")")")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "dispatch_status: first send applies assigned -> en_route"
R=$(sync "$(batch_ds "$(ds_item "$DP1" en_route "$E1")")")
expect_eq "$(echo "$R" | json_field results.0.status)" "duplicate" "dispatch_status: same event again -> 'duplicate' (offline_queue ledger; dispatch has no client_event_id column)"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='dispatch_status_changed' AND entity_id=$DP1;")" "1" "...and exactly one dispatch_status_changed audit row (no second side effect)"

SOS_E=$(uuid)
SB="{\"device_id\":\"$DEVICE_ID\",\"sos\":[{\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$SOS_E\"}]}"
sync "$SB" >/dev/null; R=$(sync "$SB")
expect_eq "$(echo "$R" | json_field results.0.status)" "duplicate" "sos: same event again -> 'duplicate'"
expect_eq "$(db_one "SELECT COUNT(*) FROM tanod_sos WHERE client_event_id='$SOS_E';")" "1" "...exactly one tanod_sos row (one alarm)"

# The ledger is keyed on (device_id, client_event_id) ONLY, not on payload kind.
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"gps_tracks\":[{\"latitude\":13.0,\"longitude\":123.7,\"accuracy_m\":10,\"recorded_at\":\"$(now_iso)\",\"client_event_id\":\"$INC_E\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)" "duplicate" "INFO: a GPS item reusing an INCIDENT's client_event_id is answered 'duplicate' and silently NOT stored (ledger ignores payload kind)"
expect_eq "$(db_one "SELECT COUNT(*) FROM gps_track WHERE client_event_id='$INC_E';")" "0" "...no gps_track row was written for it"

# ============================================================
step "2. Incident created offline after the server-side incident moved on"
# ============================================================
# No endpoint lets a phone EDIT an incident, so the only offline->server
# collision is the replay of the create. Server state is changed by SQL here.
mysql_exec "$VALDB" -e "UPDATE incident SET status='resolved', raw_narrative='ADMIN EDIT' WHERE client_event_id='$INC_E';"
R=$(sync "$B")
expect_eq "$(echo "$R" | json_field results.0.status)" "duplicate" "replay of a create whose incident is now resolved -> 'duplicate'"
expect_eq "$(db_one "SELECT CONCAT(status,'|',raw_narrative) FROM incident WHERE client_event_id='$INC_E';")" "resolved|ADMIN EDIT" "...server state is untouched (never reopened, never overwritten)"

# ============================================================
step "3. Dispatch status arriving after an Admin cancelled / advanced / completed it"
# ============================================================
DPC=$(new_dispatch "$TANOD_ID")
CODE=$(code_for PATCH "$BASE_URL/dispatch/$DPC/cancel" "$ADMIN" '{"reason":"sync-rules test cancel"}')
expect_eq "$CODE" "200" "Admin cancels the dispatch while the Tanod is offline"
EC=$(uuid)
R=$(sync "$(batch_ds "$(ds_item "$DPC" en_route "$EC")")")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "queued en_route after cancel -> item 'failed'"
expect_contains "$(echo "$R" | json_field results.0.reason)" "Cannot transition from cancelled" "...reason names the conflict"
expect_eq "$(db_one "SELECT status FROM dispatch WHERE dispatch_id=$DPC;")" "cancelled" "...dispatch stays cancelled"
expect_eq "$(db_one "SELECT reconciliation_status FROM offline_queue WHERE client_event_id='$EC';")" "failed" "...server ledger row is 'failed' (not 'success')"
R=$(sync "$(batch_ds "$(ds_item "$DPC" en_route "$EC")")")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "re-sending the same failed event is re-evaluated (still 'failed'), never turned into 'duplicate'"

DPD=$(new_dispatch "$TANOD_ID")
for s in en_route arrived completed; do code_for PATCH "$BASE_URL/dispatch/$DPD/status" "$ADMIN" "{\"status\":\"$s\",\"override_reason\":\"sync-rules admin completes\"}" >/dev/null; done
expect_eq "$(db_one "SELECT status FROM dispatch WHERE dispatch_id=$DPD;")" "completed" "Admin completes the dispatch (3 override steps) while the Tanod is offline"
R=$(sync "$(batch_ds "$(ds_item "$DPD" arrived "$(uuid)")")")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "queued 'arrived' after server already 'completed' -> 'failed' (never moves backward)"
R=$(sync "$(batch_ds "$(ds_item "$DPD" completed "$(uuid)")")")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "queued 'completed' when server already 'completed' -> reported 'success' (no-op replay, nothing changed)"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='dispatch_status_changed' AND entity_id=$DPD;")" "0" "...and no Tanod-attributed audit row is written for that no-op"

DPE=$(new_dispatch "$TANOD_ID")
code_for PATCH "$BASE_URL/dispatch/$DPE/status" "$ADMIN" '{"status":"en_route","override_reason":"sync-rules admin en_route"}' >/dev/null
R=$(sync "$(batch_ds "$(ds_item "$DPE" en_route "$(uuid)")")")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "Admin already set en_route; Tanod's queued en_route -> 'success' (no-op)"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='dispatch_status_override' AND entity_id=$DPE;")" "1" "...the Admin 'dispatch_status_override' audit row is the only record (sync never writes an override)"

DPF=$(new_dispatch "$TANOD_ID")
R=$(sync "$(batch_ds "$(ds_item "$DPF" arrived "$(uuid)"),$(ds_item "$DPF" en_route "$(uuid)")")")
expect_eq "$(echo "$R" | json_field results.0.status)/$(echo "$R" | json_field results.1.status)" "failed/success" "OUT OF ORDER in one batch [arrived, en_route]: processed in array order -> arrived fails, en_route succeeds (no re-sorting)"
DPG=$(new_dispatch "$TANOD_ID")
R=$(sync "$(batch_ds "$(ds_item "$DPG" en_route "$(uuid)"),$(ds_item "$DPG" arrived "$(uuid)"),$(ds_item "$DPG" completed "$(uuid)")")")
expect_eq "$(echo "$R" | json_field results.0.status)/$(echo "$R" | json_field results.1.status)/$(echo "$R" | json_field results.2.status)" "success/success/success" "IN ORDER [en_route, arrived, completed] in one batch -> all succeed"

DPO=$(new_dispatch "$OTHER_ID")
R=$(sync "$(batch_ds "$(ds_item "$DPO" en_route "$(uuid)")")")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "status update for ANOTHER Tanod's dispatch -> 'failed' (ownership)"

# ============================================================
step "4. GPS / SOS / duty status arriving long after they were recorded"
# ============================================================
GE=$(uuid); OLD=$(iso_ago "3 days")
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"gps_tracks\":[{\"latitude\":13.0,\"longitude\":123.7,\"accuracy_m\":10,\"recorded_at\":\"$OLD\",\"dispatch_id\":$DPC,\"client_event_id\":\"$GE\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "3-day-old GPS point for a CANCELLED dispatch is accepted"
expect_eq "$(db_one "SELECT dispatch_id FROM gps_track WHERE client_event_id='$GE';")" "$DPC" "...and stays linked to that (cancelled) dispatch"
expect_eq "$(db_one "SELECT IF(recorded_at < received_at - INTERVAL 2 DAY,'yes','no') FROM gps_track WHERE client_event_id='$GE';")" "yes" "...recorded_at keeps the device time; received_at is the server time"

SE=$(uuid)
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"sos\":[{\"latitude\":13.0,\"longitude\":123.7,\"dispatch_id\":$DPC,\"client_event_id\":\"$SE\",\"created_offline_at\":\"$OLD\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "late SOS pointing at a cancelled dispatch is still accepted"
expect_eq "$(db_one "SELECT COALESCE(dispatch_id,'NULL') FROM tanod_sos WHERE client_event_id='$SE';")" "NULL" "...stale dispatch link dropped to NULL, alarm kept"
expect_eq "$(db_one "SELECT IF(triggered_at < UTC_TIMESTAMP() - INTERVAL 2 DAY,'device-time','server-now') FROM tanod_sos WHERE client_event_id='$SE';")" "device-time" "FIXED (gap 2): triggered_at is the device's created_offline_at (3 days old, plausible); received_at stays server time"

DE1=$(uuid); DE2=$(uuid)
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"duty_status_updates\":[{\"status\":\"on_duty\",\"client_event_id\":\"$DE1\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "duty_status item accepted via /sync/batch (server-side path; the mobile app currently sends this array empty)"
expect_eq "$(db_one "SELECT IF(changed_at > UTC_TIMESTAMP() - INTERVAL 1 MINUTE,'server-now','other') FROM duty_status WHERE client_event_id='$DE1';")" "server-now" "duty_status item without created_offline_at: changed_at is the server receive time (unchanged behaviour)"
DPA=$(new_dispatch "$TANOD_ID")
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"duty_status_updates\":[{\"status\":\"off_duty\",\"client_event_id\":\"$DE2\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "off_duty while a dispatch is still active -> 'failed' (409 on current server state)"

# ============================================================
step "5. Clock: device_offline_created_at vs server clock"
# ============================================================
CE=$(uuid)
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"old\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$CE\",\"device_offline_created_at\":\"$OLD\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "incident with 3-day-old device_offline_created_at accepted"
expect_eq "$(db_one "SELECT IF(device_offline_created_at < created_at - INTERVAL 2 DAY,'yes','no') FROM incident WHERE client_event_id='$CE';")" "yes" "...created_at = server receive time; device_offline_created_at kept separately"
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"bad ts\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$(uuid)\",\"device_offline_created_at\":\"not-a-date\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "FIXED (gap 4): unparseable device_offline_created_at -> item still accepted (stored NULL, see step 7b)"
FE=$(uuid)
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"future ts\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$FE\",\"device_offline_created_at\":\"2099-01-01T00:00:00Z\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "FIXED (gap 4): a 2099 device_offline_created_at no longer rejects the incident"
expect_eq "$(db_one "SELECT COALESCE(device_offline_created_at,'NULL') FROM incident WHERE client_event_id='$FE';")" "NULL" "...and the bogus 2099 value is NOT stored (NULL)"
FUT_GPS=$(sync "{\"device_id\":\"$DEVICE_ID\",\"gps_tracks\":[{\"latitude\":13.0,\"longitude\":123.7,\"accuracy_m\":10,\"recorded_at\":\"2099-01-01T00:00:00Z\",\"client_event_id\":\"$(uuid)\"}]}")
expect_eq "$(echo "$FUT_GPS" | json_field results.0.status)" "failed" "GPS recorded_at in the future -> 'failed' (a wrong device clock is rejected for GPS)"

# ============================================================
step "6. A failed item: reason recorded, retry allowed, no server-side cap"
# ============================================================
RE=$(uuid)
BAD="{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"NOT_A_TYPE\",\"raw_narrative\":\"x\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$RE\"}]}"
R=$(sync "$BAD")
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "invalid item -> 'failed' with a reason"
expect_contains "$(echo "$R" | json_field results.0.reason)" "incident_type must be one of" "...reason text is returned to the client"
expect_eq "$(db_one "SELECT reconciliation_status FROM offline_queue WHERE client_event_id='$RE';")" "failed" "...server ledger row = failed"
for i in 1 2 3 4 5 6 7; do R=$(sync "$BAD"); done
expect_eq "$(echo "$R" | json_field results.0.status)" "failed" "...still 'failed' after 8 total sends: the server never gives up or drops it (the 5-attempt cap is client-side only)"
GOOD="{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"fixed\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$RE\"}]}"
R=$(sync "$GOOD")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "the same client_event_id with a corrected payload then succeeds (a failed event is retryable)"

# ============================================================
step "7. Ordering: SOS first; batch size cap"
# ============================================================
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"gps_tracks\":[{\"latitude\":13.0,\"longitude\":123.7,\"accuracy_m\":10,\"recorded_at\":\"$(now_iso)\",\"client_event_id\":\"$(uuid)\"}],\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"order\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$(uuid)\"}],\"sos\":[{\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$(uuid)\"}]}")
SOSROW=$(db_one "SELECT payload_type FROM offline_queue ORDER BY queue_id DESC LIMIT 3;" | tr -d '\r' | tr '\n' ',')
expect_eq "$SOSROW" "gps,incident,sos," "(body listed gps, incident, sos; ledger rows, newest first, show processing order was sos -> incident -> gps)"
expect_eq "$(echo "$R" | json_field results.0.status)/$(echo "$R" | json_field results.1.status)/$(echo "$R" | json_field results.2.status)" "success/success/success" "mixed batch all succeed"
# prove results[] order == processing order by item identity
SOSID=$(uuid); INCID=$(uuid); GPSID=$(uuid)
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"gps_tracks\":[{\"latitude\":13.0,\"longitude\":123.7,\"accuracy_m\":10,\"recorded_at\":\"$(now_iso)\",\"client_event_id\":\"$GPSID\"}],\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"o2\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$INCID\"}],\"sos\":[{\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$SOSID\"}]}")
expect_eq "$(echo "$R" | json_field results.0.client_event_id)" "$SOSID" "results[0] is the SOS even though it was listed last in the body"
expect_eq "$(echo "$R" | json_field results.1.client_event_id)" "$INCID" "results[1] is the incident"
expect_eq "$(echo "$R" | json_field results.2.client_event_id)" "$GPSID" "results[2] is the GPS point"
# an SOS is not held up by a failing routine item
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"NOPE\",\"raw_narrative\":\"x\",\"client_event_id\":\"$(uuid)\"}],\"sos\":[{\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$(uuid)\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)/$(echo "$R" | json_field results.1.status)" "success/failed" "SOS succeeds first; the failing incident behind it does not affect it"

mk_gps_batch() { "$PHP_BIN" -r '
$n=(int)$argv[1]; $items=[]; $ts=gmdate("c");
for($i=0;$i<$n;$i++){ $items[]=["latitude"=>13.0,"longitude"=>123.7,"accuracy_m"=>10,"recorded_at"=>$ts,"client_event_id"=>sprintf("%08x-0000-4000-8000-%012x",$i+1,$argv[2]+$i)]; }
echo json_encode(["device_id"=>$argv[3],"gps_tracks"=>$items]);' "$1" "$2" "$DEVICE_ID"; }
R=$(sync "$(mk_gps_batch 200 1000)")
expect_eq "$(echo "$R" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo count($d["results"]??[]);')" "200" "exactly 200 items (MAX_ITEMS_PER_BATCH) -> accepted, 200 results"
CODE=$(sync_code "$(mk_gps_batch 201 5000)")
expect_eq "$CODE" "413" "201 items -> HTTP 413 PAYLOAD_TOO_LARGE for the WHOLE batch"
expect_eq "$(db_one "SELECT COUNT(*) FROM gps_track WHERE client_event_id LIKE '%-0000-4000-8000-%' AND CAST(CONV(RIGHT(client_event_id,12),16,10) AS UNSIGNED) >= 5000;")" "0" "...and none of the 201 was written (the cap is checked before any item is processed)"

# ============================================================
step "7b. Client event times (gap 2) and implausible incident dates (gap 4)"
# ============================================================
# Field: created_offline_at (ISO-8601 UTC) on sos / dispatch_status / duty_status items.
# Rule (backend/lib/ClientEventTime.php): used only if it parses, is <= 300 s ahead of the
# server and <= 7 days old; otherwise ignored (server time). Incident device_offline_created_at
# uses 300 s ahead / 30 days old and otherwise becomes NULL. Nothing is ever rejected for it.
set_dispatched_ago() { mysql_exec "$VALDB" -e "UPDATE dispatch SET dispatched_at = UTC_TIMESTAMP() - INTERVAL $2 WHERE dispatch_id=$1;"; }
fmt_col() { db_one "SELECT DATE_FORMAT($2,'%Y-%m-%dT%H:%i:%sZ') FROM $3 WHERE $4;"; }
near_now() { db_one "SELECT IF(ABS(TIMESTAMPDIFF(SECOND, $1, UTC_TIMESTAMP())) <= 60,'server-now','other') FROM $2 WHERE $3;"; }
ds_item_t() { echo "{\"dispatch_id\":$1,\"status\":\"$2\",\"client_event_id\":\"$3\",\"created_offline_at\":\"$4\"}"; }

DPT=$(new_dispatch "$TANOD_ID"); set_dispatched_ago "$DPT" "3 HOUR"
T1=$(iso_ago "120 minutes"); T2=$(iso_ago "90 minutes"); T3=$(iso_ago "30 minutes")
R=$(sync "$(batch_ds "$(ds_item_t "$DPT" en_route "$(uuid)" "$T1"),$(ds_item_t "$DPT" arrived "$(uuid)" "$T2"),$(ds_item_t "$DPT" completed "$(uuid)" "$T3")")")
expect_eq "$(echo "$R" | json_field results.0.status)/$(echo "$R" | json_field results.1.status)/$(echo "$R" | json_field results.2.status)" "success/success/success" "late dispatch steps carrying created_offline_at are still accepted in order"
expect_eq "$(fmt_col x en_route_at dispatch "dispatch_id=$DPT")" "$T1" "late en_route is stored at the Tanod's time, not the receive time"
expect_eq "$(fmt_col x arrived_at dispatch "dispatch_id=$DPT")" "$T2" "late arrived is stored at the Tanod's time"
expect_eq "$(fmt_col x completed_at dispatch "dispatch_id=$DPT")" "$T3" "late completed is stored at the Tanod's time"

DPU=$(new_dispatch "$TANOD_ID"); set_dispatched_ago "$DPU" "1 HOUR"
BEFORE=$(iso_ago "3 hours")
sync "$(batch_ds "$(ds_item_t "$DPU" en_route "$(uuid)" "$BEFORE"),$(ds_item_t "$DPU" arrived "$(uuid)" "$BEFORE")")" >/dev/null
expect_eq "$(db_one "SELECT IF(en_route_at = dispatched_at,'clamped','other') FROM dispatch WHERE dispatch_id=$DPU;")" "clamped" "a step time before dispatched_at is clamped up to dispatched_at"
expect_eq "$(db_one "SELECT IF(arrived_at = en_route_at,'clamped','other') FROM dispatch WHERE dispatch_id=$DPU;")" "clamped" "a step time before the previous step is clamped up to the previous step's time"

for BADT in "2099-01-01T00:00:00Z" "$(iso_ago "10 days")" "not-a-date" "tomorrow"; do
  DPX=$(new_dispatch "$TANOD_ID")
  R=$(sync "$(batch_ds "$(ds_item_t "$DPX" en_route "$(uuid)" "$BADT")")")
  expect_eq "$(echo "$R" | json_field results.0.status)/$(near_now en_route_at dispatch "dispatch_id=$DPX")" "success/server-now" "dispatch step with implausible created_offline_at '$BADT' -> item still succeeds, server time used"
done
DPW=$(new_dispatch "$TANOD_ID")
sync "$(batch_ds "$(ds_item_t "$DPW" en_route "$(uuid)" "$(date -u -d '+120 seconds' +%Y-%m-%dT%H:%M:%SZ)")")" >/dev/null
expect_eq "$(db_one "SELECT IF(en_route_at <= UTC_TIMESTAMP() AND en_route_at > UTC_TIMESTAMP() - INTERVAL 60 SECOND,'capped-at-now','other') FROM dispatch WHERE dispatch_id=$DPW;")" "capped-at-now" "a time 120 s ahead (inside the 300 s tolerance) is accepted but capped at server now"

SE1=$(uuid); T_SOS=$(iso_ago "2 hours")
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"sos\":[{\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$SE1\",\"created_offline_at\":\"${T_SOS%Z}.123Z\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "SOS with a 2-hour-old created_offline_at (with milliseconds, as the app sends it) accepted"
expect_eq "$(fmt_col x triggered_at tanod_sos "client_event_id='$SE1'")" "$T_SOS" "...triggered_at = the Tanod's press time"
expect_eq "$(near_now received_at tanod_sos "client_event_id='$SE1'")" "server-now" "...received_at stays the server receive time (audit column)"
for BADT in "2099-01-01T00:00:00Z" "$(iso_ago "10 days")" "garbage"; do
  SX=$(uuid)
  R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"sos\":[{\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$SX\",\"created_offline_at\":\"$BADT\"}]}")
  expect_eq "$(echo "$R" | json_field results.0.status)/$(near_now triggered_at tanod_sos "client_event_id='$SX'")" "success/server-now" "SOS with implausible created_offline_at '$BADT' is NOT dropped; triggered_at = server time"
done

DE3=$(uuid); T_DUTY=$(iso_ago "1 hour")
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"duty_status_updates\":[{\"status\":\"responding\",\"client_event_id\":\"$DE3\",\"created_offline_at\":\"$T_DUTY\"}]}")
# A client timestamp is only honoured for off_duty (going on duty is online-only, DutyStatusController::applyToggle);
# the positive off_duty case is covered by verify-offline-offduty.sh. Here: any other status carrying one is refused.
expect_eq "$(echo "$R" | json_field results.0.status)/$(db_one "SELECT COUNT(*) FROM duty_status WHERE client_event_id='$DE3';")" "failed/0" "responding with created_offline_at is refused and writes nothing (client time is off_duty-only)"
DE4=$(uuid)
R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"duty_status_updates\":[{\"status\":\"on_duty\",\"client_event_id\":\"$DE4\",\"created_offline_at\":\"2099-01-01T00:00:00Z\"}]}")
expect_eq "$(echo "$R" | json_field results.0.status)/$(db_one "SELECT COUNT(*) FROM duty_status WHERE client_event_id='$DE4';")" "failed/0" "on_duty with a client timestamp is refused and writes nothing (going on duty is online-only)"

for CASE in "future|2099-01-01T00:00:00Z" "garbage|not-a-date" "toofar|$(iso_ago "40 days")"; do
  LBL="${CASE%%|*}"; VAL="${CASE#*|}"; IX=$(uuid)
  R=$(sync "{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"clock $LBL\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$IX\",\"device_offline_created_at\":\"$VAL\"}]}")
  expect_eq "$(echo "$R" | json_field results.0.status)/$(db_one "SELECT COALESCE(device_offline_created_at,'NULL') FROM incident WHERE client_event_id='$IX';")/$(near_now created_at incident "client_event_id='$IX'")" "success/NULL/server-now" "incident with $LBL device_offline_created_at ('$VAL'): accepted, device_offline_created_at stored NULL, created_at = server time"
done
IXD=$(uuid)
code_for POST "$BASE_URL/incidents" "$TANOD" "{\"incident_type\":\"theft\",\"raw_narrative\":\"direct future\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$IXD\",\"device_offline_created_at\":\"2099-01-01T00:00:00Z\"}" "$DEVHDR" >/dev/null
expect_eq "$(db_one "SELECT COALESCE(device_offline_created_at,'NULL') FROM incident WHERE client_event_id='$IXD';")" "NULL" "direct POST /incidents (mobile) with a 2099 device_offline_created_at: accepted, stored NULL (same helper)"

# ============================================================
step "8. Sessions while the phone is offline"
# ============================================================
NE=$(uuid)
QB="{\"device_id\":\"$DEVICE_ID\",\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"queued during outage\",\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$NE\"}]}"
mysql_exec "$VALDB" -e "UPDATE auth_session SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE user_id=$TANOD_ID AND revoked_at IS NULL;"
expect_eq "$(sync_code "$QB")" "401" "device session past its expiry -> /sync/batch answers 401 (the queue is NOT processed)"
expect_eq "$(db_one "SELECT COUNT(*) FROM incident WHERE client_event_id='$NE';")" "0" "...nothing was written"
TANOD2=$(login_body sr_tanod "$DEVHDR" | json_field token)
R=$(sync "$QB" "$TANOD2")
expect_eq "$(echo "$R" | json_field results.0.status)" "success" "after re-login as the SAME Tanod the same queued event syncs normally"
expect_eq "$(db_one "SELECT reported_by FROM incident WHERE client_event_id='$NE';")" "$TANOD_ID" "...and is attributed to the identity that syncs it (reported_by = the logged-in Tanod)"

# 7-day absolute cap: a device session never renews past issued_at + 7 days.
mysql_exec "$VALDB" -e "UPDATE auth_session SET issued_at = UTC_TIMESTAMP() - INTERVAL 7 DAY + INTERVAL 1 HOUR, expires_at = UTC_TIMESTAMP() + INTERVAL 10 MINUTE WHERE user_id=$TANOD_ID AND revoked_at IS NULL;"
code_for GET "$BASE_URL/duty-status" "$TANOD2" >/dev/null
expect_eq "$(db_one "SELECT IF(MAX(expires_at) <= MAX(issued_at) + INTERVAL 7 DAY,'capped','PAST CAP') FROM auth_session WHERE user_id=$TANOD_ID AND revoked_at IS NULL;")" "capped" "sliding renewal near day 7 is clamped to issued_at + 7 days"

# Different Tanod logs in on the same phone while A's items are still queued.
TB=$(login_body sr_tanod_b "$DEVHDR" | json_field token)
CODE=$(sync_code "$QB" "$TB")
expect_eq "$CODE" "422" "Tanod B logged in on Tanod A's device: the WHOLE batch is refused (422, device owned by A) - no per-item results"
RB=$(sync "$QB" "$TB")
expect_eq "$(echo "$RB" | json_field error.code)" "DEVICE_NOT_REGISTERED" "...and the refusal carries the distinct machine code DEVICE_NOT_REGISTERED (the app shows 'this phone is registered to a different account' instead of retrying silently)"
SB_CODE=$(sync_code "{\"device_id\":\"$DEVICE_ID\",\"sos\":[{\"latitude\":13.0,\"longitude\":123.7,\"client_event_id\":\"$(uuid)\"}]}" "$TB")
expect_eq "$SB_CODE" "422" "...including a queued SOS (an SOS cannot ride a batch from the wrong account)"
code_for POST "$BASE_URL/auth/logout" "$TANOD2" >/dev/null
expect_eq "$(sync_code "$QB" "$TANOD2")" "401" "after logout the token is dead (401) - sessions are revoked server-side on every request"
mysql_exec "$VALDB" -e "UPDATE mobile_device SET is_active=0 WHERE device_id='$DEVICE_ID';"
TANOD3=$(login_body sr_tanod "$DEVHDR" | json_field token)
expect_eq "$(sync_code "$QB" "$TANOD3")" "422" "a deactivated device (e.g. replaced by a new handset) -> whole batch 422"

echo
echo "================================"
echo "RESULT: $PASS passed, $FAIL failed"
echo "================================"
[ "$FAIL" -eq 0 ]
