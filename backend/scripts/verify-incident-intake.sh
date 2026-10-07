#!/usr/bin/env bash
# Baranguard — incident intake verification (Wave 1 review decisions,
# migration 0036): `incident.report_channel`, `incident.related_incident_id`,
# `PATCH /incidents/:id/related`, and the REMOVAL of public
# `POST /citizen-reports`.
#
# Proves: migration 0036 backfill from `source` (seeded rows of each source
# applied BEFORE 0036), re-run safety and down/up; POST /citizen-reports is a
# plain 404 route miss; report_channel default/validation/forcing per path
# (web admin+secretary, mobile POST, /sync/batch, citizen-report convert);
# list/show/search expose report_channel + related_incident_id; related link
# happy path / null unlink / self 400 / unknown+cross-tenant 404 / role gates /
# Idempotency-Key replay / allowed while a dispatch is open / status
# unchanged / show() fields / audit ids only / lifecycle duplicate flow
# unchanged / raw_narrative visibility unchanged.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (Git Bash): bash backend/scripts/verify-incident-intake.sh

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
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="${VALDB_OVERRIDE:-baranguard_intake_check}"
APP_USER="${APP_USER_OVERRIDE:-intakechk_app}"
APP_PASSWORD="IntakeChk!2026Pw"
API_PORT="${API_PORT_OVERRIDE:-8195}"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="IntakeCheck#2026Pw"

echo "Baranguard incident intake verification — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
db_one() {
  local out
  out="$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null)"
  if [ -z "$out" ]; then out="$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null)"; fi
  echo "$out"
}
json_field() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=explode(".",$argv[1]); $v=$d; foreach($k as $p){$v=is_array($v)?($v[$p]??null):null;} echo is_scalar($v)?$v:json_encode($v);' "$1"; }
json_keys() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=$argv[1]===""?[]:explode(".",$argv[1]); $v=$d; foreach($k as $p){$v=is_array($v)?($v[$p]??null):null;} if(!is_array($v)){echo "NOT_ARRAY";exit;} $keys=array_keys($v); sort($keys); echo implode(",",$keys);' "$1"; }
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }

RESP_CODE=""; RESP_BODY=""
call() {
  local method="$1" url="$2" token="${3:-}" body="${4:-}"; shift 4
  local args=(-s -w $'\n%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  local h
  for h in "$@"; do [ -n "$h" ] && args+=(-H "$h"); done
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  local out
  out="$(curl "${args[@]}")"
  RESP_CODE="${out##*$'\n'}"
  RESP_BODY="${out%$'\n'*}"
}

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.${APP_USER}-server.log"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

# ============================================================
step "0. Setup — chain up to 0035, seed pre-0036 incidents of every source"
# ============================================================
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
CHAIN_FAIL=0
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort | awk -v s=0001_baseline_schema '$0 >= s'); do
  num="${m%%_*}"
  [ "$num" = "0036" ] && continue
  [ "$num" \> "0036" ] && continue
  if ! ERR="$(mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" 2>&1)"; then
    fail "migration $m failed: $ERR"; CHAIN_FAIL=1
  fi
done
[ "$CHAIN_FAIL" -eq 0 ] && pass "Migrations before 0036 applied"
expect_eq "$(db_one "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$VALDB' AND table_name='incident' AND column_name IN ('report_channel','related_incident_id');")" "0" "Neither new column exists before 0036"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'in_admin','$HASH','IN Admin','admin',1,UTC_TIMESTAMP()),
 (1,'in_secretary','$HASH','IN Secretary','secretary',1,UTC_TIMESTAMP()),
 (1,'in_pb','$HASH','IN PB','punong_barangay',1,UTC_TIMESTAMP()),
 (1,'in_tanod','$HASH','IN Tanod','tanod',1,UTC_TIMESTAMP()),
 (2,'in_admin2','$HASH','IN Admin Two','admin',1,UTC_TIMESTAMP()),
 (2,'in_secretary2','$HASH','IN Secretary Two','secretary',1,UTC_TIMESTAMP());
