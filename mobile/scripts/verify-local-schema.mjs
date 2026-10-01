/**
 * verify-local-schema.mjs — asserts the mobile local schema actually
 * matches Master Reference §5 "Mobile Local", by executing the REAL
 * migration statements (imported from src/services/db/localSchema.ts, not
 * copy-pasted) against a real SQLite engine and inspecting the result.
 *
 * Same spirit as backend/scripts/verify-*.sh: prove it, don't claim it.
 * Runs entirely in-memory — creates no files, touches no device, needs no
 * network. Uses Node's built-in `node:sqlite` (Node 22+) so it adds no
 * dependency to the app.
 *
 * What this DOES verify: the DDL is valid SQL, every table/column/type/
 * nullability/default matches §5 exactly, the UNIQUE constraint on
 * `client_event_id` is really enforced, declared defaults really apply,
 * and the migration runner is idempotent.
 *
 * What this does NOT verify (needs a real Android device/emulator —
 * flagged in DEVLOG rather than glossed over): that SQLCipher actually
 * encrypts the file on disk, and anything in localDatabase.ts, which is
 * Capacitor-dependent.
 *
 * Usage:  node mobile/scripts/verify-local-schema.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { LOCAL_MIGRATIONS, LOCAL_SCHEMA_VERSION, LOCAL_TABLES } from '../src/services/db/localSchema.ts';
import { minutesBetweenTimes } from '../src/utils/manilaTime.ts';

let pass = 0;
let fail = 0;
const ok = (msg) => { console.log(`[PASS] ${msg}`); pass += 1; };
const bad = (msg) => { console.log(`[FAIL] ${msg}`); fail += 1; };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

/**
 * Expected shape, transcribed by hand from §5 "Mobile Local".
 * [type, notnull(0|1), default(null|string), pk(0|1)]
 */
