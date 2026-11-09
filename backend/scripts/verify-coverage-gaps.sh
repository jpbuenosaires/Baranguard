#!/usr/bin/env bash
# Baranguard — closes the route gaps found by verify-route-coverage.php
# (2026-10-29): three routes no suite ever called, and one method never sent.
#
#   GET    /incidents/:id/evidence/:attachmentId/download
#   GET    /reports/digest
#   GET    /reports/digest/download
#   DELETE /shift-swap-requests/:id
#
# Each is checked for the happy path AND its guards: role, barangay (a
# cross-tenant request is 404, never 403 — Rule 2), ownership, state, the
# bytes served, and the audit row (identifiers only — Rule 8).
#
# Safe to run: disposable database, disposable app user, throwaway port and
# scratch storage directories. The real databases and backend/.env are
# never touched.
#
# Usage (Git Bash): bash backend/scripts/verify-coverage-gaps.sh

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
VALDB="baranguard_gapchk"
APP_USER="gapchk_app"
APP_PASSWORD="GapChk!2026xx"
API_PORT="8141"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Gap#2026Pw"
SCRATCH="$BACKEND_DIR/scripts/.gapchk"
SECRET_NARRATIVE="GAPCHK-NARRATIVE-must-never-leave-the-incident-row"

echo "Baranguard coverage-gap validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  for candidate in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"
PHP_BIN="$(find_bin php)"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
db_one() { mysql_exec -N -s "$VALDB" -e "$1"; }
uuid() { "$PHP_BIN" -r 'echo bin2hex(random_bytes(16));' | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/'; }
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $v=$d[$argv[1]] ?? ""; echo is_bool($v) ? ($v ? "true" : "false") : $v;' "$1"; }
code_of() { # METHOD URL TOKEN [JSON]
  local args=(-s -o /dev/null -w '%{http_code}' -X "$1" "$2")
  [ -n "${3:-}" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "${4:-}" ] && args+=(-H "Content-Type: application/json" -d "$4")
  curl "${args[@]}"
}

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  . "$(dirname "$0")/lib/stop-php-server.sh" && stop_php_server "${API_PORT}"
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$SCRATCH"
  echo "Stopped the test server, dropped $VALDB / '$APP_USER', removed $SCRATCH."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (FULL migration chain) and fixtures"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain applied"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, is_suspended, created_at) VALUES
  (1, 'gap_owner', '$HASH', 'Gap Owner Tanod', 'tanod', 1, 0, UTC_TIMESTAMP()),
  (1, 'gap_other', '$HASH', 'Gap Other Tanod', 'tanod', 1, 0, UTC_TIMESTAMP()),
  (1, 'gap_admin', '$HASH', 'Gap Admin', 'admin', 1, 0, UTC_TIMESTAMP()),
  (1, 'gap_sec',   '$HASH', 'Gap Secretary', 'secretary', 1, 0, UTC_TIMESTAMP()),
  (1, 'gap_pb',    '$HASH', 'Gap Punong Barangay', 'punong_barangay', 1, 0, UTC_TIMESTAMP()),
  (2, 'gap_admin2','$HASH', 'Gap Admin B2', 'admin', 1, 0, UTC_TIMESTAMP()),
  (2, 'gap_pb2',   '$HASH', 'Gap PB B2', 'punong_barangay', 1, 0, UTC_TIMESTAMP()),
  (2, 'gap_tanod2','$HASH', 'Gap Tanod B2', 'tanod', 1, 0, UTC_TIMESTAMP());
INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES
  ('gap-device-owner', (SELECT user_id FROM user WHERE username='gap_owner'), 'android', 'seeded-token', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
  (1, (SELECT user_id FROM user WHERE username='gap_owner'), 'theft', 'normal', '$SECRET_NARRATIVE', 'pending', 'app', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, (SELECT user_id FROM user WHERE username='gap_owner'), 'noise', 'normal', 'Second incident.', 'pending', 'app', UTC_TIMESTAMP(), UTC_TIMESTAMP());
INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, client_request_id, approval_status) VALUES
  (1, (SELECT user_id FROM user WHERE username='gap_owner'), 'Zone 1', UTC_TIMESTAMP() + INTERVAL 2 DAY, UTC_TIMESTAMP() + INTERVAL 2 DAY + INTERVAL 8 HOUR, (SELECT user_id FROM user WHERE username='gap_admin'), 'gapchk-shift-a-000000000000000000000000', 'published'),
  (1, (SELECT user_id FROM user WHERE username='gap_owner'), 'Zone 2', UTC_TIMESTAMP() + INTERVAL 3 DAY, UTC_TIMESTAMP() + INTERVAL 3 DAY + INTERVAL 8 HOUR, (SELECT user_id FROM user WHERE username='gap_admin'), 'gapchk-shift-b-000000000000000000000000', 'published');
