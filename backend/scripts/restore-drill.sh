#!/usr/bin/env bash
# Baranguard — backup/restore drill (Sprint 7's "Backup/restore drill"
# box: "restore is actually tested, not assumed to work because a backup
# file exists").
#
# WHAT MAKES THIS A DRILL RATHER THAN A BACKUP TEST:
# `scripts/backup.sh` already proves a file can be written and
# `scripts/restore.sh` already proves it can be decrypted and loaded.
# Neither proves the RESTORED DATA IS THE SAME DATA. This script does:
# it captures a per-table content fingerprint of the live database
# BEFORE, restores the backup into a throwaway database, fingerprints
# THAT, and fails loudly if the two disagree. A backup that restores
# cleanly but silently drops rows is exactly the failure a
# "did the file restore?" check cannot see.
#
# NON-DESTRUCTIVE BY CONSTRUCTION. The restore target is always a
# separate `<db>_drill` database, created and dropped by this script. The
# live database is only ever READ. There is no flag to restore over
# production — a real disaster recovery is a deliberate, supervised
# operation with DBA credentials, not something to make one typo away.
#
# On success it records the drill time in `backend/backups/.last-restore-drill`,
# which is what `GET /system/health`'s `restore_test_at` reports and W20
# Service Health displays. Before this script existed that field was
# honestly hardcoded null, because nothing had ever recorded a drill.
#
# Usage (from a Git Bash prompt):
#   BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh
#   BACKUP_ENCRYPTION_PASSPHRASE=... bash backend/scripts/restore-drill.sh --backup-file=path/to/dump.sql.enc
#
# With no --backup-file it takes a FRESH backup first, which is the
# honest default: the question a drill answers is "can I recover from
# the backup I would actually restore today?"

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
BACKUP_DIR="${BACKUP_DIR:-$BACKEND_DIR/backups}"
DRILL_MARKER="$BACKUP_DIR/.last-restore-drill"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }

BACKUP_FILE=""
for arg in "$@"; do
  case "$arg" in
    --backup-file=*) BACKUP_FILE="${arg#--backup-file=}";;
    *) echo "Unknown argument: $arg"; exit 2;;
  esac
done

# Credentials come from backend/.env, but an already-set environment
# variable WINS — the same precedence `config/env.php` documents and
# applies ("never overrides an already-set env var"). Naively sourcing
# .env would invert that, which matters here specifically: a drill needs
# DBA credentials via DRILL_DB_USER, and an explicit DB_NAME/DB_USER has to
# actually take effect rather than being silently overwritten by the
# app's own least-privilege user from .env.
PRESET_DB_HOST="${DB_HOST:-}"
PRESET_DB_PORT="${DB_PORT:-}"
PRESET_DB_NAME="${DB_NAME:-}"
PRESET_DB_USER="${DB_USER:-}"
PRESET_DB_PASSWORD="${DB_PASSWORD-}"
if [ -f "$BACKEND_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$BACKEND_DIR/.env" 2>/dev/null
  set +a
fi
[ -n "$PRESET_DB_HOST" ] && DB_HOST="$PRESET_DB_HOST"
[ -n "$PRESET_DB_PORT" ] && DB_PORT="$PRESET_DB_PORT"
[ -n "$PRESET_DB_NAME" ] && DB_NAME="$PRESET_DB_NAME"
[ -n "$PRESET_DB_USER" ] && DB_USER="$PRESET_DB_USER"
# Deliberately uses ${VAR-} not ${VAR:-}: an explicitly EMPTY password is
# a real, valid choice (XAMPP's stock root has none), and must not fall
# through to .env's value.
if [ -n "$PRESET_DB_USER" ]; then DB_PASSWORD="$PRESET_DB_PASSWORD"; fi

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-baranguard}"
DB_USER="${DB_USER:-root}"
DB_PASSWORD="${DB_PASSWORD:-}"
DRILL_DB="${DB_NAME}_drill"

# TWO SETS OF CREDENTIALS, because a drill genuinely needs two privilege
# levels and conflating them would force an operator to hand root to
# every step:
#
#   DB_*        (from .env) — the application's own least-privilege user.
#                Enough to DUMP the live database and read it. This is
#                the account a real scheduled backup runs as.
#   DRILL_DB_*  — a DBA account, used ONLY to create/drop the throwaway
#                drill database and load the dump into it. `baranguard_app`
#                deliberately has no CREATE DATABASE grant (Sprint 0's
#                DEVLOG records this as a correct least-privilege
#                default), and it must not be given one just to make this
#                script easier to run.
#
# Defaults to XAMPP's stock root/no-password, which is what this
# workstation actually has.
DRILL_DB_USER="${DRILL_DB_USER:-root}"
DRILL_DB_PASSWORD="${DRILL_DB_PASSWORD-}"

if [ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  echo "ERROR: BACKUP_ENCRYPTION_PASSPHRASE is required (backup.sh encrypts with it)."
  exit 1
fi

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }

