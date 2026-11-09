#!/usr/bin/env bash
# verify-gps-stream.sh — GET /gps/stream (server-push live positions, Server-Sent Events).
#
# Proves, on a disposable DB and throwaway PHP servers (never the real database):
#   1. Auth, validation and tenant rules match GET /gps/live (401 / 400 / 404 / PB allowed).
#   2. Opening a stream is rate limited (429).
#   3. The stream sends a snapshot first, then pushes each posted fix as a `position` event;
#      the snapshot lists the same tanods as GET /gps/live.
#   4. Push latency: POST /gps -> `position` event arrival, measured over 10 posts. This is
#      the SERVER-TO-DASHBOARD part only, on loopback (no phone, no mobile network); it is
#      written to backend/storage/push-latency-last-run.json for the thesis.
#   5. A tanod of another barangay is never pushed into this barangay's stream.
#   6. A revoked session ends the stream with `auth_expired` within the re-check window.
#
# php -S is single-threaded on Windows, so a stream blocks its own server: the stream runs
# on port A and every other request (login, POST /gps, /gps/live) on port B.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0; FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 -- expected '$2', got '$1'"; fi; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_gpsstream_check"
APP_USER="gsstream_app"
APP_PASSWORD="GpsStream!2026"
PORT_A="9211"   # stream
PORT_B="9212"   # everything else
URL_A="http://127.0.0.1:${PORT_A}/api/v1"
URL_B="http://127.0.0.1:${PORT_B}/api/v1"
TEST_PW="GpsStream#2026Pw"
DEVICE_ID="gsstream-device-0001"
OUT_DIR="$(mktemp -d)"

find_bin() {
  local name="$1"
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  command -v "$name" 2>/dev/null || echo ""
}
MYSQL_BIN="$(find_bin mysql)"; PHP_BIN="$(find_bin php)"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }

mysql_exec() { MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"; }
db_one() { mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null | tr -d '\r'; }
json_field() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=explode(".",$argv[1]); $v=$d; foreach($k as $p){$v=is_array($v)?($v[$p]??null):null;} echo is_scalar($v)?$v:json_encode($v);' "$1"; }
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }
now_ms() { date +%s%3N; }

cleanup() {
  step "Cleanup"
  . "$(dirname "$0")/lib/stop-php-server.sh" && stop_php_server "${PORT_A}" && stop_php_server "${PORT_B}"
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$OUT_DIR" "$BACKEND_DIR/scripts/.gsstream-a.log" "$BACKEND_DIR/scripts/.gsstream-b.log"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

step "0. Setup"
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
 (1,'gs_admin','$HASH','GS Admin','admin',1,UTC_TIMESTAMP()),
 (1,'gs_pb','$HASH','GS Punong','punong_barangay',1,UTC_TIMESTAMP()),
 (1,'gs_tanod','$HASH','GS Tanod One','tanod',1,UTC_TIMESTAMP()),
 (2,'gs_tanod_b2','$HASH','GS Tanod Other Barangay','tanod',1,UTC_TIMESTAMP());
SQL
TANOD_ID=$(db_one "SELECT user_id FROM user WHERE username='gs_tanod';")
TANOD2_ID=$(db_one "SELECT user_id FROM user WHERE username='gs_tanod_b2';")
ADMIN_ID=$(db_one "SELECT user_id FROM user WHERE username='gs_admin';")
mysql_exec "$VALDB" -e "INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES ('$DEVICE_ID', $TANOD_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());"
# One earlier position per tanod, so the snapshot is not empty.
mysql_exec "$VALDB" -e "INSERT INTO gps_track (user_id, latitude, longitude, accuracy_m, recorded_at, received_at, client_event_id) VALUES
 ($TANOD_ID, 12.9000, 123.6000, 8, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UUID()),
 ($TANOD2_ID, 12.9500, 123.6500, 8, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UUID());"

start_server() { # port log
  ( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
    DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="gsstream-verify-secret-key-not-real-0123456789" \
    "$PHP_BIN" -S "127.0.0.1:$1" -t public public/dev-router.php > "$BACKEND_DIR/scripts/$2" 2>&1 ) &
}
start_server "$PORT_A" .gsstream-a.log
start_server "$PORT_B" .gsstream-b.log
sleep 3

token_for() { curl -s -X POST "$URL_B/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | json_field token; }
ADMIN=$(token_for gs_admin); PB=$(token_for gs_pb); TANOD=$(token_for gs_tanod)
[ -n "$ADMIN" ] && [ -n "$PB" ] && [ -n "$TANOD" ] && pass "Tokens acquired" || { fail "Login failed -- see .gsstream-b.log"; exit 1; }

# Read a stream into a time-stamped file: "<epoch ms> <line>".
open_stream() { # token barangay maxtime outfile
  ( curl -sN -m "$3" -H "Authorization: Bearer $1" "$URL_A/gps/stream?barangay_id=$2" \
      | while IFS= read -r line; do printf '%s %s\n' "$(now_ms)" "$line"; done > "$4" ) &
  STREAM_PID=$!   # wait for THIS reader only: a bare `wait` would also wait for the php -S servers
}

# ============================================================
step "1. Auth, validation and tenant rules (same as GET /gps/live)"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' "$URL_A/gps/stream?barangay_id=1")" "401" "No token is rejected"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ADMIN" "$URL_A/gps/stream")" "400" "Missing barangay_id is rejected"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ADMIN" "$URL_A/gps/stream?barangay_id=2")" "404" "Another barangay is 404 (cross-tenant is never 403)"
CT=$(curl -s -o /dev/null -m 2 -w '%{http_code} %{content_type}' -H "Authorization: Bearer $PB" "$URL_A/gps/stream?barangay_id=1")
case "$CT" in "200 text/event-stream"*) pass "Punong Barangay may open the stream ($CT)";; *) fail "Punong Barangay stream: '$CT'";; esac
sleep 5   # the single-threaded server notices the closed client on its next keep-alive write

