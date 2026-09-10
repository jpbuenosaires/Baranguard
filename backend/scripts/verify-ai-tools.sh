#!/usr/bin/env bash
# Baranguard — AI Tools verification (migration 0015).
#
# Covers the four assistants added with the AI Tools screen, using the
# same four-dimension structure verify-sprint7-pentest-incidents.sh
# established:
#
#   1. NO TOKEN     -> 401 everywhere
#   2. WRONG ROLE   -> 403 (each tool's gate differs, deliberately)
#   3. CROSS-TENANT -> 404, never 403
#   4. WRONG OWNER  -> 404 when polling someone else's job
#
# Plus the two things unique to this feature:
#
#   * THE QUEUE SURVIVES AN UNREACHABLE MODEL. The worker must put a
#     claimed job back to `queued`, NOT `failed`, when Ollama cannot be
#     reached (§2 Rule 5 / Rule 15). docs/REMAINING.md A2 calls this "the
#     single most important untested behaviour in the pipeline" — this
#     suite tests it directly, by pointing OLLAMA_URL at a dead port.
#
#   * TENANT SCOPING WITHOUT AN INCIDENT. Two of the four tools have
#     `incident_id IS NULL`, so `barangay_id` is the only thing scoping
#     them (§2 Rule 2). Asserted at the row level, not just the endpoint.
#
# NOT covered, and deliberately not faked: a real generate() completing.
# This workstation cannot run the model to completion (A2 — 300s timeout,
# zero bytes). Everything up to and including "worker claims the job and
# hands it back intact" is real here; the generate-and-complete path
# needs capable hardware.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage: bash backend/scripts/verify-ai-tools.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }
expect_contains() { case "$1" in *"$2"*) pass "$3";; *) fail "$3 — '$2' not found in: $1";; esac; }
expect_not_contains() { case "$1" in *"$2"*) fail "$3 — '$2' LEAKED in: $1";; *) pass "$3";; esac; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_aitools_check"
APP_USER="aitools_app"
APP_PASSWORD="AiTools!2026Check"
API_PORT="8176"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="AiTools#2026Pw"
RAW_TEXT="AITOOLSRAWNARRATIVE-Maria-Santos-09181234567-45 Rizal Street"
# Deliberately pointed at a closed port: "configured, but not reachable"
# is the state this suite needs, and the state this workstation is in.
DEAD_OLLAMA="http://127.0.0.1:59321"

echo "Baranguard AI Tools verification — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
db_one() { mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null; }
code_for() {
  local method="$1" url="$2" token="${3:-}" body="${4:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}"
}
body_for() {
  local method="$1" url="$2" token="${3:-}" body="${4:-}"
  local args=(-s -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}"
}
json_field() { "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["'"$1"'"] ?? "";'; }

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.aitools-server.log"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

# --------------------------------------------------------------------------
step "0. Setup — two barangays, every role, migration 0015 applied"
# --------------------------------------------------------------------------
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in 0001_baseline_schema 0002_seed_barangays 0003_shift_schedule_nullable_user 0004_blotter_revision \
         0005_sms_envelope_replay 0006_sms_log_barangay 0007_retention_columns 0008_incident_party_fields \
         0009_blotter_case_status 0010_incident_location_description 0011_user_suspension 0012_system_settings \
         0013_sms_manual_send 0014_incident_display_id 0015_ai_tools; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Migrations 0001-0015 applied"

ENUM_OK=$(db_one "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='ai_processing_log' AND COLUMN_NAME='task_type';")
expect_contains "$ENUM_OK" "sms_compose" "0015 widened task_type to include the tool types"
NULLABLE=$(db_one "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='ai_processing_log' AND COLUMN_NAME='incident_id';")
expect_eq "$NULLABLE" "YES" "0015 made ai_processing_log.incident_id nullable"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'t_admin','$HASH','T Admin','admin',1,UTC_TIMESTAMP()),
 (1,'t_admin_b','$HASH','T Admin Two','admin',1,UTC_TIMESTAMP()),
 (1,'t_sec','$HASH','T Secretary','secretary',1,UTC_TIMESTAMP()),
 (1,'t_pb','$HASH','T Punong','punong_barangay',1,UTC_TIMESTAMP()),
 (1,'t_tanod','$HASH','T Tanod','tanod',1,UTC_TIMESTAMP()),
 (2,'t_admin2','$HASH','T Admin B2','admin',1,UTC_TIMESTAMP()),
 (2,'t_sec2','$HASH','T Secretary B2','secretary',1,UTC_TIMESTAMP());
