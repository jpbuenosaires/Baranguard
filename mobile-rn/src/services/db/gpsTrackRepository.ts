/**
 * Local staging table for `gps_track_local` — M7 Live Map's GPS broadcast
 * buffer. Ported from ../mobile's gpsTrackRepository.ts, unchanged.
 *
 * The patrol/live-map GPS path writes here whenever a live `POST /gps`
 * attempt fails (degrade, don't crash); `syncService.ts` drains unsynced
 * rows via `/sync/batch`'s `gps_tracks[]` once connectivity returns.
 */
import { openLocalDatabase } from './localDatabase';
import type { GpsTrackLocalRow } from './localSchema';
import { uuid } from '../uuid';

export interface NewGpsPoint {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** ISO 8601 UTC string — device capture time. */
  recordedAt: string;
  dispatchId?: number | null;
  /**
   * Reuse an id already minted elsewhere (e.g. `PatrolLocationService.kt`
   * mints one per fix before its own failed POST attempt) instead of
   * generating a fresh one — Rule 3: one client_event_id per physical point,
   * never two.
   */
  clientEventId?: string;
}

/** Stages one GPS point locally with a fresh (or caller-supplied) stable client_event_id. */
export async function saveGpsPointLocally(point: NewGpsPoint): Promise<{ localId: string; clientEventId: string }> {
  const db = await openLocalDatabase();
  const localId = uuid();
  const clientEventId = point.clientEventId ?? uuid();

  await db.run(
    `INSERT INTO gps_track_local (local_id, dispatch_id, latitude, longitude, accuracy_m, recorded_at, client_event_id, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [localId, point.dispatchId ?? null, point.latitude, point.longitude, point.accuracyM, point.recordedAt, clientEventId],
  );

  return { localId, clientEventId };
}

/** Rows not yet confirmed by the server, oldest first. */
export async function listUnsyncedGpsPoints(): Promise<GpsTrackLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query<GpsTrackLocalRow>('SELECT * FROM gps_track_local WHERE synced = 0 ORDER BY recorded_at ASC');
  return result.values;
}

export async function markGpsPointSynced(localId: string, serverTrackId: number | null): Promise<void> {
  const db = await openLocalDatabase();
  await db.run('UPDATE gps_track_local SET synced = 1, server_track_id = ? WHERE local_id = ?', [serverTrackId, localId]);
}
