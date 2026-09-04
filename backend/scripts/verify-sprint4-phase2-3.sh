#!/usr/bin/env bash
# Baranguard — Sprint 4 Phase 2+3 validation: FCM/SMS transport, the Rule 12
# fallback ladder, the 60s ack-timeout worker, device secret provisioning,
# encrypted SMS envelopes, the internal-only /internal/sms/* router, and
# GET /sms/logs.
#
# ***NO LIVE FCM/SEMAPHORE CREDENTIALS ARE USED.*** There is still no
# funded Firebase project or Semaphore account on this machine. That is
# exactly why this suite is worth running anyway: FcmClient/SemaphoreClient
# both being "not configured" is itself a real, fully-deterministic code
# path (Rule 12's own "if no active FCM registration, go straight to SMS"
# and "FCM error -> retry once -> SMS on second failure" apply IDENTICALLY
# whether the failure is "not configured" or "the real service rejected
# it"), so every branch of the ladder is genuinely exercised here — only
# the very last hop (an actual byte over the wire to Google/Semaphore) is
# unverified. DEVICE_SECRET_MASTER_KEY and INTERNAL_SERVICE_TOKEN, by
# contrast, ARE fully local secrets this suite generates and uses for
# real — envelope crypto and the internal router are verified completely.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-sprint4-phase2-3.sh

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
expect_not_contains() { case "$1" in *"$2"*) fail "$3 — '$2' unexpectedly in: $1";; *) pass "$3";; esac; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_s4p23_check"
APP_USER="s4p23_app"
APP_PASSWORD="Sprint4P23Chk!2026"
API_PORT="8126"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
INTERNAL_URL="http://127.0.0.1:${API_PORT}/internal"
TEST_PW="Sprint4P23#2026Pw"

echo "Baranguard Sprint 4 Phase 2+3 validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -f "$BACKEND_DIR/scripts/.s4p23chk-server.log"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

step "0. Schema + accounts"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "0001 applied" || fail "0001 failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" >/dev/null && pass "barangays seeded" || fail "seed failed"
# 0007: DevicesController writes mobile_device.deactivated_at (§11's
# 90-day device-retention clock), so any suite that registers a device
# needs the column present.
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0007_retention_columns.sql" >/dev/null && pass "0007 applied" || fail "0007 failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0005_sms_envelope_replay.sql" && pass "0005 (sms_envelope_replay) applied" || fail "0005 failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0006_sms_log_barangay.sql" && pass "0006 (sms_log.barangay_id) applied" || fail "0006 failed"
COLCOUNT=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='sms_log' AND COLUMN_NAME='barangay_id';")
expect_eq "$COLCOUNT" "1" "sms_log.barangay_id column exists after 0006"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, contact_number, is_active, created_at) VALUES
 (1,'s4p23_admin','$HASH','P23 Admin','admin','+639170000001',1,UTC_TIMESTAMP()),
 (1,'s4p23_tanod_a','$HASH','P23 Tanod A','tanod','+639170000002',1,UTC_TIMESTAMP()),
 (1,'s4p23_tanod_b','$HASH','P23 Tanod B','tanod',NULL,1,UTC_TIMESTAMP());
SQL
pass "Seeded admin + two tanods (one with contact_number, one without)"

step "1. Start API + internal router (dev-router.php; see its own doc for why)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30 CORS_ALLOWED_ORIGIN='*'
export INTERNAL_SERVICE_TOKEN="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export DEVICE_SECRET_MASTER_KEY="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
# FCM_SERVICE_ACCOUNT_PATH / SEMAPHORE_API_KEY deliberately left UNSET.
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" "$BACKEND_DIR/public/dev-router.php" >"$BACKEND_DIR/scripts/.s4p23chk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN=$(login_as s4p23_admin); TANOD_A=$(login_as s4p23_tanod_a); TANOD_B=$(login_as s4p23_tanod_b)
[ -n "$ADMIN" ] && [ -n "$TANOD_A" ] && [ -n "$TANOD_B" ] && pass "Logged in (env override reached the disposable DB)" || { fail "Login failed"; exit 1; }

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
db_one() {
  local out
  out=$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null)
  if [ -z "$out" ]; then sleep 0.4; out=$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null); fi
  echo "$out"
}
uuid() { "$PHP_BIN" -r "echo sprintf('%s-%s-4%s-8%s-%s', bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));"; }

