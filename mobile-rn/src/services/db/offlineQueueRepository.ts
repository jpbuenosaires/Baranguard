/**
 * `offline_queue_local` — for payload types that need a real queue rather
 * than a `synced` column on their own table: dispatch-status transitions
 * (`dispatch_local` has only one `last_status_event_id` slot) and SOS
 * (raised offline — there is no `sos_local` table at all, only this
 * queue). `incident`/`gps` sync state is read directly off their own
 * tables' `synced` columns — this is not a generic mirror of those.
 *
 * Ported from ../mobile's offlineQueueRepository.ts, unchanged.
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
 * already minted for it (`dispatchRepository.applyLocalStatusChange`) —
 * the same identity that would have been used had the direct PATCH
 * succeeded.
 */
export async function enqueueDispatchStatusChange(clientEventId: string, payload: DispatchStatusQueuePayload): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `INSERT INTO offline_queue_local (client_event_id, payload_type, payload_json, created_offline_at)
     VALUES (?, 'dispatch_status', ?, ?)`,
    [clientEventId, JSON.stringify(payload), new Date().toISOString()],
  );
}

/** Pending dispatch_status queue items, oldest first. */
export async function listPendingDispatchStatusUpdates(): Promise<
  { queueId: number; clientEventId: string; payload: DispatchStatusQueuePayload }[]
> {
  const db = await openLocalDatabase();
  const result = await db.query<OfflineQueueLocalRow>(
    `SELECT * FROM offline_queue_local
     WHERE payload_type = 'dispatch_status' AND reconciliation_status = 'pending'
     ORDER BY created_offline_at ASC`,
  );
  return result.values.map((row) => ({
    queueId: row.queue_id,
    clientEventId: row.client_event_id,
    payload: JSON.parse(row.payload_json) as DispatchStatusQueuePayload,
  }));
}

export interface SosQueuePayload {
  latitude?: number;
  longitude?: number;
  dispatchId?: number | null;
}

/**
 * Stages an SOS raised while offline, keyed by the same client_event_id
 * that would have been sent to `POST /tanod-sos` directly — the idempotency
 * guarantee applies identically whether the item goes out live or through
 * `/sync/batch`'s `sos[]` array. Coordinates are optional (C-01): an SOS
 * raised with no GPS fix still queues, and the server falls back to
 * last-known/no-fix on drain.
 */
export async function enqueueSosItem(clientEventId: string, payload: SosQueuePayload): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `INSERT INTO offline_queue_local (client_event_id, payload_type, payload_json, created_offline_at)
     VALUES (?, 'sos', ?, ?)`,
    [clientEventId, JSON.stringify(payload), new Date().toISOString()],
  );
}

/** Pending sos queue items, oldest first. */
export async function listPendingSosItems(): Promise<{ queueId: number; clientEventId: string; payload: SosQueuePayload }[]> {
  const db = await openLocalDatabase();
  const result = await db.query<OfflineQueueLocalRow>(
    `SELECT * FROM offline_queue_local
     WHERE payload_type = 'sos' AND reconciliation_status = 'pending'
     ORDER BY created_offline_at ASC`,
  );
  return result.values.map((row) => ({
    queueId: row.queue_id,
    clientEventId: row.client_event_id,
    payload: JSON.parse(row.payload_json) as SosQueuePayload,
  }));
}

/**
 * Records the outcome of a sync attempt for one queued item. A 'failed'
 * outcome is left terminal rather than retried automatically — retrying
 * an event the server has already rejected would just fail again.
 */
export async function markQueueItemResolved(queueId: number, status: 'success' | 'duplicate' | 'failed'): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE offline_queue_local
       SET reconciliation_status = ?, sync_attempts = sync_attempts + 1, last_attempt_at = ?
     WHERE queue_id = ?`,
    [status, new Date().toISOString(), queueId],
  );
}
