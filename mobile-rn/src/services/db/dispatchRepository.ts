/**
 * Local cache for `dispatch_local`, backing M5 Assignments List and M6
 * Assignment Detail so both keep working when the workstation/API is
 * unreachable. Ported from ../mobile's dispatchRepository.ts, unchanged.
 *
 * Server-sourced rows use a DETERMINISTIC local_id ('srv-<id>') rather than
 * a fresh UUID per refresh, so refreshing upserts instead of accumulating
 * duplicates every time M5 polls `GET /dispatch`.
 */
import { openLocalDatabase } from './localDatabase';
import type { DispatchLocalRow } from './localSchema';
import type { DispatchEntry } from '../apiService';
import { uuid } from '../uuid';

/**
 * How long a cached dispatch snapshot is treated as fresh before the UI
 * must switch to a cached/last-known label. 10 minutes: long enough that a
 * normal refresh cadence never flickers into "stale", short enough that a
 * genuinely disconnected Tanod sees an honest label within one shift.
 */
const CACHE_FRESH_MINUTES = 10;

function localIdForServer(serverDispatchId: number): string {
  return `srv-${serverDispatchId}`;
}

/**
 * Upserts one page of `GET /dispatch` results into the cache. Does not
 * delete rows absent from this page — a completed dispatch that fell out
 * of the default query window stays in the cache as history.
 */
export async function cacheDispatchesFromServer(entries: DispatchEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openLocalDatabase();
  const now = new Date();
  const cachedAt = now.toISOString();
  const staleAfter = new Date(now.getTime() + CACHE_FRESH_MINUTES * 60 * 1000).toISOString();

  await db.beginTransaction();
  try {
    for (const entry of entries) {
      const localId = localIdForServer(entry.dispatchId);
      await db.run(
        `INSERT INTO dispatch_local
           (local_id, server_dispatch_id, server_incident_id, tanod_id, priority, redacted_incident_type,
            latitude, longitude, route_json, route_status,
            status, dispatched_at, en_route_at, arrived_at, completed_at, cached_at, stale_after, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(local_id) DO UPDATE SET
           server_dispatch_id = excluded.server_dispatch_id,
           priority = excluded.priority,
           redacted_incident_type = excluded.redacted_incident_type,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           route_json = excluded.route_json,
           route_status = excluded.route_status,
           status = excluded.status,
           en_route_at = excluded.en_route_at,
           arrived_at = excluded.arrived_at,
           completed_at = excluded.completed_at,
           cached_at = excluded.cached_at,
           stale_after = excluded.stale_after,
           synced = 1`,
        [
          localId,
          entry.dispatchId,
          entry.incidentId,
          entry.tanodId,
          entry.priority,
          entry.incidentType,
          entry.latitude,
          entry.longitude,
          entry.routeJson ? JSON.stringify(entry.routeJson) : null,
          entry.routeStatus,
          entry.status,
          entry.dispatchedAt,
          entry.enRouteAt,
          entry.arrivedAt,
          entry.completedAt,
          cachedAt,
          staleAfter,
        ],
      );
    }
    await db.commitTransaction();
  } catch (error) {
    await db.rollbackTransaction();
    throw error;
  }
}

/** Non-terminal cached assignments, newest first — M5's list. */
export async function listActiveCachedDispatches(): Promise<DispatchLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query<DispatchLocalRow>(
    "SELECT * FROM dispatch_local WHERE status NOT IN ('completed','cancelled') ORDER BY dispatched_at DESC",
  );
  return result.values;
}

/** One cached assignment by its local_id — M6's detail screen. */
export async function getCachedDispatch(localId: string): Promise<DispatchLocalRow | null> {
  const db = await openLocalDatabase();
  const result = await db.query<DispatchLocalRow>('SELECT * FROM dispatch_local WHERE local_id = ?', [localId]);
  return result.values[0] ?? null;
}

/** True once `stale_after` has passed — the cache must be labeled cached/last-known, not live. */
export function isCacheStale(row: DispatchLocalRow): boolean {
  return new Date(row.stale_after).getTime() <= Date.now();
}

const NEXT_STATUS: Record<string, 'en_route' | 'arrived' | 'completed' | undefined> = {
  assigned: 'en_route',
  en_route: 'arrived',
  arrived: 'completed',
};

/** The only forward transition available from a cached status, or null at a terminal one. */
export function nextStatusFor(currentStatus: string): 'en_route' | 'arrived' | 'completed' | null {
  return NEXT_STATUS[currentStatus] ?? null;
}

/**
 * Applies a status transition to the LOCAL cache immediately (optimistic
 * update), stamping `last_status_event_id` with a fresh client_event_id.
 * The caller either confirms it online right away or, on failure, hands the
 * SAME event id to `offlineQueueRepository.ts` for later sync.
 */
export async function applyLocalStatusChange(
  localId: string,
  newStatus: 'en_route' | 'arrived' | 'completed',
): Promise<{ clientEventId: string }> {
  const db = await openLocalDatabase();
  const clientEventId = uuid();
  const now = new Date().toISOString();
  const timestampColumn = { en_route: 'en_route_at', arrived: 'arrived_at', completed: 'completed_at' }[newStatus];

  await db.run(
    `UPDATE dispatch_local
       SET status = ?, ${timestampColumn} = ?, last_status_event_id = ?, synced = 0
     WHERE local_id = ?`,
    [newStatus, now, clientEventId, localId],
  );

  return { clientEventId };
}

/** Marks a cached dispatch's pending status change as confirmed by the server. */
export async function markStatusSynced(localId: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run('UPDATE dispatch_local SET synced = 1, last_status_event_id = NULL WHERE local_id = ?', [localId]);
}

/**
 * Caches the result of an explicit `apiService.getDispatchRoute()` call
 * onto the already-existing `route_json`/`route_status` columns — route
 * fetch shouldn't touch this row's status/priority/etc.
 */
export async function cacheRouteFetch(
  localId: string,
  routeJson: unknown | null,
  routeStatus: 'available' | 'unavailable' | 'stale',
): Promise<void> {
  const db = await openLocalDatabase();
  await db.run('UPDATE dispatch_local SET route_json = ?, route_status = ? WHERE local_id = ?', [
    routeJson ? JSON.stringify(routeJson) : null,
    routeStatus,
    localId,
  ]);
}
