#!/usr/bin/env bash
# Baranguard — paper approvals + document scans validation (migration 0037):
#   POST /accomplishment-reports/:id/paper-signature
#   POST /accomplishment-reports/:id/record-paper-approval
#   POST /ssz-term-reports/:id/paper-signature
#   POST /ssz-term-reports/:id/record-paper-approval
#   POST|GET /document-scans, GET /document-scans/:id/download
# against a REAL local XAMPP MariaDB + PHP.
#
# Safe to run: everything happens in a disposable database
# (baranguard_paper_check) with a disposable app user, disposable accounts, a
# scratch SCANS_DIR and a PHP dev server on a throwaway port (8901). The real
# `baranguard` / `baranguard_uiseed` databases, backend/.env and Apache are
# never touched.
#
# Migration order matters on purpose: the chain up to 0033 is applied, legacy
# users + an already-approved accomplishment report and Annex D report are
# seeded, and ONLY THEN 0034+ (0037 included) is applied, so the migration is
# proven on a database that already holds 0030-0033 rows.
#
# Usage (Git Bash, repo root or anywhere):
#   bash backend/scripts/verify-paper-approvals.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="${PAPER_VALDB:-baranguard_paper_check}"
APP_USER="${PAPER_APP_USER:-paper_check_app}"
APP_PASSWORD="PaperCheckDbPw!2026"
API_PORT="${PAPER_API_PORT:-8901}"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="PaperCheck#2026Pw"

echo "Baranguard paper approvals / document scans validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
echo "Using mysql: $MYSQL_BIN"
echo "Using php:   $PHP_BIN ($($PHP_BIN -r 'echo PHP_VERSION;'))"

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
db_one() { mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null | tr -d '\r'; }

TMP_DIR="$(mktemp -d)"
TMP_W="$(cygpath -m "$TMP_DIR")"
SCANS_LOCAL="$TMP_DIR/scans"
SERVER_LOG="$BACKEND_DIR/scripts/.paper-server-${API_PORT}.log"
cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$TMP_DIR" "$SERVER_LOG"
  echo "Stopped the test PHP server, dropped $VALDB and user '$APP_USER', removed the scratch scan dir."
  echo "Your real databases and backend/.env were never touched."
}
trap cleanup EXIT

