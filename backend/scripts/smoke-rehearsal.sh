#!/usr/bin/env bash
# Read-only API smoke test against a SCRATCH database (refuses the two real DBs).
# Usage: smoke-rehearsal.sh <scratch_db> <username> <password>   (login user must already exist in the scratch DB)
# Mints a throwaway MySQL user + php -S server, removes both on exit.
set -uo pipefail
db=$1; u=$2; pw=$3
case $db in baranguard|baranguard_uiseed) echo "refusing real DB"; exit 2;; esac
M=/c/xampp/mysql/bin/mysql.exe; R=(-uroot -h127.0.0.1 -P"${DB_PORT:-3306}")
AU=smoke_tmp_user; AP=$(php -r 'echo bin2hex(random_bytes(8));'); PORT=${API_PORT:-18099}
cleanup(){ [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; "$M" "${R[@]}" -e "DROP USER IF EXISTS '$AU'@'localhost'"; }
trap cleanup EXIT
"$M" "${R[@]}" -e "DROP USER IF EXISTS '$AU'@'localhost'; CREATE USER '$AU'@'localhost' IDENTIFIED BY '$AP'; GRANT ALL ON \`$db\`.* TO '$AU'@'localhost'; FLUSH PRIVILEGES"
export DB_HOST=127.0.0.1 DB_PORT=${DB_PORT:-3306} DB_USER=$AU DB_PASSWORD=$AP DB_NAME=$db CORS_ALLOWED_ORIGIN='*' JWT_EXPIRES_IN_MINUTES=15
export JWT_SECRET=$(php -r 'echo bin2hex(random_bytes(32));')
(cd "$(dirname "$0")/../public" && exec php -S 127.0.0.1:$PORT >/dev/null 2>&1) & PID=$!
sleep 2; B=http://127.0.0.1:$PORT/api/v1; fail=0
chk(){ [ "$2" = "$3" ] && echo "[PASS] $1 -> $2" || { echo "[FAIL] $1 -> $2 (want $3)"; fail=1; }; }
chk "GET /barangays (public)" "$(curl -s -o /dev/null -w %{http_code} $B/barangays)" 200
TOK=$(curl -s $B/auth/login -X POST -H 'Content-Type: application/json' -d "{\"username\":\"$u\",\"password\":\"$pw\"}" | php -r '$j=json_decode(stream_get_contents(STDIN),true);echo $j["token"]??$j["access_token"]??"";')
[ -n "$TOK" ] && echo "[PASS] login $u" || { echo "[FAIL] login $u"; exit 1; }
for p in incidents dispatch shifts "reports/nav-counts" "reports/summary" users schools availability referrals "accomplishment-reports" "dispatch-offers" "system/health" "notifications" "audit-log"; do
  c=$(curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer $TOK" "$B/$p"); case $c in 200) echo "[PASS] GET /$p -> 200";; *) echo "[INFO] GET /$p -> $c";; esac
done
exit $fail