SQL
pass "Seeded barangay-1 tanods/admin/secretary/PB, barangay-2 admin/PB/tanod, a device, 2 incidents, 2 published shifts"
INC1=$(db_one "SELECT MIN(incident_id) FROM incident;")
INC2=$(db_one "SELECT MAX(incident_id) FROM incident;")
SHIFT_A=$(db_one "SELECT shift_id FROM shift_schedule WHERE patrol_zone='Zone 1';")
SHIFT_B=$(db_one "SELECT shift_id FROM shift_schedule WHERE patrol_zone='Zone 2';")

step "2. Start the API (throwaway port, scratch evidence and report directories)"
mkdir -p "$SCRATCH/evidence" "$SCRATCH/reports"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30 CORS_ALLOWED_ORIGIN='*'
export EVIDENCE_DIR="$SCRATCH/evidence" REPORT_EXPORT_DIR="$SCRATCH/reports"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$SCRATCH/server.log" 2>&1 &
SERVER_PID=$!
sleep 2
login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | jget token
}
T_OWNER=$(login_as gap_owner); T_OTHER=$(login_as gap_other); T_ADMIN=$(login_as gap_admin); T_SEC=$(login_as gap_sec)
T_PB=$(login_as gap_pb); T_ADMIN2=$(login_as gap_admin2); T_PB2=$(login_as gap_pb2); T_TANOD2=$(login_as gap_tanod2)
if [ -n "$T_OWNER" ] && [ -n "$T_OTHER" ] && [ -n "$T_ADMIN" ] && [ -n "$T_SEC" ] && [ -n "$T_PB" ] && [ -n "$T_ADMIN2" ] && [ -n "$T_PB2" ] && [ -n "$T_TANOD2" ]; then
  pass "All 8 test accounts logged in against the disposable database"
else
  fail "A login failed — stopping"; exit 1
fi

# ---------------------------------------------------------------------------
step "3. Evidence download: GET /incidents/:id/evidence/:attachmentId/download"
PHOTO="$SCRATCH/photo.jpg"
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00GAPCHK\xff\xd9' > "$PHOTO"
SHA=$(openssl dgst -sha256 "$PHOTO" | awk '{print $NF}')
UP=$(curl -s "${BASE_URL}/incidents/${INC1}/evidence" -X POST -H "Authorization: Bearer $T_OWNER" -H "X-Device-Id: gap-device-owner" \
  -F "file=@$PHOTO" -F "type=photo" -F "sha256=$SHA" -F "mime_type=image/jpeg" -F "original_filename=scene.jpg" -F "client_request_id=$(uuid)")
ATT=$(echo "$UP" | jget attachment_id)
[ -n "$ATT" ] && pass "Fixture photo uploaded by the owning tanod (attachment $ATT)" || { fail "Upload failed: $UP"; exit 1; }
DL="${BASE_URL}/incidents/${INC1}/evidence/${ATT}/download"

for who in OWNER ADMIN SEC; do
  tok_var="T_$who"; out="$SCRATCH/dl-$who.bin"
  HDR=$(curl -s -D - -o "$out" "$DL" -H "Authorization: Bearer ${!tok_var}")
  expect_eq "$(echo "$HDR" | head -1 | awk '{print $2}')" "200" "$who downloads the evidence"
  expect_eq "$(openssl dgst -sha256 "$out" | awk '{print $NF}')" "$SHA" "$who receives exactly the uploaded bytes (SHA-256 matches)"
