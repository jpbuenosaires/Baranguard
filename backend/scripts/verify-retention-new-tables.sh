#!/usr/bin/env bash
# Baranguard — Wave 3 / Agent H validation: placeholder retention rules for
# the tables added by migrations 0030-0033 (+ document_scan, 0037).
#
# Review decision 10: retention for these tables is NOT yet decided by the
# barangay/COA, so the rules ship with NO duration (null / status
# `pending_barangay_confirmation`) and are no-ops. The purge code is written
# but unreachable in production. This suite proves, on a disposable DB:
#
#   A. with the SHIPPED constants, a full non-dry-run run deletes NOTHING
#      (row counts of every table, and the scan files on disk, before/after),
#      writes no audit row, and --list shows each rule as pending;
#   B. with the TEST-ONLY constructor seam given a duration, the purge
#      removes only EXPIRED rows, never an accomplishment report that is not
#      `approved`, never rows newer than the cutoff, respects legal hold,
#      removes the scans (rows + files) of a purged report only, and its
#      audit metadata is counts only;
#   C. the seam rejects bad values, and nothing outside the suite reaches it
#      (env var / production caller).
#
# Safe to run: disposable database, disposable app-user. The real databases
# and backend/.env are never touched. No HTTP server is started.
#
# Usage (Git Bash): bash backend/scripts/verify-retention-new-tables.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "=== $1 ==="; }
expect_eq() { if [ "$1" = "$2" ]; then pass "$3 ($2)"; else fail "$3 — expected '$2', got '$1'"; fi; }
expect_contains() { case "$1" in *"$2"*) pass "$3";; *) fail "$3 — '$2' not in: $1";; esac; }

XAMPP_MYSQL_HOST="${XAMPP_MYSQL_HOST:-127.0.0.1}"
ENV_DB_PORT="$(grep -m1 '^DB_PORT=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')"
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-${ENV_DB_PORT:-3306}}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="${RETNEW_VALDB:-baranguard_retnew_check}"
APP_USER="${RETNEW_APP_USER:-retnew_app}"
APP_PASSWORD="RetNew!Chk2026"

echo "Baranguard retention (new tables) validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"; PHP_BIN="$(find_bin php)"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
db_one() {
  local out
  out="$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null)"
  if [ -z "$out" ]; then out="$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null)"; fi
  echo "$out"
}

# Native (Windows-style) path for php.exe; harmless on Linux.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

SCANS_DIR_POSIX="$BACKEND_DIR/scripts/.retnew-scans"
SCANS_DIR_NATIVE="$(native_path "$SCANS_DIR_POSIX")"
ESCAPE_FILE="$BACKEND_DIR/scripts/.retnew-escape-sentinel.txt"

cleanup() {
  step "Cleanup"
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -rf "$SCANS_DIR_POSIX"
  rm -f "$ESCAPE_FILE"
  echo "Dropped $VALDB / user '$APP_USER'. The real databases were never touched."
}
trap cleanup EXIT

php_run() {
  # Runs a backend CLI script against the disposable DB. Credentials come from
  # the environment (config/env.php honours it ahead of .env).
  ( cd "$BACKEND_DIR" && \
    DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
    DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" \
    EVIDENCE_DIR="$BACKEND_DIR/scripts/.retnew-evidence" \
    SCANS_DIR="$SCANS_DIR_NATIVE" \
    "$PHP_BIN" "$@" 2>&1 )
}
# Pull a dotted path out of a JSON document read from stdin.
jget() {
  "$PHP_BIN" -r '$d=json_decode(stream_get_contents(STDIN), true); $v=$d; foreach (explode(".", $argv[1]) as $k) { if (!is_array($v) || !array_key_exists($k, $v)) { echo "MISSING"; exit; } $v=$v[$k]; } echo is_bool($v) ? ($v ? "true" : "false") : (is_array($v) ? json_encode($v) : $v);' "$1"
}

# --------------------------------------------------------------------------
step "0. Disposable DB + full migration chain"
# --------------------------------------------------------------------------
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
MIG_FAILED=0
for m in $(cd "$BACKEND_DIR/migrations" && ls [0-9]*.sql | grep -v '\.down\.sql$' | sed 's/\.sql$//' | sort | awk -v s=0001_baseline_schema '$0 >= s'); do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || { fail "migration $m failed"; MIG_FAILED=1; }
done
[ "$MIG_FAILED" -eq 0 ] && pass "Full migration chain applied (all migrations/*.sql, globbed)"
for t in tanod_availability accomplishment_report accomplishment_entry school_checkin incident_referral document_scan; do
  N=$(db_one "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='$t';")
  expect_eq "$N" "1" "table $t exists in the chain"
done
mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH="$("$PHP_BIN" -r "echo password_hash('x-retnew-Pw1', PASSWORD_ARGON2ID);")"
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'rn_admin','$HASH','RN Admin','admin',1,UTC_TIMESTAMP()),
 (1,'rn_tanod','$HASH','RN Tanod','tanod',1,UTC_TIMESTAMP());
