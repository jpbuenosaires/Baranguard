#!/usr/bin/env bash
# Baranguard — Sprint 7 validation: audit completeness (§2 Rule 17's full
# action list actually produces audit_log rows) + W17 GET /audit-log
# + W9 GET /reports/export.
#
# The point of this suite is NOT "does Audit::record() work" — that has
# been exercised since Sprint 1. It is: **for each action Rule 17 names,
# does performing that action through the real HTTP endpoint actually
# leave a row behind?** Every check below therefore drives the endpoint
# and then looks in the table, rather than asserting anything about the
# code that sits between them.
#
# It also enforces Rule 17's second half on every row it produces: audit
# metadata is "allow-listed and contains identifiers/statuses only, never
# raw narrative or credentials." The narrative and password used here are
# distinctive strings, and the whole audit_log table is grepped for them.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-sprint7-audit.sh

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
VALDB="baranguard_s7audit_check"
APP_USER="s7aud_app"
APP_PASSWORD="Sprint7Aud!2026"
API_PORT="8172"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Sprint7#2026Pw"
NEW_PW="Sprint7#2026NewPw"
# Distinctive strings so the leak greps at the end are unambiguous.
SECRET_NARRATIVE="ZZTOPSECRETNARRATIVE-Maria-Santos-09171234567"

echo "Baranguard Sprint 7 audit-completeness validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
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
# The core assertion of this whole suite.
expect_audit() {
  local action="$1" label="$2"
  local n
  n=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='$action';")
  if [ "${n:-0}" -ge 1 ]; then pass "Rule 17: '$action' produced an audit row — $label"; else fail "Rule 17: NO audit row for '$action' — $label"; fi
}

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.s7aud-server.log"
  rm -rf "$BACKEND_DIR/scripts/.s7aud-exports"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

step "0. Schema + accounts"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "0001 applied" || fail "0001 failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" >/dev/null && pass "barangays seeded" || fail "seed failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0003_shift_schedule_nullable_user.sql" >/dev/null && pass "0003 applied" || fail "0003 failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0004_blotter_revision.sql" >/dev/null && pass "0004 applied" || fail "0004 failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0007_retention_columns.sql" >/dev/null && pass "0007 applied" || fail "0007 failed"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'s7a_admin','$HASH','S7A Admin','admin',1,UTC_TIMESTAMP()),
 (1,'s7a_tanod','$HASH','S7A Tanod','tanod',1,UTC_TIMESTAMP()),
 (1,'s7a_tanod2','$HASH','S7A Tanod Two','tanod',1,UTC_TIMESTAMP()),
 (1,'s7a_secretary','$HASH','S7A Secretary','secretary',1,UTC_TIMESTAMP()),
 (1,'s7a_pb','$HASH','S7A Punong','punong_barangay',1,UTC_TIMESTAMP()),
 (1,'s7a_pwuser','$HASH','S7A PwChange','secretary',1,UTC_TIMESTAMP()),
 (2,'s7a_admin2','$HASH','S7A Admin B2','admin',1,UTC_TIMESTAMP());
INSERT INTO duty_status (user_id, status, channel, changed_at, client_event_id)
 VALUES (2,'on_duty','app',UTC_TIMESTAMP(),UUID()),(3,'on_duty','app',UTC_TIMESTAMP(),UUID());
SQL
pass "Test accounts created"

( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="s7a-verify-secret-key-not-real-0123456789" \
  REPORT_EXPORT_DIR="$BACKEND_DIR/scripts/.s7aud-exports" \
  "$PHP_BIN" -S 127.0.0.1:$API_PORT -t public public/dev-router.php > "$BACKEND_DIR/scripts/.s7aud-server.log" 2>&1 ) &
SERVER_PID=$!
sleep 2

token_for() {
  curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["token"] ?? "";'
}