done
HDR=$(curl -s -D - -o /dev/null "$DL" -H "Authorization: Bearer $T_OWNER" | tr -d '\r')
echo "$HDR" | grep -qi '^content-type: image/jpeg' && pass "Served with the stored MIME type (image/jpeg)" || fail "Wrong Content-Type: $(echo "$HDR" | grep -i content-type)"
echo "$HDR" | grep -qi '^content-disposition: inline' && pass "Content-Disposition is inline (for the evidence viewer), not a forced download" || fail "Content-Disposition not inline"
expect_eq "$(code_of GET "$DL" "$T_OTHER")" "404" "A tanod with no tie to the incident gets 404, not 403"
expect_eq "$(code_of GET "$DL" "$T_PB")" "403" "Punong Barangay is refused (role has no evidence access)"
expect_eq "$(code_of GET "$DL" "$T_ADMIN2")" "404" "Another barangay's Admin gets 404 (existence never confirmed)"
expect_eq "$(code_of GET "$DL")" "401" "No token is refused"
expect_eq "$(code_of GET "${BASE_URL}/incidents/${INC2}/evidence/${ATT}/download" "$T_ADMIN")" "404" "The attachment id under a DIFFERENT incident of the same barangay is 404 (scoped lookup)"
expect_eq "$(code_of GET "${BASE_URL}/incidents/${INC1}/evidence/999999/download" "$T_ADMIN")" "404" "An unknown attachment id is 404"
AUD=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='evidence_downloaded' AND entity_id=$ATT;")
[ "$AUD" -ge 3 ] 2>/dev/null && pass "Each successful download is audited ($AUD rows)" || fail "Expected >= 3 evidence_downloaded audit rows, got $AUD"
META=$(db_one "SELECT GROUP_CONCAT(metadata_json) FROM audit_log WHERE action='evidence_downloaded';")
echo "$META" | grep -q -e 'scene.jpg' -e "$SHA" && fail "Audit metadata leaks the filename or hash" || pass "Audit metadata holds identifiers only (no filename, no hash)"
rm -f "$SCRATCH/evidence/$(db_one "SELECT file_path FROM evidence_attachment WHERE attachment_id=$ATT;")"
expect_eq "$(code_of GET "$DL" "$T_ADMIN")" "503" "A row whose file is gone answers 503, not a crash or an empty 200"
grep -q "$SCRATCH" <<< "$(curl -s "$DL" -H "Authorization: Bearer $T_ADMIN")" && fail "The 503 body leaks the storage path" || pass "The 503 body does not leak the storage path"

# ---------------------------------------------------------------------------
step "4. Punong Barangay digest: GET /reports/digest and /reports/digest/download"
expect_eq "$(curl -s "${BASE_URL}/reports/digest" -H "Authorization: Bearer $T_PB" | jget available)" "false" "Before any digest exists, meta says available=false"
expect_eq "$(code_of GET "${BASE_URL}/reports/digest/download" "$T_PB")" "404" "Before any digest exists, download is 404"
( cd "$BACKEND_DIR" && "$PHP_BIN" scripts/generate-pb-digest.php --days=7 >"$SCRATCH/digest.log" 2>&1 )
[ -f "$SCRATCH/reports/digest/barangay-1.pdf" ] && pass "generate-pb-digest.php wrote barangay 1's digest into the scratch directory" || fail "No digest file: $(tail -3 "$SCRATCH/digest.log")"
META=$(curl -s "${BASE_URL}/reports/digest" -H "Authorization: Bearer $T_PB")
expect_eq "$(echo "$META" | jget available)" "true" "Meta now says available=true"
[ -n "$(echo "$META" | jget date_from)" ] && [ -n "$(echo "$META" | jget date_to)" ] && pass "Meta carries the date range" || fail "Meta missing date range: $META"
OUT="$SCRATCH/digest-pb.pdf"
HDR=$(curl -s -D - -o "$OUT" "${BASE_URL}/reports/digest/download" -H "Authorization: Bearer $T_PB" | tr -d '\r')
expect_eq "$(echo "$HDR" | head -1 | awk '{print $2}')" "200" "Punong Barangay downloads the digest"
expect_eq "$(head -c 5 "$OUT")" "%PDF-" "The download is a real PDF"
echo "$HDR" | grep -qi '^content-disposition: attachment' && pass "Served as an attachment" || fail "Content-Disposition not attachment"
echo "$HDR" | grep -qi '^cache-control: no-store' && pass "Not cached (Cache-Control: no-store)" || fail "Missing Cache-Control: no-store"
grep -a -q "$SECRET_NARRATIVE" "$OUT" && fail "The digest PDF contains a raw narrative (Rule 1)" || pass "The digest PDF carries no raw narrative (Rule 1)"
grep -a -q -e 'Gap Owner Tanod' "$OUT" && fail "The digest PDF names a tanod" || pass "The digest PDF names no person"
expect_eq "$(code_of GET "${BASE_URL}/reports/digest/download" "$T_ADMIN")" "200" "Admin may download the digest"
expect_eq "$(code_of GET "${BASE_URL}/reports/digest/download" "$T_SEC")" "403" "Secretary is refused"
expect_eq "$(code_of GET "${BASE_URL}/reports/digest/download" "$T_OWNER")" "403" "Tanod is refused"
expect_eq "$(code_of GET "${BASE_URL}/reports/digest" "$T_SEC")" "403" "Secretary cannot read the digest meta either"
expect_eq "$(code_of GET "${BASE_URL}/reports/digest/download")" "401" "No token is refused"
OUT2="$SCRATCH/digest-pb2.pdf"
CODE2=$(curl -s -o "$OUT2" -w '%{http_code}' "${BASE_URL}/reports/digest/download" -H "Authorization: Bearer $T_PB2")
if [ "$CODE2" = "200" ]; then
  cmp -s "$OUT" "$OUT2" && fail "Barangay 2's PB received barangay 1's digest" || pass "Barangay 2's PB gets only barangay 2's own digest, never barangay 1's"
