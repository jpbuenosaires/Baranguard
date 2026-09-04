#!/usr/bin/env bash
# Baranguard — Sprint 2 backend: POST /devices/register,
# PATCH /devices/:id/deactivate, GET /map-packages/:barangay_id,
# GET /map-packages/:barangay_id/download.
#
# Safe to run: everything happens in a disposable database
# (baranguard_devices_check) with a disposable app-user, disposable test
# accounts, disposable package files, and a PHP dev server on a throwaway
# port. Your real `baranguard` database, real backend/.env, and Apache are
# never touched. Mirrors the prior verify-*.sh scripts' conventions.
#
# NOTE: this script deliberately does NOT pass `-d variables_order=EGPCS`
# to `php -S`. It relies on config/env.php honoring an exported env var
# over backend/.env — which is exactly the regression fixed on
# 2026-09-02. If that fix is ever reverted, this script's very first
# login will fail (it would be talking to the real database, where these
# test accounts don't exist), which is the intended early warning.
#
# Usage (from a Git Bash prompt):  bash backend/scripts/verify-devices-map-packages.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { # expect_eq <actual> <expected> <label>
  if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi
}

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_devices_check"
APP_USER="devchk_app"
APP_PASSWORD="DevChkDbPw!2026"
API_PORT="8120"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="DevChk#2026Pw"
PKG_DIR="$BACKEND_DIR/scripts/.devchk-packages"

echo "Baranguard Sprint 2 devices + map-packages validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -rf "$PKG_DIR"
  rm -f "$BACKEND_DIR/scripts/.devchk-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER', removed disposable package files."
  echo "Your real 'baranguard' database and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema + accounts"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "0001 baseline applied" || fail "0001 apply failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" && pass "0002 barangays seeded" || fail "0002 seed failed"
# 0007 adds mobile_device.deactivated_at, which DevicesController now
# writes on every deactivation (§11's 90-day device-retention clock).
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0007_retention_columns.sql" && pass "0007 applied" || fail "0007 failed"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'dev_admin',     '$HASH', 'Dev Admin',      'admin', 1, UTC_TIMESTAMP()),
  (1, 'dev_secretary', '$HASH', 'Dev Secretary',  'secretary', 1, UTC_TIMESTAMP()),
  (1, 'dev_tanod1',    '$HASH', 'Dev Tanod One',  'tanod', 1, UTC_TIMESTAMP()),
  (1, 'dev_tanod2',    '$HASH', 'Dev Tanod Two',  'tanod', 1, UTC_TIMESTAMP()),
  (2, 'dev_tanod_b2',  '$HASH', 'Dev Tanod B2',   'tanod', 1, UTC_TIMESTAMP());
SQL
pass "Seeded admin/secretary/tanod1/tanod2 (barangay 1) + tanod (barangay 2)"

step "2. Disposable map-package files"
mkdir -p "$PKG_DIR"
printf 'FAKE-MBTILES-CONTENT-FOR-TESTING-ONLY' > "$PKG_DIR/barangay1-v1.mbtiles"
# php.exe is a native Windows binary: it cannot stat a Git-Bash-style
# "/c/..." path, and MAP_PACKAGE_DIR is resolved with realpath() inside
# PHP. Convert to the mixed "C:/..." form (forward slashes, so it also
# stays safe inside single-quoted PHP strings) for anything PHP touches.
PKG_DIR_WIN="$(cygpath -m "$PKG_DIR")"
PKG_SHA=$("$PHP_BIN" -r "echo hash_file('sha256', '$PKG_DIR_WIN/barangay1-v1.mbtiles');")
PKG_SIZE=$("$PHP_BIN" -r "echo filesize('$PKG_DIR_WIN/barangay1-v1.mbtiles');")
echo "Package dir (windows form)=$PKG_DIR_WIN sha256=$PKG_SHA size=$PKG_SIZE"
if [ -z "$PKG_SHA" ] || [ -z "$PKG_SIZE" ]; then
  fail "Could not hash/stat the disposable package file — later map-package checks would cascade"
  exit 1
