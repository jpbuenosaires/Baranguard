/**
 * accomplishmentRepository.ts — `accomplishment_entry_local` (contract §4,
 * migration 6) plus a tiny Preferences cache of the month's report status.
 *
 * A Tanod logs what they did on a work day and how long it took. Entries are
 * offline-first (Rule 7): persisted to encrypted SQLite first, then sent via
 * `/sync/batch`'s `accomplishment_entries[]` keyed by `client_event_id`. The
 * duration the Tanod types is the CONFIRMED one; the server separately
 * computes `suggested_duration_minutes` from the on-duty intervals it already
 * holds and flags a large disagreement — that suggestion only exists once the
 * entry has reached the server, so it is read back later
 * (`applyServerEntryDurations`) and shown "when available".
 *
 * Submitting the month (open/returned -> prepared) is ONLINE-ONLY by contract
 * and is not stored here; only the last-known report STATUS is cached
 * (`cacheReportSummary`) so the status chip and an approver's return reason
 * still render offline.
 *
 * Privacy: the entry text stays on the device and in the server tables; it is
 * never written to logs, and nothing here ever includes names.
 */

import { Preferences } from '@capacitor/preferences';
import { openLocalDatabase } from './localDatabase';
import type { AccomplishmentEntryLocalRow } from './localSchema';
import { uuid } from '../uuid';
import { addDays, daysBetween, manilaToday, monthOf } from '../../utils/manilaTime';
import { markWorkflowSyncFailed } from './workflowSync';
import type { AccomplishmentReportSummary, AccomplishmentEntryServerView } from '../apiService';

/** Contract §4: `work_date` may not be older than this many days. */
export const MAX_BACKDATE_DAYS = 62;
export const MAX_ENTRY_TEXT = 2000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AccomplishmentInput {
  workDate: string;
  text: string;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
}

/** Earliest date the server will accept for a new entry (Manila). */
export function earliestWorkDate(): string {
  return addDays(manilaToday(), -MAX_BACKDATE_DAYS);
}

/** Returns a human-readable problem, or null when the input satisfies contract §4's validation. */
export function validateAccomplishment(input: AccomplishmentInput, opts: { allowDateChange?: boolean } = {}): string | null {
  const text = input.text.trim();
  if (!text) return 'Describe what you did.';
  if (text.length > MAX_ENTRY_TEXT) return `Keep the description under ${MAX_ENTRY_TEXT} characters.`;
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 1440) {
    return 'Duration must be between 1 minute and 24 hours.';
  }
  if (!DATE_RE.test(input.workDate)) return 'Choose the date you worked.';
  if (opts.allowDateChange !== false) {
    const today = manilaToday();
    if (input.workDate > today) return 'The work date cannot be in the future.';
    if (daysBetween(input.workDate, today) > MAX_BACKDATE_DAYS) {
      return `Entries can only be added up to ${MAX_BACKDATE_DAYS} days back.`;
    }
  }
  if ((input.startTime && !TIME_RE.test(input.startTime)) || (input.endTime && !TIME_RE.test(input.endTime))) {
    return 'Enter times as HH:MM.';
  }
  // The server accepts start/end only as a pair. An end earlier than the start is a valid
  // overnight entry (it wraps into the next day), so there is no ordering check here.
  if (Boolean(input.startTime) !== Boolean(input.endTime)) {
    return 'Enter both a start and an end time, or leave both blank.';
  }
  return null;
}

/** Persists a new entry locally; returns identifiers. The caller must not navigate away until this resolves. */
export async function saveEntryLocally(input: AccomplishmentInput): Promise<{ localId: string; clientEventId: string }> {
  const problem = validateAccomplishment(input);
  if (problem) throw new Error(problem);

  const db = await openLocalDatabase();
  const localId = uuid();
  const clientEventId = uuid();
  await db.run(
    `INSERT INTO accomplishment_entry_local
       (local_id, report_month, work_date, accomplishment_text, start_time, end_time, duration_minutes,
        created_offline_at, client_event_id, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      localId,
      monthOf(input.workDate),
      input.workDate,
      input.text.trim(),
      input.startTime || null,
      input.endTime || null,
      input.durationMinutes,
      new Date().toISOString(),
      clientEventId,
    ],
    /* transaction */ false
  );
  return { localId, clientEventId };
}

export async function getLocalEntry(localId: string): Promise<AccomplishmentEntryLocalRow | null> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT * FROM accomplishment_entry_local WHERE local_id = ?', [localId]);
  return (result.values?.[0] as AccomplishmentEntryLocalRow | undefined) ?? null;
}

/**
 * Edits an entry that has NOT reached the server yet, in place. It keeps its
 * `client_event_id` (the server has never seen it, so there is nothing to
 * dedupe against) and gets a fresh attempt budget. The work date is fixed
 * once saved — moving an entry across months would also move it across
 * reports.
 */
export async function updateUnsyncedEntry(localId: string, input: Omit<AccomplishmentInput, 'workDate'>): Promise<void> {
  const row = await getLocalEntry(localId);
  if (!row) throw new Error('That entry no longer exists on this phone.');
  if (row.synced === 1) throw new Error('This entry is already on the server; edit it while online.');
  const problem = validateAccomplishment({ ...input, workDate: row.work_date }, { allowDateChange: false });
  if (problem) throw new Error(problem);

  const db = await openLocalDatabase();
  await db.run(
    `UPDATE accomplishment_entry_local
       SET accomplishment_text = ?, start_time = ?, end_time = ?, duration_minutes = ?,
           last_sync_error = NULL, sync_attempts = 0, permanent_failure = 0
     WHERE local_id = ? AND synced = 0`,
    [input.text.trim(), input.startTime || null, input.endTime || null, input.durationMinutes, localId],
    /* transaction */ false
  );
}

/**
 * Mirrors an edit the SERVER has already accepted (`PATCH /accomplishment-
 * entries/:id` succeeded) into the local row. The suggested/flag values are
 * cleared because the server recomputes them against the new duration; the
 * next read-back repopulates them.
 */
export async function applyAcceptedEntryEdit(localId: string, input: Omit<AccomplishmentInput, 'workDate'>): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE accomplishment_entry_local
       SET accomplishment_text = ?, start_time = ?, end_time = ?, duration_minutes = ?,
           suggested_duration_minutes = NULL, duration_flag = 0
     WHERE local_id = ?`,
    [input.text.trim(), input.startTime || null, input.endTime || null, input.durationMinutes, localId],
    /* transaction */ false
  );
}

