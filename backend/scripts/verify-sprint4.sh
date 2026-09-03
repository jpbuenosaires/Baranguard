#!/usr/bin/env bash
# Baranguard — Sprint 4 validation: notification model, Tanod SOS,
# notification acknowledgment, and dispatch-triggered notifications.
#
# ***NO TRANSPORT IS CONFIGURED WHEN THIS RUNS, ON PURPOSE.*** There is no
# GSM modem, no funded Semaphore account, and no FCM service-account
# credentials on this machine — and per §2 Rule 12, "no active FCM
# registration" and "no configured transport" are legitimate states the
# model must record honestly rather than paper over. So this suite asserts
# the LOGICAL layer (§5 notification / notification_target, the
# entity-integrity matrix, SOS lifecycle, acknowledgment) which is fully
# determinable without sending anything. Live send/receive stays a
# workstation task, exactly as Sprint 4's own prompt anticipates.
#
# Safe to run: disposable database, disposable app-user, disposable test
# accounts, throwaway port. The real `baranguard` database and
# backend/.env are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-sprint4.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }
expect_contains() { case "$1" in *"$2"*) pass "$3";; *) fail "$3 — '$2' not in: $1";; esac; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_sprint4_check"
APP_USER="s4chk_app"
APP_PASSWORD="Sprint4Chk!2026"
API_PORT="8124"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Sprint4#2026Pw"

echo "Baranguard Sprint 4 validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.s4chk-server.log"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

step "0. Schema + accounts"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "0001 applied" || fail "0001 failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" >/dev/null && pass "barangays seeded" || fail "seed failed"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'s4_admin','$HASH','S4 Admin','admin',1,UTC_TIMESTAMP()),
 (1,'s4_tanod_sos','$HASH','S4 Tanod Raiser','tanod',1,UTC_TIMESTAMP()),
 (1,'s4_tanod_on','$HASH','S4 Tanod OnDuty','tanod',1,UTC_TIMESTAMP()),
 (1,'s4_tanod_off','$HASH','S4 Tanod OffDuty','tanod',1,UTC_TIMESTAMP()),
 (1,'s4_secretary','$HASH','S4 Secretary','secretary',1,UTC_TIMESTAMP()),
 (2,'s4_admin2','$HASH','S4 Admin Brgy2','admin',1,UTC_TIMESTAMP());
SQL
# Duty state drives Rule 27's fan-out: on-duty tanod is a recipient,
# off-duty one must NOT be.
mysql_exec "$VALDB" <<SQL
INSERT INTO duty_status (user_id,status,channel,client_event_id,changed_at) VALUES
 ((SELECT user_id FROM user WHERE username='s4_tanod_on'),'on_duty','app','11111111-1111-4111-8111-111111111111',UTC_TIMESTAMP()),
 ((SELECT user_id FROM user WHERE username='s4_tanod_off'),'off_duty','app','22222222-2222-4222-8222-222222222222',UTC_TIMESTAMP()),
 ((SELECT user_id FROM user WHERE username='s4_tanod_sos'),'on_duty','app','33333333-3333-4333-8333-333333333333',UTC_TIMESTAMP());
SQL
pass "Seeded admin/tanods (on+off duty)/secretary + cross-tenant admin"

step "1. Start API (all transports deliberately UNCONFIGURED)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30 CORS_ALLOWED_ORIGIN='*'
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.s4chk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN=$(login_as s4_admin); RAISER=$(login_as s4_tanod_sos); ONDUTY=$(login_as s4_tanod_on)
OFFDUTY=$(login_as s4_tanod_off); SEC=$(login_as s4_secretary); ADMIN2=$(login_as s4_admin2)
[ -n "$ADMIN" ] && [ -n "$RAISER" ] && pass "Logged in (env override reached the disposable DB)" || { fail "Login failed"; exit 1; }

status_of() {
  local m="$1" p="$2" t="$3" b="${4:-}"
  if [ -n "$b" ]; then curl -s -o /dev/null -w '%{http_code}' -X "$m" "${BASE_URL}${p}" -H "Authorization: Bearer $t" -H "Content-Type: application/json" -d "$b"
  else curl -s -o /dev/null -w '%{http_code}' -X "$m" "${BASE_URL}${p}" -H "Authorization: Bearer $t"; fi
}
body_of() {
  local m="$1" p="$2" t="$3" b="${4:-}"
  if [ -n "$b" ]; then curl -s -X "$m" "${BASE_URL}${p}" -H "Authorization: Bearer $t" -H "Content-Type: application/json" -d "$b"
  else curl -s -X "$m" "${BASE_URL}${p}" -H "Authorization: Bearer $t"; fi
}
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "";'; }
db_one() { # single scalar, with ONE retry.
  # Observed twice across this repo's suites (once in verify-sprint6.sh's
  # audit-row check, once here): a COUNT query returns an EMPTY string
  # rather than a number, late in a long script, and is not reproducible in
  # isolation. An empty result from `mysql -N -s` means the client failed,
  # not that the count was zero. The likely cause is connection churn —
  # every call spawns a fresh mysql.exe and a fresh TCP connection, and a
  # long suite makes dozens in quick succession on Windows. Retrying once
  # costs nothing and removes a false failure that would otherwise be
  # mistaken for a real bug in the code under test.
  local out
  out=$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null)
  if [ -z "$out" ]; then sleep 0.4; out=$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null); fi
  echo "$out"
}
uuid() { "$PHP_BIN" -r "echo sprintf('%s-%s-4%s-8%s-%s', bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));"; }

