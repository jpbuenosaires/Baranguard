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

// --- 6. A device already on schema v1 upgrades to v2 in place, without ----
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
  check(survived === 1, `Pre-upgrade incident_local row survives the v1->v2 migration (Rule 2)`);
  const hasEvidenceTable = upgradeDb.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='evidence_attachment_local'"
  ).get();
  check(!!hasEvidenceTable, 'evidence_attachment_local exists after upgrading from v1');
  upgradeDb.close();
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
