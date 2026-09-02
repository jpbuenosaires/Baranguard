/**
 * incidentRepository.ts — the M3 local write path for `incident_local`.
 *
 * §2 Rule 2 is the governing constraint: "Every incident is persisted to
 * encrypted mobile SQLite BEFORE the user can leave the capture flow. The
 * local record remains available until the server confirms acceptance or
 * a duplicate has been safely correlated."
 *
 * §5's sync invariants add: "each local write has a stable
 * `client_event_id`; `/sync/batch` uses that identity for deduplication;
 * SMS fallback and direct POST use the same event ID". That ID is
 * therefore minted HERE, at first save — not at sync time, and not
 * regenerated on retry. Sprint 3/4 must reuse it verbatim; inventing a
 * second identifier scheme later would break deduplication across the
 * three transports.
 *
 * Nothing in this file talks to the network. Capture must succeed while
 * the workstation is unreachable and while the auth session has expired
 * (§2 Rule 7 and Rule 9's "offline mobile capture is unaffected").
 */

import { openLocalDatabase } from './localDatabase';
import type { IncidentLocalRow } from './localSchema';

/** §5 `incident.incident_type` enum — the only accepted values. */
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

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Persists a captured incident locally and returns its identifiers.
 *
 * Runs inside a transaction so the row is either fully written or not at
 * all — "atomic before the user can leave" (Sprint 2's own wording). The
 * caller must not navigate away until this resolves.
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
  // Minted once, here. See the file header: Sprint 3's /sync/batch and
  // Sprint 4's SMS fallback must send THIS value, not a new one.
  const clientEventId = uuid();
  // §5: "All local timestamps are stored as ISO 8601 UTC strings".
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
      /* transaction */ false
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
  const result = await db.query('SELECT * FROM incident_local WHERE local_id = ?', [localId]);
  const row = result.values?.[0] as IncidentLocalRow | undefined;
  return row ?? null;
}

/**
 * The sync states §9 M4 is allowed to display. Derived strictly from what
 * the local row actually says — M4 "never claims server submission when
 * only local persistence has occurred".
 */
export type SyncState = 'saved_locally' | 'queued' | 'synced' | 'duplicate_reconciled' | 'needs_attention';

export function deriveSyncState(row: IncidentLocalRow): SyncState {
  if (row.last_sync_error) return 'needs_attention';
  if (row.synced === 1) {
    // A server id present alongside synced=1 means the server accepted
    // and correlated this record; without one, a duplicate was reconciled
    // to an existing server record.
    return row.server_incident_id === null ? 'duplicate_reconciled' : 'synced';
  }
  // Sprint 2 has no sync worker yet, so in practice every fresh capture
  // sits here. 'queued' becomes reachable once Sprint 3's /sync/batch
  // worker starts attempting uploads.
  return 'saved_locally';
}