step "2. POST /tanod-sos — role gating and validation"
CE1=$(uuid)
expect_eq "$(status_of POST /tanod-sos "$ADMIN" "{\"latitude\":12.9,\"longitude\":123.6,\"client_event_id\":\"$CE1\"}")" "403" "Admin cannot raise an SOS"
expect_eq "$(status_of POST /tanod-sos "$SEC" "{\"latitude\":12.9,\"longitude\":123.6,\"client_event_id\":\"$CE1\"}")" "403" "Secretary cannot raise an SOS"
expect_eq "$(status_of POST /tanod-sos "$RAISER" '{"latitude":12.9,"longitude":123.6}')" "400" "Missing client_event_id rejected"
expect_eq "$(status_of POST /tanod-sos "$RAISER" "{\"longitude\":123.6,\"client_event_id\":\"$(uuid)\"}")" "400" "Missing latitude rejected"
expect_eq "$(status_of POST /tanod-sos "$RAISER" "{\"latitude\":999,\"longitude\":123.6,\"client_event_id\":\"$(uuid)\"}")" "400" "Out-of-range latitude rejected"
expect_eq "$(status_of POST /tanod-sos "$RAISER" "{\"latitude\":12.9,\"longitude\":123.6,\"client_event_id\":\"$(uuid)\",\"fallback_channel\":\"carrier-pigeon\"}")" "400" "Invalid fallback_channel rejected"

step "3. SOS happy path + Rule 27 fan-out"
SOS=$(body_of POST /tanod-sos "$RAISER" "{\"latitude\":12.9186,\"longitude\":123.6667,\"client_event_id\":\"$CE1\"}")
echo "  response: $SOS"
SOS_ID=$(echo "$SOS" | jget sos_id)
expect_eq "$(echo "$SOS" | jget status)" "active" "New SOS is active"
expect_contains "$SOS" "received_at" "Response carries received_at"
expect_eq "$(db_one "SELECT COUNT(*) FROM tanod_sos WHERE sos_id=$SOS_ID;")" "1" "SOS row exists in the DB"
# Rule 27: Admin + OTHER on-duty tanods; never the raiser, never off-duty.
NOTIF_ID=$(db_one "SELECT notification_id FROM notification WHERE sos_id=$SOS_ID;")
expect_eq "$(db_one "SELECT notification_type FROM notification WHERE notification_id=$NOTIF_ID;")" "sos" "A 'sos' notification was created"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_target WHERE notification_id=$NOTIF_ID;")" "2" "Fan-out targeted exactly 2 people (admin + on-duty tanod)"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF_ID AND u.username='s4_admin';")" "1" "Admin was targeted"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF_ID AND u.username='s4_tanod_on';")" "1" "On-duty Tanod was targeted"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF_ID AND u.username='s4_tanod_off';")" "0" "OFF-duty Tanod was NOT targeted"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF_ID AND u.username='s4_tanod_sos';")" "0" "The RAISER was not alerted to their own SOS"
# Rule 27: SOS never depends on dispatch triage.
expect_eq "$(db_one "SELECT COUNT(*) FROM incident;")" "0" "Raising an SOS created NO incident (never depends on dispatch triage)"
# Rule 17: coordinates are a person's location and must not be audited.
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='tanod_sos_raised' AND metadata_json LIKE '%12.9186%';")" "0" "SOS audit metadata does NOT contain coordinates"

step "4. SOS idempotency"
SOS_REPLAY=$(body_of POST /tanod-sos "$RAISER" "{\"latitude\":12.9186,\"longitude\":123.6667,\"client_event_id\":\"$CE1\"}")
expect_eq "$(echo "$SOS_REPLAY" | jget sos_id)" "$SOS_ID" "Replay with the same client_event_id returns the ORIGINAL sos_id"
expect_eq "$(db_one "SELECT COUNT(*) FROM tanod_sos;")" "1" "No duplicate SOS row was created"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification WHERE sos_id IS NOT NULL;")" "1" "Replay did NOT raise a second alarm"

