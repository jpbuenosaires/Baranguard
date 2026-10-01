#!/usr/bin/env bash
# Baranguard -- Safer School Zones backend (docs/FEATURE_CONTRACT_2026-10.md
# section 7, migration 0033): schools CRUD, Tanod school check-ins (incl. the
# close-by-resend rule), incident school_id + Annex C-1 fields, the live
# GET /reports/school-term Annex D computation, and the ssz_term_report
# draft -> prepared -> approved -> submitted state machine.
#
# Covers per endpoint: no token (401), wrong role (403), cross-tenant (404),
# Idempotency-Key handling, the state machine incl. segregation of duties
# (preparer != approver) and 409 on an illegal transition, counts correctness
# against seeded incidents/referrals/check-ins (multi-referral incidents, the
# barangay-only count, Manila-day bucketing at the term boundaries, the
# ambulance_ems mapping setting), c1 field round-trip, and privacy (no
# student/victim fields anywhere in schema or responses).
#
# Safe to run: disposable database, disposable app-user, throwaway port. The
# real `baranguard` database and backend/.env are never touched.
#
# Usage: bash backend/scripts/verify-school-zones.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 -- expected '$2', got '$1'"; fi; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_school_check"
APP_USER="school_app"
APP_PASSWORD="SchoolZones!2026"
API_PORT="8603"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="SchoolZones#2026Pw"

echo "Baranguard school zones verification -- $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }

