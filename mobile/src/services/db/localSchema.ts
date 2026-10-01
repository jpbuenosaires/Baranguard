/**
 * localSchema.ts — the encrypted-SQLite local schema for the Tanod app,
 * transcribed from Master Reference §5 "Mobile Local".
 *
 * Sprint 2 baseline (migration 1): `incident_local`, `mobile_device_local`,
 * `offline_map_package_local`. Migration 2 adds `evidence_attachment_local`
 * (photo/voice capture). Migration 3 (Sprint 3 cut) adds `dispatch_local`,
 * `gps_track_local`, and `offline_queue_local` — M5/M6/M7's cache tables
 * and the sync-reconciliation ledger.
 *
 * `duty_status_local` is deliberately NOT created. §5 lists it, but M2's
 * duty toggle already always calls `POST /duty-status` directly online
 * (Sprint 2) and nothing in this cut adds an offline duty-toggle path — an
 * empty table nothing reads would repeat exactly the mistake Sprint 2's
 * own precedent warned against ("adding them early would create empty
 * tables no code reads"). Add it if/when an offline duty-toggle queue is
 * actually built.
 *
 * `offline_queue_local` earns a real, used purpose in this cut rather than
 * being a second generic mirror of what `incident_local`/`gps_track_local`
 * already track via their own `synced` columns: `dispatch_local` has only
 * a single `last_status_event_id` slot (§5), not room for a queue of
 * pending offline status changes, so a Tanod's offline dispatch-status
 * transitions are staged here (`payload_type='dispatch_status'`) and drained
 * into `/sync/batch`'s `dispatch_status_updates[]` by `syncService.ts`.
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
export const LOCAL_SCHEMA_VERSION = 6;

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
  //
  // UNUSED as of the M7 rendered-basemap cut (2026-09-12):
  // `mapPackageService.ts` tracks this instead via @capacitor/preferences
  // + @capacitor/filesystem, specifically so it works on the web platform
  // too — this table lives in the SQLCipher database, which
  // localDatabase.ts refuses to open outside Android by design, which
  // would have made the whole feature untestable in a browser preview.
  // See mapPackageService.ts's own header comment for the full reasoning.
  // Left in place (not dropped — Rule 2/9's "never destroy state a
  // migration created" applies to this local schema the same as the
  // backend's) for a future session to migrate onto once this path is
  // device-verified.
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
 * Statements for schema version 3 (Sprint 3: dispatch/GPS caching + sync).
 *
 * §5 `dispatch_local` — the cached assignment record M5/M6 read/render.
 * `redacted_incident_type`/`redacted_incident_summary` are cached FIELD
 * VALUES from the server (never raw_narrative — a Tanod's cached copy
 * carries only what the server already redacted/allow-listed for them),
 * so the screen still has something to show when offline. `route_status`
 * mirrors the server's own enum (`available|unavailable|stale`).
 * `stale_after` is the cache-staleness deadline computed at cache-write
 * time (§9 M6: "Cached route is labeled cached/last known") — the UI
 * compares `stale_after` against now rather than always trusting
 * `route_status='available'` from a fetch that may itself be hours old.
 * `last_status_event_id` is a SINGLE slot, not a queue: a Tanod moves
 * through the transition matrix one step at a time, so only the most
 * recent locally-applied-but-maybe-unconfirmed status change needs
 * tracking here (a queue of MULTIPLE pending status changes is what
 * `offline_queue_local` below is for).
 *
 * §5 `gps_track_local` — this device's own broadcast points staged before
 * upload; `synced` drives what `syncService.ts` still needs to send.
 *
 * §5 `offline_queue_local` — see this file's header for why this table
 * specifically stages dispatch-status transitions (not incidents/GPS,
 * which already have their own `synced` columns).
 */
