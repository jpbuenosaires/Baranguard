#!/usr/bin/env bash
# Messaging hardening (audit 2026-10-28, stream 03): inbound human SMS stored,
# honest outbound status (pending vs failed), broadcast outbox + dedupe, SOS
# escalation, readable message content, FCM data-only for critical types,
# dispatch-offers server_time, ingest-daemon head-of-line guard.
# Disposable DB + throwaway port; never touches real databases.
#   bash backend/scripts/verify-messaging-hardening.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }
expect_contains() { case "$1" in *"$2"*) pass "$3";; *) fail "$3 — expected to find '$2' in: $1";; esac; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
# Port default: prefer backend/.env's DB_PORT over the stock-XAMPP
# 3306 guess -- this machine's own XAMPP MariaDB runs on a non-default
# port (an unrelated MySQL80 service owns 3306 here; see
# docs/REFERENCE.md Sec 8), and .env is the one place that's recorded.
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_msg_check"
APP_USER="msgchk_app"
APP_PASSWORD="MsgChk!2026xx"
API_PORT="8137"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Msg#2026Pw"

echo "Baranguard F9 (audit_log idempotency index) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  # Explicit XAMPP path checked FIRST, not `command -v`: this machine
  # (and possibly others) has an unrelated same-named binary earlier on
  # PATH -- a separate MySQL Server install whose client can silently
  # fail against XAMPP's own MariaDB (see docs/REFERENCE.md Sec 8) --
  # that `command -v` would otherwise prefer over the XAMPP install
  # these scripts are meant for. PATH is now only a fallback.
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
  rm -f "$BACKEND_DIR/scripts/.msgchk-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER'."
  echo "Your real databases and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }


step "1. Disposable schema (FULL migration chain) + accounts"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort | awk -v s=0001_baseline_schema '$0 >= s'); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain applied"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, contact_number, created_at) VALUES
  (1, 'msg_admin', '$HASH', 'Msg Admin', 'admin', 1, '+639170000001', UTC_TIMESTAMP()),
  (1, 'msg_tanod', '$HASH', 'Msg Tanod', 'tanod', 1, '+639170000002', UTC_TIMESTAMP()),
  (1, 'msg_sec',   '$HASH', 'Msg Secretary', 'secretary', 1, '+639170000003', UTC_TIMESTAMP()),
  (1, 'msg_pb',    '$HASH', 'Msg PB', 'punong_barangay', 1, '+639170000004', UTC_TIMESTAMP());
SQL
pass "Seeded admin, tanod, secretary, punong barangay"

export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30 CORS_ALLOWED_ORIGIN='*'
export INTERNAL_SERVICE_TOKEN="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export DEVICE_SECRET_MASTER_KEY="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export FCM_SERVICE_ACCOUNT_PATH='' GSM_GATEWAY_ENABLED=false GATEWAY_BARANGAY_ID=1

step "2. Service-level checks (inbound text, outbound honesty, outbox, content, SOS escalation, FCM payload)"
PHP_SCRIPT="$BACKEND_DIR/scripts/verify-messaging-hardening.php"
command -v cygpath >/dev/null 2>&1 && PHP_SCRIPT="$(cygpath -m "$PHP_SCRIPT")"
PHP_OUT=$("$PHP_BIN" "$PHP_SCRIPT" 2>&1)
echo "$PHP_OUT"
PHP_PASS=$(echo "$PHP_OUT" | grep -c '^\[PASS\]'); PHP_FAIL=$(echo "$PHP_OUT" | grep -c '^\[FAIL\]')
PASS=$((PASS+PHP_PASS)); FAIL=$((FAIL+PHP_FAIL))
echo "$PHP_OUT" | grep -q 'ALL PHP CHECKS PASSED' || fail "PHP companion did not finish cleanly"