SQL

mysql_exec "$VALDB" <<SQL
-- Barangay 1, WITH an approved redaction (the classifier's prerequisite).
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, redacted_narrative,
                      redaction_approved_at, status, source, created_at, updated_at)
 VALUES (1,'theft','normal','$RAW_TEXT','A resident reported a theft at [ADDRESS].',
         UTC_TIMESTAMP(),'pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP());
-- Barangay 1, NO approved redaction.
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at)
 VALUES (1,'fire','high','$RAW_TEXT','pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP());
-- Barangay 2. Nothing in barangay 1 may see, confirm, or act on it.
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at)
 VALUES (2,'vandalism','normal','OTHER BARANGAY NARRATIVE','pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP());
SQL
INC_OK=$(db_one "SELECT incident_id FROM incident WHERE barangay_id=1 AND redaction_approved_at IS NOT NULL LIMIT 1;")
INC_NOAPPROVE=$(db_one "SELECT incident_id FROM incident WHERE barangay_id=1 AND redaction_approved_at IS NULL LIMIT 1;")
INC_B2=$(db_one "SELECT incident_id FROM incident WHERE barangay_id=2 LIMIT 1;")
pass "Seeded incidents #$INC_OK (approved), #$INC_NOAPPROVE (unapproved), #$INC_B2 (barangay 2)"

( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="aitools-verify-secret-key-not-real-0123456" \
  OLLAMA_URL="$DEAD_OLLAMA" OLLAMA_MODEL="verify-fake-model" \
  "$PHP_BIN" -S 127.0.0.1:$API_PORT -t public public/dev-router.php > "$BACKEND_DIR/scripts/.aitools-server.log" 2>&1 ) &
SERVER_PID=$!
sleep 2

token_for() {
  curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["token"] ?? "";'
}
ADMIN=$(token_for t_admin); ADMIN_B=$(token_for t_admin_b); SEC=$(token_for t_sec)
PB=$(token_for t_pb); TANOD=$(token_for t_tanod); ADMIN2=$(token_for t_admin2)
[ -n "$ADMIN" ] && [ -n "$SEC" ] && [ -n "$PB" ] && pass "Tokens acquired for every role" \
  || { fail "Login failed — see .aitools-server.log"; exit 1; }

# --------------------------------------------------------------------------
step "1. DIMENSION 1 — no credentials reach nothing (401 everywhere)"
# --------------------------------------------------------------------------
while read -r method path; do
  [ -z "$method" ] && continue
  expect_eq "$(code_for "$method" "$BASE_URL${path}" "" '{}')" "401" "Unauthenticated $method $path"
done <<ENDPOINTS
POST /incidents/$INC_OK/ai-tools/blotter-assist
POST /incidents/$INC_OK/ai-tools/classify
POST /ai-tools/sms-compose
POST /ai-tools/threat-analysis
GET /ai-tools/jobs/1
GET /ai-tools/availability
ENDPOINTS

# --------------------------------------------------------------------------
step "2. DIMENSION 2 — wrong role is refused (each tool's gate differs)"
# --------------------------------------------------------------------------
# Blotter Assistant — Secretary ONLY (it reads raw_narrative, §2 Rule 1).
expect_eq "$(code_for POST "$BASE_URL/incidents/$INC_OK/ai-tools/blotter-assist" "$ADMIN" '{}')" "403" "Admin cannot run Blotter Assistant"
expect_eq "$(code_for POST "$BASE_URL/incidents/$INC_OK/ai-tools/blotter-assist" "$PB" '{}')" "403" "Punong Barangay cannot run Blotter Assistant"
expect_eq "$(code_for POST "$BASE_URL/incidents/$INC_OK/ai-tools/blotter-assist" "$TANOD" '{}')" "403" "Tanod cannot run Blotter Assistant"

# Classifier — Admin + Secretary (reads only the approved redaction).
expect_eq "$(code_for POST "$BASE_URL/incidents/$INC_OK/ai-tools/classify" "$PB" '{}')" "403" "Punong Barangay cannot run Classifier"
expect_eq "$(code_for POST "$BASE_URL/incidents/$INC_OK/ai-tools/classify" "$TANOD" '{}')" "403" "Tanod cannot run Classifier"

# SMS Composer — Admin only, matching /sms/send's own gate.
expect_eq "$(code_for POST "$BASE_URL/ai-tools/sms-compose" "$SEC" '{"prompt":"flood advisory"}')" "403" "Secretary cannot run SMS Composer"
expect_eq "$(code_for POST "$BASE_URL/ai-tools/sms-compose" "$PB" '{"prompt":"flood advisory"}')" "403" "Punong Barangay cannot run SMS Composer"
expect_eq "$(code_for POST "$BASE_URL/ai-tools/sms-compose" "$TANOD" '{"prompt":"flood advisory"}')" "403" "Tanod cannot run SMS Composer"

# Threat Analyzer — Admin + Punong Barangay (oversight-shaped).
expect_eq "$(code_for POST "$BASE_URL/ai-tools/threat-analysis" "$SEC" '{}')" "403" "Secretary cannot run Threat Analyzer"
expect_eq "$(code_for POST "$BASE_URL/ai-tools/threat-analysis" "$TANOD" '{}')" "403" "Tanod cannot run Threat Analyzer"

# Availability is readable by the three roles the screen serves.
expect_eq "$(code_for GET "$BASE_URL/ai-tools/availability" "$ADMIN")" "200" "Admin may read availability"
expect_eq "$(code_for GET "$BASE_URL/ai-tools/availability" "$SEC")" "200" "Secretary may read availability"
expect_eq "$(code_for GET "$BASE_URL/ai-tools/availability" "$PB")" "200" "Punong Barangay may read availability"
expect_eq "$(code_for GET "$BASE_URL/ai-tools/availability" "$TANOD")" "403" "Tanod cannot read availability"

# --------------------------------------------------------------------------
step "3. DIMENSION 3 — cross-tenant is 404, never 403"
# --------------------------------------------------------------------------
# A 403 would confirm barangay 2's incident EXISTS. It must not.
expect_eq "$(code_for POST "$BASE_URL/incidents/$INC_B2/ai-tools/blotter-assist" "$SEC" '{}')" "404" "Secretary cannot reach barangay 2's incident (Blotter Assistant)"
expect_eq "$(code_for POST "$BASE_URL/incidents/$INC_B2/ai-tools/classify" "$ADMIN" '{}')" "404" "Admin cannot reach barangay 2's incident (Classifier)"
expect_eq "$(code_for POST "$BASE_URL/incidents/999999/ai-tools/classify" "$ADMIN" '{}')" "404" "A nonexistent incident is 404"

# --------------------------------------------------------------------------
step "4. Business rules — the prerequisites are real"
# --------------------------------------------------------------------------
expect_eq "$(code_for POST "$BASE_URL/incidents/$INC_NOAPPROVE/ai-tools/classify" "$ADMIN" '{}')" "409" "Classifier refuses an incident with no approved redaction"
expect_eq "$(code_for POST "$BASE_URL/ai-tools/sms-compose" "$ADMIN" '{}')" "400" "SMS Composer requires a prompt"
expect_eq "$(code_for POST "$BASE_URL/ai-tools/sms-compose" "$ADMIN" '{"prompt":"   "}')" "400" "SMS Composer rejects a blank prompt"
LONG=$("$PHP_BIN" -r 'echo str_repeat("a", 2001);')
expect_eq "$(code_for POST "$BASE_URL/ai-tools/sms-compose" "$ADMIN" "{\"prompt\":\"$LONG\"}")" "400" "SMS Composer rejects an over-long prompt"

# --------------------------------------------------------------------------
step "5. Enqueue really queues — and carries its tenant"
# --------------------------------------------------------------------------
SMS_JOB=$(body_for POST "$BASE_URL/ai-tools/sms-compose" "$ADMIN" '{"prompt":"Baha sa Purok 3, iwasan ang daan"}' | json_field job_id)
[ -n "$SMS_JOB" ] && pass "SMS Composer returned job id $SMS_JOB" || fail "SMS Composer returned no job id"
expect_eq "$(db_one "SELECT status FROM ai_processing_log WHERE log_id=$SMS_JOB;")" "queued" "SMS job row is 'queued'"
expect_eq "$(db_one "SELECT task_type FROM ai_processing_log WHERE log_id=$SMS_JOB;")" "sms_compose" "SMS job row carries task_type"
expect_eq "$(db_one "SELECT IFNULL(incident_id,'NULL') FROM ai_processing_log WHERE log_id=$SMS_JOB;")" "NULL" "SMS job has no incident (it is not incident-scoped)"
expect_eq "$(db_one "SELECT barangay_id FROM ai_processing_log WHERE log_id=$SMS_JOB;")" "1" "SMS job carries barangay_id — the only thing scoping it (Rule 2)"
REQ_BY=$(db_one "SELECT u.username FROM ai_processing_log a JOIN user u ON u.user_id=a.requested_by_user_id WHERE a.log_id=$SMS_JOB;")
expect_eq "$REQ_BY" "t_admin" "SMS job records who requested it"

THREAT_JOB=$(body_for POST "$BASE_URL/ai-tools/threat-analysis" "$PB" '{}' | json_field job_id)
expect_eq "$(db_one "SELECT task_type FROM ai_processing_log WHERE log_id=$THREAT_JOB;")" "threat_analysis" "Threat Analyzer queued for Punong Barangay"

ASSIST_JOB=$(body_for POST "$BASE_URL/incidents/$INC_OK/ai-tools/blotter-assist" "$SEC" '{}' | json_field job_id)
expect_eq "$(db_one "SELECT incident_id FROM ai_processing_log WHERE log_id=$ASSIST_JOB;")" "$INC_OK" "Blotter Assistant job IS incident-scoped"
expect_eq "$(db_one "SELECT barangay_id FROM ai_processing_log WHERE log_id=$ASSIST_JOB;")" "1" "Incident-scoped job still carries barangay_id"

CLASSIFY_JOB=$(body_for POST "$BASE_URL/incidents/$INC_OK/ai-tools/classify" "$ADMIN" '{}' | json_field job_id)
expect_eq "$(db_one "SELECT status FROM ai_processing_log WHERE log_id=$CLASSIFY_JOB;")" "queued" "Classifier job is queued"

# Rule 8: audit metadata is identifiers and statuses only.
AUDIT_META=$(db_one "SELECT metadata_json FROM audit_log WHERE action='ai_tool_queued' ORDER BY audit_id DESC LIMIT 1;")
expect_contains "$AUDIT_META" "task_type" "Audit row records the task type"
expect_not_contains "$AUDIT_META" "Baha sa Purok" "Audit metadata does NOT contain the operator's prompt (Rule 8)"

# --------------------------------------------------------------------------
step "6. DIMENSION 4 — a job belongs to the person who asked for it"
# --------------------------------------------------------------------------
expect_eq "$(code_for GET "$BASE_URL/ai-tools/jobs/$SMS_JOB" "$ADMIN")" "200" "The requester may poll their own job"
expect_eq "$(code_for GET "$BASE_URL/ai-tools/jobs/$SMS_JOB" "$ADMIN_B")" "404" "A different same-barangay Admin cannot poll it"
expect_eq "$(code_for GET "$BASE_URL/ai-tools/jobs/$ASSIST_JOB" "$ADMIN")" "404" "An Admin cannot poll a Secretary's Blotter Assistant job"
expect_eq "$(code_for GET "$BASE_URL/ai-tools/jobs/$SMS_JOB" "$ADMIN2")" "404" "Another barangay's Admin cannot poll it"
expect_eq "$(code_for GET "$BASE_URL/ai-tools/jobs/999999" "$ADMIN")" "404" "A nonexistent job is 404"

# The polling endpoint must never become a narrative side-channel.
JOB_BODY=$(body_for GET "$BASE_URL/ai-tools/jobs/$ASSIST_JOB" "$SEC")
expect_not_contains "$JOB_BODY" "Maria-Santos" "Job response does not leak raw narrative (Rule 1)"
expect_not_contains "$JOB_BODY" "09181234567" "Job response does not leak a contact number"

# --------------------------------------------------------------------------
step "7. Availability reports honestly when the model is unreachable"
# --------------------------------------------------------------------------
AVAIL=$(body_for GET "$BASE_URL/ai-tools/availability" "$ADMIN" | json_field ollama)
expect_eq "$AVAIL" "unhealthy" "Availability reports 'unhealthy' against a dead Ollama port (not a fabricated green)"

# --------------------------------------------------------------------------
step "8. THE QUEUE SURVIVES AN UNREACHABLE MODEL (§2 Rule 5 / Rule 15)"
# --------------------------------------------------------------------------
# docs/REMAINING.md A2 names this the single most important untested
# behaviour in the pipeline: a job must come back as `queued`, never
# `failed`, when the model cannot be reached. Nothing about the job is
# wrong — the workstation just was not ready.
QUEUED_BEFORE=$(db_one "SELECT COUNT(*) FROM ai_processing_log WHERE status='queued';")
( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" \
  OLLAMA_URL="$DEAD_OLLAMA" OLLAMA_MODEL="verify-fake-model" OLLAMA_TIMEOUT_SECONDS="5" \
  "$PHP_BIN" scripts/ai-worker.php --once ) > "$BACKEND_DIR/scripts/.aitools-worker.log" 2>&1
WORKER_OUT=$(cat "$BACKEND_DIR/scripts/.aitools-worker.log")
rm -f "$BACKEND_DIR/scripts/.aitools-worker.log"

QUEUED_AFTER=$(db_one "SELECT COUNT(*) FROM ai_processing_log WHERE status='queued';")
FAILED_AFTER=$(db_one "SELECT COUNT(*) FROM ai_processing_log WHERE status='failed';")
PROCESSING_AFTER=$(db_one "SELECT COUNT(*) FROM ai_processing_log WHERE status='processing';")

expect_eq "$QUEUED_AFTER" "$QUEUED_BEFORE" "Every job is still 'queued' after the worker met a dead model"
expect_eq "$FAILED_AFTER" "0" "No job was marked 'failed' — unreachable is not invalid"
expect_eq "$PROCESSING_AFTER" "0" "No job was abandoned in 'processing'"
expect_contains "$WORKER_OUT" "requeued" "Worker reported requeueing rather than failing"
expect_not_contains "$WORKER_OUT" "Baha sa Purok" "Worker output does not echo job content"

# --------------------------------------------------------------------------
step "9. Retention reaches tool jobs (they have no incident to follow)"
# --------------------------------------------------------------------------
# purgeAiProcessingLogs() INNER JOINs `incident`, so a NULL-incident row
# is invisible to it. Without the dedicated rule these would never expire.
mysql_exec "$VALDB" -e "UPDATE ai_processing_log SET created_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 DAY) WHERE log_id=$SMS_JOB;"
PURGE_OUT=$( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" \
  "$PHP_BIN" scripts/retention-job.php --only=ai_tool_job 2>&1 )
STILL_THERE=$(db_one "SELECT COUNT(*) FROM ai_processing_log WHERE log_id=$SMS_JOB;")
expect_eq "$STILL_THERE" "0" "A 120-day-old tool job is purged by the 90-day rule"
RECENT_LEFT=$(db_one "SELECT COUNT(*) FROM ai_processing_log WHERE log_id=$THREAT_JOB;")
expect_eq "$RECENT_LEFT" "1" "A recent tool job is left alone"
INCIDENT_JOB_LEFT=$(db_one "SELECT COUNT(*) FROM ai_processing_log WHERE log_id=$ASSIST_JOB;")
expect_eq "$INCIDENT_JOB_LEFT" "1" "An incident-scoped job is NOT caught by the tool rule (it follows its case)"

# --------------------------------------------------------------------------
step "10. The removed walk-in endpoint is really gone"
# --------------------------------------------------------------------------
# 405, not 404: `/blotter` is still a real path — GET still lists records
# for the Analytics case-status widget — so the router matches the path and
# then rejects the method. That is the correct answer for a verb that was
# removed from a path that remains.
expect_eq "$(code_for POST "$BASE_URL/blotter" "$SEC" '{"incident_type":"theft","narrative_summary":"walk-in"}')" "405" "POST /blotter (walk-in entry) is gone — path remains, verb refused"
expect_eq "$(code_for GET "$BASE_URL/blotter" "$SEC")" "200" "GET /blotter still serves the records query"

echo
echo "=============================================="
echo "  AI Tools verification: $PASS passed, $FAIL failed"
echo "=============================================="
echo "NOT covered here (and not faked): a real generate() completing."
echo "This workstation cannot run the model to completion — see"
echo "docs/REMAINING.md A2. Everything up to 'worker claims the job and"
echo "hands it back intact' is genuinely exercised above."
[ "$FAIL" -eq 0 ] || exit 1