# DBA connection — creates/drops the drill database and reads both sides
# of the comparison. See the DRILL_DB_* note above for why this is not
# the same account the dump runs as.
mysql_admin() {
  MYSQL_PWD="$DRILL_DB_PASSWORD" "$MYSQL_BIN" --host="$DB_HOST" --port="$DB_PORT" --user="$DRILL_DB_USER" "$@"
}

cleanup() {
  step "Cleanup"
  mysql_admin -e "DROP DATABASE IF EXISTS \`$DRILL_DB\`;" 2>/dev/null
  mysql_admin -e "DROP USER IF EXISTS 'baranguard_drill_usr'@'localhost';" 2>/dev/null
  echo "Dropped the throwaway '$DRILL_DB' database. '$DB_NAME' was only ever read."
}
trap cleanup EXIT

echo "Baranguard restore drill — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Source (read-only): $DB_NAME     Restore target (disposable): $DRILL_DB"

# --------------------------------------------------------------------------
step "1. Take (or select) the backup to drill"
# --------------------------------------------------------------------------
if [ -z "$BACKUP_FILE" ]; then
  echo "No --backup-file given: taking a fresh backup, so the drill tests what you would actually restore today."
  if BACKUP_ENCRYPTION_PASSPHRASE="$BACKUP_ENCRYPTION_PASSPHRASE" bash "$BACKEND_DIR/scripts/backup.sh" >/dev/null 2>&1; then
    pass "Fresh backup taken"
  else
    fail "backup.sh failed — nothing to drill"
    echo; echo "RESULT: drill ABORTED."; exit 1
  fi
  BACKUP_FILE="$(ls -t "$BACKUP_DIR"/*.sql.enc 2>/dev/null | head -1)"
fi

if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  fail "No encrypted backup file found to restore"
  echo; echo "RESULT: drill ABORTED."; exit 1
fi
pass "Backup selected: $(basename "$BACKUP_FILE")"

