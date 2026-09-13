#!/usr/bin/env bash
# Baranguard — F9 (last item) validation: audit_log idempotency-key index
# (docs/REMAINING.md §F9 · migration 0019 · docs/REFERENCE.md §4).
#
# Before this fix, SmsController::broadcast()'s idempotency replay lookup
# matched `JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.idempotency_key'))`
# in the WHERE clause — a full scan of every audit_log row for
# (barangay_id, action) on every single broadcast call, since audit_log
# is append-only and grows without bound. Migration 0019 adds a VIRTUAL
# generated column + index; SmsController.php now queries the column
# directly (MariaDB does not rewrite the bare expression to use an index
# on a matching generated column the way MySQL 8's functional indexes do).
#
# This script proves BOTH halves: the schema change (EXPLAIN shows the
# new index is actually used, not just present) and that broadcast's
# functional behavior — a retry replays instead of re-sending — is
# unchanged by the fix.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard`/`baranguard_uiseed` databases and backend/.env are
# never touched by the HTTP-server portion of this script (the schema
# section below runs directly against `root` on a throwaway database
# name, same isolation as every other verify-*.sh in this repo).
#
# Usage (from a Git Bash prompt):
#   bash backend/scripts/verify-f9-sms-broadcast-idempotency-index.sh

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
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_f9_check"
APP_USER="f9chk_app"
APP_PASSWORD="F9Chk!2026xx"
API_PORT="8129"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="F9#2026Pw"

echo "Baranguard F9 (audit_log idempotency index) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -f "$BACKEND_DIR/scripts/.f9chk-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER'."
  echo "Your real databases and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (FULL migration chain incl. 0019) + accounts"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in 0001_baseline_schema 0002_seed_barangays 0003_shift_schedule_nullable_user 0004_blotter_revision \
         0005_sms_envelope_replay 0006_sms_log_barangay 0007_retention_columns 0008_incident_party_fields \
         0009_blotter_case_status 0010_incident_location_description 0011_user_suspension 0012_system_settings \
         0013_sms_manual_send 0014_incident_display_id 0015_ai_tools \
         0016_retention_hold_and_device_scrub \
         0017_health_check_log \
         0018_sms_subscriber \
         0019_audit_log_idempotency_index; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Migrations 0001-0019 applied"

COLTYPE=$(mysql_exec -N -s "$VALDB" -e "SELECT EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='audit_log' AND COLUMN_NAME='idempotency_key';")
expect_contains "$COLTYPE" "VIRTUAL GENERATED" "audit_log.idempotency_key exists as a VIRTUAL generated column"

IDXCOUNT=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='audit_log' AND INDEX_NAME='idx_audit_log_idempotency';")
expect_eq "$IDXCOUNT" "3" "idx_audit_log_idempotency covers all 3 columns (barangay_id, action, idempotency_key)"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, contact_number, created_at) VALUES
  (1, 'f9_admin', '$HASH', 'F9 Admin', 'admin', 1, '+639170000001', UTC_TIMESTAMP()),
  (1, 'f9_tanod',  '$HASH', 'F9 Tanod',  'tanod', 1, '+639170000002', UTC_TIMESTAMP());
SQL
pass "Seeded admin + one on_duty-eligible tanod (barangay 1)"

step "2. EXPLAIN proves the new query shape actually USES the index (not just present)"
mysql_exec "$VALDB" -e "
SET @i := 0;
INSERT INTO audit_log (barangay_id, action, entity_type, entity_id, metadata_json, created_at)
SELECT 1, 'sms_broadcast_sent', 'user', NULL,
       JSON_OBJECT('idempotency_key', UUID(), 'recipient_count', 1, 'sent', 1, 'failed', 0),
       UTC_TIMESTAMP()
FROM information_schema.columns a, information_schema.columns b
LIMIT 300;
"
OLD_PLAN=$(mysql_exec "$VALDB" -e "EXPLAIN SELECT metadata_json FROM audit_log WHERE barangay_id=1 AND action='sms_broadcast_sent' AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'\$.idempotency_key'))='does-not-exist' LIMIT 1;")
NEW_PLAN=$(mysql_exec "$VALDB" -e "EXPLAIN SELECT metadata_json FROM audit_log WHERE barangay_id=1 AND action='sms_broadcast_sent' AND idempotency_key='does-not-exist' LIMIT 1;")
echo "  old plan: $(echo "$OLD_PLAN" | tail -1)"
echo "  new plan: $(echo "$NEW_PLAN" | tail -1)"
expect_contains "$OLD_PLAN" "	ALL	" "OLD query (bare JSON_EXTRACT) is a full scan (type=ALL) — this was the bug"
expect_contains "$NEW_PLAN" "idx_audit_log_idempotency" "NEW query (generated column) actually picks idx_audit_log_idempotency as its key"
mysql_exec "$VALDB" -e "DELETE FROM audit_log WHERE action='sms_broadcast_sent';" >/dev/null

step "3. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.f9chk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ADMIN_TOKEN=$(login_as f9_admin)
if [ -n "$ADMIN_TOKEN" ]; then
  pass "Logged in as admin (env override reached the disposable DB)"
else
  fail "Login failed — the API is probably talking to the wrong database"
  exit 1
fi

body_of() { curl -s -X "$1" "${BASE_URL}${2}" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -H "Idempotency-Key: ${4:-}" -d "${5:-}"; }
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["'"$1"'"] ?? "";'; }
audit_count() { mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM audit_log WHERE action='sms_broadcast_sent';"; }

step "4. First broadcast with a real key actually sends (or records failed — no gateway configured — either way, exactly once)"
KEY1="33333333-3333-4333-8333-333333333333"
RESP1=$(body_of POST "/sms/broadcast" "$ADMIN_TOKEN" "$KEY1" '{"message":"Test advisory one.","scope":"role","role":"tanod"}')
RECIPIENTS1=$(echo "$RESP1" | jget recipient_count)
expect_eq "$RECIPIENTS1" "1" "First broadcast reaches the one seeded tanod"
expect_eq "$(audit_count)" "1" "Exactly ONE sms_broadcast_sent audit row after the first call"

step "5. THE ACTUAL FIX BEING PROVEN: retry with the SAME key replays, does not re-send"
RESP2=$(body_of POST "/sms/broadcast" "$ADMIN_TOKEN" "$KEY1" '{"message":"Test advisory one.","scope":"role","role":"tanod"}')
RECIPIENTS2=$(echo "$RESP2" | jget recipient_count)
expect_eq "$RECIPIENTS2" "$RECIPIENTS1" "Replayed broadcast returns the SAME recorded recipient_count"
expect_eq "$(audit_count)" "1" "STILL exactly ONE sms_broadcast_sent audit row — the retry did not fan out again"
SMSLOG_COUNT=$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM sms_log;")
expect_eq "$SMSLOG_COUNT" "1" "sms_log still has exactly ONE row — the replay never called the gateway a second time"

step "6. A DIFFERENT key is a genuinely new broadcast"
KEY2="44444444-4444-4444-8444-444444444444"
RESP3=$(body_of POST "/sms/broadcast" "$ADMIN_TOKEN" "$KEY2" '{"message":"Test advisory two.","scope":"role","role":"tanod"}')
expect_eq "$(echo "$RESP3" | jget recipient_count)" "1" "A fresh Idempotency-Key sends a genuinely new broadcast"
expect_eq "$(audit_count)" "2" "A genuinely new key writes a SECOND audit row (2 total)"

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
