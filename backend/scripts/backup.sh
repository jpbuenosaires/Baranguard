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
# data it contains. BACKUP_RETENTION_DAYS is age-based pruning, but the
# pruning step below additionally checks for an active legal_hold before
# deleting any backup file — retention-job.php/RetentionService.php only
# purge DB rows, by deliberate design (see RetentionService's own
# docblock), so this script is where backup-file-level legal hold has to
# be enforced.

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

# §11 Rule 11 / docs/REMAINING.md C1: age-based pruning alone can delete a
# backup that still holds a legal-held record — RetentionService.php's own
# docblock says this is deliberately NOT its job (it only purges DB rows).
# Each backup is a single full-DB dump named
# ${DB_NAME}_<TIMESTAMP>.sql.enc, so the fix is file-level: compute the
# earliest created_at/uploaded_at among rows CURRENTLY under legal_hold
# across every table that carries the column (incident, citizen_report,
# evidence_attachment). Any backup timestamped on/after that floor could
# contain the held record and must survive pruning regardless of age;
# anything strictly older than the floor predates the record and prunes
# normally.
set +e
HOLD_FLOOR="$(MYSQL_PWD="$DB_PASSWORD" mysql \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" -N -B "$DB_NAME" -e "
    SELECT MIN(created_at) FROM (
      SELECT created_at FROM incident WHERE legal_hold = 1
      UNION ALL SELECT created_at FROM citizen_report WHERE legal_hold = 1
      UNION ALL SELECT uploaded_at AS created_at FROM evidence_attachment WHERE legal_hold = 1
    ) AS held;
  " 2>&1)"
HOLD_QUERY_STATUS=$?
set -e

if [ "$HOLD_QUERY_STATUS" -ne 0 ]; then
  # Fail CLOSED, not open: if we can't determine hold status, we do not
  # know it's safe to delete anything, so nothing gets pruned this run
  # rather than risking a held record's only remaining backup.
  echo "[backup] WARNING: could not check legal_hold status (${HOLD_FLOOR}). Skipping pruning this run." >&2
  echo "[backup] Done."
  exit 0
fi
if [ -z "${HOLD_FLOOR:-}" ] || [ "$HOLD_FLOOR" = "NULL" ]; then
  HOLD_FLOOR_EPOCH=""
else
  echo "[backup] Legal hold active — backups from ${HOLD_FLOOR} UTC onward will not be pruned regardless of age."
  HOLD_FLOOR_EPOCH="$(date -u -d "$HOLD_FLOOR" +%s)"
fi

CUTOFF_EPOCH="$(date -u -d "-${BACKUP_RETENTION_DAYS} days" +%s)"

for f in "$BACKUP_DIR/${DB_NAME}_"*.sql.enc; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  ts="${base#${DB_NAME}_}"
  ts="${ts%.sql.enc}"
  # TIMESTAMP format is %Y%m%dT%H%M%SZ (see TIMESTAMP= above).
  file_epoch="$(date -u -d "${ts:0:4}-${ts:4:2}-${ts:6:2} ${ts:9:2}:${ts:11:2}:${ts:13:2}" +%s 2>/dev/null || echo "")"
  if [ -z "$file_epoch" ]; then
    echo "[backup] Skipping $base — could not parse its timestamp, leaving it in place."
    continue
  fi
  if [ "$file_epoch" -ge "$CUTOFF_EPOCH" ]; then
    continue # Not old enough yet.
  fi
  if [ -n "$HOLD_FLOOR_EPOCH" ] && [ "$file_epoch" -ge "$HOLD_FLOOR_EPOCH" ]; then
    echo "[backup] Retaining $base — may contain data under an active legal hold (>= ${HOLD_FLOOR} UTC)."
    continue
  fi
  echo "[backup] Deleting $base"
  rm -f "$f" "${f}.sha256"
done

echo "[backup] Done."
