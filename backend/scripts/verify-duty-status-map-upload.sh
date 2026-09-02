#!/usr/bin/env bash
# Baranguard — Sprint 2 backend follow-up: POST /duty-status (M2 Home's
# duty toggle) and POST /map-packages (Admin upload).
#
# Safe to run: everything happens in a disposable database
# (baranguard_duty_map_check) with a disposable app-user, disposable test
# accounts, disposable package files, and a PHP dev server on a throwaway
# port. Your real `baranguard` database, real backend/.env, and Apache are
# never touched. Mirrors the prior verify-*.sh scripts' conventions.
#
# NOTE: this script deliberately does NOT pass `-d variables_order=EGPCS`
# to `php -S`, relying on config/env.php honoring an exported env var over
# backend/.env (the fix from the 2026-09-02 regression) as an early
# warning canary — see verify-devices-map-packages.sh's header for detail.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-duty-status-map-upload.sh

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
VALDB="baranguard_duty_map_check"
APP_USER="dutymapchk_app"
APP_PASSWORD="DutyMapChk!2026"
API_PORT="8121"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="DutyMap#2026Pw"
PKG_DIR="$BACKEND_DIR/scripts/.dutymapchk-packages"

echo "Baranguard duty-status + map-package-upload validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -f "$BACKEND_DIR/scripts/.dutymapchk-server.log"
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
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'dmchk_admin',  '$HASH', 'DM Check Admin',  'admin', 1, UTC_TIMESTAMP()),
  (1, 'dmchk_tanod1', '$HASH', 'DM Check Tanod1', 'tanod', 1, UTC_TIMESTAMP()),
  (2, 'dmchk_admin2', '$HASH', 'DM Check Admin2', 'admin', 1, UTC_TIMESTAMP());
SQL
pass "Seeded admin/tanod (barangay 1) + admin (barangay 2)"

step "2. Disposable MBTiles-like fixture files"
mkdir -p "$PKG_DIR"
PKG_DIR_WIN="$(cygpath -m "$PKG_DIR")"
# A real MBTiles file is a SQLite database with 'tiles'/'metadata' tables —
# build a minimal but STRUCTURALLY VALID one with PHP's own pdo_sqlite
# (which the controller itself uses) rather than faking bytes by hand.
"$PHP_BIN" -r "
\$db = new PDO('sqlite:$PKG_DIR_WIN/valid.mbtiles');
\$db->exec('CREATE TABLE metadata (name TEXT, value TEXT)');
\$db->exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)');
\$db->exec(\"INSERT INTO metadata VALUES ('name','baranguard-test')\");
"
[ -s "$PKG_DIR/valid.mbtiles" ] && pass "Built a structurally valid MBTiles fixture" || { fail "Could not build MBTiles fixture"; exit 1; }
printf 'this is definitely not a sqlite file, just garbage bytes' > "$PKG_DIR/garbage.mbtiles"
# Oversize fixture stays small on disk via a sparse-ish approach: not
# needed here since MAX_BYTES (500MB) would be slow to actually generate
# in a test — that ceiling is asserted by code review, not by upload.

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export MAP_PACKAGE_DIR="$PKG_DIR_WIN"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.dutymapchk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as dmchk_admin)
T1_TOKEN=$(login_as dmchk_tanod1)
ADMIN2_TOKEN=$(login_as dmchk_admin2)
if [ -n "$ADMIN_TOKEN" ] && [ -n "$T1_TOKEN" ]; then
  pass "Logged in as admin/tanod1/admin2 (env override reached the disposable DB)"
else
  fail "Login failed — the API is probably talking to the REAL database (see this script's header note)"
  exit 1
fi

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
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "";'; }
db_one() { mysql_exec -N -s "$VALDB" -e "$1"; }
uuidgen_php() { "$PHP_BIN" -r "echo sprintf('%s-%s-%s-%s-%s', bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), bin2hex(random_bytes(2)), bin2hex(random_bytes(2)), bin2hex(random_bytes(6)));"; }