SQL
ADMIN_ID=$(db_one "SELECT user_id FROM user WHERE username='rn_admin';")
TANOD_ID=$(db_one "SELECT user_id FROM user WHERE username='rn_tanod';")

# --------------------------------------------------------------------------
step "1. Seed expired + fresh rows in every new table (and scan files)"
# --------------------------------------------------------------------------
mkdir -p "$SCANS_DIR_POSIX"
for f in scan-r1-a.pdf scan-r1-b.png scan-r2.pdf scan-r3.pdf scan-ssz.pdf; do echo "scan bytes $f" > "$SCANS_DIR_POSIX/$f"; done
echo "must survive: outside SCANS_DIR" > "$ESCAPE_FILE"

mysql_exec "$VALDB" <<SQL
-- tanod_availability: 60d-expired (cited by a shift), 29d-old (inside a 30d window), future period.
INSERT INTO tanod_availability (barangay_id, user_id, period_start, period_end, windows_json, status, version, client_event_id, created_at) VALUES
 (1, $TANOD_ID, DATE_SUB(UTC_DATE(), INTERVAL 67 DAY), DATE_SUB(UTC_DATE(), INTERVAL 60 DAY), '[]', 'accepted', 1, UUID(), UTC_TIMESTAMP()),
 (1, $TANOD_ID, DATE_SUB(UTC_DATE(), INTERVAL 36 DAY), DATE_SUB(UTC_DATE(), INTERVAL 29 DAY), '[]', 'accepted', 1, UUID(), UTC_TIMESTAMP()),
 (1, $TANOD_ID, DATE_ADD(UTC_DATE(), INTERVAL 1 DAY),  DATE_ADD(UTC_DATE(), INTERVAL 8 DAY),  '[]', 'submitted', 1, UUID(), UTC_TIMESTAMP());
SQL
AV_OLD=$(db_one "SELECT avail_id FROM tanod_availability WHERE period_end = DATE_SUB(UTC_DATE(), INTERVAL 60 DAY);")
mysql_exec "$VALDB" <<SQL
INSERT INTO shift_schedule (barangay_id, user_id, start_at, end_at, created_by, source_availability_id)
 VALUES (1, $TANOD_ID, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY), $ADMIN_ID, $AV_OLD);

-- accomplishment_report: statuses x ages. months are unique per tanod.
INSERT INTO accomplishment_report (barangay_id, user_id, month, status, noted_by, noted_at, approved_by, approved_at, created_at) VALUES
 (1, $TANOD_ID, '2025-01', 'approved', $ADMIN_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 61 DAY), $ADMIN_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)),
 (1, $TANOD_ID, '2025-02', 'approved', $ADMIN_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 DAY), $ADMIN_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 DAY)),
 (1, $TANOD_ID, '2025-03', 'noted',    $ADMIN_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY), NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 DAY)),
 (1, $TANOD_ID, '2025-04', 'prepared', NULL, NULL, NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 DAY)),
 (1, $TANOD_ID, '2025-05', 'returned', NULL, NULL, $ADMIN_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 DAY)),
 (1, $TANOD_ID, '2025-06', 'open',     NULL, NULL, NULL, NULL, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 DAY));
