#!/usr/bin/env bash
# Baranguard -- manual browser-test stack for the tanod-workflow web features
# (Approvals, Accomplishment Reports, Referral Log, Safer School Zones, scheduler
# publish) against a DISPOSABLE database.
#
#   bash backend/scripts/start-test-stack.sh          # (re)build + start, leaves servers running
#   bash backend/scripts/start-test-stack.sh --stop   # stop servers, drop DB + DB user
#
# Safe by construction: it only ever touches database `baranguard_testui` and
# MariaDB user `baranguard_testui_app`. The real `baranguard` and
# `baranguard_uiseed` databases and backend/.env are never written to (.env is
# only READ for DB_PORT; every DB_* / JWT / CORS value is passed to the API as a
# process environment variable, which config/env.php lets win over .env).
#
# The API (php -S, dev-router.php) listens on 127.0.0.1:8690, the static web
# dashboard on 127.0.0.1:8691. Both run detached (PowerShell Start-Process) so
# they survive this script and the terminal. PIDs: $TEMP/baranguard_testui.pids.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"

TESTDB="baranguard_testui"
APP_USER="baranguard_testui_app"
API_PORT="8690"
WEB_PORT="8691"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="TestUi@2026"

STATE_DIR="$(cygpath -u "${TEMP:-/tmp}" 2>/dev/null || echo /tmp)"
PID_FILE="$STATE_DIR/baranguard_testui.pids"
API_LOG="$BACKEND_DIR/scripts/test-stack-api.log"      # *.log is git-ignored
WEB_LOG="$BACKEND_DIR/scripts/test-stack-web.log"

step() { echo; echo "=== $1 ==="; }
die() { echo "ERROR: $*" >&2; exit 1; }