fi

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export MAP_PACKAGE_DIR="$PKG_DIR_WIN"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.devchk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as dev_admin)
SEC_TOKEN=$(login_as dev_secretary)
T1_TOKEN=$(login_as dev_tanod1)
T2_TOKEN=$(login_as dev_tanod2)
TB2_TOKEN=$(login_as dev_tanod_b2)
if [ -n "$ADMIN_TOKEN" ] && [ -n "$T1_TOKEN" ]; then
  pass "Logged in as admin/secretary/tanod1/tanod2/tanod-b2 (env override reached the disposable DB)"
else
  fail "Login failed — the API is probably talking to the REAL database (see this script's header note)"
  exit 1
fi

# helpers
status_of() { # status_of <method> <path> <token> [json-body]
  local method="$1" path="$2" token="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X "$method" "${BASE_URL}${path}" \
      -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$body"
  else
    curl -s -o /dev/null -w '%{http_code}' -X "$method" "${BASE_URL}${path}" -H "Authorization: Bearer $token"
  fi
}
body_of() { # body_of <method> <path> <token> [json-body]
  local method="$1" path="$2" token="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -s -X "$method" "${BASE_URL}${path}" -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$body"
  else
    curl -s -X "$method" "${BASE_URL}${path}" -H "Authorization: Bearer $token"
  fi
}
db_one() { mysql_exec -N -s "$VALDB" -e "$1"; }

# ============================================================
# POST /devices/register
# ============================================================
step "4. POST /devices/register — role gating and validation"
expect_eq "$(status_of POST /devices/register "$ADMIN_TOKEN" '{"device_id":"admin-device-001","fcm_token":"tok","platform":"android"}')" "403" "Admin cannot register a device"
expect_eq "$(status_of POST /devices/register "$SEC_TOKEN" '{"device_id":"sec-device-001","fcm_token":"tok","platform":"android"}')" "403" "Secretary cannot register a device"
expect_eq "$(status_of POST /devices/register "$T1_TOKEN" '{"device_id":"short","fcm_token":"tok","platform":"android"}')" "400" "device_id shorter than 8 chars rejected"
expect_eq "$(status_of POST /devices/register "$T1_TOKEN" '{"device_id":"tanod1-device-aaa","fcm_token":"tok","platform":"ios"}')" "400" "platform other than android rejected"
expect_eq "$(status_of POST /devices/register "$T1_TOKEN" '{"device_id":"tanod1-device-aaa","platform":"android"}')" "400" "missing fcm_token rejected"
# POST /devices/register has a FIXED path — device_id travels in the body,
# so an illegal id is a controller validation error (400), not a routing
# miss. Only the PATCH route, which carries the id in the URL, can 404 on
# a malformed id (checked in step 9).
expect_eq "$(status_of POST /devices/register "$T1_TOKEN" '{"device_id":"bad device id!","fcm_token":"tok","platform":"android"}')" "400" "device_id with illegal characters rejected by validation"

step "5. POST /devices/register — happy path"
REG=$(body_of POST /devices/register "$T1_TOKEN" '{"device_id":"tanod1-device-aaa","fcm_token":"fcm-token-one","platform":"android","app_version":"1.0.0"}')
echo "  response: $REG"
expect_eq "$(echo "$REG" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["registered"] ? "true":"false";')" "true" "registered:true returned"
expect_eq "$(echo "$REG" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["device_id"] ?? "";')" "tanod1-device-aaa" "device_id echoed back"
if echo "$REG" | grep -qi "fcm"; then fail "Response leaked an FCM token/field (§6: returns no FCM token)"; else pass "Response contains no FCM token (§6)"; fi
expect_eq "$(db_one "SELECT is_active FROM mobile_device WHERE device_id='tanod1-device-aaa';")" "1" "Device row is active in DB"
expect_eq "$(db_one "SELECT fcm_token FROM mobile_device WHERE device_id='tanod1-device-aaa';")" "fcm-token-one" "fcm_token stored server-side"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='device_registered';")" "1" "audit_log has one device_registered row"
if db_one "SELECT metadata_json FROM audit_log WHERE action='device_registered';" | grep -qi "fcm-token-one"; then
  fail "Audit metadata leaked the FCM token (§2 Rule 17)"
else
  pass "Audit metadata contains no FCM token (§2 Rule 17)"
fi