# ---------------------------------------------------------------- helpers
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }
dman() { "$PHP_BIN" -r 'date_default_timezone_set("Asia/Manila"); echo date("Y-m-d", strtotime($argv[1]));' -- "$1"; }
jget() {
  printf '%s' "$1" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach(explode(".",$argv[1]) as $k){ if(is_array($d)&&array_key_exists($k,$d)){$d=$d[$k];}else{$d=null;break;} } if(is_bool($d)){echo $d?"true":"false";}elseif($d===null){echo "null";}elseif(is_array($d)){echo json_encode($d);}else{echo $d;}' "$2"
}
# api METHOD PATH TOKEN BODY [extra curl args...]  -> sets CODE and BODY
api() {
  local method="$1" path="$2" token="$3" body="$4"
  shift 4
  local args=(-s -w $'\n%{http_code}' -X "$method" "${BASE_URL}${path}" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  RESP=$(curl "${args[@]}" "$@")
  CODE=$(printf '%s' "$RESP" | tail -n 1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
}
# upload TOKEN ENTITY_TYPE ENTITY_ID FILE [extra -F args...]  (multipart) -> CODE, BODY
upload() {
  local token="$1" et="$2" eid="$3" file="$4"
  shift 4
  local args=(-s -w $'\n%{http_code}' -X POST "${BASE_URL}/document-scans")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$et" ] && args+=(-F "entity_type=$et")
  [ -n "$eid" ] && args+=(-F "entity_id=$eid")
  [ -n "$file" ] && args+=(-F "file=@$file")
  RESP=$(curl "${args[@]}" "$@")
  CODE=$(printf '%s' "$RESP" | tail -n 1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
}
expect_code() { # label expected
  [ "$CODE" = "$2" ] && pass "$1 -> $2" || fail "$1 -> $CODE (expected $2): ${BODY:0:240}"
}
expect_eq() { # label actual expected
  [ "$2" = "$3" ] && pass "$1 (= $3)" || fail "$1: got '$2', expected '$3'"
}
login_as() {
  curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
ik() { echo "Idempotency-Key: $(uuid)"; }
file_sha() { sha256sum "$1" | cut -d' ' -f1; }
scan_files() { find "$SCANS_LOCAL" -type f 2>/dev/null | wc -l | tr -d ' '; }

# ---------------------------------------------------------------- 0
step "0. Connectivity + disposable schema (chain <= 0033, seed legacy rows, THEN 0034+)"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
ALL_MIGRATIONS=$(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort)
for m in $ALL_MIGRATIONS; do
  if [[ "$m" < "0034" ]]; then
    mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
  fi
done
pass "Migrations 0001-0033 applied (globbed)"
expect_eq "Pre-0037: accomplishment_report has no approval_mode yet" "$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='accomplishment_report' AND COLUMN_NAME='approval_mode';")" "0"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, is_suspended, official_title, approval_authority, created_at) VALUES
  (1, 'pa_adm',   '$HASH', 'PA Admin',          'admin',           1, 0, 'Chief Tanod',    'note_report,prepare_annex_d', UTC_TIMESTAMP()),
  (1, 'pa_sec',   '$HASH', 'PA Secretary',      'secretary',       1, 0, NULL,             '', UTC_TIMESTAMP()),
  (1, 'pa_kag',   '$HASH', 'PA Kagawad',        'secretary',       1, 0, 'Kagawad',        'note_report,approve_report,prepare_annex_d,approve_annex_d', UTC_TIMESTAMP()),
  (1, 'pa_sec2',  '$HASH', 'PA Secretary Two',  'secretary',       1, 0, 'Secretary',      'approve_report', UTC_TIMESTAMP()),
  (1, 'pa_pb',    '$HASH', 'PA Punong',         'punong_barangay', 1, 0, 'Punong Barangay','note_report,approve_report,approve_roster,approve_annex_d', UTC_TIMESTAMP()),
  (1, 'pa_t1',    '$HASH', 'PA Tanod One',      'tanod',           1, 0, NULL,             '', UTC_TIMESTAMP()),
  (1, 'pa_t2',    '$HASH', 'PA Tanod Two',      'tanod',           1, 0, NULL,             '', UTC_TIMESTAMP()),
  (1, 'pa_nosig', '$HASH', 'PA Note Only',      'secretary',       1, 0, NULL,             'note_report', UTC_TIMESTAMP()),
  (1, 'pa_susp',  '$HASH', 'PA Suspended',      'secretary',       1, 1, NULL,             'approve_report,approve_annex_d', UTC_TIMESTAMP()),
  (1, 'pa_inact', '$HASH', 'PA Inactive',       'secretary',       0, 0, NULL,             'approve_report,approve_annex_d', UTC_TIMESTAMP()),
  (1, 'pa_tauth', '$HASH', 'PA Tanod Authority','tanod',           1, 0, NULL,             'approve_report,approve_annex_d', UTC_TIMESTAMP()),
  (2, 'pa_adm2',  '$HASH', 'PA Admin B2',       'admin',           1, 0, 'Chief Tanod',    'note_report,prepare_annex_d', UTC_TIMESTAMP()),
  (2, 'pa_pb2',   '$HASH', 'PA Punong B2',      'punong_barangay', 1, 0, 'Punong Barangay','note_report,approve_report,approve_annex_d', UTC_TIMESTAMP()),
  (2, 'pa_t_b2',  '$HASH', 'PA Tanod B2',       'tanod',           1, 0, NULL,             '', UTC_TIMESTAMP());
SQL
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
ADM_ID=$(uid pa_adm); SEC_ID=$(uid pa_sec); KAG_ID=$(uid pa_kag); SEC2_ID=$(uid pa_sec2); PB_ID=$(uid pa_pb)
T1_ID=$(uid pa_t1); T2_ID=$(uid pa_t2); NOSIG_ID=$(uid pa_nosig); SUSP_ID=$(uid pa_susp); INACT_ID=$(uid pa_inact); TAUTH_ID=$(uid pa_tauth)
ADM2_ID=$(uid pa_adm2); PB2_ID=$(uid pa_pb2); TB2_ID=$(uid pa_t_b2)
CUR_MONTH=$(dman today | cut -c1-7)
TODAY=$(dman today)
YESTERDAY=$(dman '-1 day')
TOMORROW=$(dman '+1 day')

# Legacy rows that exist BEFORE migration 0037.
mysql_exec "$VALDB" <<SQL
INSERT INTO accomplishment_report (barangay_id, user_id, month, status, prepared_at, noted_by, noted_at, approved_by, approved_at, total_minutes_confirmed, version, created_at, updated_at) VALUES
  (1, $T1_ID, '2026-01', 'approved', UTC_TIMESTAMP(), $PB_ID, UTC_TIMESTAMP(), $PB_ID, UTC_TIMESTAMP(), 60, 5, UTC_TIMESTAMP(), UTC_TIMESTAMP());
INSERT INTO ssz_term_report (barangay_id, term_label, term_start, term_end, status, prepared_by, prepared_at, approved_by, approved_at, version, created_by, created_at, updated_at) VALUES
  (1, 'Legacy Term', '2026-01-01', '2026-03-31', 'approved', $ADM_ID, UTC_TIMESTAMP(), $PB_ID, UTC_TIMESTAMP(), 3, $ADM_ID, UTC_TIMESTAMP(), UTC_TIMESTAMP());
SQL
A_LEG=$(db_one "SELECT report_id FROM accomplishment_report WHERE month='2026-01' AND user_id=$T1_ID;")
S_LEG=$(db_one "SELECT report_id FROM ssz_term_report WHERE term_label='Legacy Term';")
[ -n "$A_LEG" ] && [ -n "$S_LEG" ] && pass "Seeded 14 users + legacy approved accomplishment report #$A_LEG and Annex D report #$S_LEG (pre-0037)" || fail "Legacy seed failed"

for m in $ALL_MIGRATIONS; do
  if [[ ! "$m" < "0034" ]]; then
    mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 && pass "migration $m applied on a DB that already has 0030-0033 rows" || fail "migration $m failed"
  fi
done

step "0b. Migration 0037 evidence: defaults on existing rows, schema, idempotency, down round-trip"
expect_eq "Existing approved accomplishment report -> approval_mode 'digital'" "$(db_one "SELECT approval_mode FROM accomplishment_report WHERE report_id=$A_LEG;")" "digital"
expect_eq "Existing approved accomplishment report -> paper_signed_on NULL" "$(db_one "SELECT IFNULL(paper_signed_on,'NULL') FROM accomplishment_report WHERE report_id=$A_LEG;")" "NULL"
expect_eq "Existing approved Annex D report -> approval_mode 'digital'" "$(db_one "SELECT approval_mode FROM ssz_term_report WHERE report_id=$S_LEG;")" "digital"
expect_eq "Existing rows untouched (status/version)" "$(db_one "SELECT CONCAT(status,'/',version) FROM accomplishment_report WHERE report_id=$A_LEG;")" "approved/5"
expect_eq "approval_mode column type (both tables)" "$(db_one "SELECT GROUP_CONCAT(COLUMN_TYPE) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND COLUMN_NAME='approval_mode' AND TABLE_NAME IN ('accomplishment_report','ssz_term_report');")" "enum('digital','recorded_from_paper'),enum('digital','recorded_from_paper')"
expect_eq "paper_recorded_by FK is ON DELETE SET NULL (both tables)" "$(db_one "SELECT GROUP_CONCAT(DELETE_RULE) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='$VALDB' AND CONSTRAINT_NAME IN ('fk_accrep_paper_recorded_by','fk_ssz_report_paper_recorded_by');")" "SET NULL,SET NULL"
expect_eq "document_scan columns" "$(db_one "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='document_scan';")" "scan_id,barangay_id,entity_type,entity_id,stored_path,mime_type,size_bytes,sha256,uploaded_by,uploaded_at"
expect_eq "document_scan has the (entity_type, entity_id) index" "$(db_one "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='document_scan' AND INDEX_NAME='idx_document_scan_entity';")" "2"
RT_DB="${VALDB}_rt"
mysql_exec -e "DROP DATABASE IF EXISTS \`$RT_DB\`; CREATE DATABASE \`$RT_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $ALL_MIGRATIONS; do mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1; done
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0037_paper_approvals_and_scans.sql" >/dev/null 2>&1 && pass "0037 is idempotent (applied twice)" || fail "0037 second apply failed"
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0037_paper_approvals_and_scans.down.sql" >/dev/null 2>&1 && pass "0037 .down.sql applies cleanly" || fail "0037 .down.sql failed"
expect_eq "  after down: no document_scan table, no paper columns" "$(mysql_exec -N -s -e "SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$RT_DB' AND TABLE_NAME='document_scan') + (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$RT_DB' AND TABLE_NAME IN ('accomplishment_report','ssz_term_report') AND COLUMN_NAME IN ('approval_mode','paper_signed_on','paper_recorded_by','paper_recorded_at'));" | tr -d '\r')" "0"
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0037_paper_approvals_and_scans.down.sql" >/dev/null 2>&1 && pass "0037 .down.sql is idempotent (applied twice)" || fail "0037 .down.sql second apply failed"
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0037_paper_approvals_and_scans.sql" >/dev/null 2>&1 && pass "0037 re-applies after rollback" || fail "0037 re-apply failed"
mysql_exec -e "DROP DATABASE IF EXISTS \`$RT_DB\`;" >/dev/null 2>&1

step "1. Start the API (PHP built-in server on port $API_PORT, scratch SCANS_DIR, 20M upload ceiling)"
mkdir -p "$SCANS_LOCAL"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN='*'
export SCANS_DIR="$TMP_W/scans"
(cd "$BACKEND_DIR/public" && "$PHP_BIN" -d upload_max_filesize=20M -d post_max_size=24M -S "127.0.0.1:${API_PORT}" >"$SERVER_LOG" 2>&1) &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null "${BASE_URL}/auth/login" -X POST -d '{}' && pass "PHP dev server responding on port $API_PORT" || { fail "PHP dev server did not start"; exit 1; }

ADM_T=$(login_as pa_adm); SEC_T=$(login_as pa_sec); KAG_T=$(login_as pa_kag); SEC2_T=$(login_as pa_sec2); PB_T=$(login_as pa_pb)
T1_T=$(login_as pa_t1); T2_T=$(login_as pa_t2); ADM2_T=$(login_as pa_adm2); PB2_T=$(login_as pa_pb2); TB2_T=$(login_as pa_t_b2)
[ -n "$ADM_T" ] && [ -n "$SEC_T" ] && [ -n "$KAG_T" ] && [ -n "$PB_T" ] && [ -n "$T1_T" ] && [ -n "$ADM2_T" ] && [ -n "$PB2_T" ] && pass "Logged in as every test account" || fail "One or more logins failed"
for pair in "dev-pa-t1:$T1_ID" "dev-pa-t2:$T2_ID"; do
  mysql_exec "$VALDB" -e "INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES ('${pair%%:*}', ${pair##*:}, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());"
done
D_T1="X-Device-Id: dev-pa-t1"

# Seed helper for accomplishment reports: mk_acc USER_ID MONTH STATUS [BARANGAY]
mk_acc() {
  local uid="$1" month="$2" status="$3" b="${4:-1}" noted="NULL" noted_at="NULL" appr="NULL" appr_at="NULL" prep="NULL"
  case "$status" in
    prepared|noted|approved) prep="UTC_TIMESTAMP()";;
  esac
  case "$status" in noted|approved) noted="$PB_ID"; noted_at="UTC_TIMESTAMP()";; esac
  [ "$b" = "2" ] && noted="$PB2_ID"
  case "$status" in approved) appr="$PB_ID"; appr_at="UTC_TIMESTAMP()";; esac
  mysql_exec "$VALDB" -e "INSERT INTO accomplishment_report (barangay_id, user_id, month, status, prepared_at, noted_by, noted_at, approved_by, approved_at, total_minutes_confirmed, version, created_at, updated_at) VALUES ($b, $uid, '$month', '$status', $prep, $noted, $noted_at, $appr, $appr_at, 60, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP());"
  db_one "SELECT report_id FROM accomplishment_report WHERE user_id=$uid AND month='$month';"
}
A_DIG=$(mk_acc "$T2_ID" "2026-08" approved)
A_N1=$(mk_acc "$T1_ID" "2026-02" noted)
A_N2=$(mk_acc "$T1_ID" "2026-03" noted)
A_N3=$(mk_acc "$T1_ID" "2026-04" noted)
A_N4=$(mk_acc "$T2_ID" "2026-05" noted)
A_N5=$(mk_acc "$T2_ID" "2026-09" noted)
A_PREP=$(mk_acc "$T1_ID" "2026-06" prepared)
A_OPEN=$(mk_acc "$T1_ID" "2026-07" open)
A_B2=$(mk_acc "$TB2_ID" "2026-02" noted 2)
A_LOCK=$(mk_acc "$T1_ID" "$CUR_MONTH" approved)
mysql_exec "$VALDB" -e "INSERT INTO accomplishment_entry (report_id, barangay_id, user_id, work_date, accomplishment_text, duration_minutes, client_event_id, created_at, updated_at) VALUES ($A_LOCK, 1, $T1_ID, '$TODAY', 'Locked-month entry', 60, '$(uuid)', UTC_TIMESTAMP(), UTC_TIMESTAMP());"
LOCK_ENTRY=$(db_one "SELECT entry_id FROM accomplishment_entry WHERE report_id=$A_LOCK LIMIT 1;")
pass "Seeded accomplishment reports (approved/noted/prepared/open/other-barangay) and one entry in the approved current-month report"

