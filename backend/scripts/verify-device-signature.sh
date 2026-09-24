#!/usr/bin/env bash
# Baranguard — device signature (code-review finding H-09, 2026-09-24
# external audit): "X-Device-Id is an identifier, not strong proof of
# device authenticity." Proves the real fix end-to-end against a real
# HTTP server + real database: a device that registers a public key gets
# every signed request cryptographically verified (evidence upload/GPS/
# dispatch reject a bad/missing signature; SOS never rejects, only logs —
# see TanodSosController's own doc for why); a device with NO key on file
# is completely unaffected (phased rollout, not a hard cutover).
#
# No real Android device is used or needed here — an EC P-256 keypair
# generated with the `openssl` CLI stands in for the mobile app's
# Keystore key for the purpose of proving the SERVER-side verification
# logic is correct. The mobile-side Keystore plugin itself is
# code-complete but device-unverified this session (no phone attached) —
# see DEVLOG.md.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# Your real `baranguard`/`baranguard_uiseed` databases and backend/.env
# are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-device-signature.sh

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
VALDB="baranguard_devsig_check"
APP_USER="devsigchk_app"
APP_PASSWORD="DevSigChk!2026xx"
API_PORT="8137"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="DevSig#2026Pw"
KEY_DIR="$BACKEND_DIR/scripts/.devsigchk-keys"

echo "Baranguard device signature (H-09) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
OPENSSL_BIN="$(command -v openssl || true)"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }
[ -z "$OPENSSL_BIN" ] && { echo "ERROR: openssl CLI not found."; exit 1; }
echo "Using mysql:   $MYSQL_BIN"
echo "Using php:     $PHP_BIN ($($PHP_BIN -r 'echo PHP_VERSION;'))"
echo "Using openssl: $OPENSSL_BIN"

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=$argv[1]; echo is_array($d) && array_key_exists($k,$d) ? (is_scalar($d[$k]) ? $d[$k] : json_encode($d[$k])) : "MISSING";' "$1"; }

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$KEY_DIR"
  rm -f "$BACKEND_DIR/scripts/.devsigchk-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER', removed disposable keys."
  echo "Your real databases and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (full migration chain incl. 0024) + accounts"
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
pass "Full migration chain 0001-0024 applied"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 'devsig_tanod',  '$HASH', 'DevSig Tanod',  'tanod', 1, UTC_TIMESTAMP()),
  (1, 'devsig_tanod2', '$HASH', 'DevSig Tanod2', 'tanod', 1, UTC_TIMESTAMP());
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, status, location_description, created_at) VALUES
  (1, (SELECT user_id FROM user WHERE username='devsig_tanod'), 'theft', 'normal', 'pending', 'seed', UTC_TIMESTAMP()),
  (1, (SELECT user_id FROM user WHERE username='devsig_tanod2'), 'theft', 'normal', 'pending', 'seed', UTC_TIMESTAMP());
SQL
pass "Seeded 2 Tanods (barangay 1) + 2 incidents, each reported_by its own Tanod (so tanodMayAccess() allows evidence upload)"

gen_uuid() {
  "$PHP_BIN" -r 'echo bin2hex(random_bytes(16));' | "$PHP_BIN" -r '
    $h = trim(fgets(STDIN));
    echo substr($h,0,8)."-".substr($h,8,4)."-".substr($h,12,4)."-".substr($h,16,4)."-".substr($h,20,12);
  '
}

step "2. Two EC P-256 keypairs (stand in for two devices' Keystore keys — no phone needed to verify server logic)"
mkdir -p "$KEY_DIR"
KEY_DIR_WIN="$(cygpath -m "$KEY_DIR")"
"$OPENSSL_BIN" ecparam -name prime256v1 -genkey -noout -out "$KEY_DIR/device_a.key" 2>/dev/null
"$OPENSSL_BIN" ec -in "$KEY_DIR/device_a.key" -pubout -out "$KEY_DIR/device_a.pub" 2>/dev/null
"$OPENSSL_BIN" ecparam -name prime256v1 -genkey -noout -out "$KEY_DIR/device_wrong.key" 2>/dev/null
[ -s "$KEY_DIR/device_a.pub" ] && pass "Generated device A's EC keypair" || { fail "Could not generate keypair"; exit 1; }
DEVICE_A_PUB_PEM=$(cat "$KEY_DIR/device_a.pub")

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.devsigchk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
TANOD_TOKEN=$(login_as devsig_tanod)
TANOD2_TOKEN=$(login_as devsig_tanod2)
[ -n "$TANOD_TOKEN" ] && [ -n "$TANOD2_TOKEN" ] && pass "Logged in as both Tanods" || { fail "Login failed"; exit 1; }

INCIDENT_ID=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE reported_by=(SELECT user_id FROM user WHERE username='devsig_tanod') LIMIT 1;")
INCIDENT_ID_B=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE reported_by=(SELECT user_id FROM user WHERE username='devsig_tanod2') LIMIT 1;")

