/**
 * gpsTrackRepository.ts — the local staging table for `gps_track_local`
 * (§5), M7 Live Map's GPS broadcast buffer.
 *
 * `geolocation.ts` writes here whenever a live `POST /gps` attempt fails
 * (offline, per §2 Rule 15's "degrade, not crash" requirement);
 * `syncService.ts` drains unsynced rows via `/sync/batch`'s `gps_tracks[]`
 * once connectivity returns.
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
}

/** Stages one GPS point locally with a fresh, stable client_event_id (§5 sync invariants). */
export async function saveGpsPointLocally(point: NewGpsPoint): Promise<{ localId: string; clientEventId: string }> {
  const db = await openLocalDatabase();
  const localId = uuid();
  const clientEventId = uuid();

  await db.run(
    `INSERT INTO gps_track_local (local_id, dispatch_id, latitude, longitude, accuracy_m, recorded_at, client_event_id, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [localId, point.dispatchId ?? null, point.latitude, point.longitude, point.accuracyM, point.recordedAt, clientEventId],
    /* transaction */ false
  );

  return { localId, clientEventId };
}

/** Rows not yet confirmed by the server, oldest first (§5 sync invariants: "processes oldest-first"). */
export async function listUnsyncedGpsPoints(): Promise<GpsTrackLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT * FROM gps_track_local WHERE synced = 0 ORDER BY recorded_at ASC');
  return (result.values ?? []) as GpsTrackLocalRow[];
}

export async function markGpsPointSynced(localId: string, serverTrackId: number | null): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    'UPDATE gps_track_local SET synced = 1, server_track_id = ? WHERE local_id = ?',
    [serverTrackId, localId],
    /* transaction */ false
  );
}
