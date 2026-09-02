#!/usr/bin/env bash
# Baranguard — W11/W12/W13 Scheduler + Swap Requests + Fatigue Flags
# validation against a REAL local XAMPP MariaDB + PHP (not a cloud
# sandbox). Safe to run: everything happens in a disposable database
# (baranguard_sched_check) with a disposable app-user, disposable test
# accounts, and a PHP dev server on a throwaway local port. Your real
# `baranguard` database, real backend/.env, and Apache are never touched.
# Mirrors the prior verify-*.sh scripts' conventions.
#
# Usage (from a Git Bash prompt, repo root or anywhere):
#   bash backend/scripts/verify-scheduler-fatigue.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
LOG_FILE="$BACKEND_DIR/scripts/scheduler-fatigue-validation-$(date -u +%Y%m%dT%H%M%SZ).log"

exec > >(tee "$LOG_FILE") 2>&1

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_sched_check"
APP_USER="sched_check_app"
APP_PASSWORD="SchedCheckDbPw!2026"
API_PORT="8100"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="SchedCheck#2026Pw"

echo "Baranguard W11/W12/W13 (Scheduler + Swap Requests + Fatigue) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for candidate in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
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

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  echo "Stopped the test PHP server, dropped $VALDB and user '$APP_USER'."
  echo "Your real 'baranguard' database and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity check"
mysql_exec -e "SELECT VERSION();" && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (0001 baseline + 0002 seed + 0003 nullable user_id)"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "0001 baseline applied" || fail "0001 apply failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" && pass "0002 barangays seeded" || fail "0002 seed failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0003_shift_schedule_nullable_user.sql" && pass "0003 nullable user_id applied" || fail "0003 apply failed"
NULLABLE_CHECK=$(mysql_exec -N -s "$VALDB" -e "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='shift_schedule' AND COLUMN_NAME='user_id';")
[ "$NULLABLE_CHECK" = "YES" ] && pass "shift_schedule.user_id is confirmed nullable in information_schema" || fail "shift_schedule.user_id IS_NULLABLE=$NULLABLE_CHECK (expected YES)"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

step "2. Seed accounts + pre-existing shifts to prime one Tanod near the fatigue threshold"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'sched_admin',    '$HASH', 'Sched Admin',    'admin', 1, UTC_TIMESTAMP()),
  (1, 'sched_tanod1',   '$HASH', 'Sched Tanod One',  'tanod', 1, UTC_TIMESTAMP()),
  (1, 'sched_tanod2',   '$HASH', 'Sched Tanod Two',  'tanod', 1, UTC_TIMESTAMP()),
  (2, 'sched_admin_b2', '$HASH', 'Sched Admin B2', 'admin', 1, UTC_TIMESTAMP()),
  (2, 'sched_tanod_b2', '$HASH', 'Sched Tanod B2', 'tanod', 1, UTC_TIMESTAMP());
SQL
TANOD1_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='sched_tanod1';")
TANOD2_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='sched_tanod2';")
TANOD_B2_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='sched_tanod_b2';")
ADMIN_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='sched_admin';")
# tanod1: 6 shifts of 8h each, one per of the last 6 days ending "now" -> 48h so far (under the 56h threshold).
mysql_exec "$VALDB" <<SQL
INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, client_request_id) VALUES
  (1, $TANOD1_ID, 'Zone A', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 DAY) + INTERVAL 8 HOUR, $ADMIN_ID, 'seed-shift-1-1111111111111111111111111'),
  (1, $TANOD1_ID, 'Zone A', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 DAY) + INTERVAL 8 HOUR, $ADMIN_ID, 'seed-shift-2-2222222222222222222222222'),
  (1, $TANOD1_ID, 'Zone A', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 4 DAY) + INTERVAL 8 HOUR, $ADMIN_ID, 'seed-shift-3-3333333333333333333333333'),
  (1, $TANOD1_ID, 'Zone A', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY) + INTERVAL 8 HOUR, $ADMIN_ID, 'seed-shift-4-4444444444444444444444444'),
  (1, $TANOD1_ID, 'Zone A', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY) + INTERVAL 8 HOUR, $ADMIN_ID, 'seed-shift-5-5555555555555555555555555'),
  (1, $TANOD1_ID, 'Zone A', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) + INTERVAL 8 HOUR, $ADMIN_ID, 'seed-shift-6-6666666666666666666666666');