SQL
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
ADMIN_ID=$(uid in_admin); SEC_ID=$(uid in_secretary); TANOD_ID=$(uid in_tanod); ADMIN2_ID=$(uid in_admin2)
DEV_T="intake-device-tanod"
mysql_exec "$VALDB" -e "INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES ('$DEV_T', $TANOD_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());"

mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
 (1, $TANOD_ID, 'theft',       'normal', 'RAW-INTAKE-APP',  'pending',  'app', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 (1, $TANOD_ID, 'fire',        'normal', 'RAW-INTAKE-SMS',  'pending',  'sms', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 (1, $ADMIN_ID, 'disturbance', 'normal', 'RAW-INTAKE-WEB',  'pending',  'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 (1, NULL,      'vandalism',   'normal', 'RAW-INTAKE-WEB2', 'resolved', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 (2, $ADMIN2_ID,'theft',       'normal', 'RAW-INTAKE-B2',   'pending',  'web', UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
inc_by() { db_one "SELECT incident_id FROM incident WHERE raw_narrative='$1';"; }
I_APP=$(inc_by RAW-INTAKE-APP); I_SMS=$(inc_by RAW-INTAKE-SMS); I_WEB=$(inc_by RAW-INTAKE-WEB); I_WEB2=$(inc_by RAW-INTAKE-WEB2); I_B2=$(inc_by RAW-INTAKE-B2)
mysql_exec "$VALDB" -e "UPDATE incident SET display_id=CONCAT('INC-T-',incident_id) WHERE display_id IS NULL;"
pass "Seeded pre-0036 incidents: app=#$I_APP sms=#$I_SMS web=#$I_WEB web2=#$I_WEB2 barangay2=#$I_B2"

# ============================================================
step "1. Migration 0036 — backfill, constraints, re-run, down/up"
# ============================================================
M36="$BACKEND_DIR/migrations/0036_incident_report_channel_and_related.sql"
M36D="$BACKEND_DIR/migrations/0036_incident_report_channel_and_related.down.sql"
ERR="$(mysql_exec "$VALDB" < "$M36" 2>&1)" && pass "0036 applies cleanly" || fail "0036 failed: $ERR"
chan() { db_one "SELECT report_channel FROM incident WHERE incident_id=$1;"; }
expect_eq "$(chan $I_APP)"  "tanod_alerted" "Backfill: source=app -> tanod_alerted"
expect_eq "$(chan $I_SMS)"  "sms"           "Backfill: source=sms -> sms"
expect_eq "$(chan $I_WEB)"  "walk_in"       "Backfill: source=web -> walk_in"
expect_eq "$(chan $I_WEB2)" "walk_in"       "Backfill: source=web (no reporter, resolved) -> walk_in"
expect_eq "$(chan $I_B2)"   "walk_in"       "Backfill: other barangay's web row -> walk_in"
expect_eq "$(db_one "SELECT column_type FROM information_schema.columns WHERE table_schema='$VALDB' AND table_name='incident' AND column_name='report_channel';")" "enum('tanod_alerted','walk_in','sms','other')" "report_channel ENUM definition"
expect_eq "$(db_one "SELECT is_nullable FROM information_schema.columns WHERE table_schema='$VALDB' AND table_name='incident' AND column_name='report_channel';")" "NO" "report_channel is NOT NULL"
expect_eq "$(db_one "SELECT column_default FROM information_schema.columns WHERE table_schema='$VALDB' AND table_name='incident' AND column_name='report_channel';")" "'other'" "report_channel default is 'other'"
expect_eq "$(db_one "SELECT is_nullable FROM information_schema.columns WHERE table_schema='$VALDB' AND table_name='incident' AND column_name='related_incident_id';")" "YES" "related_incident_id is nullable"
expect_eq "$(db_one "SELECT delete_rule FROM information_schema.referential_constraints WHERE constraint_schema='$VALDB' AND constraint_name='fk_incident_related';")" "SET NULL" "related FK is ON DELETE SET NULL"
expect_eq "$(db_one "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema='$VALDB' AND table_name='incident' AND index_name='idx_incident_related';")" "1" "idx_incident_related exists"

# Re-run must not clobber a value changed after the first run.
mysql_exec "$VALDB" -e "UPDATE incident SET report_channel='other' WHERE incident_id=$I_WEB2;"
ERR="$(mysql_exec "$VALDB" < "$M36" 2>&1)" && pass "0036 re-run is a clean no-op" || fail "0036 re-run failed: $ERR"
expect_eq "$(chan $I_WEB2)" "other" "Re-run does NOT overwrite an operator-set channel"
mysql_exec "$VALDB" -e "UPDATE incident SET report_channel='walk_in' WHERE incident_id=$I_WEB2;"

# down then up restores the same backfill.
ERR="$(mysql_exec "$VALDB" < "$M36D" 2>&1)" && pass "0036 .down.sql applies" || fail "0036 down failed: $ERR"
expect_eq "$(db_one "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$VALDB' AND table_name='incident' AND column_name IN ('report_channel','related_incident_id');")" "0" "down removes both columns"
ERR="$(mysql_exec "$VALDB" < "$M36D" 2>&1)" && pass "0036 .down.sql is re-runnable" || fail "0036 down re-run failed: $ERR"
ERR="$(mysql_exec "$VALDB" < "$M36" 2>&1)" && pass "0036 re-applies after down" || fail "0036 re-apply failed: $ERR"
expect_eq "$(chan $I_APP)/$(chan $I_SMS)/$(chan $I_WEB)" "tanod_alerted/sms/walk_in" "Backfill identical after down/up"

# ============================================================
step "2. Start API + login"
# ============================================================
( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="intakechk-verify-secret-key-not-real-0123456789" \
  "$PHP_BIN" -S 127.0.0.1:$API_PORT -t public public/dev-router.php > "$BACKEND_DIR/scripts/.${APP_USER}-server.log" 2>&1 ) &
SERVER_PID=$!
sleep 2
token_for() {
  curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | json_field token
}
ADMIN=$(token_for in_admin); SEC=$(token_for in_secretary); PB=$(token_for in_pb)
TANOD=$(token_for in_tanod); ADMIN2=$(token_for in_admin2); SEC2=$(token_for in_secretary2)
if [ -n "$ADMIN" ] && [ -n "$SEC" ] && [ -n "$PB" ] && [ -n "$TANOD" ] && [ -n "$ADMIN2" ] && [ -n "$SEC2" ]; then
  pass "Tokens acquired for all 6 accounts"
else
  fail "Login failed — see .${APP_USER}-server.log"; exit 1
fi
HT="X-Device-Id: $DEV_T"

# ============================================================
step "3. POST /citizen-reports is REMOVED (no handler: 405 via GET path, 404 otherwise)"
# ============================================================
# The path still exists for GET (inbox), so the router answers a POST with its
# generic "path matched, method not allowed" 405 (public/index.php) rather than
# the 404 an entirely absent path gets. Either way: no handler, no row.
call POST "$BASE_URL/citizen-reports" "" '{"barangay_id":1,"description":"anonymous"}'
case "$RESP_CODE" in 404|405) pass "Unauthenticated POST /citizen-reports has no handler ($RESP_CODE route miss)" ;; *) fail "Unauthenticated POST /citizen-reports -> $RESP_CODE (expected 404/405)" ;; esac
call POST "$BASE_URL/citizen-reports" "$ADMIN" '{"barangay_id":1,"description":"as admin"}'
case "$RESP_CODE" in 404|405) pass "Admin POST /citizen-reports has no handler ($RESP_CODE route miss)" ;; *) fail "Admin POST /citizen-reports -> $RESP_CODE (expected 404/405)" ;; esac
call POST "$BASE_URL/citizen-reports/1" "" '{}'
expect_eq "$RESP_CODE" "404" "POST /citizen-reports/1 (never existed) -> 404"
expect_eq "$(db_one "SELECT COUNT(*) FROM citizen_report;")" "0" "No citizen_report row created"
call GET "$BASE_URL/citizen-reports" "$ADMIN" ""
expect_eq "$RESP_CODE" "200" "GET /citizen-reports (inbox) still works"

