#!/usr/bin/env bash
# Apply migrations FROM..TO (inclusive, numeric) to ONE database, stopping at the first error.
# Usage: apply-migrations-range.sh <db> <from> <to>   e.g. baranguard_rehearsal_real 27 45
# Uses XAMPP root (DB_ROOT_PASSWORD env var, blank by default). No backup here: take one first.
set -euo pipefail
db=$1; from=$((10#$2)); to=$((10#$3))
M=/c/xampp/mysql/bin/mysql.exe
dir="$(cd "$(dirname "$0")/../migrations" && pwd)"
args=(-uroot -h127.0.0.1 -P"${DB_PORT:-3306}"); [ -n "${DB_ROOT_PASSWORD:-}" ] && args+=("-p$DB_ROOT_PASSWORD")
for f in "$dir"/[0-9][0-9][0-9][0-9]_*.sql; do
  case $f in *.down.sql) continue;; esac
  n=$((10#$(basename "$f" | cut -c1-4)))
  [ "$n" -ge "$from" ] && [ "$n" -le "$to" ] || continue
  echo "Applying $(basename "$f")"
  "$M" "${args[@]}" "$db" < "$f" || { echo "[FAIL] $(basename "$f")"; exit 1; }
done
echo "[OK] migrations $from..$to applied to $db"