const EXPECTED = {
  incident_local: {
    local_id:           ['TEXT', 1, null, 1],
    server_incident_id: ['INTEGER', 0, null, 0],
    barangay_id:        ['INTEGER', 1, null, 0],
    reported_by:        ['INTEGER', 0, null, 0],
    incident_type:      ['TEXT', 1, null, 0],
    priority:           ['TEXT', 1, "'normal'", 0],
    raw_narrative:      ['TEXT', 1, null, 0],
    redacted_narrative: ['TEXT', 0, null, 0],
    status:             ['TEXT', 1, "'pending'", 0],
    source:             ['TEXT', 1, null, 0],
    latitude:           ['REAL', 0, null, 0],
    longitude:          ['REAL', 0, null, 0],
    created_offline_at: ['TEXT', 1, null, 0],
    client_event_id:    ['TEXT', 1, null, 0],
    synced:             ['INTEGER', 1, '0', 0],
    last_sync_error:    ['TEXT', 0, null, 0],
    sync_attempts:      ['INTEGER', 1, '0', 0],
    permanent_failure:  ['INTEGER', 1, '0', 0],
    school_id:          ['INTEGER', 0, null, 0],
    c1_summary:         ['TEXT', 0, null, 0],
    c1_action_taken:    ['TEXT', 0, null, 0],
    c1_status_notes:    ['TEXT', 0, null, 0],
  },
  mobile_device_local: {
    device_id:     ['TEXT', 1, null, 1],
    user_id:       ['INTEGER', 1, null, 0],
    fcm_token_ref: ['TEXT', 0, null, 0],
    platform:      ['TEXT', 1, "'android'", 0],
    app_version:   ['TEXT', 0, null, 0],
    last_seen_at:  ['TEXT', 0, null, 0],
    is_active:     ['INTEGER', 1, '1', 0],
    synced:        ['INTEGER', 1, '0', 0],
  },
  offline_map_package_local: {
    package_id:      ['INTEGER', 1, null, 1],
    barangay_id:     ['INTEGER', 1, null, 0],
    version:         ['TEXT', 1, null, 0],
    file_path:       ['TEXT', 1, null, 0],
    checksum_sha256: ['TEXT', 1, null, 0],
    installed_at:    ['TEXT', 1, null, 0],
    is_active:       ['INTEGER', 1, '0', 0],
  },
  evidence_attachment_local: {
    local_id:              ['TEXT', 1, null, 1],
    server_attachment_id:  ['INTEGER', 0, null, 0],
    incident_local_id:     ['TEXT', 1, null, 0],
    type:                  ['TEXT', 1, null, 0],
    file_path:             ['TEXT', 1, null, 0],
    sha256:                ['TEXT', 1, null, 0],
    byte_size:             ['INTEGER', 1, null, 0],
    mime_type:             ['TEXT', 1, null, 0],
    synced:                ['INTEGER', 1, '0', 0],
    uploaded_url:          ['TEXT', 0, null, 0],
    last_attempt_at:       ['TEXT', 0, null, 0],
    attempts:              ['INTEGER', 1, '0', 0],
    synced_at:             ['TEXT', 0, null, 0],
    permanent_failure:     ['INTEGER', 1, '0', 0],
  },
  dispatch_local: {
    local_id:                  ['TEXT', 1, null, 1],
    server_dispatch_id:        ['INTEGER', 0, null, 0],
    server_incident_id:        ['INTEGER', 1, null, 0],
    tanod_id:                  ['INTEGER', 1, null, 0],
    priority:                  ['TEXT', 1, null, 0],
    redacted_incident_type:    ['TEXT', 0, null, 0],
    redacted_incident_summary: ['TEXT', 0, null, 0],
    latitude:                  ['REAL', 0, null, 0],
    longitude:                 ['REAL', 0, null, 0],
    route_json:                ['TEXT', 0, null, 0],
    route_status:              ['TEXT', 1, "'unavailable'", 0],
    status:                    ['TEXT', 1, null, 0],
    last_status_event_id:      ['TEXT', 0, null, 0],
    dispatched_at:             ['TEXT', 1, null, 0],
    en_route_at:               ['TEXT', 0, null, 0],
    arrived_at:                ['TEXT', 0, null, 0],
    completed_at:              ['TEXT', 0, null, 0],
    cached_at:                 ['TEXT', 1, null, 0],
    stale_after:               ['TEXT', 1, null, 0],
    synced:                    ['INTEGER', 1, '0', 0],
  },
  gps_track_local: {
    local_id:        ['TEXT', 1, null, 1],
    server_track_id: ['INTEGER', 0, null, 0],
    dispatch_id:     ['INTEGER', 0, null, 0],
    latitude:        ['REAL', 1, null, 0],
    longitude:       ['REAL', 1, null, 0],
    accuracy_m:      ['REAL', 1, null, 0],
    recorded_at:     ['TEXT', 1, null, 0],
    client_event_id: ['TEXT', 1, null, 0],
    synced:          ['INTEGER', 1, '0', 0],
    sync_attempts:   ['INTEGER', 1, '0', 0],
    permanent_failure: ['INTEGER', 1, '0', 0],
  },
  offline_queue_local: {
    queue_id:              ['INTEGER', 1, null, 1],
    client_event_id:       ['TEXT', 1, null, 0],
    payload_type:          ['TEXT', 1, null, 0],
    payload_json:          ['TEXT', 1, null, 0],
    created_offline_at:    ['TEXT', 1, null, 0],
    sync_attempts:         ['INTEGER', 1, '0', 0],
    last_attempt_at:       ['TEXT', 0, null, 0],
    reconciliation_status: ['TEXT', 1, "'pending'", 0],
  },
  // Migration 6 (2026-10 tanod workflow, contract §9).
  availability_local: {
    local_id:           ['TEXT', 1, null, 1],
    server_avail_id:    ['INTEGER', 0, null, 0],
    period_start:       ['TEXT', 1, null, 0],
    period_end:         ['TEXT', 1, null, 0],
    windows_json:       ['TEXT', 1, null, 0],
    status:             ['TEXT', 1, "'submitted'", 0],
    review_note:        ['TEXT', 0, null, 0],
    version:            ['INTEGER', 1, '1', 0],
    created_offline_at: ['TEXT', 1, null, 0],
    client_event_id:    ['TEXT', 1, null, 0],
    synced:             ['INTEGER', 1, '0', 0],
    last_sync_error:    ['TEXT', 0, null, 0],
    sync_attempts:      ['INTEGER', 1, '0', 0],
    permanent_failure:  ['INTEGER', 1, '0', 0],
  },
  accomplishment_entry_local: {
    local_id:                   ['TEXT', 1, null, 1],
    server_entry_id:            ['INTEGER', 0, null, 0],
    report_month:               ['TEXT', 1, null, 0],
    work_date:                  ['TEXT', 1, null, 0],
    accomplishment_text:        ['TEXT', 1, null, 0],
    start_time:                 ['TEXT', 0, null, 0],
    end_time:                   ['TEXT', 0, null, 0],
    duration_minutes:           ['INTEGER', 1, null, 0],
    suggested_duration_minutes: ['INTEGER', 0, null, 0],
    duration_flag:              ['INTEGER', 1, '0', 0],
    created_offline_at:         ['TEXT', 1, null, 0],
    client_event_id:            ['TEXT', 1, null, 0],
    synced:                     ['INTEGER', 1, '0', 0],
    last_sync_error:            ['TEXT', 0, null, 0],
    sync_attempts:              ['INTEGER', 1, '0', 0],
    permanent_failure:          ['INTEGER', 1, '0', 0],
  },
  referral_local: {
    local_id:           ['TEXT', 1, null, 1],
    server_referral_id: ['INTEGER', 0, null, 0],
    incident_local_id:  ['TEXT', 0, null, 0],
    server_incident_id: ['INTEGER', 0, null, 0],
    referred_to:        ['TEXT', 1, null, 0],
    other_text:         ['TEXT', 0, null, 0],
    contact_name:       ['TEXT', 0, null, 0],
    reference_no:       ['TEXT', 0, null, 0],
    referred_at:        ['TEXT', 1, null, 0],
    created_offline_at: ['TEXT', 1, null, 0],
    client_event_id:    ['TEXT', 1, null, 0],
    synced:             ['INTEGER', 1, '0', 0],
    last_sync_error:    ['TEXT', 0, null, 0],
    sync_attempts:      ['INTEGER', 1, '0', 0],
    permanent_failure:  ['INTEGER', 1, '0', 0],
  },
  school_checkin_local: {
    local_id:          ['TEXT', 1, null, 1],
    server_checkin_id: ['INTEGER', 0, null, 0],
    school_id:         ['INTEGER', 1, null, 0],
    school_name:       ['TEXT', 1, null, 0],
    checked_in_at:     ['TEXT', 1, null, 0],
    checked_out_at:    ['TEXT', 0, null, 0],
    checkout_event_id: ['TEXT', 0, null, 0],
    checkout_pending:  ['INTEGER', 1, '0', 0],
    client_event_id:   ['TEXT', 1, null, 0],
    synced:            ['INTEGER', 1, '0', 0],
    last_sync_error:   ['TEXT', 0, null, 0],
    sync_attempts:     ['INTEGER', 1, '0', 0],
    permanent_failure: ['INTEGER', 1, '0', 0],
  },
  school_local: {
    school_id:   ['INTEGER', 1, null, 1],
    name:        ['TEXT', 1, null, 0],
    school_type: ['TEXT', 0, null, 0],
    level:       ['TEXT', 0, null, 0],
    address:     ['TEXT', 0, null, 0],
    latitude:    ['REAL', 0, null, 0],
    longitude:   ['REAL', 0, null, 0],
    is_active:   ['INTEGER', 1, '1', 0],
    cached_at:   ['TEXT', 1, null, 0],
  },
};