# ============================================================
step "4. Web create — report_channel default, explicit values, validation"
# ============================================================
BODY_BASE='"incident_type":"theft","raw_narrative":"INTAKE web create narrative"'
call POST "$BASE_URL/incidents" "$ADMIN" "{$BODY_BASE}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "201" "Admin web create without report_channel -> 201"
expect_eq "$(echo "$RESP_BODY" | json_field report_channel)" "walk_in" "Admin default report_channel = walk_in"
expect_eq "$(echo "$RESP_BODY" | json_field source)" "web" "source stays 'web'"
expect_eq "$(echo "$RESP_BODY" | json_field related_incident_id)" "null" "New incident has no related_incident_id"
call POST "$BASE_URL/incidents" "$SEC" "{$BODY_BASE}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "201" "Secretary web create without report_channel -> 201"
expect_eq "$(echo "$RESP_BODY" | json_field report_channel)" "walk_in" "Secretary default report_channel = walk_in"
for ch in tanod_alerted walk_in sms other; do
  call POST "$BASE_URL/incidents" "$SEC" "{$BODY_BASE,\"report_channel\":\"$ch\"}" "Idempotency-Key: $(uuid)"
  expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field report_channel)" "201/$ch" "Secretary web create report_channel=$ch is stored"
  call POST "$BASE_URL/incidents" "$ADMIN" "{$BODY_BASE,\"report_channel\":\"$ch\"}" "Idempotency-Key: $(uuid)"
  expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field report_channel)" "201/$ch" "Admin web create report_channel=$ch is stored"
