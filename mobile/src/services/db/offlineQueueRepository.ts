/**
 * offlineQueueRepository.ts — `offline_queue_local` (§5).
 *
 * Used for payload types that need a real queue rather than a `synced`
 * column on their own business table: dispatch-status transitions (see
 * `localSchema.ts`'s file header for why `dispatch_local` has only a
 * single `last_status_event_id` slot, not room for multiple pending
 * changes) and SOS (raised offline, §2 Rule 27 — there is no
 * `sos_local` business table at all, only this queue). `incident`/`gps`
 * sync state is read directly off `incident_local`/`gps_track_local`'s
 * own `synced` columns instead — this repository is NOT a generic
 * mirror of those.
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

export interface SosQueuePayload {
  latitude?: number;
  longitude?: number;
  dispatchId?: number | null;
  /**
   * Client timestamp (ISO 8601 UTC) of when the Tanod actually pressed SOS —
   * sent as an optional extra `created_offline_at` field so the server can
   * show how long the alert waited; a backend that doesn't know the field
   * ignores it. Stamped by `enqueueSosItem()`, never by the caller.
   */
  createdOfflineAt?: string;
}

/**
 * Stages an SOS raised while offline, keyed by the same client_event_id
 * that would have been sent to `POST /tanod-sos` directly — §2 Rule 27's
 * idempotency guarantee applies identically whether the item goes out
 * live or through `/sync/batch`'s `sos[]` array.
 */
export async function enqueueSosItem(clientEventId: string, payload: SosQueuePayload): Promise<void> {
  const db = await openLocalDatabase();
  const createdOfflineAt = new Date().toISOString();
  await db.run(
    `INSERT INTO offline_queue_local (client_event_id, payload_type, payload_json, created_offline_at)
     VALUES (?, 'sos', ?, ?)`,
    [clientEventId, JSON.stringify({ ...payload, createdOfflineAt }), createdOfflineAt],
    /* transaction */ false
  );
}

/** Pending sos queue items, oldest first (§5 sync invariants). */
export async function listPendingSosItems(): Promise<
  { queueId: number; clientEventId: string; createdOfflineAt: string; payload: SosQueuePayload }[]
> {
  const db = await openLocalDatabase();
  const result = await db.query(
    `SELECT * FROM offline_queue_local
     WHERE payload_type = 'sos' AND reconciliation_status = 'pending'
     ORDER BY created_offline_at ASC`
  );
  const rows = (result.values ?? []) as OfflineQueueLocalRow[];
  return rows.map((row) => ({
    queueId: row.queue_id,
    clientEventId: row.client_event_id,
    createdOfflineAt: row.created_offline_at,
    payload: JSON.parse(row.payload_json) as SosQueuePayload,
  }));
}

/**
 * Records a server-reported 'failed' result for a queued SOS. Unlike a
 * dispatch-status rejection, an SOS must never be silently terminal — it
 * stays 'pending' (retried next pass) until `maxAttempts` failures, and only
 * then becomes 'failed', which `countFailedSosItems()` surfaces as a
 * persistent banner until the Tanod retries or the SMS fallback is used.
 */
export async function markSosAttemptFailed(queueId: number, maxAttempts: number): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE offline_queue_local
       SET sync_attempts = sync_attempts + 1, last_attempt_at = ?,
           reconciliation_status = CASE WHEN sync_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
     WHERE queue_id = ?`,
    [new Date().toISOString(), maxAttempts, queueId],
    /* transaction */ false
  );
}

/** SOS items that exhausted their retries and still have not reached the server. */
export async function countFailedSosItems(): Promise<number> {
  const db = await openLocalDatabase();
  const result = await db.query(
    "SELECT COUNT(*) AS n FROM offline_queue_local WHERE payload_type = 'sos' AND reconciliation_status = 'failed'"
  );
  return Number((result.values?.[0] as { n: number } | undefined)?.n ?? 0);
}

/** Manual retry: puts exhausted SOS items back into the pending set with a fresh attempt budget. */
export async function resetFailedSosItems(): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE offline_queue_local SET reconciliation_status = 'pending', sync_attempts = 0
     WHERE payload_type = 'sos' AND reconciliation_status = 'failed'`,
    [],
    /* transaction */ false
  );
}

/**
 * Records the outcome of a sync attempt for one queued item. A 'failed'
 * outcome for a dispatch-status item (the server rejected the underlying
 * transition, e.g. it was already superseded by a later change) is left as
 * a terminal state rather than retried automatically — retrying an event
 * the server has already told us is invalid would just fail again; the
 * caller reverts/refreshes the optimistic local status instead. SOS items
 * use `markSosAttemptFailed()` above for 'failed' instead.
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