SQL
[ $? -eq 0 ] && pass "Seeded 5 users + 6 pre-existing 8h shifts for tanod1 (48h total, under the 56h threshold)" || fail "Seed SQL failed"

step "3. Start the API (PHP built-in server on a throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN='*'
(cd "$BACKEND_DIR/public" && "$PHP_BIN" -S "127.0.0.1:${API_PORT}" >"$BACKEND_DIR/scripts/.sched-server.log" 2>&1) &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null "${BASE_URL}/auth/login" -X POST -d '{}' && pass "PHP dev server responding on port $API_PORT" || { fail "PHP dev server did not start"; exit 1; }

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as sched_admin)
TANOD1_TOKEN=$(login_as sched_tanod1)
TANOD2_TOKEN=$(login_as sched_tanod2)
ADMIN_B2_TOKEN=$(login_as sched_admin_b2)
TANOD_B2_TOKEN=$(login_as sched_tanod_b2)
[ -n "$ADMIN_TOKEN" ] && [ -n "$TANOD1_TOKEN" ] && pass "Logged in as admin, tanod1, tanod2, barangay-2 admin/tanod" || fail "One or more logins failed"

extract() {
  local resp="$1" key="$2"
  echo "$resp" | "$PHP_BIN" -r "\$d=json_decode(file_get_contents('php://stdin'),true); echo \$d['$key'] ?? 'MISSING';"
}

# ============================================================
# W11 — POST/GET/PATCH /shifts
# ============================================================
step "4. POST /shifts — create, idempotency, overlap rejection, role/tenant gating"
REQ_KEY="aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa"
START_T=$(mysql_exec -N -s "$VALDB" -e "SELECT DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), '%Y-%m-%dT%H:%i:%sZ');")
END_T=$(mysql_exec -N -s "$VALDB" -e "SELECT DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY) + INTERVAL 4 HOUR, '%Y-%m-%dT%H:%i:%sZ');")
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shifts" -X POST -d "{\"user_id\":$TANOD2_ID,\"patrol_zone\":\"Zone B\",\"start_at\":\"$START_T\",\"end_at\":\"$END_T\",\"request_id\":\"$REQ_KEY\"}")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
[ "$CODE" = "201" ] && pass "Admin POST /shifts -> 201" || fail "POST /shifts -> $CODE (expected 201): $BODY"
SHIFT_ID=$(extract "$BODY" shift_id)

RETRY=$(curl -s "${BASE_URL}/shifts" -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"user_id\":$TANOD2_ID,\"patrol_zone\":\"Zone B\",\"start_at\":\"$START_T\",\"end_at\":\"$END_T\",\"request_id\":\"$REQ_KEY\"}")
RETRY_SHIFT_ID=$(extract "$RETRY" shift_id)
[ "$RETRY_SHIFT_ID" = "$SHIFT_ID" ] && pass "Retry with same request_id returns the same shift_id (idempotent)" || fail "Retry shift_id=$RETRY_SHIFT_ID (expected $SHIFT_ID)"
ROWCOUNT=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM shift_schedule WHERE client_request_id='$REQ_KEY';")
[ "$ROWCOUNT" = "1" ] && pass "Exactly 1 row exists in the DB for that request_id (verified, not just response)" || fail "DB row count=$ROWCOUNT (expected 1)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shifts" -X POST -d "{\"user_id\":$TANOD2_ID,\"patrol_zone\":\"Zone B\",\"start_at\":\"$START_T\",\"end_at\":\"$END_T\",\"request_id\":\"bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb\"}")
[ "$CODE" = "409" ] && pass "Overlapping shift for the same Tanod -> 409" || fail "Overlap -> $CODE (expected 409)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TANOD1_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shifts" -X POST -d "{\"user_id\":$TANOD2_ID,\"start_at\":\"$START_T\",\"end_at\":\"$END_T\",\"request_id\":\"cccccccc-3333-4ccc-8ccc-cccccccccccc\"}")
[ "$CODE" = "403" ] && pass "Tanod POST /shifts -> 403 (Admin only)" || fail "Tanod create -> $CODE (expected 403)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shifts" -X POST -d "{\"user_id\":$TANOD_B2_ID,\"start_at\":\"$START_T\",\"end_at\":\"$END_T\",\"request_id\":\"dddddddd-4444-4ddd-8ddd-dddddddddddd\"}")
[ "$CODE" = "422" ] && pass "Cross-tenant Tanod (barangay 2) -> 422" || fail "Cross-tenant tanod -> $CODE (expected 422)"