# call METHOD PATH TOKEN [BODY [extra curl args...]] -> sets CODE and BODY
CODE=""; BODY=""
call() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  shift 3; [ $# -gt 0 ] && shift
  local args=(-s -w '\n%{http_code}' -X "$method" "$BASE_URL$path")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  args+=("$@")
  local out
  out="$(curl "${args[@]}")"
  CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
# jf PATH -> field from $BODY (dot path; booleans/null rendered as text)
jf() {
  printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $v=$d; foreach(explode(".",$argv[1]) as $k){ if(!is_array($v)||!array_key_exists($k,$v)){echo "";exit;} $v=$v[$k]; } echo is_bool($v)?($v?"true":"false"):(is_array($v)?json_encode($v):(is_null($v)?"null":$v));' "$1"
}
code_of() { call "$@"; echo "$CODE"; }

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.school-server.log"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

# ============================================================
step "0. Setup -- disposable DB, full migration chain, users in two barangays"
# ============================================================
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort | awk -v s=0001_baseline_schema '$0 >= s'); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain applied (all migrations/*.sql, globbed)"

# Fixtures for migrations written by OTHER agents, only if not on disk yet.
HAS_AUTH="$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='user' AND COLUMN_NAME='approval_authority';")"
if [ "$HAS_AUTH" = "0" ]; then
  mysql_exec "$VALDB" -e "ALTER TABLE user ADD COLUMN official_title VARCHAR(64) NULL, ADD COLUMN approval_authority SET('note_report','approve_report','approve_roster','prepare_annex_d','approve_annex_d') NOT NULL DEFAULT '';"
  echo "  (fixture: migration 0030 not on disk -- added user.approval_authority locally)"
fi
HAS_REF="$(db_one "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='incident_referral';")"
if [ "$HAS_REF" = "0" ]; then
  mysql_exec "$VALDB" -e "CREATE TABLE incident_referral (referral_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, incident_id BIGINT UNSIGNED NOT NULL, barangay_id SMALLINT UNSIGNED NOT NULL, referred_to ENUM('pnp','bfp','ambulance_ems','barangay_official','vaw_desk','social_welfare','higher_lgu','doh','dpwh','other') NOT NULL, other_text VARCHAR(100) NULL, contact_name VARCHAR(100) NULL, referred_at DATETIME NOT NULL, reference_no VARCHAR(64) NULL, created_by BIGINT UNSIGNED NOT NULL, client_event_id CHAR(36) NULL, created_at DATETIME NOT NULL, UNIQUE KEY uq_referral_creator_event (created_by, client_event_id), CONSTRAINT fk_referral_incident FOREIGN KEY (incident_id) REFERENCES incident(incident_id) ON DELETE RESTRICT) ENGINE=InnoDB;"
  echo "  (fixture: migration 0032 not on disk -- created incident_referral from the contract)"
fi

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'sz_admin','$HASH','SZ Admin Preparer','admin',1,UTC_TIMESTAMP()),
 (1,'sz_admin_noauth','$HASH','SZ Admin NoAuth','admin',1,UTC_TIMESTAMP()),
 (1,'sz_admin_both','$HASH','SZ Admin Both','admin',1,UTC_TIMESTAMP()),
 (1,'sz_sec','$HASH','SZ Secretary','secretary',1,UTC_TIMESTAMP()),
 (1,'sz_pb','$HASH','SZ Punong Barangay','punong_barangay',1,UTC_TIMESTAMP()),
 (1,'sz_tanod1','$HASH','SZ Tanod One','tanod',1,UTC_TIMESTAMP()),
 (1,'sz_tanod2','$HASH','SZ Tanod Two','tanod',1,UTC_TIMESTAMP()),
 (1,'sz_tanod_off','$HASH','SZ Tanod Inactive','tanod',0,UTC_TIMESTAMP()),
 (2,'sz_admin2','$HASH','SZ Admin B2','admin',1,UTC_TIMESTAMP()),
 (2,'sz_tanod_b2','$HASH','SZ Tanod B2','tanod',1,UTC_TIMESTAMP());
UPDATE user SET approval_authority='prepare_annex_d' WHERE username='sz_admin';
UPDATE user SET approval_authority='prepare_annex_d,approve_annex_d' WHERE username IN ('sz_admin_both','sz_admin2');
UPDATE user SET approval_authority='approve_annex_d' WHERE username='sz_pb';
UPDATE user SET approval_authority='' WHERE username IN ('sz_admin_noauth','sz_sec');
SQL
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
T1_ID=$(uid sz_tanod1); T2_ID=$(uid sz_tanod2); TB2_ID=$(uid sz_tanod_b2)
ADMIN_ID=$(uid sz_admin); BOTH_ID=$(uid sz_admin_both); PB_ID=$(uid sz_pb)

DEV1="school-dev-$(uuid)"; DEV2="school-dev-$(uuid)"; DEVB2="school-dev-$(uuid)"
mysql_exec "$VALDB" <<SQL
INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES
 ('$DEV1', $T1_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP()),
 ('$DEV2', $T2_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP()),
 ('$DEVB2', $TB2_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());
SQL

( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="school-verify-secret-key-not-real-0123456789" \
  "$PHP_BIN" -S 127.0.0.1:$API_PORT -t public public/dev-router.php > "$BACKEND_DIR/scripts/.school-server.log" 2>&1 ) &
SERVER_PID=$!
sleep 2

token_for() {
  curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["token"] ?? "";'
}
ADMIN=$(token_for sz_admin); NOAUTH=$(token_for sz_admin_noauth); BOTH=$(token_for sz_admin_both)
SEC=$(token_for sz_sec); PB=$(token_for sz_pb)
T1=$(token_for sz_tanod1); T2=$(token_for sz_tanod2)
ADMIN2=$(token_for sz_admin2); TB2=$(token_for sz_tanod_b2)
[ -n "$ADMIN" ] && [ -n "$PB" ] && [ -n "$T1" ] && [ -n "$ADMIN2" ] && [ -n "$TB2" ] && pass "Tokens acquired for every role/tenant" || { fail "Login failed -- see .school-server.log"; exit 1; }

# ============================================================
step "1. No token -> 401 on every new endpoint"
# ============================================================
while read -r method path; do
  [ -z "$method" ] && continue
  expect_eq "$(code_of "$method" "$path" "" '{}')" "401" "Unauthenticated $method $path"
done <<ENDPOINTS
GET /schools
POST /schools
PATCH /schools/1
GET /school-checkins
POST /school-checkins
GET /reports/school-term
GET /ssz-term-reports
POST /ssz-term-reports
GET /ssz-term-reports/1
PATCH /ssz-term-reports/1
POST /ssz-term-reports/1/prepare
POST /ssz-term-reports/1/approve
POST /ssz-term-reports/1/mark-submitted
ENDPOINTS

# ============================================================
step "2. SCHOOLS -- CRUD, roles, idempotency, tenant, no delete"
# ============================================================
K1=$(uuid)
S1_BODY='{"name":"Dao Elementary School","school_type":"public","level":"primary_elementary","address":"Purok 1, Dao","focal_person":"Principal Reyes","focal_contact":"09171234567","remarks":"Main gate on the highway","latitude":12.9,"longitude":123.6}'
expect_eq "$(code_of POST /schools "$T1" "$S1_BODY" -H "Idempotency-Key: $K1")" "403" "Tanod cannot create a school"
expect_eq "$(code_of POST /schools "$PB" "$S1_BODY" -H "Idempotency-Key: $K1")" "403" "Punong Barangay cannot create a school (read-only)"
expect_eq "$(code_of POST /schools "$ADMIN" "$S1_BODY")" "400" "Create without Idempotency-Key is 400"
expect_eq "$(code_of POST /schools "$ADMIN" '{"name":"X","school_type":"public","level":"nope","address":"a"}' -H "Idempotency-Key: $(uuid)")" "400" "Invalid level enum is 400"
expect_eq "$(code_of POST /schools "$ADMIN" '{"name":"X","school_type":"federal","level":"tvet","address":"a"}' -H "Idempotency-Key: $(uuid)")" "400" "Invalid school_type enum is 400"
expect_eq "$(code_of POST /schools "$ADMIN" '{"name":"X","school_type":"public","level":"tvet"}' -H "Idempotency-Key: $(uuid)")" "400" "Missing address is 400"
expect_eq "$(code_of POST /schools "$ADMIN" '{"name":"X","school_type":"public","level":"tvet","address":"a","latitude":12.9}' -H "Idempotency-Key: $(uuid)")" "400" "Latitude without longitude is 400"

call POST /schools "$ADMIN" "$S1_BODY" -H "Idempotency-Key: $K1"
expect_eq "$CODE" "201" "Admin creates a school"
S1=$(jf school_id)
expect_eq "$(jf name)|$(jf level)|$(jf is_active)|$(jf barangay_id)" "Dao Elementary School|primary_elementary|true|1" "School round-trips name/level/is_active, barangay from the session"
call POST /schools "$ADMIN" "$S1_BODY" -H "Idempotency-Key: $K1"
expect_eq "$CODE|$(jf school_id)" "200|$S1" "Replaying the same Idempotency-Key returns the original school (200)"
expect_eq "$(db_one "SELECT COUNT(*) FROM school WHERE barangay_id=1;")" "1" "Replay created no second row"

call POST /schools "$SEC" '{"name":"Dao Daycare Center","school_type":"public","level":"preschool_daycare_eccd","address":"Purok 2, Dao"}' -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "201" "Secretary creates a school"
S2=$(jf school_id)
call POST /schools "$ADMIN" '{"name":"Old Annex School","school_type":"private","level":"integrated","address":"Purok 3, Dao"}' -H "Idempotency-Key: $(uuid)"
S3=$(jf school_id)
call POST /schools "$ADMIN2" '{"name":"Binanuahan Elementary","school_type":"public","level":"primary_elementary","address":"Poblacion"}' -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "201" "Barangay-2 Admin creates a school in barangay 2"
SB2=$(jf school_id)

call GET /schools "$T1"
expect_eq "$CODE|$(jf total)" "200|3" "Tanod reads the barangay's schools (cache source) -- 3, none from barangay 2"
call GET /schools "$PB"
expect_eq "$CODE" "200" "Punong Barangay may read schools"
call GET /schools "$TB2"
expect_eq "$(jf total)|$(jf items.0.name)" "1|Binanuahan Elementary" "Barangay-2 Tanod sees only barangay 2's school"

K=$(uuid)
call PATCH /schools/$S3 "$ADMIN" '{"is_active":false,"remarks":"Closed this term"}' -H "Idempotency-Key: $K"
expect_eq "$CODE|$(jf is_active)|$(jf remarks)" "200|false|Closed this term" "Admin deactivates a school (is_active=false) and edits remarks"
call PATCH /schools/$S3 "$ADMIN" '{"is_active":false,"remarks":"Closed this term"}' -H "Idempotency-Key: $K"
expect_eq "$CODE" "200" "PATCH replay with the same key is 200"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='school_updated' AND entity_id=$S3;")" "1" "PATCH replay wrote no second audit row"
call GET "/schools?active=true" "$T1"
expect_eq "$(jf total)" "2" "GET /schools?active=true excludes the deactivated school"
call GET "/schools?active=false" "$T1"
expect_eq "$(jf total)|$(jf items.0.school_id)" "1|$S3" "GET /schools?active=false returns only the deactivated school"
expect_eq "$(code_of GET "/schools?active=maybe" "$T1")" "400" "Invalid active filter is 400"
expect_eq "$(code_of PATCH /schools/$S1 "$ADMIN" '{}' -H "Idempotency-Key: $(uuid)")" "400" "PATCH with no editable fields is 400"
expect_eq "$(code_of PATCH /schools/$S1 "$T1" '{"remarks":"x"}' -H "Idempotency-Key: $(uuid)")" "403" "Tanod cannot PATCH a school"
expect_eq "$(code_of PATCH /schools/$S1 "$ADMIN" '{"remarks":"x"}')" "400" "PATCH without Idempotency-Key is 400"
expect_eq "$(code_of PATCH /schools/$S1 "$ADMIN2" '{"remarks":"x"}' -H "Idempotency-Key: $(uuid)")" "404" "Cross-tenant PATCH is 404, never 403"
expect_eq "$(code_of PATCH /schools/999999 "$ADMIN" '{"remarks":"x"}' -H "Idempotency-Key: $(uuid)")" "404" "PATCH of a missing school is 404"
DEL_CODE="$(code_of DELETE /schools/$S1 "$ADMIN")"
case "$DEL_CODE" in 404|405) pass "No DELETE route for schools ($DEL_CODE)";; *) fail "DELETE /schools/:id should not exist, got $DEL_CODE";; esac
expect_eq "$(db_one "SELECT COUNT(*) FROM school WHERE school_id=$S1;")" "1" "School still exists after the DELETE attempt"

# ============================================================
step "3. SCHOOL CHECK-INS -- create, replay, close-by-resend, roles, tenant, sync"
# ============================================================
NOW_IN="$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
NOW_OUT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
E1=$(uuid)
CI_BODY="{\"school_id\":$S1,\"checked_in_at\":\"$NOW_IN\",\"client_event_id\":\"$E1\"}"
expect_eq "$(code_of POST /school-checkins "$ADMIN" "$CI_BODY")" "403" "Admin cannot POST a check-in (Tanod-only)"
expect_eq "$(code_of POST /school-checkins "$T1" "$CI_BODY")" "400" "Check-in without X-Device-Id is 400"
expect_eq "$(code_of POST /school-checkins "$T1" "$CI_BODY" -H "X-Device-Id: $DEV2")" "422" "Check-in with another Tanod's device is 422"
call POST /school-checkins "$T1" "$CI_BODY" -H "X-Device-Id: $DEV1"
expect_eq "$CODE|$(jf school_id)|$(jf checked_out_at)|$(jf user_id)" "201|$S1|null|$T1_ID" "Tanod checks in (201, open, own user_id)"
CI1=$(jf checkin_id)
call POST /school-checkins "$T1" "$CI_BODY" -H "X-Device-Id: $DEV1"
expect_eq "$CODE|$(jf checkin_id)" "200|$CI1" "Re-sending the same client_event_id returns the original (200)"
expect_eq "$(db_one "SELECT COUNT(*) FROM school_checkin WHERE user_id=$T1_ID;")" "1" "Replay created no second check-in"
CLOSE_BODY="{\"school_id\":$S1,\"checked_in_at\":\"$NOW_IN\",\"checked_out_at\":\"$NOW_OUT\",\"client_event_id\":\"$E1\"}"
call POST /school-checkins "$T1" "$CLOSE_BODY" -H "X-Device-Id: $DEV1"
expect_eq "$CODE|$(jf checkin_id)|$([ -n "$(jf checked_out_at)" ] && [ "$(jf checked_out_at)" != "null" ] && echo closed)" "200|$CI1|closed" "Re-sending the same client_event_id WITH checked_out_at closes it (200, wasCreated=false)"
expect_eq "$(db_one "SELECT COUNT(*) FROM school_checkin WHERE user_id=$T1_ID;")" "1" "Closing created no new row"
FIRST_OUT="$(db_one "SELECT checked_out_at FROM school_checkin WHERE checkin_id=$CI1;")"
LATER_OUT="$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
call POST /school-checkins "$T1" "{\"school_id\":$S1,\"checked_in_at\":\"$NOW_IN\",\"checked_out_at\":\"$LATER_OUT\",\"client_event_id\":\"$E1\"}" -H "X-Device-Id: $DEV1"
expect_eq "$(db_one "SELECT checked_out_at FROM school_checkin WHERE checkin_id=$CI1;")" "$FIRST_OUT" "An already-closed check-in is never mutated again"
expect_eq "$(code_of POST /school-checkins "$T1" "{\"school_id\":$S1,\"checked_in_at\":\"$NOW_OUT\",\"checked_out_at\":\"$NOW_IN\",\"client_event_id\":\"$(uuid)\"}" -H "X-Device-Id: $DEV1")" "400" "checked_out_at before checked_in_at is 400"
expect_eq "$(code_of POST /school-checkins "$T1" "{\"school_id\":$S1,\"checked_in_at\":\"not-a-date\",\"client_event_id\":\"$(uuid)\"}" -H "X-Device-Id: $DEV1")" "400" "Bad timestamp is 400"
expect_eq "$(code_of POST /school-checkins "$T1" "{\"school_id\":$S1,\"checked_in_at\":\"$NOW_IN\",\"client_event_id\":\"nope\"}" -H "X-Device-Id: $DEV1")" "400" "Non-UUID client_event_id is 400"
expect_eq "$(code_of POST /school-checkins "$T1" "{\"school_id\":$SB2,\"checked_in_at\":\"$NOW_IN\",\"client_event_id\":\"$(uuid)\"}" -H "X-Device-Id: $DEV1")" "404" "Check-in at another barangay's school is 404"
expect_eq "$(code_of POST /school-checkins "$T1" "{\"school_id\":999999,\"checked_in_at\":\"$NOW_IN\",\"client_event_id\":\"$(uuid)\"}" -H "X-Device-Id: $DEV1")" "404" "Check-in at an unknown school is the same 404"
expect_eq "$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='school_checkin' AND (COLUMN_NAME LIKE '%lat%' OR COLUMN_NAME LIKE '%lon%');")" "0" "school_checkin stores no coordinates"

call GET /school-checkins "$T1"
expect_eq "$CODE" "403" "Tanod cannot list check-ins"
call GET /school-checkins "$ADMIN"
expect_eq "$CODE|$(jf total)" "200|1" "Admin lists check-ins (1 so far)"
expect_eq "$(jf items.0.checkin_id)|$(jf items.0.school_id)|$(jf items.0.user_id)" "$CI1|$S1|$T1_ID" "Check-in row exposes checkin_id/school_id/user_id"
call GET "/school-checkins?school_id=$S2" "$PB"
expect_eq "$CODE|$(jf total)" "200|0" "Punong Barangay may read; school_id filter excludes other schools"
call GET "/school-checkins?from=2000-01-01&to=2000-01-31" "$SEC"
expect_eq "$(jf total)" "0" "from/to filter excludes out-of-range check-ins"
call GET "/school-checkins" "$ADMIN2"
expect_eq "$(jf total)" "0" "Cross-tenant: barangay-2 Admin sees none of barangay 1's check-ins"
expect_eq "$(code_of GET "/school-checkins?from=2026-13-01" "$ADMIN")" "400" "Invalid from date is 400"

SYNC_E=$(uuid)
call POST /sync/batch "$T2" "{\"device_id\":\"$DEV2\",\"school_checkins\":[{\"school_id\":$S2,\"checked_in_at\":\"$NOW_IN\",\"client_event_id\":\"$SYNC_E\"}]}"
expect_eq "$CODE" "200" "POST /sync/batch accepts school_checkins[]"
expect_eq "$(db_one "SELECT COUNT(*) FROM school_checkin WHERE user_id=$T2_ID AND client_event_id='$SYNC_E';")" "1" "SyncController -> SchoolCheckinsController::createItem created the check-in"
call POST /sync/batch "$T2" "{\"device_id\":\"$DEV2\",\"school_checkins\":[{\"school_id\":$S2,\"checked_in_at\":\"$NOW_IN\",\"client_event_id\":\"$SYNC_E\"}]}"
expect_eq "$(db_one "SELECT COUNT(*) FROM school_checkin WHERE user_id=$T2_ID;")" "1" "Replaying the same sync item created no duplicate"

# Check-out AFTER the check-in already synced: own new client_event_id + closes_client_event_id.
OUT_E=$(uuid)
NOW_OUT=$(date -u -d "+1 hour" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
call POST /sync/batch "$T2" "{\"device_id\":\"$DEV2\",\"school_checkins\":[{\"client_event_id\":\"$OUT_E\",\"closes_client_event_id\":\"$SYNC_E\",\"checked_out_at\":\"$NOW_OUT\"}]}"
expect_eq "$CODE" "200" "Close-by-reference check-out item is accepted via /sync/batch"
expect_eq "$(db_one "SELECT checked_out_at IS NOT NULL FROM school_checkin WHERE user_id=$T2_ID AND client_event_id='$SYNC_E';")" "1" "Close-by-reference closed the already-synced check-in"
expect_eq "$(db_one "SELECT COUNT(*) FROM school_checkin WHERE user_id=$T2_ID;")" "1" "Close-by-reference created no second check-in row"

# ============================================================
step "3b. Check-in time validation + H-09 device signature (fix review finding 3, 4)"
# ============================================================
ci_code() { # body -> http code (T1 / DEV1)
  code_of POST /school-checkins "$T1" "$1" -H "X-Device-Id: $DEV1"
}
UTC_NOW_NOZ="$(date -u +%Y-%m-%dT%H:%M:%S)"
expect_eq "$(ci_code "{\"school_id\":$S1,\"checked_in_at\":\"$(date -u +%Y-%m-%d)\",\"client_event_id\":\"$(uuid)\"}")" "400" "checked_in_at as a bare date (no time/zone) is 400"
expect_eq "$(ci_code "{\"school_id\":$S1,\"checked_in_at\":\"$UTC_NOW_NOZ\",\"client_event_id\":\"$(uuid)\"}")" "400" "checked_in_at with no Z / UTC offset is 400 (strict ISO-8601)"
expect_eq "$(ci_code "{\"school_id\":$S1,\"checked_in_at\":\"tomorrow\",\"client_event_id\":\"$(uuid)\"}")" "400" "Relative words ('tomorrow') are 400"
expect_eq "$(ci_code "{\"school_id\":$S1,\"checked_in_at\":\"$(date -u -d '10 minutes' +%Y-%m-%dT%H:%M:%SZ)\",\"client_event_id\":\"$(uuid)\"}")" "400" "checked_in_at 10 minutes in the future (> 5 min skew) is 400"
expect_eq "$(ci_code "{\"school_id\":$S1,\"checked_in_at\":\"$(date -u -d '63 days ago' +%Y-%m-%dT%H:%M:%SZ)\",\"client_event_id\":\"$(uuid)\"}")" "400" "checked_in_at 63 days back (> 62) is 400"
expect_eq "$(ci_code "{\"school_id\":$S1,\"checked_in_at\":\"$NOW_IN\",\"checked_out_at\":\"$(date -u -d '27 hours' +%Y-%m-%dT%H:%M:%SZ)\",\"client_event_id\":\"$(uuid)\"}")" "400" "checked_out_at more than 24h after checked_in_at is 400"
expect_eq "$(ci_code "{\"school_id\":$S1,\"checked_in_at\":\"$(date -u -d '61 days ago' +%Y-%m-%dT%H:%M:%SZ)\",\"client_event_id\":\"$(uuid)\"}")" "201" "checked_in_at 61 days back (inside the 62-day window) is accepted"
MANILA_IN="$(date -u -d '7 hours' +%Y-%m-%dT%H:%M:%S+08:00)"   # Manila wall clock for "1 hour ago" (UTC+8)
call POST /school-checkins "$T1" "{\"school_id\":$S1,\"checked_in_at\":\"$MANILA_IN\",\"client_event_id\":\"$(uuid)\"}" -H "X-Device-Id: $DEV1"
expect_eq "$CODE" "201" "A +08:00 offset timestamp is accepted"
expect_eq "$(db_one "SELECT TIMESTAMPDIFF(MINUTE, checked_in_at, UTC_TIMESTAMP()) BETWEEN 55 AND 65 FROM school_checkin WHERE checkin_id=$(jf checkin_id);")" "1" "  ...and stored as the equivalent UTC instant (about 1h ago)"
SLATE_E=$(uuid)
call POST /school-checkins "$T1" "{\"school_id\":$S1,\"checked_in_at\":\"$NOW_IN\",\"client_event_id\":\"$SLATE_E\"}" -H "X-Device-Id: $DEV1"
CI_LATE=$(jf checkin_id)
call POST /sync/batch "$T1" "{\"device_id\":\"$DEV1\",\"school_checkins\":[{\"client_event_id\":\"$(uuid)\",\"closes_client_event_id\":\"$SLATE_E\",\"checked_out_at\":\"$(date -u -d '27 hours' +%Y-%m-%dT%H:%M:%SZ)\"}]}"
expect_eq "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo $d["results"][0]["status"];')" "failed" "Close-by-reference with checked_out_at > 24h after the check-in fails per item"
expect_eq "$(db_one "SELECT checked_out_at IS NULL FROM school_checkin WHERE checkin_id=$CI_LATE;")" "1" "  ...and the check-in stays open"

# H-09: a device with a registered key must sign direct POSTs and each sync item
SIG_TMP="$(mktemp -d)"; SIG_TMP_W="$(cygpath -m "$SIG_TMP")"
OPENSSL_BIN="$(command -v openssl || true)"
DEVK="school-keyed-$(uuid)"
if [ -z "$OPENSSL_BIN" ]; then
  fail "openssl CLI not found - cannot generate a device key"
else
  "$OPENSSL_BIN" ecparam -name prime256v1 -genkey -noout -out "$SIG_TMP/k.key" 2>/dev/null
  "$OPENSSL_BIN" ec -in "$SIG_TMP/k.key" -pubout -out "$SIG_TMP/k.pub" 2>/dev/null
  PUBHEX="$("$PHP_BIN" -r 'echo bin2hex(file_get_contents($argv[1]));' "$SIG_TMP_W/k.pub")"
  mysql_exec "$VALDB" -e "INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at, device_public_key_pem) VALUES ('$DEVK', $T2_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP(), CONVERT(UNHEX('$PUBHEX') USING utf8mb4));"
  sign() { # method path device ts
    printf '%s\n%s\n%s\n%s' "$1" "$2" "$3" "$4" | "$OPENSSL_BIN" dgst -sha256 -sign "$SIG_TMP/k.key" | base64 -w0
  }
  KC_BODY="{\"school_id\":$S2,\"checked_in_at\":\"$NOW_IN\",\"client_event_id\":\"$(uuid)\"}"
  expect_eq "$(code_of POST /school-checkins "$T2" "$KC_BODY" -H "X-Device-Id: $DEVK")" "401" "Direct POST /school-checkins from a keyed device WITHOUT a signature is 401"
  expect_eq "$(db_one "SELECT COUNT(*) FROM school_checkin WHERE client_event_id='$(printf '%s' "$KC_BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo $d["client_event_id"];')';")" "0" "  ...and nothing was written"
  TS=$(date +%s)
  expect_eq "$(code_of POST /school-checkins "$T2" "$KC_BODY" -H "X-Device-Id: $DEVK" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $(sign POST /api/v1/school-checkins "$DEVK" "$TS")")" "201" "Same POST with a valid signature is 201"
  SK_E=$(uuid)
  SK_BODY="{\"device_id\":\"$DEVK\",\"school_checkins\":[{\"school_id\":$S2,\"checked_in_at\":\"$NOW_IN\",\"client_event_id\":\"$SK_E\"}]}"
  call POST /sync/batch "$T2" "$SK_BODY"
  expect_eq "$(jf results.0.status)|$(jf results.0.reason)" "failed|Device signature verification failed." "Unsigned /sync/batch school_checkins item from a keyed device fails per item"
  TS=$(date +%s)
  call POST /sync/batch "$T2" "$SK_BODY" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $(sign POST /api/v1/sync/batch "$DEVK" "$TS")"
  expect_eq "$(jf results.0.status)" "success" "Same batch with a valid signature succeeds"
fi
rm -rf "$SIG_TMP"

# ============================================================
step "4. INCIDENT school_id + Annex C-1 fields -- create / mobile / PATCH / list / show"
# ============================================================
K=$(uuid)
call POST /incidents "$SEC" "{\"incident_type\":\"disturbance\",\"raw_narrative\":\"School-zone test narrative\",\"school_id\":$S1,\"c1_summary\":\"Loitering near the gate\",\"c1_action_taken\":\"Persons advised to leave\",\"c1_status_notes\":\"Monitored until dismissal\"}" -H "Idempotency-Key: $K"
expect_eq "$CODE|$(jf school_id)|$(jf c1_summary)|$(jf c1_action_taken)|$(jf c1_status_notes)" "201|$S1|Loitering near the gate|Persons advised to leave|Monitored until dismissal" "Web create round-trips school_id and c1_* fields"
INC_A=$(jf incident_id)
call POST /incidents "$SEC" "{\"incident_type\":\"disturbance\",\"raw_narrative\":\"School-zone test narrative\",\"school_id\":$S1}" -H "Idempotency-Key: $K"
expect_eq "$CODE|$(jf incident_id)|$(jf c1_summary)" "200|$INC_A|Loitering near the gate" "Web create replay returns the original incl. c1 fields"
expect_eq "$(code_of POST /incidents "$SEC" "{\"incident_type\":\"theft\",\"raw_narrative\":\"x\",\"school_id\":$SB2}" -H "Idempotency-Key: $(uuid)")" "400" "school_id from another barangay is 400 (web create)"
expect_eq "$(code_of POST /incidents "$SEC" "{\"incident_type\":\"theft\",\"raw_narrative\":\"x\",\"school_id\":999999}" -H "Idempotency-Key: $(uuid)")" "400" "Unknown school_id gives the same 400 (no existence probe)"
LONG="$("$PHP_BIN" -r 'echo str_repeat("a", 501);')"
expect_eq "$(code_of POST /incidents "$SEC" "{\"incident_type\":\"theft\",\"raw_narrative\":\"x\",\"c1_summary\":\"$LONG\"}" -H "Idempotency-Key: $(uuid)")" "400" "c1_summary over 500 characters is 400"
expect_eq "$(code_of POST /incidents "$SEC" "{\"incident_type\":\"theft\",\"raw_narrative\":\"x\",\"c1_summary\":123}" -H "Idempotency-Key: $(uuid)")" "400" "Non-string c1 field is 400"

call GET /incidents/$INC_A "$SEC"
expect_eq "$CODE|$(jf school_id)|$(jf c1_summary)" "200|$S1|Loitering near the gate" "Show returns school_id and c1 fields (Secretary)"
call GET /incidents/$INC_A "$PB"
expect_eq "$CODE|$(jf school_id)|$(jf c1_action_taken)|$([ -z "$(jf raw_narrative)" ] && echo hidden)" "200|$S1|Persons advised to leave|hidden" "Show returns c1 to Punong Barangay, raw_narrative still withheld"
call GET "/incidents?limit=100" "$ADMIN"
LISTHIT="$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $i){ if($i["incident_id"]=='"$INC_A"'){ echo $i["school_id"]."|".$i["c1_status_notes"]; } }')"
expect_eq "$LISTHIT" "$S1|Monitored until dismissal" "List returns school_id and c1 fields"

call PATCH /incidents/$INC_A "$SEC" "{\"c1_status_notes\":\"Resolved - no further action\",\"school_id\":$S2}" -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "200" "Secretary PATCHes c1 + school_id"
call GET /incidents/$INC_A "$SEC"
expect_eq "$(jf school_id)|$(jf c1_status_notes)|$(jf c1_summary)" "$S2|Resolved - no further action|Loitering near the gate" "PATCH changed only the supplied fields"
call PATCH /incidents/$INC_A "$ADMIN" '{"school_id":null}' -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "200" "Admin may unlink the school (null)"
call GET /incidents/$INC_A "$SEC"
expect_eq "$(jf school_id)" "null" "school_id cleared by PATCH null"
expect_eq "$(code_of PATCH /incidents/$INC_A "$SEC" "{\"school_id\":$SB2}" -H "Idempotency-Key: $(uuid)")" "400" "PATCH with another barangay's school_id is 400"
expect_eq "$(code_of PATCH /incidents/$INC_A "$T1" "{\"c1_summary\":\"x\"}" -H "Idempotency-Key: $(uuid)")" "403" "Tanod cannot PATCH an incident"
expect_eq "$(db_one "SELECT metadata_json FROM audit_log WHERE action='incident_updated' AND entity_id=$INC_A ORDER BY audit_id DESC LIMIT 1;" | grep -c "Resolved")" "0" "Audit metadata for the c1 edit holds field names only, never the text"

E_INC=$(uuid)
call POST /incidents "$T1" "{\"incident_type\":\"vandalism\",\"raw_narrative\":\"Mobile school report\",\"client_event_id\":\"$E_INC\",\"school_id\":$S1,\"c1_summary\":\"Graffiti on the fence\"}" -H "X-Device-Id: $DEV1"
expect_eq "$CODE|$(jf school_id)|$(jf c1_summary)" "201|$S1|Graffiti on the fence" "Mobile create round-trips school_id and c1_summary"
INC_M=$(jf incident_id)
call POST /incidents "$T1" "{\"incident_type\":\"vandalism\",\"raw_narrative\":\"Mobile school report\",\"client_event_id\":\"$E_INC\",\"school_id\":$S1,\"c1_summary\":\"Graffiti on the fence\"}" -H "X-Device-Id: $DEV1"
expect_eq "$CODE|$(jf incident_id)" "200|$INC_M" "Mobile create replay returns the original"
E_BADSCH=$(uuid)
call POST /incidents "$T1" "{\"incident_type\":\"vandalism\",\"raw_narrative\":\"Offline report with a stale school\",\"client_event_id\":\"$E_BADSCH\",\"school_id\":$SB2}" -H "X-Device-Id: $DEV1"
expect_eq "$CODE|$(jf school_id)" "201|null" "Mobile create with another barangay's school_id is STORED with school_id NULL (offline capture is never lost, Rule 7)"
expect_eq "$(db_one "SELECT CONCAT(IFNULL(school_id,'NULL'),'|',raw_narrative) FROM incident WHERE client_event_id='$E_BADSCH';")" "NULL|Offline report with a stale school" "  ...DB row exists with the narrative intact and no school link"
call POST /incidents "$T1" "{\"incident_type\":\"vandalism\",\"raw_narrative\":\"x\",\"client_event_id\":\"$(uuid)\",\"school_id\":999999}" -H "X-Device-Id: $DEV1"
expect_eq "$CODE|$(jf school_id)" "201|null" "Mobile create with an unknown school_id is also stored with NULL"
E_BADSCH2=$(uuid)
call POST /sync/batch "$T1" "{\"device_id\":\"$DEV1\",\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"Synced with a stale school\",\"client_event_id\":\"$E_BADSCH2\",\"school_id\":$SB2}]}"
expect_eq "$(jf results.0.status)|$(db_one "SELECT IFNULL(school_id,'NULL') FROM incident WHERE client_event_id='$E_BADSCH2';")" "success|NULL" "Sync-batch incident item with a foreign school_id succeeds with NULL (does not fail the item)"
call GET /incidents/$INC_M "$T1"
expect_eq "$CODE|$(jf school_id)" "200|$S1" "Tanod reads own incident incl. school_id"
call GET /incidents/$INC_M "$T2"
expect_eq "$CODE" "404" "Another Tanod still gets 404 for it"
call GET /incidents/$INC_M "$ADMIN2"
expect_eq "$CODE" "404" "Cross-tenant show is 404"
E_SYNC=$(uuid)
call POST /sync/batch "$T1" "{\"device_id\":\"$DEV1\",\"incidents\":[{\"incident_type\":\"theft\",\"raw_narrative\":\"Synced school report\",\"client_event_id\":\"$E_SYNC\",\"school_id\":$S1,\"c1_action_taken\":\"Referred to the principal\"}]}"
expect_eq "$(db_one "SELECT CONCAT(school_id,'|',c1_action_taken) FROM incident WHERE client_event_id='$E_SYNC';")" "$S1|Referred to the principal" "Sync-batch incident item carries school_id + c1_* through"

# ============================================================
step "5. ANNEX D live computation -- seeded incidents/referrals/check-ins (term 2026-03-01..2026-03-31, Manila)"
# ============================================================
# Isolate the term: remove the API-created "now" incidents/check-ins from steps 3-4
# from consideration by using a past term; nothing above falls inside March 2026.
mk_inc() { # school_id created_utc  -> echoes incident_id
  local sid="$1" created="$2" bar="${3:-1}" rep="${4:-$T1_ID}"
  local school_sql="NULL"; [ "$sid" != "NULL" ] && school_sql="$sid"
  mysql_exec "$VALDB" -e "INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, created_at, updated_at, school_id) VALUES ($bar, $rep, 'disturbance','normal','annexd seed','resolved','app','$created','$created',$school_sql);"
  db_one "SELECT MAX(incident_id) FROM incident;"
}
mk_ref() { # incident_id referred_to [other_text]
  local inc="$1" to="$2" txt="${3:-}"
  local txt_sql="NULL"; [ -n "$txt" ] && txt_sql="'$txt'"
  local bar; bar="$(db_one "SELECT barangay_id FROM incident WHERE incident_id=$inc;")"
  mysql_exec "$VALDB" -e "INSERT INTO incident_referral (incident_id, barangay_id, referred_to, other_text, referred_at, created_by, created_at) VALUES ($inc, $bar, '$to', $txt_sql, UTC_TIMESTAMP(), $ADMIN_ID, UTC_TIMESTAMP());"
}
I1=$(mk_inc $S1 '2026-03-10 03:00:00'); mk_ref $I1 pnp; mk_ref $I1 pnp 'Sorsogon PNP'; mk_ref $I1 bfp
I2=$(mk_inc $S1 '2026-03-15 10:00:00'); mk_ref $I2 social_welfare; mk_ref $I2 higher_lgu
I3=$(mk_inc $S2 '2026-03-20 02:00:00'); mk_ref $I3 barangay_official; mk_ref $I3 vaw_desk
I4=$(mk_inc $S2 '2026-03-21 02:00:00')
I5=$(mk_inc $S1 '2026-03-22 02:00:00'); mk_ref $I5 ambulance_ems; mk_ref $I5 other 'Pilar RHU'; mk_ref $I5 doh; mk_ref $I5 pnp
I6=$(mk_inc $S1 '2026-02-28 17:00:00'); mk_ref $I6 dpwh   # UTC Feb 28 17:00 == Manila Mar 1 01:00 -> IN
I7=$(mk_inc $S1 '2026-03-31 16:30:00'); mk_ref $I7 pnp 'Excluded Org'  # Manila Apr 1 00:30 -> OUT
I8=$(mk_inc NULL '2026-03-12 02:00:00'); mk_ref $I8 pnp   # no school -> excluded
I9=$(mk_inc $SB2 '2026-03-12 02:00:00' 2 $TB2_ID); mk_ref $I9 pnp   # other barangay -> excluded
I11=$(mk_inc $S1 '2026-03-12 02:00:00'); mk_ref $I11 ambulance_ems
# check-ins: Mar 10 x3 (UTC Mar 9 17:00 is still Manila Mar 10), Mar 15, Mar 1 (UTC Feb 28 17:00), and Apr 1 (OUT)
# (Seeded by SQL: the API now refuses a check-in older than 62 days, which is correct
# for live traffic but would also refuse these deliberately historical boundary rows.)
for ts in '2026-03-10 00:30:00' '2026-03-10 08:00:00' '2026-03-09 17:00:00' '2026-03-15 01:00:00' '2026-02-28 17:00:00' '2026-03-31 17:00:00'; do
  mysql_exec "$VALDB" -e "INSERT INTO school_checkin (school_id, barangay_id, user_id, checked_in_at, client_event_id, created_at) VALUES ($S1, 1, $T1_ID, '$ts', '$(uuid)', UTC_TIMESTAMP());"
done
mysql_exec "$VALDB" -e "INSERT INTO school_checkin (school_id, barangay_id, user_id, checked_in_at, client_event_id, created_at) VALUES ($SB2, 2, $TB2_ID, '2026-03-18 01:00:00', '$(uuid)', UTC_TIMESTAMP());"
expect_eq "$(db_one "SELECT COUNT(*) FROM school_checkin WHERE checked_in_at < '2026-04-02';")" "7" "Seeded 6 barangay-1 + 1 barangay-2 check-ins around the term boundaries"

expect_eq "$(code_of GET "/reports/school-term?term_start=2026-03-01&term_end=2026-03-31" "$T1")" "403" "Tanod cannot read the Annex D computation"
expect_eq "$(code_of GET "/reports/school-term?term_start=2026-03-01" "$ADMIN")" "400" "Missing term_end is 400"
expect_eq "$(code_of GET "/reports/school-term?term_start=2026-03-31&term_end=2026-03-01" "$ADMIN")" "400" "Reversed range is 400"
expect_eq "$(code_of GET "/reports/school-term?term_start=2026-02-30&term_end=2026-03-31" "$ADMIN")" "400" "Impossible date is 400"
call GET "/reports/school-term?term_start=2026-03-01&term_end=2026-03-31" "$PB"
expect_eq "$CODE" "200" "Punong Barangay may read the live computation"
check_counts() { # label expected-string
  expect_eq "$(jf total_tanods)|$(jf total_schools)|$(jf total_deployment_days)|$(jf total_incidents)|$(jf incidents_barangay_only)|$(jf incidents_pnp)|$(jf incidents_bfp)|$(jf incidents_higher_lgu)|$(jf incidents_doh)|$(jf incidents_dpwh)|$(jf incidents_other_agencies)" "$2" "$1"
}
#            tanods|schools|days|incidents|brgy_only|pnp|bfp|lgu|doh|dpwh|other
check_counts "Annex D counts (default ambulance->other): 2 tanods, 2 active schools, 3 Manila days, 7 school incidents (I7 out, I8/I9 excluded), 2 barangay-only, pnp 2, bfp 1, lgu 1, doh 1, dpwh 1, other 2" "2|2|3|7|2|2|1|1|1|1|2"
expect_eq "$(jf other_institutions)" "Ambulance/EMS; Pilar RHU; Sorsogon PNP" "other_institutions = distinct other_text + Ambulance/EMS, sorted; out-of-range org excluded"
SUM=$(( $(jf incidents_pnp) + $(jf incidents_bfp) + $(jf incidents_higher_lgu) + $(jf incidents_doh) + $(jf incidents_dpwh) + $(jf incidents_other_agencies) ))
[ "$SUM" -gt "$(jf total_incidents)" ] && pass "Referral columns sum ($SUM) above total_incidents ($(jf total_incidents)) -- an incident counts in every column it was referred to" || fail "Referral columns should be allowed to exceed the total (sum=$SUM)"
expect_eq "$(jf term_start)|$(jf term_end)" "2026-03-01|2026-03-31" "Response echoes the requested range"

call GET "/reports/school-term?term_start=2026-03-01&term_end=2026-03-31" "$ADMIN2"
expect_eq "$(jf total_incidents)|$(jf total_schools)|$(jf total_deployment_days)|$(jf incidents_pnp)" "1|1|1|1" "Cross-tenant: barangay 2 computes only its own data"
call GET "/reports/school-term?term_start=2026-03-02&term_end=2026-03-09" "$ADMIN"
expect_eq "$(jf total_deployment_days)|$(jf total_incidents)" "0|0" "A range with nothing in it computes zeros"
expect_eq "$(code_of GET "/reports/school-term?term_start=2026-03-01&term_end=2027-03-02" "$ADMIN")" "400" "GET /reports/school-term spanning 367 days is 400 (cap 366)"
expect_eq "$(code_of GET "/reports/school-term?term_start=2026-03-01&term_end=2027-03-01" "$ADMIN")" "200" "GET /reports/school-term spanning exactly 366 days is 200"

# ambulance_ems mapping setting
mysql_exec "$VALDB" -e "INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES ('annex_d.ambulance_ems_maps_to','doh',UTC_TIMESTAMP());"
call GET "/reports/school-term?term_start=2026-03-01&term_end=2026-03-31" "$ADMIN"
check_counts "annex_d.ambulance_ems_maps_to=doh moves ambulance_ems from other_agencies to doh (doh 2, other 1)" "2|2|3|7|2|2|1|1|2|1|1"
expect_eq "$(jf other_institutions)" "Pilar RHU; Sorsogon PNP" "'Ambulance/EMS' is dropped from other_institutions when mapped to doh"
mysql_exec "$VALDB" -e "DELETE FROM system_settings WHERE setting_key='annex_d.ambulance_ems_maps_to';"

# ============================================================
step "6. ssz_term_report -- create, edit, state machine, authority, segregation of duties"
# ============================================================
KC=$(uuid)
TR_BODY='{"term_label":"Term 3 S.Y. 2025-2026","term_start":"2026-03-01","term_end":"2026-03-31","remarks":"Draft remarks"}'
expect_eq "$(code_of POST /ssz-term-reports "$PB" "$TR_BODY" -H "Idempotency-Key: $KC")" "403" "Punong Barangay cannot create a term report"
expect_eq "$(code_of POST /ssz-term-reports "$T1" "$TR_BODY" -H "Idempotency-Key: $KC")" "403" "Tanod cannot create a term report"
expect_eq "$(code_of POST /ssz-term-reports "$ADMIN" "$TR_BODY")" "400" "Create without Idempotency-Key is 400"
expect_eq "$(code_of POST /ssz-term-reports "$ADMIN" '{"term_start":"2026-03-01","term_end":"2026-03-31"}' -H "Idempotency-Key: $(uuid)")" "400" "Missing term_label is 400"
expect_eq "$(code_of POST /ssz-term-reports "$ADMIN" '{"term_label":"X","term_start":"2026-03-31","term_end":"2026-03-01"}' -H "Idempotency-Key: $(uuid)")" "400" "Reversed term range is 400"
expect_eq "$(code_of POST /ssz-term-reports "$ADMIN" '{"term_label":"X","term_start":"2026-3-1","term_end":"2026-03-31"}' -H "Idempotency-Key: $(uuid)")" "400" "Malformed term_start is 400"
expect_eq "$(code_of POST /ssz-term-reports "$ADMIN" '{"term_label":"Too long","term_start":"2026-03-01","term_end":"2027-03-02"}' -H "Idempotency-Key: $(uuid)")" "400" "A term spanning 367 days is 400 (cap 366)"
expect_eq "$(db_one "SELECT COUNT(*) FROM ssz_term_report WHERE term_label='Too long';")" "0" "  ...and no report row was created"

call POST /ssz-term-reports "$SEC" "$TR_BODY" -H "Idempotency-Key: $KC"
expect_eq "$CODE|$(jf status)|$(jf version)|$(jf remarks)" "201|draft|1|Draft remarks" "Secretary creates a draft term report"
R1=$(jf report_id)
SNAP="$(jf total_incidents)|$(jf incidents_barangay_only)|$(jf incidents_pnp)|$(jf total_deployment_days)|$(jf total_tanods)|$(jf total_schools)"
expect_eq "$SNAP" "7|2|2|3|2|2" "Snapshot at creation equals the live computation"
call POST /ssz-term-reports "$SEC" "$TR_BODY" -H "Idempotency-Key: $KC"
expect_eq "$CODE|$(jf report_id)" "200|$R1" "Create replay returns the original report (200)"
expect_eq "$(db_one "SELECT COUNT(*) FROM ssz_term_report WHERE barangay_id=1;")" "1" "Replay created no second report"

call GET /ssz-term-reports "$PB"
expect_eq "$CODE|$(jf total)" "200|1" "Punong Barangay lists term reports"
call GET "/ssz-term-reports?status=approved" "$PB"
expect_eq "$(jf total)" "0" "status filter works"
expect_eq "$(code_of GET "/ssz-term-reports?status=bogus" "$PB")" "400" "Invalid status filter is 400"
call GET /ssz-term-reports/$R1 "$PB"
expect_eq "$CODE|$(jf term_label)" "200|Term 3 S.Y. 2025-2026" "Punong Barangay reads one term report"
expect_eq "$(code_of GET /ssz-term-reports "$T1")" "403" "Tanod cannot list term reports"
expect_eq "$(code_of GET /ssz-term-reports/$R1 "$ADMIN2")" "404" "Cross-tenant GET is 404"
call GET /ssz-term-reports "$ADMIN2"
expect_eq "$(jf total)" "0" "Cross-tenant list is empty"
expect_eq "$(code_of GET /ssz-term-reports/999999 "$ADMIN")" "404" "Missing term report is 404"

# --- PATCH while draft
KP=$(uuid)
call PATCH /ssz-term-reports/$R1 "$ADMIN" '{"remarks":"Edited remarks","other_institutions":"Sorsogon PNP; Pilar RHU; Hand-added","version":1}' -H "Idempotency-Key: $KP"
expect_eq "$CODE|$(jf version)|$(jf remarks)|$(jf other_institutions)" "200|2|Edited remarks|Sorsogon PNP; Pilar RHU; Hand-added" "PATCH edits remarks/other_institutions while draft (version 2)"
call PATCH /ssz-term-reports/$R1 "$ADMIN" '{"remarks":"Edited remarks","other_institutions":"Sorsogon PNP; Pilar RHU; Hand-added","version":1}' -H "Idempotency-Key: $KP"
expect_eq "$CODE|$(jf version)" "200|2" "PATCH replay (same key) returns the current state, no second increment"
expect_eq "$(code_of PATCH /ssz-term-reports/$R1 "$ADMIN" '{"remarks":"stale","version":1}' -H "Idempotency-Key: $(uuid)")" "409" "Stale version is 409"
expect_eq "$(code_of PATCH /ssz-term-reports/$R1 "$ADMIN" '{"total_incidents":99}' -H "Idempotency-Key: $(uuid)")" "400" "Counts are not editable (PATCH accepts only remarks/other_institutions)"
expect_eq "$(code_of PATCH /ssz-term-reports/$R1 "$PB" '{"remarks":"x"}' -H "Idempotency-Key: $(uuid)")" "403" "Punong Barangay cannot PATCH"
expect_eq "$(code_of PATCH /ssz-term-reports/$R1 "$ADMIN2" '{"remarks":"x"}' -H "Idempotency-Key: $(uuid)")" "404" "Cross-tenant PATCH is 404"
expect_eq "$(code_of PATCH /ssz-term-reports/$R1 "$ADMIN" '{"remarks":"x"}')" "400" "PATCH without Idempotency-Key is 400"

# --- illegal transitions out of draft
KA=$(uuid)
expect_eq "$(code_of POST /ssz-term-reports/$R1/approve "$PB" '{}' -H "Idempotency-Key: $KA")" "409" "Approving a DRAFT is 409 (must be prepared first)"
expect_eq "$(code_of POST /ssz-term-reports/$R1/mark-submitted "$SEC" '{"mayor_office_received_by":"Clerk","mayor_office_received_at":"2026-04-02"}' -H "Idempotency-Key: $(uuid)")" "409" "Submitting a DRAFT is 409"

# --- prepare: authority + recompute
I12=$(mk_inc $S1 '2026-03-25 02:00:00')   # a new school incident AFTER the snapshot, no referral
expect_eq "$(code_of POST /ssz-term-reports/$R1/prepare "$SEC" '{}' -H "Idempotency-Key: $(uuid)")" "403" "Secretary without prepare_annex_d cannot prepare"
expect_eq "$(code_of POST /ssz-term-reports/$R1/prepare "$NOAUTH" '{}' -H "Idempotency-Key: $(uuid)")" "403" "Admin without the authority cannot prepare"
expect_eq "$(code_of POST /ssz-term-reports/$R1/prepare "$PB" '{}' -H "Idempotency-Key: $(uuid)")" "403" "Punong Barangay holds only approve_annex_d -- cannot prepare"
expect_eq "$(code_of POST /ssz-term-reports/$R1/prepare "$T1" '{}' -H "Idempotency-Key: $(uuid)")" "403" "Tanod cannot prepare"
expect_eq "$(code_of POST /ssz-term-reports/$R1/prepare "$ADMIN" '{}')" "400" "Prepare without Idempotency-Key is 400"
expect_eq "$(code_of POST /ssz-term-reports/$R1/prepare "$ADMIN2" '{}' -H "Idempotency-Key: $(uuid)")" "404" "Cross-tenant prepare (even with the authority) is 404"
KPR=$(uuid)
call POST /ssz-term-reports/$R1/prepare "$ADMIN" '{}' -H "Idempotency-Key: $KPR"
expect_eq "$CODE|$(jf status)|$(jf prepared_by)" "200|prepared|$ADMIN_ID" "Preparer with prepare_annex_d: draft -> prepared"
expect_eq "$(jf total_incidents)|$(jf incidents_barangay_only)" "8|3" "Prepare RECOMPUTED the snapshot (new school incident included: 8 total, 3 barangay-only)"
expect_eq "$(jf other_institutions)" "Sorsogon PNP; Pilar RHU; Hand-added" "Prepare kept the hand-edited other_institutions (report was edited)"
call POST /ssz-term-reports/$R1/prepare "$ADMIN" '{}' -H "Idempotency-Key: $KPR"
expect_eq "$CODE|$(jf status)" "200|prepared" "Prepare replay (same key) returns the report, not 409"
expect_eq "$(code_of POST /ssz-term-reports/$R1/prepare "$ADMIN" '{}' -H "Idempotency-Key: $(uuid)")" "409" "Preparing an already-prepared report with a new key is 409"
expect_eq "$(code_of PATCH /ssz-term-reports/$R1 "$ADMIN" '{"remarks":"late edit"}' -H "Idempotency-Key: $(uuid)")" "409" "PATCH after prepare is 409 (draft only)"

# --- approve: authority, segregation of duties
expect_eq "$(code_of POST /ssz-term-reports/$R1/approve "$ADMIN" '{}' -H "Idempotency-Key: $(uuid)")" "403" "Preparer WITHOUT approve_annex_d is 403 (no authority)"
expect_eq "$(code_of POST /ssz-term-reports/$R1/approve "$SEC" '{}' -H "Idempotency-Key: $(uuid)")" "403" "Secretary without the authority cannot approve"
expect_eq "$(code_of POST /ssz-term-reports/$R1/approve "$T1" '{}' -H "Idempotency-Key: $(uuid)")" "403" "Tanod cannot approve"
expect_eq "$(code_of POST /ssz-term-reports/$R1/approve "$PB" '{}')" "400" "Approve without Idempotency-Key is 400"
expect_eq "$(code_of POST /ssz-term-reports/$R1/approve "$ADMIN2" '{}' -H "Idempotency-Key: $(uuid)")" "404" "Cross-tenant approve is 404"
# A second report, prepared AND approve-authorised by the same account -> the preparer cannot approve it
call POST /ssz-term-reports "$SEC" '{"term_label":"Segregation test","term_start":"2026-03-01","term_end":"2026-03-31"}' -H "Idempotency-Key: $(uuid)"
R2=$(jf report_id)
expect_eq "$(code_of POST /ssz-term-reports/$R2/prepare "$BOTH" '{}' -H "Idempotency-Key: $(uuid)")" "200" "Account holding both authorities prepares report 2"
call POST /ssz-term-reports/$R2/approve "$BOTH" '{}' -H "Idempotency-Key: $(uuid)"
expect_eq "$CODE" "409" "The PREPARER cannot also approve (segregation of duties, 409)"
expect_eq "$(db_one "SELECT status FROM ssz_term_report WHERE report_id=$R2;")" "prepared" "Report 2 stays prepared after the blocked self-approval"
KAP=$(uuid)
call POST /ssz-term-reports/$R1/approve "$PB" '{}' -H "Idempotency-Key: $KAP"
expect_eq "$CODE|$(jf status)|$(jf approved_by)" "200|approved|$PB_ID" "A different official with approve_annex_d approves (prepared -> approved)"
call POST /ssz-term-reports/$R1/approve "$PB" '{}' -H "Idempotency-Key: $KAP"
expect_eq "$CODE|$(jf status)" "200|approved" "Approve replay (same key) returns the report, not 409"
expect_eq "$(code_of POST /ssz-term-reports/$R1/approve "$PB" '{}' -H "Idempotency-Key: $(uuid)")" "409" "Approving an already-approved report with a new key is 409"
expect_eq "$(code_of POST /ssz-term-reports/$R1/prepare "$ADMIN" '{}' -H "Idempotency-Key: $(uuid)")" "409" "Re-preparing an approved report is 409"
expect_eq "$(code_of PATCH /ssz-term-reports/$R1 "$ADMIN" '{"remarks":"x"}' -H "Idempotency-Key: $(uuid)")" "409" "PATCH after approve is 409"

# --- mark submitted
expect_eq "$(code_of POST /ssz-term-reports/$R1/mark-submitted "$PB" '{"mayor_office_received_by":"Clerk","mayor_office_received_at":"2026-04-02"}' -H "Idempotency-Key: $(uuid)")" "403" "Punong Barangay cannot mark submitted"
expect_eq "$(code_of POST /ssz-term-reports/$R1/mark-submitted "$T1" '{}' -H "Idempotency-Key: $(uuid)")" "403" "Tanod cannot mark submitted"
expect_eq "$(code_of POST /ssz-term-reports/$R1/mark-submitted "$SEC" '{"mayor_office_received_by":"Clerk","mayor_office_received_at":"2026-04-02"}')" "400" "mark-submitted without Idempotency-Key is 400"
expect_eq "$(code_of POST /ssz-term-reports/$R1/mark-submitted "$SEC" '{"mayor_office_received_at":"2026-04-02"}' -H "Idempotency-Key: $(uuid)")" "400" "mark-submitted without mayor_office_received_by is 400"
expect_eq "$(code_of POST /ssz-term-reports/$R1/mark-submitted "$SEC" '{"mayor_office_received_by":"Clerk","mayor_office_received_at":"April 2"}' -H "Idempotency-Key: $(uuid)")" "400" "mark-submitted with a malformed date is 400"
expect_eq "$(code_of POST /ssz-term-reports/$R1/mark-submitted "$ADMIN2" '{"mayor_office_received_by":"Clerk","mayor_office_received_at":"2026-04-02"}' -H "Idempotency-Key: $(uuid)")" "404" "Cross-tenant mark-submitted is 404"
KS=$(uuid)
call POST /ssz-term-reports/$R1/mark-submitted "$SEC" '{"mayor_office_received_by":"Mayor Office Clerk","mayor_office_received_at":"2026-04-02","dilg_received_by":"DILG Officer","dilg_date_received":"2026-04-05"}' -H "Idempotency-Key: $KS"
expect_eq "$CODE|$(jf status)|$(jf mayor_office_received_by)|$(jf mayor_office_received_at)|$(jf dilg_received_by)|$(jf dilg_date_received)" "200|submitted|Mayor Office Clerk|2026-04-02|DILG Officer|2026-04-05" "Secretary marks an approved report submitted with the receipt details"
call POST /ssz-term-reports/$R1/mark-submitted "$SEC" '{"mayor_office_received_by":"Mayor Office Clerk","mayor_office_received_at":"2026-04-02"}' -H "Idempotency-Key: $KS"
expect_eq "$CODE|$(jf status)" "200|submitted" "mark-submitted replay (same key) returns the report"
expect_eq "$(code_of POST /ssz-term-reports/$R1/mark-submitted "$SEC" '{"mayor_office_received_by":"Again","mayor_office_received_at":"2026-04-03"}' -H "Idempotency-Key: $(uuid)")" "409" "Marking an already-submitted report with a new key is 409"
expect_eq "$(code_of POST /ssz-term-reports/$R1/approve "$PB" '{}' -H "Idempotency-Key: $(uuid)")" "409" "Nothing moves a submitted report backwards (approve is 409)"
expect_eq "$(db_one "SELECT CONCAT(status,'|',version) FROM ssz_term_report WHERE report_id=$R1;")" "submitted|5" "Terminal state reached; version counts every accepted write (patch, prepare, approve, submit)"

# --- fix review finding 10: preparer / approver names + titles joined server-side
mysql_exec "$VALDB" -e "UPDATE user SET official_title='Chief Tanod' WHERE user_id=$ADMIN_ID; UPDATE user SET official_title='Punong Barangay' WHERE user_id=$PB_ID;"
call GET /ssz-term-reports/$R1 "$SEC"
expect_eq "$CODE|$(jf prepared_by_name)|$(jf prepared_by_title)|$(jf approved_by_name)|$(jf approved_by_title)" "200|SZ Admin Preparer|Chief Tanod|SZ Punong Barangay|Punong Barangay" "GET /ssz-term-reports/:id (as Secretary, who cannot read /users) carries preparer + approver name and title"
call GET /ssz-term-reports "$PB"
expect_eq "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $r){ if($r["report_id"]==(int)$argv[1]) echo $r["prepared_by_name"]."|".$r["approved_by_title"]; }' "$R1")" "SZ Admin Preparer|Punong Barangay" "GET /ssz-term-reports list carries the same names"
call GET /ssz-term-reports/$R2 "$PB"
expect_eq "$(jf prepared_by_name)|$(jf approved_by_name)|$(jf approved_by_title)" "SZ Admin Both|null|null" "A prepared-but-not-approved report has the preparer's name and null approver fields"

# --- skip-state attempt on a fresh draft
call POST /ssz-term-reports "$ADMIN" '{"term_label":"Skip test","term_start":"2026-03-01","term_end":"2026-03-31"}' -H "Idempotency-Key: $(uuid)"
R3=$(jf report_id)
expect_eq "$(code_of POST /ssz-term-reports/$R3/approve "$PB" '{}' -H "Idempotency-Key: $(uuid)")" "409" "draft -> approved is not a legal jump (409)"
expect_eq "$(code_of POST /ssz-term-reports/$R3/mark-submitted "$SEC" '{"mayor_office_received_by":"Clerk","mayor_office_received_at":"2026-04-02"}' -H "Idempotency-Key: $(uuid)")" "409" "draft -> submitted is not a legal jump (409)"

# ============================================================
step "7. Audit trail and privacy"
# ============================================================
for a in ssz_term_report_created ssz_term_report_updated ssz_term_report_prepared ssz_term_report_approved ssz_term_report_submitted school_created school_updated; do
  expect_eq "$([ "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='$a';")" -ge 1 ] && echo yes)" "yes" "Audit action recorded: $a"
done
META="$(db_one "SELECT metadata_json FROM audit_log WHERE action='ssz_term_report_approved' AND entity_id=$R1 LIMIT 1;")"
KEYS="$(printf '%s' "$META" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $k=array_keys($d); sort($k); echo implode(",",$k);')"
expect_eq "$KEYS" "idempotency_key,report_id,status" "Approval audit metadata = report_id/status (+idempotency key) only -- no counts, names or text"
SCHEMA_HITS="$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME IN ('school','school_checkin','ssz_term_report') AND (COLUMN_NAME REGEXP 'student|victim|pupil|learner|child|guardian|parent');")"
expect_eq "$SCHEMA_HITS" "0" "No student/victim/pupil/guardian column in school, school_checkin or ssz_term_report"
call GET /incidents/$INC_A "$SEC"
ALLJSON="$BODY"
call GET /schools "$ADMIN"; ALLJSON="$ALLJSON$BODY"
call GET /ssz-term-reports/$R1 "$ADMIN"; ALLJSON="$ALLJSON$BODY"
call GET /school-checkins "$ADMIN"; ALLJSON="$ALLJSON$BODY"
call GET "/reports/school-term?term_start=2026-03-01&term_end=2026-03-31" "$ADMIN"; ALLJSON="$ALLJSON$BODY"
expect_eq "$(printf '%s' "$ALLJSON" | grep -ciE 'student|victim|pupil')" "0" "No student/victim/pupil key anywhere in the new responses"
call GET "/reports/school-term?term_start=2026-03-01&term_end=2026-03-31" "$ADMIN"
expect_eq "$(printf '%s' "$BODY" | grep -ciE 'raw_narrative|latitude|longitude|contact|complainant')" "0" "Annex D computation carries counts only -- no narrative, coordinates or contact data"
call GET /incidents/$INC_A "$ADMIN"
expect_eq "$([ -z "$(jf raw_narrative)" ] && echo withheld)" "withheld" "Admin still never receives raw_narrative from show() (Rule 1 unchanged)"

# ============================================================
echo
echo "============================================================"
echo "school zones: $PASS passed, $FAIL failed"
echo "============================================================"
[ "$FAIL" -eq 0 ]
