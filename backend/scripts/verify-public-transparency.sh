#!/usr/bin/env bash
# Baranguard — GET /public/transparency validation (code-review findings
# H-13/L-03, 2026-09-24 external audit): "publish it properly" — the
# endpoint existed with no rate limit, no HTTP caching, and no web page
# ever linking to it. This proves the real fix: RateLimiter-backed 429s,
# a Cache-Control header, and the response shape the new web page
# (web/src/pages/transparency.js) depends on.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# Your real `baranguard`/`baranguard_uiseed` databases and backend/.env
# are never touched. Mirrors the other verify-*.sh scripts' conventions.
#
# Usage (from a Git Bash prompt):
#   bash backend/scripts/verify-public-transparency.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=$argv[1]; echo is_array($d) && array_key_exists($k,$d) ? (is_scalar($d[$k]) ? $d[$k] : json_encode($d[$k])) : "MISSING";' "$1"; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_transparency_check"
APP_USER="transchk_app"
APP_PASSWORD="TransChk!2026xx"
API_PORT="8133"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"

echo "Baranguard public transparency (H-13/L-03) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -f "$BACKEND_DIR/scripts/.transchk-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER'."
  echo "Your real databases and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (full migration chain) + accounts"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "0001 baseline applied" || fail "0001 apply failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" && pass "0002 barangays seeded" || fail "0002 seed failed"
for m in 0003_shift_schedule_nullable_user 0004_blotter_revision 0005_sms_envelope_replay \
         0006_sms_log_barangay 0007_retention_columns 0008_incident_party_fields \
         0009_blotter_case_status 0010_incident_location_description 0011_user_suspension \
         0012_system_settings 0013_sms_manual_send 0014_incident_display_id 0015_ai_tools \
         0016_retention_hold_and_device_scrub 0017_health_check_log 0018_sms_subscriber \
         0019_audit_log_idempotency_index 0020_health_check_log_ors 0021_ai_evaluation_run_generic_metrics \
         0022_auth_session_kind 0023_rate_limit_counter 0024_mobile_device_public_key; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain 0001-0023 applied"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

step "2. Seed a handful of incidents for barangay 1 (mixed types/statuses, within the report's 6-month window)"
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, incident_type, priority, status, location_description, created_at) VALUES
  (1, 'theft', 'normal', 'resolved', 'seed', UTC_TIMESTAMP()),
  (1, 'theft', 'normal', 'resolved', 'seed', UTC_TIMESTAMP()),
  (1, 'theft', 'normal', 'pending', 'seed', UTC_TIMESTAMP()),
  (1, 'theft', 'normal', 'pending', 'seed', UTC_TIMESTAMP()),
  (1, 'theft', 'normal', 'pending', 'seed', UTC_TIMESTAMP()),
  (1, 'fire', 'high', 'resolved', 'seed', UTC_TIMESTAMP()),
  (1, 'fire', 'high', 'pending', 'seed', UTC_TIMESTAMP());
SQL
pass "Seeded 7 incidents for barangay 1 (5 theft, 2 fire)"

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.transchk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2
curl -s -o /dev/null "${BASE_URL}/barangays" && pass "API is reachable" || { fail "API did not start"; exit 1; }

step "4. GET /public/transparency — no auth required"
RESP=$(curl -s -w "\n%{http_code}" "${BASE_URL}/public/transparency?barangay_id=1")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
expect_eq "$CODE" "200" "No Authorization header required"
expect_eq "$(echo "$BODY" | jget total_incidents)" "7" "total_incidents matches the seeded count"
expect_eq "$(echo "$BODY" | jget resolved_incidents)" "3" "resolved_incidents matches the seeded count"

step "5. Small categories are pooled (fire has only 2, under MIN_BUCKET=5)"
BY_TYPE=$(echo "$BODY" | jget by_type)
echo "$BY_TYPE" | grep -q '"type":"theft"' && pass "theft (5, at the floor) is reported on its own" || fail "theft category missing from by_type: $BY_TYPE"
echo "$BY_TYPE" | grep -q '"type":"fire"' && fail "fire (2, under the floor) should NOT appear on its own — leaked a small-cell category" || pass "fire (2, under the floor) does not appear as its own category"
echo "$BY_TYPE" | grep -q 'combined_small_categories' && pass "fire was pooled into combined_small_categories instead of dropped" || fail "no combined_small_categories bucket found: $BY_TYPE"

step "6. Unknown barangay_id -> 404, missing barangay_id -> 400"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/public/transparency?barangay_id=999")" "404" "Unknown barangay -> 404"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/public/transparency")" "400" "Missing barangay_id -> 400"

step "7. Code-review finding H-13: Cache-Control header is real, not decorative"
CACHE_HEADER=$(curl -s -D - -o /dev/null "${BASE_URL}/public/transparency?barangay_id=1" | grep -i "^Cache-Control:")
echo "$CACHE_HEADER" | grep -qi "max-age=300" && pass "Cache-Control: max-age matches the rate-limit window (300s)" || fail "Cache-Control header missing/wrong: '$CACHE_HEADER'"

step "8. Code-review finding H-13: per-IP rate limit actually triggers"
# RATE_LIMIT_MAX=30 per 300s (PublicReportsController.php). Barangay 2 is
# used here so this block's volume can't be confused with barangay 1's
# already-asserted counts above.
mysql_exec "$VALDB" -e "INSERT INTO barangay (barangay_id, name, municipality, province) SELECT 2, 'Test Barangay', 'Pilar', 'Sorsogon' WHERE NOT EXISTS (SELECT 1 FROM barangay WHERE barangay_id=2);" >/dev/null 2>&1
LAST_CODE=""
for i in $(seq 1 31); do
  LAST_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/public/transparency?barangay_id=2")
done
expect_eq "$LAST_CODE" "429" "The 31st request within the window is rate-limited"
# A fresh, never-before-seen barangay confirms the limiter is keyed by IP
# (shared across barangay_id values on this connection), not per-barangay —
# by design, since this protects against one caller hammering the endpoint
# regardless of which barangay they ask about.
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/public/transparency?barangay_id=1")" "429" "The same caller is still rate-limited even when asking about a DIFFERENT (already-passing) barangay"

echo
echo "==================== RESULT ===================="
echo "$PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ] || exit 1
