/**
 * syncService.ts — the offline-reconciliation worker (§6 "Sync" section,
 * §5 sync invariants, §10 backlog "auto-sync on reconnect with idempotent
 * reconciliation (S3)").
 *
 * Gathers everything still unsynced across the local domain tables
 * (`incident_local`, `gps_track_local`, the `dispatch_status`/`sos` items
 * staged in `offline_queue_local`) and sends them to `POST /sync/batch` in
 * CHUNKS, applying each chunk's per-item results back to local state before
 * the next chunk goes out. Nothing here decides WHEN to run — that is
 * `syncScheduler.ts`/a screen's own effect; this module is the mechanism,
 * not the scheduler, so it can be invoked from more than one trigger without
 * duplicating the gather/apply logic.
 *
 * WHY CHUNKED, AND IN THIS ORDER: one giant batch over a weak link hits the
 * request timeout, and because nothing is marked synced until the response
 * is applied, the next pass would resend the entire backlog again. Chunks of
 * `SYNC_CHUNK_SIZE` bound each request, and rows are marked per chunk, so a
 * timeout mid-backlog only costs the chunk in flight. Order is by urgency:
 * SOS and dispatch status first (a life-safety alert and a responder's
 * status must not queue behind a thousand GPS points), then incident
 * reports, then GPS — which is also capped per pass (`GPS_PER_PASS_CAP`),
 * since a long offline stretch can leave thousands of points and the next
 * passes drain the rest oldest-first.
 *
 * FAILURE HANDLING: a network/timeout error from a chunk stops the pass
 * (earlier chunks stay applied; nothing needs unwinding) and propagates. A
 * server-reported per-item 'failed' is different — it counts toward a retry
 * cap (`MAX_SYNC_ATTEMPTS`) so one poison row cannot be re-sent forever;
 * capped rows stay on the device (Rule 2) and surface as "needs attention"
 * until a manual `retryNeedsAttention()`. A rejected dispatch-status item
 * reverts the optimistic local status and refreshes from the server; a
 * failed SOS is retried, never silently terminal.
 *
 * `duty_status_updates` is always sent empty: M2's duty toggle already
 * always calls `POST /duty-status` directly online (Sprint 2) — there is
 * no offline duty-toggle queue in this codebase (see localSchema.ts's file
 * header for why `duty_status_local` doesn't exist).
 *
 * EVIDENCE (Mobile Improvement Plan Phase 3.2, closes F4): drained in a
 * SEPARATE step after the batches above, not folded into them — evidence
 * upload is a per-file multipart POST (`/incidents/:id/evidence`), not
 * JSON that fits `/sync/batch`'s body shape, and it needs the PARENT
 * incident's server id, which the batch calls above are what assign in
 * the first place. Running it after means an incident synced in THIS
 * same pass can have its evidence uploaded in this same pass too, rather
 * than waiting for the next trigger.
 */

import { getDeviceId } from './deviceIdentity';
import {
  ApiError,
  getDispatches,
  syncBatch,
  uploadEvidence,
  type SyncBatchResult,
  type SyncDispatchStatusItem,
  type SyncGpsItem,
  type SyncIncidentItem,
  type SyncSosItem,
} from './apiService';
import {
  countPermanentlyFailedIncidents,
  listUnsyncedIncidents,
  markIncidentSynced,
  markIncidentSyncFailed,
  resetFailedIncidents,
} from './db/incidentRepository';
import {
  countPermanentlyFailedGpsPoints,
  listUnsyncedGpsPoints,
  markGpsPointSynced,
  markGpsPointSyncFailed,
  resetFailedGpsPoints,
} from './db/gpsTrackRepository';
import {
  countFailedSosItems,
  listPendingDispatchStatusUpdates,
  listPendingSosItems,
  markQueueItemResolved,
  markSosAttemptFailed,
  resetFailedSosItems,
} from './db/offlineQueueRepository';
import { cacheDispatchesFromServer, markStatusSynced, revertLocalStatusChange } from './db/dispatchRepository';
import {
  countPermanentlyFailedEvidence,
  listPendingEvidenceUploads,
  markEvidenceAttemptFailed,
  markEvidenceSynced,
  resetFailedEvidence,
} from './db/evidenceRepository';
import { readEvidenceFile } from './evidenceCapture';

/** Items per `POST /sync/batch` request. */
const SYNC_CHUNK_SIZE = 50;
/** Most GPS points one pass will send; the rest drain on later passes. */
const GPS_PER_PASS_CAP = 200;
/** Server-reported failures before an item stops auto-retrying and needs attention. */
const MAX_SYNC_ATTEMPTS = 5;