/** All entries of one `YYYY-MM`, newest work date first. */
export async function listEntriesForMonth(month: string): Promise<AccomplishmentEntryLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query(
    'SELECT * FROM accomplishment_entry_local WHERE report_month = ? ORDER BY work_date DESC, created_offline_at DESC',
    [month]
  );
  return (result.values ?? []) as AccomplishmentEntryLocalRow[];
}

/** Entries of a month the server has not confirmed yet (including capped ones — the month can't be submitted around them). */
export async function countUnsyncedEntriesForMonth(month: string): Promise<number> {
  const db = await openLocalDatabase();
  const result = await db.query(
    'SELECT COUNT(*) AS n FROM accomplishment_entry_local WHERE report_month = ? AND synced = 0',
    [month]
  );
  return Number((result.values?.[0] as { n: number } | undefined)?.n ?? 0);
}

/** Rows not yet confirmed by the server, oldest first; capped rows wait for a manual retry. */
export async function listUnsyncedEntries(): Promise<AccomplishmentEntryLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query(
    'SELECT * FROM accomplishment_entry_local WHERE synced = 0 AND permanent_failure = 0 ORDER BY created_offline_at ASC'
  );
  return (result.values ?? []) as AccomplishmentEntryLocalRow[];
}

export async function markEntrySynced(clientEventId: string, serverId: number | null): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE accomplishment_entry_local
       SET synced = 1, server_entry_id = COALESCE(?, server_entry_id), last_sync_error = NULL
     WHERE client_event_id = ?`,
    [serverId, clientEventId],
    /* transaction */ false
  );
}

export function markEntrySyncFailed(clientEventId: string, reason: string, maxAttempts: number): Promise<void> {
  return markWorkflowSyncFailed('accomplishment_entry_local', clientEventId, reason, maxAttempts);
}

/**
 * Stores the server-computed suggestion/flag against the matching local rows
 * (matched by the server entry id the sync result returned). The Tanod's
 * confirmed `duration_minutes` is never overwritten.
 */
export async function applyServerEntryDurations(views: AccomplishmentEntryServerView[]): Promise<void> {
  if (views.length === 0) return;
  const db = await openLocalDatabase();
  for (const view of views) {
    await db.run(
      `UPDATE accomplishment_entry_local
         SET suggested_duration_minutes = ?, duration_flag = ?
       WHERE server_entry_id = ?`,
      [view.suggestedDurationMinutes, view.durationFlag ? 1 : 0, view.entryId],
      /* transaction */ false
    );
  }
}

// --- Report status cache (Preferences, not SQLite: a handful of strings, no capture data) ---

const REPORT_CACHE_KEY = 'baranguard.accomplishmentReports';

async function readReportCache(): Promise<Record<string, AccomplishmentReportSummary>> {
  try {
    const { value } = await Preferences.get({ key: REPORT_CACHE_KEY });
    return value ? (JSON.parse(value) as Record<string, AccomplishmentReportSummary>) : {};
  } catch {
    return {};
  }
}

/** Remembers the last server-confirmed status of a month's report. */
export async function cacheReportSummary(report: AccomplishmentReportSummary): Promise<void> {
  try {
    const cache = await readReportCache();
    cache[report.month] = report;
    await Preferences.set({ key: REPORT_CACHE_KEY, value: JSON.stringify(cache) });
  } catch {
    // Best-effort — the screen just shows "status unknown" offline.
  }
}

/** The last known report for a month, or null when this phone has never seen one. */
export async function getCachedReportSummary(month: string): Promise<AccomplishmentReportSummary | null> {
  const cache = await readReportCache();
  return cache[month] ?? null;
}
