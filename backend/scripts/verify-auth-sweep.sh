#!/usr/bin/env bash
# Baranguard — authentication and authorization sweep over EVERY /api/v1
# route (Rule 2: every protected endpoint verifies role + tenant + ownership
# server-side; Rule 12: a session dies on the next request after logout).
#
# The route list comes from the real route tables (scripts/lib/route-table.php),
# so a new route is swept automatically. Three checks per route:
#   1. Bad credentials: no token, a malformed token, a token signed with the
#      wrong key, an expired token, an unsigned "alg: none" token and a token
#      whose session was logged out must ALL get 401 on a protected route.
#   2. Robustness: no role (admin, secretary, punong_barangay, tanod) gets a
#      5xx, even with an empty body and placeholder ids.
#   3. Role guard: a role the handler's requireRole() does not list never
#      gets a 2xx. (14 handlers check roles indirectly; they get checks 1-2.)
#
# Safe to run: disposable database, disposable app user, throwaway port.
# Usage (Git Bash): bash backend/scripts/verify-auth-sweep.sh

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
VALDB="baranguard_sweepchk"
APP_USER="sweepchk_app"
APP_PASSWORD="SweepChk!2026xx"
API_PORT="8142"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Sweep#2026Pw"
SCRATCH="$BACKEND_DIR/scripts/.sweepchk"

echo "Baranguard auth sweep — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
PHPDIR="$BACKEND_DIR"
command -v cygpath >/dev/null 2>&1 && PHPDIR="$(cygpath -m "$BACKEND_DIR")"

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
jget() { "$PHP_BIN" -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d[$argv[1]] ?? "";' "$1"; }
code_of() { # METHOD PATH [TOKEN]
  local args=(-s -o /dev/null -w '%{http_code}' -X "$1" "${BASE_URL}$2")
  [ -n "${3:-}" ] && args+=(-H "Authorization: Bearer $3")
  [ "$1" != "GET" ] && args+=(-H "Content-Type: application/json" -d '{}')
  curl "${args[@]}"
}

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  . "$(dirname "$0")/lib/stop-php-server.sh" && stop_php_server "${API_PORT}"
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$SCRATCH"
  echo "Stopped the test server, dropped $VALDB / '$APP_USER'."
}
trap cleanup EXIT

step "0. Connectivity"
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }

step "1. Disposable schema (FULL migration chain) and one account per role"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Full migration chain applied"
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"
HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" -e "INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, is_suspended, created_at) VALUES
  (1,'sw_admin','$HASH','Sweep Admin','admin',1,0,UTC_TIMESTAMP()),
  (1,'sw_secretary','$HASH','Sweep Secretary','secretary',1,0,UTC_TIMESTAMP()),
  (1,'sw_punong_barangay','$HASH','Sweep PB','punong_barangay',1,0,UTC_TIMESTAMP()),
  (1,'sw_tanod','$HASH','Sweep Tanod','tanod',1,0,UTC_TIMESTAMP()),
  (1,'sw_victim','$HASH','Sweep Logout','admin',1,0,UTC_TIMESTAMP());"
pass "Seeded admin, secretary, punong_barangay, tanod and a logout-test admin"

step "2. Start the API"
mkdir -p "$SCRATCH"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" DB_NAME="$VALDB"
export JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
export JWT_EXPIRES_IN_MINUTES=30 CORS_ALLOWED_ORIGIN='*'
export EVIDENCE_DIR="$SCRATCH/evidence" REPORT_EXPORT_DIR="$SCRATCH/reports" MAP_PACKAGE_DIR="$SCRATCH/maps"
"$PHP_BIN" -S "127.0.0.1:${API_PORT}" -t "$BACKEND_DIR/public" >"$SCRATCH/server.log" 2>&1 &
SERVER_PID=$!
sleep 2
login_as() { curl -s "${BASE_URL}/auth/login" -X POST -H "Content-Type: application/json" -d "{\"username\":\"$1\",\"password\":\"$TEST_PW\"}" | jget token; }
declare -A TOK
for role in admin secretary punong_barangay tanod; do TOK[$role]=$(login_as "sw_$role"); done
VICTIM=$(login_as sw_victim)
if [ -n "${TOK[admin]}" ] && [ -n "${TOK[secretary]}" ] && [ -n "${TOK[punong_barangay]}" ] && [ -n "${TOK[tanod]}" ] && [ -n "$VICTIM" ]; then
  pass "All 5 accounts logged in against the disposable database"
else
  fail "A login failed — stopping"; exit 1
fi

