#!/usr/bin/env bash
# Baranguard — incident referral ("Delegated to") backend verification.
# docs/FEATURE_CONTRACT_2026-10.md §5, migration 0032, ReferralsController.
#
# Covers: POST /incidents/:id/referrals (happy path, validation, web
# Idempotency-Key replay, Tanod client_event_id + ownership, role 403s,
# cross-tenant 404), GET /incidents/:id/referrals, the aggregate-only
# GET /referrals log (shape, no narrative/name/contact leakage, filters,
# Manila-day bucketing, pagination), the /sync/batch `referrals[]` path
# (incident_client_event_id resolution, replay, rejection), audit rows
# (allow-listed metadata), and the migration's re-apply / down / up cycle.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage: bash backend/scripts/verify-referrals.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
warn() { echo "[WARN] $1"; }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
# Port default: backend/.env's DB_PORT (this machine's XAMPP MariaDB is
# not on 3306 — see docs/REFERENCE.md Sec 8), then the stock 3306.
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_ref_check"
APP_USER="refchk_app"
APP_PASSWORD="RefChk!2026Pw"
API_PORT="8601"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="RefCheck#2026Pw"

echo "Baranguard referral backend verification — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  # Explicit XAMPP path first, PATH only as a fallback (docs/REFERENCE.md Sec 8).
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
json_keys() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=explode(".",$argv[1]); $v=$d; foreach($k as $p){$v=is_array($v)?($v[$p]??null):null;} if(!is_array($v)){echo "NOT_ARRAY";exit;} $keys=array_keys($v); sort($keys); echo implode(",",$keys);' "$1"; }
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }

# call METHOD URL TOKEN BODY [header ...] -> sets RESP_CODE / RESP_BODY
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
  rm -f "$BACKEND_DIR/scripts/.refchk-server.log"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

# ============================================================
step "0. Setup — full migration chain, two barangays, roles, devices, incidents"
# ============================================================
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
CHAIN_FAIL=0
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort | awk -v s=0001_baseline_schema '$0 >= s'); do
  if ! ERR="$(mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" 2>&1)"; then
    num="${m%%_*}"
    case "$num" in
      0030|0031|0033)
        # Owned by other agents building concurrently; this suite only
        # depends on tables through 0029 plus 0032.
        warn "migration $m (not owned by this suite) failed: $ERR" ;;
      *)
        fail "migration $m failed: $ERR"; CHAIN_FAIL=1 ;;
    esac
  fi
done
[ "$CHAIN_FAIL" -eq 0 ] && pass "Migration chain applied (all migrations/*.sql, globbed; 0032 included)"
TBL=$(db_one "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$VALDB' AND table_name='incident_referral';")
expect_eq "$TBL" "1" "incident_referral table exists"
UNIQ=$(db_one "SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema='$VALDB' AND table_name='incident_referral' AND index_name='uq_referral_creator_event';")
expect_eq "$UNIQ" "created_by,client_event_id" "UNIQUE(created_by, client_event_id) is in place"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'rf_admin','$HASH','RF Admin','admin',1,UTC_TIMESTAMP()),
 (1,'rf_secretary','$HASH','RF Secretary','secretary',1,UTC_TIMESTAMP()),
 (1,'rf_pb','$HASH','RF Punong Barangay','punong_barangay',1,UTC_TIMESTAMP()),
 (1,'rf_tanod_a','$HASH','RF Tanod A','tanod',1,UTC_TIMESTAMP()),
 (1,'rf_tanod_b','$HASH','RF Tanod B','tanod',1,UTC_TIMESTAMP()),
 (1,'rf_tanod_c','$HASH','RF Tanod C','tanod',1,UTC_TIMESTAMP()),
 (2,'rf_admin2','$HASH','RF Admin Two','admin',1,UTC_TIMESTAMP());
SQL
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
ADMIN_ID=$(uid rf_admin); TA_ID=$(uid rf_tanod_a); TB_ID=$(uid rf_tanod_b); TC_ID=$(uid rf_tanod_c); ADMIN2_ID=$(uid rf_admin2)
DEV_A="refchk-device-a"; DEV_B="refchk-device-b"; DEV_C="refchk-device-c"
mysql_exec "$VALDB" <<SQL
INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES
 ('$DEV_A', $TA_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP()),
 ('$DEV_B', $TB_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP()),
 ('$DEV_C', $TC_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());
SQL

# INC1: reported by Tanod A (barangay 1), carries a narrative + party name
#       that must NEVER appear in the referral log.
# INC2: reported by Admin, dispatched to Tanod C (barangay 1).
# INC3: barangay 2.
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, complainant_name, status, source, latitude, longitude, created_at, updated_at) VALUES
 (1, $TA_ID,    'theft','normal','REF_SECRET_NARRATIVE_ONE','Juan Citizen Marker','pending','app',12.9000,123.6000,UTC_TIMESTAMP(),UTC_TIMESTAMP()),
 (1, $ADMIN_ID, 'fire','high','REF_SECRET_NARRATIVE_TWO','Maria Citizen Marker','pending','web',12.9100,123.6100,UTC_TIMESTAMP(),UTC_TIMESTAMP()),
 (2, $ADMIN2_ID,'theft','normal','REF_SECRET_NARRATIVE_B2','B2 Citizen Marker','pending','web',12.9200,123.6200,UTC_TIMESTAMP(),UTC_TIMESTAMP());
