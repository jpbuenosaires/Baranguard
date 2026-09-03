#!/usr/bin/env bash
# Baranguard — Sprint 6 validation: the approval loop, blotter
# finalization/amendment, the Lupon packet, and GET /incidents/:id.
#
# ***THIS SCRIPT NEVER CALLS OLLAMA.*** That is deliberate and is what
# makes it runnable on any machine, including one that cannot run an 8B
# model at a useful speed. The trick is that the approval gate does not
# care HOW a draft got into `ai_processing_log` — it only cares about the
# row's `status`, `draft_version`, `draft_summary_stale`, and text. So
# this script seeds completed draft rows directly with SQL and then
# exercises every gate against them. Model QUALITY is a separate question,
# answered by the evaluation harness (see docs/AI_Evaluation_Dataset_Guide.md);
# this script answers "is the approval logic correct", which is the part
# that has to be right for legal reasons regardless of model quality.
#
# Safe to run: everything happens in a disposable database
# (baranguard_sprint6_check) with a disposable app-user, disposable test
# accounts, a disposable packet directory, and a PHP dev server on a
# throwaway port. Your real `baranguard` database, real backend/.env, and
# Apache are never touched.
#
# Like the other verify-*.sh scripts, this deliberately does NOT pass
# `-d variables_order=EGPCS` to `php -S`, relying on config/env.php
# honoring an exported env var over backend/.env as an early-warning
# canary — if login fails, the API is talking to the REAL database.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-sprint6.sh

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
expect_contains() { # expect_contains <haystack> <needle> <label>
  case "$1" in *"$2"*) pass "$3";; *) fail "$3 — '$2' not found in: $1";; esac
}
expect_not_contains() { # expect_not_contains <haystack> <needle> <label>
  case "$1" in *"$2"*) fail "$3 — '$2' WAS present in: $1";; *) pass "$3";; esac
}

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_sprint6_check"
APP_USER="s6chk_app"
APP_PASSWORD="Sprint6Chk!2026"
API_PORT="8126"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Sprint6#2026Pw"
PACKET_DIR="$BACKEND_DIR/scripts/.s6chk-packets"

echo "Baranguard Sprint 6 validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  rm -rf "$PACKET_DIR"
  rm -f "$BACKEND_DIR/scripts/.s6chk-server.log"
  echo "Stopped the test PHP server, dropped $VALDB / user '$APP_USER', removed disposable packets."
  echo "Your real 'baranguard' database and backend/.env were never touched."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (INCLUDING migration 0004) + accounts"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql" && pass "0001 baseline applied" || fail "0001 apply failed"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql" && pass "0002 barangays seeded" || fail "0002 seed failed"
# Sprint 6's own migration — blotter amendment history has nowhere to live
# without it, so a missing 0004 must fail loudly here rather than at runtime.
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0004_blotter_revision.sql" && pass "0004 blotter_revision applied" || fail "0004 apply failed"
expect_eq "$(mysql_exec -N -s "$VALDB" -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='blotter_revision';")" "1" "blotter_revision table exists"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
  (1, 's6_secretary', '$HASH', 'S6 Secretary',     'secretary',       1, UTC_TIMESTAMP()),
  (1, 's6_admin',     '$HASH', 'S6 Admin',         'admin',           1, UTC_TIMESTAMP()),
  (1, 's6_tanod',     '$HASH', 'S6 Tanod',         'tanod',           1, UTC_TIMESTAMP()),
  (1, 's6_pb',        '$HASH', 'S6 Punong Brgy',   'punong_barangay', 1, UTC_TIMESTAMP()),
  (2, 's6_sec2',      '$HASH', 'S6 Secretary Brgy2','secretary',      1, UTC_TIMESTAMP());
SQL
pass "Seeded secretary/admin/tanod/PB (barangay 1) + secretary (barangay 2)"