step "5. GET /shifts — role scoping"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/shifts?limit=100")
TOTAL=$(extract "$RESP" total)
[ "$TOTAL" = "7" ] && pass "Admin sees all 7 barangay-1 shifts (6 seeded + 1 created)" || fail "Admin shifts total=$TOTAL (expected 7)"

RESP=$(curl -s -H "Authorization: Bearer $TANOD1_TOKEN" "${BASE_URL}/shifts?limit=100")
TOTAL=$(extract "$RESP" total)
[ "$TOTAL" = "6" ] && pass "Tanod sees only own 6 shifts (forced to self)" || fail "Tanod own shifts total=$TOTAL (expected 6)"

step "6. PATCH /shifts/:id — version conflict, reassignment, unassign"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shifts/${SHIFT_ID}" -X PATCH -d '{"patrol_zone":"Zone B Updated","version":99}')
[ "$CODE" = "409" ] && pass "Stale version -> 409" || fail "Stale version -> $CODE (expected 409)"

RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shifts/${SHIFT_ID}" -X PATCH -d '{"patrol_zone":"Zone B Updated","version":1}')
CODE=$(echo "$RESP" | tail -1)
[ "$CODE" = "200" ] && pass "Correct version -> 200" || fail "Correct version -> $CODE (expected 200)"
DB_ZONE=$(mysql_exec -N -s "$VALDB" -e "SELECT patrol_zone FROM shift_schedule WHERE shift_id=$SHIFT_ID;")
[ "$DB_ZONE" = "Zone B Updated" ] && pass "patrol_zone actually persisted (verified in DB)" || fail "DB patrol_zone='$DB_ZONE'"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shifts/${SHIFT_ID}" -X PATCH -d '{"user_id":null,"version":2}')
[ "$CODE" = "200" ] && pass "Unassign (user_id:null) -> 200" || fail "Unassign -> $CODE (expected 200)"
# mysql -N -s prints the literal text "NULL" for a NULL column (verified
# directly), not an empty string -- compare against that, not -z.
DB_USER=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM shift_schedule WHERE shift_id=$SHIFT_ID;")
[ "$DB_USER" = "NULL" ] && pass "shift_schedule.user_id is actually NULL in the DB after unassign" || fail "DB user_id='$DB_USER' (expected NULL)"

# ============================================================
# Fatigue — pushing tanod1 over the 56h threshold
# ============================================================
step "7. Fatigue flag creation when a new shift pushes a Tanod over the 56h/7-day threshold"
FSTART=$(mysql_exec -N -s "$VALDB" -e "SELECT DATE_FORMAT(UTC_TIMESTAMP() + INTERVAL 1 HOUR, '%Y-%m-%dT%H:%i:%sZ');")
FEND=$(mysql_exec -N -s "$VALDB" -e "SELECT DATE_FORMAT(UTC_TIMESTAMP() + INTERVAL 11 HOUR, '%Y-%m-%dT%H:%i:%sZ');")
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shifts" -X POST -d "{\"user_id\":$TANOD1_ID,\"patrol_zone\":\"Zone A\",\"start_at\":\"$FSTART\",\"end_at\":\"$FEND\",\"request_id\":\"eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee\"}")
FATIGUE_SHIFT_ID=$(extract "$RESP" shift_id)
[ -n "$FATIGUE_SHIFT_ID" ] && [ "$FATIGUE_SHIFT_ID" != "MISSING" ] && pass "10h shift created for tanod1 (48h + 10h = 58h, over 56h threshold)" || fail "Fatigue-triggering shift creation failed: $RESP"

FLAG_COUNT=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM fatigue_flag WHERE user_id=$TANOD1_ID AND shift_id=$FATIGUE_SHIFT_ID;")
[ "$FLAG_COUNT" = "1" ] && pass "fatigue_flag row created, keyed to the triggering shift (verified in DB)" || fail "fatigue_flag count=$FLAG_COUNT (expected 1)"
FLAG_HOURS=$(mysql_exec -N -s "$VALDB" -e "SELECT hours_worked_7day FROM fatigue_flag WHERE user_id=$TANOD1_ID AND shift_id=$FATIGUE_SHIFT_ID;")
[ "$FLAG_HOURS" = "58.00" ] && pass "hours_worked_7day = 58.00 (48h prior + 10h new, correctly summed)" || fail "hours_worked_7day=$FLAG_HOURS (expected 58.00)"