const MIGRATION_003_DISPATCH_GPS_SYNC: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS dispatch_local (
    local_id                  TEXT    NOT NULL PRIMARY KEY,
    server_dispatch_id        INTEGER NULL,
    server_incident_id        INTEGER NOT NULL,
    tanod_id                  INTEGER NOT NULL,
    priority                  TEXT    NOT NULL,
    redacted_incident_type    TEXT    NULL,
    redacted_incident_summary TEXT    NULL,
    latitude                  REAL    NULL,
    longitude                 REAL    NULL,
    route_json                TEXT    NULL,
    route_status              TEXT    NOT NULL DEFAULT 'unavailable',
    status                    TEXT    NOT NULL,
    last_status_event_id      TEXT    NULL,
    dispatched_at             TEXT    NOT NULL,
    en_route_at               TEXT    NULL,
    arrived_at                TEXT    NULL,
    completed_at              TEXT    NULL,
    cached_at                 TEXT    NOT NULL,
    stale_after               TEXT    NOT NULL,
    synced                    INTEGER NOT NULL DEFAULT 0
  )`,
  // M5's "Assignments List" reads active (non-terminal) assignments most
  // often; this index backs that scan without a full table scan.
  `CREATE INDEX IF NOT EXISTS idx_dispatch_local_status
     ON dispatch_local (status, dispatched_at)`,

  `CREATE TABLE IF NOT EXISTS gps_track_local (
    local_id        TEXT    NOT NULL PRIMARY KEY,
    server_track_id INTEGER NULL,
    dispatch_id     INTEGER NULL,
    latitude        REAL    NOT NULL,
    longitude       REAL    NOT NULL,
    accuracy_m      REAL    NOT NULL,
    recorded_at     TEXT    NOT NULL,
    client_event_id TEXT    NOT NULL UNIQUE,
    synced          INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gps_track_local_unsynced
     ON gps_track_local (synced, recorded_at)`,

  `CREATE TABLE IF NOT EXISTS offline_queue_local (
    queue_id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    client_event_id    TEXT    NOT NULL UNIQUE,
    payload_type       TEXT    NOT NULL,
    payload_json       TEXT    NOT NULL,
    created_offline_at TEXT    NOT NULL,
    sync_attempts      INTEGER NOT NULL DEFAULT 0,
    last_attempt_at    TEXT    NULL,
    reconciliation_status TEXT NOT NULL DEFAULT 'pending'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_offline_queue_local_pending
     ON offline_queue_local (reconciliation_status, created_offline_at)`,
];

/**
 * Statements for schema version 4 (Mobile Improvement Plan Phase 3.2/3.3:
 * evidence upload + the cleanup rule that depends on knowing WHEN a row
 * synced). `evidence_attachment_local.synced` (migration 2) already says
 * WHETHER a row uploaded; nothing recorded WHEN, so Phase 3.3's "clear
 * the local binary 30+ days after a CONFIRMED upload" rule had nothing to
 * measure the 30 days FROM. `local_id` (already a stable client UUID,
 * minted once at capture time — see evidenceRepository.ts) doubles as the
 * server's `client_request_id` idempotency key; no separate column is
 * needed for that half.
 */
const MIGRATION_004_EVIDENCE_SYNC_TRACKING: readonly string[] = [
  `ALTER TABLE evidence_attachment_local ADD COLUMN synced_at TEXT NULL`,
];

/**
 * Statements for schema version 5 (sync hardening: poison-item caps). A row
 * the server keeps rejecting (incident/GPS 'failed' results) or a file that
 * can never upload (evidence) used to be retried on every pass forever —
 * `sync_attempts` counts server-reported failures and `permanent_failure`
 * takes the row out of the automatic retry set once a cap is hit. The row
 * itself is never deleted (Rule 2/7: capture is durable); a manual "Retry"
 * from the sync modal resets both. Evidence already had `attempts` (migration
 * 2), so it only needs the flag. Offline-queue items need no new column:
 * `offline_queue_local.sync_attempts`/`reconciliation_status='failed'`
 * already exist.
 */
const MIGRATION_005_SYNC_FAILURE_CAPS: readonly string[] = [
  `ALTER TABLE incident_local ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE incident_local ADD COLUMN permanent_failure INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE gps_track_local ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE gps_track_local ADD COLUMN permanent_failure INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE evidence_attachment_local ADD COLUMN permanent_failure INTEGER NOT NULL DEFAULT 0`,
];

/**
 * Statements for schema version 6 (2026-10 tanod workflow build; contract
 * `docs/FEATURE_CONTRACT_2026-10.md` §9): availability submission,
 * accomplishment-report entries, incident referrals, school check-in/out,
 * the read-only school cache, and the Safer School Zones link/Annex C-1
 * fields on `incident_local`.
 *
 * The four write tables follow `incident_local`/`gps_track_local`'s pattern:
 * a stable `client_event_id` minted at first save (never regenerated on
 * retry), `synced` + `sync_attempts` + `permanent_failure` for the same
 * retry-cap / needs-attention behaviour as the existing kinds, and rows are
 * never deleted by sync (Rule 7). `school_local` is a read-only cache of
 * `GET /schools`; it carries no school staff contact data and nothing about
 * students (the contract forbids student data of any kind).
 *
 * `referral_local.incident_local_id` lets a Tanod refer an incident that has
 * only ever existed on this phone: at sync time the referral is sent with
 * `incident_client_event_id` instead of `incident_id` (contract §5/§6).
 * `school_checkin_local` closes a check-in per contract §7: if the check-in
 * has NOT synced yet, `checked_out_at` is merged into the single create item;
 * if it already synced, a NEW item `{client_event_id: checkout_event_id,
 * closes_client_event_id: client_event_id, checked_out_at}` is queued
 * (`checkout_pending = 1`) — re-sending the same event id would be answered
 * 'duplicate' by the server's ledger and the check-out lost. `school_name` is
 * denormalised so history still reads correctly if the cached school list
 * changes.
 */
const MIGRATION_006_TANOD_WORKFLOW: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS availability_local (
    local_id            TEXT    NOT NULL PRIMARY KEY,
    server_avail_id     INTEGER NULL,
    period_start        TEXT    NOT NULL,
    period_end          TEXT    NOT NULL,
    windows_json        TEXT    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'submitted',
    review_note         TEXT    NULL,
    version             INTEGER NOT NULL DEFAULT 1,
    created_offline_at  TEXT    NOT NULL,
    client_event_id     TEXT    NOT NULL UNIQUE,
    synced              INTEGER NOT NULL DEFAULT 0,
    last_sync_error     TEXT    NULL,
    sync_attempts       INTEGER NOT NULL DEFAULT 0,
    permanent_failure   INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_availability_local_period
     ON availability_local (period_start, period_end)`,
  `CREATE INDEX IF NOT EXISTS idx_availability_local_unsynced
     ON availability_local (synced, created_offline_at)`,

  `CREATE TABLE IF NOT EXISTS accomplishment_entry_local (
    local_id                    TEXT    NOT NULL PRIMARY KEY,
    server_entry_id             INTEGER NULL,
    report_month                TEXT    NOT NULL,
    work_date                   TEXT    NOT NULL,
    accomplishment_text         TEXT    NOT NULL,
    start_time                  TEXT    NULL,
    end_time                    TEXT    NULL,
    duration_minutes            INTEGER NOT NULL,
    suggested_duration_minutes  INTEGER NULL,
    duration_flag               INTEGER NOT NULL DEFAULT 0,
    created_offline_at          TEXT    NOT NULL,
    client_event_id             TEXT    NOT NULL UNIQUE,
    synced                      INTEGER NOT NULL DEFAULT 0,
    last_sync_error             TEXT    NULL,
    sync_attempts               INTEGER NOT NULL DEFAULT 0,
    permanent_failure           INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_accomplishment_local_month
     ON accomplishment_entry_local (report_month, work_date)`,
  `CREATE INDEX IF NOT EXISTS idx_accomplishment_local_unsynced
     ON accomplishment_entry_local (synced, created_offline_at)`,

  `CREATE TABLE IF NOT EXISTS referral_local (
    local_id            TEXT    NOT NULL PRIMARY KEY,
    server_referral_id  INTEGER NULL,
    incident_local_id   TEXT    NULL,
    server_incident_id  INTEGER NULL,
    referred_to         TEXT    NOT NULL,
    other_text          TEXT    NULL,
    contact_name        TEXT    NULL,
    reference_no        TEXT    NULL,
    referred_at         TEXT    NOT NULL,
    created_offline_at  TEXT    NOT NULL,
    client_event_id     TEXT    NOT NULL UNIQUE,
    synced              INTEGER NOT NULL DEFAULT 0,
    last_sync_error     TEXT    NULL,
    sync_attempts       INTEGER NOT NULL DEFAULT 0,
    permanent_failure   INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_referral_local_unsynced
     ON referral_local (synced, created_offline_at)`,
  `CREATE INDEX IF NOT EXISTS idx_referral_local_incident
     ON referral_local (incident_local_id, server_incident_id)`,

  `CREATE TABLE IF NOT EXISTS school_checkin_local (
    local_id            TEXT    NOT NULL PRIMARY KEY,
    server_checkin_id   INTEGER NULL,
    school_id           INTEGER NOT NULL,
    school_name         TEXT    NOT NULL,
    checked_in_at       TEXT    NOT NULL,
    checked_out_at      TEXT    NULL,
    checkout_event_id   TEXT    NULL,
    checkout_pending    INTEGER NOT NULL DEFAULT 0,
    client_event_id     TEXT    NOT NULL UNIQUE,
    synced              INTEGER NOT NULL DEFAULT 0,
    last_sync_error     TEXT    NULL,
    sync_attempts       INTEGER NOT NULL DEFAULT 0,
    permanent_failure   INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_checkin_local_unsynced
     ON school_checkin_local (synced, checked_in_at)`,

  `CREATE TABLE IF NOT EXISTS school_local (
    school_id   INTEGER NOT NULL PRIMARY KEY,
    name        TEXT    NOT NULL,
    school_type TEXT    NULL,
    level       TEXT    NULL,
    address     TEXT    NULL,
    latitude    REAL    NULL,
    longitude   REAL    NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    cached_at   TEXT    NOT NULL
  )`,

  `ALTER TABLE incident_local ADD COLUMN school_id INTEGER NULL`,
  `ALTER TABLE incident_local ADD COLUMN c1_summary TEXT NULL`,
  `ALTER TABLE incident_local ADD COLUMN c1_action_taken TEXT NULL`,
  `ALTER TABLE incident_local ADD COLUMN c1_status_notes TEXT NULL`,
];

/**
 * Ordered migrations. Index 0 takes the DB from user_version 0 -> 1,
 * index 1 takes it 1 -> 2, and so on. Append only — never edit a
 * released entry (same rule as the backend's completed migration files).
 */
export const LOCAL_MIGRATIONS: readonly (readonly string[])[] = [
  MIGRATION_001_BASELINE,
  MIGRATION_002_EVIDENCE,
  MIGRATION_003_DISPATCH_GPS_SYNC,
  MIGRATION_004_EVIDENCE_SYNC_TRACKING,
  MIGRATION_005_SYNC_FAILURE_CAPS,
  MIGRATION_006_TANOD_WORKFLOW,
];

/** Every table this cut is responsible for, for assertions/diagnostics. */
export const LOCAL_TABLES = [
  'incident_local',
  'mobile_device_local',
  'offline_map_package_local',
  'evidence_attachment_local',
  'dispatch_local',
  'gps_track_local',
  'offline_queue_local',
  'availability_local',
  'accomplishment_entry_local',
  'referral_local',
  'school_checkin_local',
  'school_local',
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
  /** Server-reported failures so far (migration 5). */
  sync_attempts: number;
  /** 0/1 — set once the retry cap is hit; excluded from automatic sync until a manual retry (migration 5). */
  permanent_failure: number;
  /** Safer School Zones link (migration 6) — server school id from the cached school list, or null. */
  school_id: number | null;
  /** Annex C-1 short factual non-identifying summary (migration 6). Never victim/student names. */
  c1_summary: string | null;
  c1_action_taken: string | null;
  c1_status_notes: string | null;
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
  /** ISO 8601 UTC — when a successful upload was CONFIRMED (migration 4), for Phase 3.3's 30-day cleanup rule. Null until then. */
  synced_at: string | null;
  /** 0/1 — retry cap hit (migration 5); excluded from automatic upload until a manual retry. */
  permanent_failure: number;
}

export interface DispatchLocalRow {
  local_id: string;
  server_dispatch_id: number | null;
  server_incident_id: number;
  tanod_id: number;
  priority: string;
  redacted_incident_type: string | null;
  redacted_incident_summary: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Cached route geometry, JSON-encoded (mirrors server `dispatch.route_json`). */
  route_json: string | null;
  route_status: string;
  status: string;
  /** client_event_id of the most recent locally-applied-but-maybe-unconfirmed status change. */
  last_status_event_id: string | null;
  dispatched_at: string;
  en_route_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  /** ISO 8601 UTC string — when this row was last refreshed from the server. */
  cached_at: string;
  /** ISO 8601 UTC string — past this, the UI must label the cache stale/last-known (§9 M6). */
  stale_after: string;
  synced: number;
}

export interface GpsTrackLocalRow {
  local_id: string;
  server_track_id: number | null;
  dispatch_id: number | null;
  latitude: number;
  longitude: number;
  accuracy_m: number;
  /** ISO 8601 UTC string (§5) — device capture time. */
  recorded_at: string;
  client_event_id: string;
  synced: number;
  /** Server-reported failures so far (migration 5). */
  sync_attempts: number;
  /** 0/1 — retry cap hit (migration 5); excluded from automatic sync until a manual retry. */
  permanent_failure: number;
}

/** §5 offline_queue_local.payload_type enum. */
export type OfflineQueuePayloadType = 'incident' | 'gps' | 'duty_status' | 'sos' | 'dispatch_status';

export interface OfflineQueueLocalRow {
  queue_id: number;
  client_event_id: string;
  payload_type: OfflineQueuePayloadType;
  /** JSON-encoded payload, encrypted at rest via whole-database SQLCipher (§5). */
  payload_json: string;
  /** ISO 8601 UTC string (§5). */
  created_offline_at: string;
  sync_attempts: number;
  last_attempt_at: string | null;
  reconciliation_status: 'pending' | 'success' | 'duplicate' | 'failed';
}

// --- Migration 6 row types (tanod workflow, 2026-10) ------------------------

/** Contract §3 `tanod_availability.status`. */
export type AvailabilityStatus = 'submitted' | 'accepted' | 'revised';

/** One availability window — Manila local date + HH:MM times (contract §3). */
export interface AvailabilityWindow {
  date: string;
  start: string;
  end: string;
}

export interface AvailabilityLocalRow {
  local_id: string;
  server_avail_id: number | null;
  /** YYYY-MM-DD, Manila local date. */
  period_start: string;
  period_end: string;
  /** JSON-encoded `AvailabilityWindow[]`. */
  windows_json: string;
  status: AvailabilityStatus;
  review_note: string | null;
  version: number;
  created_offline_at: string;
  client_event_id: string;
  synced: number;
  last_sync_error: string | null;
  sync_attempts: number;
  permanent_failure: number;
}

export interface AccomplishmentEntryLocalRow {
  local_id: string;
  server_entry_id: number | null;
  /** YYYY-MM of `work_date` (Manila). */
  report_month: string;
  /** YYYY-MM-DD, Manila local date. */
  work_date: string;
  accomplishment_text: string;
  /** HH:MM or null. */
  start_time: string | null;
  end_time: string | null;
  /** The Tanod's CONFIRMED duration, 1..1440. */
  duration_minutes: number;
  /** Server-computed from on_duty intervals; null until the entry has synced and been read back. */
  suggested_duration_minutes: number | null;
  /** 0/1 — server flag, set when confirmed vs suggested differ by more than the server's margin. */
  duration_flag: number;
  created_offline_at: string;
  client_event_id: string;
  synced: number;
  last_sync_error: string | null;
  sync_attempts: number;
  permanent_failure: number;
}

/** Contract §5 `incident_referral.referred_to`. */
export type ReferralTarget =
  | 'pnp'
  | 'bfp'
  | 'ambulance_ems'
  | 'barangay_official'
  | 'vaw_desk'
  | 'social_welfare'
  | 'higher_lgu'
  | 'doh'
  | 'dpwh'
  | 'other';

export interface ReferralLocalRow {
  local_id: string;
  server_referral_id: number | null;
  /** Set for a referral raised against an incident captured on this phone. */
  incident_local_id: string | null;
  /** Set for a referral raised against a dispatch's server incident. */
  server_incident_id: number | null;
  referred_to: ReferralTarget;
  other_text: string | null;
  /** The receiving unit/official — never a citizen. */
  contact_name: string | null;
  reference_no: string | null;
  referred_at: string;
  created_offline_at: string;
  client_event_id: string;
  synced: number;
  last_sync_error: string | null;
  sync_attempts: number;
  permanent_failure: number;
}

export interface SchoolCheckinLocalRow {
  local_id: string;
  server_checkin_id: number | null;
  school_id: number;
  school_name: string;
  checked_in_at: string;
  checked_out_at: string | null;
  /** Event id of the separate "close" sync item; set only when the check-in had already synced before check-out. */
  checkout_event_id: string | null;
  /** 0/1 — a close item still has to reach the server. */
  checkout_pending: number;
  client_event_id: string;
  synced: number;
  last_sync_error: string | null;
  sync_attempts: number;
  permanent_failure: number;
}

export interface SchoolLocalRow {
  school_id: number;
  name: string;
  school_type: string | null;
  level: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  is_active: number;
  cached_at: string;
}