# ---------------------------------------------------------------------------
step "2. Device registration + SMS envelope key provisioning"
DEV1="p23dev-tanoda-001"
REG1=$(body_of POST /devices/register "$TANOD_A" "{\"device_id\":\"$DEV1\",\"fcm_token\":\"fake-fcm-token-aaa\",\"platform\":\"android\"}")
KEY1=$(echo "$REG1" | jget message_encryption_key)
[ -n "$KEY1" ] && pass "First registration returns message_encryption_key" || fail "First registration returned no key: $REG1"

SECRETREF1=$(db_one "SELECT device_secret_ref FROM mobile_device WHERE device_id='$DEV1';")
[ -n "$SECRETREF1" ] && pass "device_secret_ref populated in DB" || fail "device_secret_ref is empty"

# Re-register the SAME device (ordinary FCM-token-refresh path) — must NOT
# re-issue or change the secret.
REG1B=$(body_of POST /devices/register "$TANOD_A" "{\"device_id\":\"$DEV1\",\"fcm_token\":\"fake-fcm-token-aaa-refreshed\",\"platform\":\"android\"}")
KEY1B=$(echo "$REG1B" | jget message_encryption_key)
expect_eq "$KEY1B" "" "Re-registration does NOT re-return message_encryption_key"
SECRETREF1B=$(db_one "SELECT device_secret_ref FROM mobile_device WHERE device_id='$DEV1';")
expect_eq "$SECRETREF1B" "$SECRETREF1" "Re-registration keeps the EXACT SAME wrapped secret (verified in DB, not just the response)"

step "3. GET /system/health reports fcm/sms_semaphore as not_configured, gsm_ingestion as healthy"
HEALTH=$(body_of GET /system/health "$ADMIN")
expect_contains "$HEALTH" '"fcm":"not_configured"' "fcm: not_configured (no service account on this machine)"
expect_contains "$HEALTH" '"sms_semaphore":"not_configured"' "sms_semaphore: not_configured (no Semaphore account)"
expect_contains "$HEALTH" '"gsm_ingestion":"healthy"' "gsm_ingestion: healthy (INTERNAL_SERVICE_TOKEN is set)"

# ---------------------------------------------------------------------------
step "4. Rule 12 ladder — target WITH a device: 2 FCM attempts then SMS, all recorded"
# Register device_id for tanod_a already done above (has fcm_token). Raise
# an SOS from tanod_a so tanod_a is NOT a recipient of their own alert —
# use tanod_b as the raiser instead, so tanod_a (WITH a device) is the
# recipient we can inspect.
mysql_exec "$VALDB" -e "INSERT INTO duty_status (user_id,status,channel,client_event_id,changed_at) SELECT user_id,'on_duty','app','$(uuid)',UTC_TIMESTAMP() FROM user WHERE username='s4p23_tanod_a';"
CE_SOS1=$(uuid)
SOS1=$(body_of POST /tanod-sos "$TANOD_B" "{\"latitude\":12.9,\"longitude\":123.6,\"client_event_id\":\"$CE_SOS1\"}")
SOS1_ID=$(echo "$SOS1" | jget sos_id)
[ -n "$SOS1_ID" ] && pass "SOS raised (sos_id=$SOS1_ID)" || fail "SOS raise failed: $SOS1"

NOTIF_ID=$(db_one "SELECT notification_id FROM notification WHERE sos_id=$SOS1_ID;")
[ -n "$NOTIF_ID" ] && pass "Logical notification created for the SOS" || fail "No notification row for SOS"