/** Applies LOCAL_MIGRATIONS exactly the way localDatabase.ts does. */
function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
  for (let v = current; v < LOCAL_MIGRATIONS.length; v += 1) {
    for (const statement of LOCAL_MIGRATIONS[v]) db.exec(statement);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
}

console.log(`Baranguard mobile local-schema verification — ${new Date().toISOString()}`);
console.log(`Node ${process.version}, LOCAL_SCHEMA_VERSION=${LOCAL_SCHEMA_VERSION}\n`);

const db = new DatabaseSync(':memory:');

// --- 1. Migrations apply cleanly -------------------------------------------
try {
  migrate(db);
  ok('All migration statements executed without error');
} catch (error) {
  bad(`Migration failed: ${error.message}`);
  process.exit(1);
}

const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
check(userVersion === LOCAL_SCHEMA_VERSION,
  `PRAGMA user_version is ${userVersion} (expected ${LOCAL_SCHEMA_VERSION})`);

// --- 2. Exactly the expected tables exist ----------------------------------
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((r) => r.name);
check(
  tables.length === LOCAL_TABLES.length && LOCAL_TABLES.every((t) => tables.includes(t)),
  `Tables created: [${tables.join(', ')}] (expected exactly [${[...LOCAL_TABLES].sort().join(', ')}])`
);

