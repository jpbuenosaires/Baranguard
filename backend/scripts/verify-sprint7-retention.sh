#!/usr/bin/env bash
# Baranguard — Sprint 7 validation: retention jobs (§11's retention table,
# all record types) + legal-hold override.
#
# Every rule in §11 is a TIME-WINDOW rule, and none of the windows are
# short (90 days is the shortest). So this suite seeds rows with
# deliberately BACK-DATED timestamps — one just inside each window and one
# just outside it — and asserts the job takes exactly the outside one.
# That tests the real boundary rather than waiting a year for a row to
# age, and it means the whole suite runs in seconds on any machine.
#
# Safe to run: disposable database, disposable app-user, throwaway port.
# The real `baranguard` database and backend/.env are never touched.
#
# Usage (from a Git Bash prompt): bash backend/scripts/verify-sprint7-retention.sh

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
XAMPP_MYSQL_PORT="${XAMPP_MYSQL_PORT:-3306}"
XAMPP_MYSQL_USER="${XAMPP_MYSQL_USER:-root}"
XAMPP_MYSQL_PASSWORD="${XAMPP_MYSQL_PASSWORD:-}"
VALDB="baranguard_sprint7_check"
APP_USER="s7chk_app"
APP_PASSWORD="Sprint7Chk!2026"
API_PORT="8171"
BASE_URL="http://127.0.0.1:${API_PORT}/api/v1"
TEST_PW="Sprint7#2026Pw"

echo "Baranguard Sprint 7 retention validation — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for c in "/c/xampp/mysql/bin/${name}.exe" "/c/xampp/mysql/bin/${name}" "/c/xampp/php/${name}.exe" "/c/xampp/php/${name}"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  echo ""
}
MYSQL_BIN="$(find_bin mysql)"; PHP_BIN="$(find_bin php)"
[ -z "$MYSQL_BIN" ] && { echo "ERROR: mysql client not found."; exit 1; }
[ -z "$PHP_BIN" ] && { echo "ERROR: php not found."; exit 1; }

mysql_exec() {
  MYSQL_PWD="$XAMPP_MYSQL_PASSWORD" "$MYSQL_BIN" --host="$XAMPP_MYSQL_HOST" --port="$XAMPP_MYSQL_PORT" --user="$XAMPP_MYSQL_USER" "$@"
}
# One retry: this repo has hit transient mysql-client connection churn on
# Windows across long suites before (see DEVLOG's Sprint 4 Phase 1 entry).
db_one() {
  local out
  out="$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null)"
  if [ -z "$out" ]; then out="$(mysql_exec -N -s "$VALDB" -e "$1" 2>/dev/null)"; fi
  echo "$out"
}