step "6. Registering a SECOND device deactivates the Tanod's previous one (§6)"
body_of POST /devices/register "$T1_TOKEN" '{"device_id":"tanod1-device-bbb","fcm_token":"fcm-token-two","platform":"android"}' >/dev/null
expect_eq "$(db_one "SELECT is_active FROM mobile_device WHERE device_id='tanod1-device-aaa';")" "0" "Previous device deactivated"
expect_eq "$(db_one "SELECT is_active FROM mobile_device WHERE device_id='tanod1-device-bbb';")" "1" "New device active"

step "7. Re-registering the SAME device is a token refresh, not a conflict"
expect_eq "$(status_of POST /devices/register "$T1_TOKEN" '{"device_id":"tanod1-device-bbb","fcm_token":"fcm-token-refreshed","platform":"android","app_version":"1.1.0"}')" "200" "Re-register same device returns 200"
expect_eq "$(db_one "SELECT fcm_token FROM mobile_device WHERE device_id='tanod1-device-bbb';")" "fcm-token-refreshed" "fcm_token refreshed"
expect_eq "$(db_one "SELECT app_version FROM mobile_device WHERE device_id='tanod1-device-bbb';")" "1.1.0" "app_version refreshed"
expect_eq "$(db_one "SELECT is_active FROM mobile_device WHERE device_id='tanod1-device-bbb';")" "1" "Device did NOT deactivate itself during its own refresh"

step "8. A device owned by another Tanod cannot be hijacked (§6 ownership validation)"
expect_eq "$(status_of POST /devices/register "$T2_TOKEN" '{"device_id":"tanod1-device-bbb","fcm_token":"attacker","platform":"android"}')" "409" "Registering another Tanod's device is rejected"
expect_eq "$(db_one "SELECT user_id FROM mobile_device WHERE device_id='tanod1-device-bbb';")" "$(db_one "SELECT user_id FROM user WHERE username='dev_tanod1';")" "Device still belongs to the original owner"
expect_eq "$(db_one "SELECT fcm_token FROM mobile_device WHERE device_id='tanod1-device-bbb';")" "fcm-token-refreshed" "Attacker's fcm_token was NOT written"

# ============================================================
# PATCH /devices/:id/deactivate
# ============================================================
step "9. PATCH /devices/:id/deactivate"
expect_eq "$(status_of PATCH /devices/tanod1-device-bbb/deactivate "$ADMIN_TOKEN")" "403" "Admin cannot use the Tanod device-deactivate endpoint"
expect_eq "$(status_of PATCH /devices/tanod1-device-bbb/deactivate "$T2_TOKEN")" "404" "Another Tanod's device returns 404 (existence not leaked)"
expect_eq "$(db_one "SELECT is_active FROM mobile_device WHERE device_id='tanod1-device-bbb';")" "1" "That device is still active after the rejected attempt"
expect_eq "$(status_of PATCH /devices/does-not-exist-xyz/deactivate "$T1_TOKEN")" "404" "Unknown device returns 404"
# Here the id IS in the URL, so a malformed one is a routing miss — and it
# must still be a 404, never a 400 that would confirm the route exists.
expect_eq "$(status_of PATCH "/devices/bad%20id/deactivate" "$T1_TOKEN")" "404" "Malformed device id in the URL is a route miss (404)"
expect_eq "$(status_of PATCH /devices/tanod1-device-bbb/deactivate "$T1_TOKEN")" "200" "Own device deactivates"
expect_eq "$(db_one "SELECT is_active FROM mobile_device WHERE device_id='tanod1-device-bbb';")" "0" "Device is inactive in DB"
expect_eq "$(status_of PATCH /devices/tanod1-device-bbb/deactivate "$T1_TOKEN")" "200" "Second deactivate is idempotent (200)"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='device_deactivated';")" "1" "Idempotent repeat did NOT write a second audit row"

# ============================================================
# GET /map-packages/:barangay_id
# ============================================================
step "10. GET /map-packages/:barangay_id — before any package is published"
expect_eq "$(status_of GET /map-packages/1 "$T1_TOKEN")" "404" "No published package yet -> 404 (M1 must treat this as non-fatal)"

