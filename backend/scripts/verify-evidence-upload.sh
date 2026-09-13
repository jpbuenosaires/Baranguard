#!/usr/bin/env bash
# Baranguard — evidence upload validation: POST /incidents/:id/evidence
# closes F4 (docs/REMAINING.md, docs/AUDIT_2026-09-07.md — "the schema is
# real, the upload endpoint is not"). Mobile Improvement Plan Phase 3.2.
#
# No existing verify suite calls this endpoint (it didn't exist before
# this session), so this script is the first proof it actually works
# end-to-end against a real HTTP server + real database, not just a
# `php -l` parse check.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-evidence-upload.sh

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
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_evidchk"
APP_USER="evidchk_app"
APP_PASSWORD="EvidChk!2026xx"
API_PORT="8129"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Evid#2026Pw"
EVIDENCE_DIR="$BACKEND_DIR/scripts/.evidchk-evidence"

echo "Baranguard evidence upload (F4) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -rf "$EVIDENCE_DIR"
  rm -f "$BACKEND_DIR/scripts/.evidchk-server.log" "/c/gtmp/.evidchk-photo.jpg"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER', removed the scratch evidence dir."
  echo "Your real 'baranguard' database and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (FULL migration chain) + accounts/incident/device"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in 0001_baseline_schema 0002_seed_barangays 0003_shift_schedule_nullable_user 0004_blotter_revision \
         0005_sms_envelope_replay 0006_sms_log_barangay 0007_retention_columns 0008_incident_party_fields \
         0009_blotter_case_status 0010_incident_location_description 0011_user_suspension 0012_system_settings \
         0013_sms_manual_send 0014_incident_display_id 0015_ai_tools \
         0016_retention_hold_and_device_scrub \
         0017_health_check_log \
         0018_sms_subscriber; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Migrations 0001-0018 applied"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, is_suspended, created_at) VALUES
  (1, 'evid_tanod',   '$HASH', 'Evidence Tanod',   'tanod', 1, 0, UTC_TIMESTAMP()),
  (1, 'evid_other',   '$HASH', 'Other Tanod',      'tanod', 1, 0, UTC_TIMESTAMP()),
  (1, 'evid_admin',   '$HASH', 'Evidence Admin',   'admin', 1, 0, UTC_TIMESTAMP());

INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES
  ('evid-device-owner', (SELECT user_id FROM user WHERE username='evid_tanod'), 'android', 'seeded-token', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP()),
  ('evid-device-other', (SELECT user_id FROM user WHERE username='evid_other'), 'android', 'seeded-token', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP()),
  ('evid-device-inactive', (SELECT user_id FROM user WHERE username='evid_tanod'), 'android', 'seeded-token', UTC_TIMESTAMP(), 0, UTC_TIMESTAMP());

INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
  (1, (SELECT user_id FROM user WHERE username='evid_tanod'), 'theft', 'normal', 'Evidence upload test fixture.', 'pending', 'app', UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
pass "Seeded 3 users (owning tanod, other tanod, admin), 3 devices (owner active, other active, owner's OWN device but inactive), 1 incident reported_by the owning tanod"

step "2. Start API (PHP built-in server, throwaway port, EVIDENCE_DIR pointed at a scratch dir)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
export EVIDENCE_DIR="$EVIDENCE_DIR"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.evidchk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
TOKEN_OWNER=$(login_as evid_tanod)
TOKEN_OTHER=$(login_as evid_other)
TOKEN_ADMIN=$(login_as evid_admin)
if [ -n "$TOKEN_OWNER" ] && [ -n "$TOKEN_OTHER" ] && [ -n "$TOKEN_ADMIN" ]; then
  pass "Logged in as owning tanod, other tanod, and admin (env override reached the disposable DB)"
else
  fail "A login failed — the API is probably talking to the REAL database (see this script's header)"
  exit 1
fi

INCIDENT_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident LIMIT 1;")

# A tiny real JPEG (1x1 pixel) rather than arbitrary bytes — the endpoint
# doesn't validate image structure server-side, but a real image is a more
# honest fixture than "hello world" for something documented as a photo.
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9' > "/c/gtmp/.evidchk-photo.jpg"
SHA256=$(openssl dgst -sha256 "/c/gtmp/.evidchk-photo.jpg" | awk '{print $NF}')
EXPECTED_BYTES=$(wc -c < "/c/gtmp/.evidchk-photo.jpg" | tr -d ' ')
REQ_ID_1=$("$PHP_BIN" -r 'echo bin2hex(random_bytes(16));' | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')

step "3. X-Device-Id header is required"
CODE_NO_DEVICE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/incidents/${INCIDENT_ID}/evidence" -X POST \
  -H "Authorization: Bearer $TOKEN_OWNER" \
  -F "file=@/c/gtmp/.evidchk-photo.jpg" \
  -F "type=photo" -F "sha256=$SHA256" -F "mime_type=image/jpeg" -F "client_request_id=$REQ_ID_1")
expect_eq "$CODE_NO_DEVICE" "400" "Missing X-Device-Id is rejected"

step "4. An inactive device is rejected (422)"
CODE_INACTIVE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/incidents/${INCIDENT_ID}/evidence" -X POST \
  -H "Authorization: Bearer $TOKEN_OWNER" -H "X-Device-Id: evid-device-inactive" \
  -F "file=@/c/gtmp/.evidchk-photo.jpg" \
  -F "type=photo" -F "sha256=$SHA256" -F "mime_type=image/jpeg" -F "client_request_id=$REQ_ID_1")
expect_eq "$CODE_INACTIVE" "422" "An inactive device is rejected"

step "5. A tanod with no ownership of the incident gets 404 (never 403 — Rule 2)"
CODE_WRONG_OWNER=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/incidents/${INCIDENT_ID}/evidence" -X POST \
  -H "Authorization: Bearer $TOKEN_OTHER" -H "X-Device-Id: evid-device-other" \
  -F "file=@/c/gtmp/.evidchk-photo.jpg" \
  -F "type=photo" -F "sha256=$SHA256" -F "mime_type=image/jpeg" -F "client_request_id=$REQ_ID_1")
expect_eq "$CODE_WRONG_OWNER" "404" "A tanod with no dispatch/report ownership of this incident is refused with 404, not 403"

step "6. Admin cannot upload — this endpoint is tanod-only (no capture flow to upload FROM)"
CODE_ADMIN=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/incidents/${INCIDENT_ID}/evidence" -X POST \
  -H "Authorization: Bearer $TOKEN_ADMIN" -H "X-Device-Id: evid-device-owner" \
  -F "file=@/c/gtmp/.evidchk-photo.jpg" \
  -F "type=photo" -F "sha256=$SHA256" -F "mime_type=image/jpeg" -F "client_request_id=$REQ_ID_1")
expect_eq "$CODE_ADMIN" "403" "Admin is refused (role check, not a tenant/ownership question)"

step "7. A checksum mismatch is rejected (integrity, not trusted blindly)"
BAD_SHA="0000000000000000000000000000000000000000000000000000000000000000"
BAD_SHA="${BAD_SHA:0:64}"
CODE_BAD_SHA=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/incidents/${INCIDENT_ID}/evidence" -X POST \
  -H "Authorization: Bearer $TOKEN_OWNER" -H "X-Device-Id: evid-device-owner" \
  -F "file=@/c/gtmp/.evidchk-photo.jpg" \
  -F "type=photo" -F "sha256=$BAD_SHA" -F "mime_type=image/jpeg" -F "client_request_id=$REQ_ID_1")
expect_eq "$CODE_BAD_SHA" "400" "A client-supplied sha256 that doesn't match the received bytes is rejected"

step "8. THE REAL UPLOAD: correct owner, correct device, correct checksum"
RESP_1=$(curl -s "${BASE_URL}/incidents/${INCIDENT_ID}/evidence" -X POST \
  -H "Authorization: Bearer $TOKEN_OWNER" -H "X-Device-Id: evid-device-owner" \
  -F "file=@/c/gtmp/.evidchk-photo.jpg" \
  -F "type=photo" -F "sha256=$SHA256" -F "mime_type=image/jpeg" -F "original_filename=patrol.jpg" -F "client_request_id=$REQ_ID_1")
ATTACHMENT_ID_1=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["attachment_id"] ?? "";' <<< "$RESP_1")
RESP_SHA_1=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["sha256"] ?? "";' <<< "$RESP_1")
if [ -n "$ATTACHMENT_ID_1" ]; then pass "Upload succeeded, attachment_id=$ATTACHMENT_ID_1"; else fail "Upload did not return an attachment_id — raw response: $RESP_1"; fi
expect_eq "$RESP_SHA_1" "$SHA256" "Server-computed sha256 in the response matches the real file hash"

step "9. The row and the FILE both really exist (not just an HTTP 201)"
DB_COUNT=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM evidence_attachment WHERE attachment_id = $ATTACHMENT_ID_1 AND incident_id = $INCIDENT_ID AND sha256 = '$SHA256' AND byte_size = $EXPECTED_BYTES;")
expect_eq "$DB_COUNT" "1" "evidence_attachment row exists with the right incident_id/sha256/byte_size"
FILE_COUNT=$(find "$EVIDENCE_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
expect_eq "$FILE_COUNT" "1" "Exactly one file landed in EVIDENCE_DIR (outside the web root, per §5)"

step "10. Idempotent retry — the SAME client_request_id returns the ORIGINAL row, not a second attachment"
RESP_2=$(curl -s "${BASE_URL}/incidents/${INCIDENT_ID}/evidence" -X POST \
  -H "Authorization: Bearer $TOKEN_OWNER" -H "X-Device-Id: evid-device-owner" \
  -F "file=@/c/gtmp/.evidchk-photo.jpg" \
  -F "type=photo" -F "sha256=$SHA256" -F "mime_type=image/jpeg" -F "client_request_id=$REQ_ID_1")
ATTACHMENT_ID_2=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["attachment_id"] ?? "";' <<< "$RESP_2")
expect_eq "$ATTACHMENT_ID_2" "$ATTACHMENT_ID_1" "Retry with the same client_request_id returns the SAME attachment_id"
ROW_COUNT_AFTER_RETRY=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM evidence_attachment WHERE incident_id = $INCIDENT_ID;")
expect_eq "$ROW_COUNT_AFTER_RETRY" "1" "The retry did NOT create a second row"
FILE_COUNT_AFTER_RETRY=$(find "$EVIDENCE_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
expect_eq "$FILE_COUNT_AFTER_RETRY" "1" "The retry did NOT write a second file either"

step "11. A DIFFERENT client_request_id for the same incident creates a genuinely new attachment"
REQ_ID_2="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(16));' | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')"
RESP_3=$(curl -s "${BASE_URL}/incidents/${INCIDENT_ID}/evidence" -X POST \
  -H "Authorization: Bearer $TOKEN_OWNER" -H "X-Device-Id: evid-device-owner" \
  -F "file=@/c/gtmp/.evidchk-photo.jpg" \
  -F "type=voice" -F "sha256=$SHA256" -F "mime_type=audio/aac" -F "client_request_id=$REQ_ID_2")
ATTACHMENT_ID_3=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["attachment_id"] ?? "";' <<< "$RESP_3")
if [ -n "$ATTACHMENT_ID_3" ] && [ "$ATTACHMENT_ID_3" != "$ATTACHMENT_ID_1" ]; then
  pass "A second, distinct client_request_id creates a genuinely new attachment (id=$ATTACHMENT_ID_3)"
else
  fail "Expected a new, different attachment_id — got '$ATTACHMENT_ID_3' vs first upload's '$ATTACHMENT_ID_1'"
fi

step "12. GET /incidents/:id/evidence now returns both real uploads"
GET_RESP=$(curl -s "${BASE_URL}/incidents/${INCIDENT_ID}/evidence" -H "Authorization: Bearer $TOKEN_OWNER")
GET_COUNT=$("$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["items"] ?? []);' <<< "$GET_RESP")
expect_eq "$GET_COUNT" "2" "GET /incidents/:id/evidence lists both uploaded attachments"

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