# ============================================================
step "2. Opening streams is rate limited"
WIN=$("$PHP_BIN" -r 'echo gmdate("Y-m-d H:i:s", intdiv(time(),300)*300);')
mysql_exec "$VALDB" -e "INSERT INTO rate_limit_counter (limiter_key, window_start, request_count) VALUES ('gps_stream:user:$ADMIN_ID', '$WIN', 40) ON DUPLICATE KEY UPDATE request_count=40;"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ADMIN" "$URL_A/gps/stream?barangay_id=1")" "429" "The 41st stream in a window is refused"
mysql_exec "$VALDB" -e "DELETE FROM rate_limit_counter WHERE limiter_key='gps_stream:user:$ADMIN_ID';"

# ============================================================
step "3 and 4. Snapshot, pushed positions and push latency (10 posts)"
SSE="$OUT_DIR/main.txt"; : > "$SSE"
open_stream "$ADMIN" 1 30 "$SSE"
sleep 1.5
# A fix from the other barangay, which must never appear in this stream:
mysql_exec "$VALDB" -e "INSERT INTO gps_track (user_id, latitude, longitude, accuracy_m, recorded_at, received_at, client_event_id) VALUES ($TANOD2_ID, 12.9501, 123.6501, 8, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UUID());"
declare -a T0S LATS
for i in 1 2 3 4 5 6 7 8 9 10; do
  LAT=$("$PHP_BIN" -r "printf('%.5f', 12.90005 + $i * 0.0001);")
  BODY="{\"latitude\":$LAT,\"longitude\":123.6000,\"accuracy_m\":8,\"recorded_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"client_event_id\":\"$(uuid)\"}"
  T0=$(now_ms)
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL_B/gps" -H "Authorization: Bearer $TANOD" -H "X-Device-Id: $DEVICE_ID" -H 'Content-Type: application/json' -d "$BODY")
  [ "$CODE" = "201" ] || fail "POST /gps $i returned $CODE"
  T0S[$i]=$T0; LATS[$i]=$LAT
  sleep 0.7