TARGET_A_ID=$(db_one "SELECT nt.notification_target_id FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF_ID AND u.username='s4p23_tanod_a';")
[ -n "$TARGET_A_ID" ] && pass "tanod_a (has an active device) is a target" || fail "tanod_a is not a target"

FCM_ATTEMPTS=$(db_one "SELECT COUNT(*) FROM notification_delivery WHERE notification_target_id=$TARGET_A_ID AND channel='fcm';")
expect_eq "$FCM_ATTEMPTS" "2" "Exactly 2 FCM delivery rows recorded (attempt_no 1 and 2 — Rule 12's 'retry once')"
FCM_BOTH_FAILED=$(db_one "SELECT COUNT(*) FROM notification_delivery WHERE notification_target_id=$TARGET_A_ID AND channel='fcm' AND status='failed' AND failure_reason='FCM_NOT_CONFIGURED';")
expect_eq "$FCM_BOTH_FAILED" "2" "Both FCM attempts failed with FCM_NOT_CONFIGURED"
SMS_ATTEMPTS=$(db_one "SELECT COUNT(*) FROM notification_delivery WHERE notification_target_id=$TARGET_A_ID AND channel='sms';")
expect_eq "$SMS_ATTEMPTS" "1" "Exactly 1 SMS delivery row after both FCM attempts failed (Rule 12's 'then SMS on second failure')"
SMS_FAILED_REASON=$(db_one "SELECT failure_reason FROM notification_delivery WHERE notification_target_id=$TARGET_A_ID AND channel='sms';")
expect_eq "$SMS_FAILED_REASON" "SEMAPHORE_NOT_CONFIGURED" "SMS attempt correctly failed with SEMAPHORE_NOT_CONFIGURED (a real contact_number WAS found, so it got this far)"

SMS_LOG_ROW=$(db_one "SELECT COUNT(*) FROM sms_log WHERE direction='outbound' AND message_type='sos' AND barangay_id=1;")
# dispatchAll() is synchronous and processes EVERY target of the SOS before
# POST /tanod-sos returns — by this point both tanod_a's (FCM x2 then SMS)
# and admin's (straight to SMS) fallback attempts have already run, so this
# is 2 rows, not 1. Asserted as >=2 rather than a brittle exact count.
[ "$SMS_LOG_ROW" -ge "2" ] 2>/dev/null && pass "sms_log gained outbound 'sos' rows with barangay_id populated for BOTH targets ($SMS_LOG_ROW)" || fail "Expected >=2 outbound sos sms_log rows, got $SMS_LOG_ROW"

step "5. Rule 12 ladder — target with NO device: straight to SMS, zero FCM rows"
TARGET_B_ID=$(db_one "SELECT nt.notification_target_id FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF_ID AND u.username='s4p23_admin';")
[ -n "$TARGET_B_ID" ] && pass "admin (no device registered) is a target" || fail "admin is not a target"
FCM_FOR_ADMIN=$(db_one "SELECT COUNT(*) FROM notification_delivery WHERE notification_target_id=$TARGET_B_ID AND channel='fcm';")
expect_eq "$FCM_FOR_ADMIN" "0" "No FCM attempt at all for a target with no device (Rule 12: 'no active FCM registration -> straight to SMS')"
SMS_FOR_ADMIN=$(db_one "SELECT COUNT(*) FROM notification_delivery WHERE notification_target_id=$TARGET_B_ID AND channel='sms';")
expect_eq "$SMS_FOR_ADMIN" "1" "Exactly 1 SMS attempt for admin"