# --------------------------------------------------------------------------
step "1. Auth actions (login success/failure, logout, password change)"
# --------------------------------------------------------------------------
curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"s7a_admin\",\"password\":\"WrongPassword123\"}" >/dev/null
expect_audit "login_failure" "a wrong password"

ADMIN_TOKEN=$(token_for s7a_admin "$TEST_PW")
[ -n "$ADMIN_TOKEN" ] && pass "Admin logged in" || fail "Admin login failed — see .s7aud-server.log"
expect_audit "login_success" "a correct password"

SEC_TOKEN=$(token_for s7a_secretary "$TEST_PW")
TANOD_TOKEN=$(token_for s7a_tanod "$TEST_PW")
PB_TOKEN=$(token_for s7a_pb "$TEST_PW")

# Password change runs on its OWN account. It cannot share one with any
# other check: changing a password revokes that user's other sessions
# (correct, verified back in Sprint 1) — reusing an account here would
# invalidate a token a later step still needs, and the resulting 401
# would look like a role-gating failure rather than the intended
# behaviour it actually is.
PW_TOKEN=$(token_for s7a_pwuser "$TEST_PW")
curl -s -X POST "$BASE_URL/auth/change-password" -H "Authorization: Bearer $PW_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"current_password\":\"$TEST_PW\",\"new_password\":\"$NEW_PW\"}" >/dev/null
expect_audit "password_changed" "a self-service password change"

LOGOUT_TOKEN=$(token_for s7a_tanod2 "$TEST_PW")
curl -s -X POST "$BASE_URL/auth/logout" -H "Authorization: Bearer $LOGOUT_TOKEN" >/dev/null
expect_audit "logout" "an explicit sign-out"

# --------------------------------------------------------------------------
step "2. User changes (Rule 17: 'user changes/deactivation')"
# --------------------------------------------------------------------------
ADMIN_ID=$(db_one "SELECT user_id FROM user WHERE username='s7a_admin';")
curl -s -X PATCH "$BASE_URL/users/$ADMIN_ID" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"full_name":"S7A Admin Renamed","contact_number":"09991112222"}' >/dev/null
expect_audit "user_updated" "a self profile edit"
# Rule 17's allow-list: WHICH fields changed, never the values.
UMETA=$(db_one "SELECT metadata_json FROM audit_log WHERE action='user_updated' LIMIT 1;")
case "$UMETA" in
  *09991112222*) fail "AUDIT LEAK: the contact number itself is in audit metadata";;
  *full_name*) pass "user_updated metadata names the changed FIELDS, not their values";;
  *) fail "user_updated metadata missing the field list: $UMETA";;
esac

# --------------------------------------------------------------------------
step "3. Incident + dispatch lifecycle"
# --------------------------------------------------------------------------
# The incident carries a deliberately distinctive narrative — the leak
# grep at the end proves it never reaches audit_log.
INCIDENT_ID=$(curl -s -X POST "$BASE_URL/incidents" -H "Authorization: Bearer $SEC_TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $("$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));')" \
  -d "{\"incident_type\":\"theft\",\"raw_narrative\":\"$SECRET_NARRATIVE\",\"latitude\":12.9,\"longitude\":123.6}" \
  | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["incident_id"] ?? "";')
[ -n "$INCIDENT_ID" ] && pass "Incident #$INCIDENT_ID created" || fail "Incident creation failed"