SQL
R1=$(db_one "SELECT report_id FROM accomplishment_report WHERE month='2025-01';")
R2=$(db_one "SELECT report_id FROM accomplishment_report WHERE month='2025-02';")
R3=$(db_one "SELECT report_id FROM accomplishment_report WHERE month='2025-03';")
mysql_exec "$VALDB" <<SQL
INSERT INTO accomplishment_entry (report_id, barangay_id, user_id, work_date, accomplishment_text, duration_minutes, client_event_id, created_at) VALUES
 ($R1, 1, $TANOD_ID, DATE_SUB(UTC_DATE(), INTERVAL 80 DAY), 'patrol A', 120, UUID(), UTC_TIMESTAMP()),
 ($R1, 1, $TANOD_ID, DATE_SUB(UTC_DATE(), INTERVAL 79 DAY), 'patrol B', 120, UUID(), UTC_TIMESTAMP()),
 ($R2, 1, $TANOD_ID, DATE_SUB(UTC_DATE(), INTERVAL 20 DAY), 'patrol C', 120, UUID(), UTC_TIMESTAMP()),
 ($R3, 1, $TANOD_ID, DATE_SUB(UTC_DATE(), INTERVAL 110 DAY), 'patrol D', 120, UUID(), UTC_TIMESTAMP());

-- document_scan: two on R1 (expired parent), one on R2 (fresh), one on R3 (noted),
-- one on an ssz_term_report whose id equals R1 (entity_type must isolate it),
-- and one R1 row whose stored_path tries to climb out of SCANS_DIR.
INSERT INTO document_scan (barangay_id, entity_type, entity_id, stored_path, mime_type, size_bytes, sha256, uploaded_by, uploaded_at) VALUES
 (1, 'accomplishment_report', $R1, 'scan-r1-a.pdf', 'application/pdf', 20, REPEAT('1',64), $ADMIN_ID, UTC_TIMESTAMP()),
 (1, 'accomplishment_report', $R1, 'scan-r1-b.png', 'image/png',      20, REPEAT('2',64), $ADMIN_ID, UTC_TIMESTAMP()),
 (1, 'accomplishment_report', $R1, '../.retnew-escape-sentinel.txt', 'application/pdf', 20, REPEAT('6',64), $ADMIN_ID, UTC_TIMESTAMP()),
 (1, 'accomplishment_report', $R2, 'scan-r2.pdf',   'application/pdf', 20, REPEAT('3',64), $ADMIN_ID, UTC_TIMESTAMP()),
 (1, 'accomplishment_report', $R3, 'scan-r3.pdf',   'application/pdf', 20, REPEAT('4',64), $ADMIN_ID, UTC_TIMESTAMP()),
 (1, 'ssz_term_report',       $R1, 'scan-ssz.pdf',  'application/pdf', 20, REPEAT('5',64), $ADMIN_ID, UTC_TIMESTAMP());

-- school + school_checkin: 60d, 29d, and a recent still-open check-in.
INSERT INTO school (barangay_id, name, school_type, level, address, created_by, created_at, updated_at)
 VALUES (1, 'RN Elementary', 'public', 'primary_elementary', 'Purok 1', $ADMIN_ID, UTC_TIMESTAMP(), UTC_TIMESTAMP());
SET @sch = LAST_INSERT_ID();
INSERT INTO school_checkin (school_id, barangay_id, user_id, checked_in_at, checked_out_at, client_event_id, created_at) VALUES
 (@sch, 1, $TANOD_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY), UUID(), UTC_TIMESTAMP()),
 (@sch, 1, $TANOD_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 59 DAY), NULL, UUID(), UTC_TIMESTAMP()),
 (@sch, 1, $TANOD_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 29 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 29 DAY), UUID(), UTC_TIMESTAMP()),
 (@sch, 1, $TANOD_ID, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), NULL, UUID(), UTC_TIMESTAMP());