# ============================================================
# POST /duty-status
# ============================================================
step "4. POST /duty-status — role gating and validation"
expect_eq "$(status_of POST /duty-status "$ADMIN_TOKEN" "{\"status\":\"on_duty\",\"client_event_id\":\"$(uuidgen_php)\"}")" "403" "Admin cannot toggle duty status"
expect_eq "$(status_of POST /duty-status "$T1_TOKEN" "{\"status\":\"asleep\",\"client_event_id\":\"$(uuidgen_php)\"}")" "400" "Invalid status value rejected"
expect_eq "$(status_of POST /duty-status "$T1_TOKEN" '{"status":"on_duty"}')" "400" "Missing client_event_id rejected"
expect_eq "$(status_of POST /duty-status "$T1_TOKEN" '{"status":"on_duty","client_event_id":"not-a-uuid"}')" "400" "Malformed client_event_id rejected"

step "5. POST /duty-status — happy path + response shape"
CEID1=$(uuidgen_php)
DS1=$(body_of POST /duty-status "$T1_TOKEN" "{\"status\":\"on_duty\",\"client_event_id\":\"$CEID1\"}")
echo "  response: $DS1"
expect_eq "$(echo "$DS1" | jget status)" "on_duty" "status echoed back"
expect_eq "$(echo "$DS1" | jget channel)" "app" "channel is 'app' (server-derived, per §6)"
STATUS_ID1=$(echo "$DS1" | jget status_id)
[ -n "$STATUS_ID1" ] && pass "status_id present in response" || fail "status_id missing"
expect_eq "$(db_one "SELECT status FROM duty_status WHERE client_event_id='$CEID1';")" "on_duty" "Row persisted in DB with correct status"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='duty_status_changed';")" "1" "audit_log has one duty_status_changed row"

step "6. POST /duty-status — idempotent retry on the same client_event_id"
DS1_RETRY=$(body_of POST /duty-status "$T1_TOKEN" "{\"status\":\"on_duty\",\"client_event_id\":\"$CEID1\"}")
expect_eq "$(echo "$DS1_RETRY" | jget status_id)" "$STATUS_ID1" "Retry returns the SAME status_id, not a new one"
expect_eq "$(db_one "SELECT COUNT(*) FROM duty_status WHERE client_event_id='$CEID1';")" "1" "Exactly one DB row exists for that client_event_id (verified in DB, not just the response)"

step "7. A second real toggle (different client_event_id) creates a new row"
CEID2=$(uuidgen_php)
DS2=$(body_of POST /duty-status "$T1_TOKEN" "{\"status\":\"off_duty\",\"client_event_id\":\"$CEID2\"}")
expect_eq "$(echo "$DS2" | jget status)" "off_duty" "Second toggle records off_duty"
expect_eq "$(db_one "SELECT COUNT(*) FROM duty_status WHERE user_id=(SELECT user_id FROM user WHERE username='dmchk_tanod1');")" "2" "Tanod now has exactly 2 duty_status rows total"

step "8. GET /duty-status?user_id=me reflects both entries, current status latest"
CURRENT=$(body_of GET "/duty-status?barangay_id=1" "$ADMIN_TOKEN")
echo "  current-by-barangay: $CURRENT"
if echo "$CURRENT" | grep -q '"status":"off_duty"'; then pass "Admin's current-status view shows the latest toggle (off_duty)"; else fail "Current-status view did not reflect the latest toggle"; fi

# ============================================================
# POST /map-packages
# ============================================================
step "9. POST /map-packages — role gating"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/map-packages" -H "Authorization: Bearer $T1_TOKEN" -F "version=1.0.0" -F "file=@${PKG_DIR}/valid.mbtiles")" "403" "Tanod cannot upload a map package"

step "10. POST /map-packages — validation"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/map-packages" -H "Authorization: Bearer $ADMIN_TOKEN" -F "file=@${PKG_DIR}/valid.mbtiles")" "400" "Missing version rejected"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/map-packages" -H "Authorization: Bearer $ADMIN_TOKEN" -F "version=bad version!" -F "file=@${PKG_DIR}/valid.mbtiles")" "400" "Illegal characters in version rejected"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/map-packages" -H "Authorization: Bearer $ADMIN_TOKEN" -F "version=1.0.0")" "400" "Missing file rejected"
GARBAGE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/map-packages" -H "Authorization: Bearer $ADMIN_TOKEN" -F "version=1.0.0" -F "file=@${PKG_DIR}/garbage.mbtiles")
expect_eq "$GARBAGE_STATUS" "400" "Non-SQLite garbage file rejected by structure validation"

