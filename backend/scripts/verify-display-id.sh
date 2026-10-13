#!/usr/bin/env bash
# Baranguard - incident display-code (INC-YYYY-NNN) verification, migration 0043.
#
# Proves: the full migration chain applies (incl. 0043: unique per (barangay_id,
# display_id), old global key gone, re-run no-op, down/up); two barangays can
# each hold INC-<year>-001 (the case the old global key broke with a 500); the
# next number is MAX+1 so a deleted/purged incident's number is never re-issued;
# an idempotent retry returns the original code; the Punong Barangay exact
# search accepts a lower-case code and the unofficial INC-#<id> form.
# Not covered (single-threaded `php -S`): truly simultaneous filings; the
# FOR UPDATE serialisation is reasoned, not demonstrated.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (Git Bash): bash backend/scripts/verify-display-id.sh

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
VALDB="${VALDB_OVERRIDE:-baranguard_dispid_check}"
APP_USER="${APP_USER_OVERRIDE:-dispidchk_app}"
APP_PASSWORD="DispIdChk!2026Pw"
API_PORT="${API_PORT_OVERRIDE:-8197}"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="DispIdCheck#2026Pw"

echo "Baranguard display-id verification — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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

mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
YEAR="$("$PHP_BIN" -r 'echo (new DateTime("now", new DateTimeZone("Asia/Manila")))->format("Y");')"

# ============================================================
step "0. Full migration chain on a fresh database"
# ============================================================
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
CHAIN_FAIL=0
for f in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sort); do
  if ! ERR="$(mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$f" 2>&1)"; then fail "migration $f failed: $ERR"; CHAIN_FAIL=1; fi
done
[ "$CHAIN_FAIL" -eq 0 ] && pass "Every migration applied"
idx() { db_one "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema='$VALDB' AND table_name='incident' AND index_name='$1';"; }
expect_eq "$(idx uq_incident_barangay_display)" "2" "uq_incident_barangay_display covers (barangay_id, display_id)"
expect_eq "$(idx uq_incident_display_id)" "0" "the old global uq_incident_display_id is gone"
M43="$BACKEND_DIR/migrations/0043_display_id_unique_per_barangay.sql"
M43D="$BACKEND_DIR/migrations/0043_display_id_unique_per_barangay.down.sql"
ERR="$(mysql_exec "$VALDB" < "$M43" 2>&1)" && pass "0043 re-run is a clean no-op" || fail "0043 re-run failed: $ERR"
ERR="$(mysql_exec "$VALDB" < "$M43D" 2>&1)" && pass "0043 .down.sql applies (no cross-barangay duplicates yet)" || fail "0043 down failed: $ERR"
expect_eq "$(idx uq_incident_display_id)/$(idx uq_incident_barangay_display)" "1/0" "down restores the global key"
ERR="$(mysql_exec "$VALDB" < "$M43" 2>&1)" && pass "0043 re-applies after down" || fail "0043 re-apply failed: $ERR"
expect_eq "$(idx uq_incident_display_id)/$(idx uq_incident_barangay_display)" "0/2" "up again: per-barangay key only"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'di_sec','$HASH','DI Secretary','secretary',1,UTC_TIMESTAMP()),
 (1,'di_pb','$HASH','DI PB','punong_barangay',1,UTC_TIMESTAMP()),
 (2,'di_sec2','$HASH','DI Secretary Two','secretary',1,UTC_TIMESTAMP());
SQL

# ============================================================
step "1. Start API + login"
# ============================================================
( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="dispidchk-verify-secret-key-not-real-0123456789" \
  "$PHP_BIN" -S 127.0.0.1:$API_PORT -t public public/dev-router.php > "$BACKEND_DIR/scripts/.${APP_USER}-server.log" 2>&1 ) &
SERVER_PID=$!
sleep 2
token_for() {
  curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | json_field token
}
SEC=$(token_for di_sec); PB=$(token_for di_pb); SEC2=$(token_for di_sec2)
if [ -n "$SEC" ] && [ -n "$PB" ] && [ -n "$SEC2" ]; then pass "Tokens acquired for all 3 accounts"; else fail "Login failed - see .${APP_USER}-server.log"; exit 1; fi

