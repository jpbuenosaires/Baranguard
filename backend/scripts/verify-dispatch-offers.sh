#!/usr/bin/env bash
# Baranguard — Wave 2 / Agent E validation (review decisions 2026-10-07):
# night-time dispatch offers (migration 0038), the sweeper, notification
# payload rules, roster recorded-from-paper, and the dispatch status-override
# audit fix.
#
# Safe to run: disposable database, disposable app-user, throwaway ports
# 9001 (night clock), 9002 (day clock), 9003 (night clock + injected offer
# fault). The real databases and backend/.env are never touched.
#
# TEST SEAMS used (read by OfferService ONLY when APP_ENV is set and not
# "production"): BARANGUARD_NOW_OVERRIDE (fake clock) and
# BARANGUARD_TEST_OFFER_FAULT=1. Fake night = 2026-10-08T13:00:00Z =
# 21:00 Manila; fake day = 2026-10-08T04:00:00Z = 12:00 Manila.
#
# Usage: bash backend/scripts/verify-dispatch-offers.sh

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
VALDB="baranguard_offers_check"
APP_USER="offers_app"
APP_PASSWORD="OffersDbPw!2026"
NIGHT_PORT="9001"
DAY_PORT="9002"
FAULT_PORT="9003"
NIGHT_URL="http://127.0.0.1:${NIGHT_PORT}/api/v1"
DAY_URL="http://127.0.0.1:${DAY_PORT}/api/v1"
FAULT_URL="http://127.0.0.1:${FAULT_PORT}/api/v1"
BASE_URL="$NIGHT_URL"
TEST_PW="Offers#2026Pw"
FAKE_NIGHT="2026-10-08T13:00:00Z"
FAKE_DAY="2026-10-08T04:00:00Z"

echo "Baranguard Wave 2E (dispatch offers) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
db_run() { mysql_exec "$VALDB" -e "$1" >/dev/null 2>&1; }