find_bin() {
  local name="$1"
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"; PHP_BIN="$(find_bin php)"
[ -z "$MYSQL_BIN" ] && die "mysql client not found."
[ -z "$PHP_BIN" ] && die "php not found."
# powershell.exe is not always on Git Bash's PATH; fall back to its fixed location.
PS_BIN="$(command -v powershell.exe 2>/dev/null || true)"
[ -z "$PS_BIN" ] && PS_BIN="/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
[ -x "$PS_BIN" ] || die "powershell.exe not found."

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
db_one() { mysql_exec -N -s "$TESTDB" -e "$1" 2>/dev/null | tr -d '\r'; }

kill_listeners() { # port...
  local port pid
  for port in "$@"; do
    for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${port} " | grep LISTENING | awk '{print $NF}' | sort -u); do
      taskkill //F //PID "$pid" >/dev/null 2>&1
    done
  done
}

teardown() {
  if [ -f "$PID_FILE" ]; then
    for pid in $(cat "$PID_FILE"); do taskkill //F //PID "$pid" >/dev/null 2>&1; done
    rm -f "$PID_FILE"
  fi
  kill_listeners "$API_PORT" "$WEB_PORT"
  mysql_exec -e "DROP DATABASE IF EXISTS \`$TESTDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; FLUSH PRIVILEGES;" 2>/dev/null
  rm -f "$API_LOG" "$WEB_LOG"
}

if [ "${1:-}" = "--stop" ]; then
  step "Stopping the test stack"
  teardown
  echo "Servers on :$API_PORT / :$WEB_PORT stopped; database $TESTDB and user $APP_USER dropped."
  echo "baranguard / baranguard_uiseed and backend/.env were never touched."
  exit 0
fi

# ------------------------------------------------------------ helpers
uuid() { "$PHP_BIN" -r 'printf("%s-%s-4%s-8%s-%s", bin2hex(random_bytes(4)), bin2hex(random_bytes(2)), substr(bin2hex(random_bytes(2)),1), substr(bin2hex(random_bytes(2)),1), bin2hex(random_bytes(6)));'; }
# Manila calendar date for a relative expression ("today", "+3 days").
dman() { "$PHP_BIN" -r 'date_default_timezone_set("Asia/Manila"); echo date("Y-m-d", strtotime($argv[1]));' -- "$1"; }
# UTC "Y-m-d H:i:s" for a Manila date + time.
mu() { "$PHP_BIN" -r '$d=new DateTime($argv[1]." ".$argv[2]." +08:00"); $d->setTimezone(new DateTimeZone("UTC")); echo $d->format("Y-m-d H:i:s");' "$1" "$2"; }
iso_ago() { "$PHP_BIN" -r 'echo gmdate("Y-m-d\TH:i:s\Z", time() - (int)$argv[1]);' "$1"; }  # seconds ago, UTC ISO

CODE=""; BODY=""
call() { # METHOD PATH TOKEN [BODY [extra curl args...]]
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  shift 3; [ $# -gt 0 ] && shift
  local args=(-s -w '\n%{http_code}' -X "$method" "$BASE_URL$path")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  args+=("$@")
  local out; out="$(curl "${args[@]}")"
  CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
jf() { printf '%s' "$BODY" | "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN),true); $v=$d; foreach(explode(".",$argv[1]) as $k){ if(!is_array($v)||!array_key_exists($k,$v)){echo "";exit;} $v=$v[$k]; } echo is_bool($v)?($v?"true":"false"):(is_array($v)?json_encode($v):(is_null($v)?"null":$v));' "$1"; }
need() { # label expected-code-prefix  -- abort loudly if the last call() was not what we wanted
  case "$CODE" in $2) ;; *) die "$1 failed: HTTP $CODE ${BODY:0:300}";; esac
}
token_for() {
  curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["token"] ?? "";'
}

# Detached background process that outlives this shell: PowerShell Start-Process.
start_detached() { # workdir logfile args...
  local wd logf out_w err_w php_w ps_args
  wd="$(cygpath -m "$1")"; logf="$2"; shift 2
  php_w="$(cygpath -m "$PHP_BIN")"
  out_w="$(cygpath -m "$logf")"; err_w="$(cygpath -m "${logf%.log}.err.log")"
  ps_args="$*"
  # The PID goes through a FILE, never a pipe: the detached php would otherwise
  # inherit the pipe's write end and `$(...)` would block until the server exits.
  local pid_out="$STATE_DIR/baranguard_testui.start.$$.tmp"
  "$PS_BIN" -NoProfile -Command "(Start-Process -FilePath '$php_w' -ArgumentList '$ps_args' -WorkingDirectory '$wd' -WindowStyle Hidden -RedirectStandardOutput '$out_w' -RedirectStandardError '$err_w' -PassThru).Id" > "$pid_out" 2>&1 < /dev/null
  tr -d '\r\n ' < "$pid_out"; rm -f "$pid_out"
}

# ============================================================ 1. teardown
step "1. Tearing down any previous test stack"
mysql_exec -e "SELECT VERSION();" >/dev/null 2>&1 || die "Could not connect to MariaDB on $XAMPP_MYSQL_HOST:$XAMPP_MYSQL_PORT (start XAMPP MySQL first)."
teardown
echo "Previous $TESTDB / $APP_USER / servers removed (if any existed)."

# ============================================================ 2. DB + migrations
step "2. Creating $TESTDB and applying the FULL migration chain"
mysql_exec -e "CREATE DATABASE \`$TESTDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" || die "CREATE DATABASE failed"
NMIG=0
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort); do
  mysql_exec "$TESTDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || die "migration $m failed"
  NMIG=$((NMIG+1))
done
echo "$NMIG migrations applied (migrations/*.sql globbed, *.down.sql skipped)."

APP_PASSWORD="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(16));')"
mysql_exec -e "CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$TESTDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;" || die "CREATE USER failed"

# ============================================================ 3. users + devices
step "3. Seeding barangay 1 (Dao) users"
HASH="$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")"
mysql_exec "$TESTDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'admin.test','$HASH','Test Admin (Chief Tanod)','admin',1,UTC_TIMESTAMP()),
 (1,'pb.test','$HASH','Test Punong Barangay','punong_barangay',1,UTC_TIMESTAMP()),
 (1,'sec.test','$HASH','Test Secretary','secretary',1,UTC_TIMESTAMP()),
 (1,'kagawad.test','$HASH','Test Kagawad','secretary',1,UTC_TIMESTAMP()),
 (1,'tanod.one','$HASH','Test Tanod One','tanod',1,UTC_TIMESTAMP()),
 (1,'tanod.two','$HASH','Test Tanod Two','tanod',1,UTC_TIMESTAMP());