step "11. POST /map-packages — happy path"
UPLOAD=$(curl -s -X POST "${BASE_URL}/map-packages" -H "Authorization: Bearer $ADMIN_TOKEN" -F "version=2026.09.03" -F "file=@${PKG_DIR}/valid.mbtiles")
echo "  response: $UPLOAD"
expect_eq "$(echo "$UPLOAD" | jget version)" "2026.09.03" "version echoed back"
expect_eq "$(echo "$UPLOAD" | jget is_published)" "1" "is_published true"
REAL_SHA=$("$PHP_BIN" -r "echo hash_file('sha256', '$PKG_DIR_WIN/valid.mbtiles');")
expect_eq "$(echo "$UPLOAD" | jget checksum_sha256)" "$REAL_SHA" "checksum_sha256 matches the real uploaded file's hash"
PKG_ID=$(echo "$UPLOAD" | jget package_id)
expect_eq "$(db_one "SELECT is_published FROM offline_map_package WHERE package_id=$PKG_ID;")" "1" "DB row is_published=1 (verified in DB)"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='map_package_published';")" "1" "audit_log has one map_package_published row"
# The file must actually have been moved into permanent storage, not left
# only as the (now-deleted) PHP upload tmp file.
STORED_PATH=$(db_one "SELECT file_path FROM offline_map_package WHERE package_id=$PKG_ID;")
[ -f "$PKG_DIR/$STORED_PATH" ] && pass "Uploaded bytes actually landed on disk under MAP_PACKAGE_DIR" || fail "Stored file_path does not exist on disk"

step "12. Uploading a duplicate (barangay,version) is rejected"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/map-packages" -H "Authorization: Bearer $ADMIN_TOKEN" -F "version=2026.09.03" -F "file=@${PKG_DIR}/valid.mbtiles")" "409" "Duplicate (barangay,version) rejected with 409"

step "13. Publishing a NEW version unpublishes the previous one — 'exactly one published' (§5)"
UPLOAD2=$(curl -s -X POST "${BASE_URL}/map-packages" -H "Authorization: Bearer $ADMIN_TOKEN" -F "version=2026.09.04" -F "file=@${PKG_DIR}/valid.mbtiles")
PKG_ID2=$(echo "$UPLOAD2" | jget package_id)
expect_eq "$(db_one "SELECT is_published FROM offline_map_package WHERE package_id=$PKG_ID2;")" "1" "New package is published"
expect_eq "$(db_one "SELECT is_published FROM offline_map_package WHERE package_id=$PKG_ID;")" "0" "Previous package for the same barangay was automatically unpublished"
expect_eq "$(db_one "SELECT COUNT(*) FROM offline_map_package WHERE barangay_id=1 AND is_published=1;")" "1" "Exactly one published row remains for this barangay"

step "14. Newly published package is immediately servable via the existing GET endpoints"
META=$(body_of GET /map-packages/1 "$T1_TOKEN")
expect_eq "$(echo "$META" | jget version)" "2026.09.04" "GET metadata reflects the newly-published version"
DL_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/map-packages/1/download" -H "Authorization: Bearer $T1_TOKEN")
expect_eq "$DL_STATUS" "200" "Newly-published package downloads successfully"

step "15. Cross-tenant: barangay-2 admin uploads to their own barangay only"
UPLOAD_B2=$(curl -s -X POST "${BASE_URL}/map-packages" -H "Authorization: Bearer $ADMIN2_TOKEN" -F "version=2026.09.03" -F "file=@${PKG_DIR}/valid.mbtiles")
expect_eq "$(echo "$UPLOAD_B2" | jget is_published)" "1" "Barangay-2 admin can publish (their own tenant)"
B2_PKG_ID=$(echo "$UPLOAD_B2" | jget package_id)
expect_eq "$(db_one "SELECT barangay_id FROM offline_map_package WHERE package_id=$B2_PKG_ID;")" "2" "Uploaded package is scoped to the uploader's own barangay_id, not client-supplied"
expect_eq "$(db_one "SELECT is_published FROM offline_map_package WHERE package_id=$PKG_ID2;")" "1" "Barangay-1's published package is untouched by barangay-2's publish"

echo
echo "==================== RESULT ===================="
echo "$PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ] || exit 1