step "5. Acknowledge / resolve"
expect_eq "$(status_of PATCH "/tanod-sos/$SOS_ID/acknowledge" "$RAISER")" "403" "Tanod cannot acknowledge"
expect_eq "$(status_of PATCH "/tanod-sos/$SOS_ID/acknowledge" "$ADMIN2")" "404" "Cross-tenant admin gets 404"
ACK=$(body_of PATCH "/tanod-sos/$SOS_ID/acknowledge" "$ADMIN")
expect_eq "$(echo "$ACK" | jget status)" "acknowledged" "Acknowledge sets status"
# §6/§9: acknowledging must NOT resolve — W3's banner keeps showing.
expect_eq "$(db_one "SELECT resolved_at IS NULL FROM tanod_sos WHERE sos_id=$SOS_ID;")" "1" "Acknowledge did NOT resolve (banner stays up)"
ACK_AT=$(db_one "SELECT acknowledged_at FROM tanod_sos WHERE sos_id=$SOS_ID;")
body_of PATCH "/tanod-sos/$SOS_ID/acknowledge" "$ADMIN" >/dev/null
expect_eq "$(db_one "SELECT acknowledged_at FROM tanod_sos WHERE sos_id=$SOS_ID;")" "$ACK_AT" "Repeat acknowledge keeps the ORIGINAL timestamp"
RES=$(body_of PATCH "/tanod-sos/$SOS_ID/resolve" "$ADMIN")
expect_eq "$(echo "$RES" | jget status)" "resolved" "Resolve sets status"
expect_eq "$(status_of PATCH "/tanod-sos/$SOS_ID/resolve" "$ADMIN")" "409" "Re-resolving is 409"
expect_eq "$(status_of PATCH "/tanod-sos/$SOS_ID/acknowledge" "$ADMIN")" "409" "Acknowledging a resolved SOS is 409"

step "6. POST /notifications/:id/ack"
CE2=$(uuid)
SOS2=$(body_of POST /tanod-sos "$RAISER" "{\"latitude\":12.92,\"longitude\":123.67,\"client_event_id\":\"$CE2\"}")
SOS2_ID=$(echo "$SOS2" | jget sos_id)
N2=$(db_one "SELECT notification_id FROM notification WHERE sos_id=$SOS2_ID;")
expect_eq "$(status_of POST "/notifications/$N2/ack" "$ADMIN" '{}')" "403" "Admin cannot use the Tanod ack endpoint"
expect_eq "$(status_of POST "/notifications/$N2/ack" "$OFFDUTY" '{}')" "404" "A Tanod who is not a target gets 404"
# Rule 24: acknowledgment is NOT a transport record — captured BEFORE the
# ack call, not asserted as a global zero. Since Sprint 4 Phase 2 wired
# NotificationDispatcher into SOS/dispatch creation, delivery rows now
# legitimately exist by this point (every SOS raised above already
# attempted FCM/SMS and recorded 'failed' rows, since nothing is
# configured on this machine) — the invariant this step actually checks is
# narrower and still holds: calling POST /notifications/:id/ack itself
# creates no NEW delivery row, logical acknowledgment and transport
# attempts are recorded by entirely separate code paths.
DELIVERY_COUNT_BEFORE_ACK=$(db_one "SELECT COUNT(*) FROM notification_delivery;")
ACKN=$(body_of POST "/notifications/$N2/ack" "$ONDUTY" '{}')
expect_contains "$ACKN" '"success":true' "Targeted Tanod can acknowledge"
expect_eq "$(db_one "SELECT ack_status FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$N2 AND u.username='s4_tanod_on';")" "acknowledged" "ack_status recorded"
FIRST_ACK=$(db_one "SELECT acknowledged_at FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$N2 AND u.username='s4_tanod_on';")
body_of POST "/notifications/$N2/ack" "$ONDUTY" '{}' >/dev/null
expect_eq "$(db_one "SELECT acknowledged_at FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$N2 AND u.username='s4_tanod_on';")" "$FIRST_ACK" "Repeat ack keeps the original timestamp (protects avg_ack_seconds)"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_delivery;")" "$DELIVERY_COUNT_BEFORE_ACK" "Acknowledgment (both calls) created NO NEW delivery row (logical != transport)"