UPDATE user SET official_title='Chief Tanod',        approval_authority='note_report,prepare_annex_d' WHERE username='admin.test';
UPDATE user SET official_title='Punong Barangay',    approval_authority='note_report,approve_report,approve_roster,approve_annex_d' WHERE username='pb.test';
UPDATE user SET official_title='Barangay Secretary', approval_authority='' WHERE username='sec.test';
UPDATE user SET official_title='Kagawad',            approval_authority='approve_report' WHERE username='kagawad.test';
SQL
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
ADMIN_ID=$(uid admin.test); PB_ID=$(uid pb.test); T1_ID=$(uid tanod.one); T2_ID=$(uid tanod.two)
DEV1="testui-dev-$(uuid)"; DEV2="testui-dev-$(uuid)"
mysql_exec "$TESTDB" -e "INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, last_seen_at, is_active, created_at) VALUES ('$DEV1', $T1_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP()), ('$DEV2', $T2_ID, 'android', '', UTC_TIMESTAMP(), 1, UTC_TIMESTAMP());"
echo "6 users + 2 registered tanod devices seeded."

# ============================================================ 4. servers
step "4. Starting the API (:$API_PORT) and the static web dashboard (:$WEB_PORT)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$TESTDB" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN="http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}"
# Keep the throwaway stack from reaching real outbound services configured in .env.
export GSM_GATEWAY_ENABLED=false FCM_SERVICE_ACCOUNT_PATH=/nonexistent/testui-fcm.json
API_PID="$(start_detached "$BACKEND_DIR" "$API_LOG" "-S 127.0.0.1:${API_PORT} -t public public/dev-router.php")"
WEB_PID="$(start_detached "$REPO_ROOT" "$WEB_LOG" "-S 127.0.0.1:${WEB_PORT} -t web")"
printf '%s\n%s\n' "$API_PID" "$WEB_PID" > "$PID_FILE"
echo "API pid $API_PID, web pid $WEB_PID (recorded in $PID_FILE)"
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null "$BASE_URL/auth/login" -X POST -d '{}' && break
  sleep 1
done
curl -s -o /dev/null "$BASE_URL/auth/login" -X POST -d '{}' || die "API did not start -- see $API_LOG"
curl -s -o /dev/null "http://127.0.0.1:${WEB_PORT}/index.html" || die "Web server did not start -- see $WEB_LOG"

ADMIN=$(token_for admin.test); SEC=$(token_for sec.test)
T1=$(token_for tanod.one); T2=$(token_for tanod.two)
[ -n "$ADMIN" ] && [ -n "$SEC" ] && [ -n "$T1" ] && [ -n "$T2" ] || die "Login failed -- see $API_LOG"

# ============================================================ 5. sample data
step "5. Seeding sample data (API where it is a plain write, SQL for state/time-shaped rows)"

# --- schools (API)
call POST /schools "$ADMIN" '{"name":"Dao Elementary School","school_type":"public","level":"primary_elementary","address":"Purok 1, Dao","focal_person":"Principal (test)","focal_contact":"09170000001","remarks":"Test data - main gate on the highway"}' -H "Idempotency-Key: $(uuid)"
need "create school 1" 201; S1=$(jf school_id)
call POST /schools "$ADMIN" '{"name":"Dao Private Academy","school_type":"private","level":"secondary_high_school","address":"Purok 3, Dao","focal_person":"Head (test)","focal_contact":"09170000002"}' -H "Idempotency-Key: $(uuid)"
need "create school 2" 201; S2=$(jf school_id)