TMP_DIR="$(mktemp -d)"
cleanup() {
  step "Cleanup"
  for port in $NIGHT_PORT $DAY_PORT $FAULT_PORT; do
    for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${port} " | grep LISTENING | awk '{print $NF}' | sort -u); do
      taskkill //F //PID "$pid" >/dev/null 2>&1
    done
  done
  for pid in ${SERVER_PIDS:-}; do kill "$pid" 2>/dev/null; done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; DROP DATABASE IF EXISTS \`${VALDB}_rt\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$TMP_DIR"
  rm -f "$BACKEND_DIR/scripts/.offers-server-"*.log
  echo "Stopped the test PHP servers, dropped $VALDB and user '$APP_USER'."
  echo "Your real databases and backend/.env were never touched."
}
trap cleanup EXIT

# ---------------------------------------------------------------- helpers
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }
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
expect_code() { [ "$CODE" = "$2" ] && pass "$1 -> $2" || fail "$1 -> $CODE (expected $2): ${BODY:0:300}"; }
expect_eq() { [ "$2" = "$3" ] && pass "$1 (= $3)" || fail "$1: got '$2', expected '$3'"; }
login_as() {
  curl -s "${NIGHT_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" \
    | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";'
}
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
recips() { db_one "SELECT IFNULL(GROUP_CONCAT(user_id ORDER BY user_id),'') FROM dispatch_offer_recipient WHERE offer_id=$1;"; }
recip_status() { db_one "SELECT IFNULL(status,'none') FROM dispatch_offer_recipient WHERE offer_id=$1 AND user_id=$2;"; }
offer_field() { db_one "SELECT IFNULL($2,'NULL') FROM dispatch_offer WHERE offer_id=$1;"; }
# number of items in .items of $1 with offer_id == $2
offer_listed() { printf '%s' "$1" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=0; foreach(($d["items"] ?? []) as $r){ if($r["offer_id"]==(int)$argv[1]) $n++; } echo $n;' "$2"; }

# Runs PHP against the disposable DB with the fake clock (test seams on).
# php_run <fake-now> <file.php> [args]
php_run() {
  local fake="$1" file="$2"; shift 2
  DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB" \
    APP_ENV=test BARANGUARD_NOW_OVERRIDE="$fake" "$PHP_BIN" "$file" "$@"
}
BOOT="$BACKEND_DIR"
cat > "$TMP_DIR/boot.php" <<PHP
<?php
require '$(cygpath -m "$BACKEND_DIR")/config/env.php';
baranguard_load_env();
require '$(cygpath -m "$BACKEND_DIR")/config/autoload.php';
require '$(cygpath -m "$BACKEND_DIR")/config/db.php';
\$pdo = baranguard_db_fresh();
PHP
BOOT_PATH="$(cygpath -m "$TMP_DIR/boot.php")"

# ---------------------------------------------------------------- 0
step "0. Disposable schema (FULL migration chain) + migration 0038"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain applied (all migrations/*.sql, globbed)"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

expect_eq "0038: dispatch_offer table exists" "$(db_one "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME IN ('dispatch_offer','dispatch_offer_recipient');")" "2"
expect_eq "0038: notification.dispatch_offer_id exists" "$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='notification' AND COLUMN_NAME='dispatch_offer_id';")" "1"
expect_eq "0038: notification_type enum has dispatch_offer" "$(db_one "SELECT COLUMN_TYPE LIKE '%dispatch_offer%' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='notification' AND COLUMN_NAME='notification_type';")" "1"
expect_eq "0038: shift_schedule has the 4 paper columns" "$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='shift_schedule' AND COLUMN_NAME IN ('approval_mode','paper_signed_on','paper_recorded_by','paper_recorded_at');")" "4"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0038_dispatch_offers_and_roster_paper.sql" >/dev/null 2>&1 \
  && pass "0038 is idempotent (re-applied cleanly)" || fail "0038 re-apply failed"

RT_DB="${VALDB}_rt"
mysql_exec -e "DROP DATABASE IF EXISTS \`$RT_DB\`; CREATE DATABASE \`$RT_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort); do
  mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1
done
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0038_dispatch_offers_and_roster_paper.down.sql" >/dev/null 2>&1 && pass "0038 .down.sql applies cleanly" || fail "0038 .down.sql failed"
GONE=$(mysql_exec -N -s -e "SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$RT_DB' AND TABLE_NAME LIKE 'dispatch_offer%') + (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$RT_DB' AND ((TABLE_NAME='notification' AND COLUMN_NAME='dispatch_offer_id') OR (TABLE_NAME='shift_schedule' AND COLUMN_NAME IN ('approval_mode','paper_signed_on','paper_recorded_by','paper_recorded_at'))));" | tr -d '\r')
expect_eq "Down migration removed both tables and all 5 columns" "$GONE" "0"
mysql_exec "$RT_DB" < "$BACKEND_DIR/migrations/0038_dispatch_offers_and_roster_paper.sql" >/dev/null 2>&1 && pass "0038 re-applies after rollback" || fail "0038 re-apply after rollback failed"
mysql_exec -e "DROP DATABASE IF EXISTS \`$RT_DB\`;" >/dev/null 2>&1

# ---------------------------------------------------------------- 1 seed
step "1. Seed accounts, shifts, duty status"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, contact_number, is_active, is_suspended, created_at) VALUES
  (1, 'of_admin',  '$HASH', 'OF Admin',      'admin',           '+639170000100', 1, 0, UTC_TIMESTAMP()),
  (1, 'of_admin_b','$HASH', 'OF Admin Later','admin',           '+639170000101', 1, 0, UTC_TIMESTAMP()),
  (1, 'of_pb',     '$HASH', 'OF Punong',     'punong_barangay', NULL,            1, 0, UTC_TIMESTAMP()),
  (1, 'of_sec',    '$HASH', 'OF Secretary',  'secretary',       NULL,            1, 0, UTC_TIMESTAMP()),
  (1, 'of_t1',     '$HASH', 'OF Tanod One',  'tanod',           '+639170000001', 1, 0, UTC_TIMESTAMP()),
  (1, 'of_t2',     '$HASH', 'OF Tanod Two',  'tanod',           '+639170000002', 1, 0, UTC_TIMESTAMP()),
  (1, 'of_t3',     '$HASH', 'OF Tanod Three','tanod',           '+639170000003', 1, 0, UTC_TIMESTAMP()),
  (1, 'of_t4',     '$HASH', 'OF Tanod Four', 'tanod',           '+639170000004', 1, 0, UTC_TIMESTAMP()),
  (1, 'of_t5',     '$HASH', 'OF Tanod Five', 'tanod',           '+639170000005', 1, 0, UTC_TIMESTAMP()),
  (1, 'of_t6',     '$HASH', 'OF Tanod Six',  'tanod',           '+639170000006', 1, 0, UTC_TIMESTAMP()),
  (1, 'of_t7',     '$HASH', 'OF Tanod Seven','tanod',           '+639170000007', 1, 1, UTC_TIMESTAMP()),
  (1, 'of_t8',     '$HASH', 'OF Tanod Eight','tanod',           '+639170000008', 1, 0, UTC_TIMESTAMP()),
  (2, 'of_admin2', '$HASH', 'OF Admin B2',   'admin',           NULL,            1, 0, UTC_TIMESTAMP()),
  (2, 'of_t_b2',   '$HASH', 'OF Tanod B2',   'tanod',           '+639170000020', 1, 0, UTC_TIMESTAMP()),
  (3, 'of_admin3', '$HASH', 'OF Admin B3',   'admin',           NULL,            1, 0, UTC_TIMESTAMP());
SQL
ADMIN_ID=$(uid of_admin); ADMINB_ID=$(uid of_admin_b); PB_ID=$(uid of_pb); SEC_ID=$(uid of_sec)
T1=$(uid of_t1); T2=$(uid of_t2); T3=$(uid of_t3); T4=$(uid of_t4); T5=$(uid of_t5); T6=$(uid of_t6); T7=$(uid of_t7); T8=$(uid of_t8)
ADMIN2_ID=$(uid of_admin2); TB2=$(uid of_t_b2); ADMIN3_ID=$(uid of_admin3)
B1NAME=$(db_one "SELECT name FROM barangay WHERE barangay_id=1;")
db_run "UPDATE user SET approval_authority='approve_roster' WHERE user_id=$PB_ID; UPDATE user SET approval_authority='' WHERE user_id IN ($ADMIN_ID,$SEC_ID);"
# duty: t3 off, t5 responding, everyone else on duty
for t in $T1 $T2 $T4 $T6 $T7 $T8 $TB2; do db_run "INSERT INTO duty_status (user_id,status,channel,changed_at) VALUES ($t,'on_duty','app',UTC_TIMESTAMP());"; done
db_run "INSERT INTO duty_status (user_id,status,channel,changed_at) VALUES ($T3,'on_duty','app',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR)),($T3,'off_duty','app',UTC_TIMESTAMP());"
db_run "INSERT INTO duty_status (user_id,status,channel,changed_at) VALUES ($T5,'on_duty','app',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR)),($T5,'responding','app',UTC_TIMESTAMP());"
# shifts around the FAKE night (2026-10-08 13:00Z). Published covering: t1,t2,t3,t5,t6,t7,tb2. Draft: t4. Ended: t8.
mysql_exec "$VALDB" <<SQL
INSERT INTO shift_schedule (barangay_id,user_id,patrol_zone,start_at,end_at,created_by,approval_status,approved_by,approved_at) VALUES
  (1,$T1,'Z','2026-10-08 08:00:00','2026-10-08 20:00:00',$ADMIN_ID,'published',$PB_ID,UTC_TIMESTAMP()),
  (1,$T2,'Z','2026-10-08 08:00:00','2026-10-08 20:00:00',$ADMIN_ID,'published',$PB_ID,UTC_TIMESTAMP()),
  (1,$T3,'Z','2026-10-08 08:00:00','2026-10-08 20:00:00',$ADMIN_ID,'published',$PB_ID,UTC_TIMESTAMP()),
  (1,$T5,'Z','2026-10-08 08:00:00','2026-10-08 20:00:00',$ADMIN_ID,'published',$PB_ID,UTC_TIMESTAMP()),
  (1,$T6,'Z','2026-10-08 08:00:00','2026-10-08 20:00:00',$ADMIN_ID,'published',$PB_ID,UTC_TIMESTAMP()),
  (1,$T7,'Z','2026-10-08 08:00:00','2026-10-08 20:00:00',$ADMIN_ID,'published',$PB_ID,UTC_TIMESTAMP()),
  (2,$TB2,'Z','2026-10-08 08:00:00','2026-10-08 20:00:00',$ADMIN2_ID,'published',$ADMIN2_ID,UTC_TIMESTAMP());
INSERT INTO shift_schedule (barangay_id,user_id,patrol_zone,start_at,end_at,created_by,approval_status) VALUES
  (1,$T4,'Z','2026-10-08 08:00:00','2026-10-08 20:00:00',$ADMIN_ID,'draft');
INSERT INTO shift_schedule (barangay_id,user_id,patrol_zone,start_at,end_at,created_by,approval_status,approved_by,approved_at) VALUES
  (1,$T8,'Z','2026-10-08 00:00:00','2026-10-08 10:00:00',$ADMIN_ID,'published',$PB_ID,UTC_TIMESTAMP());
SQL
# devices (no FCM token -> straight to SMS, whose body lands in sms_log)
for t in $T1 $T2 $T3 $T6 $TB2; do
  db_run "INSERT INTO mobile_device (device_id,user_id,platform,fcm_token,last_seen_at,is_active,created_at) VALUES ('dev-of-$t',$t,'android','',UTC_TIMESTAMP(),1,UTC_TIMESTAMP());"
done
# t6 already has an active dispatch on another incident
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id,incident_type,priority,raw_narrative,status,source,created_at,updated_at) VALUES
  (1,'noise','normal','OF-BUSY','dispatched','web',UTC_TIMESTAMP(),UTC_TIMESTAMP());
SQL
BUSY_INC=$(db_one "SELECT incident_id FROM incident WHERE raw_narrative='OF-BUSY';")
db_run "INSERT INTO dispatch (incident_id,dispatched_by,tanod_id,priority,route_status,status,dispatched_at,created_client_request_id) VALUES ($BUSY_INC,$ADMIN_ID,$T6,'normal','unavailable','assigned',UTC_TIMESTAMP(),'$(uuid)');"
[ -n "$T1" ] && [ -n "$ADMIN3_ID" ] && [ -n "$BUSY_INC" ] && pass "Seeded users, duty states, shifts, devices" || { fail "Seed failed"; exit 1; }

step "2. Start the API: night clock :$NIGHT_PORT, day clock :$DAY_PORT, fault :$FAULT_PORT"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30
export CORS_ALLOWED_ORIGIN='*'
SERVER_PIDS=""
start_server() { # port fake-now fault
  (cd "$BACKEND_DIR/public" && APP_ENV=test BARANGUARD_NOW_OVERRIDE="$2" BARANGUARD_TEST_OFFER_FAULT="$3" "$PHP_BIN" -S "127.0.0.1:$1" >"$BACKEND_DIR/scripts/.offers-server-$1.log" 2>&1) &
  SERVER_PIDS="$SERVER_PIDS $!"
}
start_server $NIGHT_PORT "$FAKE_NIGHT" ""
start_server $DAY_PORT "$FAKE_DAY" ""
start_server $FAULT_PORT "$FAKE_NIGHT" "1"
sleep 3
ADMIN_T=$(login_as of_admin); ADMINB_T=$(login_as of_admin_b); PB_T=$(login_as of_pb); SEC_T=$(login_as of_sec)
T1_T=$(login_as of_t1); T2_T=$(login_as of_t2); T3_T=$(login_as of_t3); T6_T=$(login_as of_t6)
ADMIN2_T=$(login_as of_admin2); TB2_T=$(login_as of_t_b2); ADMIN3_T=$(login_as of_admin3)
[ -n "$ADMIN_T" ] && [ -n "$PB_T" ] && [ -n "$SEC_T" ] && [ -n "$T1_T" ] && [ -n "$T2_T" ] && [ -n "$TB2_T" ] && [ -n "$ADMIN3_T" ] && pass "Logged in as every test account" || { fail "Logins failed"; exit 1; }

# ================================================================ clock
step "3. Night window (18:00 inclusive - 06:00 exclusive Manila) and the test-seam guard"
cat > "$TMP_DIR/night.php" <<PHP
<?php
require '$BOOT_PATH';
use Baranguard\Services\Dispatch\OfferService;
\$cases = ['2026-10-08T09:59:59Z'=>false,'2026-10-08T10:00:00Z'=>true,'2026-10-08T21:59:59Z'=>true,'2026-10-08T22:00:00Z'=>false,'2026-10-08T04:00:00Z'=>false,'2026-10-07T17:59:59Z'=>true];
// 09:59:59Z = 17:59:59 Manila (day); 10:00Z = 18:00 (night); 21:59:59Z = 05:59:59 (night); 22:00Z = 06:00 (day)
\$out = [];
foreach (\$cases as \$iso => \$expect) { \$out[] = OfferService::isNight(new DateTimeImmutable(\$iso)) === \$expect ? 'ok' : 'BAD:'.\$iso; }
echo implode(',', \$out);
PHP
NIGHT_OUT=$(php_run "$FAKE_NIGHT" "$TMP_DIR/night.php")
expect_eq "isNight boundaries (09:59:59Z day, 10:00Z night, 21:59:59Z night, 22:00Z day, noon day, 01:59 night)" "$NIGHT_OUT" "ok,ok,ok,ok,ok,ok"
cat > "$TMP_DIR/seam.php" <<PHP
<?php
require '$BOOT_PATH';
echo Baranguard\Services\Dispatch\OfferService::now()->format('Y-m-d\TH:i:s\Z');
PHP
SEAM_NO_ENV=$(DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB" BARANGUARD_NOW_OVERRIDE="$FAKE_NIGHT" "$PHP_BIN" "$TMP_DIR/seam.php")
[ "$SEAM_NO_ENV" != "$FAKE_NIGHT" ] && pass "Clock override is IGNORED when APP_ENV is unset" || fail "override honoured without APP_ENV"
SEAM_PROD=$(DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB" APP_ENV=production BARANGUARD_NOW_OVERRIDE="$FAKE_NIGHT" "$PHP_BIN" "$TMP_DIR/seam.php")
[ "$SEAM_PROD" != "$FAKE_NIGHT" ] && pass "Clock override is IGNORED when APP_ENV=production" || fail "override honoured in production"
expect_eq "Clock override honoured under APP_ENV=test" "$(php_run "$FAKE_NIGHT" "$TMP_DIR/seam.php")" "$FAKE_NIGHT"

# ================================================================ auto trigger + selection
step "4. Night auto-trigger: web incident create opens an offer; selection rules"
SECRET="SECRET-NARRATIVE-XYZ"
INC_BODY="{\"incident_type\":\"theft\",\"raw_narrative\":\"$SECRET\",\"latitude\":13.0123456,\"longitude\":123.7654321,\"location_description\":\"Purok 9 Secret St\",\"complainant_name\":\"Juan SecretName\",\"complainant_contact_number\":\"09991234567\"}"
BASE_URL="$DAY_URL"
api POST /incidents "$ADMIN_T" "$INC_BODY" -H "Idempotency-Key: $(uuid)"
expect_code "DAY: web incident create" 201
DAY_INC=$(jget "$BODY" incident_id)
expect_eq "DAY: no offer is opened" "$(db_one "SELECT COUNT(*) FROM dispatch_offer WHERE incident_id=$DAY_INC;")" "0"

BASE_URL="$NIGHT_URL"
api POST /incidents "$ADMIN_T" "$INC_BODY" -H "Idempotency-Key: $(uuid)"
expect_code "NIGHT: web incident create" 201
INC1=$(jget "$BODY" incident_id)
OFFER1=$(db_one "SELECT offer_id FROM dispatch_offer WHERE incident_id=$INC1;")
[ -n "$OFFER1" ] && pass "NIGHT: an offer #$OFFER1 was opened automatically" || fail "NIGHT: no offer opened"
expect_eq "  status open, round 1, created_by NULL (system)" "$(offer_field $OFFER1 "CONCAT(status,'/',\`round\`,'/',IFNULL(created_by,'NULL'))")" "open/1/NULL"
expect_eq "  recipients = exactly t1,t2 (off-duty, responding, draft shift, ended shift, busy, suspended, other barangay all excluded)" "$(recips $OFFER1)" "$T1,$T2"
expect_eq "  expires_at is created_at + 180 s" "$(db_one "SELECT TIMESTAMPDIFF(SECOND,created_at,expires_at) FROM dispatch_offer WHERE offer_id=$OFFER1;")" "180"
expect_eq "  created_at is the injected clock" "$(offer_field $OFFER1 "DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ')")" "$FAKE_NIGHT"
expect_eq "  incident stays pending (an offer is not a dispatch)" "$(db_one "SELECT status FROM incident WHERE incident_id=$INC1;")" "pending"
expect_eq "  no dispatch row yet" "$(db_one "SELECT COUNT(*) FROM dispatch WHERE incident_id=$INC1;")" "0"

# idempotent replay of the incident create must NOT open a second offer
KEY=$(uuid)
api POST /incidents "$ADMIN_T" "$INC_BODY" -H "Idempotency-Key: $KEY"; INC1B=$(jget "$BODY" incident_id)
api POST /incidents "$ADMIN_T" "$INC_BODY" -H "Idempotency-Key: $KEY"
expect_code "Replayed incident create" 200
expect_eq "  replay opened no second offer" "$(db_one "SELECT COUNT(*) FROM dispatch_offer WHERE incident_id=$INC1B;")" "1"
db_run "UPDATE dispatch_offer SET status='cancelled' WHERE incident_id=$INC1B;"  # keep it out of the sweeper tests

step "5. Notification content: non-identifying, only allowed keys"
NOTIF1=$(db_one "SELECT notification_id FROM notification WHERE dispatch_offer_id=$OFFER1 AND notification_type='dispatch_offer' ORDER BY notification_id LIMIT 1;")
[ -n "$NOTIF1" ] && pass "dispatch_offer notification #$NOTIF1 created" || fail "no dispatch_offer notification"
expect_eq "  targets are exactly t1,t2" "$(db_one "SELECT GROUP_CONCAT(user_id ORDER BY user_id) FROM notification_target WHERE notification_id=$NOTIF1;")" "$T1,$T2"
expect_eq "  carries incident_id and dispatch_offer_id, no dispatch_id/sos_id" "$(db_one "SELECT CONCAT(IFNULL(incident_id,'x'),'/',IFNULL(dispatch_offer_id,'x'),'/',IFNULL(dispatch_id,'null'),'/',IFNULL(sos_id,'null')) FROM notification WHERE notification_id=$NOTIF1;")" "$INC1/$OFFER1/null/null"
cat > "$TMP_DIR/fcm.php" <<PHP
<?php
require '$BOOT_PATH';
use Baranguard\Services\Notifications\NotificationDispatcher;
\$n = (int) \$argv[1];
\$row = \$pdo->query("SELECT notification_type, dispatch_offer_id FROM notification WHERE notification_id=\$n")->fetch(PDO::FETCH_ASSOC);
\$data = NotificationDispatcher::buildFcmData(\$pdo, \$n, ['notification_type'=>\$row['notification_type'], 'dispatch_offer_id'=>\$row['dispatch_offer_id'] !== null ? (int)\$row['dispatch_offer_id'] : null]);
ksort(\$data);
echo json_encode(\$data, JSON_UNESCAPED_SLASHES);
PHP
FCM_JSON=$(php_run "$FAKE_NIGHT" "$TMP_DIR/fcm.php" "$NOTIF1")
KEYS=$(printf '%s' "$FCM_JSON" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $k=array_keys($d); sort($k); echo implode(",",$k);')
expect_eq "  FCM data keys are exactly the contract keys (+ the two generic ids)" "$KEYS" "barangay_name,created_at,incident_type,notification_id,notification_type,offer_id,type"
expect_eq "  data.type is dispatch_offer" "$(jget "$FCM_JSON" type)" "dispatch_offer"
expect_eq "  data.incident_type" "$(jget "$FCM_JSON" incident_type)" "theft"
expect_eq "  data.barangay_name" "$(jget "$FCM_JSON" barangay_name)" "$B1NAME"
expect_eq "  data.offer_id" "$(jget "$FCM_JSON" offer_id)" "$OFFER1"
expect_eq "  data.created_at (ISO UTC)" "$(jget "$FCM_JSON" created_at)" "$FAKE_NIGHT"
case "$FCM_JSON" in *"$SECRET"*|*"Secret"*|*"13.01"*|*"123.76"*|*"0999"*) fail "LEAK in FCM data: $FCM_JSON";; *) pass "  FCM data holds no narrative, names, contacts, coordinates or location text";; esac
SMS1=$(db_one "SELECT message_body FROM sms_log WHERE receiver_number='+639170000001' AND message_body LIKE 'BARANGUARD DISPATCH OFFER%' ORDER BY log_id LIMIT 1;")
expect_eq "  SMS fallback text to t1" "$SMS1" "BARANGUARD DISPATCH OFFER: a theft incident reported in $B1NAME at 21:00. Open the app to accept."
case "$SMS1" in *"$SECRET"*|*"Secret"*|*"13.01"*|*"123.76"*|*"0999"*) fail "LEAK in SMS text";; *) pass "  SMS text holds no narrative, names, contacts, coordinates or location text";; esac
expect_eq "  SMS is logged under a valid sms_log message_type (dispatch)" "$(db_one "SELECT message_type FROM sms_log WHERE receiver_number='+639170000001' AND message_body LIKE 'BARANGUARD DISPATCH OFFER%' ORDER BY log_id LIMIT 1;")" "dispatch"

# ================================================================ GET /dispatch-offers
step "6. GET /dispatch-offers (tanod / staff / tenant)"
api GET /dispatch-offers "$T1_T" ""
expect_code "Recipient tanod lists offers" 200
expect_eq "  t1 sees offer #$OFFER1" "$(offer_listed "$BODY" $OFFER1)" "1"
TKEYS=$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $k=array_keys($d["items"][0]); sort($k); echo implode(",",$k);')
expect_eq "  tanod item has exactly the contract keys" "$TKEYS" "barangay_name,created_at,expires_at,incident_id,incident_type,offer_id,priority,status"
case "$BODY" in *"$SECRET"*|*"Secret"*|*"13.01"*) fail "tanod list leaks case content";; *) pass "  tanod list carries no narrative/names/coordinates";; esac
api GET /dispatch-offers "$T3_T" ""
expect_eq "Off-duty tanod t3 (not a recipient) sees nothing" "$(offer_listed "$BODY" $OFFER1)" "0"
api GET /dispatch-offers "$TB2_T" ""
expect_eq "Other-barangay tanod sees nothing" "$(offer_listed "$BODY" $OFFER1)" "0"
api GET /dispatch-offers "$ADMIN_T" ""
expect_eq "Admin sees the offer" "$(offer_listed "$BODY" $OFFER1)" "1"
expect_eq "  recipient_count 2" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $r){ if($r["offer_id"]==(int)$argv[1]) echo $r["recipient_count"]; }' $OFFER1)" "2"
api GET "/dispatch-offers?incident_id=$INC1" "$SEC_T" ""
expect_eq "Secretary incident_id filter finds it" "$(offer_listed "$BODY" $OFFER1)" "1"
expect_eq "  and only it" "$(jget "$BODY" total)" "1"
api GET /dispatch-offers "$PB_T" ""
expect_code "Punong Barangay reads offers" 200
api GET /dispatch-offers "$ADMIN2_T" ""
expect_eq "Other-barangay admin does not see it" "$(offer_listed "$BODY" $OFFER1)" "0"
api GET "/dispatch-offers?incident_id=abc" "$ADMIN_T" ""
expect_code "Non-numeric incident_id filter" 400
api GET /dispatch-offers "" ""
expect_code "No token" 401

# ================================================================ accept
step "7. POST /dispatch-offers/:id/accept"
dev() { printf 'X-Device-Id: dev-of-%s' "$1"; }
REQ1=$(uuid)
api POST "/dispatch-offers/$OFFER1/accept" "$T1_T" "{\"request_id\":\"$REQ1\"}"
expect_code "Accept without X-Device-Id" 400
api POST "/dispatch-offers/$OFFER1/accept" "$T1_T" "{\"request_id\":\"not-a-uuid\"}" -H "$(dev $T1)"
expect_code "Accept with a bad request_id" 400
api POST "/dispatch-offers/$OFFER1/accept" "$ADMIN_T" "{\"request_id\":\"$REQ1\"}"
expect_code "Admin cannot accept" 403
api POST "/dispatch-offers/$OFFER1/accept" "$T3_T" "{\"request_id\":\"$(uuid)\"}" -H "$(dev $T3)"
expect_code "Non-recipient (never offered) tanod" 404
api POST "/dispatch-offers/$OFFER1/accept" "$TB2_T" "{\"request_id\":\"$(uuid)\"}" -H "$(dev $TB2)"
expect_code "Cross-tenant tanod" 404
api POST "/dispatch-offers/999999/accept" "$T1_T" "{\"request_id\":\"$(uuid)\"}" -H "$(dev $T1)"
expect_code "Unknown offer" 404
api POST "/dispatch-offers/$OFFER1/accept" "$T1_T" "{\"request_id\":\"$REQ1\"}" -H "$(dev $T2)"
expect_code "Device that belongs to another account" 422

api POST "/dispatch-offers/$OFFER1/accept" "$T1_T" "{\"request_id\":\"$REQ1\"}" -H "$(dev $T1)"
expect_code "t1 accepts (first accept wins)" 200
D1=$(jget "$BODY" dispatch_id)
expect_eq "  status assigned" "$(jget "$BODY" status)" "assigned"
expect_eq "  incident_id" "$(jget "$BODY" incident_id)" "$INC1"
expect_eq "  dispatch row: tanod t1, status assigned" "$(db_one "SELECT CONCAT(tanod_id,'/',status) FROM dispatch WHERE dispatch_id=$D1;")" "$T1/assigned"
expect_eq "  dispatched_by = the barangay's first Admin (offer was system-opened)" "$(db_one "SELECT dispatched_by FROM dispatch WHERE dispatch_id=$D1;")" "$ADMIN_ID"
expect_eq "  incident is now dispatched" "$(db_one "SELECT status FROM incident WHERE incident_id=$INC1;")" "dispatched"
expect_eq "  offer accepted by t1 with that dispatch" "$(offer_field $OFFER1 "CONCAT(status,'/',accepted_by,'/',accepted_dispatch_id)")" "accepted/$T1/$D1"
expect_eq "  t1 recipient accepted" "$(recip_status $OFFER1 $T1)" "accepted"
expect_eq "  t2 recipient released" "$(recip_status $OFFER1 $T2)" "released"
expect_eq "  the winner got a normal dispatch notification" "$(db_one "SELECT COUNT(*) FROM notification n JOIN notification_target nt ON nt.notification_id=n.notification_id WHERE n.dispatch_id=$D1 AND n.notification_type='dispatch' AND nt.user_id=$T1;")" "1"
expect_eq "  audit dispatch_offer_accepted (ids only)" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='dispatch_offer_accepted' AND entity_id=$OFFER1;")" '["incident_id", "dispatch_id", "round"]'
expect_eq "  audit dispatch_created marks via_offer" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.via_offer') FROM audit_log WHERE action='dispatch_created' AND entity_id=$D1;")" "true"

api POST "/dispatch-offers/$OFFER1/accept" "$T1_T" "{\"request_id\":\"$REQ1\"}" -H "$(dev $T1)"
expect_code "Idempotent replay (same request_id)" 200
expect_eq "  returns the original dispatch" "$(jget "$BODY" dispatch_id)" "$D1"
expect_eq "  still exactly one dispatch row for the incident" "$(db_one "SELECT COUNT(*) FROM dispatch WHERE incident_id=$INC1;")" "1"
api POST "/dispatch-offers/$OFFER1/accept" "$T2_T" "{\"request_id\":\"$(uuid)\"}" -H "$(dev $T2)"
expect_code "Second accept by t2" 409
expect_eq "  error code OFFER_CLOSED" "$(jget "$BODY" error.code)" "OFFER_CLOSED"
api POST "/dispatch-offers/$OFFER1/accept" "$T1_T" "{\"request_id\":\"$(uuid)\"}" -H "$(dev $T1)"
expect_code "Winner re-accepting with a NEW request_id" 409
api GET /dispatch-offers "$T2_T" ""
expect_eq "Loser's list no longer shows the offer" "$(offer_listed "$BODY" $OFFER1)" "0"
api GET /dispatch-offers "$ADMIN_T" ""
expect_eq "Admin view carries accepted_by_name" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $r){ if($r["offer_id"]==(int)$argv[1]) echo $r["accepted_by_name"]; }' $OFFER1)" "OF Tanod One"

# ================================================================ expired
step "8. Expired offer cannot be accepted; manual open"
db_run "INSERT INTO incident (barangay_id,incident_type,priority,raw_narrative,status,source,created_at,updated_at) VALUES (1,'fire','high','OF-INC-3','pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP()),(1,'noise','normal','OF-INC-4','pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP()),(1,'vandalism','normal','OF-INC-5','pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP()),(1,'theft','normal','OF-INC-6','pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP()),(1,'theft','normal','OF-INC-7','resolved','web',UTC_TIMESTAMP(),UTC_TIMESTAMP());"
iid() { db_one "SELECT incident_id FROM incident WHERE raw_narrative='$1';"; }
INC3=$(iid OF-INC-3); INC4=$(iid OF-INC-4); INC5=$(iid OF-INC-5); INC6=$(iid OF-INC-6); INC7=$(iid OF-INC-7)
OKEY=$(uuid)
api POST /dispatch-offers "$ADMIN_T" "{\"incident_id\":$INC3}"
expect_code "Manual open without Idempotency-Key" 400
api POST /dispatch-offers "$ADMIN_T" "{}" -H "Idempotency-Key: $(uuid)"
expect_code "Manual open without incident_id" 400
api POST /dispatch-offers "$T1_T" "{\"incident_id\":$INC3}" -H "Idempotency-Key: $(uuid)"
expect_code "Tanod cannot open" 403
api POST /dispatch-offers "$PB_T" "{\"incident_id\":$INC3}" -H "Idempotency-Key: $(uuid)"
expect_code "Punong Barangay cannot open" 403
api POST /dispatch-offers "$ADMIN2_T" "{\"incident_id\":$INC3}" -H "Idempotency-Key: $(uuid)"
expect_code "Cross-tenant admin" 404
api POST /dispatch-offers "$ADMIN_T" "{\"incident_id\":999999}" -H "Idempotency-Key: $(uuid)"
expect_code "Unknown incident" 404
api POST /dispatch-offers "$ADMIN_T" "{\"incident_id\":$INC7}" -H "Idempotency-Key: $(uuid)"
expect_code "Resolved incident" 409
api POST /dispatch-offers "$SEC_T" "{\"incident_id\":$INC3}" -H "Idempotency-Key: $OKEY"
expect_code "Secretary opens an offer by hand" 201
OFFER3=$(jget "$BODY" offer_id)
expect_eq "  created_by is the Secretary" "$(offer_field $OFFER3 created_by)" "$SEC_ID"
expect_eq "  recipients: t2 only (t1 now has an active dispatch)" "$(recips $OFFER3)" "$T2"
api POST /dispatch-offers "$SEC_T" "{\"incident_id\":$INC3}" -H "Idempotency-Key: $OKEY"
expect_code "Replay of the same Idempotency-Key" 200
expect_eq "  same offer" "$(jget "$BODY" offer_id)" "$OFFER3"
api POST /dispatch-offers "$ADMIN_T" "{\"incident_id\":$INC3}" -H "Idempotency-Key: $(uuid)"
expect_code "Second offer for an incident that has a live one" 409
expect_eq "  still exactly one offer row" "$(db_one "SELECT COUNT(*) FROM dispatch_offer WHERE incident_id=$INC3;")" "1"
db_run "INSERT INTO dispatch_offer (incident_id,barangay_id,\`round\`,status,created_at,expires_at) VALUES ($INC3,1,1,'open',UTC_TIMESTAMP(),UTC_TIMESTAMP());"
expect_eq "DB-level guard: a 2nd live offer for one incident is impossible (unique)" "$(db_one "SELECT COUNT(*) FROM dispatch_offer WHERE incident_id=$INC3;")" "1"

db_run "UPDATE dispatch_offer SET expires_at='2000-01-01 00:00:00' WHERE offer_id=$OFFER3;"
api POST "/dispatch-offers/$OFFER3/accept" "$T2_T" "{\"request_id\":\"$(uuid)\"}" -H "$(dev $T2)"
expect_code "t2 accepts after the round expired (sweeper has not run)" 409
expect_eq "  OFFER_CLOSED" "$(jget "$BODY" error.code)" "OFFER_CLOSED"
api GET /dispatch-offers "$T2_T" ""
expect_eq "  an expired round is not listed for the tanod" "$(offer_listed "$BODY" $OFFER3)" "0"
expect_eq "  no dispatch was created" "$(db_one "SELECT COUNT(*) FROM dispatch WHERE incident_id=$INC3;")" "0"
db_run "UPDATE dispatch_offer SET status='cancelled' WHERE offer_id=$OFFER3;"  # keep it out of the sweeper tests

# ================================================================ cancel
step "9. PATCH /dispatch-offers/:id/cancel"
api POST /dispatch-offers "$ADMIN_T" "{\"incident_id\":$INC4}" -H "Idempotency-Key: $(uuid)"
OFFER4=$(jget "$BODY" offer_id)
CKEY=$(uuid)
api PATCH "/dispatch-offers/$OFFER4/cancel" "$ADMIN_T" "" -H "Idempotency-Key: $CKEY"
expect_code "Admin cancels" 200
expect_eq "  status cancelled" "$(offer_field $OFFER4 status)" "cancelled"
expect_eq "  recipients released" "$(recip_status $OFFER4 $T2)" "released"
api PATCH "/dispatch-offers/$OFFER4/cancel" "$ADMIN_T" "" -H "Idempotency-Key: $CKEY"
expect_code "Cancel replay" 200
api PATCH "/dispatch-offers/$OFFER4/cancel" "$ADMIN_T" ""
expect_code "Cancel without Idempotency-Key" 400
api PATCH "/dispatch-offers/$OFFER4/cancel" "$SEC_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Secretary cannot cancel" 403
api PATCH "/dispatch-offers/$OFFER4/cancel" "$ADMIN2_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Cross-tenant admin cancel" 404
api PATCH "/dispatch-offers/$OFFER1/cancel" "$ADMIN_T" "" -H "Idempotency-Key: $(uuid)"
expect_code "Cancelling an ACCEPTED offer" 409
api POST "/dispatch-offers/$OFFER4/accept" "$T2_T" "{\"request_id\":\"$(uuid)\"}" -H "$(dev $T2)"
expect_code "Accepting a cancelled offer" 409
expect_eq "  audit dispatch_offer_cancelled recorded" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='dispatch_offer_cancelled' AND entity_id=$OFFER4;")" "1"
api POST /dispatch-offers "$ADMIN_T" "{\"incident_id\":$INC4}" -H "Idempotency-Key: $(uuid)"
expect_code "A new offer may be opened after the old one was cancelled" 201
OFFER4B=$(jget "$BODY" offer_id)

# ================================================================ sweeper
step "10. Sweeper: expiry -> admin alert + re-broadcast (3 rounds) -> escalated"
api POST /dispatch-offers "$ADMIN_T" "{\"incident_id\":$INC5}" -H "Idempotency-Key: $(uuid)"
OFFER5=$(jget "$BODY" offer_id)
expect_eq "Offer #$OFFER5 round 1, recipient t2" "$(offer_field $OFFER5 "CONCAT(\`round\`,'/',status)")/$(recips $OFFER5)" "1/open/$T2"
SW=$(php_run "$FAKE_NIGHT" "$BACKEND_DIR/scripts/dispatch-offer-sweeper.php" --once; echo "rc=$?")
case "$SW" in *"rc=0"*) pass "Sweeper CLI --once with nothing due exits 0";; *) fail "sweeper rc: $SW";; esac
expect_eq "  prints nothing when nothing is due" "$(printf '%s' "$SW" | grep -c 'dispatch-offer sweep')" "0"
expect_eq "  a not-yet-due offer is untouched" "$(offer_field $OFFER5 "CONCAT(\`round\`,'/',status)")" "1/open"

db_run "UPDATE dispatch_offer SET expires_at='2026-10-08 12:59:00' WHERE offer_id IN ($OFFER5,$OFFER4B);"
ALERTS_BEFORE=$(db_one "SELECT COUNT(*) FROM notification WHERE notification_type='priority_alert' AND dispatch_offer_id=$OFFER5;")
SW=$(php_run "$FAKE_NIGHT" "$BACKEND_DIR/scripts/dispatch-offer-sweeper.php" --once; echo "rc=$?")
case "$SW" in *"processed=2"*) pass "Sweep line reports processed=2";; *) fail "sweep output: $SW";; esac
expect_eq "Round 2 started, offer open again" "$(offer_field $OFFER5 "CONCAT(\`round\`,'/',status)")" "2/open"
expect_eq "  new deadline = injected now + 180 s" "$(offer_field $OFFER5 "DATE_FORMAT(expires_at,'%H:%i:%s')")" "13:03:00"
expect_eq "  t2 offered again" "$(recip_status $OFFER5 $T2)" "offered"
expect_eq "  an Admin priority_alert was created" "$(db_one "SELECT COUNT(*) FROM notification WHERE notification_type='priority_alert' AND dispatch_offer_id=$OFFER5;")" "$((ALERTS_BEFORE+1))"
ALERT=$(db_one "SELECT notification_id FROM notification WHERE notification_type='priority_alert' AND dispatch_offer_id=$OFFER5 ORDER BY notification_id DESC LIMIT 1;")
expect_eq "  alert targets the Admin(s) only (t2/secretary/pb excluded)" "$(db_one "SELECT GROUP_CONCAT(user_id ORDER BY user_id) FROM notification_target WHERE notification_id=$ALERT;")" "$ADMIN_ID,$ADMINB_ID"
ASMS=$(db_one "SELECT message_body FROM sms_log WHERE receiver_number='+639170000100' AND message_body LIKE '%No Tanod has accepted%' ORDER BY log_id DESC LIMIT 1;")
EXPECTED_ALERT="BARANGUARD PRIORITY ALERT: No Tanod has accepted: a vandalism incident reported in $B1NAME at $(db_one "SELECT DATE_FORMAT(DATE_ADD(created_at,INTERVAL 8 HOUR),'%H:%i') FROM dispatch_offer WHERE offer_id=$OFFER5;"). Assign a responder."
expect_eq "  (exact alert text, Manila clock)" "$ASMS" "$EXPECTED_ALERT"
expect_eq "  audit dispatch_offer_expired has ids/counts only" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='dispatch_offer_expired' AND entity_id=$OFFER5 ORDER BY audit_id DESC LIMIT 1;")" '["incident_id", "round_before", "round_after", "status_after", "recipient_count", "admin_alerted"]'
expect_eq "  the other expired offer (#$OFFER4B) also moved to round 2" "$(offer_field $OFFER4B "\`round\`")" "2"

# round 2 -> 3
db_run "UPDATE dispatch_offer SET expires_at='2026-10-08 12:59:00' WHERE offer_id=$OFFER5;"
php_run "$FAKE_NIGHT" "$BACKEND_DIR/scripts/dispatch-offer-sweeper.php" --once >/dev/null
expect_eq "Round 3 started" "$(offer_field $OFFER5 "CONCAT(\`round\`,'/',status)")" "3/open"
# round 3 expiry -> escalated (no more tanod rebroadcast)
db_run "UPDATE dispatch_offer SET expires_at='2026-10-08 12:59:00' WHERE offer_id=$OFFER5;"
BR_BEFORE=$(db_one "SELECT COUNT(*) FROM notification WHERE notification_type='dispatch_offer' AND dispatch_offer_id=$OFFER5;")
php_run "$FAKE_NIGHT" "$BACKEND_DIR/scripts/dispatch-offer-sweeper.php" --once >/dev/null
expect_eq "After round 3 times out: escalated, round stays 3" "$(offer_field $OFFER5 "CONCAT(\`round\`,'/',status)")" "3/escalated"
expect_eq "  recipient expired" "$(recip_status $OFFER5 $T2)" "expired"
expect_eq "  no further tanod broadcast was created" "$(db_one "SELECT COUNT(*) FROM notification WHERE notification_type='dispatch_offer' AND dispatch_offer_id=$OFFER5;")" "$BR_BEFORE"
api POST "/dispatch-offers/$OFFER5/accept" "$T2_T" "{\"request_id\":\"$(uuid)\"}" -H "$(dev $T2)"
expect_code "Accept on an escalated offer" 409
AL_BEFORE=$(db_one "SELECT COUNT(*) FROM notification WHERE notification_type='priority_alert' AND dispatch_offer_id=$OFFER5;")
db_run "UPDATE dispatch_offer SET expires_at='2026-10-08 12:59:00' WHERE offer_id=$OFFER5;"
php_run "$FAKE_NIGHT" "$BACKEND_DIR/scripts/dispatch-offer-sweeper.php" --once >/dev/null
expect_eq "Escalated offer keeps alerting Admins on every timeout" "$(db_one "SELECT COUNT(*) FROM notification WHERE notification_type='priority_alert' AND dispatch_offer_id=$OFFER5;")" "$((AL_BEFORE+1))"
expect_eq "  and stays escalated at round 3" "$(offer_field $OFFER5 "CONCAT(\`round\`,'/',status)")" "3/escalated"
# ---- escalation reminder backoff + cap (Wave 3b-K): +3, +6, +12 min, then every 30 min, max 8 reminders, then silence
expect_eq "Reminder #1 was audited (ids only)" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='dispatch_offer_reminder' AND entity_id=$OFFER5 ORDER BY audit_id DESC LIMIT 1;")" '["incident_id", "reminder_no", "admin_alerted"]'
expect_eq "  next reminder is due +6 min after reminder #1 (13:00 + 360 s)" "$(offer_field $OFFER5 "DATE_FORMAT(expires_at,'%H:%i:%s')")" "13:06:00"
cat > "$TMP_DIR/sweepsched.php" <<PHP
<?php
require '$BOOT_PATH';
use Baranguard\Services\Dispatch\OfferService;
\$id = (int) \$argv[1];
\$alerts = function () use (\$pdo, \$id) {
    \$s = \$pdo->prepare("SELECT COUNT(*) FROM notification WHERE notification_type='priority_alert' AND dispatch_offer_id = ?");
    \$s->execute([\$id]);
    return (int) \$s->fetchColumn();
};
\$exp = function () use (\$pdo, \$id) {
    \$s = \$pdo->prepare("SELECT expires_at, status FROM dispatch_offer WHERE offer_id = ?");
    \$s->execute([\$id]);
    return \$s->fetch(PDO::FETCH_ASSOC);
};
\$rem = function () use (\$pdo, \$id) {
    \$s = \$pdo->prepare("SELECT COUNT(*) FROM audit_log WHERE action='dispatch_offer_reminder' AND entity_id = ?");
    \$s->execute([\$id]);
    return (int) \$s->fetchColumn();
};
\$out = [];
// one second early: nothing may happen
\$row = \$exp();
\$a0 = \$alerts();
OfferService::sweep(\$pdo, (new DateTimeImmutable(\$row['expires_at'] . ' UTC'))->modify('-1 second'));
\$out[] = 'early:' . (\$alerts() - \$a0);
for (\$i = 0; \$i < 11; \$i++) {
    \$row = \$exp();
    \$a = \$alerts();
    OfferService::sweep(\$pdo, new DateTimeImmutable(\$row['expires_at'] . ' UTC'));
    \$after = \$exp();
    \$out[] = (\$alerts() - \$a) . '@' . substr(\$after['expires_at'], 11, 5) . '/' . \$rem() . '/' . \$after['status'];
}
echo implode(' ', \$out);
PHP
EXPECT_SCHED="early:0 1@13:18/2/escalated 1@13:48/3/escalated 1@14:18/4/escalated 1@14:48/5/escalated 1@15:18/6/escalated 1@15:48/7/escalated 1@16:18/8/escalated 0@16:48/8/escalated 0@17:18/8/escalated 0@17:48/8/escalated 0@18:18/8/escalated"
expect_eq "Backoff: reminders 2-8 alert Admins at +6,+12,+30... min gaps; ticks 9+ send no alert; offer stays escalated" "$(php_run "$FAKE_NIGHT" "$TMP_DIR/sweepsched.php" $OFFER5)" "$EXPECT_SCHED"
expect_eq "  exactly 8 reminders audited, never more" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='dispatch_offer_reminder' AND entity_id=$OFFER5;")" "8"
expect_eq "  the capped offer is still escalated (visible on the board)" "$(offer_field $OFFER5 "CONCAT(\`round\`,'/',status)")" "3/escalated"
# Admin assigns directly -> offer closed
api POST /dispatch "$ADMIN_T" "{\"incident_id\":$INC5,\"tanod_id\":$T2,\"request_id\":\"$(uuid)\",\"override_reason\":\"offers escalated, assigned directly\"}"
expect_code "Admin assigns a responder directly on the escalated incident" 201
D5=$(jget "$BODY" dispatch_id)
expect_eq "  the offer is closed" "$(offer_field $OFFER5 status)" "closed"
expect_eq "  audit dispatch_offer_closed reason admin_dispatch" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.reason') FROM audit_log WHERE action='dispatch_offer_closed' AND entity_id=$OFFER5;")" '"admin_dispatch"'

# fake-clock unit call of OfferService::sweep with an injected $now
db_run "UPDATE dispatch_offer SET expires_at='2026-10-08 13:03:00' WHERE offer_id=$OFFER4B;"
cat > "$TMP_DIR/sweepnow.php" <<PHP
<?php
require '$BOOT_PATH';
use Baranguard\Services\Dispatch\OfferService;
\$early = OfferService::sweep(\$pdo, new DateTimeImmutable('2026-10-08T13:02:59Z'));
\$late  = OfferService::sweep(\$pdo, new DateTimeImmutable('2026-10-08T13:03:00Z'));
echo \$early['processed'] . ',' . \$late['processed'];
PHP
expect_eq "sweep(\$now) injection: nothing due at 13:02:59, the offer is due at 13:03:00" "$(php_run "$FAKE_NIGHT" "$TMP_DIR/sweepnow.php")" "0,1"
expect_eq "  #$OFFER4B advanced to round 3" "$(offer_field $OFFER4B "\`round\`")" "3"

# an incident that is no longer actionable closes its offer
api POST /dispatch-offers "$ADMIN_T" "{\"incident_id\":$INC6}" -H "Idempotency-Key: $(uuid)"
OFFER6=$(jget "$BODY" offer_id)
db_run "UPDATE incident SET status='resolved' WHERE incident_id=$INC6; UPDATE dispatch_offer SET expires_at='2026-10-08 12:59:00' WHERE offer_id=$OFFER6;"
php_run "$FAKE_NIGHT" "$BACKEND_DIR/scripts/dispatch-offer-sweeper.php" --once >/dev/null
expect_eq "Offer on a resolved incident is closed by the sweeper" "$(offer_field $OFFER6 status)" "closed"
expect_eq "  audit reason incident_not_actionable" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.reason') FROM audit_log WHERE action='dispatch_offer_closed' AND entity_id=$OFFER6;")" '"incident_not_actionable"'

# ================================================================ zero recipients
step "11. Nobody qualifies: created already escalated, Admin alerted"
db_run "INSERT INTO incident (barangay_id,incident_type,priority,raw_narrative,status,source,created_at,updated_at) VALUES (3,'fire','high','OF-B3','pending','web',UTC_TIMESTAMP(),UTC_TIMESTAMP());"
INCB3=$(iid OF-B3)
api POST /dispatch-offers "$ADMIN3_T" "{\"incident_id\":$INCB3}" -H "Idempotency-Key: $(uuid)"
expect_code "Manual open in a barangay with no qualifying tanod" 201
OFFERB3=$(jget "$BODY" offer_id)
expect_eq "  zero recipients, status escalated" "$(jget "$BODY" recipient_count)/$(jget "$BODY" status)" "0/escalated"
expect_eq "  audit shows recipient_count=0" "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.recipient_count') FROM audit_log WHERE action='dispatch_offer_opened' AND entity_id=$OFFERB3;")" "0"
expect_eq "  the Admin was alerted immediately" "$(db_one "SELECT COUNT(*) FROM notification n JOIN notification_target nt ON nt.notification_id=n.notification_id WHERE n.dispatch_offer_id=$OFFERB3 AND n.notification_type='priority_alert' AND nt.user_id=$ADMIN3_ID;")" "1"

# ================================================================ other create paths
step "12. Other incident-create paths trigger the night offer; failure never fails creation"
api POST /incidents "$T1_T" "{\"incident_type\":\"fire\",\"raw_narrative\":\"$SECRET\",\"latitude\":13.01,\"longitude\":123.76,\"client_event_id\":\"$(uuid)\"}" -H "$(dev $T1)"
expect_code "NIGHT: tanod-created incident (mobile path)" 201
TINC=$(jget "$BODY" incident_id)
expect_eq "  forced report_channel tanod_alerted (Wave 1B intact)" "$(db_one "SELECT report_channel FROM incident WHERE incident_id=$TINC;")" "tanod_alerted"
expect_eq "  an offer was opened" "$(db_one "SELECT COUNT(*) FROM dispatch_offer WHERE incident_id=$TINC;")" "1"
db_run "INSERT INTO citizen_report (barangay_id,description,submitted_at) VALUES (1,'$SECRET walk-in',UTC_TIMESTAMP());"
CRID=$(db_one "SELECT report_id FROM citizen_report ORDER BY report_id DESC LIMIT 1;")
api POST "/citizen-reports/$CRID/convert" "$SEC_T" '{"incident_type":"theft"}' -H "Idempotency-Key: $(uuid)"
expect_code "NIGHT: convert citizen report" 200
CINC=$(jget "$BODY" incident_id)
expect_eq "  an offer was opened for the converted incident" "$(db_one "SELECT COUNT(*) FROM dispatch_offer WHERE incident_id=$CINC;")" "1"
BASE_URL="$DAY_URL"
api POST "/incidents" "$T2_T" "{\"incident_type\":\"fire\",\"raw_narrative\":\"x\",\"client_event_id\":\"$(uuid)\"}" -H "$(dev $T2)"
DINC=$(jget "$BODY" incident_id)
expect_eq "DAY: tanod-created incident opens no offer" "$(db_one "SELECT COUNT(*) FROM dispatch_offer WHERE incident_id=$DINC;")" "0"

BASE_URL="$FAULT_URL"
FT=$(curl -s "${FAULT_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"of_admin\",\"password\":\"$TEST_PW\"}" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["token"] ?? "";')
api POST /incidents "$FT" "$INC_BODY" -H "Idempotency-Key: $(uuid)"
expect_code "NIGHT with the offer service throwing: incident create still succeeds" 201
FINC=$(jget "$BODY" incident_id)
expect_eq "  the incident row exists" "$(db_one "SELECT COUNT(*) FROM incident WHERE incident_id=$FINC;")" "1"
expect_eq "  no offer (the fault fired) and no half-written offer rows" "$(db_one "SELECT COUNT(*) FROM dispatch_offer WHERE incident_id=$FINC;")" "0"
grep -q "dispatch offer auto-open failed" "$BACKEND_DIR/scripts/.offers-server-${FAULT_PORT}.log" 2>/dev/null && pass "  the failure was logged, not swallowed silently" || fail "  failure was not logged"
BASE_URL="$NIGHT_URL"

# ================================================================ audit leak scan
step "13. Audit metadata for offers is identifiers/statuses/counts only"
LEAK=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action LIKE 'dispatch_offer%' AND (metadata_json LIKE '%SECRET%' OR metadata_json LIKE '%Secret%' OR metadata_json LIKE '%Purok%' OR metadata_json LIKE '%13.01%' OR metadata_json LIKE '%OF Tanod%' OR metadata_json LIKE '%0999%');")
expect_eq "No narrative, names, contacts, coordinates or location text in any dispatch_offer audit row" "$LEAK" "0"
expect_eq "Offer audit rows exist (opened/accepted/expired/reminder/closed/cancelled)" "$(db_one "SELECT COUNT(DISTINCT action) FROM audit_log WHERE action LIKE 'dispatch_offer%';")" "6"

# ================================================================ roster paper
step "14. POST /shifts/publish with recorded_from_paper"
mk_draft() { db_run "INSERT INTO shift_schedule (barangay_id,user_id,patrol_zone,start_at,end_at,created_by,approval_status) VALUES (1,$1,'P','$2','$3',$ADMIN_ID,'draft');"; db_one "SELECT MAX(shift_id) FROM shift_schedule;"; }
SH1=$(mk_draft $T4 '2026-11-02 00:00:00' '2026-11-02 08:00:00')
SH2=$(mk_draft $T4 '2026-11-03 00:00:00' '2026-11-03 08:00:00')
SH3=$(mk_draft $T4 '2026-11-04 00:00:00' '2026-11-04 08:00:00')
SH4=$(mk_draft $T4 '2026-11-05 00:00:00' '2026-11-05 08:00:00')
TODAY=$(date -u +%Y-%m-%d)
paper() { printf '{"shift_ids":[%s],"recorded_from_paper":{"signer_user_id":%s,"signed_on":"%s"}}' "$1" "$2" "$3"; }
api POST /shifts/publish "$SEC_T" "{\"shift_ids\":[$SH1]}" -H "Idempotency-Key: $(uuid)"
expect_code "Secretary WITHOUT approve_roster and no paper record" 403
api POST /shifts/publish "$T1_T" "$(paper $SH1 $PB_ID $TODAY)" -H "Idempotency-Key: $(uuid)"
expect_code "Tanod cannot record from paper" 403
api POST /shifts/publish "$PB_T" "$(paper $SH1 $PB_ID $TODAY)" -H "Idempotency-Key: $(uuid)"
expect_code "Punong Barangay cannot use the paper path (role admin|secretary only)" 403
api POST /shifts/publish "$SEC_T" "$(paper $SH1 $ADMIN_ID $TODAY)" -H "Idempotency-Key: $(uuid)"
expect_code "Signer without approve_roster" 422
api POST /shifts/publish "$SEC_T" "$(paper $SH1 $ADMIN2_ID $TODAY)" -H "Idempotency-Key: $(uuid)"
expect_code "Signer from another barangay" 404
api POST /shifts/publish "$SEC_T" "$(paper $SH1 999999 $TODAY)" -H "Idempotency-Key: $(uuid)"
expect_code "Unknown signer" 404
api POST /shifts/publish "$SEC_T" "$(paper $SH1 $PB_ID 2099-01-01)" -H "Idempotency-Key: $(uuid)"
expect_code "Future signed_on" 400
api POST /shifts/publish "$SEC_T" "$(paper $SH1 $PB_ID 2026-13-45)" -H "Idempotency-Key: $(uuid)"
expect_code "Malformed signed_on" 400
api POST /shifts/publish "$SEC_T" "{\"shift_ids\":[$SH1],\"recorded_from_paper\":\"yes\"}" -H "Idempotency-Key: $(uuid)"
expect_code "recorded_from_paper not an object" 400
expect_eq "  none of the refusals published anything" "$(db_one "SELECT COUNT(*) FROM shift_schedule WHERE shift_id=$SH1 AND approval_status='published';")" "0"
db_run "UPDATE shift_schedule SET pending_reapproval=1 WHERE shift_id=$SH1;"
PKEY=$(uuid)
api POST /shifts/publish "$SEC_T" "$(paper "$SH1,$SH2" $PB_ID 2026-10-05)" -H "Idempotency-Key: $PKEY"
expect_code "Secretary records a roster approved on paper by the Punong Barangay" 200
expect_eq "  both shifts published" "$(jget "$BODY" published)" "[$SH1,$SH2]"
expect_eq "  approved_by is the SIGNER, not the recorder" "$(db_one "SELECT approved_by FROM shift_schedule WHERE shift_id=$SH1;")" "$PB_ID"
expect_eq "  mode/date/recorder stored" "$(db_one "SELECT CONCAT(approval_mode,'/',paper_signed_on,'/',paper_recorded_by) FROM shift_schedule WHERE shift_id=$SH1;")" "recorded_from_paper/2026-10-05/$SEC_ID"
expect_eq "  paper_recorded_at set" "$(db_one "SELECT paper_recorded_at IS NOT NULL FROM shift_schedule WHERE shift_id=$SH1;")" "1"
expect_eq "  pending_reapproval cleared" "$(db_one "SELECT pending_reapproval FROM shift_schedule WHERE shift_id=$SH1;")" "0"
expect_eq "  audit roster_published_from_paper (not roster_published)" "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='roster_published_from_paper';")/$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='roster_published' AND JSON_CONTAINS(metadata_json,'$SH1','\$.published');")" "1/0"
expect_eq "  audit metadata has ids/dates only" "$(db_one "SELECT JSON_KEYS(metadata_json) FROM audit_log WHERE action='roster_published_from_paper' LIMIT 1;")" '["count", "published", "already_published", "warning_dates", "idempotency_key", "signer_user_id", "paper_signed_on"]'
api POST /shifts/publish "$SEC_T" "$(paper "$SH1,$SH2" $PB_ID 2026-10-05)" -H "Idempotency-Key: $PKEY"
expect_code "Replay with the same Idempotency-Key" 200
expect_eq "  replays the original outcome" "$(jget "$BODY" published)" "[$SH1,$SH2]"
api GET "/shifts?approval_status=published" "$ADMIN_T" ""
SHOWN=$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["items"] as $r){ if($r["shift_id"]==(int)$argv[1]) echo $r["approval_mode"]."|".$r["paper_signed_on"]."|".$r["paper_recorded_by_name"]; }' $SH1)
expect_eq "GET /shifts exposes approval_mode, paper_signed_on, paper_recorded_by_name" "$SHOWN" "recorded_from_paper|2026-10-05|OF Secretary"
api POST /shifts/publish "$PB_T" "{\"shift_ids\":[$SH3]}" -H "Idempotency-Key: $(uuid)"
expect_code "Normal publish by an approve_roster holder is unchanged" 200
expect_eq "  digital mode, no paper fields" "$(db_one "SELECT CONCAT(approval_mode,'/',IFNULL(paper_signed_on,'NULL'),'/',approved_by) FROM shift_schedule WHERE shift_id=$SH3;")" "digital/NULL/$PB_ID"
api POST /shifts/publish "$ADMIN_T" "{\"shift_ids\":[$SH4]}" -H "Idempotency-Key: $(uuid)"
expect_code "Admin without approve_roster and no paper record still 403" 403
api POST /shifts/publish "$ADMIN_T" "$(paper $SH4 $PB_ID $TODAY)" -H "Idempotency-Key: $(uuid)"
expect_code "Admin may record from paper" 200
OTHER_T=$(login_as of_t4)
api GET /shifts "$OTHER_T" ""
expect_eq "A draft-then-paper-published shift is visible to its tanod only once published" "$(printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $n=0; foreach(($d["items"] ?? []) as $r){ if($r["shift_id"]==(int)$argv[1]) $n++; } echo $n;' $SH4)" "1"

# ================================================================ audit-reason fix
step "15. Dispatch status override audit never stores the reason text"
OVR_TEXT="ReasonTextLeakCheck-do-not-store"
api PATCH "/dispatch/$D1/status" "$ADMIN_T" "{\"status\":\"en_route\",\"override_reason\":\"$OVR_TEXT\"}"
expect_code "Admin override en_route on the offer-created dispatch" 200
OMETA=$(db_one "SELECT metadata_json FROM audit_log WHERE action='dispatch_status_override' AND entity_id=$D1 ORDER BY audit_id DESC LIMIT 1;")
case "$OMETA" in *"$OVR_TEXT"*) fail "AUDIT LEAK: override reason text in audit metadata";; *) pass "Override reason text is NOT in audit metadata";; esac
expect_eq "  records has_reason and reason_length instead" "$(db_one "SELECT CONCAT(JSON_EXTRACT(metadata_json,'\$.has_reason'),'/',JSON_EXTRACT(metadata_json,'\$.reason_length')) FROM audit_log WHERE action='dispatch_status_override' AND entity_id=$D1 ORDER BY audit_id DESC LIMIT 1;")" "true/${#OVR_TEXT}"

echo
echo "================================================================"
echo "Wave 2E dispatch offers: $PASS passed, $FAIL failed"
echo "NOTE: first-accept-wins is reasoned from SELECT ... FOR UPDATE (incident row, then offer row);"
echo "      php -S is single-threaded, so true concurrency is NOT demonstrated here."
[ "$FAIL" -eq 0 ] && echo "ALL CHECKS PASSED" || exit 1