step "7. POST /dispatch now creates its notification"
mysql_exec "$VALDB" -e "INSERT INTO incident (barangay_id,incident_type,priority,raw_narrative,status,source,created_at,updated_at) VALUES (1,'theft','normal','Seeded for dispatch.','pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP());"
INC=$(db_one "SELECT incident_id FROM incident LIMIT 1;")
TANOD_ON_ID=$(db_one "SELECT user_id FROM user WHERE username='s4_tanod_on';")
DISP=$(body_of POST /dispatch "$ADMIN" "{\"incident_id\":$INC,\"tanod_id\":$TANOD_ON_ID,\"request_id\":\"$(uuid)\"}")
DISP_ID=$(echo "$DISP" | jget dispatch_id)
expect_contains "$DISP" "dispatch_id" "Dispatch created"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification WHERE dispatch_id=$DISP_ID AND notification_type='dispatch';")" "1" "Dispatch created its notification (Sprint 1's deferral now closed)"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_target nt JOIN notification n ON n.notification_id=nt.notification_id WHERE n.dispatch_id=$DISP_ID;")" "1" "Exactly the assigned Tanod was targeted"
expect_eq "$(db_one "SELECT nt.user_id FROM notification_target nt JOIN notification n ON n.notification_id=nt.notification_id WHERE n.dispatch_id=$DISP_ID;")" "$TANOD_ON_ID" "The target IS the assigned Tanod"

step "8. Entity-integrity matrix is enforced in app code (the ERROR 1901 workaround)"
# §5's matrix cannot be a CHECK constraint on MariaDB, so NotificationService
# enforces it. Prove the DB would happily accept a bad row that the service
# refuses — i.e. that the app layer is genuinely the thing protecting it.
BAD=$(mysql_exec "$VALDB" -e "INSERT INTO notification (barangay_id,notification_type,created_at) VALUES (1,'sos',UTC_TIMESTAMP());" 2>&1 && echo "ACCEPTED" || echo "REJECTED")
expect_eq "$BAD" "ACCEPTED" "The DATABASE alone accepts an sos notification with no sos_id (hence app-level enforcement is required)"
mysql_exec "$VALDB" -e "DELETE FROM notification WHERE sos_id IS NULL AND notification_type='sos';"
MATRIX=$("$PHP_BIN" -r '
require "'"$(cygpath -m "$BACKEND_DIR")"'/config/env.php"; baranguard_load_env();
require "'"$(cygpath -m "$BACKEND_DIR")"'/config/autoload.php";
$pdo = new PDO("mysql:host='"$XAMPP_MYSQL_HOST"';port='"$XAMPP_MYSQL_PORT"';dbname='"$VALDB"';charset=utf8mb4","'"$APP_USER"'","'"$APP_PASSWORD"'",[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
$cases = [
  ["sos",        [],                      "sos without sos_id"],
  ["dispatch",   [],                      "dispatch without dispatch_id"],
  ["priority_alert", [],                  "priority_alert without incident or dispatch"],
  ["sos",        ["sos_id"=>1,"dispatch_id"=>1], "sos carrying dispatch_id"],
];
$rejected = 0;
foreach ($cases as [$type,$entities,$label]) {
  try {
    \Baranguard\Services\Notifications\NotificationService::create($pdo, 1, $type, $entities, null, []);
    echo "NOT_REJECTED:$label\n";
  } catch (\Throwable $e) { $rejected++; }
}
echo $rejected;
' 2>&1 | tail -1)
expect_eq "$MATRIX" "4" "All 4 invalid type/entity combinations rejected by NotificationService"

step "9. /sync/batch sos[] now works (was 503 'not supported until Sprint 4')"
mysql_exec "$VALDB" -e "INSERT INTO mobile_device (device_id,user_id,platform,fcm_token,last_seen_at,is_active,created_at) VALUES ('s4-device-001',(SELECT user_id FROM user WHERE username='s4_tanod_sos'),'android','seeded-token',UTC_TIMESTAMP(),1,UTC_TIMESTAMP());"
CE3=$(uuid)
SYNC=$(body_of POST /sync/batch "$RAISER" "{\"device_id\":\"s4-device-001\",\"sos\":[{\"latitude\":12.93,\"longitude\":123.68,\"client_event_id\":\"$CE3\"}]}")
echo "  response: $SYNC"
expect_contains "$SYNC" '"status":"success"' "A queued offline SOS syncs successfully"
expect_eq "$(db_one "SELECT COUNT(*) FROM tanod_sos WHERE client_event_id='$CE3';")" "1" "The synced SOS exists in the DB"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification n JOIN tanod_sos s ON s.sos_id=n.sos_id WHERE s.client_event_id='$CE3';")" "1" "The synced SOS fanned out like a live one"

echo
echo "==================== SUMMARY ===================="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "================================================="
[ "$FAIL" -eq 0 ] && echo "All Sprint 4 (Phase 1) checks passed." || echo "Some checks FAILED — see above."
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
