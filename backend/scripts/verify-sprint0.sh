#!/usr/bin/env bash
# Baranguard — Sprint 0 end-to-end validation against a REAL local XAMPP
# MariaDB instance (not a cloud sandbox). Safe to run: everything happens
# in a disposable database (baranguard_sprint0_check) plus a disposable
# restore-verification database (baranguard_sprint0_check_restore_test).
# Your real `baranguard` database and backend/backups/ are never touched.
#
# Usage (from a Git Bash prompt, repo root or anywhere):
#   bash backend/scripts/verify-sprint0.sh
#
# Uses XAMPP's default root/no-password local admin account so it can
# create/drop the disposable validation databases regardless of what
# privileges your app's `baranguard_app` user has. Override if your XAMPP
# root account has a password:
#   XAMPP_MYSQL_USER=root XAMPP_MYSQL_PASSWORD=yourpass bash backend/scripts/verify-sprint0.sh
#
# Writes a timestamped log next to this script so results can be reviewed
# afterward (including by Claude, via the device bridge) without needing
# to paste terminal output back manually.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
LOG_FILE="$BACKEND_DIR/scripts/sprint0-validation-$(date -u +%Y%m%dT%H%M%SZ).log"

exec > >(tee "$LOG_FILE") 2>&1

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_sprint0_check"
RESTOREDB="${VALDB}_restore_test"

echo "Baranguard Sprint 0 validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Target: $XAMPP_MYSQL_HOST:$XAMPP_MYSQL_PORT as $XAMPP_MYSQL_USER"

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for candidate in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}"; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"
MYSQLDUMP_BIN="$(find_bin mysqldump)"

if [ -z "$MYSQL_BIN" ]; then
  echo "ERROR: mysql client not found on PATH or at C:\\xampp\\mysql\\bin." >&2
  echo "Add C:\\xampp\\mysql\\bin to PATH, or edit MYSQL_BIN near the top of this script." >&2
  exit 1
fi
echo "Using mysql:     $MYSQL_BIN"
echo "Using mysqldump: ${MYSQLDUMP_BIN:-<not found — backup step will likely fail>}"

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}

step "0. Connectivity check"
if mysql_exec -e "SELECT VERSION();"; then
  pass "Connected to MariaDB at $XAMPP_MYSQL_HOST:$XAMPP_MYSQL_PORT"
else
  fail "Could not connect — is XAMPP's MySQL service running? Check XAMPP_MYSQL_USER/PASSWORD."
  echo "Aborting: nothing else can run without a DB connection."
  echo; echo "$PASS passed, $FAIL failed."; echo "Full log: $LOG_FILE"
  exit 1
fi

step "1. Empty-DB apply (0001_baseline_schema.sql)"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
if mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql"; then
  pass "0001_baseline_schema.sql applied with 0 errors"
else
  fail "0001_baseline_schema.sql did not apply cleanly"
fi

TABLE_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$VALDB';")
[ "$TABLE_COUNT" = "24" ] && pass "Table count = 24" || fail "Table count = $TABLE_COUNT (expected 24)"

FK_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='$VALDB' AND REFERENCED_TABLE_NAME IS NOT NULL;")
[ "$FK_COUNT" = "57" ] && pass "Foreign key count = 57" || fail "Foreign key count = $FK_COUNT (expected 57)"

step "2. Rollback / reapply (0001_baseline_schema.down.sql)"
if mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.down.sql"; then
  pass "down.sql ran with 0 errors"
else
  fail "down.sql did not run cleanly"
fi
TABLE_COUNT_AFTER_DROP=$(mysql_exec -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$VALDB';")
[ "$TABLE_COUNT_AFTER_DROP" = "0" ] && pass "All tables dropped (0 remain)" || fail "$TABLE_COUNT_AFTER_DROP tables remain after down.sql"

if mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0001_baseline_schema.sql"; then
  pass "0001_baseline_schema.sql re-applied with 0 errors"
else
  fail "Reapply of 0001_baseline_schema.sql failed"
fi
TABLE_COUNT_REAPPLY=$(mysql_exec -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$VALDB';")
[ "$TABLE_COUNT_REAPPLY" = "24" ] && pass "Table count after reapply = 24" || fail "Table count after reapply = $TABLE_COUNT_REAPPLY"

step "3. Seed idempotency (0002_seed_barangays.sql)"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0002_seed_barangays.sql"
BRGY_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM barangay;" "$VALDB")
[ "$BRGY_COUNT" = "4" ] && pass "barangay row count stayed at 4 after seeding twice" || fail "barangay row count = $BRGY_COUNT (expected 4)"
USER_COUNT_BEFORE=$(mysql_exec -N -e "SELECT COUNT(*) FROM user;" "$VALDB")
[ "$USER_COUNT_BEFORE" = "0" ] && pass "user table remains empty after seeding" || fail "user table has $USER_COUNT_BEFORE rows after seeding (expected 0)"

step "3.5 Create a disposable app-user (bootstrap/backup scripts reject an empty DB_PASSWORD by design)"
APP_TEST_USER="sprint0_check_app"
APP_TEST_PASSWORD="Sprint0CheckDbPw!"
mysql_exec -e "DROP USER IF EXISTS '$APP_TEST_USER'@'localhost';"
mysql_exec -e "CREATE USER '$APP_TEST_USER'@'localhost' IDENTIFIED BY '$APP_TEST_PASSWORD';"
mysql_exec -e "GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_TEST_USER'@'localhost';"
mysql_exec -e "GRANT ALL PRIVILEGES ON \`$RESTOREDB\`.* TO '$APP_TEST_USER'@'localhost';"
mysql_exec -e "FLUSH PRIVILEGES;"
pass "Created disposable app-user '$APP_TEST_USER' scoped to the two validation databases"

step "4. Bootstrap CLI — happy path, one-time guard, no password leakage"
export DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_USER="$APP_TEST_USER" DB_PASSWORD="$APP_TEST_PASSWORD" DB_NAME="$VALDB"
TEST_PW='Sprint0Check#2026'

printf '1\nsprint0check\nSprint Zero Check\n\n%s\n%s\n' "$TEST_PW" "$TEST_PW" | node "$BACKEND_DIR/scripts/bootstrap-admin.js"
ADMIN_ROW=$(mysql_exec -N -e "SELECT CONCAT(role, ':', is_active, ':', (password_hash LIKE '\$argon2id\$%')) FROM user WHERE username='sprint0check';" "$VALDB")
echo "Bootstrap row: $ADMIN_ROW"
case "$ADMIN_ROW" in
  admin:1:1) pass "Bootstrap created admin row (role=admin, active, argon2id hash)" ;;
  *) fail "Bootstrap row missing or malformed: '$ADMIN_ROW'" ;;