step "6. NO_CONTACT_NUMBER path — a target with neither device nor phone number"
# tanod_b must be on-duty to be an eligible SOS recipient at all
# (NotificationService::sosRecipients() — same "responding counts too"
# rule as tanod_a's own on-duty row above); the SOS itself must be raised
# by someone ELSE, since a raiser is never their own recipient.
mysql_exec "$VALDB" -e "INSERT INTO duty_status (user_id,status,channel,client_event_id,changed_at) SELECT user_id,'on_duty','app','$(uuid)',UTC_TIMESTAMP() FROM user WHERE username='s4p23_tanod_b';"
CE_SOS2=$(uuid)
SOS2=$(body_of POST /tanod-sos "$TANOD_A" "{\"latitude\":12.91,\"longitude\":123.61,\"client_event_id\":\"$CE_SOS2\"}")
SOS2_ID=$(echo "$SOS2" | jget sos_id)
NOTIF2_ID=$(db_one "SELECT notification_id FROM notification WHERE sos_id=$SOS2_ID;")
TARGET_C_ID=$(db_one "SELECT nt.notification_target_id FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF2_ID AND u.username='s4p23_tanod_b';")
[ -n "$TARGET_C_ID" ] && pass "tanod_b (no device, no contact_number) is a target" || fail "tanod_b is not a target"
NC_REASON=$(db_one "SELECT failure_reason FROM notification_delivery WHERE notification_target_id=$TARGET_C_ID AND channel='sms';")
expect_eq "$NC_REASON" "NO_CONTACT_NUMBER" "SMS attempt failed with NO_CONTACT_NUMBER, and no phantom sms_log row was written for it"
SMSLOG_FOR_C=$(db_one "SELECT COUNT(*) FROM sms_log WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 1 MINUTE AND message_type='sos' AND status='failed' AND failure_reason='NO_CONTACT_NUMBER';")
expect_eq "$SMSLOG_FOR_C" "0" "NO_CONTACT_NUMBER never reaches SmsGatewayService, so no sms_log row is written for it (correct — nothing was actually attempted against a gateway)"

step "7. Dispatch creation also triggers the ladder (not just SOS)"
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, latitude, longitude, created_at, updated_at)
VALUES (1,'theft','normal','test narrative — never sent anywhere','pending','web',12.92,123.62,UTC_TIMESTAMP(),UTC_TIMESTAMP());
SQL
INCIDENT_ID=$(db_one "SELECT incident_id FROM incident ORDER BY incident_id DESC LIMIT 1;")
DISPATCH_BODY=$(body_of POST /dispatch "$ADMIN" "{\"incident_id\":$INCIDENT_ID,\"tanod_id\":$(db_one "SELECT user_id FROM user WHERE username='s4p23_tanod_a';"),\"request_id\":\"$(uuid)\"}")
DISPATCH_ID=$(echo "$DISPATCH_BODY" | jget dispatch_id)
[ -n "$DISPATCH_ID" ] && pass "Dispatch created (dispatch_id=$DISPATCH_ID)" || fail "Dispatch create failed: $DISPATCH_BODY"
DISPATCH_NOTIF=$(db_one "SELECT notification_id FROM notification WHERE dispatch_id=$DISPATCH_ID;")
[ -n "$DISPATCH_NOTIF" ] && pass "Dispatch notification created" || fail "No notification for dispatch"
DISPATCH_DELIVERY_COUNT=$(db_one "SELECT COUNT(*) FROM notification_delivery nd JOIN notification_target nt ON nt.notification_target_id=nd.notification_target_id WHERE nt.notification_id=$DISPATCH_NOTIF;")
[ "$DISPATCH_DELIVERY_COUNT" -ge "1" ] 2>/dev/null && pass "Dispatch notification produced at least one delivery attempt" || fail "No delivery attempts for dispatch notification"