-- incident_referral: one plain incident (60d + 10d referrals) and one on legal hold (60d referral).
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, created_at, updated_at, legal_hold) VALUES
 (1, $TANOD_ID, 'theft', 'normal', 'n', 'pending', 'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY), UTC_TIMESTAMP(), 0);
SET @inc_plain = LAST_INSERT_ID();
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, created_at, updated_at, legal_hold) VALUES
 (1, $TANOD_ID, 'theft', 'normal', 'n', 'pending', 'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY), UTC_TIMESTAMP(), 1);
SET @inc_held = LAST_INSERT_ID();
INSERT INTO incident_referral (incident_id, barangay_id, referred_to, referred_at, created_by, created_at) VALUES
 (@inc_plain, 1, 'pnp', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY), $TANOD_ID, UTC_TIMESTAMP()),
 (@inc_plain, 1, 'bfp', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY), $TANOD_ID, UTC_TIMESTAMP()),
 (@inc_held,  1, 'pnp', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY), $TANOD_ID, UTC_TIMESTAMP());
SQL

count_all() {
  echo "av=$(db_one 'SELECT COUNT(*) FROM tanod_availability;')" \
       "rep=$(db_one 'SELECT COUNT(*) FROM accomplishment_report;')" \
       "ent=$(db_one 'SELECT COUNT(*) FROM accomplishment_entry;')" \
       "scan=$(db_one 'SELECT COUNT(*) FROM document_scan;')" \
       "chk=$(db_one 'SELECT COUNT(*) FROM school_checkin;')" \
       "ref=$(db_one 'SELECT COUNT(*) FROM incident_referral;')" \
       "inc=$(db_one 'SELECT COUNT(*) FROM incident;')" \
       "shift=$(db_one 'SELECT COUNT(*) FROM shift_schedule;')" \
       "files=$(ls "$SCANS_DIR_POSIX" | wc -l | tr -d ' ')"
}
BASELINE="$(count_all)"
expect_eq "$BASELINE" "av=3 rep=6 ent=4 scan=6 chk=4 ref=3 inc=2 shift=1 files=5" "baseline row counts seeded"

# --------------------------------------------------------------------------
step "2. A — SHIPPED constants: --list shows every rule as pending"
# --------------------------------------------------------------------------
LIST_OUT="$(php_run scripts/retention-job.php --list)"
for r in tanod_availability accomplishment_report school_checkin incident_referral document_scan; do
  expect_contains "$LIST_OUT" "$r" "--list names $r"
done
expect_contains "$LIST_OUT" "pending_barangay_confirmation" "--list shows the pending status marker"
expect_contains "$LIST_OUT" "no period set" "--list states no period is set"
expect_contains "$LIST_OUT" "2557" "--list still prints the existing 7-year constant (existing rules untouched)"
PENDING_COUNT=$(echo "$LIST_OUT" | grep -c "pending_barangay_confirmation")
expect_eq "$PENDING_COUNT" "4" "exactly four rules carry the pending marker"

# --------------------------------------------------------------------------
step "3. A — SHIPPED constants: a full non-dry-run job deletes NOTHING from the new tables"
# --------------------------------------------------------------------------
FULL_OUT="$(php_run scripts/retention-job.php)"
expect_contains "$FULL_OUT" "tanod_availability: pending barangay confirmation" "full run reports tanod_availability pending"
expect_contains "$FULL_OUT" "accomplishment_report: pending barangay confirmation" "full run reports accomplishment_report pending"
expect_contains "$FULL_OUT" "school_checkin: pending barangay confirmation" "full run reports school_checkin pending"
expect_contains "$FULL_OUT" "incident_referral: pending barangay confirmation" "full run reports incident_referral pending"
AFTER_FULL="$(count_all)"
# Existing rules may legitimately act on the seeded incidents (none are 90 days old
# or 7 years old here), so every count must be identical.
expect_eq "$AFTER_FULL" "$BASELINE" "every table + scan file count identical after a full non-dry-run job"

