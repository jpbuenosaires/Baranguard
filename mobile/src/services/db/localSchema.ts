/**
 * localSchema.ts — the encrypted-SQLite local schema for the Tanod app,
 * transcribed from Master Reference §5 "Mobile Local".
 *
 * Sprint 2 baseline (migration 1): `incident_local`, `mobile_device_local`,
 * `offline_map_package_local`. Migration 2 (this follow-up cut) adds
 * `evidence_attachment_local` now that photo/voice capture is in scope —
 * see `evidenceCapture.ts`/`evidenceRepository.ts`. The remaining §5 local
 * tables (`dispatch_local`, `gps_track_local`, `duty_status_local`,
 * `offline_queue_local`) are still deliberately NOT created here — each
 * belongs to Sprint 3 (M5/M6 dispatch/GPS caching and `/sync/batch`).
 * Adding them early would create empty tables no code reads, and would
 * claim schema coverage this cut hasn't actually tested.
 *
 * DELIBERATELY PLUGIN-AGNOSTIC: this module imports nothing from
 * Capacitor. It is pure SQL strings + types, so the exact DDL that ships
 * to a device can be executed against a real SQLite engine in plain Node
 * (see `mobile/scripts/verify-local-schema.mjs`) and asserted
 * column-for-column against §5. The Capacitor/SQLCipher wiring lives
 * separately in `localDatabase.ts` — that half needs a real device to
 * verify, this half does not.
 *
 * §5 conventions honored here:
 *   - "Local integer IDs are device-local unless a server ID field is
 *     explicitly present" — hence `local_id` TEXT (a client UUID) plus a
 *     nullable `server_*_id` INTEGER on the tables that sync.
 *   - "All local timestamps are stored as ISO 8601 UTC strings; UI
 *     converts to Asia/Manila" — every *_at column is TEXT, never a
 *     numeric epoch.
 *   - Booleans are INTEGER 0/1 (SQLite has no BOOLEAN type).
 */

/**
 * Bumped whenever a migration is appended below. Tracked on the database
 * itself via `PRAGMA user_version`, mirroring the numbered-migration
 * discipline the backend uses (`backend/migrations/000N_*.sql`) rather
 * than dropping and recreating the local store — a rebuild would destroy
 * unsynced field captures, which Rule 2 ("offline capture is durable
 * until reconciliation") forbids.
 */
export const LOCAL_SCHEMA_VERSION = 2;

/** Statements for schema version 1 (Sprint 2 baseline cut). */
const MIGRATION_001_BASELINE: readonly string[] = [
  // §5: incident_local — the offline incident capture record. `raw_narrative`
  // is "encrypted at rest": that is provided by whole-database SQLCipher
  // encryption (see localDatabase.ts), not a per-column cipher, so the
  // column itself is ordinary TEXT.
  `CREATE TABLE IF NOT EXISTS incident_local (
    local_id            TEXT    NOT NULL PRIMARY KEY,
    server_incident_id  INTEGER NULL,
    barangay_id         INTEGER NOT NULL,
    reported_by         INTEGER NULL,
    incident_type       TEXT    NOT NULL,
    priority            TEXT    NOT NULL DEFAULT 'normal',
    raw_narrative       TEXT    NOT NULL,
    redacted_narrative  TEXT    NULL,
    status              TEXT    NOT NULL DEFAULT 'pending',
    source              TEXT    NOT NULL,
    latitude            REAL    NULL,
    longitude           REAL    NULL,
    created_offline_at  TEXT    NOT NULL,
    client_event_id     TEXT    NOT NULL UNIQUE,
    synced              INTEGER NOT NULL DEFAULT 0,
    last_sync_error     TEXT    NULL
  )`,
  // Sync sweeps read "everything not yet accepted by the server, oldest
  // first" (§5 sync invariants: /sync/batch processes oldest-first per
  // device), which is exactly this index.
  `CREATE INDEX IF NOT EXISTS idx_incident_local_unsynced
     ON incident_local (synced, created_offline_at)`,

  // §5: mobile_device_local — this device's own registration mirror.
  // `fcm_token_ref` is a REFERENCE/handle, not the raw FCM token (§5
  // "protected at rest"; §6 POST /devices/register "Returns no FCM
  // token") — never store the token itself here.
  `CREATE TABLE IF NOT EXISTS mobile_device_local (
    device_id     TEXT    NOT NULL PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    fcm_token_ref TEXT    NULL,
    platform      TEXT    NOT NULL DEFAULT 'android',
    app_version   TEXT    NULL,
    last_seen_at  TEXT    NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    synced        INTEGER NOT NULL DEFAULT 0
  )`,

  // §5: offline_map_package_local — installed basemap packages. NOTE
  // `package_id` is the SERVER's package id (§6 POST /map-packages
  // returns it), not a device-local autoincrement, so it is a plain
  // INTEGER PRIMARY KEY with no AUTOINCREMENT.
  `CREATE TABLE IF NOT EXISTS offline_map_package_local (
    package_id      INTEGER NOT NULL PRIMARY KEY,
    barangay_id     INTEGER NOT NULL,
    version         TEXT    NOT NULL,
    file_path       TEXT    NOT NULL,
    checksum_sha256 TEXT    NOT NULL,
    installed_at    TEXT    NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 0
  )`,
  // §14/§6: a device may hold several versions per barangay but activates
  // one at a time; this index backs "which package is active for my
  // barangay".
  `CREATE INDEX IF NOT EXISTS idx_map_package_local_barangay_active
     ON offline_map_package_local (barangay_id, is_active)`,
];