step "4. POST /devices/register — device A registers WITH a public key, device B WITHOUT (phased rollout)"
REG_A_BODY=$("$PHP_BIN" -r '
$pem = file_get_contents($argv[1]);
echo json_encode(["device_id" => "devsig-a-00000001", "platform" => "android", "device_public_key_pem" => $pem]);
' "$KEY_DIR/device_a.pub")
REG_A=$(curl -s -X POST "${BASE_URL}/devices/register" -H "Authorization: Bearer $TANOD_TOKEN" -H "Content-Type: application/json" -d "$REG_A_BODY")
expect_eq "$(echo "$REG_A" | jget registered)" "1" "Device A registered with a public key"
DB_KEY_STORED=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM mobile_device WHERE device_id='devsig-a-00000001' AND device_public_key_pem IS NOT NULL;")
expect_eq "$DB_KEY_STORED" "1" "device_public_key_pem actually persisted in the DB"

REG_B=$(curl -s -X POST "${BASE_URL}/devices/register" -H "Authorization: Bearer $TANOD2_TOKEN" -H "Content-Type: application/json" -d '{"device_id":"devsig-b-00000002","platform":"android"}')
expect_eq "$(echo "$REG_B" | jget registered)" "1" "Device B registered WITHOUT a public key (legacy/not-yet-upgraded device)"

step "5. POST /devices/register — a malformed key is rejected"
BAD_KEY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/devices/register" -H "Authorization: Bearer $TANOD_TOKEN" -H "Content-Type: application/json" -d '{"device_id":"devsig-a-00000001","platform":"android","device_public_key_pem":"not a real PEM key"}')
expect_eq "$BAD_KEY_STATUS" "400" "A malformed device_public_key_pem is rejected before it can ever be stored"

# --- Signing helper: METHOD\nPATH\nDEVICE_ID\nTIMESTAMP, SHA-256, base64 ---
sign_request() {
  local key_file="$1" method="$2" path="$3" device_id="$4" ts="$5"
  printf '%s\n%s\n%s\n%s' "$method" "$path" "$device_id" "$ts" \
    | "$OPENSSL_BIN" dgst -sha256 -sign "$key_file" \
    | base64 -w0
}

step "6. POST /incidents/:id/evidence — device A (has a key): valid signature succeeds, bad signature rejected"
TS=$(date +%s)
SIG=$(sign_request "$KEY_DIR/device_a.key" "POST" "/api/v1/incidents/$INCIDENT_ID/evidence" "devsig-a-00000001" "$TS")
# A tiny real JPEG (1x1 pixel), same fixture verify-evidence-upload.sh
# uses — required by the (unrelated) H-10 magic-byte check, plus its own
# required sha256/mime_type fields, so this test isolates the signature
# check under test from H-10's.
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9' > "$KEY_DIR/photo.jpg"
PHOTO_SHA256=$("$OPENSSL_BIN" dgst -sha256 "$KEY_DIR/photo.jpg" | awk '{print $NF}')
VALID_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/incidents/$INCIDENT_ID/evidence" \
  -H "Authorization: Bearer $TANOD_TOKEN" -H "X-Device-Id: devsig-a-00000001" \
  -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $SIG" \
  -F "type=photo" -F "sha256=$PHOTO_SHA256" -F "mime_type=image/jpeg" -F "client_request_id=$(gen_uuid)" -F "file=@$KEY_DIR_WIN/photo.jpg;type=image/jpeg")
expect_eq "$VALID_STATUS" "201" "A correctly-signed evidence upload from device A succeeds"

BAD_SIG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/incidents/$INCIDENT_ID/evidence" \
  -H "Authorization: Bearer $TANOD_TOKEN" -H "X-Device-Id: devsig-a-00000001" \
  -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: aW52YWxpZC1zaWduYXR1cmU=" \
  -F "type=photo" -F "sha256=$PHOTO_SHA256" -F "mime_type=image/jpeg" -F "client_request_id=$(gen_uuid)" -F "file=@$KEY_DIR_WIN/photo.jpg;type=image/jpeg")
expect_eq "$BAD_SIG_STATUS" "401" "A garbage signature from device A (which HAS a key on file) is rejected"

WRONG_KEY_SIG=$(sign_request "$KEY_DIR/device_wrong.key" "POST" "/api/v1/incidents/$INCIDENT_ID/evidence" "devsig-a-00000001" "$TS")
WRONG_KEY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/incidents/$INCIDENT_ID/evidence" \
  -H "Authorization: Bearer $TANOD_TOKEN" -H "X-Device-Id: devsig-a-00000001" \
  -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $WRONG_KEY_SIG" \
  -F "type=photo" -F "client_request_id=$(gen_uuid)" -F "file=@$KEY_DIR_WIN/photo.jpg;type=image/jpeg")
expect_eq "$WRONG_KEY_STATUS" "401" "A signature made with a DIFFERENT private key is rejected (proves real crypto verification, not a stub)"

