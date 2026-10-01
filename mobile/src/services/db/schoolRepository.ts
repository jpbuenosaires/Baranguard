/**
 * schoolRepository.ts — `school_local` (the read-only school cache) and
 * `school_checkin_local` (a Tanod's school check-in/out), contract §7,
 * migration 6.
 *
 * `school_local` mirrors `GET /schools` for the Tanod's own barangay so the
 * picker (check-in, and the Annex C-1 link on a new incident) works with no
 * connection. It is a cache, not capture data: `cacheSchools()` replaces it
 * wholesale on every successful fetch. It holds no staff contact details and
 * nothing about students — the contract forbids student data of any kind.
 *
 * Check-ins are offline-first (Rule 7). The server stores NO coordinates for a
 * check-in, and neither does this table. Closing a check-in (the only mutation
 * the server allows) follows contract §7's close-by-reference rule — see
 * `endSchoolCheckin()`.
 */

import { openLocalDatabase } from './localDatabase';
import type { SchoolCheckinLocalRow, SchoolLocalRow } from './localSchema';
import { uuid } from '../uuid';
import type { SchoolEntry } from '../apiService';
import { markWorkflowSyncFailed } from './workflowSync';

// --- School cache -----------------------------------------------------------

/** Replaces the cache with the server's current list (inside one transaction, so a crash can't leave it half-empty). */
export async function cacheSchools(schools: SchoolEntry[]): Promise<void> {
  const db = await openLocalDatabase();
  const cachedAt = new Date().toISOString();
  await db.beginTransaction();
  try {
    await db.run('DELETE FROM school_local', [], /* transaction */ false);
    for (const school of schools) {
      await db.run(
        `INSERT OR REPLACE INTO school_local
           (school_id, name, school_type, level, address, latitude, longitude, is_active, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          school.schoolId,
          school.name,
          school.schoolType,
          school.level,
          school.address,
          school.latitude,
          school.longitude,
          school.isActive ? 1 : 0,
          cachedAt,
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

/** Cached schools by name. `activeOnly` hides deactivated schools from every picker. */
export async function listCachedSchools(activeOnly = true): Promise<SchoolLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query(
    `SELECT * FROM school_local ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY name COLLATE NOCASE ASC`
  );
  return (result.values ?? []) as SchoolLocalRow[];
}

/** Milliseconds since the cache was last refreshed, or null if it has never been filled. */
export async function getSchoolCacheAgeMs(): Promise<number | null> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT MAX(cached_at) AS latest FROM school_local');
  const latest = (result.values?.[0] as { latest: string | null } | undefined)?.latest;
  if (!latest) return null;
  return Math.max(0, Date.now() - new Date(latest).getTime());
}

// --- Check-in / check-out ---------------------------------------------------

/** The Tanod's currently open check-in on this phone, if any. */
export async function getOpenSchoolCheckin(): Promise<SchoolCheckinLocalRow | null> {
  const db = await openLocalDatabase();
  const result = await db.query(
    'SELECT * FROM school_checkin_local WHERE checked_out_at IS NULL ORDER BY checked_in_at DESC LIMIT 1'
  );
  return (result.values?.[0] as SchoolCheckinLocalRow | undefined) ?? null;
}

/**
 * Starts a check-in at a cached school. Only one may be open at a time — the
 * Tanod checks out of one school before checking in at another — so a stray
 * double-tap or a forgotten check-out is surfaced instead of piling up rows.
 */
export async function startSchoolCheckin(school: { schoolId: number; name: string }): Promise<{ localId: string; clientEventId: string }> {
  const open = await getOpenSchoolCheckin();
  if (open) throw new Error(`You are still checked in at ${open.school_name}. Check out first.`);

  const db = await openLocalDatabase();
  const localId = uuid();
  const clientEventId = uuid();
  await db.run(
    `INSERT INTO school_checkin_local (local_id, school_id, school_name, checked_in_at, client_event_id, synced)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [localId, school.schoolId, school.name, new Date().toISOString(), clientEventId],
    /* transaction */ false
  );
  return { localId, clientEventId };
}

/**
 * Closes an open check-in (contract §7). Re-sending the SAME client_event_id
 * does not work through /sync/batch (the server's ledger answers 'duplicate'
 * first), so:
 *   (a) check-in NOT synced yet  -> just record `checked_out_at`; the single
 *       create item carries it (see `listUnsyncedSchoolCheckins`);
 *   (b) check-in already synced  -> mint `checkout_event_id` and set
 *       `checkout_pending`; a NEW item referencing the check-in is sent.
 */
export async function endSchoolCheckin(localId: string): Promise<void> {
  const db = await openLocalDatabase();
  const row = (await db.query('SELECT * FROM school_checkin_local WHERE local_id = ?', [localId]))
    .values?.[0] as SchoolCheckinLocalRow | undefined;
  if (!row || row.checked_out_at !== null) return;
  const now = new Date().toISOString();
  if (row.synced === 1) {
    await db.run(
      `UPDATE school_checkin_local
         SET checked_out_at = ?, checkout_event_id = ?, checkout_pending = 1,
             last_sync_error = NULL, sync_attempts = 0, permanent_failure = 0
       WHERE local_id = ? AND checked_out_at IS NULL`,
      [now, uuid(), localId],
      /* transaction */ false
    );
  } else {
    await db.run(
      `UPDATE school_checkin_local
         SET checked_out_at = ?, last_sync_error = NULL, sync_attempts = 0, permanent_failure = 0
       WHERE local_id = ? AND checked_out_at IS NULL`,
      [now, localId],
      /* transaction */ false
    );
  }
}

/** Most recent check-ins on this phone, newest first. */
export async function listRecentSchoolCheckins(limit = 15): Promise<SchoolCheckinLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT * FROM school_checkin_local ORDER BY checked_in_at DESC LIMIT ?', [limit]);
  return (result.values ?? []) as SchoolCheckinLocalRow[];
}

/** True once everything about this check-in (create AND any close) has reached the server. */
export function isCheckinFullySynced(row: SchoolCheckinLocalRow): boolean {
  return row.synced === 1 && row.checkout_pending === 0;
}

export interface UnsyncedSchoolCheckin {
  row: SchoolCheckinLocalRow;
  /** `create`: POST item (carries `checked_out_at` if already closed). `close`: reference item for an already-synced check-in. */
  kind: 'create' | 'close';
}

/** Items ready to send, oldest first; capped rows wait for a manual retry. */
export async function listUnsyncedSchoolCheckins(): Promise<UnsyncedSchoolCheckin[]> {
  const db = await openLocalDatabase();
  const result = await db.query(
    `SELECT * FROM school_checkin_local
      WHERE permanent_failure = 0 AND (synced = 0 OR checkout_pending = 1)
      ORDER BY checked_in_at ASC`
  );
  return ((result.values ?? []) as SchoolCheckinLocalRow[]).map((row) => ({
    row,
    kind: row.synced === 0 ? 'create' : 'close',
  }));
}

/**
 * Applies a successful/duplicate result for a CREATE item. The server may hold
 * the check-in WITHOUT the check-out the phone now has, in two cases, and in
 * both the close is queued as its own referencing item (never lost):
 *   - the Tanod checked out while the create request was in flight
 *     (`sentCheckedOutAt` was null but the row is now closed);
 *   - the server answered `duplicate`: an earlier send of this check-in already
 *     landed (typically before the check-out), and a duplicate answer never
 *     applies the checked_out_at carried by the repeat, so the server's copy
 *     may be open even though this phone's is closed.
 * The close is idempotent server-side (it only fills an empty checked_out_at),
 * so queueing one when it was not strictly needed is harmless.
 */
export async function markSchoolCheckinSynced(
  clientEventId: string,
  serverId: number | null,
  sentCheckedOutAt: string | null,
  resultStatus: 'success' | 'duplicate' = 'success'
): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE school_checkin_local
       SET synced = 1, server_checkin_id = COALESCE(?, server_checkin_id), last_sync_error = NULL
     WHERE client_event_id = ?`,
    [serverId, clientEventId],
    /* transaction */ false
  );
  if (sentCheckedOutAt === null || resultStatus === 'duplicate') {
    await db.run(
      `UPDATE school_checkin_local
         SET checkout_event_id = ?, checkout_pending = 1, sync_attempts = 0, permanent_failure = 0
       WHERE client_event_id = ? AND checked_out_at IS NOT NULL AND checkout_event_id IS NULL`,
      [uuid(), clientEventId],
      /* transaction */ false
    );
  }
}

/** Applies a successful/duplicate result for a CLOSE item. */
export async function markSchoolCheckinCloseSynced(checkoutEventId: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    'UPDATE school_checkin_local SET checkout_pending = 0, last_sync_error = NULL WHERE checkout_event_id = ?',
    [checkoutEventId],
    /* transaction */ false
  );
}

export function markSchoolCheckinSyncFailed(clientEventId: string, reason: string, maxAttempts: number): Promise<void> {
  return markWorkflowSyncFailed('school_checkin_local', clientEventId, reason, maxAttempts);
}

/** Counts a server-reported failure for a CLOSE item (keyed by its own event id). */
export async function markSchoolCheckinCloseFailed(checkoutEventId: string, reason: string, maxAttempts: number): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE school_checkin_local
       SET last_sync_error = ?, sync_attempts = sync_attempts + 1,
           permanent_failure = CASE WHEN sync_attempts + 1 >= ? THEN 1 ELSE permanent_failure END
     WHERE checkout_event_id = ?`,
    [reason, maxAttempts, checkoutEventId],
    /* transaction */ false
  );
}
