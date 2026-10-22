#!/usr/bin/env bash
# Rebuilds baranguard_uiseed (the one demo/UAT/eval DB): drop, migrations, grant, UAT seed (67 incidents, Sep 1 -> now).
# Simulated data only. Needs MySQL root with a blank password (XAMPP default) or MYSQL_PWD set. ~1-2 min.
set -e
cd "$(dirname "$0")/.."
M=/c/xampp/mysql/bin/mysql.exe; PHP=/c/xampp/php/php.exe; DB=baranguard_uiseed
R="$M -h127.0.0.1 -P3306 -uroot --default-character-set=utf8mb4"
APPUSER=$(grep ^DB_USER .env | cut -d= -f2)
$R -e "DROP DATABASE IF EXISTS \`$DB\`; CREATE DATABASE \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
for f in $(ls migrations/*.sql | grep -v '\.down\.sql' | sort); do $R $DB < "$f" || { echo "FAIL $f"; exit 1; }; done
for h in $($R -N -B -e "select host from mysql.user where user='$APPUSER'"); do
  $R -e "GRANT SELECT, INSERT, UPDATE, DELETE ON \`$DB\`.* TO '$APPUSER'@'$h'; FLUSH PRIVILEGES;"
done
CH4_DB_USER=root CH4_DB_PASSWORD="${MYSQL_PWD:-}" $PHP scripts/seed-ch4.php --db=$DB --profile=uat --seed=2026 --since=2026-09-01 --incidents=67