step "3. Forged, expired and revoked tokens built from a real one"
forge() { # MODE TOKEN
  "$PHP_BIN" -r '
    [$h, $c] = explode(".", $argv[2]);
    $b = fn($s) => rtrim(strtr(base64_encode($s), "+/", "-_"), "=");
    $claims = json_decode(base64_decode(strtr($c, "-_", "+/")), true);
    $sign = fn($h, $c, $k) => $b(hash_hmac("sha256", "$h.$c", $k, true));
    $hdr = $b(json_encode(["alg" => "HS256", "typ" => "JWT"]));
    switch ($argv[1]) {
      case "wrongkey": $p = $b(json_encode($claims)); echo "$hdr.$p." . $sign($hdr, $p, "not-the-real-secret"); break;
      case "expired":  $claims["exp"] = time() - 60; $p = $b(json_encode($claims)); echo "$hdr.$p." . $sign($hdr, $p, getenv("JWT_SECRET")); break;
      case "none":     echo $b(json_encode(["alg" => "none", "typ" => "JWT"])) . "." . $b(json_encode($claims)) . "."; break;
    }' "$1" "$2"
}
WRONGKEY=$(forge wrongkey "${TOK[admin]}")
EXPIRED=$(forge expired "${TOK[admin]}")
ALGNONE=$(forge none "${TOK[admin]}")
GARBAGE="not.a.jwt"
[ "$(code_of GET /audit-log "$VICTIM")" = "200" ] && pass "The logout-test session works before logout" || fail "The logout-test session did not work before logout"
curl -s -o /dev/null -X POST "${BASE_URL}/auth/logout" -H "Authorization: Bearer $VICTIM"
[ "$(code_of GET /audit-log "$VICTIM")" = "401" ] && pass "The same session is refused right after logout" || fail "A logged-out session still works"

step "4. Sweep every route"
ROUTES="$SCRATCH/routes.tsv"
"$PHP_BIN" "$PHPDIR/scripts/lib/route-table.php" > "$ROUTES"
TOTAL=$(wc -l < "$ROUTES" | tr -d ' ')
[ "$TOTAL" -gt 90 ] && pass "Loaded $TOTAL routes from the route tables" || fail "Only $TOTAL routes loaded"
# Expected roles come from the REVIEWED matrix, never from the code under test,
# so a widened requireRole() is caught both as drift and as a role getting in.
declare -A EXPECTED
while IFS=$'\t' read -r m p r; do
  [ -z "$m" ] || [ "${m:0:1}" = "#" ] && continue
  EXPECTED["$m $p"]="$r"
done < "$BACKEND_DIR/scripts/lib/route-roles.tsv"
ALL_ROLES="admin secretary punong_barangay tanod"
while IFS=$'\t' read -r method path auth coderoles; do
  label="$method $path"
  if [ -z "${EXPECTED[$label]+x}" ]; then
    fail "$label: not in scripts/lib/route-roles.tsv (add its reviewed roles)"; roles="$coderoles"
  else
    roles="${EXPECTED[$label]}"
    [ "$coderoles" = "$roles" ] && pass "$label: handler roles match the reviewed matrix [${roles:-indirect}]" \
      || fail "$label: handler now allows [$coderoles] but the reviewed matrix says [$roles]"
  fi
  # Session-ending routes would revoke the sweep's own tokens; they are covered by step 3 and the auth suites.
  case "$path" in /auth/logout|/auth/change-password|/auth/login) skip_roles=1 ;; *) skip_roles=0 ;; esac

  if [ "$auth" = "1" ]; then
    got=""
    for t in "" "$GARBAGE" "$WRONGKEY" "$EXPIRED" "$ALGNONE" "$VICTIM"; do got="$got $(code_of "$method" "$path" "$t")"; done
    [ "$got" = " 401 401 401 401 401 401" ] && pass "$label: no, malformed, wrong-key, expired, alg-none and revoked tokens all get 401" \
      || fail "$label: bad credentials got [$got ] instead of six 401s"
  fi

  [ "$skip_roles" = "1" ] && continue
  five="" twoxx=""
  for role in $ALL_ROLES; do
    c=$(code_of "$method" "$path" "${TOK[$role]}")
    [ "${c:0:1}" = "5" ] && five="$five $role:$c"
    if [ -n "$roles" ] && [[ ",$roles," != *",$role,"* ]] && [ "${c:0:1}" = "2" ]; then twoxx="$twoxx $role:$c"; fi
  done
  [ -z "$five" ] && pass "$label: no role gets a server error" || fail "$label: server error for$five"
  if [ -n "$roles" ]; then
    [ -z "$twoxx" ] && pass "$label: roles outside [$roles] never succeed" || fail "$label: role not allowed got success:$twoxx"
  fi
done < "$ROUTES"

step "5. Server log has no PHP fatal errors"
grep -q -E 'PHP (Fatal|Parse) error' "$SCRATCH/server.log" && fail "PHP fatal error in the server log: $(grep -m1 -E 'PHP (Fatal|Parse) error' "$SCRATCH/server.log")" || pass "No PHP fatal or parse errors during the sweep"

echo
echo "================================================================"
echo "RESULT: $PASS passed, $FAIL failed."
echo "================================================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