esac
AUDIT_ROW=$(mysql_exec -N -e "SELECT COUNT(*) FROM audit_log WHERE action='bootstrap_first_admin';" "$VALDB")
[ "$AUDIT_ROW" = "1" ] && pass "bootstrap_first_admin audit_log row recorded" || fail "audit_log row count = $AUDIT_ROW (expected 1)"

GUARD_OUT="$(mktemp)"
echo "1" | node "$BACKEND_DIR/scripts/bootstrap-admin.js" >"$GUARD_OUT" 2>&1
GUARD_EXIT=$?
if [ "$GUARD_EXIT" -ne 0 ] && grep -qi "already has an active Admin" "$GUARD_OUT"; then
  pass "One-time guard refused a second bootstrap for the same barangay"
else
  fail "One-time guard did not refuse re-bootstrap as expected (exit=$GUARD_EXIT) — see $GUARD_OUT"
fi

if grep -rq "$TEST_PW" "$BACKEND_DIR" --exclude-dir=node_modules --exclude-dir=backups --exclude="verify-sprint0.sh" --exclude="*.log" 2>/dev/null; then
  fail "Test password found in source tree under backend/ — investigate immediately"
else
  pass "No plaintext test password found anywhere under backend/"
fi

step "5. Backup / restore drill"
VAL_BACKUP_DIR="$BACKEND_DIR/backups/sprint0-check"
mkdir -p "$VAL_BACKUP_DIR"
export BACKUP_DIR="$VAL_BACKUP_DIR" BACKUP_ENCRYPTION_PASSPHRASE="sprint0-check-passphrase"
bash "$BACKEND_DIR/scripts/backup.sh"
LATEST_ENC=$(ls -t "$VAL_BACKUP_DIR"/*.sql.enc 2>/dev/null | head -1)
if [ -n "$LATEST_ENC" ] && [ -f "${LATEST_ENC}.sha256" ]; then
  pass "backup.sh produced an encrypted dump + checksum ($(basename "$LATEST_ENC"))"
else
  fail "backup.sh did not produce the expected .sql.enc/.sha256 pair"
fi
LEFTOVER_PLAINTEXT=$(find "$VAL_BACKUP_DIR" -maxdepth 1 -name "*.sql" 2>/dev/null | wc -l | tr -d ' ')
[ "$LEFTOVER_PLAINTEXT" = "0" ] && pass "No plaintext .sql dump left on disk after backup" || fail "$LEFTOVER_PLAINTEXT plaintext .sql file(s) left on disk"

mysql_exec -e "DROP DATABASE IF EXISTS \`$RESTOREDB\`;"
if [ -n "$LATEST_ENC" ]; then
  bash "$BACKEND_DIR/scripts/restore.sh" "$LATEST_ENC" "$RESTOREDB"
  RESTORE_TABLE_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$RESTOREDB';")
  [ "$RESTORE_TABLE_COUNT" = "24" ] && pass "Restore recreated 24 tables in $RESTOREDB" || fail "Restored DB has $RESTORE_TABLE_COUNT tables (expected 24)"
  RESTORE_BRGY_COUNT=$(mysql_exec -N -e "SELECT COUNT(*) FROM barangay;" "$RESTOREDB")
  [ "$RESTORE_BRGY_COUNT" = "4" ] && pass "Restored barangay row count = 4" || fail "Restored barangay row count = $RESTORE_BRGY_COUNT"
else
  fail "Skipped restore drill — no backup file was produced"
fi

step "Cleanup"
mysql_exec -e "DROP DATABASE IF EXISTS \`$RESTOREDB\`;"
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;"
mysql_exec -e "DROP USER IF EXISTS '$APP_TEST_USER'@'localhost';" 2>/dev/null || true
rm -rf "$VAL_BACKUP_DIR"
echo "Dropped $VALDB / $RESTOREDB / user '$APP_TEST_USER' and removed $VAL_BACKUP_DIR."
echo "Your real 'baranguard' database (if any) and backend/backups/ were never touched."

step "SUMMARY"
echo "$PASS passed, $FAIL failed."
echo "Full log: $LOG_FILE"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