OLD_TS=$(( $(date +%s) - 600 ))
STALE_SIG=$(sign_request "$KEY_DIR/device_a.key" "POST" "/api/v1/incidents/$INCIDENT_ID/evidence" "devsig-a-00000001" "$OLD_TS")
STALE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/incidents/$INCIDENT_ID/evidence" \
  -H "Authorization: Bearer $TANOD_TOKEN" -H "X-Device-Id: devsig-a-00000001" \
  -H "X-Device-Timestamp: $OLD_TS" -H "X-Device-Signature: $STALE_SIG" \
  -F "type=photo" -F "client_request_id=$(gen_uuid)" -F "file=@$KEY_DIR_WIN/photo.jpg;type=image/jpeg")
expect_eq "$STALE_STATUS" "401" "A correctly-signed but 10-minutes-old timestamp is rejected (replay window)"

step "7. POST /incidents/:id/evidence — device B (NO key on file) is completely unaffected (phased rollout)"
NO_KEY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/incidents/$INCIDENT_ID_B/evidence" \
  -H "Authorization: Bearer $TANOD2_TOKEN" -H "X-Device-Id: devsig-b-00000002" \
  -F "type=photo" -F "sha256=$PHOTO_SHA256" -F "mime_type=image/jpeg" -F "client_request_id=$(gen_uuid)" -F "file=@$KEY_DIR_WIN/photo.jpg;type=image/jpeg")
expect_eq "$NO_KEY_STATUS" "201" "A device with no key on file uploads with no signature headers at all — unchanged, pre-H-09 behavior"

step "8. POST /gps — same real/bad/absent-key behavior as evidence upload"
GPS_TS=$(date +%s)
GPS_SIG=$(sign_request "$KEY_DIR/device_a.key" "POST" "/api/v1/gps" "devsig-a-00000001" "$GPS_TS")
GPS_CID_1=$(gen_uuid)
GPS_OK=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/gps" -H "Authorization: Bearer $TANOD_TOKEN" -H "Content-Type: application/json" \
  -H "X-Device-Id: devsig-a-00000001" -H "X-Device-Timestamp: $GPS_TS" -H "X-Device-Signature: $GPS_SIG" \
  -d "{\"latitude\":12.92,\"longitude\":123.66,\"accuracy_m\":10,\"recorded_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"client_event_id\":\"$GPS_CID_1\"}")
expect_eq "$GPS_OK" "201" "A correctly-signed GPS post from device A succeeds"

GPS_CID_2=$(gen_uuid)
GPS_BAD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/gps" -H "Authorization: Bearer $TANOD_TOKEN" -H "Content-Type: application/json" \
  -H "X-Device-Id: devsig-a-00000001" -H "X-Device-Timestamp: $GPS_TS" -H "X-Device-Signature: aW52YWxpZA==" \
  -d "{\"latitude\":12.92,\"longitude\":123.66,\"client_event_id\":\"$GPS_CID_2\"}")
expect_eq "$GPS_BAD" "401" "A bad GPS signature from device A (which has a key) is rejected"

GPS_CID_3=$(gen_uuid)
GPS_NO_HEADER=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/gps" -H "Authorization: Bearer $TANOD2_TOKEN" -H "Content-Type: application/json" \
  -d "{\"latitude\":12.92,\"longitude\":123.66,\"accuracy_m\":10,\"recorded_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"client_event_id\":\"$GPS_CID_3\"}")
expect_eq "$GPS_NO_HEADER" "201" "GPS with no device headers at all (device B, no key) still works — unaffected"

step "9. POST /tanod-sos — NEVER rejected, even with a deliberately bad signature (safety-first, unlike every other check above)"
SOS_TS=$(date +%s)
SOS_CID=$(gen_uuid)
SOS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/tanod-sos" -H "Authorization: Bearer $TANOD_TOKEN" -H "Content-Type: application/json" \
  -H "X-Device-Id: devsig-a-00000001" -H "X-Device-Timestamp: $SOS_TS" -H "X-Device-Signature: dGhpcyBpcyBkZWZpbml0ZWx5IG5vdCBhIHZhbGlkIHNpZ25hdHVyZQ==" \
  -d "{\"latitude\":12.92,\"longitude\":123.66,\"client_event_id\":\"$SOS_CID\"}")
expect_eq "$SOS_STATUS" "201" "SOS with an INVALID signature is still ACCEPTED — a real emergency must never be dropped over a secondary check"
SOS_AUDIT_FLAG=$(mysql_exec -N -s "$VALDB" -e "SELECT JSON_EXTRACT(metadata_json, '\$.device_signature_verified') FROM audit_log WHERE action='tanod_sos_raised' ORDER BY audit_id DESC LIMIT 1;")
expect_eq "$SOS_AUDIT_FLAG" "false" "...but the failure IS recorded in the audit trail for operator visibility (device_signature_verified=false)"

echo
echo "==================== RESULT ===================="
echo "$PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ] || exit 1