SHIPPED_JSON="$(php_run scripts/verify-retention-new-tables-seam.php shipped)"
for r in tanod_availability accomplishment_report school_checkin incident_referral; do
  expect_eq "$(echo "$SHIPPED_JSON" | jget "results.$r.purged")" "0" "runAll(): $r purged 0"
  expect_eq "$(echo "$SHIPPED_JSON" | jget "results.$r.held")" "0" "runAll(): $r held 0"
  expect_eq "$(echo "$SHIPPED_JSON" | jget "results.$r.note")" "pending barangay confirmation" "runAll(): $r note"
done
expect_eq "$(count_all)" "$BASELINE" "counts identical after runAll() through the PHP API too"

NEW_AUDIT=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action IN ('retention_tanod_availability_purged','retention_accomplishment_report_purged','retention_school_checkin_purged','retention_incident_referral_purged');")
expect_eq "$NEW_AUDIT" "0" "pending rules write no audit row"

# --------------------------------------------------------------------------
step "4. C — the seam is not reachable from production paths or the environment"
# --------------------------------------------------------------------------
ENV_RUN="$( cd "$BACKEND_DIR" && RETENTION_TANOD_AVAILABILITY_DAYS=1 RETENTION_ACCOMPLISHMENT_REPORT_DAYS=1 RETENTION_SCHOOL_CHECKIN_DAYS=1 RETENTION_INCIDENT_REFERRAL_DAYS=1 \
  DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" SCANS_DIR="$SCANS_DIR_NATIVE" \
  "$PHP_BIN" scripts/retention-job.php 2>&1 )"
expect_eq "$(count_all)" "$BASELINE" "env vars named like retention periods change nothing"
if grep -n "new RetentionService" "$BACKEND_DIR/scripts/retention-job.php" | grep -q "durationOverrides\|\[.*=>"; then
  fail "retention-job.php passes something besides (pdo, dryRun) to RetentionService"
else
  pass "retention-job.php constructs RetentionService with no override argument"
fi
CALLERS=$(grep -rln "new RetentionService\|new \\\\Baranguard\\\\Services\\\\Retention\\\\RetentionService" "$BACKEND_DIR" --include=*.php | grep -v "verify-retention-new-tables-seam.php" | grep -v "/node_modules/" | wc -l | tr -d ' ')
expect_eq "$CALLERS" "1" "only retention-job.php constructs the service outside this suite's seam driver"
if grep -n "baranguard_env" "$BACKEND_DIR/services/retention/RetentionService.php" | grep -qi "RETENTION\|_DAYS"; then
  fail "RetentionService reads a retention period from the environment"
else
  pass "RetentionService reads no retention period from the environment (Rule 10)"
fi
for bad in "tanod_availability 0" "tanod_availability -1" "tanod_availability abc" "not_a_rule 30" "gps_track 30"; do
  set -- $bad
  expect_eq "$(php_run scripts/verify-retention-new-tables-seam.php bad-override "$1" "$2" | jget rejected)" "true" "seam rejects override '$1' => '$2'"
done

# --------------------------------------------------------------------------
step "5. B — TEST SEAM (30-day override): dry-run counts but deletes nothing"
# --------------------------------------------------------------------------
DRY_JSON="$(php_run scripts/verify-retention-new-tables-seam.php override 30 --dry-run)"
expect_eq "$(echo "$DRY_JSON" | jget results.tanod_availability.eligible)" "1" "dry-run: 1 expired availability"
expect_eq "$(echo "$DRY_JSON" | jget results.accomplishment_report.eligible)" "1" "dry-run: 1 eligible report (only the 60d-approved one)"
expect_eq "$(echo "$DRY_JSON" | jget results.school_checkin.eligible)" "2" "dry-run: 2 expired check-ins"
expect_eq "$(echo "$DRY_JSON" | jget results.incident_referral.eligible)" "1" "dry-run: 1 eligible referral"
expect_eq "$(echo "$DRY_JSON" | jget results.incident_referral.held)" "1" "dry-run: 1 referral protected by legal hold"
expect_eq "$(count_all)" "$BASELINE" "dry-run deleted nothing"

