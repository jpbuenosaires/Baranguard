#!/usr/bin/env bash
# Baranguard — restore verification companion to backup.sh (§11: "periodic
# restore verification" is a required pre-UAT exit condition, not optional).
#
# Usage: DB_PASSWORD=... BACKUP_ENCRYPTION_PASSPHRASE=... \
#        ./scripts/restore.sh /path/to/backup.sql.enc [target_db_name]
#
# By default restores into a *separate* verification database
# (<DB_NAME>_restore_test) rather than overwriting the live database, so a
# routine restore drill can never destroy production data by accident.
# Pass an explicit target_db_name to restore elsewhere (e.g. disaster
# recovery onto the real database name).

set -euo pipefail

ENCRYPTED_DUMP="${1:?Usage: restore.sh <encrypted_dump_path> [target_db_name]}"
CHECKSUM_FILE="${ENCRYPTED_DUMP}.sha256"

: "${DB_HOST:?DB_HOST is required}"
: "${DB_PORT:=3306}"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"

TARGET_DB="${2:-${DB_NAME}_restore_test}"

if [ ! -f "$ENCRYPTED_DUMP" ]; then
  echo "[restore] ERROR: backup file not found: $ENCRYPTED_DUMP" >&2
  exit 1
fi

if [ -f "$CHECKSUM_FILE" ]; then
  echo "[restore] Verifying checksum ..."
  (cd "$(dirname "$ENCRYPTED_DUMP")" && sha256sum -c "$(basename "$CHECKSUM_FILE")")
else
  echo "[restore] WARNING: no checksum file found alongside backup; skipping integrity check." >&2
fi

TMP_DECRYPTED="$(mktemp)"
trap 'shred -u "$TMP_DECRYPTED" 2>/dev/null || rm -f "$TMP_DECRYPTED"' EXIT

echo "[restore] Decrypting ..."
openssl enc -d -aes-256-cbc -pbkdf2 \
  -in "$ENCRYPTED_DUMP" \
  -out "$TMP_DECRYPTED" \
  -pass "pass:${BACKUP_ENCRYPTION_PASSPHRASE}"

echo "[restore] Creating/verifying target database: $TARGET_DB"
MYSQL_PWD="$DB_PASSWORD" mysql \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
  -e "CREATE DATABASE IF NOT EXISTS \`${TARGET_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo "[restore] Restoring into $TARGET_DB ..."
MYSQL_PWD="$DB_PASSWORD" mysql \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
  "$TARGET_DB" < "$TMP_DECRYPTED"

echo "[restore] Verifying table count ..."
TABLE_COUNT=$(MYSQL_PWD="$DB_PASSWORD" mysql --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" -N -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TARGET_DB}';")
echo "[restore] Restored database has ${TABLE_COUNT} tables."

echo "[restore] Done. Verification database: $TARGET_DB (drop it manually once you're satisfied)."