# ---------------------------------------------------------------------------
step "8. Ack-timeout worker (scripts/notification-worker.php)"
# Manually plant a 'sent' FCM delivery row 90s in the past for a fresh
# target that has NOT acknowledged — this is the one thing a live test
# cannot produce naturally without a real FCM send succeeding.
mysql_exec "$VALDB" <<SQL
INSERT INTO notification_delivery (notification_id, notification_target_id, channel, attempt_no, status, initiated_at, sent_at)
VALUES ($NOTIF_ID, $TARGET_A_ID, 'fcm', 99, 'sent', UTC_TIMESTAMP() - INTERVAL 90 SECOND, UTC_TIMESTAMP() - INTERVAL 90 SECOND);
INSERT INTO notification_delivery (notification_id, notification_target_id, channel, attempt_no, status, initiated_at, sent_at)
VALUES ($NOTIF_ID, $TARGET_A_ID, 'fcm', 98, 'sent', UTC_TIMESTAMP() - INTERVAL 10 SECOND, UTC_TIMESTAMP() - INTERVAL 10 SECOND);
SQL
STALE_DELIVERY_ID=$(db_one "SELECT delivery_id FROM notification_delivery WHERE notification_target_id=$TARGET_A_ID AND attempt_no=99;")
FRESH_DELIVERY_ID=$(db_one "SELECT delivery_id FROM notification_delivery WHERE notification_target_id=$TARGET_A_ID AND attempt_no=98;")

pushd "$BACKEND_DIR" >/dev/null
"$PHP_BIN" scripts/notification-worker.php --once >/tmp/.s4p23-worker.log 2>&1
popd >/dev/null

STALE_STATUS=$(db_one "SELECT status FROM notification_delivery WHERE delivery_id=$STALE_DELIVERY_ID;")
expect_eq "$STALE_STATUS" "ack_timeout" "A 90s-old unacknowledged FCM 'sent' row was swept into ack_timeout"
STALE_TIMEOUT_AT=$(db_one "SELECT ack_timeout_at IS NOT NULL FROM notification_delivery WHERE delivery_id=$STALE_DELIVERY_ID;")
expect_eq "$STALE_TIMEOUT_AT" "1" "ack_timeout_at was set on the swept row"
FRESH_STATUS=$(db_one "SELECT status FROM notification_delivery WHERE delivery_id=$FRESH_DELIVERY_ID;")
expect_eq "$FRESH_STATUS" "sent" "A 10s-old 'sent' row (still inside the 60s window) was left untouched"

# Re-run the sweep — must be idempotent (no error, no double-processing).
pushd "$BACKEND_DIR" >/dev/null
"$PHP_BIN" scripts/notification-worker.php --once >/tmp/.s4p23-worker2.log 2>&1
popd >/dev/null
STALE_STATUS_AGAIN=$(db_one "SELECT status FROM notification_delivery WHERE delivery_id=$STALE_DELIVERY_ID;")
expect_eq "$STALE_STATUS_AGAIN" "ack_timeout" "Re-running the sweep is a no-op on an already-timed-out row"

# Acknowledge, then confirm a stale-but-now-acknowledged target is skipped.
mysql_exec "$VALDB" -e "UPDATE notification_target SET ack_status='acknowledged', acknowledged_at=UTC_TIMESTAMP() WHERE notification_target_id=$TARGET_A_ID;"
mysql_exec "$VALDB" <<SQL
INSERT INTO notification_delivery (notification_id, notification_target_id, channel, attempt_no, status, initiated_at, sent_at)
VALUES ($NOTIF_ID, $TARGET_A_ID, 'fcm', 97, 'sent', UTC_TIMESTAMP() - INTERVAL 90 SECOND, UTC_TIMESTAMP() - INTERVAL 90 SECOND);
SQL
ACKED_DELIVERY_ID=$(db_one "SELECT delivery_id FROM notification_delivery WHERE notification_target_id=$TARGET_A_ID AND attempt_no=97;")
pushd "$BACKEND_DIR" >/dev/null
"$PHP_BIN" scripts/notification-worker.php --once >/tmp/.s4p23-worker3.log 2>&1
popd >/dev/null
ACKED_STATUS=$(db_one "SELECT status FROM notification_delivery WHERE delivery_id=$ACKED_DELIVERY_ID;")
expect_eq "$ACKED_STATUS" "sent" "An already-acknowledged target's stale 'sent' row is NEVER swept into ack_timeout (Rule 24)"