# ================================================================ A. fields
step "2. Accomplishment report objects: approval_mode / paper_* / paper_pending"
api GET "/accomplishment-reports/$A_LEG" "$SEC_T" ""
expect_code "Secretary GET legacy approved report" 200
expect_eq "  approval_mode (existing row)" "$(jget "$BODY" approval_mode)" "digital"
expect_eq "  paper_signed_on" "$(jget "$BODY" paper_signed_on)" "null"
expect_eq "  paper_recorded_by_name" "$(jget "$BODY" paper_recorded_by_name)" "null"
expect_eq "  paper_recorded_at" "$(jget "$BODY" paper_recorded_at)" "null"
expect_eq "  paper_pending is true (approved, no paper date)" "$(jget "$BODY" paper_pending)" "true"
api GET "/accomplishment-reports/$A_N1" "$PB_T" ""
expect_eq "Noted report: paper_pending false (not approved yet)" "$(jget "$BODY" paper_pending)/$(jget "$BODY" approval_mode)" "false/digital"
api GET "/accomplishment-reports/$A_LEG" "$T1_T" ""
expect_code "Owning tanod GET own approved report" 200
expect_eq "  tanod sees paper_pending too" "$(jget "$BODY" paper_pending)" "true"
api GET "/accomplishment-reports?status=approved&limit=100" "$ADM_T" ""
expect_eq "List items carry the new fields" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $ok=0; foreach($d["items"] as $i){ if(array_key_exists("paper_pending",$i)&&array_key_exists("approval_mode",$i)&&array_key_exists("paper_signed_on",$i)&&array_key_exists("paper_recorded_by_name",$i)&&array_key_exists("paper_recorded_at",$i)) $ok++; } echo $ok."/".count($d["items"]);')" "3/3"