# --- incidents (API, Secretary) -- some with school_id + Annex C-1 fields
mk_incident() { # type narrative school_id|"" c1_summary|"" action|"" notes|"" priority -> echoes incident_id
  local sch="" c1=""
  [ -n "$3" ] && sch=",\"school_id\":$3"
  [ -n "$4" ] && c1=",\"c1_summary\":\"$4\",\"c1_action_taken\":\"$5\",\"c1_status_notes\":\"$6\""
  call POST /incidents "$SEC" "{\"incident_type\":\"$1\",\"raw_narrative\":\"$2\",\"priority\":\"${7:-normal}\",\"location_description\":\"Near the school gate (test data)\"$sch$c1}" -H "Idempotency-Key: $(uuid)"
  need "create incident ($1)" 201
  jf incident_id
}
INC_A=$(mk_incident disturbance "Test narrative: loud disturbance outside the school gate at dismissal." "$S1" "Disturbance at the gate during dismissal" "Tanods dispersed the crowd and escorted pupils" "Monitored until the area cleared" high)
INC_B=$(mk_incident vandalism "Test narrative: graffiti on the school fence." "$S1" "Graffiti on the perimeter fence" "Photographed; school informed" "Awaiting repainting")
INC_C=$(mk_incident traffic_incident "Test narrative: minor collision near the private academy." "$S2" "Minor traffic collision at the school crossing" "Traffic redirected, parties advised" "Cleared")
INC_D=$(mk_incident theft "Test narrative: bicycle reported stolen (no school link)." "" "" "" "")
INC_E=$(mk_incident medical_emergency "Test narrative: resident collapsed at the plaza (no school link)." "" "" "" "" critical)

add_ref() { # incident_id referred_to [other_text]
  local extra=""; [ -n "${3:-}" ] && extra=",\"other_text\":\"$3\""
  call POST "/incidents/$1/referrals" "$ADMIN" "{\"referred_to\":\"$2\",\"referred_at\":\"$(iso_ago 600)\",\"reference_no\":\"TEST-$2-$1\"$extra}" -H "Idempotency-Key: $(uuid)"
  need "referral $2 on incident $1" 2??
}
add_ref "$INC_A" pnp; add_ref "$INC_A" ambulance_ems; add_ref "$INC_A" bfp
add_ref "$INC_B" barangay_official
add_ref "$INC_C" higher_lgu
add_ref "$INC_D" pnp

# --- school check-ins (API, Tanod + X-Device-Id)
checkin() { # token device school_id in_secs_ago out_secs_ago|""
  local out=""; [ -n "$5" ] && out=",\"checked_out_at\":\"$(iso_ago "$5")\""
  call POST /school-checkins "$1" "{\"school_id\":$3,\"checked_in_at\":\"$(iso_ago "$4")\"$out,\"client_event_id\":\"$(uuid)\"}" -H "X-Device-Id: $2"
  need "school check-in" 20?
}
checkin "$T1" "$DEV1" "$S1" 7200 3600            # today, closed
checkin "$T1" "$DEV1" "$S2" 173000 169400        # ~2 days ago, closed
checkin "$T2" "$DEV2" "$S1" 90000 86400          # ~1 day ago, closed
checkin "$T2" "$DEV2" "$S2" 1200 ""              # open, ~20 min ago

# --- shifts: 1 published + several drafts over the next days (SQL; the API would
#     enforce the rest/coverage guards, and drafts are an approval-state fixture)
D1=$(dman '+1 day'); D2=$(dman '+2 days'); D3=$(dman '+3 days'); D4=$(dman '+4 days')
D5=$(dman '+5 days'); D8=$(dman '+8 days')

# --- availability submission (SQL): tanod.two, submitted, next week
WINDOWS="[{\"date\":\"$D2\",\"start\":\"08:00\",\"end\":\"16:00\"},{\"date\":\"$D3\",\"start\":\"08:00\",\"end\":\"16:00\"},{\"date\":\"$D4\",\"start\":\"16:00\",\"end\":\"23:00\"},{\"date\":\"$D5\",\"start\":\"16:00\",\"end\":\"23:00\"}]"
mysql_exec "$TESTDB" -e "INSERT INTO tanod_availability (barangay_id, user_id, period_start, period_end, windows_json, status, version, client_event_id, created_at, updated_at) VALUES (1, $T2_ID, '$D1', '$D8', '$WINDOWS', 'submitted', 1, '$(uuid)', UTC_TIMESTAMP(), UTC_TIMESTAMP());"
AVAIL_ID=$(db_one "SELECT MAX(avail_id) FROM tanod_availability;")