WORKER_STATUS_OUT=$("$PHP_BIN" "$BACKEND_DIR/scripts/notification-worker.php" --status 2>&1)
expect_contains "$WORKER_STATUS_OUT" "FCM deliveries" "notification-worker.php --status runs and prints real counts"

# ---------------------------------------------------------------------------
step "9. Internal router — loopback+token gate"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/sos")" "401" "No X-Internal-Token -> 401"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/sos" -H "X-Internal-Token: wrong-token")" "401" "Wrong X-Internal-Token -> 401"
NF=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/does-not-exist" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN")
expect_eq "$NF" "404" "Unknown internal route (with a VALID token) -> 404, not exposed on /api/v1"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL/api\/v1/internal}/sms/sos" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Authorization: Bearer $ADMIN")" "422" "Even WITH a valid Bearer token, /internal/sms/sos is unreachable via any means except the internal gate+a real envelope (422 = reached the handler, envelope was empty/invalid, not 401/404 — proves this is genuinely a different router, not a JWT-gated /api/v1 alias)"

step "10. Real encrypted envelope, end to end — /internal/sms/duty-status"
CE_ENV1=$(uuid)
ENV1=$("$PHP_BIN" "$BACKEND_DIR/scripts/sms-envelope-build.php" --secret="$KEY1" --device-id="$DEV1" --type=duty_status --payload='{"status":"responding"}' --client-event-id="$CE_ENV1")
ENV1_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/duty-status" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "$ENV1")
expect_eq "$ENV1_STATUS" "200" "Real AES-256-GCM envelope decrypts and processes successfully (duty_status)"
DUTY_CHANNEL=$(db_one "SELECT channel FROM duty_status WHERE client_event_id='$CE_ENV1';")
expect_eq "$DUTY_CHANNEL" "sms" "The resulting duty_status row has channel='sms' (Rule 13), not 'app'"
DUTY_USER=$(db_one "SELECT u.username FROM duty_status ds JOIN user u ON u.user_id=ds.user_id WHERE ds.client_event_id='$CE_ENV1';")
expect_eq "$DUTY_USER" "s4p23_tanod_a" "Sender identity was correctly derived from the device mapping, not any embedded field (Rule 13)"

step "11. Replay protection — the identical envelope rejected on a second POST"
REPLAY_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/duty-status" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "$ENV1")
expect_eq "$REPLAY_STATUS" "422" "Replaying the exact same envelope is rejected"
DUTY_ROWS_FOR_EVENT=$(db_one "SELECT COUNT(*) FROM duty_status WHERE client_event_id='$CE_ENV1';")
expect_eq "$DUTY_ROWS_FOR_EVENT" "1" "Still exactly 1 duty_status row for that event — the replay never reached business logic a second time"

