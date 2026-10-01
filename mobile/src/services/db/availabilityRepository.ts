/**
 * availabilityRepository.ts — `availability_local` (contract §3, migration 6).
 *
 * A Tanod submits the dates and time windows they can serve for a period; the
 * desk reviews it (accepted / revised) and builds the roster from it. The
 * write is offline-first (Rule 7): it persists to encrypted SQLite before the
 * screen closes and goes out through `/sync/batch`'s `availability[]`, keyed
 * by `client_event_id`. The server's own status (`accepted`/`revised`,
 * `review_note`) flows back in through `applyServerAvailability()`.
 *
 * ONE LOCAL ROW PER PERIOD (unique index): the server has UNIQUE(user_id,
 * period_start, period_end) and, for a still-`submitted` period, treats a
 * re-send as an update (version + 1). So an edit re-uses the row, bumps the
 * local version and mints a NEW `client_event_id` — the old event id has
 * already been (or may have been) applied, and an idempotent replay of it
 * would carry the old windows.
 *
 * Nothing in here logs window contents or review notes.
 */

import { openLocalDatabase } from './localDatabase';
import type { AvailabilityLocalRow, AvailabilityStatus, AvailabilityWindow } from './localSchema';
import { uuid } from '../uuid';
import { daysBetween, manilaToday } from '../../utils/manilaTime';
import { markWorkflowSyncFailed } from './workflowSync';

/** Contract §3 limit. */
export const MAX_AVAILABILITY_WINDOWS = 62;

export interface NewAvailabilityInput {
  periodStart: string;
  periodEnd: string;
  windows: AvailabilityWindow[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns a human-readable problem, or null when the input satisfies contract §3's validation. */
export function validateAvailability(input: NewAvailabilityInput): string | null {
  const { periodStart, periodEnd, windows } = input;
  if (!DATE_RE.test(periodStart) || !DATE_RE.test(periodEnd)) return 'Choose a start and end date for the period.';
  if (periodEnd < periodStart) return 'The period must end on or after its start date.';
  if (windows.length === 0) return 'Add at least one day and time you can serve.';
  if (windows.length > MAX_AVAILABILITY_WINDOWS) {
    return `You can add at most ${MAX_AVAILABILITY_WINDOWS} time windows per submission.`;
  }
  for (const w of windows) {
    if (!DATE_RE.test(w.date) || w.date < periodStart || w.date > periodEnd) {
      return 'Every time window must fall inside the period.';
    }
    if (!TIME_RE.test(w.start) || !TIME_RE.test(w.end)) return 'Enter a start and end time for every window.';
    if (w.end <= w.start) return 'Each window must end after it starts.';
  }
  return null;
}

/** Windows sorted by date then start, so the stored/sent order is stable. */
function normalizeWindows(windows: AvailabilityWindow[]): AvailabilityWindow[] {
  return [...windows]
    .map((w) => ({ date: w.date, start: w.start, end: w.end }))
    .sort((a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date)));
}

export function parseLocalWindows(row: Pick<AvailabilityLocalRow, 'windows_json'>): AvailabilityWindow[] {
  try {
    const parsed = JSON.parse(row.windows_json) as unknown;
    return Array.isArray(parsed) ? (parsed as AvailabilityWindow[]) : [];
  } catch {
    return [];
  }
}

/** True when the Tanod may still change this period (the server 409s an accepted one). */
export function isAvailabilityEditable(status: AvailabilityStatus): boolean {
  return status !== 'accepted';
}

/**
 * Persists a submission locally. Re-submitting a period that already has a row
 * updates it (new event id, version + 1, back to unsynced); an `accepted` row
 * is refused here the same way the server would (409).
 */
export async function saveAvailabilityLocally(input: NewAvailabilityInput): Promise<{ localId: string; clientEventId: string }> {
  const problem = validateAvailability(input);
  if (problem) throw new Error(problem);

  const db = await openLocalDatabase();
  const windows = normalizeWindows(input.windows);
  const clientEventId = uuid();
  const now = new Date().toISOString();

  await db.beginTransaction();
  try {
    const existing = (
      await db.query('SELECT * FROM availability_local WHERE period_start = ? AND period_end = ?', [
        input.periodStart,
        input.periodEnd,
      ])
    ).values?.[0] as AvailabilityLocalRow | undefined;

    let localId: string;
    if (existing) {
      if (!isAvailabilityEditable(existing.status)) {
        throw new Error('This period was already accepted by the desk and can no longer be changed.');
      }
      localId = existing.local_id;
      await db.run(
        `UPDATE availability_local
           SET windows_json = ?, status = 'submitted', review_note = NULL, version = version + 1,
               created_offline_at = ?, client_event_id = ?, synced = 0, last_sync_error = NULL,
               sync_attempts = 0, permanent_failure = 0
         WHERE local_id = ?`,
        [JSON.stringify(windows), now, clientEventId, localId],
        /* transaction */ false
      );
    } else {
      localId = uuid();
      await db.run(
        `INSERT INTO availability_local
           (local_id, period_start, period_end, windows_json, status, version, created_offline_at, client_event_id, synced)
         VALUES (?, ?, ?, ?, 'submitted', 1, ?, ?, 0)`,
        [localId, input.periodStart, input.periodEnd, JSON.stringify(windows), now, clientEventId],
        /* transaction */ false
      );
    }
    await db.commitTransaction();
    return { localId, clientEventId };
  } catch (error) {
    await db.rollbackTransaction();
    throw error;
  }
}

/** Every submission this device knows about, newest period first. */
export async function listAvailability(): Promise<AvailabilityLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT * FROM availability_local ORDER BY period_start DESC, period_end DESC');
  return (result.values ?? []) as AvailabilityLocalRow[];
}

