#!/usr/bin/env bash
# Baranguard — Chief Tanod on mobile, stage 1 (Wave 3-G, review decision 15C,
# item 24) + the users directory.
#
# Proves over real HTTP that:
#   1. SessionPolicy: an ADMIN login with a well-formed X-Device-Id gets a
#      DEVICE session (24h, 7-day cap); admin without the header (browser)
#      keeps the 15-minute web session; secretary / punong_barangay never get
#      a device session even with the header; tanod unchanged.
#   2. SCOPE LIMIT: an admin DEVICE session reaches ONLY the allow-list
#      (SessionPolicy::ADMIN_DEVICE_ALLOWLIST); every other route is
#      403 DEVICE_SESSION_SCOPE and is audited; an admin WEB session is
#      completely unaffected by the same calls.
#   3. Admin can register / deactivate its OWN device (and nobody else's).
#   4. Mobile writes from an admin device follow the Tanod device rules:
#      X-Device-Id required (400), must be this account's active device
#      (422), H-09 signature enforced when a key is on file (401), phased
#      rollout (no key on file -> header + ownership check only).
#   5. Revocation (logout, suspension, deactivation, change-password) still
#      kills an admin device session on the very next request; the 7-day cap
#      applies to admin device sessions too.
#   6. Item 24: raising an SOS creates notification targets for every
#      on-duty/responding tanod and every active admin of the SAME barangay
#      excluding the sender, and an admin with a registered device gets an
#      FCM-channel delivery row (which only fails because no FCM project is
#      configured in the test env — Rule 12 then falls back to SMS).
#   7. GET /users/directory (admin|secretary): thin {user_id, full_name,
#      official_title} feed, own barangay only, active + non-suspended only,
#      purpose=tanod | purpose=signer&authority=..., other roles 403.
#
# Safe to run: disposable database, disposable app-user, throwaway port
# (Wave 3 agent G range 9101-9199). Real databases and backend/.env are never
# touched. Uses the FULL migration chain.
#
# Usage: bash backend/scripts/verify-chief-tanod-mobile.sh
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
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_ctm_check"
APP_USER="ctm_app"
APP_PASSWORD="2ndResp!2026xx"
API_PORT="9101"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="2ndResp#2026Pw"
KEY_DIR="$BACKEND_DIR/scripts/.ctm-keys"

