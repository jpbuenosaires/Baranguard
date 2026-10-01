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
  /**
   * Safer School Zones link (contract §7) — a server school id from the cached
   * `school_local` list. Optional; null for an ordinary incident.
   */
  schoolId?: number | null;
  /**
   * Annex C-1 fields: SHORT, FACTUAL and NON-IDENTIFYING. They are separate
   * from `rawNarrative` and must never carry the name of a student or victim
   * (the screen says so next to the inputs). Max `C1_FIELD_MAX` characters each.
   */
  c1Summary?: string | null;
  c1ActionTaken?: string | null;
  c1StatusNotes?: string | null;
}

/** Contract §7: each C-1 field is VARCHAR(500). */
export const C1_FIELD_MAX = 500;

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
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
  for (const value of [input.c1Summary, input.c1ActionTaken, input.c1StatusNotes]) {
    if ((value ?? '').trim().length > C1_FIELD_MAX) {
      throw new Error(`Keep each school-incident note under ${C1_FIELD_MAX} characters.`);
    }
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
          status, source, latitude, longitude, created_offline_at, client_event_id, synced,
          school_id, c1_summary, c1_action_taken, c1_status_notes)
       VALUES (?, ?, ?, ?, 'normal', ?, 'pending', 'app', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
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
        input.schoolId ?? null,
        blankToNull(input.c1Summary),
        blankToNull(input.c1ActionTaken),
        blankToNull(input.c1StatusNotes),
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
  // 'queued' becomes reachable once syncService.ts has actually attempted
  // (and not yet resolved) an upload for this row — see markIncidentSynced/
  // markIncidentSyncFailed below, added for Sprint 3's /sync/batch worker.
  return 'saved_locally';
}

// --- Sprint 3: /sync/batch worker support -----------------------------------
// Everything below is read/written by `syncService.ts`, never by M3/M4
// directly — the capture screens only ever read the row back via
// `getLocalIncident`/`deriveSyncState` above.

/**
 * Every incident this DEVICE has ever captured, newest first — M14 "My
 * Reports" (Mobile Improvement Plan Phase 2.2). Deliberately not scoped
 * to unsynced-only like `listUnsyncedIncidents()` below: a Tanod checking
 * "what happened to the report I filed" needs to see synced rows too, not
 * just the ones still in flight.
 */
export async function listAllLocalIncidents(): Promise<IncidentLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT * FROM incident_local ORDER BY created_offline_at DESC');
  return (result.values ?? []) as IncidentLocalRow[];
}

/**
 * Rows not yet confirmed by the server, oldest first (§5 sync invariants).
 * Rows that hit the retry cap (`permanent_failure`) are excluded — they stay
 * on the device (Rule 2) but wait for a manual retry, so one poison row can't
 * be re-sent on every pass forever or crowd out healthy ones.
 */
export async function listUnsyncedIncidents(): Promise<IncidentLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query(
    'SELECT * FROM incident_local WHERE synced = 0 AND permanent_failure = 0 ORDER BY created_offline_at ASC'
  );
  return (result.values ?? []) as IncidentLocalRow[];
}

/**
 * Applies a successful (or duplicate-reconciled) sync result. `serverId`
 * is null only in the pathological case where the server reported success
 * without one — treated the same as a reconciled duplicate by
 * `deriveSyncState` above, never as an error.
 */
export async function markIncidentSynced(clientEventId: string, serverId: number | null): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    'UPDATE incident_local SET synced = 1, server_incident_id = ?, last_sync_error = NULL WHERE client_event_id = ?',
    [serverId, clientEventId],
    /* transaction */ false
  );
}

/**
 * Records why a sync attempt failed, for M4's "needs_attention" state
 * (deriveSyncState above). Counts one server-reported failure and flips
 * `permanent_failure` once `maxAttempts` is reached.
 */
export async function markIncidentSyncFailed(
  clientEventId: string,
  reason: string,
  maxAttempts: number
): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE incident_local
       SET last_sync_error = ?, sync_attempts = sync_attempts + 1,
           permanent_failure = CASE WHEN sync_attempts + 1 >= ? THEN 1 ELSE permanent_failure END
     WHERE client_event_id = ?`,
    [reason, maxAttempts, clientEventId],
    /* transaction */ false
  );
}

/** Unsynced incidents that hit the retry cap — the "needs attention" count. */
export async function countPermanentlyFailedIncidents(): Promise<number> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT COUNT(*) AS n FROM incident_local WHERE synced = 0 AND permanent_failure = 1');
  return Number((result.values?.[0] as { n: number } | undefined)?.n ?? 0);
}

/** Manual retry: puts capped incidents back into the automatic sync set. */
export async function resetFailedIncidents(): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    'UPDATE incident_local SET permanent_failure = 0, sync_attempts = 0, last_sync_error = NULL WHERE synced = 0 AND permanent_failure = 1',
    [],
    /* transaction */ false
  );
}