else
  expect_eq "$CODE2" "404" "Barangay 2's PB cannot reach barangay 1's digest"
fi
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='report_digest_downloaded' AND barangay_id=1;")" "2" "The two barangay-1 downloads are audited"

# ---------------------------------------------------------------------------
step "5. Swap request withdrawal: DELETE /shift-swap-requests/:id"
SW1=$(curl -s "${BASE_URL}/shift-swap-requests" -X POST -H "Authorization: Bearer $T_OWNER" -H "Content-Type: application/json" \
  -d "{\"shift_id\":$SHIFT_A,\"reason\":\"family matter\",\"client_request_id\":\"$(uuid)\"}" | jget request_id)
SW2=$(curl -s "${BASE_URL}/shift-swap-requests" -X POST -H "Authorization: Bearer $T_OWNER" -H "Content-Type: application/json" \
  -d "{\"shift_id\":$SHIFT_B,\"reason\":\"clinic visit\",\"client_request_id\":\"$(uuid)\"}" | jget request_id)
[ -n "$SW1" ] && [ -n "$SW2" ] && pass "Owner created two pending swap requests ($SW1, $SW2)" || { fail "Could not create swap requests"; exit 1; }
expect_eq "$(code_of DELETE "${BASE_URL}/shift-swap-requests/$SW1" "$T_OTHER")" "403" "Another tanod of the same barangay cannot withdraw it"
expect_eq "$(code_of DELETE "${BASE_URL}/shift-swap-requests/$SW1" "$T_ADMIN")" "403" "Admin cannot withdraw it (withdrawal is the requester's own act)"
expect_eq "$(code_of DELETE "${BASE_URL}/shift-swap-requests/$SW1" "$T_TANOD2")" "404" "A tanod of another barangay gets 404"
expect_eq "$(code_of DELETE "${BASE_URL}/shift-swap-requests/$SW1")" "401" "No token is refused"
expect_eq "$(db_one "SELECT COUNT(*) FROM shift_swap_request WHERE request_id=$SW1;")" "1" "None of the refused attempts deleted the row"
expect_eq "$(code_of DELETE "${BASE_URL}/shift-swap-requests/$SW1" "$T_OWNER")" "200" "The requester withdraws their pending request"
expect_eq "$(db_one "SELECT COUNT(*) FROM shift_swap_request WHERE request_id=$SW1;")" "0" "The row is gone"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='swap_request_withdrawn' AND entity_id=$SW1;")" "1" "The withdrawal is audited"
expect_eq "$(code_of DELETE "${BASE_URL}/shift-swap-requests/$SW1" "$T_OWNER")" "404" "Withdrawing it again is 404"
expect_eq "$(db_one "SELECT approval_status FROM shift_schedule WHERE shift_id=$SHIFT_A;")" "published" "The shift itself is untouched by the withdrawal"
mysql_exec "$VALDB" -e "UPDATE shift_swap_request SET status='denied', resolved_at=UTC_TIMESTAMP() WHERE request_id=$SW2;"
expect_eq "$(code_of DELETE "${BASE_URL}/shift-swap-requests/$SW2" "$T_OWNER")" "409" "A request that was already decided cannot be withdrawn"

echo
echo "================================================================"
echo "RESULT: $PASS passed, $FAIL failed."
echo "================================================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