// --- 3. Every column matches §5 column-for-column --------------------------
for (const [table, expectedCols] of Object.entries(EXPECTED)) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const actual = Object.fromEntries(
    info.map((c) => [c.name, [c.type, c.notnull, c.dflt_value ?? null, c.pk ? 1 : 0]])
  );

  const expectedNames = Object.keys(expectedCols);
  const actualNames = Object.keys(actual);
  const missing = expectedNames.filter((n) => !actualNames.includes(n));
  const extra = actualNames.filter((n) => !expectedNames.includes(n));
  check(missing.length === 0 && extra.length === 0,
    `${table}: column set matches §5 (${actualNames.length} columns)`
    + (missing.length ? ` — MISSING: ${missing.join(', ')}` : '')
    + (extra.length ? ` — UNEXPECTED: ${extra.join(', ')}` : ''));

  for (const [col, exp] of Object.entries(expectedCols)) {
    const act = actual[col];
    if (!act) continue; // already reported as missing above
    const same = act[0] === exp[0] && act[1] === exp[1] && act[2] === exp[2] && act[3] === exp[3];
    check(same,
      `${table}.${col} = ${JSON.stringify(act)}` + (same ? '' : ` (expected ${JSON.stringify(exp)})`));
  }
}

// --- 4. The UNIQUE constraint on client_event_id is really enforced --------
// §5 sync invariants depend on this being a hard database guarantee, not a
// convention the app remembers to follow.
const insertIncident = (localId, eventId) => db.prepare(
  `INSERT INTO incident_local
     (local_id, barangay_id, incident_type, raw_narrative, source, created_offline_at, client_event_id)
   VALUES (?, 1, 'theft', 'narrative', 'app', '2026-09-02T00:00:00Z', ?)`
).run(localId, eventId);

insertIncident('local-1', 'event-abc');
let duplicateRejected = false;
try {
  insertIncident('local-2', 'event-abc');
} catch {
  duplicateRejected = true;
}
check(duplicateRejected, 'incident_local.client_event_id UNIQUE actually rejects a duplicate event id');

// --- 5. Declared defaults really apply -------------------------------------
const row = db.prepare('SELECT priority, status, synced FROM incident_local WHERE local_id = ?').get('local-1');
check(row.priority === 'normal', `incident_local.priority defaults to 'normal' (got '${row.priority}')`);
check(row.status === 'pending', `incident_local.status defaults to 'pending' (got '${row.status}')`);
check(row.synced === 0, `incident_local.synced defaults to 0 (got ${row.synced})`);

db.prepare(
  `INSERT INTO mobile_device_local (device_id, user_id) VALUES ('device-1', 42)`
).run();
const device = db.prepare('SELECT platform, is_active, synced FROM mobile_device_local WHERE device_id = ?').get('device-1');
check(device.platform === 'android', `mobile_device_local.platform defaults to 'android' (got '${device.platform}')`);
check(device.is_active === 1, `mobile_device_local.is_active defaults to 1 (got ${device.is_active})`);
check(device.synced === 0, `mobile_device_local.synced defaults to 0 (got ${device.synced})`);