step "11. Publish a package, then read its metadata"
ADMIN_ID=$(db_one "SELECT user_id FROM user WHERE username='dev_admin';")
mysql_exec "$VALDB" <<SQL
INSERT INTO offline_map_package (barangay_id, version, file_path, checksum_sha256, byte_size, created_by, created_at, is_published)
VALUES (1, '2026.09.01', 'barangay1-v1.mbtiles', '$PKG_SHA', $PKG_SIZE, $ADMIN_ID, UTC_TIMESTAMP(), 1);
SQL
META=$(body_of GET /map-packages/1 "$T1_TOKEN")
echo "  response: $META"
expect_eq "$(echo "$META" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["version"] ?? "";')" "2026.09.01" "version returned"
expect_eq "$(echo "$META" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["checksum_sha256"] ?? "";')" "$PKG_SHA" "checksum_sha256 matches the real file hash"
expect_eq "$(echo "$META" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["is_published"] ? "true":"false";')" "true" "is_published true"
expect_eq "$(echo "$META" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["download_url"] ?? "";')" "/map-packages/1/download" "download_url returned"

step "12. Metadata role + tenant gating (§6: Admin or Tanod, own barangay only)"
expect_eq "$(status_of GET /map-packages/1 "$ADMIN_TOKEN")" "200" "Admin may read map-package metadata"
expect_eq "$(status_of GET /map-packages/1 "$SEC_TOKEN")" "403" "Secretary cannot read map-package metadata"
expect_eq "$(status_of GET /map-packages/1 "$TB2_TOKEN")" "404" "Barangay-2 Tanod cannot read barangay 1's package (tenant isolation)"
expect_eq "$(status_of GET /map-packages/2 "$T1_TOKEN")" "404" "Barangay-1 Tanod cannot read barangay 2's package (tenant isolation)"

# ============================================================
# GET /map-packages/:barangay_id/download
# ============================================================
step "13. GET /map-packages/:barangay_id/download"
expect_eq "$(status_of GET /map-packages/1/download "$ADMIN_TOKEN")" "403" "Admin cannot download (§6: Tanod only)"
expect_eq "$(status_of GET /map-packages/1/download "$TB2_TOKEN")" "404" "Cross-tenant download rejected"

DL_HEADERS=$(curl -s -D - -o "$PKG_DIR/downloaded.bin" "${BASE_URL}/map-packages/1/download" -H "Authorization: Bearer $T1_TOKEN")
DL_SHA=$("$PHP_BIN" -r "echo hash_file('sha256', '$PKG_DIR_WIN/downloaded.bin');")
expect_eq "$DL_SHA" "$PKG_SHA" "Downloaded bytes hash to the same SHA-256 as the source file"
HDR_SHA=$(echo "$DL_HEADERS" | tr -d '\r' | grep -i '^X-Checksum-SHA256:' | awk '{print $2}')
expect_eq "$HDR_SHA" "$PKG_SHA" "X-Checksum-SHA256 header matches (§6: client verifies before activation)"

step "14. An unpublished package is never served"
mysql_exec "$VALDB" -e "UPDATE offline_map_package SET is_published = 0 WHERE barangay_id = 1;"
expect_eq "$(status_of GET /map-packages/1 "$T1_TOKEN")" "404" "Unpublished package is not exposed via metadata"
expect_eq "$(status_of GET /map-packages/1/download "$T1_TOKEN")" "404" "Unpublished package cannot be downloaded"

step "15. Path-traversal containment (a hostile file_path row must not read arbitrary files)"
mysql_exec "$VALDB" -e "UPDATE offline_map_package SET file_path = '../../.env', is_published = 1 WHERE barangay_id = 1;"
TRAV_STATUS=$(status_of GET /map-packages/1/download "$T1_TOKEN")
expect_eq "$TRAV_STATUS" "503" "file_path escaping MAP_PACKAGE_DIR is refused (503), not served"
TRAV_BODY=$(body_of GET /map-packages/1/download "$T1_TOKEN")
if echo "$TRAV_BODY" | grep -qi "DB_PASSWORD\|JWT_SECRET"; then
  fail "CRITICAL: traversal returned real .env contents"
else
  pass "Traversal response contains no .env contents"
fi

echo
echo "==================== RESULT ===================="
echo "$PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ] || exit 1
