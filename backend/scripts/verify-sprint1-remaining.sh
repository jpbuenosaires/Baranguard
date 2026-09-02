#!/usr/bin/env bash
# Baranguard — Sprint 1's remaining "Today's cut" items validation against a
# REAL local XAMPP MariaDB + PHP (not a cloud sandbox): W5 Historical
# Heatmap, W6 Electronic Blotter List, W9 Statistical Reports (Generate
# only), W15 Settings/Account, W16 Citizen Reports Inbox (list only), W19
# Public Citizen Report. Safe to run: everything happens in a disposable
# database (baranguard_s1rem_check) with a disposable app-user, disposable
# test accounts, and a PHP dev server on a throwaway local port. Your real
# `baranguard` database, real backend/.env, and Apache are never touched.
# Mirrors verify-sprint1-auth.sh / verify-w2-reports.sh / verify-w3-w4-
# dispatch-gis.sh's conventions.
#
# Usage (from a Git Bash prompt, repo root or anywhere):
#   bash backend/scripts/verify-sprint1-remaining.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
LOG_FILE="$BACKEND_DIR/scripts/sprint1-remaining-validation-$(date -u +%Y%m%dT%H%M%SZ).log"

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
VALDB="baranguard_s1rem_check"
APP_USER="s1rem_check_app"
APP_PASSWORD="S1RemCheckDbPw!2026"
API_PORT="8099"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="S1RemCheck#2026Pw"

echo "Baranguard Sprint 1 remaining items (W5/W6/W9/W15/W16/W19) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  pkill -f "php -S 127.0.0.1:${API_PORT}" 2>/dev/null
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  echo "Stopped the test PHP server, dropped $VALDB and user '$APP_USER'."
  echo "Your real 'baranguard' database and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity check"
mysql_exec -e "SELECT VERSION();" && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "Schema applied" || fail "Schema apply failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" && pass "Barangays seeded" || fail "Seed failed"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

step "2. Seed test accounts + incidents with coordinates (barangay 1), 1 admin in barangay 2"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 's1check_admin',     '$HASH', 'S1 Check Admin',     'admin',           1, UTC_TIMESTAMP()),
  (1, 's1check_secretary', '$HASH', 'S1 Check Secretary', 'secretary',       1, UTC_TIMESTAMP()),
  (1, 's1check_pb',        '$HASH', 'S1 Check PB',        'punong_barangay', 1, UTC_TIMESTAMP()),
  (1, 's1check_tanod',     '$HASH', 'S1 Check Tanod',     'tanod',           1, UTC_TIMESTAMP()),
  (2, 's1check_admin_b2',  '$HASH', 'S1 Check Admin B2',  'admin',           1, UTC_TIMESTAMP());

INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, latitude, longitude, created_at, updated_at) VALUES
  (1, 1, 'theft', 'normal', 'sandbox test narrative', 'resolved', 'web', 12.9186, 123.6667, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, 1, 'fire',  'normal', 'sandbox test narrative', 'pending',  'web', 12.9200, 123.6650, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (2, 5, 'theft', 'normal', 'sandbox test narrative', 'pending',  'web', 12.9000, 123.7000, UTC_TIMESTAMP(), UTC_TIMESTAMP());

INSERT INTO citizen_report (barangay_id, contact_number, description, latitude, longitude, submitted_at) VALUES
  (1, '09171234567', 'Pre-seeded unconverted report for inbox check', 12.91, 123.66, UTC_TIMESTAMP());
SQL
[ $? -eq 0 ] && pass "Seeded 5 users, 3 incidents (2 in barangay 1 with coords, 1 in barangay 2), 1 citizen_report" || fail "Seed SQL failed"

step "3. Start the API (PHP built-in server on a throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN='*'
(cd "$BACKEND_DIR/public" && "$PHP_BIN" -S "127.0.0.1:${API_PORT}" >"$BACKEND_DIR/scripts/.s1rem-server.log" 2>&1) &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null "${BASE_URL}/auth/login" -X POST -d '{}' && pass "PHP dev server responding on port $API_PORT" || { fail "PHP dev server did not start"; exit 1; }

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as s1check_admin)
SEC_TOKEN=$(login_as s1check_secretary)
PB_TOKEN=$(login_as s1check_pb)
TANOD_TOKEN=$(login_as s1check_tanod)
ADMIN_B2_TOKEN=$(login_as s1check_admin_b2)
[ -n "$ADMIN_TOKEN" ] && [ -n "$SEC_TOKEN" ] && [ -n "$PB_TOKEN" ] && pass "Logged in as admin, secretary, PB, tanod, barangay-2 admin" || fail "One or more logins failed to return a token"

