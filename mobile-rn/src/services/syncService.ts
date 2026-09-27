/**
 * The offline-reconciliation worker. Ported from ../mobile's
 * syncService.ts — gather/apply logic unchanged; the only real difference
 * is evidence upload no longer reads the file into a Blob first
 * (`readEvidenceFile` doesn't exist here) — `apiService.uploadEvidence()`
 * takes the file URI directly, since RN's FormData streams a `{uri}` part
 * from disk itself.
 *
 * Gathers everything still unsynced (`incident_local`, `gps_track_local`,
 * the `dispatch_status`/`sos` items staged in `offline_queue_local`), sends
 * them in ONE `POST /sync/batch` call, and applies the per-item results
 * back to local state. This module is the mechanism, not the scheduler —
 * `syncScheduler.ts` decides when to call it.
 *
 * `duty_status_updates` is always empty: the duty toggle always calls
 * `POST /duty-status` directly online — there is no offline duty-toggle
 * queue (`duty_status_local` deliberately doesn't exist).
 *
 * Evidence is drained in a SEPARATE step after the batch, not folded into
 * it: it's a per-file multipart POST, not JSON, and needs the PARENT
 * incident's server id — which the batch call is what assigns in the
 * first place. Running it after means an incident synced in this same
 * pass can have its evidence uploaded in this same pass too.
 */
import { getDeviceId } from './deviceIdentity';
import { syncBatch, uploadEvidence, type SyncBatchResult, type SyncDispatchStatusItem, type SyncGpsItem, type SyncIncidentItem, type SyncSosItem } from './apiService';
import { listUnsyncedIncidents, markIncidentSynced, markIncidentSyncFailed } from './db/incidentRepository';
import { listUnsyncedGpsPoints, markGpsPointSynced } from './db/gpsTrackRepository';
import { listPendingDispatchStatusUpdates, listPendingSosItems, markQueueItemResolved } from './db/offlineQueueRepository';
import { markStatusSynced } from './db/dispatchRepository';
import { listPendingEvidenceUploads, markEvidenceAttemptFailed, markEvidenceSynced } from './db/evidenceRepository';

export interface SyncSummary {
  attempted: number;
  succeeded: number;
  duplicates: number;
  failed: number;
  evidenceUploaded: number;
  evidenceFailed: number;
}

/**
 * Runs one sync pass. Safe to call offline — a network failure surfaces as
 * an `ApiError('NETWORK_ERROR')` from `syncBatch()` and propagates: nothing
 * was marked synced, so a later retry naturally picks up the same rows.
 */
export async function runSyncPass(): Promise<SyncSummary> {
  const deviceId = await getDeviceId();

  const unsyncedIncidents = await listUnsyncedIncidents();
  const unsyncedGps = await listUnsyncedGpsPoints();
  const pendingDispatchStatus = await listPendingDispatchStatusUpdates();
  const pendingSos = await listPendingSosItems();

  let succeeded = 0;
  let duplicates = 0;
  let failed = 0;
  let attempted = 0;

  if (unsyncedIncidents.length > 0 || unsyncedGps.length > 0 || pendingDispatchStatus.length > 0 || pendingSos.length > 0) {
    const batchResult = await runBatchSync(deviceId, unsyncedIncidents, unsyncedGps, pendingDispatchStatus, pendingSos);
    attempted = batchResult.attempted;
    succeeded = batchResult.succeeded;
    duplicates = batchResult.duplicates;
    failed = batchResult.failed;
  }

  // Checked every pass regardless of whether the batch above ran — a
  // previous pass may have synced the parent incident while its evidence
  // upload failed, leaving pending evidence with nothing else to batch.
  let evidenceUploaded = 0;
  let evidenceFailed = 0;
  const pendingEvidence = await listPendingEvidenceUploads();
  for (const item of pendingEvidence) {
    try {
      const uploaded = await uploadEvidence(item.incidentServerId, deviceId, item.filePath, {
        type: item.type === 'voice' ? 'voice' : 'photo',
        sha256: item.sha256,
        mimeType: item.mimeType,
        clientRequestId: item.localId,
      });
      await markEvidenceSynced(item.localId, uploaded.attachmentId);
      evidenceUploaded += 1;
    } catch {
      // Offline, or the server rejected it — stays unsynced for retry.
      await markEvidenceAttemptFailed(item.localId);
      evidenceFailed += 1;
    }
  }

  return { attempted, succeeded, duplicates, failed, evidenceUploaded, evidenceFailed };
}

interface BatchSyncResult {
  attempted: number;
  succeeded: number;
  duplicates: number;
  failed: number;
}

async function runBatchSync(
  deviceId: string,
  unsyncedIncidents: Awaited<ReturnType<typeof listUnsyncedIncidents>>,
  unsyncedGps: Awaited<ReturnType<typeof listUnsyncedGpsPoints>>,
  pendingDispatchStatus: Awaited<ReturnType<typeof listPendingDispatchStatusUpdates>>,
  pendingSos: Awaited<ReturnType<typeof listPendingSosItems>>,
): Promise<BatchSyncResult> {
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

  const sosItems: SyncSosItem[] = pendingSos.map(({ clientEventId, payload }) => ({
    latitude: payload.latitude,
    longitude: payload.longitude,
    dispatch_id: payload.dispatchId,
    client_event_id: clientEventId,
  }));

  const results = await syncBatch({
    deviceId,
    incidents: incidentItems,
    gpsTracks: gpsItems,
    dispatchStatusUpdates: dispatchStatusItems,
    sosItems,
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

  for (const { queueId, clientEventId } of pendingSos) {
    const result = byEventId.get(clientEventId);
    if (!result) continue;
    // No local business table for SOS — the queue row itself is the record.
    await markQueueItemResolved(queueId, result.status === 'failed' ? 'failed' : result.status);
  }

  const succeeded = results.filter((r) => r.status === 'success').length;
  const duplicates = results.filter((r) => r.status === 'duplicate').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return { attempted: results.length, succeeded, duplicates, failed };
}
