#!/usr/bin/env bash
# Baranguard — local backup baseline (Master Reference §11: "daily local
# database backup with encrypted storage, documented backup retention,
# periodic restore verification").
#
# This is the recovery baseline for Sprint 0. It is NOT the final
# production schedule — the final backup schedule/retention number must
# still be recorded in the deployment runbook before UAT (§11).
#
# Usage: DB_PASSWORD=... ./scripts/backup.sh
# Reads DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD from the environment
# (source .env first, or export them) — never hardcoded here.
#
# Backup retention note (§11 Rule 11): a backup is a recovery copy, not an
# independent archive. Its expiration follows the retention of the source
# data it contains. BACKUP_RETENTION_DAYS below is a local pruning
# convenience only — it does not override legal hold or the per-record
# retention rules in §11's table, which the retention job (implemented in
# a later sprint) is responsible for enforcing at the row level.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/../backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

: "${DB_HOST:?DB_HOST is required}"
: "${DB_PORT:=3306}"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required (backups must be encrypted at rest per §11)}"

mkdir -p "$BACKUP_DIR"

RAW_DUMP="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql"
ENCRYPTED_DUMP="${RAW_DUMP}.enc"
CHECKSUM_FILE="${ENCRYPTED_DUMP}.sha256"

echo "[backup] Dumping ${DB_NAME} from ${DB_HOST}:${DB_PORT} ..."
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --routines \
  --triggers \
  --hex-blob \
  "$DB_NAME" > "$RAW_DUMP"

echo "[backup] Encrypting dump (AES-256-CBC) ..."
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in "$RAW_DUMP" \
  -out "$ENCRYPTED_DUMP" \
  -pass "pass:${BACKUP_ENCRYPTION_PASSPHRASE}"

# Raw plaintext dump never remains on disk.
shred -u "$RAW_DUMP" 2>/dev/null || rm -f "$RAW_DUMP"

sha256sum "$ENCRYPTED_DUMP" > "$CHECKSUM_FILE"

echo "[backup] Wrote $ENCRYPTED_DUMP"
echo "[backup] Checksum: $(cat "$CHECKSUM_FILE")"

echo "[backup] Pruning backups older than ${BACKUP_RETENTION_DAYS} days ..."
find "$BACKUP_DIR" -maxdepth 1 -name "${DB_NAME}_*.sql.enc" -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true
find "$BACKUP_DIR" -maxdepth 1 -name "${DB_NAME}_*.sql.enc.sha256" -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true

echo "[backup] Done."