shift_row() { # user_id date start end zone status [source_avail_id|NULL]
  local su="${7:-NULL}" appr="NULL, NULL"
  [ "$6" = "published" ] && appr="$PB_ID, UTC_TIMESTAMP()"
  echo "(1, $1, '$5', '$(mu "$2" "$3")', '$(mu "$2" "$4")', $ADMIN_ID, 1, UTC_TIMESTAMP(), '$6', $su, $appr)"
}
mysql_exec "$TESTDB" -e "INSERT INTO shift_schedule (barangay_id, user_id, patrol_zone, start_at, end_at, created_by, version, updated_at, approval_status, source_availability_id, approved_by, approved_at) VALUES
 $(shift_row $T1_ID "$D1" 08:00 16:00 'Purok 1' published),
 $(shift_row $T1_ID "$D2" 08:00 16:00 'Purok 1' draft),
 $(shift_row $T1_ID "$D3" 08:00 16:00 'Purok 2' draft),
 $(shift_row $T2_ID "$D2" 08:00 16:00 'Purok 3' draft $AVAIL_ID),
 $(shift_row $T2_ID "$D3" 08:00 16:00 'Purok 3' draft $AVAIL_ID),
 $(shift_row $T2_ID "$D4" 16:00 23:00 'Poblacion' draft $AVAIL_ID);" || die "shift seed failed"

