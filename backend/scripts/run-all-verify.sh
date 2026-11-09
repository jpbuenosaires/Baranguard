#!/usr/bin/env bash
# Baranguard — runs every backend verify suite one after another and prints
# one table of passed/failed checks per suite plus the total, so the counts
# come from one command instead of 40 runs added up by hand.
#
# Each suite already builds and drops its own disposable database, so the
# suites run sequentially (two at once would fight over MariaDB and ports).
# A "check" is one [PASS] or [FAIL] line a suite prints. A suite that exits
# non-zero without printing a [FAIL] line is reported as ERROR (it crashed
# before finishing), never as a pass.
#
# Usage (Git Bash, from anywhere):
#   bash backend/scripts/run-all-verify.sh                # every suite
#   bash backend/scripts/run-all-verify.sh --only routing  # suites whose name contains "routing"
#   bash backend/scripts/run-all-verify.sh --live          # also the 3 checks that need the
#        running demo backend on :8081 (json-contracts, auth-lockout-revocation, routing-fallback)
#
# Output: a table on screen, plus backend/storage/verify-runs/<UTC stamp>/
# with one log per suite, summary.json and summary.md (storage/ is gitignored).

set -uo pipefail
# Suites must never drive a real gateway phone: an empty value beats GSM_GATEWAY_ENABLED=true in backend/.env
# (config/env.php never overrides a variable that is already set). Suites that need it on set it themselves.
export GSM_GATEWAY_ENABLED=''

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="$REPO_ROOT/backend/scripts"
ONLY=""
LIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --live) LIVE=1; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

PHP_BIN=""
for c in /c/xampp/php/php.exe /c/xampp/php/php; do [ -x "$c" ] && { PHP_BIN="$c"; break; }; done
[ -z "$PHP_BIN" ] && PHP_BIN="$(command -v php || true)"
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }
to_native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$REPO_ROOT/backend/storage/verify-runs/$STAMP"
mkdir -p "$OUT"

# name|command (bash or php). Static and disposable-DB suites always run.
SUITES=("verify-route-coverage.php|php")
for f in "$SCRIPTS"/verify-*.sh; do SUITES+=("$(basename "$f")|bash"); done
if [ "$LIVE" = "1" ]; then
  SUITES+=("verify-json-contracts.php|php" "verify-auth-lockout-revocation.php|php" "verify-routing-fallback.php|php")
fi

ROWS=()
TOTAL_P=0; TOTAL_F=0; BAD=0; RUN=0
printf '\n%-46s %8s %8s %8s  %s\n' "Suite" "Passed" "Failed" "Seconds" "Status"
printf '%s\n' "------------------------------------------------------------------------------------------"
for entry in "${SUITES[@]}"; do
  name="${entry%%|*}"; kind="${entry##*|}"
  [ -n "$ONLY" ] && [[ "$name" != *"$ONLY"* ]] && continue
  log="$OUT/${name%.*}.log"
  start=$(date +%s)
  if [ "$kind" = "php" ]; then
    extra=(); [ "$name" = "verify-route-coverage.php" ] && extra=(--list)
    "$PHP_BIN" "$(to_native "$SCRIPTS/$name")" "${extra[@]}" >"$log" 2>&1; code=$?
  else
    bash "$SCRIPTS/$name" >"$log" 2>&1; code=$?
  fi
  secs=$(( $(date +%s) - start ))
  p=$(grep -c '^\[PASS\]' "$log"); f=$(grep -c '^\[FAIL\]' "$log")
  if [ "$f" -gt 0 ]; then status="FAILED"; BAD=1
  elif [ "$code" -ne 0 ]; then status="ERROR (exit $code)"; BAD=1
  elif [ "$p" -eq 0 ]; then status="ERROR (no checks)"; BAD=1
  else status="ok"; fi
  TOTAL_P=$((TOTAL_P + p)); TOTAL_F=$((TOTAL_F + f)); RUN=$((RUN + 1))
  printf '%-46s %8d %8d %8d  %s\n' "$name" "$p" "$f" "$secs" "$status"
  ROWS+=("{\"suite\":\"$name\",\"passed\":$p,\"failed\":$f,\"exit_code\":$code,\"seconds\":$secs,\"status\":\"$status\"}")
done
printf '%s\n' "------------------------------------------------------------------------------------------"
printf '%-46s %8d %8d\n\n' "TOTAL ($RUN suites)" "$TOTAL_P" "$TOTAL_F"

{
  printf '{"run_utc":"%s","suites_run":%d,"passed":%d,"failed":%d,"live":%s,"suites":[' "$STAMP" "$RUN" "$TOTAL_P" "$TOTAL_F" "$([ "$LIVE" = 1 ] && echo true || echo false)"
  (IFS=,; printf '%s' "${ROWS[*]}")
  printf ']}\n'
} > "$OUT/summary.json"
{
  echo "# Verify run $STAMP"
  echo
  echo "| Suite | Passed | Failed | Status |"
  echo "|---|---:|---:|---|"
  for row in "${ROWS[@]}"; do
    "$PHP_BIN" -r '$r=json_decode($argv[1],true); printf("| %s | %d | %d | %s |\n",$r["suite"],$r["passed"],$r["failed"],$r["status"]);' "$row"
  done
  echo "| **Total ($RUN suites)** | **$TOTAL_P** | **$TOTAL_F** | |"
} > "$OUT/summary.md"
echo "Logs and summary: backend/storage/verify-runs/$STAMP/"
[ "$BAD" -eq 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED OR ERRORED — open the logs above"
exit "$BAD"