step "12. Tampered ciphertext is rejected (GCM auth tag)"
CE_ENV2=$(uuid)
ENV2=$("$PHP_BIN" "$BACKEND_DIR/scripts/sms-envelope-build.php" --secret="$KEY1" --device-id="$DEV1" --type=coord_ping --payload="{\"latitude\":12.93,\"longitude\":123.63,\"accuracy_m\":8,\"recorded_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" --client-event-id="$CE_ENV2")
TAMPERED=$("$PHP_BIN" -r '
$e = json_decode(file_get_contents("php://stdin"), true);
$bytes = base64_decode($e["ciphertext"]);
$bytes[0] = chr(ord($bytes[0]) ^ 0xFF);
$e["ciphertext"] = base64_encode($bytes);
echo json_encode($e);
' <<< "$ENV2")
TAMPER_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/coord-ping" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "$TAMPERED")
expect_eq "$TAMPER_STATUS" "422" "A single flipped ciphertext byte fails GCM authentication and is rejected"

step "13. AAD binding — swapping device_id in the header (without re-encrypting) is rejected"
DEV2="p23dev-tanodb-002"
REG2=$(body_of POST /devices/register "$TANOD_B" "{\"device_id\":\"$DEV2\",\"fcm_token\":\"fake-fcm-token-bbb\",\"platform\":\"android\"}")
KEY2=$(echo "$REG2" | jget message_encryption_key)
CE_ENV3=$(uuid)
ENV3=$("$PHP_BIN" "$BACKEND_DIR/scripts/sms-envelope-build.php" --secret="$KEY1" --device-id="$DEV1" --type=coord_ping --payload="{\"latitude\":12.94,\"longitude\":123.64,\"accuracy_m\":8,\"recorded_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" --client-event-id="$CE_ENV3")
SPOOFED=$("$PHP_BIN" -r '
$e = json_decode(file_get_contents("php://stdin"), true);
$e["device_id"] = "'"$DEV2"'";
echo json_encode($e);
' <<< "$ENV3")
SPOOF_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/coord-ping" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "$SPOOFED")
expect_eq "$SPOOF_STATUS" "422" "Swapping device_id in the header (still encrypted under device 1's key) fails AAD authentication — cannot impersonate device 2"

step "14. Expired envelope is rejected"
CE_ENV4=$(uuid)
ENV4=$("$PHP_BIN" "$BACKEND_DIR/scripts/sms-envelope-build.php" --secret="$KEY1" --device-id="$DEV1" --type=coord_ping --payload="{\"latitude\":12.95,\"longitude\":123.65,\"accuracy_m\":8,\"recorded_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" --client-event-id="$CE_ENV4" --ttl=-3600)
EXPIRED_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/coord-ping" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "$ENV4")
expect_eq "$EXPIRED_STATUS" "422" "An envelope whose expiry is already in the past is rejected"

step "15. message_type must match the endpoint it's posted to"
CE_ENV5=$(uuid)
ENV5=$("$PHP_BIN" "$BACKEND_DIR/scripts/sms-envelope-build.php" --secret="$KEY1" --device-id="$DEV1" --type=duty_status --payload='{"status":"on_duty"}' --client-event-id="$CE_ENV5")
MISMATCH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/sos" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "$ENV5")
expect_eq "$MISMATCH_STATUS" "422" "A duty_status envelope posted to /sms/sos is rejected (message_type mismatch)"

step "16. Incident-fallback envelope creates an incident with source='sms'"
CE_ENV6=$(uuid)
ENV6=$("$PHP_BIN" "$BACKEND_DIR/scripts/sms-envelope-build.php" --secret="$KEY1" --device-id="$DEV1" --type=incident_fallback --payload='{"incident_type":"theft","raw_narrative":"reported via SMS fallback, never printed anywhere","latitude":12.96,"longitude":123.66}' --client-event-id="$CE_ENV6")
INC_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/incident-fallback" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "$ENV6")
expect_eq "$INC_STATUS" "200" "Incident-fallback envelope accepted"
INC_SOURCE=$(db_one "SELECT source FROM incident WHERE client_event_id='$CE_ENV6';")
expect_eq "$INC_SOURCE" "sms" "The reconstructed incident correctly has source='sms', not 'app'"

step "17. SOS-fallback envelope creates a real SOS and fans out identically to the app path"
CE_ENV7=$(uuid)
ENV7=$("$PHP_BIN" "$BACKEND_DIR/scripts/sms-envelope-build.php" --secret="$KEY1" --device-id="$DEV1" --type=sos --payload='{"latitude":12.97,"longitude":123.67}' --client-event-id="$CE_ENV7")
SOS_ENV_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/sos" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "$ENV7")
expect_eq "$SOS_ENV_STATUS" "200" "SOS-fallback envelope accepted"
SOS_ENV_ID=$(db_one "SELECT sos_id FROM tanod_sos WHERE client_event_id='$CE_ENV7';")
[ -n "$SOS_ENV_ID" ] && pass "SMS-originated SOS record exists" || fail "No SOS row for the SMS envelope"
SOS_ENV_FALLBACK=$(db_one "SELECT fallback_channel FROM tanod_sos WHERE sos_id=$SOS_ENV_ID;")
expect_eq "$SOS_ENV_FALLBACK" "sms" "fallback_channel correctly recorded as 'sms'"
SOS_ENV_NOTIF=$(db_one "SELECT COUNT(*) FROM notification WHERE sos_id=$SOS_ENV_ID;")
expect_eq "$SOS_ENV_NOTIF" "1" "The SMS-originated SOS triggered Rule 27's fan-out exactly like an app-originated one"

step "18. Inbound rows are logged to sms_log with barangay_id, transport=gsm_modem"
INBOUND_LOG_COUNT=$(db_one "SELECT COUNT(*) FROM sms_log WHERE direction='inbound' AND transport='gsm_modem' AND barangay_id=1;")
[ "$INBOUND_LOG_COUNT" -ge "3" ] 2>/dev/null && pass "At least 3 inbound sms_log rows recorded (duty_status/coord_ping x2/incident/sos), all tenant-scoped" || fail "Expected >=3 inbound sms_log rows, got $INBOUND_LOG_COUNT"

# ---------------------------------------------------------------------------
step "19. Internal outbound endpoints (dispatch-payload, priority-alert) — direct, isolated test"
OUT1_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/dispatch-payload" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "{\"phone_number\":\"+639170000002\",\"message\":\"test\",\"barangay_id\":1}")
expect_eq "$OUT1_STATUS" "502" "dispatch-payload with Semaphore unconfigured -> 502 (failed outcome, not a crash)"
OUT1_LOG=$(db_one "SELECT COUNT(*) FROM sms_log WHERE direction='outbound' AND message_type='dispatch' AND failure_reason='SEMAPHORE_NOT_CONFIGURED';")
[ "$OUT1_LOG" -ge "1" ] 2>/dev/null && pass "dispatch-payload wrote an sms_log row for the attempt" || fail "No sms_log row from dispatch-payload"

MISSING_PHONE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/priority-alert" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "{\"message\":\"test\",\"barangay_id\":1}")
expect_eq "$MISSING_PHONE" "400" "priority-alert without phone_number -> 400"
MISSING_BRGY=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/priority-alert" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d "{\"phone_number\":\"+639170000002\",\"message\":\"test\"}")
expect_eq "$MISSING_BRGY" "400" "priority-alert without barangay_id -> 400"

# ---------------------------------------------------------------------------
step "20. GET /sms/logs — role gating, tenant scoping, shape"
expect_eq "$(status_of GET /sms/logs "$TANOD_A")" "403" "Tanod cannot read the SMS log"
LOGS_BODY=$(body_of GET /sms/logs "$ADMIN")
expect_contains "$LOGS_BODY" '"items"' "GET /sms/logs (Admin) returns items"
expect_not_contains "$LOGS_BODY" 'sender_number' "Response never includes sender_number (not part of §6's documented item shape)"
expect_not_contains "$LOGS_BODY" 'receiver_number' "Response never includes receiver_number"
LOGS_TOTAL=$(echo "$LOGS_BODY" | jget total)
[ "$LOGS_TOTAL" -ge "5" ] 2>/dev/null && pass "GET /sms/logs total reflects the rows written across this run ($LOGS_TOTAL)" || fail "Unexpectedly low total: $LOGS_TOTAL"

FILTER_BODY=$(body_of GET "/sms/logs?message_type=sos&direction=inbound" "$ADMIN")
expect_contains "$FILTER_BODY" '"items"' "Filtered GET /sms/logs (message_type+direction) responds correctly"

echo
echo "=== Server log tail (for diagnosis only) ==="
tail -n 25 "$BACKEND_DIR/scripts/.s4p23chk-server.log" 2>/dev/null || true

echo
echo "================================================================"
echo "RESULT: $PASS passed, $FAIL failed."
echo "================================================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