db.prepare(
  `INSERT INTO offline_map_package_local
     (package_id, barangay_id, version, file_path, checksum_sha256, installed_at)
   VALUES (7, 1, '2026.09.01', '/data/pkg.mbtiles', 'abc123', '2026-09-02T00:00:00Z')`
).run();
const pkg = db.prepare('SELECT is_active FROM offline_map_package_local WHERE package_id = 7').get();
check(pkg.is_active === 0,
  `offline_map_package_local.is_active defaults to 0 — a downloaded package is not active until the SHA-256 is verified (§6) (got ${pkg.is_active})`);

db.prepare(
  `INSERT INTO evidence_attachment_local
     (local_id, incident_local_id, type, file_path, sha256, byte_size, mime_type)
   VALUES ('ev-1', 'local-1', 'photo', '/data/photo.jpg', 'deadbeef', 12345, 'image/jpeg')`
).run();
const evidence = db.prepare('SELECT synced, attempts FROM evidence_attachment_local WHERE local_id = ?').get('ev-1');
check(evidence.synced === 0, `evidence_attachment_local.synced defaults to 0 (got ${evidence.synced})`);
check(evidence.attempts === 0, `evidence_attachment_local.attempts defaults to 0 (got ${evidence.attempts})`);
const evidenceFlag = db.prepare('SELECT permanent_failure FROM evidence_attachment_local WHERE local_id = ?').get('ev-1');
check(evidenceFlag.permanent_failure === 0, `evidence_attachment_local.permanent_failure defaults to 0 (got ${evidenceFlag.permanent_failure})`);
const incidentCaps = db.prepare('SELECT sync_attempts, permanent_failure FROM incident_local WHERE local_id = ?').get('local-1');
check(incidentCaps.sync_attempts === 0 && incidentCaps.permanent_failure === 0,
  `incident_local.sync_attempts/permanent_failure default to 0 (got ${incidentCaps.sync_attempts}/${incidentCaps.permanent_failure})`);

db.prepare(
  `INSERT INTO dispatch_local
     (local_id, server_incident_id, tanod_id, priority, status, dispatched_at, cached_at, stale_after)
   VALUES ('dl-1', 501, 42, 'high', 'assigned', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z', '2026-09-05T00:10:00Z')`
).run();
const dispatchRow = db.prepare('SELECT route_status, synced FROM dispatch_local WHERE local_id = ?').get('dl-1');
check(dispatchRow.route_status === 'unavailable', `dispatch_local.route_status defaults to 'unavailable' (got '${dispatchRow.route_status}')`);
check(dispatchRow.synced === 0, `dispatch_local.synced defaults to 0 (got ${dispatchRow.synced})`);

db.prepare(
  `INSERT INTO gps_track_local (local_id, latitude, longitude, accuracy_m, recorded_at, client_event_id)
   VALUES ('gt-1', 12.9186, 123.6667, 8.5, '2026-09-05T00:00:00Z', 'gps-event-1')`
).run();
let gpsDuplicateRejected = false;
try {
  db.prepare(
    `INSERT INTO gps_track_local (local_id, latitude, longitude, accuracy_m, recorded_at, client_event_id)
     VALUES ('gt-2', 12.9186, 123.6667, 8.5, '2026-09-05T00:01:00Z', 'gps-event-1')`
  ).run();
} catch {
  gpsDuplicateRejected = true;
}
check(gpsDuplicateRejected, 'gps_track_local.client_event_id UNIQUE actually rejects a duplicate event id');

db.prepare(
  `INSERT INTO offline_queue_local (client_event_id, payload_type, payload_json, created_offline_at)
   VALUES ('dq-event-1', 'dispatch_status', '{"dispatch_id":501,"status":"en_route"}', '2026-09-05T00:00:00Z')`
).run();
const queueRow = db.prepare('SELECT reconciliation_status, sync_attempts FROM offline_queue_local WHERE client_event_id = ?').get('dq-event-1');
check(queueRow.reconciliation_status === 'pending', `offline_queue_local.reconciliation_status defaults to 'pending' (got '${queueRow.reconciliation_status}')`);
check(queueRow.sync_attempts === 0, `offline_queue_local.sync_attempts defaults to 0 (got ${queueRow.sync_attempts})`);

