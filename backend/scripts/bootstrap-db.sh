#!/usr/bin/env bash
# Baranguard — one-shot database bootstrap for a FRESH machine (new laptop,
# fresh clone). Creates the real application database, creates the
# least-privileged `baranguard_app` DB user (§8: no CREATE/ALTER/CREATE
# TABLE — matches docs/REFERENCE.md's stated policy), and applies every
# migration 0001..0022 in order. Refuses to touch a database that already
# exists — this is a create-once bootstrap, not a re-sync tool; there is
# no migration-tracking table in this codebase (see backend/migrations/
# and every verify-*.sh script, which all apply raw .sql files directly),
# so re-running against a live schema would just fail loudly on duplicate
# CREATE TABLE rather than silently corrupting anything, but it's cleaner
# to refuse up front with a clear message.
#
# Usage (from a Git Bash prompt, repo root or anywhere):
#   bash backend/scripts/bootstrap-db.sh
#
# Uses XAMPP's default root/no-password local admin account to create the
# database + app user, matching every verify-*.sh script's convention.
# Override if your XAMPP root account has a password, or you want a
# non-default database name/app credentials:
#   XAMPP_MYSQL_PASSWORD=yourpass bash backend/scripts/bootstrap-db.sh
#   APP_DB_NAME=baranguard APP_DB_USER=baranguard_app APP_DB_PASSWORD='...' bash backend/scripts/bootstrap-db.sh
#
# This script only touches the database. It does NOT write backend/.env —
# copy backend/.env.example yourself and fill in DB_NAME/DB_USER/
# DB_PASSWORD with whatever this script printed at the end (see
# docs/SETUP.md).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
MIGRATIONS_DIR="$BACKEND_DIR/migrations"

PASS=0
FAIL=0
pass() { echo "[OK]   $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"

APP_DB_NAME="${APP_DB_NAME:-baranguard}"
APP_DB_USER="${APP_DB_USER:-baranguard_app}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-}"

if [ -z "$APP_DB_PASSWORD" ]; then
  # config/env.php's own doc: an empty DB_PASSWORD is rejected by design
  # elsewhere in this codebase, so generate a real one now rather than
  # hand back a user that can't actually be used.
  APP_DB_PASSWORD="$(php -r 'echo bin2hex(random_bytes(16));' 2>/dev/null || echo "ChangeMe$(date +%s)!")"
fi

echo "Baranguard DB bootstrap — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "MySQL/MariaDB target: $XAMPP_MYSQL_HOST:$XAMPP_MYSQL_PORT as $XAMPP_MYSQL_USER"
echo "Database to create:   $APP_DB_NAME"
echo "App user to create:   $APP_DB_USER"

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for candidate in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}"; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"
if [ -z "$MYSQL_BIN" ]; then
  echo "ERROR: mysql client not found on PATH or at C:\\xampp\\mysql\\bin." >&2
  echo "Add C:\\xampp\\mysql\\bin to PATH, or start XAMPP's MySQL and retry." >&2
  exit 1
fi

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}

step "0. Connectivity check"
if mysql_exec -e "SELECT VERSION();" >/dev/null; then
  pass "Connected to MariaDB at $XAMPP_MYSQL_HOST:$XAMPP_MYSQL_PORT"
else
  fail "Could not connect — is XAMPP's MySQL service running? Check XAMPP_MYSQL_USER/PASSWORD."
  echo; echo "Aborting: nothing else can run without a DB connection."
  exit 1
fi

step "1. Refuse to overwrite an existing database"
EXISTING=$(mysql_exec -N -e "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$APP_DB_NAME';")
if [ -n "$EXISTING" ]; then
  fail "Database '$APP_DB_NAME' already exists — refusing to touch it."
  echo "If you really want a fresh one, drop it yourself first (this script won't):"
  echo "  mysql -u root -e \"DROP DATABASE \\\`$APP_DB_NAME\\\`;\""
  echo "Or bootstrap under a different name: APP_DB_NAME=baranguard_dev bash $0"
  exit 1
fi
pass "'$APP_DB_NAME' does not exist yet — safe to create"

step "2. Create database"
if mysql_exec -e "CREATE DATABASE \`$APP_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"; then
  pass "Created database '$APP_DB_NAME'"
else
  fail "Could not create database '$APP_DB_NAME'"
  exit 1
fi

step "3. Apply migrations 0001..0022 in order"
shopt -s nullglob
MIGRATION_FILES=("$MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql)
APPLIED=0
for f in "${MIGRATION_FILES[@]}"; do
  # Skip .down.sql rollback files — only forward migrations apply here.
  [[ "$f" == *.down.sql ]] && continue
  name="$(basename "$f")"
  if mysql_exec "$APP_DB_NAME" < "$f"; then
    pass "Applied $name"
    APPLIED=$((APPLIED+1))
  else
    fail "Failed applying $name — stopping (later migrations may depend on this one)"
    break
  fi
done
echo "$APPLIED forward migration(s) applied."

step "4. Create least-privileged app user (§8: no CREATE/ALTER/CREATE TABLE)"
mysql_exec -e "DROP USER IF EXISTS '$APP_DB_USER'@'localhost';"
mysql_exec -e "CREATE USER '$APP_DB_USER'@'localhost' IDENTIFIED BY '$APP_DB_PASSWORD';"
if mysql_exec -e "GRANT SELECT, INSERT, UPDATE, DELETE ON \`$APP_DB_NAME\`.* TO '$APP_DB_USER'@'localhost'; FLUSH PRIVILEGES;"; then
  pass "Created '$APP_DB_USER'@'localhost' with SELECT/INSERT/UPDATE/DELETE only on '$APP_DB_NAME'"
else
  fail "Could not grant privileges to '$APP_DB_USER'"
fi

step "5. Sanity check: barangay seed (0002) landed, user table is empty"
BRGY_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM barangay;" "$APP_DB_NAME" 2>/dev/null)
[ "$BRGY_COUNT" = "4" ] && pass "barangay table has 4 rows (Dao/Binanuahan/Marifosque/Banuyo)" || fail "barangay row count = ${BRGY_COUNT:-<error>} (expected 4)"
USER_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM user;" "$APP_DB_NAME" 2>/dev/null)
[ "$USER_COUNT" = "0" ] && pass "user table is empty (bootstrap-admin.js creates your first login next)" || fail "user table has ${USER_COUNT:-<error>} rows (expected 0 on a fresh bootstrap)"

echo
echo "$PASS ok, $FAIL failed."
if [ "$FAIL" -eq 0 ]; then
  echo
  echo "Put these into backend/.env (copy from backend/.env.example first):"
  echo "  DB_HOST=$XAMPP_MYSQL_HOST"
  echo "  DB_PORT=$XAMPP_MYSQL_PORT"
  echo "  DB_NAME=$APP_DB_NAME"
  echo "  DB_USER=$APP_DB_USER"
  echo "  DB_PASSWORD=$APP_DB_PASSWORD"
  echo
  echo "Next: cd backend && npm install && node scripts/bootstrap-admin.js"
else
  exit 1
fi