done
call POST "$BASE_URL/incidents" "$ADMIN" "{$BODY_BASE,\"report_channel\":\"phone_call\"}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "Unknown report_channel -> 400"
call POST "$BASE_URL/incidents" "$ADMIN" "{$BODY_BASE,\"report_channel\":5}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "Non-string report_channel -> 400"
call POST "$BASE_URL/incidents" "$ADMIN" "{$BODY_BASE,\"report_channel\":null}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field report_channel)" "201/walk_in" "Explicit null report_channel is treated as omitted -> default walk_in"
K_RC=$(uuid)
call POST "$BASE_URL/incidents" "$SEC" "{$BODY_BASE,\"report_channel\":\"sms\"}" "Idempotency-Key: $K_RC"
FIRST_ID=$(echo "$RESP_BODY" | json_field incident_id)
call POST "$BASE_URL/incidents" "$SEC" "{$BODY_BASE,\"report_channel\":\"sms\"}" "Idempotency-Key: $K_RC"
expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field incident_id)/$(echo "$RESP_BODY" | json_field report_channel)" "200/$FIRST_ID/sms" "Idempotency-Key replay returns the original incident with its channel"
call POST "$BASE_URL/incidents" "$PB" "{$BODY_BASE}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "403" "Punong Barangay cannot create an incident -> 403"