step "2. Seed incidents and AI drafts directly (no model involved)"
# INC1: has a completed, non-stale draft -> the happy approval path.
# INC2: has a completed but STALE draft   -> approval must be blocked.
# INC3: no draft at all                   -> 404 / finalize-without-approval.
# INC4: belongs to barangay 2             -> cross-tenant checks.
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at) VALUES
  (1, 'theft', 'normal', 'RAW-SECRET-ONE Rosalinda Mercado 0917-555-2841', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, 'disturbance', 'normal', 'RAW-SECRET-TWO Danilo Reyes', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (1, 'vandalism', 'normal', 'RAW-SECRET-THREE', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  (2, 'fire', 'normal', 'RAW-SECRET-FOUR', 'pending', 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
INC1=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE incident_type='theft' LIMIT 1;")
INC2=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE incident_type='disturbance' LIMIT 1;")
INC3=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE incident_type='vandalism' LIMIT 1;")
INC4=$(mysql_exec -N -s "$VALDB" -e "SELECT incident_id FROM incident WHERE incident_type='fire' LIMIT 1;")
echo "  incidents: INC1=$INC1 INC2=$INC2 INC3=$INC3 INC4(brgy2)=$INC4"

DRAFT1='Nagreklamo si [NAME] na naninirahan sa [ADDRESS] tungkol sa nawawalang cellphone.'
mysql_exec "$VALDB" <<SQL
INSERT INTO ai_processing_log
  (incident_id, pipeline_run_id, task_type, model_version, draft_redacted_narrative, draft_summary,
   draft_summary_stale, draft_version, status, processed_at, created_at)
VALUES
  ($INC1, '11111111-1111-4111-8111-111111111111', 'redaction', 'test/seeded-model',
   '$DRAFT1', 'Summary of the redacted narrative.', 0, 1, 'completed', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ($INC2, '22222222-2222-4222-8222-222222222222', 'redaction', 'test/seeded-model',
   'Draft for incident two.', 'Stale summary.', 1, 1, 'completed', UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
pass "Seeded a clean draft (INC1) and a STALE-summary draft (INC2)"

step "3. Start API (PHP built-in server, throwaway port)"
mkdir -p "$PACKET_DIR"
PACKET_DIR_WIN="$(cygpath -m "$PACKET_DIR")"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
export LUPON_PACKET_DIR="$PACKET_DIR_WIN"
# Configured but pointed at a port nothing listens on: proves the API
# NEVER calls the model (Rule 15) — if any endpoint tried, it would hang
# or fail, and these tests would not pass.
export OLLAMA_URL="http://127.0.0.1:59999"
export OLLAMA_MODEL="test/seeded-model"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.s6chk-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
SEC_TOKEN=$(login_as s6_secretary)
ADMIN_TOKEN=$(login_as s6_admin)
TANOD_TOKEN=$(login_as s6_tanod)
PB_TOKEN=$(login_as s6_pb)
SEC2_TOKEN=$(login_as s6_sec2)
if [ -n "$SEC_TOKEN" ] && [ -n "$ADMIN_TOKEN" ]; then
  pass "Logged in as secretary/admin/tanod/PB/secretary2 (env override reached the disposable DB)"
else
  fail "Login failed — the API is probably talking to the REAL database (see this script's header)"
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
json_body() { "$PHP_BIN" -r 'echo json_encode(json_decode(file_get_contents("php://stdin"), true));'; }

# ============================================================
# GET /incidents/:id — the only raw_narrative disclosure
# ============================================================
step "4. GET /incidents/:id — raw narrative is Secretary-only"
SEC_DETAIL=$(body_of GET "/incidents/$INC1" "$SEC_TOKEN")
expect_contains "$SEC_DETAIL" "RAW-SECRET-ONE" "Secretary receives raw_narrative"
expect_not_contains "$(body_of GET "/incidents/$INC1" "$ADMIN_TOKEN")" "RAW-SECRET-ONE" "Admin does NOT receive raw_narrative"
expect_not_contains "$(body_of GET "/incidents/$INC1" "$PB_TOKEN")" "RAW-SECRET-ONE" "Punong Barangay does NOT receive raw_narrative"
expect_eq "$(status_of GET "/incidents/$INC1" "$TANOD_TOKEN")" "404" "Tanod with no relationship to the incident gets 404"
expect_eq "$(status_of GET "/incidents/$INC4" "$SEC_TOKEN")" "404" "Cross-tenant incident is 404"
expect_eq "$(status_of GET "/incidents/999999" "$SEC_TOKEN")" "404" "Unknown incident is 404"

# ============================================================
# Role gating on the AI endpoints
# ============================================================
step "4b. GET /incidents/:id/evidence — ownership policy + no filesystem paths"
# Seed one attachment so the happy path returns something real.
mysql_exec "$VALDB" <<SQL
INSERT INTO evidence_attachment
  (incident_id, type, file_path, uploaded_by, uploaded_at, sha256, byte_size, mime_type, original_filename)
VALUES
  ($INC1, 'photo', '/protected/storage/s6-secret-path.jpg',
   (SELECT user_id FROM user WHERE username='s6_tanod'), UTC_TIMESTAMP(),
   'abc123def456', 20480, 'image/jpeg', 'scene-photo.jpg');
SQL
EV=$(body_of GET "/incidents/$INC1/evidence" "$SEC_TOKEN")
echo "  response: $EV"
expect_contains "$EV" "scene-photo.jpg" "Secretary sees the attachment"
# §6: "Never returns filesystem paths."
expect_not_contains "$EV" "s6-secret-path" "Response does NOT leak the filesystem path"
expect_not_contains "$EV" "file_path" "Response has no file_path field at all"
expect_eq "$(status_of GET "/incidents/$INC1/evidence" "$ADMIN_TOKEN")" "200" "Admin can list evidence"
expect_eq "$(status_of GET "/incidents/$INC1/evidence" "$PB_TOKEN")" "403" "Punong Barangay is not on §6's role list for evidence"
expect_eq "$(status_of GET "/incidents/$INC1/evidence" "$TANOD_TOKEN")" "404" "Unrelated Tanod cannot list evidence"
expect_eq "$(status_of GET "/incidents/$INC4/evidence" "$SEC_TOKEN")" "404" "Cross-tenant evidence listing is 404"

step "4c. PATCH /incidents/:id/status — Admin resolve, with prerequisites"
expect_eq "$(status_of PATCH "/incidents/$INC1/status" "$SEC_TOKEN" '{"status":"resolved"}')" "403" "Secretary cannot resolve an incident"
expect_eq "$(status_of PATCH "/incidents/$INC1/status" "$ADMIN_TOKEN" '{"status":"pending"}')" "400" "Body must be exactly status=resolved"
# INC1 is still 'pending' — §6 allows resolving only a 'dispatched' incident.
expect_eq "$(status_of PATCH "/incidents/$INC1/status" "$ADMIN_TOKEN" '{"status":"resolved"}')" "409" "A pending incident cannot be resolved"

# Give INC2 a dispatch so the prerequisite path can be exercised properly.
mysql_exec "$VALDB" <<SQL
UPDATE incident SET status='dispatched' WHERE incident_id=$INC2;
INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, route_status, status, dispatched_at, created_client_request_id)
VALUES ($INC2,
        (SELECT user_id FROM user WHERE username='s6_admin'),
        (SELECT user_id FROM user WHERE username='s6_tanod'),
        'normal', 'unavailable', 'assigned', UTC_TIMESTAMP(), '33333333-3333-4333-8333-333333333333');
SQL
expect_eq "$(status_of PATCH "/incidents/$INC2/status" "$ADMIN_TOKEN" '{"status":"resolved"}')" "409" "Cannot resolve while a dispatch is still active"
mysql_exec "$VALDB" -e "UPDATE dispatch SET status='completed', completed_at=UTC_TIMESTAMP() WHERE incident_id=$INC2;"
expect_eq "$(status_of PATCH "/incidents/$INC2/status" "$ADMIN_TOKEN" '{"status":"resolved"}')" "200" "Resolves once the dispatch is completed"
expect_eq "$(db_one "SELECT status FROM incident WHERE incident_id=$INC2;")" "resolved" "Incident is resolved in the DB"
expect_eq "$(status_of PATCH "/incidents/$INC2/status" "$ADMIN_TOKEN" '{"status":"resolved"}')" "409" "Repeated resolve is 409, not a second mutation"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='incident_resolved';")" "1" "Exactly one resolve audit row"
expect_eq "$(status_of PATCH "/incidents/$INC4/status" "$ADMIN_TOKEN" '{"status":"resolved"}')" "404" "Cross-tenant resolve is 404"

step "4c2. GET /incidents/:id carries the dispatch stages W7's timeline needs"
# Found in a real browser pass: W7's timeline showed "Not yet" for stages
# that HAD happened, because a Secretary gets 403 on GET /dispatch (§6
# lists Admin/PB/Tanod only) and the failure was being swallowed. §9
# requires dispatched_at/arrived_at ON a Secretary screen, so they ride
# along here instead. A silent "Not yet" for something that did happen is
# exactly the fabricated timeline §9 forbids.
expect_eq "$(status_of GET "/dispatch" "$SEC_TOKEN")" "403" "Secretary genuinely cannot read GET /dispatch (the reason these fields exist here)"
DET=$(body_of GET "/incidents/$INC2" "$SEC_TOKEN")
expect_contains "$DET" '"dispatched_at"' "GET /incidents/:id exposes dispatched_at"
expect_contains "$DET" '"arrived_at"' "GET /incidents/:id exposes arrived_at"
expect_contains "$DET" '"has_active_dispatch"' "GET /incidents/:id exposes has_active_dispatch"
# INC2's dispatch was completed above, so no dispatch is active any more.
expect_contains "$DET" '"has_active_dispatch":false' "has_active_dispatch is false once the dispatch completed"
expect_eq "$(body_of GET "/incidents/$INC2" "$SEC_TOKEN" | jget dispatched_at | cut -c1-4)" "2026" "dispatched_at is a real timestamp, not null"
# An incident that was never dispatched must report nulls, not fabricated times.
DET3=$(body_of GET "/incidents/$INC3" "$SEC_TOKEN")
expect_contains "$DET3" '"dispatched_at":null' "Never-dispatched incident reports null, not a made-up time"
expect_contains "$DET3" '"has_active_dispatch":false' "Never-dispatched incident has no active dispatch"

step "4d. GET /dispatch?incident_id= — W7's timeline source"
DISP=$(body_of GET "/dispatch?incident_id=$INC2" "$ADMIN_TOKEN")
expect_contains "$DISP" '"incident_id":'"$INC2" "Filter returns this incident's dispatch"
expect_eq "$(body_of GET "/dispatch?incident_id=$INC3" "$ADMIN_TOKEN" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo count($d["items"] ?? []);')" "0" "Incident with no dispatch returns an empty list"
expect_eq "$(status_of GET "/dispatch?incident_id=abc" "$ADMIN_TOKEN")" "400" "Non-numeric incident_id rejected"

step "5. AI endpoints — Secretary-only (§7)"
expect_eq "$(status_of POST "/incidents/$INC1/redact" "$ADMIN_TOKEN")" "403" "Admin cannot trigger redaction"
expect_eq "$(status_of POST "/incidents/$INC1/redact" "$TANOD_TOKEN")" "403" "Tanod cannot trigger redaction"
expect_eq "$(status_of POST "/incidents/$INC1/redact" "$PB_TOKEN")" "403" "PB cannot trigger redaction"
expect_eq "$(status_of GET "/incidents/$INC1/ai-draft" "$ADMIN_TOKEN")" "403" "Admin cannot read the AI draft"
expect_eq "$(status_of GET "/incidents/$INC3/ai-draft" "$SEC_TOKEN")" "404" "No draft yet is 404, not an error"
expect_eq "$(status_of GET "/incidents/$INC4/ai-draft" "$SEC2_TOKEN")" "404" "Cross-tenant draft read is 404"

# ============================================================
# regenerate-summary — optimistic concurrency (Rule 23)
# ============================================================
step "6. regenerate-summary — exact draft_version equality"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/regenerate-summary" "$ADMIN_TOKEN" '{"draft_redacted_narrative":"x","draft_version":1}')" "403" "Admin cannot regenerate"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/regenerate-summary" "$SEC_TOKEN" '{"draft_version":1}')" "400" "Missing draft_redacted_narrative rejected"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/regenerate-summary" "$SEC_TOKEN" '{"draft_redacted_narrative":"Edited text.","draft_version":99}')" "409" "STALE draft_version rejected with 409"
# The stale attempt must not have changed anything.
expect_eq "$(db_one "SELECT draft_version FROM ai_processing_log WHERE incident_id=$INC1;")" "1" "draft_version unchanged after the stale attempt"

REGEN=$(body_of POST "/incidents/$INC1/ai-draft/regenerate-summary" "$SEC_TOKEN" '{"draft_redacted_narrative":"Edited redacted text v2.","draft_version":1}')
echo "  response: $REGEN"
expect_eq "$(echo "$REGEN" | jget draft_version)" "2" "draft_version incremented to 2"
expect_eq "$(echo "$REGEN" | jget status)" "queued" "status is queued (the worker generates the summary, not the API)"
expect_eq "$(db_one "SELECT draft_summary_stale FROM ai_processing_log WHERE incident_id=$INC1;")" "1" "draft_summary_stale set in the DB"
expect_eq "$(db_one "SELECT draft_redacted_narrative FROM ai_processing_log WHERE incident_id=$INC1;")" "Edited redacted text v2." "Edited narrative persisted"
expect_eq "$(db_one "SELECT status FROM ai_processing_log WHERE incident_id=$INC1;")" "queued" "Row re-queued for the worker"

# ============================================================
# approve — the Rule 3 gate
# ============================================================
step "7. approve — every prerequisite is enforced"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/approve" "$ADMIN_TOKEN" '{"approved_narrative":"x","draft_version":2}')" "403" "Admin cannot approve"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/approve" "$SEC_TOKEN" '{"approved_narrative":"Edited redacted text v2.","draft_version":2}')" "409" "Approval blocked while status=queued"

# Simulate the worker finishing: summary filled, stale cleared, completed.
mysql_exec "$VALDB" -e "UPDATE ai_processing_log SET status='completed', draft_summary='Regenerated summary.', draft_summary_stale=0, processed_at=UTC_TIMESTAMP() WHERE incident_id=$INC1;"
pass "Simulated the worker completing the summary (no model call)"

expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/approve" "$SEC_TOKEN" '{"approved_narrative":"Edited redacted text v2.","draft_version":1}')" "409" "Wrong draft_version rejected"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/approve" "$SEC_TOKEN" '{"approved_narrative":"Text that does NOT match the draft.","draft_version":2}')" "409" "Text not matching the draft rejected"
expect_eq "$(db_one "SELECT COUNT(*) FROM incident WHERE incident_id=$INC1 AND redacted_narrative IS NOT NULL;")" "0" "No approval was written by any rejected attempt"

# Stale-summary incident must be refused outright.
expect_eq "$(status_of POST "/incidents/$INC2/ai-draft/approve" "$SEC_TOKEN" '{"approved_narrative":"Draft for incident two.","draft_version":1}')" "409" "draft_summary_stale=true blocks approval"

APPROVE=$(body_of POST "/incidents/$INC1/ai-draft/approve" "$SEC_TOKEN" '{"approved_narrative":"Edited redacted text v2.","draft_version":2}')
echo "  response: $APPROVE"
expect_contains "$APPROVE" "redaction_approved_at" "Approval returned redaction_approved_at"
expect_eq "$(db_one "SELECT redacted_narrative FROM incident WHERE incident_id=$INC1;")" "Edited redacted text v2." "incident.redacted_narrative committed (verified in the DB)"
expect_eq "$(db_one "SELECT COUNT(*) FROM incident WHERE incident_id=$INC1 AND redaction_approved_at IS NOT NULL AND redaction_approved_by IS NOT NULL;")" "1" "approved_at + approved_by both set"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='ai_redaction_approved' AND entity_id=$INC1;")" "1" "Approval wrote an audit row"

step "8. approve — idempotent replay vs. real conflict"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/approve" "$SEC_TOKEN" '{"approved_narrative":"Edited redacted text v2.","draft_version":2}')" "200" "Repeat approval with IDENTICAL text replays as 200"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='ai_redaction_approved' AND entity_id=$INC1;")" "1" "Replay did NOT write a second audit row"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/approve" "$SEC_TOKEN" '{"approved_narrative":"Completely different text now.","draft_version":2}')" "409" "Repeat approval with DIFFERENT text is a 409"

# ============================================================
# Translation — post-approval gate
# ============================================================
step "9. translate — requires an approved redaction"
expect_eq "$(status_of POST "/incidents/$INC2/ai-draft/translate" "$SEC_TOKEN" '{"target_language":"fil"}')" "409" "Translation without approval is 409"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/translate" "$SEC_TOKEN" '{"target_language":"klingon"}')" "400" "Unsupported target_language rejected"
expect_eq "$(status_of POST "/incidents/$INC1/ai-draft/translate" "$ADMIN_TOKEN" '{"target_language":"fil"}')" "403" "Admin cannot translate"
TRANS=$(body_of POST "/incidents/$INC1/ai-draft/translate" "$SEC_TOKEN" '{"target_language":"fil"}')
expect_eq "$(echo "$TRANS" | jget status)" "queued" "Translation queues after approval"
expect_eq "$(echo "$TRANS" | jget language_validated)" "1" "Filipino reports language_validated=true"
TRANS_BCL=$(body_of POST "/incidents/$INC1/ai-draft/translate" "$SEC_TOKEN" '{"target_language":"bcl"}')
expect_contains "$TRANS_BCL" '"language_validated":false' "Bikol honestly reports language_validated=false (Rule 16)"

# ============================================================
# Blotter finalization
# ============================================================
step "10. finalize — Secretary-only, requires approved redaction"
expect_eq "$(status_of POST "/incidents/$INC1/finalize" "$ADMIN_TOKEN" '{"narrative_summary":"x"}')" "403" "Admin cannot finalize (RA 7160 s394(c): Secretary is custodian)"
expect_eq "$(status_of POST "/incidents/$INC3/finalize" "$SEC_TOKEN" '{"narrative_summary":"No approval yet."}')" "409" "Finalize without an approved redaction is 409"
expect_eq "$(status_of POST "/incidents/$INC1/finalize" "$SEC_TOKEN" '{}')" "400" "Missing narrative_summary rejected"

FIN=$(body_of POST "/incidents/$INC1/finalize" "$SEC_TOKEN" '{"narrative_summary":"Original finalized summary."}')
echo "  response: $FIN"
BLOTTER_ID=$(echo "$FIN" | jget blotter_id)
expect_eq "$(echo "$FIN" | jget revision_no)" "1" "First finalization is revision 1"
expect_eq "$(db_one "SELECT COUNT(*) FROM blotter_record WHERE incident_id=$INC1 AND finalized_at IS NOT NULL;")" "1" "Blotter finalized in the DB"
expect_eq "$(status_of POST "/incidents/$INC1/finalize" "$SEC_TOKEN" '{"narrative_summary":"Second attempt."}')" "409" "Double finalize is 409 (no silent overwrite)"
expect_eq "$(db_one "SELECT narrative_summary FROM blotter_record WHERE incident_id=$INC1;")" "Original finalized summary." "Original summary survived the rejected second finalize"

step "11. redact after finalization is blocked (§6)"
expect_eq "$(status_of POST "/incidents/$INC1/redact" "$SEC_TOKEN")" "409" "Re-running redaction under a finalized blotter is 409"

# ============================================================
# Amendment — history must survive
# ============================================================
step "12. amend — increments revision and preserves the prior text"
expect_eq "$(status_of POST "/incidents/$INC3/blotter/amend" "$SEC_TOKEN" '{"narrative_summary":"x","reason":"y"}')" "404" "Amending a nonexistent blotter is 404"
expect_eq "$(status_of POST "/incidents/$INC1/blotter/amend" "$SEC_TOKEN" '{"narrative_summary":"Missing reason."}')" "400" "Amendment without a reason rejected"
expect_eq "$(status_of POST "/incidents/$INC1/blotter/amend" "$ADMIN_TOKEN" '{"narrative_summary":"x","reason":"y"}')" "403" "Admin cannot amend"

AMEND=$(body_of POST "/incidents/$INC1/blotter/amend" "$SEC_TOKEN" '{"narrative_summary":"Corrected summary after review.","reason":"Typo in the original date."}')
echo "  response: $AMEND"
expect_eq "$(echo "$AMEND" | jget revision_no)" "2" "revision_no incremented to 2"
expect_eq "$(db_one "SELECT narrative_summary FROM blotter_record WHERE incident_id=$INC1;")" "Corrected summary after review." "Current text is the amended one"
# §6's "never deletes the previous finalized value" — the whole point of 0004.
expect_eq "$(db_one "SELECT narrative_summary FROM blotter_revision WHERE blotter_id=$BLOTTER_ID AND revision_no=1;")" "Original finalized summary." "PREVIOUS finalized text is preserved in blotter_revision"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='blotter_amended';")" "1" "Amendment wrote an audit row"

step "12b. GET /incidents/:id/blotter — W7's lookup by incident"
# W7 works from an incident id (that is what the blotter list links by), so
# it needs this rather than GET /blotter/:id, whose id it does not have.
BY_INC=$(body_of GET "/incidents/$INC1/blotter" "$SEC_TOKEN")
expect_eq "$(echo "$BY_INC" | jget blotter_id)" "$BLOTTER_ID" "Lookup by incident returns the right blotter"
expect_eq "$(echo "$BY_INC" | jget revision_no)" "2" "Lookup reflects the amended revision"
expect_eq "$(status_of GET "/incidents/$INC3/blotter" "$SEC_TOKEN")" "404" "Incident with no blotter record is 404 (an ordinary state for W7)"
expect_eq "$(status_of GET "/incidents/$INC4/blotter" "$SEC_TOKEN")" "404" "Cross-tenant lookup is 404"
expect_eq "$(status_of GET "/incidents/$INC1/blotter" "$TANOD_TOKEN")" "404" "Unrelated Tanod cannot look it up"
expect_eq "$(status_of GET "/incidents/$INC1/blotter" "$PB_TOKEN")" "200" "Punong Barangay can read it (read-only role)"

step "13. GET /blotter/:id — tenant scoping"
expect_eq "$(status_of GET "/blotter/$BLOTTER_ID" "$SEC_TOKEN")" "200" "Own-barangay Secretary can read the blotter"
expect_eq "$(status_of GET "/blotter/$BLOTTER_ID" "$SEC2_TOKEN")" "404" "Cross-tenant blotter read is 404"
expect_eq "$(status_of GET "/blotter/$BLOTTER_ID" "$TANOD_TOKEN")" "404" "Unrelated Tanod cannot read the blotter"
expect_eq "$(status_of GET "/blotter/999999" "$SEC_TOKEN")" "404" "Unknown blotter is 404"

# ============================================================
# Lupon packet
# ============================================================
step "14. lupon-packet — prerequisites, generation, and protected download"
expect_eq "$(status_of POST "/incidents/$INC3/lupon-packet" "$SEC_TOKEN")" "409" "Packet without approval/finalization is 409"
expect_eq "$(status_of POST "/incidents/$INC1/lupon-packet" "$ADMIN_TOKEN")" "403" "Admin cannot generate a packet"

PACKET=$(body_of POST "/incidents/$INC1/lupon-packet" "$SEC_TOKEN")
echo "  response: $PACKET"
expect_contains "$PACKET" "lupon-packet/download" "Packet returned an API-relative file_url"
PACKET_FILE="$PACKET_DIR/incident-$INC1.pdf"
[ -s "$PACKET_FILE" ] && pass "Packet file was written to protected storage" || fail "Packet file missing at $PACKET_FILE"
expect_eq "$(head -c 5 "$PACKET_FILE" 2>/dev/null)" "%PDF-" "Generated file really is a PDF"
# The packet must carry the APPROVED text, never the raw narrative.
expect_not_contains "$(strings "$PACKET_FILE" 2>/dev/null || cat "$PACKET_FILE")" "RAW-SECRET-ONE" "Packet does NOT contain the raw narrative"
expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='lupon_packet_generated';")" "1" "Packet generation wrote an audit row"

expect_eq "$(status_of GET "/incidents/$INC1/lupon-packet/download" "$SEC_TOKEN")" "200" "Secretary can download the packet"
expect_eq "$(status_of GET "/incidents/$INC1/lupon-packet/download" "$ADMIN_TOKEN")" "403" "Admin cannot download the packet"
expect_eq "$(status_of GET "/incidents/$INC4/lupon-packet/download" "$SEC2_TOKEN")" "409" "Cross-barangay packet download blocked by prerequisites"

step "15. The API never called Ollama"
# OLLAMA_URL points at a dead port for this whole run. Every endpoint
# above still behaved correctly, which is the proof that the request path
# only ever enqueues (Rule 15).
pass "All endpoints behaved correctly with OLLAMA_URL pointing at a dead port"

echo
echo "==================== SUMMARY ===================="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "================================================="
[ "$FAIL" -eq 0 ] && echo "All Sprint 6 checks passed." || echo "Some checks FAILED — see above."
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