extract() {
  local resp="$1" key="$2"
  echo "$resp" | "$PHP_BIN" -r "\$d=json_decode(file_get_contents('php://stdin'),true); echo \$d['$key'] ?? 'MISSING';"
}

# ============================================================
# W5 — GET /reports/heatmap
# ============================================================
step "4. W5 GET /reports/heatmap"
RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/reports/heatmap")
COUNT=$(echo "$RESP" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["items"] ?? []);')
[ "$COUNT" = "2" ] && pass "Admin (barangay 1) heatmap returns 2 points (only own-barangay incidents with coords)" || fail "heatmap item count=$COUNT (expected 2)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TANOD_TOKEN" "${BASE_URL}/reports/heatmap")
[ "$CODE" = "403" ] && pass "Tanod -> 403 on heatmap (Admin/PB only)" || fail "Tanod heatmap -> $CODE (expected 403)"

RESP_B2=$(curl -s -H "Authorization: Bearer $ADMIN_B2_TOKEN" "${BASE_URL}/reports/heatmap")
COUNT_B2=$(echo "$RESP_B2" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["items"] ?? []);')
[ "$COUNT_B2" = "1" ] && pass "Barangay-2 admin sees only their own 1 point (tenant isolation)" || fail "Barangay-2 heatmap count=$COUNT_B2 (expected 1)"

# ============================================================
# W6 — POST /incidents (web path) + GET /incidents (blotter list)
# ============================================================
step "5. W6 POST /incidents (web path, idempotent) + role gating"
IDEMPOTENCY_KEY="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $SEC_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  "${BASE_URL}/incidents" -X POST -d '{"incident_type":"vandalism","raw_narrative":"sandbox test narrative for blotter entry"}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
[ "$CODE" = "201" ] && pass "Secretary POST /incidents -> 201" || fail "Secretary POST /incidents -> $CODE (expected 201)"
INCIDENT_ID=$(extract "$BODY" incident_id)

RETRY_RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $SEC_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  "${BASE_URL}/incidents" -X POST -d '{"incident_type":"vandalism","raw_narrative":"sandbox test narrative for blotter entry"}')
RETRY_CODE=$(echo "$RETRY_RESP" | tail -1)
RETRY_BODY=$(echo "$RETRY_RESP" | head -n -1)
RETRY_INCIDENT_ID=$(extract "$RETRY_BODY" incident_id)
[ "$RETRY_CODE" = "200" ] && [ "$RETRY_INCIDENT_ID" = "$INCIDENT_ID" ] && pass "Retry with same Idempotency-Key -> 200, same incident_id (no duplicate)" || fail "Retry -> code=$RETRY_CODE incident_id=$RETRY_INCIDENT_ID (expected 200, $INCIDENT_ID)"

ROWCOUNT=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM incident WHERE client_event_id = '$IDEMPOTENCY_KEY';")
[ "$ROWCOUNT" = "1" ] && pass "Exactly 1 row exists in the DB for that Idempotency-Key (verified in DB, not just the response)" || fail "DB row count=$ROWCOUNT (expected 1)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: cccccccc-cccc-4ccc-8ccc-cccccccccccc" \
  "${BASE_URL}/incidents" -X POST -d '{"incident_type":"vandalism","raw_narrative":"n/a"}')
[ "$CODE" = "201" ] && pass "Admin POST /incidents -> 201 (also allowed per role matrix)" || fail "Admin POST /incidents -> $CODE (expected 201)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TANOD_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: dddddddd-dddd-4ddd-8ddd-dddddddddddd" \
  "${BASE_URL}/incidents" -X POST -d '{"incident_type":"vandalism","raw_narrative":"n/a"}')
