/**
 * The M3 local write path for `incident_local`. Ported from
 * ../mobile/src/services/db/incidentRepository.ts — SQL and control flow
 * unchanged, only `openLocalDatabase`'s import path differs (see that
 * file's `CompatDb` adapter).
 *
 * Rule 2: every incident is persisted to encrypted SQLite BEFORE the user
 * can leave the capture flow, and stays available until the server
 * confirms acceptance or a duplicate is safely correlated.
 *
 * Rule 3: each local write has a stable `client_event_id`, minted HERE at
 * first save — not regenerated on retry, and reused verbatim by
 * `/sync/batch` and any SMS fallback.
 *
 * Nothing here talks to the network — capture must succeed while the
 * workstation is unreachable and while the auth session has expired.
 */
import { openLocalDatabase } from './localDatabase';
import type { IncidentLocalRow } from './localSchema';
import { uuid } from '../uuid';

/** incident.incident_type enum — the only accepted values. */
export const INCIDENT_TYPES = [
  'theft',
  'physical_injury',
  'disturbance',
  'domestic_dispute',
  'vandalism',
  'traffic_incident',
  'fire',
  'medical_emergency',
  'missing_person',
  'animal_complaint',
  'other',
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export interface NewIncidentInput {
  barangayId: number;
  /** The authenticated Tanod's user id; null only if unknown locally. */
  reportedBy: number | null;
  incidentType: IncidentType;
  rawNarrative: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface SavedIncident {
  localId: string;
  clientEventId: string;
  createdOfflineAt: string;
}

/**
 * Persists a captured incident locally and returns its identifiers.
 * Runs inside a transaction so the row is either fully written or not at
 * all — the caller must not navigate away until this resolves.
 */
export async function saveIncidentLocally(input: NewIncidentInput): Promise<SavedIncident> {
  const narrative = input.rawNarrative.trim();
  if (!narrative) {
    throw new Error('A narrative is required.');
  }
  if (!INCIDENT_TYPES.includes(input.incidentType)) {
    throw new Error('Unknown incident type.');
  }

  const db = await openLocalDatabase();

  const localId = uuid();
  // Minted once, here. /sync/batch and any SMS fallback must send THIS
  // value, not a new one.
  const clientEventId = uuid();
  const createdOfflineAt = new Date().toISOString();

  await db.beginTransaction();
  try {
    await db.run(
      `INSERT INTO incident_local
         (local_id, barangay_id, reported_by, incident_type, priority, raw_narrative,
          status, source, latitude, longitude, created_offline_at, client_event_id, synced)
       VALUES (?, ?, ?, ?, 'normal', ?, 'pending', 'app', ?, ?, ?, ?, 0)`,
      [
        localId,
        input.barangayId,
        input.reportedBy,
        input.incidentType,
        narrative,
        input.latitude ?? null,
        input.longitude ?? null,
        createdOfflineAt,
        clientEventId,
      ],
    );
    await db.commitTransaction();
  } catch (error) {
    await db.rollbackTransaction();
    throw error;
  }

  return { localId, clientEventId, createdOfflineAt };
}

/** Reads one locally-captured incident back, for M4's confirmation screen. */
export async function getLocalIncident(localId: string): Promise<IncidentLocalRow | null> {
  const db = await openLocalDatabase();
  const result = await db.query<IncidentLocalRow>('SELECT * FROM incident_local WHERE local_id = ?', [localId]);
  return result.values[0] ?? null;
}

/**
 * The sync states M4 is allowed to display. Derived strictly from what the
 * local row actually says — never claims server submission when only
 * local persistence has occurred.
 */
export type SyncState = 'saved_locally' | 'queued' | 'synced' | 'duplicate_reconciled' | 'needs_attention';

export function deriveSyncState(row: IncidentLocalRow): SyncState {
  if (row.last_sync_error) return 'needs_attention';
  if (row.synced === 1) {
    // A server id present alongside synced=1 means the server accepted and
    // correlated this record; without one, a duplicate was reconciled to
    // an existing server record.
    return row.server_incident_id === null ? 'duplicate_reconciled' : 'synced';
  }
  return 'saved_locally';
}

// --- /sync/batch worker support ---------------------------------------------
// Everything below is read/written by syncService.ts, never by the capture
// screens directly — those only read the row back via getLocalIncident/
// deriveSyncState above.

/** Every incident this device has ever captured, newest first — M14 "My Reports". */
export async function listAllLocalIncidents(): Promise<IncidentLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query<IncidentLocalRow>('SELECT * FROM incident_local ORDER BY created_offline_at DESC');
  return result.values;
}

/** Rows not yet confirmed by the server, oldest first. */
export async function listUnsyncedIncidents(): Promise<IncidentLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query<IncidentLocalRow>('SELECT * FROM incident_local WHERE synced = 0 ORDER BY created_offline_at ASC');
  return result.values;
}

/**
 * Applies a successful (or duplicate-reconciled) sync result. `serverId`
 * is null only if the server reported success without one — treated the
 * same as a reconciled duplicate by `deriveSyncState`, never as an error.
 */
export async function markIncidentSynced(clientEventId: string, serverId: number | null): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    'UPDATE incident_local SET synced = 1, server_incident_id = ?, last_sync_error = NULL WHERE client_event_id = ?',
    [serverId, clientEventId],
  );
}

/** Records why a sync attempt failed, for M4's "needs_attention" state. */
export async function markIncidentSyncFailed(clientEventId: string, reason: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run('UPDATE incident_local SET last_sync_error = ? WHERE client_event_id = ?', [reason, clientEventId]);
}