export interface SyncSummary {
  attempted: number;
  succeeded: number;
  duplicates: number;
  failed: number;
  evidenceUploaded: number;
  evidenceFailed: number;
  /** Queued dispatch-status changes the server refused this pass (local status reverted/refreshed). */
  dispatchRejected: number;
}

interface ChunkCounts {
  attempted: number;
  succeeded: number;
  duplicates: number;
  failed: number;
  dispatchRejected: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs one sync pass. Safe to call when offline — a network failure
 * surfaces as a normal `ApiError('NETWORK_ERROR')` from `syncBatch()`,
 * which this function lets propagate. Chunks already applied stay applied;
 * the rest are still unsynced, so a later retry picks up exactly where this
 * one stopped.
 */
export async function runSyncPass(): Promise<SyncSummary> {
  const deviceId = await getDeviceId();

  const unsyncedIncidents = await listUnsyncedIncidents();
  const unsyncedGps = await listUnsyncedGpsPoints(GPS_PER_PASS_CAP);
  const pendingDispatchStatus = await listPendingDispatchStatusUpdates();
  const pendingSos = await listPendingSosItems();

  const totals: ChunkCounts = { attempted: 0, succeeded: 0, duplicates: 0, failed: 0, dispatchRejected: 0 };
  const add = (c: ChunkCounts) => {
    totals.attempted += c.attempted;
    totals.succeeded += c.succeeded;
    totals.duplicates += c.duplicates;
    totals.failed += c.failed;
    totals.dispatchRejected += c.dispatchRejected;
  };

  // 1. Urgent: SOS first, then dispatch status. Tiny lists in practice, so
  //    each kind is chunked independently and SOS never waits behind status.
  for (const part of chunk(pendingSos, SYNC_CHUNK_SIZE)) {
    add(await syncChunk(deviceId, { sos: part }));
  }
  for (const part of chunk(pendingDispatchStatus, SYNC_CHUNK_SIZE)) {
    add(await syncChunk(deviceId, { dispatch: part }));
  }
  // 2. Incident reports.
  for (const part of chunk(unsyncedIncidents, SYNC_CHUNK_SIZE)) {
    add(await syncChunk(deviceId, { incidents: part }));
  }
  // 3. GPS history — least urgent, already capped above.
  for (const part of chunk(unsyncedGps, SYNC_CHUNK_SIZE)) {
    add(await syncChunk(deviceId, { gps: part }));
  }

  // Evidence is checked every pass regardless of whether a batch above
  // ran — a previous pass may have already synced the parent incident
  // while its evidence upload failed (or hadn't been captured yet), so
  // there can be pending evidence with nothing else to batch this time.
  let evidenceUploaded = 0;
  let evidenceFailed = 0;
  const pendingEvidence = await listPendingEvidenceUploads();
  for (const item of pendingEvidence) {
    try {
      const bytes = await readEvidenceFile(item.filePath, item.mimeType);
      const uploaded = await uploadEvidence(item.incidentServerId, deviceId, bytes, {
        type: item.type === 'voice' ? 'voice' : 'photo',
        sha256: item.sha256,
        mimeType: item.mimeType,
        clientRequestId: item.localId,
      });
      await markEvidenceSynced(item.localId, uploaded.attachmentId);
      evidenceUploaded += 1;
    } catch (error) {
      // Offline/timeout/5xx/401 are transient: the row retries without
      // spending its attempt budget. A server 4xx rejection or an
      // unreadable local file will never succeed on its own, so those
      // count toward the cap and eventually need attention.
      const transient =
        error instanceof ApiError && (error.isOffline || error.status >= 500 || error.status === 401);
      await markEvidenceAttemptFailed(item.localId, transient ? null : MAX_SYNC_ATTEMPTS);
      evidenceFailed += 1;
    }
  }

  return {
    attempted: totals.attempted,
    succeeded: totals.succeeded,
    duplicates: totals.duplicates,
    failed: totals.failed,
    evidenceUploaded,
    evidenceFailed,
    dispatchRejected: totals.dispatchRejected,
  };
}

interface ChunkInput {
  incidents?: Awaited<ReturnType<typeof listUnsyncedIncidents>>;
  gps?: Awaited<ReturnType<typeof listUnsyncedGpsPoints>>;
  dispatch?: Awaited<ReturnType<typeof listPendingDispatchStatusUpdates>>;
  sos?: Awaited<ReturnType<typeof listPendingSosItems>>;
}

/** Sends one chunk and applies its per-item results before returning (so a later timeout never un-does it). */
async function syncChunk(deviceId: string, input: ChunkInput): Promise<ChunkCounts> {
  const incidents = input.incidents ?? [];
  const gps = input.gps ?? [];
  const dispatch = input.dispatch ?? [];
  const sos = input.sos ?? [];

  const incidentItems: SyncIncidentItem[] = incidents.map((row) => ({
    incident_type: row.incident_type,
    raw_narrative: row.raw_narrative,
    latitude: row.latitude,
    longitude: row.longitude,
    device_offline_created_at: row.created_offline_at,
    client_event_id: row.client_event_id,
  }));

  const gpsItems: SyncGpsItem[] = gps.map((row) => ({
    latitude: row.latitude,
    longitude: row.longitude,
    accuracy_m: row.accuracy_m,
    recorded_at: row.recorded_at,
    dispatch_id: row.dispatch_id,
    client_event_id: row.client_event_id,
  }));

  const dispatchStatusItems: SyncDispatchStatusItem[] = dispatch.map(({ clientEventId, payload }) => ({
    dispatch_id: payload.serverDispatchId,
    status: payload.status,
    client_event_id: clientEventId,
  }));

  const sosItems: SyncSosItem[] = sos.map(({ clientEventId, createdOfflineAt, payload }) => ({
    latitude: payload.latitude,
    longitude: payload.longitude,
    dispatch_id: payload.dispatchId,
    client_event_id: clientEventId,
    created_offline_at: payload.createdOfflineAt ?? createdOfflineAt,
  }));

  const results = await syncBatch({
    deviceId,
    incidents: incidentItems,
    gpsTracks: gpsItems,
    dispatchStatusUpdates: dispatchStatusItems,
    sosItems,
  });

  const byEventId = new Map<string, SyncBatchResult>(results.map((r) => [r.clientEventId, r]));

  for (const row of incidents) {
    const result = byEventId.get(row.client_event_id);
    if (!result) continue;
    if (result.status === 'failed') {
      await markIncidentSyncFailed(row.client_event_id, result.reason ?? 'Sync failed.', MAX_SYNC_ATTEMPTS);
    } else {
      await markIncidentSynced(row.client_event_id, result.serverId);
    }
  }

  for (const row of gps) {
    const result = byEventId.get(row.client_event_id);
    if (!result) continue;
    if (result.status === 'failed') {
      await markGpsPointSyncFailed(row.local_id, MAX_SYNC_ATTEMPTS);
    } else {
      await markGpsPointSynced(row.local_id, result.serverId);
    }
  }

  let dispatchRejected = 0;
  for (const { queueId, clientEventId, payload } of dispatch) {
    const result = byEventId.get(clientEventId);
    if (!result) continue;
    await markQueueItemResolved(queueId, result.status);
    if (result.status !== 'failed') {
      await markStatusSynced(payload.dispatchLocalId);
    } else {
      // The server refused this transition (cancelled/already advanced/
      // not ours). Terminal for the queue row, but the optimistic local
      // status must not be left claiming it happened.
      dispatchRejected += 1;
      await revertLocalStatusChange(payload.dispatchLocalId, payload.status);
    }
  }
  if (dispatchRejected > 0) {
    try {
      await cacheDispatchesFromServer(await getDispatches());
    } catch {
      // Offline refresh is best-effort — the local revert above already
      // stopped the cache lying; the next Assignments load re-syncs it.
    }
  }

  for (const { queueId, clientEventId } of sos) {
    const result = byEventId.get(clientEventId);
    if (!result) continue;
    if (result.status === 'failed') {
      await markSosAttemptFailed(queueId, MAX_SYNC_ATTEMPTS);
    } else {
      // No local business table to flag for SOS — the queue row itself IS
      // the record; resolving it is the whole reconciliation.
      await markQueueItemResolved(queueId, result.status);
    }
  }

  return {
    attempted: results.length,
    succeeded: results.filter((r) => r.status === 'success').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    failed: results.filter((r) => r.status === 'failed').length,
    dispatchRejected,
  };
}

export interface NeedsAttentionCounts {
  incidents: number;
  gps: number;
  evidence: number;
  /** SOS alerts that exhausted their retries and never reached the server. */
  sos: number;
  total: number;
}

/** Items the automatic sync has given up on — shown as a warning, never hidden. */
export async function getNeedsAttentionCounts(): Promise<NeedsAttentionCounts> {
  const [incidents, gps, evidence, sos] = await Promise.all([
    countPermanentlyFailedIncidents(),
    countPermanentlyFailedGpsPoints(),
    countPermanentlyFailedEvidence(),
    countFailedSosItems(),
  ]);
  return { incidents, gps, evidence, sos, total: incidents + gps + evidence + sos };
}

/** Manual retry: gives every capped item a fresh attempt budget; the caller then runs a pass. */
export async function retryNeedsAttention(): Promise<void> {
  await resetFailedIncidents();
  await resetFailedGpsPoints();
  await resetFailedEvidence();
  await resetFailedSosItems();
}
