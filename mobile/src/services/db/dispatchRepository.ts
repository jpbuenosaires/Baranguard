/**
 * dispatchRepository.ts — the local cache for `dispatch_local` (§5),
 * backing M5 Assignments List and M6 Assignment Detail/Navigation so both
 * screens keep working when the workstation/API is unreachable (§9 M5:
 * "Reads cached assignments so the screen still works when the
 * workstation/API is unreachable. Shows stale/cached indicator.").
 *
 * Server-sourced rows use a DETERMINISTIC local_id ('srv-<server_dispatch_id>')
 * rather than a fresh UUID per cache refresh — refreshing upserts the same
 * row instead of accumulating a duplicate every time M5 polls
 * `GET /dispatch`.
 */

import { openLocalDatabase } from './localDatabase';
import type { DispatchLocalRow } from './localSchema';
import type { DispatchEntry } from '../apiService';
import { uuid } from '../uuid';

/**
 * How long a cached dispatch snapshot is treated as fresh before the UI
 * must switch to a cached/last-known label (§9 M6). Not a number §6/§5
 * states explicitly — resolved here (logged in DEVLOG.md) at 10 minutes:
 * long enough that a normal refresh cadence never flickers into "stale",
 * short enough that a genuinely disconnected Tanod sees an honest label
 * within one shift, not days later.
 */
const CACHE_FRESH_MINUTES = 10;

function localIdForServer(serverDispatchId: number): string {
  return `srv-${serverDispatchId}`;
}

/**
 * Upserts one page of `GET /dispatch` results into the cache. Deliberately
 * does not delete rows absent from this page — a completed dispatch that
 * fell out of the default query window stays in the cache as history
 * rather than vanishing from a Tanod's own device.
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
        /* transaction */ false
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
  const result = await db.query(
    "SELECT * FROM dispatch_local WHERE status NOT IN ('completed','cancelled') ORDER BY dispatched_at DESC"
  );
  return (result.values ?? []) as DispatchLocalRow[];
}

/** One cached assignment by its local_id — M6's detail screen. */
export async function getCachedDispatch(localId: string): Promise<DispatchLocalRow | null> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT * FROM dispatch_local WHERE local_id = ?', [localId]);
  const row = result.values?.[0] as DispatchLocalRow | undefined;
  return row ?? null;
}

/** True once `stale_after` has passed — the cache must be labeled cached/last-known, not live (§9 M6). */
export function isCacheStale(row: DispatchLocalRow): boolean {
  return new Date(row.stale_after).getTime() <= Date.now();
}

const NEXT_STATUS: Record<string, 'en_route' | 'arrived' | 'completed' | undefined> = {
  assigned: 'en_route',
  en_route: 'arrived',
  arrived: 'completed',
};

/**
 * The only forward transition available from a cached status, or null at a
 * terminal one. §9 M6: "A client must not locally skip states" — this is
 * the one place that rule is enforced client-side (the server enforces it
 * independently and authoritatively either way).
 */
export function nextStatusFor(currentStatus: string): 'en_route' | 'arrived' | 'completed' | null {
  return NEXT_STATUS[currentStatus] ?? null;
}

/**
 * Applies a status transition to the LOCAL cache immediately (optimistic
 * update — §9 M6: "status changes may be made offline"), stamping
 * `last_status_event_id` with a fresh client_event_id. The caller either
 * confirms it online right away (`apiService.updateDispatchStatus`) or, on
 * failure, hands the SAME event id to `offlineQueueRepository.ts` for
 * later sync — one identity follows whichever path succeeds (§5 sync
 * invariants).
 */
export async function applyLocalStatusChange(
  localId: string,
  newStatus: 'en_route' | 'arrived' | 'completed'
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
    /* transaction */ false
  );

  return { clientEventId };
}

/** Marks a cached dispatch's pending status change as confirmed by the server. */
export async function markStatusSynced(localId: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    'UPDATE dispatch_local SET synced = 1, last_status_event_id = NULL WHERE local_id = ?',
    [localId],
    /* transaction */ false
  );
}