// --- 5b. Migration 6 tables: UNIQUE client_event_id, defaults, period index ---
// Each builder inserts one row; `n` varies the non-key data so the ONLY thing a
// second insert can collide on is client_event_id (the guarantee under test).
const T0 = '2026-10-01T00:00:00Z';
const WORKFLOW_INSERTS = {
  availability_local: (id, evt, n) => db.prepare(
    `INSERT INTO availability_local (local_id, period_start, period_end, windows_json, created_offline_at, client_event_id)
     VALUES (?, ?, '2026-10-31', '[]', ?, ?)`
  ).run(id, `2026-10-${String(10 + n).padStart(2, '0')}`, T0, evt),
  accomplishment_entry_local: (id, evt, n) => db.prepare(
    `INSERT INTO accomplishment_entry_local (local_id, report_month, work_date, accomplishment_text, duration_minutes, created_offline_at, client_event_id)
     VALUES (?, '2026-10', '2026-10-01', 'Patrol', ?, ?, ?)`
  ).run(id, 60 + n, T0, evt),
  referral_local: (id, evt, n) => db.prepare(
    `INSERT INTO referral_local (local_id, referred_to, referred_at, created_offline_at, client_event_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, n === 0 ? 'pnp' : 'bfp', T0, T0, evt),
  school_checkin_local: (id, evt, n) => db.prepare(
    `INSERT INTO school_checkin_local (local_id, school_id, school_name, checked_in_at, client_event_id)
     VALUES (?, ?, 'Dao Elementary School', ?, ?)`
  ).run(id, 1 + n, T0, evt),
};
for (const [table, insertRow] of Object.entries(WORKFLOW_INSERTS)) {
  insertRow(`${table}-1`, `${table}-evt-1`, 0);
  let rejected = false;
  try {
    insertRow(`${table}-2`, `${table}-evt-1`, 1);
  } catch {
    rejected = true;
  }
  check(rejected, `${table}.client_event_id UNIQUE actually rejects a duplicate event id`);
  const flags = db.prepare(`SELECT synced, sync_attempts, permanent_failure FROM ${table} WHERE local_id = ?`).get(`${table}-1`);
  check(flags.synced === 0 && flags.sync_attempts === 0 && flags.permanent_failure === 0,
    `${table}.synced/sync_attempts/permanent_failure default to 0 (got ${flags.synced}/${flags.sync_attempts}/${flags.permanent_failure})`);
}

const referralLinks = db.prepare('SELECT incident_local_id, server_incident_id FROM referral_local WHERE local_id = ?').get('referral_local-1');
check(referralLinks.incident_local_id === null && referralLinks.server_incident_id === null,
  'referral_local.incident_local_id / server_incident_id default to NULL');

// Multiple referrals per incident are allowed (contract §5): same incident_local_id, new event ids.
db.prepare(
  `INSERT INTO referral_local (local_id, incident_local_id, referred_to, referred_at, created_offline_at, client_event_id)
   VALUES ('ref-3', 'local-1', 'pnp', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'ref-evt-3'),
          ('ref-4', 'local-1', 'bfp', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'ref-evt-4')`
).run();
check(db.prepare("SELECT COUNT(*) AS n FROM referral_local WHERE incident_local_id = 'local-1'").get().n === 2,
  'referral_local allows several referrals against one incident');

// One local availability row per period (an edit re-uses the row with a new event id).
let periodDuplicateRejected = false;
try {
  db.prepare(
    `INSERT INTO availability_local (local_id, period_start, period_end, windows_json, created_offline_at, client_event_id)
     VALUES ('availability_local-3', '2026-10-10', '2026-10-31', '[]', '2026-10-01T00:00:00Z', 'availability-evt-other')`
  ).run();
} catch {
  periodDuplicateRejected = true;
}
check(periodDuplicateRejected, 'availability_local UNIQUE(period_start, period_end) rejects a second row for the same period');
const availDefaults = db.prepare("SELECT status, version FROM availability_local WHERE local_id = 'availability_local-1'").get();
check(availDefaults.status === 'submitted' && availDefaults.version === 1,
  `availability_local.status/version default to 'submitted'/1 (got '${availDefaults.status}'/${availDefaults.version})`);
const accomplishmentDefaults = db.prepare("SELECT duration_flag, suggested_duration_minutes FROM accomplishment_entry_local WHERE local_id = 'accomplishment_entry_local-1'").get();
check(accomplishmentDefaults.duration_flag === 0 && accomplishmentDefaults.suggested_duration_minutes === null,
  'accomplishment_entry_local.duration_flag defaults to 0 and suggested_duration_minutes to NULL');
const checkoutDefaults = db.prepare("SELECT checked_out_at FROM school_checkin_local WHERE local_id = 'school_checkin_local-1'").get();
check(checkoutDefaults.checked_out_at === null, 'school_checkin_local.checked_out_at defaults to NULL (open check-in)');
const closeDefaults = db.prepare("SELECT checkout_event_id, checkout_pending FROM school_checkin_local WHERE local_id = 'school_checkin_local-1'").get();
check(closeDefaults.checkout_event_id === null && closeDefaults.checkout_pending === 0,
  'school_checkin_local.checkout_event_id defaults to NULL and checkout_pending to 0 (contract §7 close-by-reference)');

db.prepare(
  `INSERT INTO school_local (school_id, name, cached_at) VALUES (7, 'Dao Elementary School', '2026-10-01T00:00:00Z')`
).run();
const schoolRow = db.prepare('SELECT is_active, school_type, latitude FROM school_local WHERE school_id = 7').get();
check(schoolRow.is_active === 1 && schoolRow.school_type === null && schoolRow.latitude === null,
  'school_local.is_active defaults to 1 and optional columns to NULL');

// The incident's new school/C-1 columns accept values and default to NULL.
const incidentC1Default = db.prepare('SELECT school_id, c1_summary FROM incident_local WHERE local_id = ?').get('local-1');
check(incidentC1Default.school_id === null && incidentC1Default.c1_summary === null,
  'incident_local.school_id / c1_summary default to NULL');
db.prepare(
  `UPDATE incident_local SET school_id = 7, c1_summary = 'Short factual summary', c1_action_taken = 'Escorted', c1_status_notes = 'Resolved on site' WHERE local_id = 'local-1'`
).run();
check(db.prepare('SELECT school_id FROM incident_local WHERE local_id = ?').get('local-1').school_id === 7,
  'incident_local.school_id / c1_* columns accept values');

// --- 6. A device already on schema v1 upgrades to latest in place, without ----
// losing existing rows — the real-world path an already-installed app
// takes, not just a fresh install migrating 0 -> latest in one pass.
{
  const upgradeDb = new DatabaseSync(':memory:');
  for (const statement of LOCAL_MIGRATIONS[0]) upgradeDb.exec(statement);
  upgradeDb.exec('PRAGMA user_version = 1');
  upgradeDb.prepare(
    `INSERT INTO incident_local
       (local_id, barangay_id, incident_type, raw_narrative, source, created_offline_at, client_event_id)
     VALUES ('pre-upgrade', 1, 'theft', 'captured before the app updated', 'app', '2026-09-01T00:00:00Z', 'event-pre-upgrade')`
  ).run();

  migrate(upgradeDb); // brings a v1 device to LOCAL_SCHEMA_VERSION
  const upgradedVersion = Number(upgradeDb.prepare('PRAGMA user_version').get().user_version);
  check(upgradedVersion === LOCAL_SCHEMA_VERSION,
    `A device already on schema v1 upgrades to v${LOCAL_SCHEMA_VERSION} (got v${upgradedVersion})`);
  const survived = upgradeDb.prepare('SELECT COUNT(*) AS n FROM incident_local').get().n;
  check(survived === 1, `Pre-upgrade incident_local row survives the v1->v${LOCAL_SCHEMA_VERSION} migration (Rule 2)`);
  for (const laterTable of [
    'evidence_attachment_local', 'dispatch_local', 'gps_track_local', 'offline_queue_local',
    'availability_local', 'accomplishment_entry_local', 'referral_local', 'school_checkin_local', 'school_local',
  ]) {
    const hasTable = upgradeDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(laterTable);
    check(!!hasTable, `${laterTable} exists after upgrading from v1`);
  }
  upgradeDb.close();
}

// --- 6b. The real-world 2026-10 path: an installed app already on schema v5 -----
// (with an unsynced incident, a GPS point and a queued SOS) takes migration 6
// in place — nothing it captured offline is lost, and the new columns/tables
// arrive empty/NULL.
{
  const v5Db = new DatabaseSync(':memory:');
  const V5_MIGRATION_COUNT = 5;
  for (let v = 0; v < V5_MIGRATION_COUNT; v += 1) {
    for (const statement of LOCAL_MIGRATIONS[v]) v5Db.exec(statement);
    v5Db.exec(`PRAGMA user_version = ${v + 1}`);
  }
  check(Number(v5Db.prepare('PRAGMA user_version').get().user_version) === 5, 'Simulated device is on schema v5 before the 2026-10 upgrade');
  v5Db.prepare(
    `INSERT INTO incident_local (local_id, barangay_id, incident_type, raw_narrative, source, created_offline_at, client_event_id)
     VALUES ('v5-incident', 1, 'theft', 'captured on v5', 'app', '2026-09-30T00:00:00Z', 'v5-event-1')`
  ).run();
  v5Db.prepare(
    `INSERT INTO gps_track_local (local_id, latitude, longitude, accuracy_m, recorded_at, client_event_id)
     VALUES ('v5-gps', 12.9, 123.6, 9, '2026-09-30T00:00:00Z', 'v5-gps-1')`
  ).run();
  v5Db.prepare(
    `INSERT INTO offline_queue_local (client_event_id, payload_type, payload_json, created_offline_at)
     VALUES ('v5-sos-1', 'sos', '{}', '2026-09-30T00:00:00Z')`
  ).run();

  migrate(v5Db);
  check(Number(v5Db.prepare('PRAGMA user_version').get().user_version) === LOCAL_SCHEMA_VERSION,
    `A device on schema v5 upgrades to v${LOCAL_SCHEMA_VERSION}`);
  const keptIncident = v5Db.prepare("SELECT raw_narrative, synced, school_id, c1_summary, c1_action_taken, c1_status_notes FROM incident_local WHERE local_id = 'v5-incident'").get();
  check(keptIncident.raw_narrative === 'captured on v5' && keptIncident.synced === 0,
    'v5 -> v6: the unsynced incident survives with its narrative intact (Rule 7)');
  check(keptIncident.school_id === null && keptIncident.c1_summary === null && keptIncident.c1_action_taken === null && keptIncident.c1_status_notes === null,
    'v5 -> v6: pre-existing incident rows get NULL school_id / c1_* (no invented data)');
  check(v5Db.prepare('SELECT COUNT(*) AS n FROM gps_track_local').get().n === 1
    && v5Db.prepare('SELECT COUNT(*) AS n FROM offline_queue_local').get().n === 1,
    'v5 -> v6: the pending GPS point and queued SOS survive');
  for (const t of ['availability_local', 'accomplishment_entry_local', 'referral_local', 'school_checkin_local', 'school_local']) {
    check(v5Db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n === 0, `v5 -> v6: ${t} is created empty`);
  }
  v5Db.close();
}

// --- 7. Migration is idempotent (re-running must not error or double-apply) -
try {
  migrate(db);
  const v = Number(db.prepare('PRAGMA user_version').get().user_version);
  check(v === LOCAL_SCHEMA_VERSION, `Re-running migrations is a no-op (user_version still ${v})`);
  const stillThere = db.prepare('SELECT COUNT(*) AS n FROM incident_local').get().n;
  check(stillThere === 1, `Existing rows survive a re-run (${stillThere} row(s) still present) — Rule 2: local capture is durable`);
} catch (error) {
  bad(`Re-running migrations threw: ${error.message}`);
}

db.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
