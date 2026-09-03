/**
 * offlineQueueRepository.ts — `offline_queue_local` (§5).
 *
 * Used specifically for dispatch-status transitions made offline — see
 * `localSchema.ts`'s file header for why this is the one payload type
 * that needs a real queue rather than a `synced` column on its own
 * business table (`dispatch_local` has only a single
 * `last_status_event_id` slot, not room for multiple pending changes).
 * `incident`/`gps` sync state is read directly off `incident_local`/
 * `gps_track_local`'s own `synced` columns instead — this repository is
 * NOT a generic mirror of those.
 */

import { openLocalDatabase } from './localDatabase';
import type { OfflineQueueLocalRow } from './localSchema';

export interface DispatchStatusQueuePayload {
  dispatchLocalId: string;
  serverDispatchId: number;
  status: 'en_route' | 'arrived' | 'completed';
}

/**
 * Stages a dispatch-status change offline, keyed by the client_event_id
 * already minted for it (`dispatchRepository.applyLocalStatusChange`'s
 * return value / `dispatch_local.last_status_event_id`) — the same
 * identity that would have been used had the direct PATCH succeeded.
 */
export async function enqueueDispatchStatusChange(
  clientEventId: string,
  payload: DispatchStatusQueuePayload
): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `INSERT INTO offline_queue_local (client_event_id, payload_type, payload_json, created_offline_at)
     VALUES (?, 'dispatch_status', ?, ?)`,
    [clientEventId, JSON.stringify(payload), new Date().toISOString()],
    /* transaction */ false
  );
}

/** Pending dispatch_status queue items, oldest first (§5 sync invariants). */
export async function listPendingDispatchStatusUpdates(): Promise<
  { queueId: number; clientEventId: string; payload: DispatchStatusQueuePayload }[]
> {
  const db = await openLocalDatabase();
  const result = await db.query(
    `SELECT * FROM offline_queue_local
     WHERE payload_type = 'dispatch_status' AND reconciliation_status = 'pending'
     ORDER BY created_offline_at ASC`
  );
  const rows = (result.values ?? []) as OfflineQueueLocalRow[];
  return rows.map((row) => ({
    queueId: row.queue_id,
    clientEventId: row.client_event_id,
    payload: JSON.parse(row.payload_json) as DispatchStatusQueuePayload,
  }));
}

/**
 * Records the outcome of a sync attempt for one queued item. A 'failed'
 * outcome (the server rejected the underlying transition, e.g. it was
 * already superseded by a later change) is left as a terminal state
 * rather than retried automatically — retrying an event the server has
 * already told us is invalid would just fail again.
 */
export async function markQueueItemResolved(
  queueId: number,
  status: 'success' | 'duplicate' | 'failed'
): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE offline_queue_local
       SET reconciliation_status = ?, sync_attempts = sync_attempts + 1, last_attempt_at = ?
     WHERE queue_id = ?`,
    [status, new Date().toISOString(), queueId],
    /* transaction */ false
  );
}