step "3. Start API (dev-router: /api/v1 + /internal)"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" "$BACKEND_DIR/public/dev-router.php" >"$BACKEND_DIR/scripts/.msgchk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2
INTERNAL_URL="http://127.0.0.1:${API_PORT}/internal"
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "";'; }
uuid() { "$PHP_BIN" -r '$b=random_bytes(16); $b[6]=chr((ord($b[6])&15)|64); $b[8]=chr((ord($b[8])&63)|128); echo vsprintf("%s%s-%s-%s-%s-%s%s%s", str_split(bin2hex($b),4));'; }
ADMIN_TOKEN=$(curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"msg_admin\",\"password\":\"$TEST_PW\"}" | jget token)
[ -n "$ADMIN_TOKEN" ] && pass "Logged in as admin" || { fail "Login failed"; exit 1; }
# api METHOD PATH [JSON_BODY] [IDEMPOTENCY_KEY]
api() {
  local key="${4:-$(uuid)}"
  if [ -n "${3:-}" ]; then
    curl -s -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: $key" -d "$3"
  else
    curl -s -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: $key"
  fi
}
unread_of() { api GET /sms/conversations | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); foreach($d["items"] as $i){ if($i["phone_number"]===$argv[1]) echo $i["unread_count"]; }' "$1"; }

step "4. Inbound human text over the internal endpoint, then Conversations"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/inbound-text" -H "X-Internal-Token: $INTERNAL_SERVICE_TOKEN" -H "Content-Type: application/json" -d '{"sender_number":"+639178889999","body":"Saan po ang tanod?","sms_key":"99:1"}')
expect_eq "$CODE" "200" "POST /internal/sms/inbound-text stores a human text"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INTERNAL_URL/sms/inbound-text" -H "Content-Type: application/json" -d '{"sender_number":"+639178889999","body":"x","sms_key":"99:2"}')
expect_eq "$CODE" "401" "inbound-text without the internal token is refused"
CONV=$(api GET /sms/conversations)
expect_contains "$CONV" "+639178889999" "Conversations now lists the citizen's number"
expect_eq "$(unread_of +639178889999)" "1" "unread_count is real (1)"
THREAD=$(api GET "/sms/conversations/%2B639178889999/messages")
expect_contains "$THREAD" "Saan po ang tanod?" "thread shows the inbound body"
api PATCH "/sms/conversations/%2B639178889999/resolve" >/dev/null
expect_eq "$(unread_of +639178889999)" "0" "Mark resolved clears unread"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/sms/logs?message_type=manual" -H "Authorization: Bearer $ADMIN_TOKEN")
expect_eq "$CODE" "200" "Activity Log 'manual' filter no longer 400s"

step "5. Thread returns the NEWEST 200 messages"
mysql_exec "$VALDB" -e "INSERT INTO sms_log (barangay_id, sender_number, transport, message_type, direction, status, received_at, message_body, created_at)
  SELECT 1, '+639170001111', 'gsm_modem', 'manual', 'inbound', 'received', UTC_TIMESTAMP(), CONCAT('msg-', n), UTC_TIMESTAMP() + INTERVAL n SECOND
  FROM (SELECT a.N + b.N*10 + c.N*100 AS n FROM (SELECT 0 N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
        (SELECT 0 N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
        (SELECT 0 N UNION SELECT 1 UNION SELECT 2) c) t WHERE n < 250;"
THREAD=$(api GET "/sms/conversations/%2B639170001111/messages")
TOT=$(echo "$THREAD" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["items"]), ":", $d["items"][0]["message_body"], ":", end($d["items"])["message_body"];')
expect_eq "$TOT" "200:msg-50:msg-249" "250 stored -> newest 200 returned, oldest-first (msg-50 .. msg-249)"

step "6. Broadcast is queued (not sent in the request), deduped, and subscribers get a STOP line"
mysql_exec "$VALDB" -e "INSERT INTO sms_subscriber (barangay_id, contact_number, consent_at, consent_source, created_at) VALUES (1,'09176660001',UTC_TIMESTAMP(),'staff_entry',UTC_TIMESTAMP()),(1,'09176660002',UTC_TIMESTAMP(),'staff_entry',UTC_TIMESTAMP());"
R1=$(api POST /sms/broadcast '{"message":"Advisory: road closed.","scope":"subscribers"}')
expect_eq "$(echo "$R1" | jget queued)" "2" "broadcast queues 2 recipients"
expect_eq "$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM sms_log WHERE status='queued' AND message_body LIKE 'Advisory: road closed.%'")" "2" "2 queued sms_log rows (nothing sent inside the request)"
expect_contains "$(mysql_exec -N -s "$VALDB" -e "SELECT message_body FROM sms_log WHERE status='queued' AND message_body LIKE 'Advisory%' LIMIT 1")" "Reply STOP to unsubscribe." "subscriber broadcast carries the opt-out line"
R2=$(api POST /sms/broadcast '{"message":"Advisory: road closed.","scope":"subscribers"}')
expect_eq "$(echo "$R2" | jget duplicate)" "1" "same body+audience under a NEW key within 10 min is confirmed as a duplicate"
expect_eq "$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM sms_log WHERE message_body LIKE 'Advisory: road closed.%'")" "2" "the duplicate queued nothing more"