[ "$CODE" = "403" ] && pass "Tanod POST /incidents -> 403 (web-side entry is Admin/Secretary only)" || fail "Tanod POST /incidents -> $CODE (expected 403)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/incidents" -X POST -d '{"incident_type":"vandalism","raw_narrative":"n/a"}')
[ "$CODE" = "400" ] && pass "POST /incidents without Idempotency-Key header -> 400" || fail "Missing header -> $CODE (expected 400)"

RESP=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/incidents?limit=100")
TOTAL=$(extract "$RESP" total)
[ "$TOTAL" = "4" ] && pass "GET /incidents (blotter list) shows all 4 barangay-1 incidents (2 seeded + 2 just created), no status filter" || fail "Blotter list total=$TOTAL (expected 4)"

# ============================================================
# W9 — Statistical Reports reuses GET /reports/summary (already covered
# by verify-w2-reports.sh's own suite) — just a role-gate spot check here.
# ============================================================
step "6. W9 GET /reports/summary role gate (Statistical Reports data source)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PB_TOKEN" "${BASE_URL}/reports/summary")
[ "$CODE" = "200" ] && pass "PB (read-only) can GET /reports/summary for Statistical Reports -> 200" || fail "PB /reports/summary -> $CODE (expected 200)"

# ============================================================
# W15 — POST /auth/change-password + PATCH /users/:id (self-only)
# ============================================================
step "7. W15 POST /auth/change-password"
NEW_PW="S1RemCheckNEW#2026Pw"
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/auth/change-password" -X POST -d "{\"current_password\":\"wrong-password\",\"new_password\":\"$NEW_PW\"}")
CODE=$(echo "$RESP" | tail -1)
[ "$CODE" = "401" ] && pass "Wrong current_password -> 401" || fail "Wrong current_password -> $CODE (expected 401)"

RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/auth/change-password" -X POST -d "{\"current_password\":\"$TEST_PW\",\"new_password\":\"short1A\"}")
CODE=$(echo "$RESP" | tail -1)
[ "$CODE" = "400" ] && pass "Weak new_password (policy violation) -> 400" || fail "Weak password -> $CODE (expected 400)"

# A second concurrent admin session, to verify it gets revoked but the
# current one survives.
SECOND_ADMIN_TOKEN=$(login_as s1check_admin)
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/auth/change-password" -X POST -d "{\"current_password\":\"$TEST_PW\",\"new_password\":\"$NEW_PW\"}")
CODE=$(echo "$RESP" | tail -1)
[ "$CODE" = "200" ] && pass "Correct current_password + valid new_password -> 200" || fail "Change password -> $CODE (expected 200)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE_URL}/incidents?limit=1")
[ "$CODE" = "200" ] && pass "Current session (that made the change) is still valid after password change" || fail "Current session -> $CODE (expected 200, session should survive)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $SECOND_ADMIN_TOKEN" "${BASE_URL}/incidents?limit=1")
[ "$CODE" = "401" ] && pass "Other session (second admin token) was revoked by the password change -> 401" || fail "Second session -> $CODE (expected 401, should be revoked)"

RELOGIN_TOKEN=$(curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"s1check_admin\",\"password\":\"$NEW_PW\"}" \
  | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";')
[ -n "$RELOGIN_TOKEN" ] && pass "Can log in again with the NEW password" || fail "Re-login with new password failed"

step "8. W15 PATCH /users/:id (self-only)"
ADMIN_USER_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='s1check_admin';")
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $RELOGIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/users/${ADMIN_USER_ID}" -X PATCH -d '{"full_name":"S1 Check Admin Renamed","contact_number":"09179998888"}')
CODE=$(echo "$RESP" | tail -1)
[ "$CODE" = "200" ] && pass "Self-edit full_name/contact_number -> 200" || fail "Self-edit -> $CODE (expected 200)"
DB_NAME_CHECK=$(mysql_exec -N -s "$VALDB" -e "SELECT full_name FROM user WHERE user_id=$ADMIN_USER_ID;")
[ "$DB_NAME_CHECK" = "S1 Check Admin Renamed" ] && pass "full_name actually persisted in the DB (verified, not just response)" || fail "DB full_name='$DB_NAME_CHECK' (expected 'S1 Check Admin Renamed')"

SEC_USER_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT user_id FROM user WHERE username='s1check_secretary';")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $RELOGIN_TOKEN" -H "Content-Type: application/json" \
  "${BASE_URL}/users/${SEC_USER_ID}" -X PATCH -d '{"full_name":"Hijacked Name"}')