step "8. GET /shifts/fatigue-flags + PATCH /fatigue-flags/:id/acknowledge"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/shifts/fatigue-flags")
TOTAL=$(extract "$RESP" total)
[ "$TOTAL" = "1" ] && pass "GET /shifts/fatigue-flags returns the 1 flag" || fail "fatigue-flags total=$TOTAL (expected 1)"
FLAG_ID=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["items"][0]["flag_id"] ?? "MISSING";')

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TANOD1_TOKEN" "${BASE_URL}/shifts/fatigue-flags")
[ "$CODE" = "403" ] && pass "Tanod -> 403 on fatigue-flags list" || fail "Tanod fatigue-flags -> $CODE (expected 403)"

RESP_B2=$(curl -s -H "Authorization: Bearer $ADMIN_B2_TOKEN" "${BASE_URL}/shifts/fatigue-flags")
TOTAL_B2=$(extract "$RESP_B2" total)
[ "$TOTAL_B2" = "0" ] && pass "Barangay-2 admin sees 0 flags (tenant isolation)" || fail "Barangay-2 fatigue total=$TOTAL_B2 (expected 0)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/fatigue-flags/${FLAG_ID}/acknowledge" -X PATCH -d '{}')
[ "$CODE" = "200" ] && pass "PATCH /fatigue-flags/:id/acknowledge -> 200" || fail "Acknowledge -> $CODE (expected 200)"
DB_ACK=$(mysql_exec -N -s "$VALDB" -e "SELECT acknowledged_by FROM fatigue_flag WHERE flag_id=$FLAG_ID;")
[ "$DB_ACK" = "$ADMIN_ID" ] && pass "acknowledged_by persisted in the DB" || fail "DB acknowledged_by=$DB_ACK (expected $ADMIN_ID)"

STILL_THERE=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM fatigue_flag WHERE flag_id=$FLAG_ID;")
[ "$STILL_THERE" = "1" ] && pass "Flag row still exists after acknowledgment (never deleted, per spec)" || fail "Flag row missing after acknowledge"

# ============================================================
# W12 — Shift swap requests
# ============================================================
step "9. POST /shift-swap-requests — ownership check, named target, idempotency"
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TANOD1_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shift-swap-requests" -X POST -d "{\"shift_id\":$FATIGUE_SHIFT_ID,\"target_user_id\":$TANOD2_ID,\"reason\":\"sandbox test - too tired\",\"client_request_id\":\"ffffffff-6666-4fff-8fff-ffffffffffff\"}")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
[ "$CODE" = "201" ] && pass "Tanod1 requests a swap for their own shift, naming tanod2 as target -> 201" || fail "Swap create -> $CODE (expected 201): $BODY"
SWAP_REQUEST_ID=$(extract "$BODY" request_id)
RESP_TARGET=$(extract "$BODY" target_user_id)
[ "$RESP_TARGET" = "$TANOD2_ID" ] && pass "Response echoes the named target_user_id" || fail "target_user_id=$RESP_TARGET (expected $TANOD2_ID)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TANOD2_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shift-swap-requests" -X POST -d "{\"shift_id\":$FATIGUE_SHIFT_ID,\"client_request_id\":\"11111111-7777-4111-8111-111111111111\"}")
[ "$CODE" = "403" ] && pass "Tanod2 requesting a swap for tanod1's shift -> 403 (not their own)" || fail "Non-owner swap request -> $CODE (expected 403)"