# --- accomplishment reports (SQL). Entry dates must be <= today and inside one month.
TODAY_DAY=$("$PHP_BIN" -r 'date_default_timezone_set("Asia/Manila"); echo (int)date("j");')
if [ "$TODAY_DAY" -ge 8 ]; then ACC_MONTH=$(dman today | cut -c1-7); else ACC_MONTH=$(dman '-1 month' | cut -c1-7); fi
mysql_exec "$TESTDB" -e "
INSERT INTO accomplishment_report (barangay_id, user_id, month, status, prepared_at, total_minutes_confirmed, version, created_at, updated_at) VALUES
 (1, $T1_ID, '$ACC_MONTH', 'prepared', UTC_TIMESTAMP(), 1440, 2, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 (1, $T2_ID, '$ACC_MONTH', 'open', NULL, NULL, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP());"
R1=$(db_one "SELECT report_id FROM accomplishment_report WHERE user_id=$T1_ID;")
R2=$(db_one "SELECT report_id FROM accomplishment_report WHERE user_id=$T2_ID;")
mysql_exec "$TESTDB" -e "
INSERT INTO accomplishment_entry (report_id, barangay_id, user_id, work_date, accomplishment_text, start_time, end_time, duration_minutes, suggested_duration_minutes, duration_flag, client_event_id, created_at, updated_at) VALUES
 ($R1, 1, $T1_ID, '$ACC_MONTH-03', 'Foot patrol of Purok 1 and the plaza.',               '08:00:00', '16:00:00', 480, 470,  0, '$(uuid)', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 ($R1, 1, $T1_ID, '$ACC_MONTH-04', 'School-zone check at dismissal; traffic assistance.', '14:00:00', '17:00:00', 180, 180,  0, '$(uuid)', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 ($R1, 1, $T1_ID, '$ACC_MONTH-05', 'Full-day patrol (confirmed longer than duty log suggests).', '06:00:00', '18:00:00', 720, 300, 1, '$(uuid)', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 ($R1, 1, $T1_ID, '$ACC_MONTH-06', 'Overnight night-watch of the barangay hall and market.', '22:00:00', '02:00:00', 240, NULL, 0, '$(uuid)', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 ($R2, 1, $T2_ID, '$ACC_MONTH-03', 'Checkpoint duty at the highway junction.',            '09:00:00', '13:00:00', 240, 240,  0, '$(uuid)', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
 ($R2, 1, $T2_ID, '$ACC_MONTH-04', 'Assisted a flood-prone household evacuation drill.',  NULL,       NULL,       120, NULL, 0, '$(uuid)', UTC_TIMESTAMP(), UTC_TIMESTAMP());" || die "accomplishment seed failed"
# keep the report totals honest for the prepared one (sum of its entries)
mysql_exec "$TESTDB" -e "UPDATE accomplishment_report SET total_minutes_confirmed=(SELECT SUM(duration_minutes) FROM accomplishment_entry WHERE report_id=$R1) WHERE report_id=$R1;"

# --- Annex D draft term report (API: snapshot computed by the real endpoint)
TERM_START=$(dman '-45 days'); TERM_END=$(dman today)
call POST /ssz-term-reports "$ADMIN" "{\"term_label\":\"Term 1 S.Y. 2026-2027\",\"term_start\":\"$TERM_START\",\"term_end\":\"$TERM_END\",\"remarks\":\"Test data - draft for manual UI testing\"}" -H "Idempotency-Key: $(uuid)"
need "create Annex D draft" 20?
SSZ_ID=$(jf report_id)

# ============================================================ 6. self-check
step "6. Self-check"
for u in admin.test pb.test sec.test kagawad.test tanod.one tanod.two; do
  [ -n "$(token_for "$u")" ] && echo "  login ok: $u" || die "login failed for $u"
done
TKN=$(token_for pb.test)
call GET /schools "$TKN"; echo "  GET /schools                      -> $CODE total=$(jf total)"
call GET "/shifts?limit=100&approval_status=draft" "$ADMIN"; echo "  GET /shifts (draft)               -> $CODE total=$(jf total)"
call GET "/accomplishment-reports?month=$ACC_MONTH" "$TKN"; echo "  GET /accomplishment-reports       -> $CODE total=$(jf total)"
call GET /ssz-term-reports "$TKN"; echo "  GET /ssz-term-reports             -> $CODE total=$(jf total)"

# ============================================================ 7. instructions
cat <<EOF

=====================================================================
 TEST STACK RUNNING  (database: $TESTDB -- disposable, not your real data)
=====================================================================
 Open:  http://127.0.0.1:${WEB_PORT}/index.html?api_base=http://127.0.0.1:${API_PORT}/api/v1
        (web/index.html reads ?api_base=, saves it to localStorage for this
         origin and strips it from the URL bar -- the first load is enough.
         Opening other origins/ports is NOT supported by the CORS list.)
 API:   $BASE_URL        Stop everything:  bash backend/scripts/start-test-stack.sh --stop

 All accounts share the password:  $TEST_PW

  admin.test    Admin ('Chief Tanod'; note_report, prepare_annex_d)
                -> Approvals, Accomplishment Reports (month $ACC_MONTH), Referral Log,
                   Safer School Zones (schools + Annex D draft, "Prepare"),
                   Personnel > Scheduler (draft shifts -> publish), Personnel > Users
                   (edit title/approval authority)
  pb.test       Punong Barangay (approve_report, approve_roster, approve_annex_d)
                -> Approvals: approve the roster, note/approve the 'prepared'
                   accomplishment report, approve Annex D once prepared by admin
  sec.test      Secretary (no authority) -> Referral Log, schools, incident detail
                (raw narrative + C-1 fields), read-only on approvals
  kagawad.test  Secretary-role, title 'Kagawad', approve_report only
                -> Accomplishment Reports: can approve a noted report only
  tanod.one     Tanod (mobile only; web login lands on the 'no screen' page)
  tanod.two     Tanod (has a submitted availability; an OPEN accomplishment report)

 Seeded: 2 schools, 5 incidents (3 school-linked with C-1 fields; incident #$INC_A has
 PNP + Ambulance/EMS + BFP referrals), 1 published + 5 draft shifts, 1 submitted
 availability, accomplishment reports for $ACC_MONTH (tanod.one 'prepared' with 4
 entries incl. one flagged duration + one overnight; tanod.two 'open'), 4 school
 check-ins, Annex D draft #$SSZ_ID (Term 1 S.Y. 2026-2027, $TERM_START to $TERM_END).
=====================================================================
EOF