# ============================================================
step "5. Mobile POST /incidents and /sync/batch — channel FORCED to tanod_alerted"
# ============================================================
call POST "$BASE_URL/incidents" "$TANOD" "{\"incident_type\":\"fire\",\"raw_narrative\":\"INTAKE mobile narrative\",\"client_event_id\":\"$(uuid)\",\"report_channel\":\"walk_in\"}" "$HT"
expect_eq "$RESP_CODE" "201" "Tanod create (spoofing report_channel=walk_in) -> 201"
expect_eq "$(echo "$RESP_BODY" | json_field report_channel)" "tanod_alerted" "Tanod create is forced to tanod_alerted"
expect_eq "$(echo "$RESP_BODY" | json_field source)" "app" "source = app"
MOB_EVT=$(uuid)
SYNC_BODY=$("$PHP_BIN" -r '
echo json_encode(["device_id"=>$argv[1],"incidents"=>[["incident_type"=>"theft","raw_narrative"=>"INTAKE sync narrative","latitude"=>13.0,"longitude"=>123.7,"client_event_id"=>$argv[2],"report_channel"=>"sms"]]]);' "$DEV_T" "$MOB_EVT")
call POST "$BASE_URL/sync/batch" "$TANOD" "$SYNC_BODY" "$HT"
expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field results.0.status)" "200/success" "sync/batch incident (spoofing report_channel=sms) succeeds"
expect_eq "$(db_one "SELECT report_channel FROM incident WHERE device_id='$DEV_T' AND client_event_id='$MOB_EVT';")" "tanod_alerted" "sync/batch incident is forced to tanod_alerted"
call POST "$BASE_URL/sync/batch" "$TANOD" "$SYNC_BODY" "$HT"
expect_eq "$(echo "$RESP_BODY" | json_field results.0.status)" "duplicate" "sync replay is a duplicate"
expect_eq "$(db_one "SELECT report_channel FROM incident WHERE device_id='$DEV_T' AND client_event_id='$MOB_EVT';")" "tanod_alerted" "channel unchanged after replay"

# ============================================================
step "6. Citizen-report convert -> walk_in"
# ============================================================
mysql_exec "$VALDB" -e "INSERT INTO citizen_report (barangay_id, contact_number, description, submitted_at) VALUES (1, NULL, 'INTAKE citizen fixture', UTC_TIMESTAMP());"
CR=$(db_one "SELECT report_id FROM citizen_report WHERE description='INTAKE citizen fixture';")
call POST "$BASE_URL/citizen-reports/$CR/convert" "$SEC" '{"incident_type":"theft"}'
expect_eq "$RESP_CODE" "200" "Secretary converts a SQL-seeded citizen report -> 200"
CONV_INC=$(echo "$RESP_BODY" | json_field incident_id)
expect_eq "$(chan $CONV_INC)" "walk_in" "Converted incident has report_channel = walk_in"
expect_eq "$(db_one "SELECT source FROM incident WHERE incident_id=$CONV_INC;")" "web" "...and source = web"