/** Rows not yet confirmed by the server, oldest first; capped rows wait for a manual retry. */
export async function listUnsyncedAvailability(): Promise<AvailabilityLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query(
    'SELECT * FROM availability_local WHERE synced = 0 AND permanent_failure = 0 ORDER BY created_offline_at ASC'
  );
  return (result.values ?? []) as AvailabilityLocalRow[];
}

/**
 * Applies a successful/duplicate sync result. Matches on `client_event_id`, so
 * if the Tanod edited the period while the old event was in flight (new event
 * id) this does NOT mark the newer, still-unsent edit as synced.
 */
export async function markAvailabilitySynced(clientEventId: string, serverId: number | null): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE availability_local
       SET synced = 1, server_avail_id = COALESCE(?, server_avail_id), last_sync_error = NULL
     WHERE client_event_id = ?`,
    [serverId, clientEventId],
    /* transaction */ false
  );
}

export function markAvailabilitySyncFailed(clientEventId: string, reason: string, maxAttempts: number): Promise<void> {
  return markWorkflowSyncFailed('availability_local', clientEventId, reason, maxAttempts);
}

export interface ServerAvailability {
  availId: number;
  periodStart: string;
  periodEnd: string;
  windows: AvailabilityWindow[];
  status: AvailabilityStatus;
  reviewNote: string | null;
  version: number;
  clientEventId: string | null;
}

/**
 * Merges the server's view of the Tanod's own submissions. Server status is
 * authoritative for rows already synced (that is how `accepted`/`revised` and
 * the reviewer's note reach the phone); a local row with an UNSENT edit is
 * never overwritten — the Tanod's pending change wins until it is sent — EXCEPT
 * when the server's copy is already `accepted` (it 409s every change to one), where the server's
 * copy is applied and the local row is marked resolved instead of retrying forever. A
 * period the server has but this phone does not (submitted from another
 * device) is added as already-synced.
 */
export async function applyServerAvailability(entries: ServerAvailability[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openLocalDatabase();
  const now = new Date().toISOString();
  for (const entry of entries) {
    const existing = (
      await db.query('SELECT * FROM availability_local WHERE period_start = ? AND period_end = ?', [
        entry.periodStart,
        entry.periodEnd,
      ])
    ).values?.[0] as AvailabilityLocalRow | undefined;

    if (!existing) {
      await db.run(
        `INSERT OR IGNORE INTO availability_local
           (local_id, server_avail_id, period_start, period_end, windows_json, status, review_note, version,
            created_offline_at, client_event_id, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          uuid(),
          entry.availId,
          entry.periodStart,
          entry.periodEnd,
          JSON.stringify(normalizeWindows(entry.windows)),
          entry.status,
          entry.reviewNote,
          entry.version,
          now,
          entry.clientEventId ?? `server-availability-${entry.availId}`,
        ],
        /* transaction */ false
      );
    } else if (existing.synced === 0 && entry.status === 'accepted') {
      // The desk already ACCEPTED this period, and the server answers any further change to an
      // accepted period with a 409 — so an unsent local edit can never succeed and would otherwise
      // retry (then sit in needs-attention) forever. The server's accepted copy wins and the local
      // row is resolved. (A `revised` period is NOT treated this way: the server still takes a
      // resubmission of it, so a pending edit must be sent, not overwritten.)
      await db.run(
        `UPDATE availability_local
           SET server_avail_id = ?, status = ?, review_note = ?, version = ?, windows_json = ?,
               synced = 1, last_sync_error = NULL, sync_attempts = 0, permanent_failure = 0
         WHERE local_id = ? AND synced = 0`,
        [
          entry.availId,
          entry.status,
          entry.reviewNote,
          entry.version,
          JSON.stringify(normalizeWindows(entry.windows)),
          existing.local_id,
        ],
        /* transaction */ false
      );
    } else if (existing.synced === 1) {
      await db.run(
        `UPDATE availability_local
           SET server_avail_id = ?, status = ?, review_note = ?, version = ?, windows_json = ?
         WHERE local_id = ?`,
        [
          entry.availId,
          entry.status,
          entry.reviewNote,
          entry.version,
          JSON.stringify(normalizeWindows(entry.windows)),
          existing.local_id,
        ],
        /* transaction */ false
      );
    }
  }
}

/** Convenience for the screens: how many days a period spans (inclusive). */
export function periodLengthDays(periodStart: string, periodEnd: string): number {
  return daysBetween(periodStart, periodEnd) + 1;
}

/** True when the period has already ended (Manila), so the list can tuck it away. */
export function isPeriodPast(periodEnd: string): boolean {
  return periodEnd < manilaToday();
}