cleanup() {
  step "Cleanup"
  [ -n "${SERVER_PID:-}" ] && { kill "$SERVER_PID" 2>/dev/null; taskkill //F //PID "$SERVER_PID" 2>/dev/null; }
  for pid in $(netstat -ano 2>/dev/null | grep "127.0.0.1:${API_PORT} " | grep LISTENING | awk '{print $NF}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null
  done
  mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`;" 2>/dev/null
  mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost';" 2>/dev/null
  rm -f "$BACKEND_DIR/scripts/.s7chk-server.log"
  rm -rf "$BACKEND_DIR/scripts/.s7chk-evidence"
  echo "Dropped $VALDB / user '$APP_USER'. The real 'baranguard' database was never touched."
}
trap cleanup EXIT

# --------------------------------------------------------------------------
step "0. Schema + migrations"
# --------------------------------------------------------------------------
mysql_exec -e "SELECT VERSION();" >/dev/null && pass "Connected to MariaDB" || { fail "Could not connect"; exit 1; }
mysql_exec -e "DROP DATABASE IF EXISTS \`$VALDB\`; CREATE DATABASE \`$VALDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
# FULL CHAIN, not this sprint's subset. Applying only 0001/0002/0004/
# 0006/0007 was correct when written and silently stopped being correct on
# 2026-09-05: migration 0011 added `user.is_suspended`, which
# AuthController::login() selects, so every login here 500'd from then on
# and the suite could not reach its own assertions. A suite pinned to a
# partial schema expires the next time a migration touches a table it logs
# in through.
for m in 0001_baseline_schema 0002_seed_barangays 0003_shift_schedule_nullable_user 0004_blotter_revision \
         0005_sms_envelope_replay 0006_sms_log_barangay 0007_retention_columns 0008_incident_party_fields \
         0009_blotter_case_status 0010_incident_location_description 0011_user_suspension 0012_system_settings \
         0013_sms_manual_send 0014_incident_display_id 0015_ai_tools \
         0016_retention_hold_and_device_scrub \
         0017_health_check_log; do
  mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m failed"
done
pass "Migrations 0001-0017 applied"

# The four schema gaps 0007 exists to close — asserted against
# information_schema, not assumed from the migration file's intent.
RAW_NULLABLE=$(db_one "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='incident' AND COLUMN_NAME='raw_narrative';")
expect_eq "$RAW_NULLABLE" "YES" "0007: incident.raw_narrative is now nullable"
HOLD_COL=$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='incident' AND COLUMN_NAME='legal_hold';")
expect_eq "$HOLD_COL" "1" "0007: incident.legal_hold exists"
PURGED_COL=$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='incident' AND COLUMN_NAME='raw_narrative_purged_at';")
expect_eq "$PURGED_COL" "1" "0007: incident.raw_narrative_purged_at exists"
DEACT_COL=$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='mobile_device' AND COLUMN_NAME='deactivated_at';")
expect_eq "$DEACT_COL" "1" "0007: mobile_device.deactivated_at exists"

# Re-running must be a no-op (every statement is guarded).
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0007_retention_columns.sql" >/dev/null 2>&1 && pass "0007 is idempotent (re-ran cleanly)" || fail "0007 re-run failed"

# The two gaps 0016 exists to close — same information_schema discipline.
SMS_HOLD_COL=$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='sms_log' AND COLUMN_NAME='legal_hold';")
expect_eq "$SMS_HOLD_COL" "1" "0016: sms_log.legal_hold exists"
SCRUB_COL=$(db_one "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$VALDB' AND TABLE_NAME='mobile_device' AND COLUMN_NAME='secrets_scrubbed_at';")
expect_eq "$SCRUB_COL" "1" "0016: mobile_device.secrets_scrubbed_at exists"
mysql_exec "$VALDB" < "$BACKEND_DIR/migrations/0016_retention_hold_and_device_scrub.sql" >/dev/null 2>&1 && pass "0016 is idempotent (re-ran cleanly)" || fail "0016 re-run failed"

mysql_exec -e "DROP USER IF EXISTS '$APP_USER'@'localhost'; CREATE USER '$APP_USER'@'localhost' IDENTIFIED BY '$APP_PASSWORD'; GRANT ALL PRIVILEGES ON \`$VALDB\`.* TO '$APP_USER'@'localhost'; FLUSH PRIVILEGES;"

HASH=$("$PHP_BIN" -r "echo password_hash('$TEST_PW', PASSWORD_ARGON2ID);")
mysql_exec "$VALDB" <<SQL
INSERT INTO user (barangay_id, username, password_hash, full_name, role, is_active, created_at) VALUES
 (1,'s7_admin','$HASH','S7 Admin','admin',1,UTC_TIMESTAMP()),
 (1,'s7_tanod','$HASH','S7 Tanod','tanod',1,UTC_TIMESTAMP()),
 (1,'s7_secretary','$HASH','S7 Secretary','secretary',1,UTC_TIMESTAMP());
SQL
pass "Test accounts created"

run_job() {
  # Runs the retention job against the disposable DB. Credentials come
  # from the environment, which config/env.php honours ahead of .env —
  # the same mechanism every other verify script in this repo relies on.
  ( cd "$BACKEND_DIR" && \
    DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
    DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" \
    EVIDENCE_DIR="$BACKEND_DIR/scripts/.s7chk-evidence" \
    "$PHP_BIN" scripts/retention-job.php "$@" 2>&1 )
}

# --------------------------------------------------------------------------
step "1. --list and --only argument handling"
# --------------------------------------------------------------------------
LIST_OUT="$(run_job --list)"
expect_contains "$LIST_OUT" "raw_narrative" "--list names the raw_narrative rule"
expect_contains "$LIST_OUT" "2557" "--list prints the real 7-year constant"
# Capital L: it starts a sentence in the real output. This repo's own
# DEVLOG has logged case-sensitivity assertion bugs twice before.
expect_contains "$LIST_OUT" "Legal hold" "--list states legal hold is the only exception"

BAD_OUT="$(run_job --only=not_a_rule 2>&1)"; BAD_CODE=$?
expect_contains "$BAD_OUT" "Unknown rule" "--only rejects an unknown rule name"

# --------------------------------------------------------------------------
step "2. raw_narrative — 30-day post-approval grace"
# --------------------------------------------------------------------------
# Four incidents, all approved, differing only in WHEN they were approved
# and whether they are on legal hold.
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, redacted_narrative, redaction_approved_at, status, source, created_at, updated_at, legal_hold) VALUES
 (1,2,'theft','normal','RAW approved 40 days ago','[NAME] took it', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 DAY),'resolved','app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY), UTC_TIMESTAMP(), 0),
 (1,2,'theft','normal','RAW approved 10 days ago','[NAME] took it', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 DAY),'resolved','app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 DAY), UTC_TIMESTAMP(), 0),
 (1,2,'theft','normal','RAW approved 40 days ago BUT HELD','[NAME] took it', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 DAY),'resolved','app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY), UTC_TIMESTAMP(), 1);
SQL
# Two more for the unapproved 90-day ceiling.
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, status, source, created_at, updated_at, legal_hold) VALUES
 (1,2,'disturbance','normal','RAW unapproved 100 days old','pending','app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY), UTC_TIMESTAMP(), 0),
 (1,2,'disturbance','normal','RAW unapproved 30 days old','pending','app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY), UTC_TIMESTAMP(), 0);
SQL
pass "Seeded 5 incidents across both raw_narrative clauses"

# Dry run must delete NOTHING while reporting the right blast radius.
DRY_OUT="$(run_job --dry-run --only=raw_narrative)"
expect_contains "$DRY_OUT" "DRY RUN" "--dry-run announces itself"
STILL_THERE=$(db_one "SELECT COUNT(*) FROM incident WHERE raw_narrative IS NOT NULL;")
expect_eq "$STILL_THERE" "5" "--dry-run deleted nothing (all 5 raw narratives intact)"
expect_contains "$DRY_OUT" "raw_narrative: 2 eligible, 1 on legal hold" "--dry-run counts 2 eligible + 1 held"

# Real run.
RUN_OUT="$(run_job --only=raw_narrative)"
expect_contains "$RUN_OUT" "raw_narrative: purged 2" "job reports 2 purged"

PURGED_APPROVED=$(db_one "SELECT raw_narrative IS NULL AND raw_narrative_purged_at IS NOT NULL FROM incident WHERE raw_narrative_purged_at IS NOT NULL AND redaction_approved_at IS NOT NULL LIMIT 1;")
expect_eq "$PURGED_APPROVED" "1" "40-day-approved incident: raw_narrative NULL + purge timestamp set"
KEPT_IN_GRACE=$(db_one "SELECT COUNT(*) FROM incident WHERE raw_narrative = 'RAW approved 10 days ago';")
expect_eq "$KEPT_IN_GRACE" "1" "10-day-approved incident is STILL INSIDE the 30-day grace and was kept"
HELD_KEPT=$(db_one "SELECT COUNT(*) FROM incident WHERE raw_narrative = 'RAW approved 40 days ago BUT HELD';")
expect_eq "$HELD_KEPT" "1" "legal hold blocked an otherwise-eligible purge"
CEILING_PURGED=$(db_one "SELECT COUNT(*) FROM incident WHERE raw_narrative = 'RAW unapproved 100 days old';")
expect_eq "$CEILING_PURGED" "0" "unapproved 100-day incident hit the 90-day ceiling"
CEILING_KEPT=$(db_one "SELECT COUNT(*) FROM incident WHERE raw_narrative = 'RAW unapproved 30 days old';")
expect_eq "$CEILING_KEPT" "1" "unapproved 30-day incident is under the ceiling and was kept"

# The redacted narrative is the whole point of keeping the case — it must
# survive the raw purge untouched.
REDACTED_INTACT=$(db_one "SELECT COUNT(*) FROM incident WHERE redacted_narrative = '[NAME] took it';")
expect_eq "$REDACTED_INTACT" "3" "approved redactions survived the raw_narrative purge"

# Rule 17: retention jobs produce audit events.
AUDIT_ROW=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action = 'retention_raw_narrative_purged';")
expect_eq "$AUDIT_ROW" "1" "one audit row written for the raw_narrative rule"
AUDIT_ACTOR=$(db_one "SELECT actor_user_id IS NULL AND barangay_id IS NULL FROM audit_log WHERE action='retention_raw_narrative_purged';")
expect_eq "$AUDIT_ACTOR" "1" "audit row has no invented actor/barangay (system action)"
AUDIT_META=$(db_one "SELECT metadata_json FROM audit_log WHERE action='retention_raw_narrative_purged';")
expect_contains "$AUDIT_META" '"purged":2' "audit metadata carries the count"
case "$AUDIT_META" in
  *RAW*) fail "AUDIT LEAK: narrative text appears in audit metadata";;
  *) pass "Rule 17: no narrative text in audit metadata";;
esac

# Idempotent: a second run finds nothing left to do.
RERUN_OUT="$(run_job --only=raw_narrative)"
expect_contains "$RERUN_OUT" "raw_narrative: 0 eligible" "re-running the rule is a no-op"

# --------------------------------------------------------------------------
step "3. citizen_report — 1 year, UNCONVERTED only"
# --------------------------------------------------------------------------
CONV_INCIDENT=$(db_one "SELECT incident_id FROM incident LIMIT 1;")
mysql_exec "$VALDB" <<SQL
INSERT INTO citizen_report (barangay_id, incident_id, description, submitted_at, converted_at, legal_hold) VALUES
 (1, NULL, 'old unconverted report', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY), NULL, 0),
 (1, NULL, 'recent unconverted report', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY), NULL, 0),
 (1, NULL, 'old unconverted but HELD', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY), NULL, 1),
 (1, $CONV_INCIDENT, 'old CONVERTED report', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 399 DAY), 0);
SQL
run_job --only=citizen_report >/dev/null
OLD_GONE=$(db_one "SELECT COUNT(*) FROM citizen_report WHERE description = 'old unconverted report';")
expect_eq "$OLD_GONE" "0" "400-day unconverted report purged"
RECENT_KEPT=$(db_one "SELECT COUNT(*) FROM citizen_report WHERE description = 'recent unconverted report';")
expect_eq "$RECENT_KEPT" "1" "100-day unconverted report kept (under 1 year)"
CR_HELD=$(db_one "SELECT COUNT(*) FROM citizen_report WHERE description = 'old unconverted but HELD';")
expect_eq "$CR_HELD" "1" "legal hold blocked the citizen_report purge"
CONVERTED_KEPT=$(db_one "SELECT COUNT(*) FROM citizen_report WHERE description = 'old CONVERTED report';")
expect_eq "$CONVERTED_KEPT" "1" "CONVERTED report ignored this rule entirely (§11: follows its incident)"

# --------------------------------------------------------------------------
step "4. sms_log — 1 year, EXTENDED by a hold on the linked case (0016)"
# --------------------------------------------------------------------------
# Five 400-day-old rows, all past the flat clock, differing only in which
# hold path (if any) reaches them. Before 0016 this table had no
# legal_hold column at all and every one of these would have been purged.
HELD_INCIDENT=$(db_one "SELECT incident_id FROM incident WHERE legal_hold = 1 LIMIT 1;")
HELD_REPORT=$(db_one "SELECT report_id FROM citizen_report WHERE legal_hold = 1 LIMIT 1;")
mysql_exec "$VALDB" <<SQL
INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, status, dispatched_at, created_client_request_id)
 VALUES ($HELD_INCIDENT, 2, 2, 'normal', 'completed', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 399 DAY), UUID());
SQL
HELD_DISPATCH=$(db_one "SELECT dispatch_id FROM dispatch ORDER BY dispatch_id DESC LIMIT 1;")
mysql_exec "$VALDB" <<SQL
INSERT INTO sms_log (barangay_id, incident_id, report_id, dispatch_id, transport, message_type, direction, status, legal_hold, created_at) VALUES
 (1, $CONV_INCIDENT, NULL, NULL, 'semaphore','dispatch','outbound','sent', 0, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY)),
 (1, $CONV_INCIDENT, NULL, NULL, 'semaphore','dispatch','outbound','sent', 0, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY)),
 (1, $HELD_INCIDENT, NULL, NULL, 'semaphore','dispatch','outbound','sent', 0, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY)),
 (1, NULL, $HELD_REPORT, NULL, 'semaphore','confirmation','outbound','sent', 0, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY)),
 (1, NULL, NULL, $HELD_DISPATCH, 'semaphore','dispatch','outbound','sent', 0, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY)),
 (1, NULL, NULL, NULL, 'semaphore','manual','outbound','sent', 1, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY));
SQL
SMS_DRY="$(run_job --dry-run --only=sms_log)"
expect_contains "$SMS_DRY" "sms_log: 1 eligible, 4 on legal hold" "held rows are COUNTED and reported, not silently skipped"

run_job --only=sms_log >/dev/null
SMS_UNHELD_GONE=$(db_one "SELECT COUNT(*) FROM sms_log WHERE incident_id = $CONV_INCIDENT AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 200 DAY);")
expect_eq "$SMS_UNHELD_GONE" "0" "400-day row on an UNHELD incident purged"
SMS_RECENT_KEPT=$(db_one "SELECT COUNT(*) FROM sms_log WHERE incident_id = $CONV_INCIDENT;")
expect_eq "$SMS_RECENT_KEPT" "1" "100-day row kept (under the 1-year clock)"
SMS_HELD_INCIDENT=$(db_one "SELECT COUNT(*) FROM sms_log WHERE incident_id = $HELD_INCIDENT;")
expect_eq "$SMS_HELD_INCIDENT" "1" "hold INHERITED from the linked incident kept a 400-day row"
SMS_HELD_REPORT=$(db_one "SELECT COUNT(*) FROM sms_log WHERE report_id = $HELD_REPORT;")
expect_eq "$SMS_HELD_REPORT" "1" "hold inherited from the linked citizen_report kept a 400-day row"
SMS_HELD_DISPATCH=$(db_one "SELECT COUNT(*) FROM sms_log WHERE dispatch_id = $HELD_DISPATCH;")
expect_eq "$SMS_HELD_DISPATCH" "1" "hold resolved THROUGH a dispatch to its incident kept a 400-day row"
SMS_OWN_HOLD=$(db_one "SELECT COUNT(*) FROM sms_log WHERE legal_hold = 1;")
expect_eq "$SMS_OWN_HOLD" "1" "row's OWN legal_hold kept it with no linked case at all"
SMS_INCIDENT_ALIVE=$(db_one "SELECT COUNT(*) FROM incident WHERE incident_id = $CONV_INCIDENT;")
expect_eq "$SMS_INCIDENT_ALIVE" "1" "purging an sms_log row did not touch its incident"
SMS_AUDIT=$(db_one "SELECT metadata_json FROM audit_log WHERE action='retention_sms_log_purged';")
expect_contains "$SMS_AUDIT" '"held":4' "audit metadata carries the held count"

# --------------------------------------------------------------------------
step "5. ai_processing_log — 1 year OR the incident's clock, whichever is longer"
# --------------------------------------------------------------------------
# A 400-day-old draft whose incident is only 60 days old must be KEPT:
# the incident's 7-year clock is the longer of the two.
mysql_exec "$VALDB" <<SQL
INSERT INTO ai_processing_log (incident_id, pipeline_run_id, task_type, model_version, status, created_at) VALUES
 ($CONV_INCIDENT, UUID(), 'redaction', 'test-model', 'completed', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 400 DAY));
SQL
run_job --only=ai_processing_log >/dev/null
AI_KEPT=$(db_one "SELECT COUNT(*) FROM ai_processing_log;")
expect_eq "$AI_KEPT" "1" "400-day draft KEPT because its incident's 7-year clock is longer"

# --------------------------------------------------------------------------
step "6. mobile_device — secrets scrubbed at 90 days, ROW RETAINED (0016)"
# --------------------------------------------------------------------------
# The rule changed: this used to DELETE the row, which silently stripped
# `incident.device_id` off 7-year records via ON DELETE SET NULL 90 days
# after a handset was retired. The provenance assertion below is the one
# that would have caught that, and is the reason the rule was revised.
mysql_exec "$VALDB" <<SQL
INSERT INTO mobile_device (device_id, user_id, platform, fcm_token, device_secret_ref, last_seen_at, is_active, created_at, deactivated_at) VALUES
 ('dev-old-inactive', 2, 'android', 'tok', 'secret-should-go', UTC_TIMESTAMP(), 0, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 200 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 120 DAY)),
 ('dev-recent-inactive', 2, 'android', 'tok', 'secret-stays', UTC_TIMESTAMP(), 0, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 200 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)),
 ('dev-still-active', 2, 'android', 'tok', 'secret-stays', UTC_TIMESTAMP(), 1, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 200 DAY), NULL);
SQL
# An old incident filed by the retired handset — its device attribution is
# what the previous delete-the-row rule destroyed.
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, reported_by, device_id, incident_type, priority, raw_narrative, status, source, created_at, updated_at, legal_hold)
 VALUES (1, 2, 'dev-old-inactive', 'theft', 'normal', 'filed from the retired handset', 'resolved', 'app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 200 DAY), UTC_TIMESTAMP(), 1);
SQL
run_job --only=mobile_device >/dev/null

DEV_OLD=$(db_one "SELECT COUNT(*) FROM mobile_device WHERE device_id = 'dev-old-inactive';")
expect_eq "$DEV_OLD" "1" "device deactivated 120 days ago is RETAINED, not deleted"
DEV_SCRUBBED=$(db_one "SELECT fcm_token = '' AND device_secret_ref IS NULL AND secrets_scrubbed_at IS NOT NULL FROM mobile_device WHERE device_id = 'dev-old-inactive';")
expect_eq "$DEV_SCRUBBED" "1" "its secrets ARE gone (fcm_token emptied, device_secret_ref NULL, marker set)"
DEV_PROVENANCE=$(db_one "SELECT COUNT(*) FROM incident WHERE device_id = 'dev-old-inactive';")
expect_eq "$DEV_PROVENANCE" "1" "the 7-year incident still knows which device filed it (the whole point)"

DEV_RECENT=$(db_one "SELECT device_secret_ref FROM mobile_device WHERE device_id = 'dev-recent-inactive';")
expect_eq "$DEV_RECENT" "secret-stays" "device deactivated 30 days ago untouched (inside 90-day window)"
DEV_ACTIVE=$(db_one "SELECT device_secret_ref FROM mobile_device WHERE device_id = 'dev-still-active';")
expect_eq "$DEV_ACTIVE" "secret-stays" "active device never touched"

DEV_AUDIT=$(db_one "SELECT metadata_json FROM audit_log WHERE action='retention_device_secrets_scrubbed';")
expect_contains "$DEV_AUDIT" '"scrubbed":1' "audit records a scrub, not a purge"
DEV_RERUN="$(run_job --only=mobile_device)"
expect_contains "$DEV_RERUN" "mobile_device: 0 eligible" "already-scrubbed rows are not eligible again (idempotent)"

# --------------------------------------------------------------------------
step "7. audit_log — 7 years"
# --------------------------------------------------------------------------
mysql_exec "$VALDB" <<SQL
INSERT INTO audit_log (barangay_id, actor_user_id, action, entity_type, entity_id, created_at) VALUES
 (1, 1, 'login_success', 'user', 1, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3000 DAY)),
 (1, 1, 'login_success', 'user', 1, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY));
SQL
OLD_AUDIT_BEFORE=$(db_one "SELECT COUNT(*) FROM audit_log WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2557 DAY);")
expect_eq "$OLD_AUDIT_BEFORE" "1" "one 3000-day-old audit row seeded"
run_job --only=audit_log >/dev/null
OLD_AUDIT_AFTER=$(db_one "SELECT COUNT(*) FROM audit_log WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2557 DAY);")
expect_eq "$OLD_AUDIT_AFTER" "0" "3000-day audit row purged (Rule 17's controlled retention deletion)"
RECENT_AUDIT=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='login_success';")
expect_eq "$RECENT_AUDIT" "1" "100-day audit row kept"
SELF_AUDIT=$(db_one "SELECT COUNT(*) FROM audit_log WHERE action='retention_audit_log_purged';")
expect_eq "$SELF_AUDIT" "1" "the audit-log purge audited itself, after the delete"

# --------------------------------------------------------------------------
step "8. incident_records — the 7-year cascade (FK RESTRICT ordering)"
# --------------------------------------------------------------------------
# One 8-year-old incident carrying EVERY restrict-dependent record type,
# plus an 8-year-old incident on legal hold that must survive intact.
mkdir -p "$BACKEND_DIR/scripts/.s7chk-evidence"
echo "fake evidence bytes" > "$BACKEND_DIR/scripts/.s7chk-evidence/old-photo.jpg"
mysql_exec "$VALDB" <<SQL
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, redacted_narrative, status, source, created_at, updated_at, legal_hold)
VALUES (1,2,'fire','high',NULL,'[NAME] fire','resolved','app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3000 DAY), UTC_TIMESTAMP(), 0);
SET @old_inc = LAST_INSERT_ID();
INSERT INTO incident (barangay_id, reported_by, incident_type, priority, raw_narrative, redacted_narrative, status, source, created_at, updated_at, legal_hold)
VALUES (1,2,'fire','high',NULL,'[NAME] held fire','resolved','app', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3000 DAY), UTC_TIMESTAMP(), 1);
SET @held_inc = LAST_INSERT_ID();

INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, route_status, status, dispatched_at)
VALUES (@old_inc, 1, 2, 'high', 'unavailable', 'completed', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2999 DAY));
INSERT INTO evidence_attachment (incident_id, type, file_path, uploaded_by, uploaded_at, sha256, byte_size, mime_type, original_filename)
VALUES (@old_inc, 'photo', 'old-photo.jpg', 2, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2999 DAY), REPEAT('a',64), 20, 'image/jpeg', 'old-photo.jpg');
INSERT INTO blotter_record (incident_id, barangay_id, recorded_by, approved_by, narrative_summary, finalized_at, revision_no)
VALUES (@old_inc, 1, 3, 3, 'old finalized summary', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2998 DAY), 2);
SET @old_blotter = LAST_INSERT_ID();
INSERT INTO blotter_revision (blotter_id, revision_no, narrative_summary, reason, amended_by, superseded_at)
VALUES (@old_blotter, 1, 'superseded summary', 'typo', 3, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2998 DAY));
INSERT INTO ai_processing_log (incident_id, pipeline_run_id, task_type, model_version, status, created_at)
VALUES (@old_inc, UUID(), 'redaction', 'test-model', 'completed', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2999 DAY));
INSERT INTO citizen_report (barangay_id, incident_id, description, submitted_at, converted_at)
VALUES (1, @old_inc, 'converted long ago', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3001 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3000 DAY));
SQL
pass "Seeded an 8-year-old incident with all 5 RESTRICT dependents + a held twin"

OLD_INC=$(db_one "SELECT incident_id FROM incident WHERE redacted_narrative='[NAME] fire';")
HELD_INC=$(db_one "SELECT incident_id FROM incident WHERE redacted_narrative='[NAME] held fire';")

CASCADE_OUT="$(run_job --only=incident_records)"
expect_contains "$CASCADE_OUT" "purged 1" "cascade reports exactly 1 case purged"
expect_contains "$CASCADE_OUT" "1 on legal hold" "cascade reports the held case as held"

INC_GONE=$(db_one "SELECT COUNT(*) FROM incident WHERE incident_id = $OLD_INC;")
expect_eq "$INC_GONE" "0" "8-year-old incident deleted"
DISP_GONE=$(db_one "SELECT COUNT(*) FROM dispatch WHERE incident_id = $OLD_INC;")
expect_eq "$DISP_GONE" "0" "its dispatch went with it (FK RESTRICT handled in order)"
EV_GONE=$(db_one "SELECT COUNT(*) FROM evidence_attachment WHERE incident_id = $OLD_INC;")
expect_eq "$EV_GONE" "0" "its evidence row went with it"
BLOT_GONE=$(db_one "SELECT COUNT(*) FROM blotter_record WHERE incident_id = $OLD_INC;")
expect_eq "$BLOT_GONE" "0" "its blotter record went with it"
REV_GONE=$(db_one "SELECT COUNT(*) FROM blotter_revision;")
expect_eq "$REV_GONE" "0" "its blotter REVISION history went with it"
AI_GONE=$(db_one "SELECT COUNT(*) FROM ai_processing_log WHERE incident_id = $OLD_INC;")
expect_eq "$AI_GONE" "0" "its AI draft rows went with it"

if [ -f "$BACKEND_DIR/scripts/.s7chk-evidence/old-photo.jpg" ]; then
  fail "evidence FILE still on disk after the row was purged"
else
  pass "evidence file was unlinked from disk, not just the row (Rule 11)"
fi

HELD_ALIVE=$(db_one "SELECT COUNT(*) FROM incident WHERE incident_id = $HELD_INC;")
expect_eq "$HELD_ALIVE" "1" "the legal-hold twin of the same age SURVIVED"

# §11: a converted citizen_report follows its incident. The FK is SET
# NULL, so the report itself survives the cascade and simply loses the
# link — after which its own 1-year clock (step 3's rule) applies again.
ORPHANED=$(db_one "SELECT COUNT(*) FROM citizen_report WHERE description='converted long ago' AND incident_id IS NULL;")
expect_eq "$ORPHANED" "1" "converted report survived the cascade with incident_id SET NULL"
run_job --only=citizen_report >/dev/null
ORPHAN_PURGED=$(db_one "SELECT COUNT(*) FROM citizen_report WHERE description='converted long ago';")
expect_eq "$ORPHAN_PURGED" "0" "…and the next run purged it under its own 1-year clock"

# --------------------------------------------------------------------------
step "9. Full run + backup reminder"
# --------------------------------------------------------------------------
FULL_OUT="$(run_job)"
expect_contains "$FULL_OUT" "Purged" "a full run summarises a total"
expect_contains "$FULL_OUT" "backups are NOT covered" "run states backups are out of scope (Rule 11)"
# 5 from step 2 (all still inside the 7-year window, whatever happened to
# their raw_narrative) + the legal-hold twin from step 8. The only
# incident that should be GONE is step 8's unheld 8-year-old case.
LEFT=$(db_one "SELECT COUNT(*) FROM incident;")
expect_eq "$LEFT" "7" "full run left exactly the 7 surviving incidents (5 in-window + 1 held + step 6's held provenance case)"

# --------------------------------------------------------------------------
step "10. DevicesController sets deactivated_at (the 90-day clock's source)"
# --------------------------------------------------------------------------
# The rule in step 6 is worthless if nothing ever sets deactivated_at in
# production, so this exercises the real endpoint rather than assuming it.
( cd "$BACKEND_DIR" && DB_HOST="$XAMPP_MYSQL_HOST" DB_PORT="$XAMPP_MYSQL_PORT" DB_NAME="$VALDB" \
  DB_USER="$APP_USER" DB_PASSWORD="$APP_PASSWORD" JWT_SECRET="s7-verify-secret-key-not-real-0123456789" \
  "$PHP_BIN" -S 127.0.0.1:$API_PORT -t public public/dev-router.php > "$BACKEND_DIR/scripts/.s7chk-server.log" 2>&1 ) &
SERVER_PID=$!
sleep 2

TANOD_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"s7_tanod\",\"password\":\"$TEST_PW\"}" | "$PHP_BIN" -r 'echo json_decode(stream_get_contents(STDIN), true)["token"] ?? "";')
if [ -n "$TANOD_TOKEN" ]; then pass "Tanod logged in"; else fail "Tanod login failed — see .s7chk-server.log"; fi

curl -s -X POST "$BASE_URL/devices/register" -H "Authorization: Bearer $TANOD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"device_id":"s7-device-abc123","platform":"android","fcm_token":"fcm-token-value","app_version":"1.0.0"}' >/dev/null
REG_NULL=$(db_one "SELECT deactivated_at IS NULL FROM mobile_device WHERE device_id='s7-device-abc123';")
expect_eq "$REG_NULL" "1" "a freshly registered device has NO deactivated_at (clock not running)"

curl -s -X PATCH "$BASE_URL/devices/s7-device-abc123/deactivate" -H "Authorization: Bearer $TANOD_TOKEN" >/dev/null
DEACT_SET=$(db_one "SELECT deactivated_at IS NOT NULL AND is_active = 0 FROM mobile_device WHERE device_id='s7-device-abc123';")
expect_eq "$DEACT_SET" "1" "deactivate endpoint sets deactivated_at — the 90-day clock now runs"

curl -s -X POST "$BASE_URL/devices/register" -H "Authorization: Bearer $TANOD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"device_id":"s7-device-abc123","platform":"android","fcm_token":"fcm-token-value-2","app_version":"1.0.1"}' >/dev/null
REACT_CLEARED=$(db_one "SELECT deactivated_at IS NULL AND is_active = 1 FROM mobile_device WHERE device_id='s7-device-abc123';")
expect_eq "$REACT_CLEARED" "1" "re-registering the device CLEARS deactivated_at (clock stops)"

# --------------------------------------------------------------------------
echo
echo "=================================================="
echo "PASSED: $PASS   FAILED: $FAIL"
echo "=================================================="
[ "$FAIL" -eq 0 ] || exit 1