# ================================================================ B. paper-signature
step "3. POST /accomplishment-reports/:id/paper-signature"
PS_BODY="{\"paper_signed_on\":\"$YESTERDAY\"}"
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$T1_T" "$PS_BODY" -H "$(ik)"
expect_code "Tanod" 403
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$PB_T" "$PS_BODY" -H "$(ik)"
expect_code "Punong Barangay (admin|secretary only)" 403
api POST "/accomplishment-reports/$A_LEG/paper-signature" "" "$PS_BODY" -H "$(ik)"
expect_code "No auth token" 401
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$SEC_T" "$PS_BODY"
expect_code "Missing Idempotency-Key" 400
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$SEC_T" "$PS_BODY" -H "Idempotency-Key: nope"
expect_code "Malformed Idempotency-Key" 400
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$SEC_T" '{}' -H "$(ik)"
expect_code "Missing paper_signed_on" 400
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$SEC_T" '{"paper_signed_on":"2026-13-45"}' -H "$(ik)"
expect_code "Impossible date" 400
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$SEC_T" '{"paper_signed_on":"04/10/2026"}' -H "$(ik)"
expect_code "Wrong date format" 400
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$SEC_T" "{\"paper_signed_on\":\"$TOMORROW\"}" -H "$(ik)"
expect_code "Future Manila date" 400
api POST "/accomplishment-reports/99999999/paper-signature" "$SEC_T" "$PS_BODY" -H "$(ik)"
expect_code "Unknown report id" 404
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$ADM2_T" "$PS_BODY" -H "$(ik)"
expect_code "Cross-tenant (barangay 2 admin) is 404, never 403" 404
api POST "/accomplishment-reports/$A_N1/paper-signature" "$SEC_T" "$PS_BODY" -H "$(ik)"
expect_code "Report still 'noted'" 409
api POST "/accomplishment-reports/$A_PREP/paper-signature" "$SEC_T" "$PS_BODY" -H "$(ik)"
expect_code "Report 'prepared'" 409
api POST "/accomplishment-reports/$A_OPEN/paper-signature" "$SEC_T" "$PS_BODY" -H "$(ik)"
expect_code "Report 'open'" 409

PS_KEY=$(uuid)
V_BEFORE=$(db_one "SELECT version FROM accomplishment_report WHERE report_id=$A_LEG;")
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$SEC_T" "$PS_BODY" -H "Idempotency-Key: $PS_KEY"
expect_code "Secretary records the paper date" 200
expect_eq "  paper_signed_on" "$(jget "$BODY" paper_signed_on)" "$YESTERDAY"
expect_eq "  paper_pending flips true -> false" "$(jget "$BODY" paper_pending)" "false"
expect_eq "  paper_recorded_by_name" "$(jget "$BODY" paper_recorded_by_name)" "PA Secretary"
expect_eq "  paper_recorded_at is an ISO UTC timestamp" "$(jget "$BODY" paper_recorded_at | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$')" "1"
expect_eq "  status stays approved, approval_mode stays digital" "$(jget "$BODY" status)/$(jget "$BODY" approval_mode)" "approved/digital"
expect_eq "  approved_by untouched (still the PB)" "$(jget "$BODY" approved_by)" "$PB_ID"
expect_eq "  version bumped once" "$(jget "$BODY" version)" "$((V_BEFORE+1))"
expect_eq "  DB paper_recorded_by = the recorder" "$(db_one "SELECT paper_recorded_by FROM accomplishment_report WHERE report_id=$A_LEG;")" "$SEC_ID"
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$SEC_T" "$PS_BODY" -H "Idempotency-Key: $PS_KEY"
expect_code "Replay (same Idempotency-Key)" 200
expect_eq "  replay did not bump the version again" "$(jget "$BODY" version)" "$((V_BEFORE+1))"
expect_eq "  exactly one audit row for that key" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='paper_signature_recorded' AND entity_type='accomplishment_report' AND entity_id=$A_LEG;")" "1"
expect_eq "  audit metadata = ids/status only" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='paper_signature_recorded' AND entity_type='accomplishment_report' AND entity_id=$A_LEG LIMIT 1;")" '["report_id", "status", "idempotency_key"]'
api GET "/accomplishment-reports/$A_LEG" "$PB_T" ""
expect_eq "  GET by PB shows the recorded date and recorder name" "$(jget "$BODY" paper_signed_on)/$(jget "$BODY" paper_recorded_by_name)" "$YESTERDAY/PA Secretary"
api POST "/accomplishment-reports/$A_LEG/paper-signature" "$ADM_T" "{\"paper_signed_on\":\"$TODAY\"}" -H "$(ik)"
expect_code "Admin overwrites with a new date (today is allowed)" 200
expect_eq "  new date stored, recorder is now the admin" "$(jget "$BODY" paper_signed_on)/$(jget "$BODY" paper_recorded_by_name)" "$TODAY/PA Admin"
expect_eq "  two audit rows now (one per distinct key)" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='paper_signature_recorded' AND entity_type='accomplishment_report' AND entity_id=$A_LEG;")" "2"

# ================================================================ C. record-paper-approval
step "4. POST /accomplishment-reports/:id/record-paper-approval"
RP_BODY="{\"signer_user_id\":$KAG_ID,\"signed_on\":\"$YESTERDAY\"}"
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$T1_T" "$RP_BODY" -H "$(ik)"
expect_code "Tanod" 403
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$PB_T" "$RP_BODY" -H "$(ik)"
expect_code "Punong Barangay (admin|secretary only)" 403
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$SEC_T" "$RP_BODY"
expect_code "Missing Idempotency-Key" 400
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$SEC_T" "{\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Missing signer_user_id" 400
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$SEC_T" "{\"signer_user_id\":\"abc\",\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "signer_user_id not an integer" 400
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$SEC_T" "{\"signer_user_id\":0,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "signer_user_id 0" 400
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$KAG_ID}" -H "$(ik)"
expect_code "Missing signed_on" 400
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$KAG_ID,\"signed_on\":\"$TOMORROW\"}" -H "$(ik)"
expect_code "Future signed_on" 400
api POST "/accomplishment-reports/99999999/record-paper-approval" "$SEC_T" "$RP_BODY" -H "$(ik)"
expect_code "Unknown report id" 404
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$ADM2_T" "{\"signer_user_id\":$PB2_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Cross-tenant recorder is 404" 404
api POST "/accomplishment-reports/$A_B2/record-paper-approval" "$SEC_T" "$RP_BODY" -H "$(ik)"
expect_code "Barangay 1 secretary on a barangay 2 report is 404" 404
api POST "/accomplishment-reports/$A_PREP/record-paper-approval" "$SEC_T" "$RP_BODY" -H "$(ik)"
expect_code "Report 'prepared' (must be noted)" 409
api POST "/accomplishment-reports/$A_OPEN/record-paper-approval" "$SEC_T" "$RP_BODY" -H "$(ik)"
expect_code "Report 'open'" 409
api POST "/accomplishment-reports/$A_DIG/record-paper-approval" "$SEC_T" "$RP_BODY" -H "$(ik)"
expect_code "Report already approved" 409
# signer rules (A_N2 stays noted through all of these)
api POST "/accomplishment-reports/$A_N2/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$T1_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Signer is the report's preparer (assertNotPreparer convention)" 409
api POST "/accomplishment-reports/$A_N2/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$PB2_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Signer belongs to another barangay -> 404 (no existence leak)" 404
api POST "/accomplishment-reports/$A_N2/record-paper-approval" "$SEC_T" "{\"signer_user_id\":99999999,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Signer id does not exist -> 404" 404
api POST "/accomplishment-reports/$A_N2/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$SEC_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Signer holds no authority at all" 422
api POST "/accomplishment-reports/$A_N2/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$NOSIG_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Signer holds note_report but NOT approve_report" 422
api POST "/accomplishment-reports/$A_N2/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$ADM_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Admin signer holds note_report/prepare_annex_d only" 422
api POST "/accomplishment-reports/$A_N2/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$SUSP_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Signer is suspended" 422
api POST "/accomplishment-reports/$A_N2/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$INACT_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Signer is inactive" 422
api POST "/accomplishment-reports/$A_N2/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$TAUTH_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Signer is a tanod (ineligible role even with the authority set)" 422
expect_eq "  after all those refusals A_N2 is still noted, untouched" "$(db_one "SELECT CONCAT(status,'/',approval_mode,'/',IFNULL(approved_by,'NULL'),'/',version) FROM accomplishment_report WHERE report_id=$A_N2;")" "noted/digital/NULL/1"

RPA_KEY=$(uuid)
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$SEC_T" "$RP_BODY" -H "Idempotency-Key: $RPA_KEY"
expect_code "Secretary records a paper approval signed by the Kagawad" 200
expect_eq "  status approved" "$(jget "$BODY" status)" "approved"
expect_eq "  approved_by = signer" "$(jget "$BODY" approved_by)" "$KAG_ID"
expect_eq "  approval_mode recorded_from_paper" "$(jget "$BODY" approval_mode)" "recorded_from_paper"
expect_eq "  paper_signed_on = signed_on" "$(jget "$BODY" paper_signed_on)" "$YESTERDAY"
expect_eq "  paper_recorded_by_name = recorder" "$(jget "$BODY" paper_recorded_by_name)" "PA Secretary"
expect_eq "  paper_pending false (the paper date is known)" "$(jget "$BODY" paper_pending)" "false"
expect_eq "  noted_by untouched" "$(jget "$BODY" noted_by)" "$PB_ID"
expect_eq "  DB approved_at set, paper_recorded_by = recorder" "$(db_one "SELECT CONCAT(approved_at IS NOT NULL,'/',paper_recorded_by) FROM accomplishment_report WHERE report_id=$A_N1;")" "1/$SEC_ID"
expect_eq "  audit approval_recorded_from_paper: one row" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='approval_recorded_from_paper' AND entity_type='accomplishment_report' AND entity_id=$A_N1;")" "1"
expect_eq "  audit metadata = ids/status only (no names, no dates)" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='approval_recorded_from_paper' AND entity_type='accomplishment_report' AND entity_id=$A_N1 LIMIT 1;")" '["report_id", "month", "status", "signer_user_id", "idempotency_key"]'
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$SEC_T" "$RP_BODY" -H "Idempotency-Key: $RPA_KEY"
expect_code "Replay (same Idempotency-Key) returns the original outcome" 200
expect_eq "  still exactly one audit row, version unchanged" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='approval_recorded_from_paper' AND entity_type='accomplishment_report' AND entity_id=$A_N1;")/$(jget "$BODY" version)" "1/2"
api POST "/accomplishment-reports/$A_N1/record-paper-approval" "$SEC_T" "$RP_BODY" -H "$(ik)"
expect_code "A NEW key on the now-approved report" 409
api POST "/accomplishment-reports/$A_N3/record-paper-approval" "$SEC2_T" "{\"signer_user_id\":$SEC2_ID,\"signed_on\":\"$TODAY\"}" -H "$(ik)"
expect_code "Recorder is also the signer (a Secretary holding approve_report)" 200
expect_eq "  approved_by = recorder = signer" "$(jget "$BODY" approved_by)/$(jget "$BODY" paper_recorded_by_name)" "$SEC2_ID/PA Secretary Two"
api POST "/accomplishment-reports/$A_N4/record-paper-approval" "$ADM_T" "{\"signer_user_id\":$PB_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Admin records, Punong Barangay signed on paper" 200
expect_eq "  approved_by = the PB, recorder = admin" "$(jget "$BODY" approved_by)/$(jget "$BODY" paper_recorded_by_name)" "$PB_ID/PA Admin"
api POST "/accomplishment-reports/$A_N5/record-paper-approval" "$ADM_T" "{\"signer_user_id\":\"$KAG_ID\",\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "signer_user_id sent as a digit string is accepted" 200

# ================================================================ D. locked after approval
step "5. An approved accomplishment report is locked on EVERY edit path"
# Paths that write to an accomplishment report or its entries:
#   POST /accomplishment-entries, PATCH /accomplishment-entries/:id, POST /sync/batch (accomplishment_entries[]),
#   POST .../submit, .../note, .../approve, .../return, .../record-paper-approval.
# The ONLY write an approved report accepts is .../paper-signature (a date; no content).
ENTRY_COUNT_BEFORE=$(db_one "SELECT COUNT(*) FROM accomplishment_entry WHERE report_id=$A_LOCK;")
LOCK_STATE_BEFORE=$(db_one "SELECT CONCAT(status,'/',version,'/',total_minutes_confirmed) FROM accomplishment_report WHERE report_id=$A_LOCK;")
api POST "/accomplishment-entries" "$T1_T" "{\"work_date\":\"$TODAY\",\"accomplishment_text\":\"Late entry\",\"duration_minutes\":30,\"client_event_id\":\"$(uuid)\"}" -H "$D_T1"
expect_code "POST /accomplishment-entries into the approved month" 409
api PATCH "/accomplishment-entries/$LOCK_ENTRY" "$T1_T" '{"accomplishment_text":"Edited after approval","duration_minutes":999}' -H "$D_T1"
expect_code "PATCH /accomplishment-entries/:id of an approved report" 409
SYNC_EVT=$(uuid)
api POST "/sync/batch" "$T1_T" "{\"device_id\":\"dev-pa-t1\",\"accomplishment_entries\":[{\"work_date\":\"$TODAY\",\"accomplishment_text\":\"Synced late\",\"duration_minutes\":20,\"client_event_id\":\"$SYNC_EVT\"}]}"
expect_code "POST /sync/batch with an entry into the approved month" 200
expect_eq "  the sync item itself is reported failed" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["results"] as $r){ if($r["client_event_id"]===$argv[1]) echo $r["status"]; }' "$SYNC_EVT")" "failed"
api POST "/accomplishment-reports/$A_LOCK/submit" "$T1_T" '{}' -H "$(ik)"
expect_code ".../submit by the owner" 409
api POST "/accomplishment-reports/$A_LOCK/note" "$PB_T" '{}' -H "$(ik)"
expect_code ".../note" 409
api POST "/accomplishment-reports/$A_LOCK/approve" "$PB_T" '{}' -H "$(ik)"
expect_code ".../approve a second time" 409
api POST "/accomplishment-reports/$A_LOCK/return" "$PB_T" '{"reason":"change my mind"}' -H "$(ik)"
expect_code ".../return an approved report" 409
api POST "/accomplishment-reports/$A_LOCK/return" "$KAG_T" '{"reason":"change my mind"}' -H "$(ik)"
expect_code ".../return by another authority holder" 409
api POST "/accomplishment-reports/$A_LOCK/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$KAG_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code ".../record-paper-approval on an approved report" 409
expect_eq "  entry count, status, version and minutes did not move" "$(db_one "SELECT COUNT(*) FROM accomplishment_entry WHERE report_id=$A_LOCK;")/$(db_one "SELECT CONCAT(status,'/',version,'/',total_minutes_confirmed) FROM accomplishment_report WHERE report_id=$A_LOCK;")" "$ENTRY_COUNT_BEFORE/$LOCK_STATE_BEFORE"
expect_eq "  the entry text is unchanged" "$(db_one "SELECT accomplishment_text FROM accomplishment_entry WHERE entry_id=$LOCK_ENTRY;")" "Locked-month entry"
api POST "/accomplishment-reports/$A_N1/return" "$PB_T" '{"reason":"x"}' -H "$(ik)"
expect_code "A paper-recorded approval is just as locked (.../return)" 409
api POST "/accomplishment-reports/$A_LOCK/paper-signature" "$SEC_T" "{\"paper_signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "The one allowed write: .../paper-signature" 200
expect_eq "  ...and it still changed no content" "$(db_one "SELECT COUNT(*) FROM accomplishment_entry WHERE report_id=$A_LOCK;")/$(db_one "SELECT CONCAT(status,'/',total_minutes_confirmed) FROM accomplishment_report WHERE report_id=$A_LOCK;")" "$ENTRY_COUNT_BEFORE/approved/60"

# ================================================================ E. Annex D
step "6. Annex D term report: object fields, flow, paper-signature, record-paper-approval, lock"
api GET "/ssz-term-reports/$S_LEG" "$SEC_T" ""
expect_code "Secretary GET legacy approved Annex D report" 200
expect_eq "  approval_mode/paper_signed_on/paper_pending (existing row)" "$(jget "$BODY" approval_mode)/$(jget "$BODY" paper_signed_on)/$(jget "$BODY" paper_pending)" "digital/null/true"
expect_eq "  paper_recorded_by_name / paper_recorded_at" "$(jget "$BODY" paper_recorded_by_name)/$(jget "$BODY" paper_recorded_at)" "null/null"

mk_ssz() { # label -> report id (admin creates a draft)
  api POST "/ssz-term-reports" "$ADM_T" "{\"term_label\":\"$1\",\"term_start\":\"2026-06-01\",\"term_end\":\"2026-10-01\"}" -H "$(ik)"
  jget "$BODY" report_id
}
prep_ssz() { api POST "/ssz-term-reports/$1/prepare" "$ADM_T" '{}' -H "$(ik)"; }
S_FLOW=$(mk_ssz "Flow Term"); prep_ssz "$S_FLOW"
expect_code "Admin prepares the flow report" 200
api POST "/ssz-term-reports/$S_FLOW/approve" "$PB_T" '{}' -H "$(ik)"
expect_code "Punong Barangay approves digitally" 200
expect_eq "  digital approval: approval_mode digital, paper_pending true" "$(jget "$BODY" approval_mode)/$(jget "$BODY" paper_pending)" "digital/true"
S_REC=$(mk_ssz "Paper Term"); prep_ssz "$S_REC"
S_DRAFT=$(mk_ssz "Draft Term")
S_BAD=$(mk_ssz "Refusal Term"); prep_ssz "$S_BAD"
api POST "/ssz-term-reports" "$ADM2_T" '{"term_label":"B2 Term","term_start":"2026-06-01","term_end":"2026-10-01"}' -H "$(ik)"
S_B2=$(jget "$BODY" report_id)
[ -n "$S_FLOW" ] && [ -n "$S_REC" ] && [ -n "$S_DRAFT" ] && [ -n "$S_BAD" ] && [ -n "$S_B2" ] && pass "Created Annex D reports through the API (flow/paper/draft/refusal + a barangay 2 one)" || fail "Annex D fixture creation failed"

api POST "/ssz-term-reports/$S_FLOW/paper-signature" "$T1_T" "$PS_BODY" -H "$(ik)"
expect_code "Annex D paper-signature: tanod" 403
api POST "/ssz-term-reports/$S_FLOW/paper-signature" "$PB_T" "$PS_BODY" -H "$(ik)"
expect_code "Annex D paper-signature: Punong Barangay" 403
api POST "/ssz-term-reports/$S_FLOW/paper-signature" "$SEC_T" "$PS_BODY"
expect_code "Annex D paper-signature: missing Idempotency-Key" 400
api POST "/ssz-term-reports/$S_FLOW/paper-signature" "$SEC_T" '{"paper_signed_on":"nope"}' -H "$(ik)"
expect_code "Annex D paper-signature: bad date" 400
api POST "/ssz-term-reports/$S_FLOW/paper-signature" "$SEC_T" "{\"paper_signed_on\":\"$TOMORROW\"}" -H "$(ik)"
expect_code "Annex D paper-signature: future date" 400
api POST "/ssz-term-reports/$S_FLOW/paper-signature" "$ADM2_T" "$PS_BODY" -H "$(ik)"
expect_code "Annex D paper-signature: cross-tenant" 404
api POST "/ssz-term-reports/99999999/paper-signature" "$SEC_T" "$PS_BODY" -H "$(ik)"
expect_code "Annex D paper-signature: unknown id" 404
api POST "/ssz-term-reports/$S_DRAFT/paper-signature" "$SEC_T" "$PS_BODY" -H "$(ik)"
expect_code "Annex D paper-signature: draft" 409
api POST "/ssz-term-reports/$S_REC/paper-signature" "$SEC_T" "$PS_BODY" -H "$(ik)"
expect_code "Annex D paper-signature: prepared" 409
SPS_KEY=$(uuid)
api POST "/ssz-term-reports/$S_FLOW/paper-signature" "$SEC_T" "$PS_BODY" -H "Idempotency-Key: $SPS_KEY"
expect_code "Annex D paper-signature on the approved report" 200
expect_eq "  paper_signed_on / paper_pending / recorder" "$(jget "$BODY" paper_signed_on)/$(jget "$BODY" paper_pending)/$(jget "$BODY" paper_recorded_by_name)" "$YESTERDAY/false/PA Secretary"
expect_eq "  status and approver unchanged" "$(jget "$BODY" status)/$(jget "$BODY" approved_by)/$(jget "$BODY" approval_mode)" "approved/$PB_ID/digital"
api POST "/ssz-term-reports/$S_FLOW/paper-signature" "$SEC_T" "$PS_BODY" -H "Idempotency-Key: $SPS_KEY"
expect_code "Annex D paper-signature replay" 200
expect_eq "  exactly one audit row for the replayed key" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='paper_signature_recorded' AND entity_type='ssz_term_report' AND entity_id=$S_FLOW;")" "1"
expect_eq "  audit metadata = ids/status only" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='paper_signature_recorded' AND entity_type='ssz_term_report' AND entity_id=$S_FLOW LIMIT 1;")" '["report_id", "status", "idempotency_key"]'
api GET "/ssz-term-reports?status=approved" "$PB_T" ""
expect_eq "  list items carry paper fields too" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $ok=0; foreach($d["items"] as $i){ if(array_key_exists("paper_pending",$i)&&array_key_exists("approval_mode",$i)&&array_key_exists("paper_recorded_by_name",$i)) $ok++; } echo $ok."/".count($d["items"]);')" "2/2"

SRP_BODY="{\"signer_user_id\":$KAG_ID,\"signed_on\":\"$YESTERDAY\"}"
api POST "/ssz-term-reports/$S_REC/record-paper-approval" "$T1_T" "$SRP_BODY" -H "$(ik)"
expect_code "Annex D record-paper-approval: tanod" 403
api POST "/ssz-term-reports/$S_REC/record-paper-approval" "$PB_T" "$SRP_BODY" -H "$(ik)"
expect_code "Annex D record-paper-approval: Punong Barangay" 403
api POST "/ssz-term-reports/$S_REC/record-paper-approval" "$SEC_T" "$SRP_BODY"
expect_code "Annex D record-paper-approval: missing Idempotency-Key" 400
api POST "/ssz-term-reports/$S_REC/record-paper-approval" "$SEC_T" "{\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Annex D record-paper-approval: missing signer" 400
api POST "/ssz-term-reports/$S_REC/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$KAG_ID,\"signed_on\":\"$TOMORROW\"}" -H "$(ik)"
expect_code "Annex D record-paper-approval: future signed_on" 400
api POST "/ssz-term-reports/$S_REC/record-paper-approval" "$ADM2_T" "{\"signer_user_id\":$PB2_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Annex D record-paper-approval: cross-tenant" 404
api POST "/ssz-term-reports/$S_DRAFT/record-paper-approval" "$SEC_T" "$SRP_BODY" -H "$(ik)"
expect_code "Annex D record-paper-approval: draft" 409
api POST "/ssz-term-reports/$S_FLOW/record-paper-approval" "$SEC_T" "$SRP_BODY" -H "$(ik)"
expect_code "Annex D record-paper-approval: already approved" 409
api POST "/ssz-term-reports/$S_BAD/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$ADM_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Annex D signer is the preparer" 409
api POST "/ssz-term-reports/$S_BAD/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$PB2_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Annex D signer in another barangay" 404
api POST "/ssz-term-reports/$S_BAD/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$SEC_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Annex D signer holds no authority" 422
api POST "/ssz-term-reports/$S_BAD/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$SEC2_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Annex D signer holds approve_report but NOT approve_annex_d" 422
api POST "/ssz-term-reports/$S_BAD/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$SUSP_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Annex D signer suspended" 422
api POST "/ssz-term-reports/$S_BAD/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$INACT_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Annex D signer inactive" 422
api POST "/ssz-term-reports/$S_BAD/record-paper-approval" "$SEC_T" "{\"signer_user_id\":$TAUTH_ID,\"signed_on\":\"$YESTERDAY\"}" -H "$(ik)"
expect_code "Annex D signer is a tanod" 422
expect_eq "  refusals left the report prepared" "$(db_one "SELECT CONCAT(status,'/',approval_mode,'/',IFNULL(approved_by,'NULL')) FROM ssz_term_report WHERE report_id=$S_BAD;")" "prepared/digital/NULL"
SRPA_KEY=$(uuid)
api POST "/ssz-term-reports/$S_REC/record-paper-approval" "$SEC_T" "$SRP_BODY" -H "Idempotency-Key: $SRPA_KEY"
expect_code "Annex D record-paper-approval succeeds" 200
expect_eq "  status/approved_by/approval_mode" "$(jget "$BODY" status)/$(jget "$BODY" approved_by)/$(jget "$BODY" approval_mode)" "approved/$KAG_ID/recorded_from_paper"
expect_eq "  approved_by_name/title come from the signer" "$(jget "$BODY" approved_by_name)/$(jget "$BODY" approved_by_title)" "PA Kagawad/Kagawad"
expect_eq "  paper date / pending / recorder" "$(jget "$BODY" paper_signed_on)/$(jget "$BODY" paper_pending)/$(jget "$BODY" paper_recorded_by_name)" "$YESTERDAY/false/PA Secretary"
expect_eq "  prepared_by untouched" "$(jget "$BODY" prepared_by)" "$ADM_ID"
api POST "/ssz-term-reports/$S_REC/record-paper-approval" "$SEC_T" "$SRP_BODY" -H "Idempotency-Key: $SRPA_KEY"
expect_code "Annex D record-paper-approval replay" 200
expect_eq "  one audit row; metadata ids/status only" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='approval_recorded_from_paper' AND entity_type='ssz_term_report' AND entity_id=$S_REC;")/$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='approval_recorded_from_paper' AND entity_type='ssz_term_report' AND entity_id=$S_REC LIMIT 1;")" '1/["report_id", "status", "signer_user_id", "idempotency_key"]'

# Lock: an approved Annex D report
# Paths that write to a term report: PATCH /:id (draft only), /prepare (draft only), /approve (prepared only),
# /record-paper-approval (prepared only), /mark-submitted (approved -> submitted, the intended forward step).
for sid in "$S_FLOW" "$S_REC"; do
  api PATCH "/ssz-term-reports/$sid" "$ADM_T" '{"remarks":"edited after approval"}' -H "$(ik)"
  expect_code "Annex D #$sid: PATCH after approval" 409
  api POST "/ssz-term-reports/$sid/prepare" "$ADM_T" '{}' -H "$(ik)"
  expect_code "Annex D #$sid: prepare again" 409
  api POST "/ssz-term-reports/$sid/approve" "$PB_T" '{}' -H "$(ik)"
  expect_code "Annex D #$sid: approve again" 409
  api POST "/ssz-term-reports/$sid/record-paper-approval" "$SEC_T" "$SRP_BODY" -H "$(ik)"
  expect_code "Annex D #$sid: record-paper-approval again" 409
done
expect_eq "  remarks untouched on the approved reports" "$(db_one "SELECT COUNT(*) FROM ssz_term_report WHERE report_id IN ($S_FLOW,$S_REC) AND remarks IS NOT NULL;")" "0"

# ================================================================ F. scans
step "7. Scan fixtures"
"$PHP_BIN" -r '
$d = $argv[1];
file_put_contents("$d/ok.png", base64_decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="));
file_put_contents("$d/ok.jpg", base64_decode("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="));
file_put_contents("$d/ok.pdf", "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
file_put_contents("$d/ok2.pdf", "%PDF-1.4\n% second document\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
file_put_contents("$d/evil.pdf", "MZ\x90\x00\x03\x00\x00\x00 not a pdf, a renamed executable");
file_put_contents("$d/notes.png", "student names: just text pretending to be an image");
file_put_contents("$d/html.pdf", "<html><script>alert(1)</script></html>");
file_put_contents("$d/empty.pdf", "");
' "$TMP_W"
{ printf '%%PDF-1.4\n'; head -c $((10485760-9)) /dev/zero; } > "$TMP_DIR/exact10mb.pdf"
{ printf '%%PDF-1.4\n'; head -c $((10485761-9)) /dev/zero; } > "$TMP_DIR/over10mb.pdf"
{ printf '%%PDF-1.4\n'; head -c $((30*1024*1024)) /dev/zero; } > "$TMP_DIR/huge30mb.pdf"
expect_eq "exact10mb.pdf is exactly 10 MB" "$(stat -c %s "$TMP_DIR/exact10mb.pdf")" "10485760"
expect_eq "over10mb.pdf is 10 MB + 1 byte" "$(stat -c %s "$TMP_DIR/over10mb.pdf")" "10485761"

step "8. POST /document-scans — gates and validation"
PDF_W="$TMP_W/ok.pdf"
upload "$T1_T" accomplishment_report "$A_LEG" "$PDF_W"
expect_code "Tanod upload" 403
upload "$PB_T" accomplishment_report "$A_LEG" "$PDF_W"
expect_code "Punong Barangay upload (admin|secretary only)" 403
upload "" accomplishment_report "$A_LEG" "$PDF_W"
expect_code "No token" 401
upload "$SEC_T" "" "$A_LEG" "$PDF_W"
expect_code "Missing entity_type" 400
upload "$SEC_T" blotter "$A_LEG" "$PDF_W"
expect_code "Unknown entity_type" 400
upload "$SEC_T" accomplishment_report "" "$PDF_W"
expect_code "Missing entity_id" 400
upload "$SEC_T" accomplishment_report "abc" "$PDF_W"
expect_code "Non-numeric entity_id" 400
upload "$SEC_T" accomplishment_report "$A_LEG" ""
expect_code "Missing file" 400
upload "$SEC_T" accomplishment_report 99999999 "$PDF_W"
expect_code "Unknown report" 404
upload "$ADM2_T" accomplishment_report "$A_LEG" "$PDF_W"
expect_code "Cross-tenant upload is 404, never 403" 404
upload "$ADM2_T" ssz_term_report "$S_FLOW" "$PDF_W"
expect_code "Cross-tenant upload (Annex D) is 404" 404
upload "$SEC_T" accomplishment_report "$A_B2" "$PDF_W"
expect_code "Barangay 1 secretary onto a barangay 2 report" 404
upload "$SEC_T" accomplishment_report "$A_PREP" "$PDF_W"
expect_code "Report not yet approved (prepared)" 409
upload "$SEC_T" accomplishment_report "$A_OPEN" "$PDF_W"
expect_code "Report not yet approved (open)" 409
upload "$SEC_T" ssz_term_report "$S_DRAFT" "$PDF_W"
expect_code "Annex D draft" 409
upload "$SEC_T" ssz_term_report "$S_BAD" "$PDF_W"
expect_code "Annex D prepared" 409
expect_eq "  nothing was stored by any refused upload" "$(scan_files)/$(db_one "SELECT COUNT(*) FROM document_scan;")" "0/0"
upload "$SEC_T" accomplishment_report "$A_LEG" "$TMP_W/evil.pdf"
expect_code "Renamed .exe (MZ header) as evil.pdf" 400
upload "$SEC_T" accomplishment_report "$A_LEG" "$TMP_W/notes.png"
expect_code "Plain text named .png" 400
upload "$SEC_T" accomplishment_report "$A_LEG" "$TMP_W/html.pdf"
expect_code "HTML named .pdf" 400
upload "$SEC_T" accomplishment_report "$A_LEG" "" -F "file=@$TMP_W/evil.pdf;type=application/pdf"
expect_code "Executable that CLAIMS application/pdf" 400
upload "$SEC_T" accomplishment_report "$A_LEG" "$TMP_W/empty.pdf"
expect_code "Empty file" 400
upload "$SEC_T" accomplishment_report "$A_LEG" "$TMP_W/over10mb.pdf"
expect_code "10 MB + 1 byte" 400
upload "$SEC_T" accomplishment_report "$A_LEG" "$TMP_W/huge30mb.pdf"
expect_code "30 MB (beyond even post_max_size)" 400
expect_eq "  still nothing stored after every rejection" "$(scan_files)/$(db_one "SELECT COUNT(*) FROM document_scan;")" "0/0"

step "9. POST /document-scans — accepted uploads"
upload "$SEC_T" accomplishment_report "$A_LEG" "$PDF_W"
expect_code "Secretary uploads a PDF to an approved accomplishment report" 201
SCAN1=$(jget "$BODY" scan_id)
expect_eq "  mime_type / size / sha256 are the server's own" "$(jget "$BODY" mime_type)/$(jget "$BODY" size_bytes)/$(jget "$BODY" sha256)" "application/pdf/$(stat -c %s "$TMP_DIR/ok.pdf")/$(file_sha "$TMP_DIR/ok.pdf")"
expect_eq "  entity + uploader fields" "$(jget "$BODY" entity_type)/$(jget "$BODY" entity_id)/$(jget "$BODY" uploaded_by)/$(jget "$BODY" uploaded_by_name)" "accomplishment_report/$A_LEG/$SEC_ID/PA Secretary"
expect_eq "  response never carries stored_path (or any path)" "$(printf '%s' "$BODY" | grep -ciE 'stored_path|storage|scan-[0-9]')" "0"
expect_eq "  exactly one file on disk, under SCANS_DIR" "$(scan_files)" "1"
STORED=$(db_one "SELECT stored_path FROM document_scan WHERE scan_id=$SCAN1;")
expect_eq "  stored name is server-generated (scan-<barangay>-<id>-<hex>.pdf), not the client's" "$(printf '%s' "$STORED" | grep -cE '^scan-1-[0-9]+-[0-9a-f]{24}\.pdf$')" "1"
expect_eq "  stored file bytes == uploaded bytes" "$(file_sha "$SCANS_LOCAL/$STORED")" "$(file_sha "$TMP_DIR/ok.pdf")"
expect_eq "  SCANS_DIR is outside the web root" "$( [[ "$SCANS_LOCAL" == "$BACKEND_DIR/public"* ]] && echo inside || echo outside )" "outside"
expect_eq "  audit document_scan_uploaded metadata = ids only" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='document_scan_uploaded' AND entity_id=$SCAN1;")" '["scan_id", "entity_type", "entity_id"]'
upload "$SEC_T" accomplishment_report "$A_LEG" "$PDF_W"
expect_code "Same bytes to the same report again (de-dupe by sha256 + entity)" 200
expect_eq "  same scan_id, still one file and one row" "$(jget "$BODY" scan_id)/$(scan_files)/$(db_one "SELECT COUNT(*) FROM document_scan;")" "$SCAN1/1/1"
upload "$ADM_T" accomplishment_report "$A_LEG" "$TMP_W/ok.jpg"
expect_code "Admin uploads a JPEG" 201
SCAN2=$(jget "$BODY" scan_id)
expect_eq "  stored as image/jpeg with a .jpg name" "$(jget "$BODY" mime_type)/$(db_one "SELECT stored_path FROM document_scan WHERE scan_id=$SCAN2;" | grep -cE '\.jpg$')" "image/jpeg/1"
upload "$SEC_T" accomplishment_report "$A_LEG" "$TMP_W/ok.png"
expect_code "PNG" 201
SCAN3=$(jget "$BODY" scan_id)
expect_eq "  image/png" "$(jget "$BODY" mime_type)" "image/png"
upload "$SEC_T" accomplishment_report "$A_N1" "" -F "file=@$TMP_W/ok2.pdf;type=image/png"
expect_code "PDF with a client Content-Type of image/png on another report" 201
expect_eq "  mime is decided by magic bytes, not by the client" "$(jget "$BODY" mime_type)" "application/pdf"
upload "$SEC_T" accomplishment_report "$A_LEG" "" -F "file=@$TMP_W/ok2.pdf;filename=Juan_Dela_Cruz_student_list.exe"
expect_code "A hostile client filename is accepted as bytes but never kept" 201
SCAN4=$(jget "$BODY" scan_id)
expect_eq "  no trace of the client filename in DB, files or response" "$(db_one "SELECT COUNT(*) FROM document_scan WHERE stored_path LIKE '%Juan%' OR stored_path LIKE '%.exe';")/$(find "$SCANS_LOCAL" -name '*Juan*' | wc -l | tr -d ' ')/$(printf '%s' "$BODY" | grep -c Juan)" "0/0/0"
upload "$SEC_T" accomplishment_report "$A_N2" "$TMP_W/exact10mb.pdf"
expect_code "Exactly 10 MB onto a not-approved report: the state gate answers first" 409
upload "$SEC_T" accomplishment_report "$A_N1" "$TMP_W/exact10mb.pdf"
expect_code "Exactly 10 MB is accepted (on an approved report)" 201
SCAN_BIG=$(jget "$BODY" scan_id)
expect_eq "  size_bytes 10485760" "$(jget "$BODY" size_bytes)" "10485760"
upload "$SEC_T" ssz_term_report "$S_FLOW" "$PDF_W"
expect_code "Annex D approved: upload" 201
SSCAN1=$(jget "$BODY" scan_id)
expect_eq "  entity_type ssz_term_report" "$(jget "$BODY" entity_type)/$(jget "$BODY" entity_id)" "ssz_term_report/$S_FLOW"
expect_eq "  the same bytes may be attached to different reports (de-dupe is per entity)" "$(db_one "SELECT COUNT(*) FROM document_scan WHERE sha256='$(file_sha "$TMP_DIR/ok.pdf")';")" "2"

step "10. Annex D submitted still accepts scans"
api POST "/ssz-term-reports/$S_FLOW/mark-submitted" "$SEC_T" '{"mayor_office_received_by":"Mayor Office Clerk","mayor_office_received_at":"'"$TODAY"'"}' -H "$(ik)"
expect_code "mark-submitted (the intended forward step off 'approved')" 200
upload "$SEC_T" ssz_term_report "$S_FLOW" "$TMP_W/ok.jpg"
expect_code "Upload to a SUBMITTED Annex D report" 201
api PATCH "/ssz-term-reports/$S_FLOW" "$ADM_T" '{"remarks":"x"}' -H "$(ik)"
expect_code "PATCH after submitted" 409
api POST "/ssz-term-reports/$S_FLOW/paper-signature" "$SEC_T" "$PS_BODY" -H "$(ik)"
expect_code "paper-signature after submitted (allowed: paper date may follow filing)" 200

step "11. GET /document-scans (list)"
api GET "/document-scans?entity_type=accomplishment_report&entity_id=$A_LEG" "$PB_T" ""
expect_code "Punong Barangay can list scans" 200
expect_eq "  4 scans on the legacy report (pdf, jpg, png, second pdf)" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo count($d["items"]);')" "4"
expect_eq "  list never exposes stored_path / filesystem names" "$(printf '%s' "$BODY" | grep -ciE 'stored_path|scan-1-')" "0"
expect_eq "  item keys" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo implode(",",array_keys($d["items"][0]));')" "scan_id,entity_type,entity_id,mime_type,size_bytes,sha256,uploaded_by,uploaded_by_name,uploaded_at"
api GET "/document-scans?entity_type=accomplishment_report&entity_id=$A_LEG" "$SEC_T" ""
expect_code "Secretary list" 200
api GET "/document-scans?entity_type=accomplishment_report&entity_id=$A_LEG" "$ADM_T" ""
expect_code "Admin list" 200
api GET "/document-scans?entity_type=accomplishment_report&entity_id=$A_LEG" "$T1_T" ""
expect_code "Tanod list (even for their own report)" 403
api GET "/document-scans?entity_type=accomplishment_report&entity_id=$A_LEG" "$ADM2_T" ""
expect_code "Cross-tenant list is 404" 404
api GET "/document-scans?entity_type=ssz_term_report&entity_id=$S_FLOW" "$PB2_T" ""
expect_code "Cross-tenant list (Annex D) is 404" 404
api GET "/document-scans?entity_type=accomplishment_report&entity_id=99999999" "$SEC_T" ""
expect_code "Unknown report" 404
api GET "/document-scans?entity_type=accomplishment_report" "$SEC_T" ""
expect_code "Missing entity_id" 400
api GET "/document-scans?entity_id=$A_LEG" "$SEC_T" ""
expect_code "Missing entity_type" 400
api GET "/document-scans?entity_type=nope&entity_id=$A_LEG" "$SEC_T" ""
expect_code "Bad entity_type" 400
api GET "/document-scans?entity_type=accomplishment_report&entity_id=$A_DIG" "$SEC_T" ""
expect_eq "Report with no scans -> empty items (200)" "$CODE/$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo count($d["items"]);')" "200/0"
api GET "/document-scans?entity_type=ssz_term_report&entity_id=$S_FLOW" "$PB_T" ""
expect_eq "Annex D list is scoped to ssz_term_report (2 scans, not the accomplishment one)" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); echo count($d["items"]);')" "2"

step "12. GET /document-scans/:id/download"
dl() { # token scan_id -> CODE, headers in $TMP_DIR/h.txt, body in $TMP_DIR/dl.bin
  CODE=$(curl -s -D "$TMP_DIR/h.txt" -o "$TMP_DIR/dl.bin" -w '%{http_code}' -H "Authorization: Bearer $1" "${BASE_URL}/document-scans/$2/download")
  BODY=$(head -c 300 "$TMP_DIR/dl.bin" 2>/dev/null)
}
hdr() { grep -i "^$1:" "$TMP_DIR/h.txt" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
dl "$PB_T" "$SCAN1"
expect_code "Punong Barangay downloads" 200
expect_eq "  bytes identical to the upload" "$(file_sha "$TMP_DIR/dl.bin")" "$(file_sha "$TMP_DIR/ok.pdf")"
expect_eq "  Content-Type" "$(hdr content-type)" "application/pdf"
expect_eq "  Content-Disposition is attachment with a neutral name" "$(hdr content-disposition)" "attachment; filename=\"scan-$SCAN1.pdf\""
expect_eq "  X-Content-Type-Options" "$(hdr x-content-type-options)" "nosniff"
expect_eq "  Cache-Control" "$(hdr cache-control)" "private, no-store"
expect_eq "  Content-Security-Policy sandbox" "$(hdr content-security-policy)" "default-src 'none'; sandbox"
expect_eq "  Content-Length" "$(hdr content-length)" "$(stat -c %s "$TMP_DIR/ok.pdf")"
dl "$SEC_T" "$SCAN2"
expect_eq "JPEG download: type + extension" "$CODE/$(hdr content-type)/$(hdr content-disposition)" "200/image/jpeg/attachment; filename=\"scan-$SCAN2.jpg\""
dl "$ADM_T" "$SCAN3"
expect_eq "PNG download as admin: type + extension" "$CODE/$(hdr content-type)/$(hdr content-disposition)" "200/image/png/attachment; filename=\"scan-$SCAN3.png\""
dl "$SEC_T" "$SCAN_BIG"
expect_eq "10 MB download streams completely" "$CODE/$(stat -c %s "$TMP_DIR/dl.bin")" "200/10485760"
dl "$T1_T" "$SCAN1"
expect_code "Tanod download" 403
dl "$ADM2_T" "$SCAN1"
expect_code "Cross-tenant download is 404" 404
dl "$PB2_T" "$SSCAN1"
expect_code "Cross-tenant download (Annex D scan) is 404" 404
dl "$SEC_T" 99999999
expect_code "Unknown scan" 404
dl "" "$SCAN1"
expect_code "No token" 401
expect_eq "  audit document_scan_downloaded exists, metadata ids only" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='document_scan_downloaded' AND entity_id=$SCAN1;")/$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='document_scan_downloaded' AND entity_id=$SCAN1 LIMIT 1;")" '1/["scan_id", "entity_type", "entity_id"]'
mysql_exec "$VALDB" -e "UPDATE document_scan SET mime_type='text/html' WHERE scan_id=$SCAN4;"
dl "$SEC_T" "$SCAN4"
expect_eq "A tampered stored mime_type is never echoed (falls back to octet-stream + nosniff)" "$CODE/$(hdr content-type)/$(hdr x-content-type-options)" "200/application/octet-stream/nosniff"
rm -f "$SCANS_LOCAL/$STORED"
dl "$SEC_T" "$SCAN1"
expect_eq "File missing on disk -> 503" "$CODE" "503"
expect_eq "  error body leaks no path" "$(grep -ciE 'storage|scans|[A-Za-z]:[/\\]|stored_path' "$TMP_DIR/dl.bin")" "0"

step "13. Direct-access sanity"
expect_eq "Nothing under backend/public serves scan bytes" "$(find "$BACKEND_DIR/public" -iname 'scan-*' | wc -l | tr -d ' ')" "0"

echo
echo "============================================================"
echo "Result: $PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
[ "$FAIL" -eq 0 ]