/**
 * Statements for schema version 2 (photo/voice evidence capture cut).
 *
 * §5 `evidence_attachment_local` — evidence staged/captured on this
 * device before the owning incident has a server ID. `incident_local_id`
 * (not `server_incident_id`) is the foreign reference deliberately: a
 * Tanod can attach a photo/voice note to an incident that has only ever
 * been saved locally, and that link must resolve without a network round
 * trip. `synced`/`uploaded_url`/`last_attempt_at`/`attempts` mirror the
 * upload-retry bookkeeping `incident_local` already has for its own sync
 * state, since §6 says evidence uploads individually via
 * `/incidents/:id/evidence` — a separate transport from `/sync/batch`'s
 * JSON body — once the parent incident has a server id.
 */
const MIGRATION_002_EVIDENCE: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS evidence_attachment_local (
    local_id            TEXT    NOT NULL PRIMARY KEY,
    server_attachment_id INTEGER NULL,
    incident_local_id   TEXT    NOT NULL,
    type                TEXT    NOT NULL,
    file_path           TEXT    NOT NULL,
    sha256              TEXT    NOT NULL,
    byte_size           INTEGER NOT NULL,
    mime_type           TEXT    NOT NULL,
    synced              INTEGER NOT NULL DEFAULT 0,
    uploaded_url         TEXT    NULL,
    last_attempt_at      TEXT    NULL,
    attempts             INTEGER NOT NULL DEFAULT 0
  )`,
  // Backs "all evidence for this incident" (attach-flow + M4 confirmation
  // display) and "everything still unsynced" (a future upload worker),
  // same shape as incident_local's own unsynced index.
  `CREATE INDEX IF NOT EXISTS idx_evidence_local_incident
     ON evidence_attachment_local (incident_local_id)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_local_unsynced
     ON evidence_attachment_local (synced)`,
];

/**
 * Ordered migrations. Index 0 takes the DB from user_version 0 -> 1,
 * index 1 takes it 1 -> 2, and so on. Append only — never edit a
 * released entry (same rule as the backend's completed migration files).
 */
export const LOCAL_MIGRATIONS: readonly (readonly string[])[] = [
  MIGRATION_001_BASELINE,
  MIGRATION_002_EVIDENCE,
];

/** Every table this cut is responsible for, for assertions/diagnostics. */
export const LOCAL_TABLES = [
  'incident_local',
  'mobile_device_local',
  'offline_map_package_local',
  'evidence_attachment_local',
] as const;

export type LocalTableName = (typeof LOCAL_TABLES)[number];

// --- Row types -------------------------------------------------------------
// Field names stay snake_case here because these mirror actual SQLite
// columns. §4's camelCase rule applies to the app's own domain objects and
// to the single API boundary (`apiService.ts`), not to raw row shapes —
// keeping the row type honest about the column names avoids a silent
// second translation layer inside the data access code.

export interface IncidentLocalRow {
  local_id: string;
  server_incident_id: number | null;
  barangay_id: number;
  reported_by: number | null;
  incident_type: string;
  priority: string;
  raw_narrative: string;
  redacted_narrative: string | null;
  status: string;
  source: string;
  latitude: number | null;
  longitude: number | null;
  /** ISO 8601 UTC string (§5). */
  created_offline_at: string;
  /** Stable identity for dedupe across direct POST, /sync/batch, and SMS fallback (§5). */
  client_event_id: string;
  /** 0/1 — SQLite has no boolean type. */
  synced: number;
  last_sync_error: string | null;
}

export interface MobileDeviceLocalRow {
  device_id: string;
  user_id: number;
  /** A reference/handle to the FCM registration — never the raw token (§5, §6). */
  fcm_token_ref: string | null;
  platform: string;
  app_version: string | null;
  /** ISO 8601 UTC string (§5). */
  last_seen_at: string | null;
  is_active: number;
  synced: number;
}

export interface OfflineMapPackageLocalRow {
  /** Server-assigned package id (§6 map packages), not device-local. */
  package_id: number;
  barangay_id: number;
  version: string;
  file_path: string;
  checksum_sha256: string;
  /** ISO 8601 UTC string (§5). */
  installed_at: string;
  is_active: number;
}

export interface EvidenceAttachmentLocalRow {
  local_id: string;
  server_attachment_id: number | null;
  /** FK to incident_local.local_id — resolves offline, before any server id exists. */
  incident_local_id: string;
  type: string;
  /** App-private storage path, never a public/shared location. */
  file_path: string;
  sha256: string;
  byte_size: number;
  mime_type: string;
  synced: number;
  uploaded_url: string | null;
  last_attempt_at: string | null;
  attempts: number;
}