echo "Baranguard Chief-Tanod-mobile validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"; PHP_BIN="$(find_bin php)"; OPENSSL_BIN="$(command -v openssl || true)"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }
[ -z "$OPENSSL_BIN" ] && { echo "ERROR: openssl CLI not found."; exit 1; }
echo "Using mysql: $MYSQL_BIN"
echo "Using php:   $PHP_BIN ($($PHP_BIN -r 'echo PHP_VERSION;'))"

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
db_one() { mysql_exec -N -s "$VALDB" -e "$1"; }

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$KEY_DIR"
  rm -f "$BACKEND_DIR/scripts/.ctm-server.log" "$BACKEND_DIR/scripts/.ctm-body.json"
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
pass "Full migration chain applied (all migrations/*.sql, globbed)"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, is_suspended, official_title, approval_authority, contact_number, created_at) VALUES
  (1, 'adm1',     '$HASH', 'Chief Alpha',    'admin',           1, 0, 'Chief Tanod',      'note_report,prepare_annex_d', NULL, UTC_TIMESTAMP()),
  (1, 'adm2',     '$HASH', 'Chief Beta',     'admin',           1, 0, 'Deputy Chief',     'approve_report',              NULL, UTC_TIMESTAMP()),
  (1, 'adm_cp',   '$HASH', 'Chief ChangePw', 'admin',           1, 0, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (1, 'adm_rv',   '$HASH', 'Chief Revoke',   'admin',           1, 0, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (1, 'adm_cap',  '$HASH', 'Chief Cap',      'admin',           1, 0, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (2, 'adm_b2',   '$HASH', 'Other Chief',    'admin',           1, 0, 'Chief Tanod',      'approve_report',              NULL, UTC_TIMESTAMP()),
  (1, 'sec1',     '$HASH', 'Sec One',        'secretary',       1, 0, 'Barangay Secretary','approve_report,approve_annex_d', NULL, UTC_TIMESTAMP()),
  (2, 'sec_b2',   '$HASH', 'Sec Other',      'secretary',       1, 0, 'Secretary',        'approve_report',              NULL, UTC_TIMESTAMP()),
  (1, 'pb1',      '$HASH', 'Punong One',     'punong_barangay', 1, 0, 'Punong Barangay',  'approve_report,approve_roster,approve_annex_d', NULL, UTC_TIMESTAMP()),
  (1, 'pb_susp',  '$HASH', 'Punong Susp',    'punong_barangay', 1, 1, 'Punong Barangay',  'approve_report',              NULL, UTC_TIMESTAMP()),
  (1, 'sec_off',  '$HASH', 'Sec Inactive',   'secretary',       0, 0, 'Secretary',        'approve_report',              NULL, UTC_TIMESTAMP()),
  (1, 'tan1',     '$HASH', 'Tanod Raiser',   'tanod',           1, 0, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (1, 'tan2',     '$HASH', 'Tanod OnDuty',   'tanod',           1, 0, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (1, 'tan3',     '$HASH', 'Tanod OffDuty',  'tanod',           1, 0, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (1, 'tan4',     '$HASH', 'Tanod NoDuty',   'tanod',           1, 0, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (1, 'tan5',     '$HASH', 'Tanod Respond',  'tanod',           1, 0, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (1, 'tan_susp', '$HASH', 'Tanod Suspended','tanod',           1, 1, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (1, 'tan_off',  '$HASH', 'Tanod Inactive', 'tanod',           0, 0, NULL,               '',                            NULL, UTC_TIMESTAMP()),
  (2, 'tan_b2',   '$HASH', 'Tanod Other',    'tanod',           1, 0, NULL,               '',                            NULL, UTC_TIMESTAMP());
SQL
# A tanod can never legitimately hold an authority (ApprovalAuthority::ELIGIBLE_ROLES), but nothing in the schema
# stops a bad row: the signer directory must still exclude it (role filter, not just the SET filter).
mysql_exec "$VALDB" -e "UPDATE user SET approval_authority='approve_report' WHERE username='tan4';"
uid() { db_one "SELECT user_id FROM user WHERE username='$1';"; }
mysql_exec "$VALDB" <<SQL
INSERT INTO duty_status (user_id, status, channel, changed_at) VALUES
  ($(uid tan1), 'on_duty',    'app', UTC_TIMESTAMP()),
  ($(uid tan2), 'on_duty',    'app', UTC_TIMESTAMP()),
  ($(uid tan3), 'on_duty',    'app', UTC_TIMESTAMP() - INTERVAL 2 HOUR),
  ($(uid tan3), 'off_duty',   'app', UTC_TIMESTAMP() - INTERVAL 1 HOUR),
  ($(uid tan5), 'responding', 'app', UTC_TIMESTAMP()),
  ($(uid tan_b2), 'on_duty',  'app', UTC_TIMESTAMP());
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, status, location_description, created_at) VALUES
  (1, $(uid tan1), 'theft', 'normal', 'pending', 'seed one', UTC_TIMESTAMP()),
  (1, $(uid tan1), 'theft', 'normal', 'pending', 'seed two', UTC_TIMESTAMP());
SQL
INC1=$(db_one "SELECT MIN(incident_id) FROM incident;"); INC2=$(db_one "SELECT MAX(incident_id) FROM incident;")
pass "Seeded 3 admins+3 spare, secretary/PB, 8 tanods, a second barangay, duty rows and 2 incidents (INC1=$INC1 INC2=$INC2)"

step "2. Start API (PHP built-in server, throwaway port)"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=15
export CORS_ALLOWED_ORIGIN='*'
export FCM_SERVICE_ACCOUNT_PATH=
export GSM_GATEWAY_ENABLED=false
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$BACKEND_DIR/scripts/.ctm-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

gen_uuid() {
  "$PHP_BIN" -r '$h=bin2hex(random_bytes(16)); echo substr($h,0,8)."-".substr($h,8,4)."-4".substr($h,13,3)."-8".substr($h,17,3)."-".substr($h,20,12);'
}
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=$argv[1]; echo is_array($d) && array_key_exists($k,$d) ? (is_scalar($d[$k]) ? $d[$k] : json_encode($d[$k])) : "MISSING";' "$1"; }
jwt_claim() { echo "$1" | cut -d. -f2 | "$PHP_BIN" -r '$p=json_decode(base64_decode(strtr(trim(file_get_contents("php://stdin")),"-_","+/")),true); echo $p["'"$2"'"] ?? "";'; }
kind_of_jti() { db_one "SELECT session_kind FROM auth_session WHERE jti='$1';"; }
BODY_FILE="$BACKEND_DIR/scripts/.ctm-body.json"

# login USER [DEVICE_ID_HEADER] [PASSWORD] -> token on stdout
login_tok() {
  local pw="${3:-$TEST_PW}"
  if [ -n "${2:-}" ]; then
    curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -H "X-Device-Id: $2" -d "{\"username\":\"$1\",\"password\":\"$pw\"}" | jget token
  else
    curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$pw\"}" | jget token
  fi
}
# req METHOD PATH TOKEN [JSON_BODY] [extra curl args...] -> sets CODE and BODY
req() {
  local method="$1" path="$2" token="$3" body="${4:-}"; shift 4 2>/dev/null || shift $#
  local args=(-s -o "$BODY_FILE" -w '%{http_code}' -X "$method" "${BASE_URL}${path}" -H "Authorization: Bearer $token")
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" -d "$body"); fi
  CODE=$(curl "${args[@]}" "$@")
  BODY=$(cat "$BODY_FILE" 2>/dev/null)
}
err_code() { echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["error"]["code"] ?? "";'; }
# Outcome label: SCOPE when the admin-device scope gate answered, else the HTTP status.
outcome() { if [ "$CODE" = "403" ] && [ "$(err_code)" = "DEVICE_SESSION_SCOPE" ]; then echo "SCOPE"; else echo "$CODE"; fi; }
expect_scope()   { req "$1" "$2" "$3" "${4:-}"; expect_eq "$(outcome)" "SCOPE" "device session denied: $1 $2"; }
expect_reached() { req "$1" "$2" "$3" "${4:-}"; if [ "$(outcome)" != "SCOPE" ] && [ "$CODE" != "401" ]; then pass "device session allowed: $1 $2 (HTTP $CODE, not the scope gate)"; else fail "device session NOT allowed: $1 $2 -> $(outcome)"; fi; }

DEV_A="and-$(gen_uuid)"   # adm1's first (keyless) phone
DEV_K="and-$(gen_uuid)"   # adm1's replacement phone, WITH a Keystore-style key
DEV_B="and-$(gen_uuid)"   # adm2's phone
DEV_T="and-$(gen_uuid)"   # tan1's phone

step "3. SessionPolicy: who gets a device session"
NOW=$(date +%s)
T=$(login_tok adm1 "$DEV_A"); [ -n "$T" ] && pass "adm1 logged in with X-Device-Id" || { fail "adm1 device login failed"; exit 1; }
A1D="$T"; JTI=$(jwt_claim "$T" jti)
expect_eq "$(kind_of_jti "$JTI")" "device" "Admin + well-formed X-Device-Id -> session_kind 'device'"
LIFE=$(( $(jwt_claim "$T" exp) - NOW )); [ "$LIFE" -gt 86000 ] && [ "$LIFE" -le 86460 ] && pass "Admin device JWT exp ~24h (${LIFE}s)" || fail "Admin device JWT exp not ~24h: ${LIFE}s"
expect_eq "$(db_one "SELECT JSON_EXTRACT(metadata_json,'\$.session_kind') FROM audit_log WHERE action='login_success' ORDER BY audit_id DESC LIMIT 1;")" '"device"' "login_success audit records session_kind=device (allow-listed enum)"
A1W=$(login_tok adm1 ""); expect_eq "$(kind_of_jti "$(jwt_claim "$A1W" jti)")" "web" "Admin WITHOUT the header -> 'web' (browser dashboard unchanged)"
LIFE=$(( $(jwt_claim "$A1W" exp) - NOW )); [ "$LIFE" -gt 840 ] && [ "$LIFE" -le 960 ] && pass "Admin web JWT exp ~15m (${LIFE}s)" || fail "Admin web JWT exp not ~15m: ${LIFE}s"
expect_eq "$(kind_of_jti "$(jwt_claim "$(login_tok adm1 'not-a-device-id')" jti)")" "web" "Admin + malformed X-Device-Id -> 'web'"
expect_eq "$(kind_of_jti "$(jwt_claim "$(login_tok sec1 "$DEV_A")" jti)")" "web" "Secretary + header -> still 'web' (never a device session)"
expect_eq "$(kind_of_jti "$(jwt_claim "$(login_tok pb1 "$DEV_A")" jti)")" "web" "Punong Barangay + header -> still 'web'"
TAN1D=$(login_tok tan1 "$DEV_T"); expect_eq "$(kind_of_jti "$(jwt_claim "$TAN1D" jti)")" "device" "Tanod + header -> 'device' (unchanged)"
A2D=$(login_tok adm2 "$DEV_B")

step "4. Users directory — GET /users/directory"
SEC=$(login_tok sec1 ""); PB=$(login_tok pb1 ""); TANW=$(login_tok tan2 ""); A1WEB="$A1W"
req GET "/users/directory?purpose=tanod" "$SEC"
expect_eq "$CODE" "200" "Secretary may read the tanod directory"
GOT=$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $n=array_map(fn($i)=>$i["full_name"],$d["items"]); sort($n); echo implode("|",$n);')
expect_eq "$GOT" "Tanod NoDuty|Tanod OffDuty|Tanod OnDuty|Tanod Raiser|Tanod Respond" "purpose=tanod lists exactly the 5 active, non-suspended tanods of barangay 1"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $k=[]; foreach($d["items"] as $i){ $x=array_keys($i); sort($x); $k[implode(",",$x)]=1; } echo implode(";",array_keys($k));')" "full_name,official_title,user_id" "Every item carries ONLY user_id, full_name, official_title (no username/phone/email/authorities)"
req GET "/users/directory?purpose=tanod" "$A1WEB"; expect_eq "$CODE" "200" "Admin (web) may read the tanod directory"
req GET "/users/directory?purpose=signer&authority=approve_report" "$SEC"
expect_eq "$CODE" "200" "Secretary may read the signer directory"
GOT=$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $n=array_map(fn($i)=>$i["full_name"].":".($i["official_title"]??"null"),$d["items"]); sort($n); echo implode("|",$n);')
expect_eq "$GOT" "Chief Beta:Deputy Chief|Punong One:Punong Barangay|Sec One:Barangay Secretary" "signer/approve_report: holders in eligible roles, same barangay, active, not suspended (no tanod with a stray authority, no inactive secretary, no suspended PB, no barangay-2 holder)"
req GET "/users/directory?purpose=signer&authority=prepare_annex_d" "$A1WEB"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo implode("|",array_map(fn($i)=>$i["full_name"],$d["items"]));')" "Chief Alpha" "signer/prepare_annex_d -> only the one holder"
req GET "/users/directory?purpose=signer&authority=approve_roster" "$A1WEB"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo implode("|",array_map(fn($i)=>$i["full_name"],$d["items"]));')" "Punong One" "signer/approve_roster -> only the Punong Barangay"
# Tenant scoping: a barangay-2 secretary sees only barangay-2 people.
SECB2=$(login_tok sec_b2 "")
req GET "/users/directory?purpose=signer&authority=approve_report" "$SECB2"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $n=array_map(fn($i)=>$i["full_name"],$d["items"]); sort($n); echo implode("|",$n);')" "Other Chief|Sec Other" "Barangay-2 caller sees only barangay-2 signers (scoped by the caller's tenant; no barangay parameter exists)"
req GET "/users/directory?purpose=tanod" "$SECB2"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo implode("|",array_map(fn($i)=>$i["full_name"],$d["items"]));')" "Tanod Other" "Barangay-2 tanod directory is barangay-2 only"
req GET "/users/directory?purpose=tanod&barangay_id=1" "$SECB2"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo implode("|",array_map(fn($i)=>$i["full_name"],$d["items"]));')" "Tanod Other" "A barangay_id query parameter is ignored (cannot cross tenants)"
req GET "/users/directory?purpose=tanod" "$PB"; expect_eq "$CODE" "403" "Punong Barangay -> 403"
req GET "/users/directory?purpose=tanod" "$TANW"; expect_eq "$CODE" "403" "Tanod -> 403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/users/directory?purpose=tanod"); expect_eq "$CODE" "401" "No token -> 401"
req GET "/users/directory" "$SEC"; expect_eq "$CODE" "400" "Missing purpose -> 400"
req GET "/users/directory?purpose=everyone" "$SEC"; expect_eq "$CODE" "400" "Unknown purpose -> 400"
req GET "/users/directory?purpose=signer" "$SEC"; expect_eq "$CODE" "400" "purpose=signer without authority -> 400"
req GET "/users/directory?purpose=signer&authority=god_mode" "$SEC"; expect_eq "$CODE" "400" "purpose=signer with an unknown authority -> 400"
req GET "/users/directory?purpose=tanod&authority=approve_report" "$SEC"; expect_eq "$CODE" "400" "authority with purpose=tanod -> 400"
req GET "/users/$(uid adm1)" "$SEC"; expect_eq "$CODE" "404" "(control) the directory did not widen GET /users/:id — Secretary still cannot read another user"

step "5. Admin WEB session is unaffected by the scope limit"
for p in /users /audit-log /system-settings "/shifts" "/availability" "/gps/history?user_id=$(uid tan1)"; do
  req GET "$p" "$A1WEB"
  if [ "$(outcome)" != "SCOPE" ] && [ "$CODE" != "401" ] && [ "$CODE" != "403" ]; then pass "admin web: GET $p -> $CODE"; else fail "admin web: GET $p -> $(outcome)/$CODE"; fi
done
req GET "/reports/export" "$A1WEB"; if [ "$(outcome)" != "SCOPE" ]; then pass "admin web: GET /reports/export reaches the controller (HTTP $CODE)"; else fail "admin web hit the scope gate"; fi

step "6. Admin DEVICE session: every allow-list entry is reachable"
req POST /devices/register "$A1D" "{\"device_id\":\"$DEV_A\",\"fcm_token\":\"fake-fcm-token-adm1\",\"platform\":\"android\"}"
expect_eq "$CODE" "200" "POST /devices/register by an admin device session (Chief Tanod phone registers itself)"
expect_eq "$(db_one "SELECT COUNT(*) FROM mobile_device WHERE device_id='$DEV_A' AND user_id=$(uid adm1) AND is_active=1;")" "1" "mobile_device row exists for the ADMIN (this is what NotificationService reads for push targeting)"
req GET /tanod-sos "$A1D";                        expect_eq "$CODE" "200" "GET /tanod-sos"
req GET /tanod-sos/fallback-contact "$A1D";       expect_eq "$CODE" "200" "GET /tanod-sos/fallback-contact (admin allowed since this change)"
req GET /dispatch "$A1D";                         expect_eq "$CODE" "200" "GET /dispatch"
req GET /incidents "$A1D";                        expect_eq "$CODE" "200" "GET /incidents"
req GET "/incidents/$INC1" "$A1D";                expect_eq "$CODE" "200" "GET /incidents/:id"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo array_key_exists("raw_narrative",$d) && $d["raw_narrative"]!==null ? "LEAK" : "none";')" "none" "GET /incidents/:id over the device session returns no raw_narrative to an Admin (Rule 1 unchanged)"
req GET "/gps/live?barangay_id=1" "$A1D";         expect_eq "$CODE" "200" "GET /gps/live"
req GET /notifications "$A1D";                    expect_eq "$CODE" "200" "GET /notifications"
req GET /barangays "$A1D";                        expect_eq "$CODE" "200" "GET /barangays"
expect_reached GET "/dispatch/999999/route?latitude=12.9&longitude=123.6&mode=car" "$A1D"
expect_reached GET /dispatch-offers "$A1D"
expect_reached POST /dispatch-offers "$A1D" '{}'
expect_reached PATCH /dispatch-offers/1/cancel "$A1D" '{}'
expect_reached POST /notifications/999999/ack "$A1D" '{}'
expect_reached PATCH /tanod-sos/999999/acknowledge "$A1D" '{}'
expect_reached POST /dispatch "$A1D" '{}'
expect_reached PATCH /dispatch/999999/cancel "$A1D" '{}'
expect_reached PATCH "/devices/does-not-exist-xyz/deactivate" "$A1D" '{}'
expect_reached POST /auth/change-password "$A1D" "{\"current_password\":\"$TEST_PW\",\"new_password\":\"x\"}"

step "7. Admin DEVICE session: everything off the allow-list is 403 DEVICE_SESSION_SCOPE"
expect_scope GET  /users "$A1D"
req GET "/users/directory?purpose=tanod" "$A1D"; expect_eq "$CODE" "200" "GET /users/directory (allowed on admin device: name list only)"
expect_scope POST /users "$A1D" '{}'
expect_scope GET  "/users/$(uid adm1)" "$A1D"
expect_scope GET  /audit-log "$A1D"
expect_scope GET  /system-settings "$A1D"
expect_scope PATCH /system-settings "$A1D" '{}'
expect_scope GET  /system/health "$A1D"
expect_scope PATCH "/incidents/$INC1/status" "$A1D" '{"status":"resolved"}'
expect_scope PATCH "/incidents/$INC1/lifecycle" "$A1D" '{"lifecycle":"cancelled"}'
expect_scope PATCH "/incidents/$INC1/related" "$A1D" '{"related_incident_id":null}'
expect_scope PATCH "/incidents/$INC1" "$A1D" '{"priority":"high"}'
expect_scope POST /incidents "$A1D" '{}'
expect_scope GET  "/incidents/nearby?latitude=12.9&longitude=123.6" "$A1D"
expect_scope GET  "/incidents/$INC1/evidence" "$A1D"
expect_scope PATCH /tanod-sos/999999/resolve "$A1D" '{}'
expect_scope POST /tanod-sos "$A1D" '{}'
expect_scope GET  /reports/export "$A1D"
expect_scope GET  "/reports/summary" "$A1D"
expect_scope GET  /availability "$A1D"
expect_scope GET  /shifts "$A1D"
expect_scope POST /shifts "$A1D" '{}'
expect_scope POST /shifts/publish "$A1D" '{"shift_ids":[1]}'
expect_scope GET  /shift-swap-requests "$A1D"
expect_scope POST /notifications/ack-all "$A1D" '{}'
expect_scope GET  "/gps/history?user_id=$(uid tan1)" "$A1D"
expect_scope POST /gps "$A1D" '{}'
expect_scope POST /sms/send "$A1D" '{}'
expect_scope GET  /sms/logs "$A1D"
expect_scope POST /sms/broadcast "$A1D" '{}'
expect_scope GET  /citizen-reports "$A1D"
expect_scope GET  /accomplishment-reports "$A1D"
expect_scope GET  /referrals "$A1D"
expect_scope GET  /schools "$A1D"
expect_scope POST /sync/batch "$A1D" '{}'
expect_scope GET  /map-packages/1/download "$A1D"
expect_scope POST /duty-status "$A1D" '{}'
echo "(the SAME admin's WEB session reaches those controllers — see step 5)"
DENIED_ROWS=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='device_session_scope_denied' AND actor_user_id=$(uid adm1);")
[ "$DENIED_ROWS" -ge 30 ] && pass "Every scope denial is audited ($DENIED_ROWS device_session_scope_denied rows for adm1)" || fail "scope denials not audited ($DENIED_ROWS rows)"
LEAK=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='device_session_scope_denied' AND JSON_LENGTH(metadata_json) <> 1;")
expect_eq "$LEAK" "0" "Denial audit metadata is just method_path (no token, no body, no names — Rule 8)"

step "8. Item 24 — an SOS reaches on-duty tanods AND every active admin (own barangay), never the sender"
# tan1 raises an SOS (no GPS fix needed).
SOS_CID1=$(gen_uuid)
req POST /tanod-sos "$TAN1D" "{\"latitude\":12.92,\"longitude\":123.66,\"client_event_id\":\"$SOS_CID1\"}"
expect_eq "$CODE" "201" "tan1 raises an SOS"
SOS1=$(echo "$BODY" | jget sos_id)
NOTIF1=$(db_one "SELECT notification_id FROM notification WHERE sos_id=$SOS1;")
TARGETS=$(db_one "SELECT GROUP_CONCAT(u.username ORDER BY u.username SEPARATOR ',') FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF1;")
expect_eq "$TARGETS" "adm_cap,adm_cp,adm_rv,adm1,adm2,tan2,tan5" "Targets = every active admin of barangay 1 + the on_duty tanod + the responding tanod (NOT the sender, the off-duty/never-on-duty/suspended-or-inactive tanods, barangay-2 users, secretary, punong barangay)"
expect_eq "$(db_one "SELECT device_id FROM notification_target WHERE notification_id=$NOTIF1 AND user_id=$(uid adm1);")" "$DEV_A" "adm1's target row carries adm1's REGISTERED DEVICE id (push destination)"
expect_eq "$(db_one "SELECT COALESCE(device_id,'NULL') FROM notification_target WHERE notification_id=$NOTIF1 AND user_id=$(uid adm2);")" "NULL" "adm2 has no device: target device_id is NULL (Rule 12 -> SMS directly)"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_delivery d JOIN notification_target nt ON nt.notification_target_id=d.notification_target_id WHERE nt.notification_id=$NOTIF1 AND nt.user_id=$(uid adm1) AND d.channel='fcm';")" "2" "adm1 (device registered, token on file) gets FCM delivery attempts 1+2 (retry once, Rule 12)"
FAILWHY=$(db_one "SELECT GROUP_CONCAT(DISTINCT d.failure_reason) FROM notification_delivery d JOIN notification_target nt ON nt.notification_target_id=d.notification_target_id WHERE nt.notification_id=$NOTIF1 AND nt.user_id=$(uid adm1) AND d.channel='fcm';")
expect_eq "$FAILWHY" "FCM_NOT_CONFIGURED" "...and the ONLY thing that fails them here is that no FCM project is configured in this env (nothing role-based blocks an admin device)"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_delivery d JOIN notification_target nt ON nt.notification_target_id=d.notification_target_id WHERE nt.notification_id=$NOTIF1 AND nt.user_id=$(uid adm1) AND d.channel='sms';")" "1" "adm1 then falls back to one SMS attempt (Rule 12)"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_delivery d JOIN notification_target nt ON nt.notification_target_id=d.notification_target_id WHERE nt.notification_id=$NOTIF1 AND nt.user_id=$(uid adm2) AND d.channel='fcm';")" "0" "adm2 (no device) gets NO fcm attempt, straight to SMS"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_delivery d JOIN notification_target nt ON nt.notification_target_id=d.notification_target_id WHERE nt.notification_id=$NOTIF1 AND nt.user_id=$(uid adm2) AND d.channel='sms';")" "1" "adm2 gets exactly one SMS attempt"
expect_eq "$(db_one "SELECT COUNT(DISTINCT nt.user_id) FROM notification_delivery d JOIN notification_target nt ON nt.notification_target_id=d.notification_target_id WHERE nt.notification_id=$NOTIF1;")" "7" "Every one of the 7 targets has at least one delivery row"
# The admin phone sees it and acknowledges it.
req GET /notifications "$A1D"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $f=0; foreach($d["items"] as $i){ if((int)($i["notification_id"]??0)===(int)$argv[1]) $f=1; } echo $f;' "$NOTIF1")" "1" "GET /notifications over the admin device session lists the SOS notification"
req POST "/notifications/$NOTIF1/ack" "$A1D" '{}'; expect_eq "$CODE" "200" "Admin device acknowledges the notification"
req GET /tanod-sos "$A1D"
expect_eq "$(echo "$BODY" | "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); $f=0; foreach($d["items"] as $i){ if((int)$i["sos_id"]===(int)$argv[1]) $f=1; } echo $f;' "$SOS1")" "1" "GET /tanod-sos over the device session lists the SOS"

step "9. Mobile writes from an admin device follow the Tanod device rules (header + ownership + H-09 signature)"
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}'
expect_eq "$CODE" "400" "Signed-write class without X-Device-Id -> 400 (same code a Tanod mobile write gets)"
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: and-$(gen_uuid)"
expect_eq "$CODE" "422" "X-Device-Id that is not registered to this account -> 422 (same code a Tanod gets)"
# adm2 registers its own phone; adm1 must not be able to borrow it.
req POST /devices/register "$A2D" "{\"device_id\":\"$DEV_B\",\"platform\":\"android\"}"; expect_eq "$CODE" "200" "adm2 registers its own device"
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: $DEV_B"
expect_eq "$CODE" "422" "adm1 borrowing adm2's device id -> 422 (ownership checked per account)"
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: $DEV_A"
expect_eq "$CODE" "200" "Own registered device, no key on file (phased rollout) -> allowed: header + ownership only, exactly today's Tanod baseline"
expect_eq "$(db_one "SELECT status FROM tanod_sos WHERE sos_id=$SOS1;")" "acknowledged" "SOS is now acknowledged"
req PATCH "/tanod-sos/$SOS1/resolve" "$A1D" '{}' -H "X-Device-Id: $DEV_A"
expect_eq "$(outcome)" "SCOPE" "Resolve over the device session is denied by scope even with a valid device header"
expect_eq "$(db_one "SELECT status FROM tanod_sos WHERE sos_id=$SOS1;")" "acknowledged" "...and the SOS stays acknowledged (nothing changed)"

# POST /dispatch + cancel from the device.
D_REQ=$(gen_uuid)
DISPATCH_BODY="{\"incident_id\":$INC1,\"tanod_id\":$(uid tan2),\"request_id\":\"$D_REQ\",\"override_reason\":\"Chief Tanod phone test, no roster in this DB\"}"
req POST /dispatch "$A1D" "$DISPATCH_BODY"
expect_eq "$CODE" "400" "POST /dispatch from the admin device without X-Device-Id -> 400"
req POST /dispatch "$A1D" "$DISPATCH_BODY" -H "X-Device-Id: $DEV_A"
if [ "$CODE" = "201" ] || [ "$CODE" = "200" ]; then pass "POST /dispatch from the registered admin device creates the dispatch (HTTP $CODE)"; else fail "POST /dispatch -> $CODE $BODY"; fi
DISP1=$(echo "$BODY" | jget dispatch_id)
expect_eq "$(db_one "SELECT dispatched_by FROM dispatch WHERE dispatch_id=$DISP1;")" "$(uid adm1)" "dispatch.dispatched_by is the Chief Tanod (adm1)"
req PATCH "/dispatch/$DISP1/cancel" "$A1D" '{"reason":"test cancel"}'
expect_eq "$CODE" "400" "PATCH /dispatch/:id/cancel from the admin device without X-Device-Id -> 400"
req PATCH "/dispatch/$DISP1/cancel" "$A1D" '{"reason":"test cancel"}' -H "X-Device-Id: $DEV_A"
expect_eq "$CODE" "200" "PATCH /dispatch/:id/cancel from the registered admin device"
expect_eq "$(db_one "SELECT status FROM dispatch WHERE dispatch_id=$DISP1;")" "cancelled" "dispatch cancelled"

# Re-registering a NEW device with a hardware key: the old device is deactivated, the key is stored, signatures enforced.
mkdir -p "$KEY_DIR"
"$OPENSSL_BIN" ecparam -name prime256v1 -genkey -noout -out "$KEY_DIR/k.key" 2>/dev/null
"$OPENSSL_BIN" ec -in "$KEY_DIR/k.key" -pubout -out "$KEY_DIR/k.pub" 2>/dev/null
"$OPENSSL_BIN" ecparam -name prime256v1 -genkey -noout -out "$KEY_DIR/wrong.key" 2>/dev/null
[ -s "$KEY_DIR/k.pub" ] && pass "Generated a Keystore-style EC keypair" || fail "keygen failed"
REG_K=$("$PHP_BIN" -r 'echo json_encode(["device_id"=>$argv[1],"platform"=>"android","device_public_key_pem"=>file_get_contents($argv[2])]);' "$DEV_K" "$KEY_DIR/k.pub")
req POST /devices/register "$A1D" "$REG_K"; expect_eq "$CODE" "200" "adm1 registers a second phone WITH a public key"
expect_eq "$(db_one "SELECT is_active FROM mobile_device WHERE device_id='$DEV_A';")" "0" "Registering a new device deactivates adm1's previous one (single active device, same rule as Tanods)"
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: $DEV_A"
expect_eq "$CODE" "422" "The deactivated old device id is no longer accepted for writes"

sign_request() { printf '%s\n%s\n%s\n%s' "$1" "$2" "$3" "$4" | "$OPENSSL_BIN" dgst -sha256 -sign "$5" | base64 -w0; }
TS=$(date +%s)
P_ACK="/api/v1/tanod-sos/$SOS1/acknowledge"
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: $DEV_K"
expect_eq "$CODE" "401" "Keyed device, NO signature headers -> 401 (H-09 enforced for admin devices)"
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: $DEV_K" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: aW52YWxpZC1zaWduYXR1cmU="
expect_eq "$CODE" "401" "Keyed device, garbage signature -> 401"
WSIG=$(sign_request PATCH "$P_ACK" "$DEV_K" "$TS" "$KEY_DIR/wrong.key")
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: $DEV_K" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $WSIG"
expect_eq "$CODE" "401" "Keyed device, signature from a DIFFERENT private key -> 401 (real crypto, not a stub)"
OLD=$(( $(date +%s) - 600 ))
SSIG=$(sign_request PATCH "$P_ACK" "$DEV_K" "$OLD" "$KEY_DIR/k.key")
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: $DEV_K" -H "X-Device-Timestamp: $OLD" -H "X-Device-Signature: $SSIG"
expect_eq "$CODE" "401" "Keyed device, correct signature but 10-minute-old timestamp -> 401 (replay window)"
WPSIG=$(sign_request PATCH "/api/v1/tanod-sos/999/acknowledge" "$DEV_K" "$TS" "$KEY_DIR/k.key")
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: $DEV_K" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $WPSIG"
expect_eq "$CODE" "401" "A signature minted for a DIFFERENT path cannot be replayed here -> 401"
GSIG=$(sign_request PATCH "$P_ACK" "$DEV_K" "$TS" "$KEY_DIR/k.key")
req PATCH "/tanod-sos/$SOS1/acknowledge" "$A1D" '{}' -H "X-Device-Id: $DEV_K" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $GSIG"
expect_eq "$CODE" "200" "Keyed device, valid signature -> 200"
# Keyed dispatch create/cancel.
D2_REQ=$(gen_uuid)
D2_BODY="{\"incident_id\":$INC2,\"tanod_id\":$(uid tan2),\"request_id\":\"$D2_REQ\",\"override_reason\":\"Chief Tanod phone test, signed\"}"
req POST /dispatch "$A1D" "$D2_BODY" -H "X-Device-Id: $DEV_K"
expect_eq "$CODE" "401" "POST /dispatch from a keyed admin device without a signature -> 401"
TS=$(date +%s); DSIG=$(sign_request POST "/api/v1/dispatch" "$DEV_K" "$TS" "$KEY_DIR/k.key")
req POST /dispatch "$A1D" "$D2_BODY" -H "X-Device-Id: $DEV_K" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $DSIG"
if [ "$CODE" = "201" ] || [ "$CODE" = "200" ]; then pass "POST /dispatch from a keyed admin device with a valid signature (HTTP $CODE)"; else fail "signed POST /dispatch -> $CODE $BODY"; fi
DISP2=$(echo "$BODY" | jget dispatch_id)
TS=$(date +%s); CSIG=$(sign_request PATCH "/api/v1/dispatch/$DISP2/cancel" "$DEV_K" "$TS" "$KEY_DIR/k.key")
req PATCH "/dispatch/$DISP2/cancel" "$A1D" '{"reason":"signed cancel"}' -H "X-Device-Id: $DEV_K" -H "X-Device-Timestamp: $TS" -H "X-Device-Signature: $CSIG"
expect_eq "$CODE" "200" "PATCH /dispatch/:id/cancel from a keyed admin device with a valid signature"
# Reads from a keyed device need no signature (same as the Tanod app today).
req GET /dispatch "$A1D"; expect_eq "$CODE" "200" "Reads need no signature (matches what the mobile client sends today)"

step "10. Device deactivate: own device only"
req PATCH "/devices/$DEV_B/deactivate" "$A1D" '{}'
expect_eq "$CODE" "404" "adm1 cannot deactivate adm2's device (404, existence not leaked)"
expect_eq "$(db_one "SELECT is_active FROM mobile_device WHERE device_id='$DEV_B';")" "1" "adm2's device is untouched"

step "11. Second SOS: once the admin's device is deactivated there is no push destination (SMS only)"
req PATCH "/devices/$DEV_K/deactivate" "$A1D" '{}'
expect_eq "$CODE" "200" "adm1 deactivates its own device (device session may do this)"
SOS_CID2=$(gen_uuid)
req POST /tanod-sos "$TAN1D" "{\"latitude\":12.93,\"longitude\":123.67,\"client_event_id\":\"$SOS_CID2\"}"
expect_eq "$CODE" "201" "tan1 raises a second SOS ($BODY)"
SOS2=$(echo "$BODY" | jget sos_id); NOTIF2=$(db_one "SELECT notification_id FROM notification WHERE sos_id=$SOS2;")
expect_eq "$(db_one "SELECT COALESCE(device_id,'NULL') FROM notification_target WHERE notification_id=$NOTIF2 AND user_id=$(uid adm1);")" "NULL" "adm1 with no active device -> target device_id NULL"
expect_eq "$(db_one "SELECT COUNT(*) FROM notification_delivery d JOIN notification_target nt ON nt.notification_target_id=d.notification_target_id WHERE nt.notification_id=$NOTIF2 AND nt.user_id=$(uid adm1) AND d.channel='fcm';")" "0" "...so no FCM attempt, SMS only"
expect_eq "$(db_one "SELECT GROUP_CONCAT(u.username ORDER BY u.username SEPARATOR ',') FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF2;")" "adm_cap,adm_cp,adm_rv,adm1,adm2,tan2,tan5" "Same fan-out set on the second SOS"
# A suspended/deactivated admin is not alerted; a tanod who went off duty is not either.
mysql_exec "$VALDB" -e "UPDATE user SET is_active=0 WHERE username='adm_cap'; INSERT INTO duty_status (user_id,status,channel,changed_at) VALUES ($(uid tan2),'off_duty','app',UTC_TIMESTAMP() + INTERVAL 1 SECOND);"
SOS_CID3=$(gen_uuid)
req POST /tanod-sos "$TAN1D" "{\"latitude\":12.93,\"longitude\":123.67,\"client_event_id\":\"$SOS_CID3\"}"
SOS3=$(echo "$BODY" | jget sos_id); NOTIF3=$(db_one "SELECT notification_id FROM notification WHERE sos_id=$SOS3;")
expect_eq "$(db_one "SELECT GROUP_CONCAT(u.username ORDER BY u.username SEPARATOR ',') FROM notification_target nt JOIN user u ON u.user_id=nt.user_id WHERE nt.notification_id=$NOTIF3;")" "adm_cp,adm_rv,adm1,adm2,tan5" "Deactivated admin and now-off-duty tanod drop out of the fan-out"

step "12. Revocation still kills an admin device session on the very next request"
RV=$(login_tok adm_rv "and-$(gen_uuid)")
expect_eq "$(kind_of_jti "$(jwt_claim "$RV" jti)")" "device" "adm_rv has a device session"
req GET /dispatch "$RV"; expect_eq "$CODE" "200" "works before revocation"
curl -s -o /dev/null -X POST "${BASE_URL}/auth/logout" -H "Authorization: Bearer $RV"
req GET /dispatch "$RV"; expect_eq "$CODE" "401" "After logout the 24h admin device token is rejected immediately"
RV=$(login_tok adm_rv "and-$(gen_uuid)")
mysql_exec "$VALDB" -e "UPDATE user SET is_suspended=1, suspended_at=UTC_TIMESTAMP(), suspended_reason='t' WHERE username='adm_rv';"
req GET /dispatch "$RV"; expect_eq "$CODE" "401" "Suspension kills the live admin device session on the next request"
mysql_exec "$VALDB" -e "UPDATE user SET is_suspended=0, suspended_at=NULL, suspended_reason=NULL WHERE username='adm_rv';"
RV=$(login_tok adm_rv "and-$(gen_uuid)")
mysql_exec "$VALDB" -e "UPDATE user SET is_active=0 WHERE username='adm_rv';"
req GET /dispatch "$RV"; expect_eq "$CODE" "401" "Deactivation kills the live admin device session on the next request"
# Password change: current session stays valid, every OTHER session (incl. another device session) dies.
CP1=$(login_tok adm_cp "and-$(gen_uuid)"); CP2=$(login_tok adm_cp "and-$(gen_uuid)"); CPW=$(login_tok adm_cp "")
NEWPW="ChiefTanod#2026Zq"
req POST /auth/change-password "$CP1" "{\"current_password\":\"$TEST_PW\",\"new_password\":\"$NEWPW\"}"
expect_eq "$CODE" "200" "change-password over an admin device session succeeds"
req GET /dispatch "$CP1"; expect_eq "$CODE" "200" "...current device session stays valid"
req GET /dispatch "$CP2"; expect_eq "$CODE" "401" "...another admin device session is revoked"
req GET /users "$CPW"; expect_eq "$CODE" "401" "...and the admin's web session is revoked"
expect_eq "$([ -n "$(login_tok adm_cp "" "$NEWPW")" ] && echo ok || echo no)" "ok" "The new password works"

step "13. The 7-day absolute cap applies to admin device sessions"
CAP=$(login_tok adm_cap "and-$(gen_uuid)")
mysql_exec "$VALDB" -e "UPDATE user SET is_active=1 WHERE username='adm_cap';"
CAP=$(login_tok adm_cap "and-$(gen_uuid)"); JTI_CAP=$(jwt_claim "$CAP" jti)
expect_eq "$(kind_of_jti "$JTI_CAP")" "device" "adm_cap has a device session"
mysql_exec "$VALDB" -e "UPDATE auth_session SET issued_at = UTC_TIMESTAMP() - INTERVAL 166 HOUR, expires_at = UTC_TIMESTAMP() + INTERVAL 1 HOUR WHERE jti='$JTI_CAP';"
HDR=$(curl -s -D - -o /dev/null "${BASE_URL}/notifications" -H "Authorization: Bearer $CAP" | grep -i "^X-Renewed-Token:" | cut -d' ' -f2 | tr -d '\r')
[ -n "$HDR" ] && pass "Admin device session renews when under half its lifetime" || fail "no X-Renewed-Token"
EXP_IN=$(db_one "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), expires_at) FROM auth_session WHERE jti='$JTI_CAP';")
CAP_IN=$(db_one "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), issued_at + INTERVAL 7 DAY) FROM auth_session WHERE jti='$JTI_CAP';")
[ "$EXP_IN" -gt 7000 ] && [ "$EXP_IN" -le "$((CAP_IN + 3))" ] && [ "$EXP_IN" -lt 10000 ] && pass "Renewed expiry lands AT the 7-day cap (${EXP_IN}s), not +24h" || fail "cap not applied: expires in ${EXP_IN}s, cap in ${CAP_IN}s"
# A scope-denied probe must NOT extend a session (the gate runs before renewal).
mysql_exec "$VALDB" -e "UPDATE auth_session SET expires_at = UTC_TIMESTAMP() + INTERVAL 1 HOUR WHERE jti='$JTI_CAP';"
BEFORE=$(db_one "SELECT expires_at FROM auth_session WHERE jti='$JTI_CAP';")
curl -s -o /dev/null "${BASE_URL}/users" -H "Authorization: Bearer $CAP"
AFTER=$(db_one "SELECT expires_at FROM auth_session WHERE jti='$JTI_CAP';")
expect_eq "$AFTER" "$BEFORE" "A scope-denied request does not renew/extend the session"

echo; echo "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