step "7. Notification worker drains the outbox (gateway not configured -> honest failed)"
( cd "$BACKEND_DIR" && "$PHP_BIN" scripts/notification-worker.php --once ) | sed 's/^/  /'
expect_eq "$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM sms_log WHERE message_body LIKE 'Advisory: road closed.%' AND status='failed' AND failure_reason='GSM_GATEWAY_NOT_CONFIGURED'")" "2" "queued rows were processed by notification-worker --once"

step "8. dispatch-offers list returns server_time"
SRV=$(api GET /dispatch-offers | jget server_time)
case "$SRV" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) pass "admin list has ISO-8601 UTC server_time ($SRV)";; *) fail "server_time missing/odd: $SRV";; esac
echo "  (tanod branch shares the same send call; covered by verify-dispatch-offers.sh)"

step "9. Ingest daemon: human text stored, bad envelope does not block the next message"
FIX="$BACKEND_DIR/scripts/.msgchk-inbox.txt"
printf '%s\n' \
  'Row: 0 _id=1, address=+639175551234, date=1700000000000, body=Magandang gabi po' \
  'Row: 1 _id=2, address=+639175551234, date=1700000001000, body={"message_type":"sos","version":"1"}' \
  'Row: 2 _id=3, address=+639175559999, date=1700000002000, body=Ikatlo' > "$FIX"
STATE="$BACKEND_DIR/storage/gsm-ingest-state.json"; [ -f "$STATE" ] && cp "$STATE" "$STATE.msgchk.bak"; rm -f "$STATE"
export INTERNAL_SMS_BASE_URL="http://127.0.0.1:${API_PORT}"
( cd "$BACKEND_DIR" && "$PHP_BIN" scripts/gsm-ingest-daemon.php --once --source="$FIX" ) | sed 's/^/  /'
LAST=$(grep -o '"last_id": *[0-9]*' "$STATE" | grep -o '[0-9]*$')
expect_eq "$LAST" "3" "daemon advanced past the rejected envelope to _id 3 (422 is terminal, later texts still processed)"
expect_eq "$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM sms_log WHERE sender_number='+639175551234' AND status='received' AND message_body='Magandang gabi po'")" "1" "daemon stored the human text"
expect_eq "$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM sms_log WHERE status='rejected' AND failure_reason='ENVELOPE_REJECTED_SOS' AND message_body IS NULL AND sender_number='+639175551234'")" "1" "the dropped envelope was recorded as rejected, body not stored"
expect_eq "$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM sms_log WHERE sender_number='+639175559999' AND message_body='Ikatlo'")" "1" "the message after the bad envelope was not blocked"
rm -f "$FIX" "$STATE"; [ -f "$STATE.msgchk.bak" ] && mv "$STATE.msgchk.bak" "$STATE"

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