step "10. PATCH /shift-swap-requests/:id — approve WITH a named target: real reassignment + fatigue recalc for both users"
TANOD1_HOURS_BEFORE=$(mysql_exec -N -s "$VALDB" -e "SELECT hours_worked_7day FROM fatigue_flag WHERE user_id=$TANOD1_ID AND shift_id=$FATIGUE_SHIFT_ID;")
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shift-swap-requests/${SWAP_REQUEST_ID}" -X PATCH -d '{"status":"approved","version":1}')
CODE=$(echo "$RESP" | tail -1)
[ "$CODE" = "200" ] && pass "Approve (named target on the request) -> 200" || fail "Approve -> $CODE (expected 200): $RESP"
NEW_SHIFT_OWNER=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM shift_schedule WHERE shift_id=$FATIGUE_SHIFT_ID;")
[ "$NEW_SHIFT_OWNER" = "$TANOD2_ID" ] && pass "Shift actually reassigned from tanod1 to tanod2 in the DB" || fail "shift user_id=$NEW_SHIFT_OWNER (expected $TANOD2_ID)"
# Recalculation runs for tanod2 too, but their own total in this window is
# just the 10h of this one shift -- correctly under the 56h threshold, so
# NO flag should exist for them (recalculation must not over-flag someone
# who isn't actually fatigued just because a recalculation ran).
TANOD2_FLAG_COUNT=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM fatigue_flag WHERE user_id=$TANOD2_ID;")
[ "$TANOD2_FLAG_COUNT" = "0" ] && pass "Fatigue recalculated for tanod2 too, but correctly raised no flag (10h is under the 56h threshold)" || fail "tanod2 fatigue_flag count=$TANOD2_FLAG_COUNT (expected 0)"

step "11. Revalidation on approve: reassigned-out-from-under-the-request -> 409"
FSTART2=$(mysql_exec -N -s "$VALDB" -e "SELECT DATE_FORMAT(UTC_TIMESTAMP() + INTERVAL 2 DAY, '%Y-%m-%dT%H:%i:%sZ');")
FEND2=$(mysql_exec -N -s "$VALDB" -e "SELECT DATE_FORMAT(UTC_TIMESTAMP() + INTERVAL 2 DAY + INTERVAL 4 HOUR, '%Y-%m-%dT%H:%i:%sZ');")
NEWSHIFT_RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shifts" -X POST -d "{\"user_id\":$TANOD2_ID,\"patrol_zone\":\"Zone C\",\"start_at\":\"$FSTART2\",\"end_at\":\"$FEND2\",\"request_id\":\"33333333-9999-4333-8333-333333333333\"}")
NEWSHIFT_ID=$(extract "$NEWSHIFT_RESP" shift_id)

SWAP2_RESP=$(curl -s -H "Authorization: Bearer $TANOD2_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shift-swap-requests" -X POST -d "{\"shift_id\":$NEWSHIFT_ID,\"client_request_id\":\"44444444-aaaa-4444-8444-444444444444\"}")
SWAP2_ID=$(extract "$SWAP2_RESP" request_id)

# Admin directly reassigns this shift away from tanod2 (out from under the pending request) before it's resolved.
mysql_exec "$VALDB" -e "UPDATE shift_schedule SET user_id = $TANOD1_ID, version = version + 1 WHERE shift_id = $NEWSHIFT_ID;" >/dev/null
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shift-swap-requests/${SWAP2_ID}" -X PATCH -d '{"status":"approved","version":1}')
[ "$CODE" = "409" ] && pass "Approving a request whose shift was reassigned out from under it -> 409 (revalidation caught it)" || fail "Revalidation -> $CODE (expected 409)"

step "12. Version conflict + already-resolved conflict on deny"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shift-swap-requests/${SWAP2_ID}" -X PATCH -d '{"status":"denied","version":99}')
[ "$CODE" = "409" ] && pass "Stale version on swap-request resolve -> 409" || fail "Stale version -> $CODE (expected 409)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shift-swap-requests/${SWAP2_ID}" -X PATCH -d '{"status":"denied","version":1}')
[ "$CODE" = "200" ] && pass "Deny with correct version -> 200" || fail "Deny -> $CODE (expected 200)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/shift-swap-requests/${SWAP2_ID}" -X PATCH -d '{"status":"approved","version":2}')
[ "$CODE" = "409" ] && pass "Re-resolving an already-denied request -> 409 (idempotent-safe, not silently re-processed)" || fail "Re-resolve -> $CODE (expected 409)"

step "13. GET /shift-swap-requests — role scoping"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/shift-swap-requests?limit=100")
TOTAL=$(extract "$RESP" total)
[ "$TOTAL" = "2" ] && pass "Admin sees both barangay-1 swap requests" || fail "Admin swap-requests total=$TOTAL (expected 2)"

RESP=$(curl -s -H "Authorization: Bearer $TANOD2_TOKEN" "${BASE_URL}/shift-swap-requests?limit=100")
TOTAL=$(extract "$RESP" total)
[ "$TOTAL" = "1" ] && pass "Tanod2 sees only their own 1 swap request" || fail "Tanod2 own swap-requests total=$TOTAL (expected 1)"

step "Summary"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
[ "$FAIL" -eq 0 ]