done
wait "$STREAM_PID"
FIRST_EVENT=$(grep -m1 ' event: ' "$SSE" | sed 's/^[0-9]* //')
expect_eq "$FIRST_EVENT" "event: snapshot" "The first event is the snapshot"
SNAP_IDS=$(grep -m1 ' data: ' "$SSE" | sed 's/^[0-9]* data: //' | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $ids=array_map(fn($x)=>$x["user_id"],$d["items"]); sort($ids); echo implode(",",$ids);')
LIVE_IDS=$(curl -s -H "Authorization: Bearer $ADMIN" "$URL_B/gps/live?barangay_id=1" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $ids=array_map(fn($x)=>$x["user_id"],$d["items"] ?? []); sort($ids); echo implode(",",$ids);')
expect_eq "$SNAP_IDS" "$LIVE_IDS" "The snapshot lists the same tanods as GET /gps/live"
POS_COUNT=$(grep -c ' event: position' "$SSE")
[ "$POS_COUNT" -ge 10 ] && pass "At least 10 position events were pushed ($POS_COUNT)" || fail "Only $POS_COUNT position events for 10 posts"

LAT_LIST=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  line=$(grep -m1 "\"latitude\":${LATS[$i]}" "$SSE")
  if [ -z "$line" ]; then fail "Post $i (latitude ${LATS[$i]}) was never pushed"; continue; fi
  ARR=$(echo "$line" | cut -d' ' -f1)
  LAT_LIST="$LAT_LIST $((ARR - ${T0S[$i]}))"
done
STATS=$("$PHP_BIN" -r '$v=array_map("intval", array_filter(explode(" ", trim($argv[1])), "strlen")); sort($v); $n=count($v); if($n==0){echo "n=0";exit;} $p=function($q) use($v,$n){return $v[(int)min($n-1, max(0, ceil($q*$n)-1))];}; echo json_encode(["n"=>$n,"p50_ms"=>$p(0.5),"p95_ms"=>$p(0.95),"max_ms"=>max($v),"min_ms"=>min($v)]);' "$LAT_LIST")
echo "  PUSH LATENCY (POST /gps start -> event arrival, loopback): $STATS"
P50=$(echo "$STATS" | json_field p50_ms); MAXL=$(echo "$STATS" | json_field max_ms)
[ -n "$P50" ] && [ "$P50" -lt 1500 ] 2>/dev/null && pass "Median push latency under 1.5 s ($P50 ms)" || fail "Median push latency too high or missing ($P50 ms)"
[ -n "$MAXL" ] && [ "$MAXL" -lt 3000 ] 2>/dev/null && pass "Worst push latency under 3 s ($MAXL ms)" || fail "Worst push latency too high or missing ($MAXL ms)"
"$PHP_BIN" -r 'file_put_contents($argv[1], json_encode(["measured_at"=>gmdate("c"),"what"=>"POST /gps start to position event arrival, 10 posts","where"=>"workstation loopback, disposable DB, no phone, no mobile network, includes curl start-up","stats"=>json_decode($argv[2],true)], JSON_PRETTY_PRINT));' "$BACKEND_DIR/storage/push-latency-last-run.json" "$STATS"

step "5. Tenant isolation"
grep -q "Other Barangay" "$SSE" && fail "A tanod of another barangay was pushed into this barangay's stream" || pass "No position from another barangay appears in the stream"
sleep 4

# ============================================================
step "6. A revoked session ends the stream with auth_expired"
SSE2="$OUT_DIR/revoke.txt"; : > "$SSE2"
T_START=$(now_ms)
open_stream "$TANOD" 1 40 "$SSE2"
sleep 2
mysql_exec "$VALDB" -e "UPDATE auth_session SET revoked_at=UTC_TIMESTAMP() WHERE user_id=$TANOD_ID AND revoked_at IS NULL;"
wait "$STREAM_PID"
T_END=$(now_ms)
grep -q ' event: auth_expired' "$SSE2" && pass "The stream ended with auth_expired" || fail "No auth_expired event after the session was revoked"
EL=$(( (T_END - T_START) / 1000 ))
[ "$EL" -le 22 ] && pass "...within the re-check window (${EL} s of 22 s allowed)" || fail "Stream stayed open ${EL} s after revocation"

step "7. Source guards"
grep -q 'STREAM_MAX_SECONDS = 300' "$BACKEND_DIR/controllers/GpsController.php" && pass "A stream is bounded to 300 s (the client reopens it)" || fail "STREAM_MAX_SECONDS is not 300"
grep -q -E 'PHP (Fatal|Parse) error' "$BACKEND_DIR/scripts/.gsstream-a.log" "$BACKEND_DIR/scripts/.gsstream-b.log" && fail "PHP fatal error in a server log" || pass "No PHP fatal errors in the server logs"

echo
echo "================================================================"
echo "RESULT: $PASS passed, $FAIL failed."
echo "================================================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