# --------------------------------------------------------------------------
step "6. B — TEST SEAM (30-day override): real run removes ONLY expired rows"
# --------------------------------------------------------------------------
RUN_JSON="$(php_run scripts/verify-retention-new-tables-seam.php override 30)"
expect_eq "$(echo "$RUN_JSON" | jget results.tanod_availability.purged)" "1" "availability: purged 1"
expect_eq "$(echo "$RUN_JSON" | jget results.accomplishment_report.purged)" "1" "accomplishment_report: purged 1"
expect_eq "$(echo "$RUN_JSON" | jget results.school_checkin.purged)" "2" "school_checkin: purged 2"
expect_eq "$(echo "$RUN_JSON" | jget results.incident_referral.purged)" "1" "incident_referral: purged 1"
expect_eq "$(echo "$RUN_JSON" | jget results.incident_referral.held)" "1" "incident_referral: held 1"

# tanod_availability
expect_eq "$(db_one "SELECT COUNT(*) FROM tanod_availability WHERE avail_id = $AV_OLD;")" "0" "60-day-expired availability deleted"
expect_eq "$(db_one 'SELECT COUNT(*) FROM tanod_availability;')" "2" "29-day-old and future availability kept"
expect_eq "$(db_one 'SELECT COUNT(*) FROM shift_schedule;')" "1" "the shift citing the deleted availability was NOT deleted"
expect_eq "$(db_one 'SELECT source_availability_id IS NULL FROM shift_schedule;')" "1" "...its source_availability_id pointer was nulled"

# accomplishment_report
expect_eq "$(db_one "SELECT COUNT(*) FROM accomplishment_report WHERE report_id = $R1;")" "0" "approved report past cutoff deleted"
expect_eq "$(db_one "SELECT COUNT(*) FROM accomplishment_entry WHERE report_id = $R1;")" "0" "its entries deleted with it"
expect_eq "$(db_one "SELECT COUNT(*) FROM accomplishment_report WHERE report_id = $R2;")" "1" "approved report INSIDE the window kept"
expect_eq "$(db_one "SELECT COUNT(*) FROM accomplishment_entry WHERE report_id = $R2;")" "1" "its entry kept"
expect_eq "$(db_one "SELECT GROUP_CONCAT(status ORDER BY month) FROM accomplishment_report WHERE month IN ('2025-03','2025-04','2025-05','2025-06');")" "noted,prepared,returned,open" "noted/prepared/returned/open reports ALL kept, however old"
expect_eq "$(db_one "SELECT COUNT(*) FROM accomplishment_report WHERE status='returned' AND approved_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY);")" "1" "(a returned report carrying an old approved_at survived: the status guard works)"
expect_eq "$(db_one "SELECT COUNT(*) FROM accomplishment_entry WHERE report_id = $R3;")" "1" "entries of a not-yet-approved report kept"

# document_scan rows + files follow the parent report only
expect_eq "$(db_one "SELECT COUNT(*) FROM document_scan WHERE entity_type='accomplishment_report' AND entity_id = $R1;")" "0" "scan rows of the purged report deleted"
expect_eq "$(db_one 'SELECT COUNT(*) FROM document_scan;')" "3" "scans of other reports and of the ssz_term_report entity kept"
expect_eq "$(db_one "SELECT COUNT(*) FROM document_scan WHERE entity_type='ssz_term_report' AND entity_id = $R1;")" "1" "same entity_id but entity_type ssz_term_report: untouched"
[ ! -e "$SCANS_DIR_POSIX/scan-r1-a.pdf" ] && pass "scan file scan-r1-a.pdf unlinked from SCANS_DIR" || fail "scan-r1-a.pdf still on disk"
[ ! -e "$SCANS_DIR_POSIX/scan-r1-b.png" ] && pass "scan file scan-r1-b.png unlinked from SCANS_DIR" || fail "scan-r1-b.png still on disk"
[ -e "$SCANS_DIR_POSIX/scan-r2.pdf" ] && pass "scan file of the kept approved report remains" || fail "scan-r2.pdf was deleted"
[ -e "$SCANS_DIR_POSIX/scan-r3.pdf" ] && pass "scan file of the noted report remains" || fail "scan-r3.pdf was deleted"
[ -e "$SCANS_DIR_POSIX/scan-ssz.pdf" ] && pass "scan file of the ssz_term_report entity remains" || fail "scan-ssz.pdf was deleted"
[ -e "$ESCAPE_FILE" ] && pass "a stored_path of ../ could not steer an unlink outside SCANS_DIR" || fail "file outside SCANS_DIR was deleted (path traversal)"