TANOD_ID=$(db_one "SELECT user_id FROM user WHERE username='s7a_tanod';")
REQ_ID=$("$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));')
DISPATCH_ID=$(curl -s -X POST "$BASE_URL/dispatch" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"incident_id\":$INCIDENT_ID,\"tanod_id\":$TANOD_ID,\"request_id\":\"$REQ_ID\"}" \
  | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["dispatch_id"] ?? "";')
[ -n "$DISPATCH_ID" ] && pass "Dispatch #$DISPATCH_ID created" || fail "Dispatch creation failed"
expect_audit "dispatch_created" "assigning a Tanod (this was an audit GAP before Sprint 7)"

curl -s -X PATCH "$BASE_URL/dispatch/$DISPATCH_ID/cancel" -H "Authorization: Bearer $ADMIN_TOKEN" >/dev/null
expect_audit "dispatch_cancelled" "cancelling a dispatch (also a GAP before Sprint 7)"

# Re-dispatch, walk it to completion, then resolve the incident.
REQ_ID2=$("$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));')
DISPATCH2=$(curl -s -X POST "$BASE_URL/dispatch" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"incident_id\":$INCIDENT_ID,\"tanod_id\":$TANOD_ID,\"request_id\":\"$REQ_ID2\"}" \
  | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["dispatch_id"] ?? "";')
for st in en_route arrived completed; do
  curl -s -X PATCH "$BASE_URL/dispatch/$DISPATCH2/status" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"status\":\"$st\",\"override_reason\":\"drill: audit completeness check\"}" >/dev/null
done
expect_audit "dispatch_status_override" "an Admin driving a dispatch someone else owns"

curl -s -X PATCH "$BASE_URL/incidents/$INCIDENT_ID/status" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"status":"resolved"}' >/dev/null
expect_audit "incident_resolved" "an Admin closing an incident"

# --------------------------------------------------------------------------
step "4. Shift changes + swap decisions (both were audit GAPS)"
# --------------------------------------------------------------------------
SREQ=$("$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));')
SHIFT_ID=$(curl -s -X POST "$BASE_URL/shifts" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"user_id\":$TANOD_ID,\"patrol_zone\":\"Zone A\",\"start_at\":\"2027-01-05T08:00:00\",\"end_at\":\"2027-01-05T16:00:00\",\"request_id\":\"$SREQ\"}" \
  | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["shift_id"] ?? "";')
[ -n "$SHIFT_ID" ] && pass "Shift #$SHIFT_ID created" || fail "Shift creation failed"
expect_audit "shift_created" "scheduling a shift"

curl -s -X PATCH "$BASE_URL/shifts/$SHIFT_ID" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"patrol_zone":"Zone A-Revised","version":1}' >/dev/null
expect_audit "shift_updated" "editing a shift"

CREQ=$("$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));')
SWAP_ID=$(curl -s -X POST "$BASE_URL/shift-swap-requests" -H "Authorization: Bearer $TANOD_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"shift_id\":$SHIFT_ID,\"reason\":\"family matter\",\"client_request_id\":\"$CREQ\"}" \
  | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["request_id"] ?? "";')
curl -s -X PATCH "$BASE_URL/shift-swap-requests/$SWAP_ID" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"approved","version":1}' >/dev/null
expect_audit "swap_request_resolved" "an Admin approving a swap"

# Fatigue acknowledgement — seeded directly, since producing a real flag
# needs 56 scheduled hours and that is FatigueCalculator's own suite.
mysql_exec "$VALDB" -e "INSERT INTO fatigue_flag (user_id, shift_id, hours_worked_7day, calculation_basis, flagged_at) VALUES ($TANOD_ID, $SHIFT_ID, 58.00, 'rolling_7day', UTC_TIMESTAMP());"
FLAG_ID=$(db_one "SELECT flag_id FROM fatigue_flag LIMIT 1;")
curl -s -X PATCH "$BASE_URL/fatigue-flags/$FLAG_ID/acknowledge" -H "Authorization: Bearer $ADMIN_TOKEN" >/dev/null
expect_audit "fatigue_flag_acknowledged" "an Admin acknowledging a fatigue flag"

# --------------------------------------------------------------------------
step "5. SOS lifecycle + device changes + duty status"
# --------------------------------------------------------------------------
SOS_EVENT=$("$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));')
SOS_ID=$(curl -s -X POST "$BASE_URL/tanod-sos" -H "Authorization: Bearer $TANOD_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"latitude\":12.9,\"longitude\":123.6,\"triggered_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"client_event_id\":\"$SOS_EVENT\"}" \
  | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["sos_id"] ?? "";')
expect_audit "tanod_sos_raised" "a Tanod raising an SOS"
curl -s -X PATCH "$BASE_URL/tanod-sos/$SOS_ID/acknowledge" -H "Authorization: Bearer $ADMIN_TOKEN" >/dev/null
expect_audit "tanod_sos_acknowledged" "an Admin acknowledging the SOS"
curl -s -X PATCH "$BASE_URL/tanod-sos/$SOS_ID/resolve" -H "Authorization: Bearer $ADMIN_TOKEN" >/dev/null
expect_audit "tanod_sos_resolved" "resolving the SOS"
# Rule 17 + Rule 27: an SOS location is a person's position, never audited.
SOSMETA=$(db_one "SELECT GROUP_CONCAT(metadata_json) FROM audit_log WHERE action LIKE 'tanod_sos%';")
case "$SOSMETA" in
  *12.9*) fail "AUDIT LEAK: SOS coordinates appear in audit metadata";;
  *) pass "SOS coordinates are absent from audit metadata (Rule 17)";;
esac

curl -s -X POST "$BASE_URL/devices/register" -H "Authorization: Bearer $TANOD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"device_id":"s7a-device-xyz","platform":"android","fcm_token":"SECRETFCMTOKENVALUE","app_version":"1.0.0"}' >/dev/null
expect_audit "device_registered" "registering a handset"
curl -s -X PATCH "$BASE_URL/devices/s7a-device-xyz/deactivate" -H "Authorization: Bearer $TANOD_TOKEN" >/dev/null
expect_audit "device_deactivated" "retiring a handset"

DUTY_EVENT=$("$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));')
curl -s -X POST "$BASE_URL/duty-status" -H "Authorization: Bearer $TANOD_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"status\":\"off_duty\",\"client_event_id\":\"$DUTY_EVENT\"}" >/dev/null
expect_audit "duty_status_changed" "a Tanod going off duty"

# --------------------------------------------------------------------------
step "6. W9 GET /reports/export — 'request is scoped and audited' (§6)"
# --------------------------------------------------------------------------
EXPORT_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/reports/export?format=csv" -H "Authorization: Bearer $ADMIN_TOKEN")
expect_eq "$EXPORT_CODE" "201" "Admin can generate an export"
expect_audit "report_exported" "generating a report export"

BAD_FORMAT=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/reports/export?format=xlsx" -H "Authorization: Bearer $ADMIN_TOKEN")
expect_eq "$BAD_FORMAT" "400" "An unapproved format is refused, not silently downgraded to CSV"

TANOD_EXPORT=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/reports/export?format=csv" -H "Authorization: Bearer $TANOD_TOKEN")
expect_eq "$TANOD_EXPORT" "403" "Tanod cannot export"

DL_BODY=$(curl -s "$BASE_URL/reports/export/download" -H "Authorization: Bearer $ADMIN_TOKEN")
case "$DL_BODY" in
  *"Baranguard incident report"*) pass "Download returns the real generated CSV";;
  *) fail "Download did not return the expected CSV: $(echo "$DL_BODY" | head -c 120)";;
esac
case "$DL_BODY" in
  *"$SECRET_NARRATIVE"*) fail "EXPORT LEAK: the raw narrative is inside the exported CSV";;
  *) pass "Export contains aggregate counts only — no narrative text";;
esac
B2_DL=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/reports/export/download" -H "Authorization: Bearer $(token_for s7a_admin2 "$TEST_PW")")
expect_eq "$B2_DL" "404" "Another barangay's Admin gets their OWN (absent) export, never barangay 1's"

# --------------------------------------------------------------------------
step "7. W17 GET /audit-log"
# --------------------------------------------------------------------------
AL_TOTAL=$(curl -s "$BASE_URL/audit-log?limit=100" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["total"] ?? "0";')
if [ "${AL_TOTAL:-0}" -ge 15 ]; then pass "Audit log returns this session's rows (total=$AL_TOTAL)"; else fail "Audit log total unexpectedly low: $AL_TOTAL"; fi

for role_token in "$SEC_TOKEN" "$TANOD_TOKEN" "$PB_TOKEN"; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/audit-log" -H "Authorization: Bearer $role_token")
  expect_eq "$CODE" "403" "Non-Admin is refused the audit log (§9 W17: Admin only)"
done

FILTERED=$(curl -s "$BASE_URL/audit-log?action=dispatch_created" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $a=array_unique(array_column($d["items"]??[], "action")); echo implode(",", $a);')
expect_eq "$FILTERED" "dispatch_created" "action filter returns only that action"

# Tenant scoping: barangay 2's Admin must not see barangay 1's trail.
B2_TOTAL=$(curl -s "$BASE_URL/audit-log?limit=100" -H "Authorization: Bearer $(token_for s7a_admin2 "$TEST_PW")" \
  | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=0; foreach($d["items"]??[] as $i){ if(($i["action"]??"")!=="login_success") $n++; } echo $n;')
expect_eq "$B2_TOTAL" "0" "Cross-tenant: barangay 2 Admin sees none of barangay 1's audit rows"

# No write surface exists at all — the defining property of the audit log.
for method in POST PATCH DELETE PUT; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$BASE_URL/audit-log" -H "Authorization: Bearer $ADMIN_TOKEN")
  if [ "$CODE" = "405" ] || [ "$CODE" = "404" ]; then
    pass "$method /audit-log is not routed ($CODE) — the log has no write surface"
  else
    fail "$method /audit-log returned $CODE — an audit-log write path must not exist"
  fi
done

# --------------------------------------------------------------------------
step "8. Rule 17's allow-list, enforced across the WHOLE table"
# --------------------------------------------------------------------------
# "never raw narrative or credentials" — checked against every audit row
# this session produced, not per-action.
LEAK_NARR=$(db_one "SELECT COUNT(*) FROM audit_log WHERE metadata_json LIKE '%ZZTOPSECRETNARRATIVE%';")
expect_eq "$LEAK_NARR" "0" "No raw narrative anywhere in audit_log"
LEAK_PW=$(db_one "SELECT COUNT(*) FROM audit_log WHERE metadata_json LIKE '%Sprint7#2026%';")
expect_eq "$LEAK_PW" "0" "No password (old or new) anywhere in audit_log"
LEAK_HASH=$(db_one "SELECT COUNT(*) FROM audit_log WHERE metadata_json LIKE '%argon2%';")
expect_eq "$LEAK_HASH" "0" "No password hash anywhere in audit_log"
LEAK_FCM=$(db_one "SELECT COUNT(*) FROM audit_log WHERE metadata_json LIKE '%SECRETFCMTOKENVALUE%';")
expect_eq "$LEAK_FCM" "0" "No FCM token anywhere in audit_log (Rule 26)"
LEAK_JWT=$(db_one "SELECT COUNT(*) FROM audit_log WHERE metadata_json LIKE '%eyJ%';")
expect_eq "$LEAK_JWT" "0" "No JWT anywhere in audit_log"

# Every row must be attributable and typed — a row with neither an actor
# nor an entity type would be an audit entry that says nothing.
UNTYPED=$(db_one "SELECT COUNT(*) FROM audit_log WHERE entity_type IS NULL OR entity_type = '';")
expect_eq "$UNTYPED" "0" "Every audit row carries an entity_type"

DISTINCT=$(db_one "SELECT COUNT(DISTINCT action) FROM audit_log;")
echo "  (distinct audited actions exercised this run: $DISTINCT)"
if [ "${DISTINCT:-0}" -ge 15 ]; then pass "Rule 17 coverage: $DISTINCT distinct actions produced audit rows"; else fail "Only $DISTINCT distinct actions audited — expected 15+"; fi

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