SQL
INC1=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='REF_SECRET_NARRATIVE_ONE';")
INC2=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='REF_SECRET_NARRATIVE_TWO';")
INC3=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='REF_SECRET_NARRATIVE_B2';")
mysql_exec "$VALDB" -e "INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, status, dispatched_at, created_client_request_id) VALUES ($INC2, $ADMIN_ID, $TC_ID, 'high','assigned',UTC_TIMESTAMP(),UUID());"
pass "Seeded: admin/secretary/PB + 3 tanods (+ barangay-2 admin), incidents #$INC1 (Tanod A's), #$INC2 (dispatched to Tanod C), #$INC3 (barangay 2)"

( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="refchk-verify-secret-key-not-real-0123456789" \
  "$PHP_BIN" -S 127.0.0.1:$API_PORT -t public public/dev-router.php > "$BACKEND_DIR/scripts/.refchk-server.log" 2>&1 ) &
SERVER_PID=$!
sleep 2

token_for() {
  curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | json_field token
}
ADMIN=$(token_for rf_admin); SEC=$(token_for rf_secretary); PB=$(token_for rf_pb)
TA=$(token_for rf_tanod_a); TB=$(token_for rf_tanod_b); TC=$(token_for rf_tanod_c); ADMIN2=$(token_for rf_admin2)
if [ -n "$ADMIN" ] && [ -n "$SEC" ] && [ -n "$PB" ] && [ -n "$TA" ] && [ -n "$TB" ] && [ -n "$TC" ] && [ -n "$ADMIN2" ]; then
  pass "Tokens acquired for all 7 accounts"
else
  fail "Login failed — see .refchk-server.log"; exit 1
fi
HA="X-Device-Id: $DEV_A"; HB="X-Device-Id: $DEV_B"; HC="X-Device-Id: $DEV_C"
refs_for_incident() { db_one "SELECT COUNT(*) FROM incident_referral WHERE incident_id=$1;"; }

# ============================================================
step "1. POST /incidents/:id/referrals — Admin/Secretary (Idempotency-Key)"
# ============================================================
K1=$(uuid)
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"pnp","contact_name":"PO2 Unit-Marker-XYZ","reference_no":"BLTR-2026-0042"}' "Idempotency-Key: $K1"
expect_eq "$RESP_CODE" "201" "Admin creates a referral (pnp) -> 201"
REF1=$(echo "$RESP_BODY" | json_field referral_id)
expect_eq "$(echo "$RESP_BODY" | json_field referred_to)" "pnp" "Response carries referred_to"
expect_eq "$(echo "$RESP_BODY" | json_field incident_id)" "$INC1" "Response carries incident_id"
expect_eq "$(echo "$RESP_BODY" | json_field contact_name)" "PO2 Unit-Marker-XYZ" "contact_name stored (responder/unit label)"
expect_eq "$(echo "$RESP_BODY" | json_field reference_no)" "BLTR-2026-0042" "reference_no stored"
[ -n "$(echo "$RESP_BODY" | json_field referred_at)" ] && pass "referred_at defaults to now when omitted" || fail "referred_at missing"

call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"pnp","contact_name":"PO2 Unit-Marker-XYZ","reference_no":"BLTR-2026-0042"}' "Idempotency-Key: $K1"
expect_eq "$RESP_CODE" "200" "Replay with the SAME Idempotency-Key -> 200 (not 201)"
expect_eq "$(echo "$RESP_BODY" | json_field referral_id)" "$REF1" "Replay returns the ORIGINAL referral_id"
expect_eq "$(refs_for_incident $INC1)" "1" "Exactly one row exists after the replay"

call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"bfp"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "201" "Multiple referrals per incident are allowed (second, bfp)"
expect_eq "$(refs_for_incident $INC1)" "2" "Two referral rows on the incident"

call POST "$BASE_URL/incidents/$INC1/referrals" "$SEC" '{"referred_to":"vaw_desk"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "201" "Secretary creates a referral (vaw_desk) -> 201"

call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"other","other_text":"Municipal Social Welfare Office"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "201" "referred_to=other with other_text -> 201"
expect_eq "$(echo "$RESP_BODY" | json_field other_text)" "Municipal Social Welfare Office" "other_text stored"

call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"doh","other_text":"RHU Pilar"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "201" "other_text is optional free label for non-'other' targets"