# school_checkin
expect_eq "$(db_one 'SELECT COUNT(*) FROM school_checkin WHERE checked_in_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY);')" "0" "both expired check-ins gone (incl. the never-closed 59d one)"
expect_eq "$(db_one 'SELECT COUNT(*) FROM school_checkin;')" "2" "29-day and 1-day check-ins kept"
expect_eq "$(db_one 'SELECT COUNT(*) FROM school;')" "1" "the school itself untouched"

# incident_referral
expect_eq "$(db_one "SELECT GROUP_CONCAT(referred_to ORDER BY referral_id) FROM incident_referral;")" "bfp,pnp" "plain 60d referral purged; 10d referral and the legal-hold 60d referral kept"
expect_eq "$(db_one "SELECT COUNT(*) FROM incident_referral r JOIN incident i ON i.incident_id=r.incident_id WHERE i.legal_hold=1;")" "1" "the kept old referral is the one on the held incident"
expect_eq "$(db_one 'SELECT COUNT(*) FROM incident;')" "2" "no incident deleted"

# audit: system actor, counts only
for a in retention_tanod_availability_purged retention_accomplishment_report_purged retention_school_checkin_purged retention_incident_referral_purged; do
  expect_eq "$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='$a';")" "1" "one audit row: $a"
done
expect_eq "$(db_one "SELECT actor_user_id IS NULL AND barangay_id IS NULL FROM audit_log WHERE action='retention_accomplishment_report_purged';")" "1" "audit row has no invented actor/barangay"
expect_eq "$(db_one "SELECT metadata_json FROM audit_log WHERE action='retention_accomplishment_report_purged';")" '{"purged":1,"failed":0}' "accomplishment audit metadata is counts only"
expect_eq "$(db_one "SELECT metadata_json FROM audit_log WHERE action='retention_incident_referral_purged';")" '{"purged":1,"held":1}' "referral audit metadata is counts only"
LEAK=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action LIKE 'retention_%' AND (metadata_json LIKE '%patrol%' OR metadata_json LIKE '%scan-%' OR metadata_json LIKE '%RN %');")
expect_eq "$LEAK" "0" "no entry text / file names / names in retention audit metadata"

# --------------------------------------------------------------------------
step "7. B — idempotent: a second override run finds nothing; shipped run still deletes nothing"
# --------------------------------------------------------------------------
AFTER_REAL="$(count_all)"
RUN2_JSON="$(php_run scripts/verify-retention-new-tables-seam.php override 30)"
expect_eq "$(echo "$RUN2_JSON" | jget results.accomplishment_report.purged)" "0" "second run purges 0 reports"
expect_eq "$(echo "$RUN2_JSON" | jget results.school_checkin.purged)" "0" "second run purges 0 check-ins"
expect_eq "$(echo "$RUN2_JSON" | jget results.tanod_availability.purged)" "0" "second run purges 0 availability"
expect_eq "$(count_all)" "$AFTER_REAL" "second run changed no counts"
php_run scripts/retention-job.php >/dev/null
expect_eq "$(count_all)" "$AFTER_REAL" "a shipped-constants full job after that still deletes nothing"

# Rows newer than ANY cutoff are safe: a 400-day override must not delete the 29/10/1-day rows either.
RUN3_JSON="$(php_run scripts/verify-retention-new-tables-seam.php override 400)"
expect_eq "$(echo "$RUN3_JSON" | jget results.accomplishment_report.purged)" "0" "400-day override: nothing past the cutoff"
expect_eq "$(count_all)" "$AFTER_REAL" "400-day override deleted nothing"

# --------------------------------------------------------------------------
echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