# A backup whose checksum no longer matches is corrupt on disk — catching
# that here, before the restore, is the whole point of writing one.
if [ -f "${BACKUP_FILE}.sha256" ]; then
  if ( cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256" >/dev/null 2>&1 ); then
    pass "Checksum verifies — the file on disk is intact"
  else
    fail "CHECKSUM MISMATCH — this backup is corrupt and would not restore correctly"
    echo; echo "RESULT: drill FAILED."; exit 1
  fi
else
  fail "No .sha256 companion file — cannot prove the backup is intact"
fi

# --------------------------------------------------------------------------
step "2. Fingerprint the LIVE database (read-only)"
# --------------------------------------------------------------------------
# Per-table row counts, ordered by table name. Not a whole-dump hash: a
# dump embeds a timestamp and its row order isn't guaranteed stable, so
# comparing dumps byte-for-byte would produce false failures. Row counts
# per table catch the failure that actually matters — data missing after
# a restore.
fingerprint() {
  local db="$1"
  local tables
  tables=$(mysql_admin -N -s -e "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$db' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;" 2>/dev/null)
  local t count
  for t in $tables; do
    count=$(mysql_admin -N -s "$db" -e "SELECT COUNT(*) FROM \`$t\`;" 2>/dev/null)
    echo "$t=$count"
  done
}

LIVE_FP="$(fingerprint "$DB_NAME")"
LIVE_TABLES=$(echo "$LIVE_FP" | grep -c . )
if [ "$LIVE_TABLES" -gt 0 ]; then
  pass "Live database fingerprinted ($LIVE_TABLES tables)"
else
  fail "Could not read the live database — is '$DB_NAME' present and are the credentials right?"
  echo; echo "RESULT: drill ABORTED."; exit 1
fi

# --------------------------------------------------------------------------
step "3. Restore into the disposable drill database"
# --------------------------------------------------------------------------
# A drill needs CREATE DATABASE, which the application's own DB user
# deliberately does NOT have — `baranguard_app` is least-privilege by
# design (Sprint 0's DEVLOG records the same finding). That is correct and
# must not be "fixed" by granting the app user more: a drill is a
# supervised operation, so it runs with DBA credentials.
if mysql_admin -e "DROP DATABASE IF EXISTS \`$DRILL_DB\`; CREATE DATABASE \`$DRILL_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null; then
  pass "Created disposable '$DRILL_DB'"
else
  fail "Could not create the drill database as user '$DB_USER'"
  echo
  echo "  Expected if you are using the application's own least-privilege database"
  echo "  user: it has no CREATE DATABASE grant, and should not be given one."
  echo "  Re-run with a DBA account, e.g.:"
  echo
  echo "    DRILL_DB_USER=root DRILL_DB_PASSWORD= BACKUP_ENCRYPTION_PASSPHRASE=... \\"
  echo "      bash backend/scripts/restore-drill.sh"
  echo
  echo "RESULT: drill ABORTED."
  exit 1
fi

# `restore.sh` refuses an empty DB_PASSWORD by design (§11: backups and
# restores are never run with a passwordless account), and XAMPP's stock
# root has none. So the drill mints a throwaway user with a real
# password, scoped to the drill database only, and drops it in cleanup —
# the same pattern every verify-*.sh script in this repo already uses for
# exactly this reason.
DRILL_USER="baranguard_drill_usr"
DRILL_USER_PW="Drill!$(date +%s)Pw"
mysql_admin -e "DROP USER IF EXISTS '$DRILL_USER'@'localhost';
                CREATE USER '$DRILL_USER'@'localhost' IDENTIFIED BY '$DRILL_USER_PW';
                GRANT ALL PRIVILEGES ON \`$DRILL_DB\`.* TO '$DRILL_USER'@'localhost';
                FLUSH PRIVILEGES;" 2>/dev/null \
  && pass "Created a disposable restore user scoped to '$DRILL_DB' only" \
  || fail "Could not create the disposable restore user"

RESTORE_LOG="$(mktemp)"
if DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_USER="$DRILL_USER" DB_PASSWORD="$DRILL_USER_PW" \
   BACKUP_ENCRYPTION_PASSPHRASE="$BACKUP_ENCRYPTION_PASSPHRASE" \
   bash "$BACKEND_DIR/scripts/restore.sh" "$BACKUP_FILE" "$DRILL_DB" > "$RESTORE_LOG" 2>&1; then
  pass "restore.sh completed without error"
else
  fail "restore.sh failed — see output below"
  sed -n '1,40p' "$RESTORE_LOG"
  rm -f "$RESTORE_LOG"
  echo; echo "RESULT: drill FAILED."; exit 1
fi
rm -f "$RESTORE_LOG"

# --------------------------------------------------------------------------
step "4. Compare — the check that makes this a drill"
# --------------------------------------------------------------------------
DRILL_FP="$(fingerprint "$DRILL_DB")"
DRILL_TABLES=$(echo "$DRILL_FP" | grep -c . )

if [ "$LIVE_TABLES" -eq "$DRILL_TABLES" ]; then
  pass "Table count matches ($LIVE_TABLES)"
else
  fail "TABLE COUNT MISMATCH — live $LIVE_TABLES, restored $DRILL_TABLES"
fi

if [ "$LIVE_FP" = "$DRILL_FP" ]; then
  pass "Every table's row count matches the live database exactly"
else
  fail "ROW COUNTS DIFFER between live and restored — the backup does not faithfully reproduce the data"
  echo "--- differences (live vs restored) ---"
  diff <(echo "$LIVE_FP") <(echo "$DRILL_FP") | sed -n '1,30p'
fi

# Spot-check a table whose content is structural, not incidental: the
# four barangay rows are deterministic (§5), so a restore that lost or
# altered them is broken in a way row counts alone might not reveal.
LIVE_BRGY=$(mysql_admin -N -s "$DB_NAME" -e "SELECT GROUP_CONCAT(CONCAT(barangay_id,':',name) ORDER BY barangay_id) FROM barangay;" 2>/dev/null)
DRILL_BRGY=$(mysql_admin -N -s "$DRILL_DB" -e "SELECT GROUP_CONCAT(CONCAT(barangay_id,':',name) ORDER BY barangay_id) FROM barangay;" 2>/dev/null)
if [ -n "$LIVE_BRGY" ] && [ "$LIVE_BRGY" = "$DRILL_BRGY" ]; then
  pass "Barangay rows restored identically ($LIVE_BRGY)"
else
  fail "Barangay rows differ — live '$LIVE_BRGY' vs restored '$DRILL_BRGY'"
fi

# Foreign keys must survive the restore: a dump that loads but drops
# constraints leaves a database that accepts data the real one wouldn't.
LIVE_FKS=$(mysql_admin -N -s -e "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='$DB_NAME' AND REFERENCED_TABLE_NAME IS NOT NULL;" 2>/dev/null)
DRILL_FKS=$(mysql_admin -N -s -e "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='$DRILL_DB' AND REFERENCED_TABLE_NAME IS NOT NULL;" 2>/dev/null)
if [ "$LIVE_FKS" = "$DRILL_FKS" ] && [ -n "$LIVE_FKS" ]; then
  pass "Foreign-key constraints restored ($LIVE_FKS)"
else
  fail "FOREIGN-KEY COUNT MISMATCH — live $LIVE_FKS, restored $DRILL_FKS"
fi

# --------------------------------------------------------------------------
step "5. Record the drill"
# --------------------------------------------------------------------------
if [ "$FAIL" -eq 0 ]; then
  mkdir -p "$BACKUP_DIR"
  {
    echo "drill_completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "backup_file=$(basename "$BACKUP_FILE")"
    echo "tables_verified=$LIVE_TABLES"
    echo "foreign_keys_verified=$LIVE_FKS"
  } > "$DRILL_MARKER"
  pass "Recorded in $(basename "$DRILL_MARKER") — GET /system/health and W20 now report this drill"
else
  # A failed drill must NOT refresh the marker: W20 would then show a
  # recent "last restore drill" for a restore that did not actually work,
  # which is worse than showing an old date or none at all.
  echo "Drill FAILED — deliberately not updating $(basename "$DRILL_MARKER")."
fi

echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