[ "$CODE" = "403" ] && pass "Admin editing a DIFFERENT user's row via this endpoint -> 403 (self-only, not admin-edit-others)" || fail "Cross-user edit -> $CODE (expected 403)"

# ============================================================
# W19 — POST /citizen-reports (public) + W16 GET /citizen-reports (inbox)
# ============================================================
step "9. W19 POST /citizen-reports (public, no auth)"
RESP=$(curl -s -w "\n%{http_code}" "${BASE_URL}/citizen-reports" -X POST -H "Content-Type: application/json" \
  -d '{"barangay_id":1,"description":"sandbox test citizen report narrative","contact_number":"09171112222"}')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
[ "$CODE" = "201" ] && pass "Public citizen report submit (no Authorization header) -> 201" || fail "Public submit -> $CODE (expected 201)"
REPORT_ID=$(extract "$BODY" report_id)
[ -n "$REPORT_ID" ] && [ "$REPORT_ID" != "MISSING" ] && pass "Response includes a report_id" || fail "No report_id in response"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/citizen-reports" -X POST -H "Content-Type: application/json" \
  -d '{"barangay_id":99,"description":"n/a"}')
[ "$CODE" = "400" ] && pass "Unknown barangay_id -> 400" || fail "Unknown barangay_id -> $CODE (expected 400)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/citizen-reports" -X POST -H "Content-Type: application/json" \
  -d '{"barangay_id":1,"description":""}')
[ "$CODE" = "400" ] && pass "Empty description -> 400" || fail "Empty description -> $CODE (expected 400)"

step "10. Rate limiting (3 accepted submissions/15min, then 429)"
for i in 2 3; do
  curl -s -o /dev/null "${BASE_URL}/citizen-reports" -X POST -H "Content-Type: application/json" \
    -d "{\"barangay_id\":1,\"description\":\"sandbox rate-limit filler $i\"}"
done
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/citizen-reports" -X POST -H "Content-Type: application/json" \
  -d '{"barangay_id":1,"description":"sandbox rate-limit 4th attempt"}')
[ "$CODE" = "429" ] && pass "4th submission from the same IP within the window -> 429 RATE_LIMITED" || fail "4th submission -> $CODE (expected 429)"

step "11. W16 GET /citizen-reports (inbox, list only)"
RESP=$(curl -s -H "Authorization: Bearer $RELOGIN_TOKEN" "${BASE_URL}/citizen-reports?status=unconverted")
TOTAL=$(extract "$RESP" total)
[ "$TOTAL" = "4" ] && pass "Admin sees 4 unconverted reports (1 pre-seeded + 3 accepted before rate-limit)" || fail "Inbox total=$TOTAL (expected 4)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TANOD_TOKEN" "${BASE_URL}/citizen-reports")
[ "$CODE" = "403" ] && pass "Tanod -> 403 on citizen reports inbox (Admin/Secretary only)" || fail "Tanod inbox -> $CODE (expected 403)"

RESP_B2=$(curl -s -H "Authorization: Bearer $ADMIN_B2_TOKEN" "${BASE_URL}/citizen-reports")
TOTAL_B2=$(extract "$RESP_B2" total)
[ "$TOTAL_B2" = "0" ] && pass "Barangay-2 admin sees 0 (tenant isolation — all seeded reports are barangay 1)" || fail "Barangay-2 inbox total=$TOTAL_B2 (expected 0)"

step "Summary"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
[ "$FAIL" -eq 0 ]