# ============================================================
step "7. list / show / search expose report_channel + related_incident_id"
# ============================================================
call GET "$BASE_URL/incidents?limit=100" "$ADMIN" ""
expect_eq "$RESP_CODE" "200" "Admin GET /incidents -> 200"
LIST_SMS=$(echo "$RESP_BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); foreach($d["items"] as $i){ if($i["incident_id"]==(int)$argv[1]) echo $i["report_channel"]."|".(array_key_exists("related_incident_id",$i)?"has":"missing"); }' "$I_SMS")
expect_eq "$LIST_SMS" "sms|has" "List item carries report_channel and related_incident_id keys"
call GET "$BASE_URL/incidents?limit=100" "$PB" ""
expect_eq "$RESP_CODE" "200" "PB GET /incidents -> 200"
call GET "$BASE_URL/incidents?limit=100" "$TANOD" ""
expect_eq "$(echo "$RESP_BODY" | json_field items.0.report_channel)" "tanod_alerted" "Tanod list items carry report_channel (own incidents only)"
call GET "$BASE_URL/incidents/$I_SMS" "$ADMIN" ""
expect_eq "$(echo "$RESP_BODY" | json_field report_channel)" "sms" "show(): report_channel"
expect_eq "$(echo "$RESP_BODY" | json_field related_incident)" "null" "show(): related_incident is null when unlinked"
expect_eq "$(echo "$RESP_BODY" | json_field related_by)" "[]" "show(): related_by is [] when nothing links here"
call GET "$BASE_URL/incidents/$I_APP" "$TANOD" ""
expect_eq "$(echo "$RESP_BODY" | json_field report_channel)" "tanod_alerted" "Tanod show() of own incident carries report_channel"
call GET "$BASE_URL/search?q=fire" "$ADMIN" ""
expect_eq "$RESP_CODE" "200" "GET /search -> 200"
SRCH=$(echo "$RESP_BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); foreach($d["items"] as $i){ if($i["incident_id"]==(int)$argv[1]) echo $i["report_channel"]."|".(array_key_exists("related_incident_id",$i)?"has":"missing"); }' "$I_SMS")
expect_eq "$SRCH" "sms|has" "Search item carries report_channel and related_incident_id"

# ============================================================
step "8. PATCH /incidents/:id/related — happy path, unlink, validation"
# ============================================================
K=$(uuid)
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" "{\"related_incident_id\":$I_SMS}" "Idempotency-Key: $K"
expect_eq "$RESP_CODE" "200" "Secretary links web incident -> sms incident"
expect_eq "$(echo "$RESP_BODY" | json_field related_incident_id)" "$I_SMS" "Response echoes related_incident_id"
expect_eq "$(db_one "SELECT related_incident_id FROM incident WHERE incident_id=$I_WEB;")" "$I_SMS" "DB link stored"
call GET "$BASE_URL/incidents/$I_WEB" "$SEC" ""
expect_eq "$(echo "$RESP_BODY" | json_field related_incident.incident_id)" "$I_SMS" "show(): related_incident.incident_id"
expect_eq "$(echo "$RESP_BODY" | json_field related_incident.display_id)" "$(db_one "SELECT display_id FROM incident WHERE incident_id=$I_SMS;")" "show(): related_incident.display_id"
expect_eq "$(echo "$RESP_BODY" | json_keys related_incident)" "display_id,incident_id" "related_incident carries ONLY incident_id + display_id"
expect_eq "$(echo "$RESP_BODY" | json_field related_incident_id)" "$I_SMS" "show(): related_incident_id"
call GET "$BASE_URL/incidents/$I_SMS" "$ADMIN" ""
expect_eq "$(echo "$RESP_BODY" | json_field related_by.0.incident_id)" "$I_WEB" "show() on the target: related_by lists the incident pointing at it"
expect_eq "$(echo "$RESP_BODY" | json_keys related_by.0)" "display_id,incident_id" "related_by entries carry ONLY incident_id + display_id"
expect_eq "$(echo "$RESP_BODY" | json_field raw_narrative)" "null" "Admin show() still has no raw_narrative"
call GET "$BASE_URL/incidents/$I_SMS" "$SEC" ""
expect_eq "$(echo "$RESP_BODY" | json_field raw_narrative)" "RAW-INTAKE-SMS" "Secretary show() still returns raw_narrative"

# Idempotency replay
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" "{\"related_incident_id\":$I_SMS}" "Idempotency-Key: $K"
expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field related_incident_id)" "200/$I_SMS" "Replay with the same key returns the original result"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='incident_related_changed' AND entity_id=$I_WEB;")" "1" "Replay wrote NO second audit row"
# Replay with the same key but a DIFFERENT body is still the original (key identity wins, like PATCH /incidents/:id)
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" "{\"related_incident_id\":$I_APP}" "Idempotency-Key: $K"
expect_eq "$(db_one "SELECT related_incident_id FROM incident WHERE incident_id=$I_WEB;")" "$I_SMS" "Same key + different body does not change the link"

# audit metadata = ids only
META=$(db_one "SELECT metadata_json FROM audit_log WHERE action='incident_related_changed' AND entity_id=$I_WEB LIMIT 1;")
expect_eq "$(echo "$META" | json_keys '')" "idempotency_key,previous_related_incident_id,related_incident_id" "Audit metadata keys are ids/key only"
case "$META" in *RAW-INTAKE*|*display*|*INC-*) fail "Audit metadata leaks narrative/display text: $META" ;; *) pass "Audit metadata holds no narrative or display text" ;; esac

# Admin may also link; relink replaces; unlink with null
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$ADMIN" "{\"related_incident_id\":$I_APP}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field related_incident_id)" "200/$I_APP" "Admin can re-link (replaces the old target)"
LAST_META=$(db_one "SELECT metadata_json FROM audit_log WHERE action='incident_related_changed' AND entity_id=$I_WEB ORDER BY audit_id DESC LIMIT 1;")
expect_eq "$(echo "$LAST_META" | json_field previous_related_incident_id)" "$I_SMS" "Audit records the previous id"
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" '{"related_incident_id":null}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "200" "null unlinks -> 200"
expect_eq "$(db_one "SELECT IFNULL(related_incident_id,'NULL') FROM incident WHERE incident_id=$I_WEB;")" "NULL" "DB link cleared"
call GET "$BASE_URL/incidents/$I_WEB" "$SEC" ""
expect_eq "$(echo "$RESP_BODY" | json_field related_incident)" "null" "show(): related_incident null after unlink"

# Validation
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" "{\"related_incident_id\":$I_WEB}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "Self-link -> 400"
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" '{}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "Missing related_incident_id key -> 400"
for bad in '"abc"' '0' '-3' '1.5' 'true' '[]'; do
  call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" "{\"related_incident_id\":$bad}" "Idempotency-Key: $(uuid)"
  expect_eq "$RESP_CODE" "400" "related_incident_id=$bad -> 400"
done
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" "{\"related_incident_id\":$I_SMS}" ""
expect_eq "$RESP_CODE" "400" "Missing Idempotency-Key -> 400"
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" "{\"related_incident_id\":$I_SMS}" "Idempotency-Key: nope"
expect_eq "$RESP_CODE" "400" "Non-UUID Idempotency-Key -> 400"
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" "{\"related_incident_id\":999999}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Unknown related_incident_id -> 404"
call PATCH "$BASE_URL/incidents/999999/related" "$SEC" "{\"related_incident_id\":$I_SMS}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Unknown incident -> 404"
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC" "{\"related_incident_id\":$I_B2}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Target in ANOTHER barangay -> 404 (not 403, indistinguishable from unknown)"
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$SEC2" "{\"related_incident_id\":$I_B2}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Another barangay's Secretary acting on this barangay's incident -> 404"
call PATCH "$BASE_URL/incidents/$I_B2/related" "$ADMIN" "{\"related_incident_id\":$I_WEB}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Barangay-1 Admin targeting a barangay-2 incident -> 404"
call PATCH "$BASE_URL/incidents/$I_B2/related" "$ADMIN2" "{\"related_incident_id\":$I_WEB}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Barangay-2 Admin linking to a barangay-1 target -> 404"
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$TANOD" "{\"related_incident_id\":$I_SMS}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "403" "Tanod -> 403"
call PATCH "$BASE_URL/incidents/$I_WEB/related" "$PB" "{\"related_incident_id\":$I_SMS}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "403" "Punong Barangay -> 403"
call PATCH "$BASE_URL/incidents/$I_WEB/related" "" "{\"related_incident_id\":$I_SMS}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "401" "Unauthenticated -> 401"
expect_eq "$(db_one "SELECT IFNULL(related_incident_id,'NULL') FROM incident WHERE incident_id=$I_WEB;")" "NULL" "None of the rejected calls changed the link"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='incident_related_changed' AND (metadata_json LIKE '%RAW-INTAKE%');")" "0" "No audit row anywhere contains narrative"

# ============================================================
step "9. Link while a dispatch is open — allowed, nothing else changes"
# ============================================================
mysql_exec "$VALDB" -e "UPDATE incident SET status='dispatched' WHERE incident_id=$I_APP;"
mysql_exec "$VALDB" -e "INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, status, dispatched_at, created_client_request_id) VALUES ($I_APP, $ADMIN_ID, $TANOD_ID, 'normal','assigned',UTC_TIMESTAMP(),UUID());"
call PATCH "$BASE_URL/incidents/$I_APP/related" "$SEC" "{\"related_incident_id\":$I_SMS}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "200" "Link on an incident with an ACTIVE dispatch -> 200"
expect_eq "$(db_one "SELECT status FROM incident WHERE incident_id=$I_APP;")" "dispatched" "Incident status unchanged (still dispatched)"
expect_eq "$(db_one "SELECT status FROM dispatch WHERE incident_id=$I_APP;")" "assigned" "Dispatch untouched (still assigned)"
call PATCH "$BASE_URL/incidents/$I_SMS/related" "$ADMIN" "{\"related_incident_id\":$I_APP}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "200" "Link TO an incident with an active dispatch (mutual link) -> 200"
call PATCH "$BASE_URL/incidents/$I_APP/related" "$SEC" '{"related_incident_id":null}' "Idempotency-Key: $(uuid)"
call PATCH "$BASE_URL/incidents/$I_SMS/related" "$SEC" '{"related_incident_id":null}' "Idempotency-Key: $(uuid)"
# resolved incident may also be linked
call PATCH "$BASE_URL/incidents/$I_WEB2/related" "$SEC" "{\"related_incident_id\":$I_WEB}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "200" "Link on a RESOLVED incident -> 200"
expect_eq "$(db_one "SELECT status FROM incident WHERE incident_id=$I_WEB2;")" "resolved" "Resolved status unchanged"

# ============================================================
step "10. Lifecycle duplicate flow is unchanged"
# ============================================================
call PATCH "$BASE_URL/incidents/$I_APP/lifecycle" "$SEC" "{\"status\":\"duplicate\",\"duplicate_of_incident_id\":$I_SMS}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "409" "duplicate while a dispatch is open -> still 409"
call PATCH "$BASE_URL/incidents/$I_SMS/lifecycle" "$SEC" '{"status":"duplicate"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "duplicate without duplicate_of_incident_id -> still 400"
call PATCH "$BASE_URL/incidents/$I_SMS/lifecycle" "$ADMIN" "{\"status\":\"duplicate\",\"duplicate_of_incident_id\":$I_WEB}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "403" "Admin still cannot use lifecycle -> 403"
call PATCH "$BASE_URL/incidents/$I_SMS/lifecycle" "$SEC" "{\"status\":\"duplicate\",\"duplicate_of_incident_id\":$I_WEB}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "200" "Secretary duplicate with a target and no open dispatch -> 200"
expect_eq "$(db_one "SELECT duplicate_of_incident_id FROM incident WHERE incident_id=$I_SMS;")" "$I_WEB" "duplicate_of_incident_id set (separate from related_incident_id)"
expect_eq "$(db_one "SELECT IFNULL(related_incident_id,'NULL') FROM incident WHERE incident_id=$I_SMS;")" "NULL" "related_incident_id independent of the duplicate link"

# ============================================================
step "11. Retention-style delete: ON DELETE SET NULL on the related FK"
# ============================================================
mysql_exec "$VALDB" -e "UPDATE incident SET related_incident_id=$I_B2 WHERE incident_id=$I_WEB2;"
mysql_exec "$VALDB" -e "DELETE FROM incident WHERE incident_id=$I_B2;" 2>/dev/null
expect_eq "$(db_one "SELECT IFNULL(related_incident_id,'NULL') FROM incident WHERE incident_id=$I_WEB2;")" "NULL" "Deleting the target nulls the pointer instead of blocking"

step "Summary"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
[ "$FAIL" -eq 0 ]