call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"pnp","referred_at":"2026-03-01T17:00:00Z","reference_no":"BUCKET-PROBE"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "201" "Explicit past referred_at (ISO, Z) accepted"
expect_eq "$(db_one "SELECT referred_at FROM incident_referral WHERE reference_no='BUCKET-PROBE';")" "2026-03-01 17:00:00" "referred_at stored as UTC"

# ============================================================
step "2. Validation"
# ============================================================
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"pnp"}' ""
expect_eq "$RESP_CODE" "400" "Missing Idempotency-Key -> 400"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"pnp"}' "Idempotency-Key: not-a-uuid"
expect_eq "$RESP_CODE" "400" "Non-UUID Idempotency-Key -> 400"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"police"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "Unknown referred_to -> 400"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "Missing referred_to -> 400"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"other"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "referred_to=other without other_text -> 400"
LONG101="$("$PHP_BIN" -r 'echo str_repeat("x",101);')"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" "{\"referred_to\":\"pnp\",\"contact_name\":\"$LONG101\"}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "contact_name > 100 chars -> 400"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" "{\"referred_to\":\"other\",\"other_text\":\"$LONG101\"}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "other_text > 100 chars -> 400"
LONG65="$("$PHP_BIN" -r 'echo str_repeat("r",65);')"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" "{\"referred_to\":\"pnp\",\"reference_no\":\"$LONG65\"}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "reference_no > 64 chars -> 400"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"pnp","referred_at":"yesterday"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "Unparseable referred_at -> 400"
FUTURE="$("$PHP_BIN" -r 'echo gmdate("Y-m-d\TH:i:s\Z", time()+7200);')"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" "{\"referred_to\":\"pnp\",\"referred_at\":\"$FUTURE\"}" "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "referred_at 2h in the future -> 400"
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" '{"referred_to":"pnp","contact_name":42}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "400" "Non-string contact_name -> 400"
call POST "$BASE_URL/incidents/999999/referrals" "$ADMIN" '{"referred_to":"pnp"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Nonexistent incident -> 404"
call POST "$BASE_URL/incidents/abc/referrals" "$ADMIN" '{"referred_to":"pnp"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Non-numeric incident id -> 404 (no route match)"

# ============================================================
step "3. Role gates"
# ============================================================
call POST "$BASE_URL/incidents/$INC1/referrals" "$PB" '{"referred_to":"pnp"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "403" "Punong Barangay cannot create a referral (read-only role) -> 403"
call POST "$BASE_URL/incidents/$INC1/referrals" "" '{"referred_to":"pnp"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "401" "Unauthenticated POST -> 401"
call GET "$BASE_URL/referrals" "$TA" ""
expect_eq "$RESP_CODE" "403" "Tanod cannot read the barangay-wide referral log -> 403"

# ============================================================
step "4. Tanod: client_event_id + X-Device-Id + ownership"
# ============================================================
TE1=$(uuid)
BODY_T="{\"referred_to\":\"bfp\",\"contact_name\":\"Engine 3\",\"client_event_id\":\"$TE1\"}"
call POST "$BASE_URL/incidents/$INC1/referrals" "$TA" "$BODY_T" "$HA"
expect_eq "$RESP_CODE" "201" "Tanod A (reporter of the incident) creates a referral -> 201"
TREF=$(echo "$RESP_BODY" | json_field referral_id)
call POST "$BASE_URL/incidents/$INC1/referrals" "$TA" "$BODY_T" "$HA"
expect_eq "$RESP_CODE" "200" "Replay with the same client_event_id -> 200"
expect_eq "$(echo "$RESP_BODY" | json_field referral_id)" "$TREF" "Replay returns the original referral_id"
expect_eq "$(db_one "SELECT COUNT(*) FROM incident_referral WHERE client_event_id='$TE1';")" "1" "One row for that client_event_id"
expect_eq "$(db_one "SELECT created_by FROM incident_referral WHERE referral_id=$TREF;")" "$TA_ID" "created_by is the authenticated Tanod, never a body field"

call POST "$BASE_URL/incidents/$INC1/referrals" "$TA" "{\"referred_to\":\"pnp\",\"client_event_id\":\"$(uuid)\"}" ""
expect_eq "$RESP_CODE" "400" "Tanod POST without X-Device-Id -> 400"
call POST "$BASE_URL/incidents/$INC1/referrals" "$TA" "{\"referred_to\":\"pnp\",\"client_event_id\":\"$(uuid)\"}" "X-Device-Id: not-this-tanods-device"
expect_eq "$RESP_CODE" "422" "Tanod POST with a device not registered to them -> 422"
call POST "$BASE_URL/incidents/$INC1/referrals" "$TA" "{\"referred_to\":\"pnp\",\"client_event_id\":\"$(uuid)\"}" "$HB"
expect_eq "$RESP_CODE" "422" "Tanod A cannot use Tanod B's device -> 422"
call POST "$BASE_URL/incidents/$INC1/referrals" "$TA" '{"referred_to":"pnp"}' "$HA"
expect_eq "$RESP_CODE" "400" "Tanod POST without client_event_id -> 400"
call POST "$BASE_URL/incidents/$INC1/referrals" "$TA" '{"referred_to":"pnp","client_event_id":"nope"}' "$HA"
expect_eq "$RESP_CODE" "400" "Tanod POST with a non-UUID client_event_id -> 400"

call POST "$BASE_URL/incidents/$INC1/referrals" "$TB" "{\"referred_to\":\"pnp\",\"client_event_id\":\"$(uuid)\"}" "$HB"
expect_eq "$RESP_CODE" "404" "Tanod B (unrelated to the incident) -> 404, never 403"
expect_eq "$(refs_for_incident $INC1)" "7" "Unrelated Tanod's attempt wrote nothing (7 rows on INC1)"

call POST "$BASE_URL/incidents/$INC2/referrals" "$TC" "{\"referred_to\":\"ambulance_ems\",\"client_event_id\":\"$(uuid)\"}" "$HC"
expect_eq "$RESP_CODE" "201" "Tanod C (holds a dispatch on the incident) creates a referral -> 201"
call POST "$BASE_URL/incidents/$INC2/referrals" "$TA" "{\"referred_to\":\"pnp\",\"client_event_id\":\"$(uuid)\"}" "$HA"
expect_eq "$RESP_CODE" "404" "Tanod A on INC2 (neither reporter nor dispatched) -> 404"

# Referral must not alter incident/dispatch state.
expect_eq "$(db_one "SELECT status FROM incident WHERE incident_id=$INC2;")" "pending" "Referral did NOT change the incident status"
expect_eq "$(db_one "SELECT status FROM dispatch WHERE incident_id=$INC2;")" "assigned" "Referral did NOT change the dispatch status"

# ============================================================
step "5. Cross-tenant -> 404, never 403"
# ============================================================
call POST "$BASE_URL/incidents/$INC1/referrals" "$ADMIN2" '{"referred_to":"pnp"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Barangay-2 admin POST on barangay-1 incident -> 404"
call POST "$BASE_URL/incidents/$INC3/referrals" "$ADMIN" '{"referred_to":"pnp"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Barangay-1 admin POST on barangay-2 incident -> 404"
call POST "$BASE_URL/incidents/$INC3/referrals" "$SEC" '{"referred_to":"pnp"}' "Idempotency-Key: $(uuid)"
expect_eq "$RESP_CODE" "404" "Barangay-1 secretary POST on barangay-2 incident -> 404"
call GET "$BASE_URL/incidents/$INC1/referrals" "$ADMIN2" ""
expect_eq "$RESP_CODE" "404" "Barangay-2 admin GET referrals of barangay-1 incident -> 404"
expect_eq "$(refs_for_incident $INC3)" "0" "No referral rows were written on the foreign incident"

# ============================================================
step "6. GET /incidents/:id/referrals"
# ============================================================
call GET "$BASE_URL/incidents/$INC1/referrals" "$ADMIN" ""
expect_eq "$RESP_CODE" "200" "Admin lists referrals of an incident -> 200"
expect_eq "$(echo "$RESP_BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo count($d["items"]);')" "7" "All 7 referrals on INC1 returned"
expect_eq "$(echo "$RESP_BODY" | json_keys items.0)" "contact_name,created_at,incident_id,other_text,reference_no,referral_id,referred_at,referred_to" "Per-incident row shape"
echo "$RESP_BODY" | grep -q 'Unit-Marker-XYZ' && pass "Per-incident view shows the responder/unit contact_name" || fail "contact_name missing from per-incident view"
for role in SEC PB TA; do
  call GET "$BASE_URL/incidents/$INC1/referrals" "${!role}" ""
  expect_eq "$RESP_CODE" "200" "$role can read referrals of INC1"
done
call GET "$BASE_URL/incidents/$INC1/referrals" "$TB" ""
expect_eq "$RESP_CODE" "404" "Unrelated Tanod B -> 404"
call GET "$BASE_URL/incidents/999999/referrals" "$ADMIN" ""
expect_eq "$RESP_CODE" "404" "Nonexistent incident -> 404"
call GET "$BASE_URL/incidents/$INC1/referrals" "" ""
expect_eq "$RESP_CODE" "401" "Unauthenticated GET -> 401"

# ============================================================
step "7. GET /referrals — aggregate-only delegation log"
# ============================================================
B1_TOTAL=$(db_one "SELECT COUNT(*) FROM incident_referral WHERE barangay_id=1;")
call GET "$BASE_URL/referrals?limit=100" "$ADMIN" ""
expect_eq "$RESP_CODE" "200" "Admin reads the referral log -> 200"
expect_eq "$(echo "$RESP_BODY" | json_field total)" "$B1_TOTAL" "total equals the barangay's referral count ($B1_TOTAL)"
expect_eq "$(echo "$RESP_BODY" | json_keys items.0)" "display_id,incident_id,incident_type,other_text,reference_no,referral_id,referred_at,referred_to" "Row shape is EXACTLY the 8 contract fields"
for leak in REF_SECRET Juan Maria Citizen Unit-Marker-XYZ "Engine 3" latitude longitude complainant raw_narrative contact_name; do
  if echo "$RESP_BODY" | grep -q "$leak"; then fail "LEAK: log response contains '$leak'"; else pass "Log response never contains '$leak'"; fi
done
call GET "$BASE_URL/referrals" "$SEC" ""
expect_eq "$RESP_CODE" "200" "Secretary can read the log"
call GET "$BASE_URL/referrals" "$PB" ""
expect_eq "$RESP_CODE" "200" "Punong Barangay can read the log"
call GET "$BASE_URL/referrals" "" ""
expect_eq "$RESP_CODE" "401" "Unauthenticated -> 401"

call GET "$BASE_URL/referrals?limit=100" "$ADMIN2" ""
expect_eq "$(echo "$RESP_BODY" | json_field total)" "0" "Barangay-2 admin sees none of barangay 1's referrals"

call GET "$BASE_URL/referrals?referred_to=pnp&limit=100" "$ADMIN" ""
PNP_DB=$(db_one "SELECT COUNT(*) FROM incident_referral WHERE barangay_id=1 AND referred_to='pnp';")
expect_eq "$(echo "$RESP_BODY" | json_field total)" "$PNP_DB" "referred_to=pnp filter total matches the DB"
call GET "$BASE_URL/referrals?referred_to=police" "$ADMIN" ""
expect_eq "$RESP_CODE" "400" "Invalid referred_to filter -> 400"

# Manila-day bucketing: 2026-03-01T17:00:00Z is 2026-03-02 01:00 in Manila.
call GET "$BASE_URL/referrals?from=2026-03-02&to=2026-03-02" "$ADMIN" ""
expect_eq "$(echo "$RESP_BODY" | json_field total)" "1" "Manila-day bucketing: 17:00Z on Mar 1 falls on Manila Mar 2"
expect_eq "$(echo "$RESP_BODY" | json_field items.0.reference_no)" "BUCKET-PROBE" "...and it is the probe row"
call GET "$BASE_URL/referrals?from=2026-03-01&to=2026-03-01" "$ADMIN" ""
expect_eq "$(echo "$RESP_BODY" | json_field total)" "0" "Manila Mar 1 does NOT contain it"
TODAY_MNL="$("$PHP_BIN" -r 'echo gmdate("Y-m-d", time()+8*3600);')"
call GET "$BASE_URL/referrals?from=$TODAY_MNL&to=$TODAY_MNL&limit=100" "$ADMIN" ""
expect_eq "$(echo "$RESP_BODY" | json_field total)" "$((B1_TOTAL - 1))" "Today's Manila date holds every referral except the back-dated probe"
call GET "$BASE_URL/referrals?from=2026-04-02&to=2026-04-01" "$ADMIN" ""
expect_eq "$RESP_CODE" "400" "from after to -> 400"
call GET "$BASE_URL/referrals?from=02-03-2026" "$ADMIN" ""
expect_eq "$RESP_CODE" "400" "Malformed from -> 400"
call GET "$BASE_URL/referrals?to=2026-02-30" "$ADMIN" ""
expect_eq "$RESP_CODE" "400" "Impossible calendar date -> 400"

call GET "$BASE_URL/referrals?limit=2" "$ADMIN" ""
expect_eq "$(echo "$RESP_BODY" | json_field limit)" "2" "limit echoed"
expect_eq "$(echo "$RESP_BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo count($d["items"]);')" "2" "limit=2 returns 2 items"
expect_eq "$(echo "$RESP_BODY" | json_field total)" "$B1_TOTAL" "total is unaffected by limit"
P1_FIRST=$(echo "$RESP_BODY" | json_field items.0.referral_id)
call GET "$BASE_URL/referrals?limit=2&page=2" "$ADMIN" ""
expect_eq "$(echo "$RESP_BODY" | json_field page)" "2" "page echoed"
[ "$(echo "$RESP_BODY" | json_field items.0.referral_id)" != "$P1_FIRST" ] && pass "Page 2 starts with a different row" || fail "Page 2 repeats page 1"
call GET "$BASE_URL/referrals?limit=500" "$ADMIN" ""
expect_eq "$(echo "$RESP_BODY" | json_field limit)" "100" "limit above 100 is clamped to 100"
call GET "$BASE_URL/referrals" "$ADMIN" ""
expect_eq "$(echo "$RESP_BODY" | json_field limit)" "25" "Default limit is 25"

# ============================================================
step "8. POST /sync/batch referrals[] (offline-style incident_client_event_id)"
# ============================================================
SYNC_INC_EVT=$(uuid); SYNC_REF_EVT=$(uuid); SYNC_REF2_EVT=$(uuid)
SYNC_BODY=$("$PHP_BIN" -r '
echo json_encode([
  "device_id" => $argv[1],
  "incidents" => [["incident_type"=>"theft","raw_narrative"=>"REF_SECRET_NARRATIVE_SYNC","latitude"=>13.0,"longitude"=>123.7,"client_event_id"=>$argv[2]]],
  "referrals" => [
    ["referred_to"=>"pnp","contact_name"=>"Sync Unit","incident_client_event_id"=>$argv[2],"client_event_id"=>$argv[3]],
    ["referred_to"=>"other","other_text"=>"Sync Other","incident_id"=>(int)$argv[5],"client_event_id"=>$argv[4]],
  ],
]);' "$DEV_A" "$SYNC_INC_EVT" "$SYNC_REF_EVT" "$SYNC_REF2_EVT" "$INC1")
call POST "$BASE_URL/sync/batch" "$TA" "$SYNC_BODY" "$HA"
expect_eq "$RESP_CODE" "200" "sync/batch with incident + referrals -> 200"
# Order is sos, incident, referral: results[0]=incident, [1]=ref (by incident_client_event_id), [2]=ref (by incident_id)
expect_eq "$(echo "$RESP_BODY" | json_field results.0.status)" "success" "Offline incident item succeeds"
expect_eq "$(echo "$RESP_BODY" | json_field results.1.status)" "success" "Referral resolved via incident_client_event_id succeeds (incident created earlier in the same batch)"
expect_eq "$(echo "$RESP_BODY" | json_field results.2.status)" "success" "Referral with an explicit incident_id succeeds"
SYNC_INC_ID=$(db_one "SELECT incident_id FROM incident WHERE device_id='$DEV_A' AND client_event_id='$SYNC_INC_EVT';")
expect_eq "$(db_one "SELECT incident_id FROM incident_referral WHERE client_event_id='$SYNC_REF_EVT';")" "$SYNC_INC_ID" "Referral row is attached to the offline-created incident"
expect_eq "$(db_one "SELECT created_by FROM incident_referral WHERE client_event_id='$SYNC_REF_EVT';")" "$TA_ID" "Sync referral created_by is the Tanod"
expect_eq "$(echo "$RESP_BODY" | json_field results.1.server_id)" "$(db_one "SELECT referral_id FROM incident_referral WHERE client_event_id='$SYNC_REF_EVT';")" "server_id reported for the referral item"

call POST "$BASE_URL/sync/batch" "$TA" "$SYNC_BODY" "$HA"
expect_eq "$(echo "$RESP_BODY" | json_field results.1.status)" "duplicate" "Replaying the whole batch: referral item is 'duplicate'"
expect_eq "$(echo "$RESP_BODY" | json_field results.2.status)" "duplicate" "Replaying the whole batch: second referral item is 'duplicate'"
expect_eq "$(db_one "SELECT COUNT(*) FROM incident_referral WHERE client_event_id IN ('$SYNC_REF_EVT','$SYNC_REF2_EVT');")" "2" "Still exactly 2 referral rows after the replay"

BAD_SYNC=$("$PHP_BIN" -r '
echo json_encode([
  "device_id" => $argv[1],
  "referrals" => [
    ["referred_to"=>"pnp","incident_id"=>(int)$argv[2],"client_event_id"=>$argv[5]],
    ["referred_to"=>"pnp","incident_client_event_id"=>$argv[4],"client_event_id"=>$argv[6]],
    ["referred_to"=>"nonsense","incident_id"=>(int)$argv[3],"client_event_id"=>$argv[7]],
    ["referred_to"=>"pnp","client_event_id"=>$argv[8]],
    ["referred_to"=>"pnp","incident_id"=>(int)$argv[9],"client_event_id"=>$argv[10]],
  ],
]);' "$DEV_A" "$INC3" "$INC1" "$(uuid)" "$(uuid)" "$(uuid)" "$(uuid)" "$(uuid)" "$INC2" "$(uuid)")
call POST "$BASE_URL/sync/batch" "$TA" "$BAD_SYNC" "$HA"
expect_eq "$(echo "$RESP_BODY" | json_field results.0.status)" "failed" "Sync referral on a foreign-tenant incident fails (404 semantics)"
expect_eq "$(echo "$RESP_BODY" | json_field results.1.status)" "failed" "Sync referral with an unknown incident_client_event_id fails"
expect_eq "$(echo "$RESP_BODY" | json_field results.2.status)" "failed" "Sync referral with an invalid referred_to fails"
expect_eq "$(echo "$RESP_BODY" | json_field results.3.status)" "failed" "Sync referral with neither incident_id nor incident_client_event_id fails"
expect_eq "$(echo "$RESP_BODY" | json_field results.4.status)" "failed" "Sync referral on an incident Tanod A does not own fails"
expect_eq "$(refs_for_incident $INC3)" "0" "Nothing was written to the foreign-tenant incident"

# Another device's incident_client_event_id must not resolve.
OTHER_DEV_BODY=$("$PHP_BIN" -r 'echo json_encode(["device_id"=>$argv[1],"referrals"=>[["referred_to"=>"pnp","incident_client_event_id"=>$argv[2],"client_event_id"=>$argv[3]]]]);' "$DEV_B" "$SYNC_INC_EVT" "$(uuid)")
call POST "$BASE_URL/sync/batch" "$TB" "$OTHER_DEV_BODY" "$HB"
expect_eq "$(echo "$RESP_BODY" | json_field results.0.status)" "failed" "incident_client_event_id is resolved per device — Tanod B's device cannot reference Tanod A's offline incident"

# ============================================================
step "8b. H-09 device signature, PER ITEM, on sync referrals[] (fix review finding 4)"
# ============================================================
SIG_TMP="$(mktemp -d)"; SIG_TMP_W="$(cygpath -m "$SIG_TMP")"
OPENSSL_BIN="$(command -v openssl || true)"
if [ -z "$OPENSSL_BIN" ]; then
  fail "openssl CLI not found - cannot generate a device key"
else
  "$OPENSSL_BIN" ecparam -name prime256v1 -genkey -noout -out "$SIG_TMP/c.key" 2>/dev/null
  "$OPENSSL_BIN" ec -in "$SIG_TMP/c.key" -pubout -out "$SIG_TMP/c.pub" 2>/dev/null
  PUBHEX="$("$PHP_BIN" -r 'echo bin2hex(file_get_contents($argv[1]));' "$SIG_TMP_W/c.pub")"
  mysql_exec "$VALDB" -e "UPDATE mobile_device SET device_public_key_pem = CONVERT(UNHEX('$PUBHEX') USING utf8mb4) WHERE device_id='$DEV_C';"
  SIG_REF_EVT=$(uuid); SIG_SOS_EVT=$(uuid)
  SIG_BODY=$("$PHP_BIN" -r '
  echo json_encode([
    "device_id" => $argv[1],
    "sos" => [["latitude"=>12.9,"longitude"=>123.6,"triggered_at"=>gmdate("Y-m-d\TH:i:s\Z"),"client_event_id"=>$argv[4]]],
    "referrals" => [["referred_to"=>"bfp","incident_id"=>(int)$argv[2],"client_event_id"=>$argv[3]]],
  ]);' "$DEV_C" "$INC2" "$SIG_REF_EVT" "$SIG_SOS_EVT")
  call POST "$BASE_URL/sync/batch" "$TC" "$SIG_BODY" "$HC"
  expect_eq "$RESP_CODE" "200" "Unsigned batch from a device that HAS a registered key -> 200 (per-item results)"
  expect_eq "$(echo "$RESP_BODY" | json_field results.0.status)" "success" "SOS item in the unsigned batch is still accepted (SOS is never rejected on the signature check)"
  expect_eq "$(echo "$RESP_BODY" | json_field results.1.status)" "failed" "Referral item in the same unsigned batch is rejected per item"
  expect_eq "$(echo "$RESP_BODY" | json_field results.1.reason)" "Device signature verification failed." "  ...with the device-signature reason"
  expect_eq "$(db_one "SELECT COUNT(*) FROM incident_referral WHERE client_event_id='$SIG_REF_EVT';")" "0" "  ...and nothing was written"
  TS=$(date +%s)
  SIG=$(printf 'POST\n/api/v1/sync/batch\n%s\n%s' "$DEV_C" "$TS" | "$OPENSSL_BIN" dgst -sha256 -sign "$SIG_TMP/c.key" | base64 -w0)
  call POST "$BASE_URL/sync/batch" "$TC" "$SIG_BODY" "$HC" "X-Device-Timestamp: $TS" "X-Device-Signature: $SIG"
  expect_eq "$(echo "$RESP_BODY" | json_field results.1.status)" "success" "Same batch with a valid signature: the referral item succeeds"
  expect_eq "$(db_one "SELECT COUNT(*) FROM incident_referral WHERE client_event_id='$SIG_REF_EVT';")" "1" "  ...and exactly one row exists"
fi
rm -rf "$SIG_TMP"

# ============================================================
step "8c. SQLSTATE 23000 that is NOT a duplicate must be 'failed', never 'duplicate' (fix review finding 5)"
# ============================================================
# A trigger raising SQLSTATE 23000 stands in for an FK / integrity violation: there is
# no original row for findExistingServerId() to find, so this must not read as a duplicate.
mysql_exec "$VALDB" -e "DROP TRIGGER IF EXISTS trg_refchk_integrity;"
mysql_exec "$VALDB" <<'SQL'
DELIMITER //
CREATE TRIGGER trg_refchk_integrity BEFORE INSERT ON incident_referral FOR EACH ROW
BEGIN
  IF NEW.reference_no = 'FORCE-23000' THEN
    SIGNAL SQLSTATE '23000' SET MESSAGE_TEXT = 'simulated integrity violation';
  END IF;
END//
DELIMITER ;
SQL
expect_eq "$(db_one "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='$VALDB' AND TRIGGER_NAME='trg_refchk_integrity';")" "1" "Integrity-violation trigger installed for the test"
INTEG_EVT=$(uuid)
INTEG_BODY=$("$PHP_BIN" -r 'echo json_encode(["device_id"=>$argv[1],"referrals"=>[["referred_to"=>"pnp","incident_id"=>(int)$argv[2],"reference_no"=>"FORCE-23000","client_event_id"=>$argv[3]]]]);' "$DEV_A" "$SYNC_INC_ID" "$INTEG_EVT")
call POST "$BASE_URL/sync/batch" "$TA" "$INTEG_BODY" "$HA"
expect_eq "$(echo "$RESP_BODY" | json_field results.0.status)" "failed" "A 23000 integrity violation with no original row is reported as 'failed', not 'duplicate'"
expect_eq "$(echo "$RESP_BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo var_export($d["results"][0]["server_id"],true);')" "NULL" "  ...with a null server_id"
expect_eq "$(echo "$RESP_BODY" | json_field results.0.reason)" "Item could not be stored (data integrity check failed)." "  ...and a generic reason (no SQL text)"
expect_eq "$(db_one "SELECT reconciliation_status FROM offline_queue WHERE client_event_id='$INTEG_EVT';")" "failed" "  ...the offline_queue ledger row is 'failed' (so the client keeps and retries it)"
mysql_exec "$VALDB" -e "DROP TRIGGER IF EXISTS trg_refchk_integrity;"
call POST "$BASE_URL/sync/batch" "$TA" "$INTEG_BODY" "$HA"
expect_eq "$(echo "$RESP_BODY" | json_field results.0.status)" "success" "Once the cause is gone, the SAME item is retried and succeeds (it was never swallowed as a duplicate)"
expect_eq "$(db_one "SELECT COUNT(*) FROM incident_referral WHERE client_event_id='$INTEG_EVT';")" "1" "  ...exactly one row"

# ============================================================
step "9. Audit rows — allow-listed metadata"
# ============================================================
REF_TOTAL=$(db_one "SELECT COUNT(*) FROM incident_referral;")
AUD_TOTAL=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='incident_referral_created';")
expect_eq "$AUD_TOTAL" "$REF_TOTAL" "One incident_referral_created audit row per created referral ($REF_TOTAL), none for replays/rejections"
AUD_KEYS=$(db_one "SELECT metadata_json FROM audit_log WHERE action='incident_referral_created' AND entity_id=$REF1 LIMIT 1;")
expect_eq "$(echo "$AUD_KEYS" | "$PHP_BIN" -r '$d=json_decode(trim(stream_get_contents(STDIN)),true); $k=array_keys($d); sort($k); echo implode(",",$k);')" "incident_id,referred_to" "Audit metadata keys are exactly {incident_id, referred_to}"
LEAK_AUDIT=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='incident_referral_created' AND (metadata_json LIKE '%Unit-Marker%' OR metadata_json LIKE '%BLTR-2026%' OR metadata_json LIKE '%REF_SECRET%' OR metadata_json LIKE '%Municipal Social%');")
expect_eq "$LEAK_AUDIT" "0" "No contact/reference/label/narrative text leaked into audit metadata"
expect_eq "$(db_one "SELECT entity_type FROM audit_log WHERE action='incident_referral_created' AND entity_id=$REF1 LIMIT 1;")" "incident_referral" "Audit entity_type is incident_referral"
expect_eq "$(db_one "SELECT actor_user_id FROM audit_log WHERE action='incident_referral_created' AND entity_id=$REF1 LIMIT 1;")" "$ADMIN_ID" "Audit actor is the creator"
[ "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='tenant_access_denied';")" -ge 1 ] && pass "Cross-tenant attempts left tenant_access_denied audit rows" || fail "No tenant_access_denied audit rows"

# ============================================================
step "10. Migration re-apply / down / up"
# ============================================================
MIG="$BACKEND_DIR/migrations/0032_incident_referral"
if mysql_exec "$VALDB" < "$MIG.sql" >/dev/null 2>&1; then pass "0032 re-applies cleanly (IF NOT EXISTS guard)"; else fail "0032 re-apply failed"; fi
expect_eq "$(refs_for_incident $INC1)" "8" "Re-apply left existing data untouched (8 rows on INC1 incl. the sync one)"
if mysql_exec "$VALDB" < "$MIG.down.sql" >/dev/null 2>&1; then pass "0032 .down.sql applies"; else fail "0032 .down.sql failed"; fi
expect_eq "$(db_one "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$VALDB' AND table_name='incident_referral';")" "0" "Down migration drops incident_referral"
if mysql_exec "$VALDB" < "$MIG.sql" >/dev/null 2>&1; then pass "0032 up applies again after down"; else fail "0032 up-after-down failed"; fi
expect_eq "$(db_one "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$VALDB' AND table_name='incident_referral';")" "1" "incident_referral exists again"

echo
echo "==================== RESULT ===================="
echo "$PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ] || exit 1