# ============================================================
step "2. Two barangays can both hold INC-$YEAR-001"
# ============================================================
BODY='{"incident_type":"theft","raw_narrative":"DISPID narrative"}'
call POST "$BASE_URL/incidents" "$SEC" "$BODY" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field display_id)" "201/INC-$YEAR-001" "Barangay 1 first incident"
I1=$(echo "$RESP_BODY" | json_field incident_id)
call POST "$BASE_URL/incidents" "$SEC" "$BODY" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field display_id)" "201/INC-$YEAR-002" "Barangay 1 second incident"
call POST "$BASE_URL/incidents" "$SEC2" "$BODY" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field display_id)" "201/INC-$YEAR-001" "Barangay 2 first incident reuses the same number (was a 500 under the global key)"
expect_eq "$(db_one "SELECT COUNT(*) FROM incident WHERE display_id='INC-$YEAR-001';")" "2" "Two incidents hold INC-$YEAR-001, one per barangay"
expect_eq "$(db_one "SELECT COUNT(*) FROM (SELECT barangay_id, display_id FROM incident GROUP BY barangay_id, display_id HAVING COUNT(*)>1) d;")" "0" "No duplicate inside a barangay"

# ============================================================
step "3. A deleted incident's number is never re-issued"
# ============================================================
mysql_exec "$VALDB" -e "DELETE FROM incident WHERE incident_id=$I1;"
call POST "$BASE_URL/incidents" "$SEC" "$BODY" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE/$(echo "$RESP_BODY" | json_field display_id)" "201/INC-$YEAR-003" "Next number after purging #001 is MAX+1 (003), not COUNT+1 (which would re-issue 002)"

# ============================================================
step "4. Idempotent retry returns the original code"
# ============================================================
KEY="$(uuid)"
call POST "$BASE_URL/incidents" "$SEC" "$BODY" "Idempotency-Key: $KEY"
FIRST_CODE=$(echo "$RESP_BODY" | json_field display_id); FIRST_ID=$(echo "$RESP_BODY" | json_field incident_id)
call POST "$BASE_URL/incidents" "$SEC" "$BODY" "Idempotency-Key: $KEY"
expect_eq "$(echo "$RESP_BODY" | json_field display_id)/$(echo "$RESP_BODY" | json_field incident_id)" "$FIRST_CODE/$FIRST_ID" "Replay returns the same code and the same incident"
expect_eq "$FIRST_CODE" "INC-$YEAR-004" "Fourth incident of barangay 1 is 004"

# ============================================================
step "5. Year comes from Asia/Manila"
# ============================================================
expect_eq "$(db_one "SELECT COUNT(*) FROM incident WHERE barangay_id=1 AND display_id NOT LIKE 'INC-$YEAR-%';")" "0" "Every barangay-1 code carries the Manila year $YEAR"

# ============================================================
step "6. Search: lower-case code, INC-#id, and the code for staff roles"
# ============================================================
ID2=$(db_one "SELECT incident_id FROM incident WHERE barangay_id=1 AND display_id='INC-$YEAR-002';")
ids_of() { echo "$RESP_BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo implode(",", array_map(fn($i)=>$i["incident_id"], $d["items"] ?? []));'; }
call GET "$BASE_URL/search?q=inc-$YEAR-002" "$PB" ""
expect_eq "$RESP_CODE/$(ids_of)" "200/$ID2" "Punong Barangay: a lower-case code finds exactly that incident"
call GET "$BASE_URL/search?q=INC-%23$ID2" "$PB" ""
expect_eq "$(ids_of)" "$ID2" "Punong Barangay: the unofficial INC-#$ID2 form finds the incident by its id"
call GET "$BASE_URL/search?q=INC-$YEAR-001" "$PB" ""
expect_eq "$(ids_of)" "" "Punong Barangay in barangay 1 does not find barangay 2's INC-$YEAR-001 (the one in barangay 1 was purged)"
call GET "$BASE_URL/search?q=INC-$YEAR-002" "$SEC" ""
expect_eq "$RESP_CODE/$(ids_of)" "200/$ID2" "Secretary: typing the code finds the incident (was id-only)"
expect_eq "$(echo "$RESP_BODY" | json_field items.0.display_id)" "INC-$YEAR-002" "Search results now carry display_id"
call GET "$BASE_URL/search?q=INC-$YEAR-001" "$SEC2" ""
expect_eq "$(echo "$RESP_BODY" | json_field items.0.display_id)" "INC-$YEAR-001" "Secretary of barangay 2 finds their own INC-$YEAR-001"

step "Summary"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
[ "$FAIL" -eq 0 ]
