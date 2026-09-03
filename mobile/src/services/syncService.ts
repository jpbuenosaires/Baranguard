/**
 * syncService.ts — the offline-reconciliation worker (§6 "Sync" section,
 * §5 sync invariants, §10 backlog "auto-sync on reconnect with idempotent
 * reconciliation (S3)").
 *
 * Gathers everything still unsynced across the local domain tables
 * (`incident_local`, `gps_track_local`, the `dispatch_status` items staged
 * in `offline_queue_local`), sends them in ONE `POST /sync/batch` call, and
 * applies the per-item results back to local state. Nothing here decides
 * WHEN to run — that is `main.tsx`/a screen's own effect (e.g. "call this
 * on app foreground and on a timer"); this module is the mechanism, not
 * the scheduler, so it can be invoked from more than one trigger without
 * duplicating the gather/apply logic.
 *
 * `duty_status_updates` is always sent empty: M2's duty toggle already
 * always calls `POST /duty-status` directly online (Sprint 2) — there is
 * no offline duty-toggle queue in this codebase (see localSchema.ts's file
 * header for why `duty_status_local` doesn't exist). `sos` is always
 * empty too — SOS sync is Sprint 4 scope (see SyncController.php's own
 * doc comment on the server side).
 */

import { getDeviceId } from './deviceIdentity';
import {
  syncBatch,
  type SyncBatchResult,
  type SyncDispatchStatusItem,
  type SyncGpsItem,
  type SyncIncidentItem,
} from './apiService';
import {
  listUnsyncedIncidents,
  markIncidentSynced,
  markIncidentSyncFailed,
} from './db/incidentRepository';
import { listUnsyncedGpsPoints, markGpsPointSynced } from './db/gpsTrackRepository';
import {
  listPendingDispatchStatusUpdates,
  markQueueItemResolved,
} from './db/offlineQueueRepository';
import { markStatusSynced } from './db/dispatchRepository';

export interface SyncSummary {
  attempted: number;
  succeeded: number;
  duplicates: number;
  failed: number;
}

/**
 * Runs one sync pass. Safe to call when offline — a network failure
 * surfaces as a normal `ApiError('NETWORK_ERROR')` from `syncBatch()`,
 * which this function lets propagate (nothing was marked synced, so a
 * later retry naturally picks up the same unsynced rows — no local state
 * needs unwinding on a failed attempt).
 */
export async function runSyncPass(): Promise<SyncSummary> {
  const deviceId = await getDeviceId();

  const unsyncedIncidents = await listUnsyncedIncidents();
  const unsyncedGps = await listUnsyncedGpsPoints();
  const pendingDispatchStatus = await listPendingDispatchStatusUpdates();

  if (unsyncedIncidents.length === 0 && unsyncedGps.length === 0 && pendingDispatchStatus.length === 0) {
    return { attempted: 0, succeeded: 0, duplicates: 0, failed: 0 };
  }

  const incidentItems: SyncIncidentItem[] = unsyncedIncidents.map((row) => ({
    incident_type: row.incident_type,
    raw_narrative: row.raw_narrative,
    latitude: row.latitude,
    longitude: row.longitude,
    device_offline_created_at: row.created_offline_at,
    client_event_id: row.client_event_id,
  }));

  const gpsItems: SyncGpsItem[] = unsyncedGps.map((row) => ({
    latitude: row.latitude,
    longitude: row.longitude,
    accuracy_m: row.accuracy_m,
    recorded_at: row.recorded_at,
    dispatch_id: row.dispatch_id,
    client_event_id: row.client_event_id,
  }));

  const dispatchStatusItems: SyncDispatchStatusItem[] = pendingDispatchStatus.map(({ clientEventId, payload }) => ({
    dispatch_id: payload.serverDispatchId,
    status: payload.status,
    client_event_id: clientEventId,
  }));

  const results = await syncBatch({
    deviceId,
    incidents: incidentItems,
    gpsTracks: gpsItems,
    dispatchStatusUpdates: dispatchStatusItems,
  });

  const byEventId = new Map<string, SyncBatchResult>(results.map((r) => [r.clientEventId, r]));

  for (const row of unsyncedIncidents) {
    const result = byEventId.get(row.client_event_id);
    if (!result) continue;
    if (result.status === 'failed') {
      await markIncidentSyncFailed(row.client_event_id, result.reason ?? 'Sync failed.');
    } else {
      await markIncidentSynced(row.client_event_id, result.serverId);
    }
  }

  for (const row of unsyncedGps) {
    const result = byEventId.get(row.client_event_id);
    if (!result || result.status === 'failed') continue; // Left unsynced; a later pass retries it.
    await markGpsPointSynced(row.local_id, result.serverId);
  }

  for (const { queueId, clientEventId, payload } of pendingDispatchStatus) {
    const result = byEventId.get(clientEventId);
    if (!result) continue;
    await markQueueItemResolved(queueId, result.status === 'failed' ? 'failed' : result.status);
    if (result.status !== 'failed') {
      await markStatusSynced(payload.dispatchLocalId);
    }
  }

  const succeeded = results.filter((r) => r.status === 'success').length;
  const duplicates = results.filter((r) => r.status === 'duplicate').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return { attempted: results.length, succeeded, duplicates, failed };
}
