/**
 * workflowSync.ts — the sync bookkeeping the four 2026-10 write tables share
 * (`availability_local`, `accomplishment_entry_local`, `referral_local`,
 * `school_checkin_local`). Each already carries the same three columns the
 * older kinds have — `synced`, `sync_attempts`, `permanent_failure` — so the
 * "count a server-reported failure, cap it, surface it as needs-attention,
 * reset on manual retry" behaviour lives here once instead of four times.
 *
 * Behaviour deliberately matches `incidentRepository`/`gpsTrackRepository`:
 * rows are never deleted by sync (Rule 7); a row the server keeps rejecting
 * stops being retried automatically after `maxAttempts` and waits for a manual
 * retry from the sync modal.
 *
 * The table name is interpolated into SQL, so it is restricted to the
 * `WorkflowTable` union below — it is never user input.
 */

import { openLocalDatabase } from './localDatabase';

/**
 * What "not yet confirmed by the server" means per table. A school check-in is
 * also unconfirmed while its separate close item is still pending (contract §7).
 */
function unsyncedPredicate(table: WorkflowTable): string {
  return table === 'school_checkin_local' ? '(synced = 0 OR checkout_pending = 1)' : 'synced = 0';
}

export type WorkflowTable =
  | 'availability_local'
  | 'accomplishment_entry_local'
  | 'referral_local'
  | 'school_checkin_local';

/** What the UI may say about a record's journey to the server — never claims more than the row proves. */
export type WorkflowSyncState = 'saved_locally' | 'synced' | 'needs_attention';

export function deriveWorkflowSyncState(row: { synced: number; permanent_failure: number }): WorkflowSyncState {
  if (row.synced === 1) return 'synced';
  if (row.permanent_failure === 1) return 'needs_attention';
  return 'saved_locally';
}

export const WORKFLOW_SYNC_STATE_LABEL: Record<WorkflowSyncState, string> = {
  saved_locally: 'Saved on phone',
  synced: 'Synced',
  needs_attention: 'Needs attention',
};

/** Counts one server-reported failure; flips `permanent_failure` once `maxAttempts` is reached. */
export async function markWorkflowSyncFailed(
  table: WorkflowTable,
  clientEventId: string,
  reason: string,
  maxAttempts: number
): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE ${table}
       SET last_sync_error = ?, sync_attempts = sync_attempts + 1,
           permanent_failure = CASE WHEN sync_attempts + 1 >= ? THEN 1 ELSE permanent_failure END
     WHERE client_event_id = ?`,
    [reason, maxAttempts, clientEventId],
    /* transaction */ false
  );
}

/** Unsynced rows that hit the retry cap — the "needs attention" count for one table. */
export async function countWorkflowPermanentFailures(table: WorkflowTable): Promise<number> {
  const db = await openLocalDatabase();
  const result = await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${unsyncedPredicate(table)} AND permanent_failure = 1`);
  return Number((result.values?.[0] as { n: number } | undefined)?.n ?? 0);
}

/** Pending (not yet confirmed, not capped) row count for one table. */
export async function countWorkflowPending(table: WorkflowTable): Promise<number> {
  const db = await openLocalDatabase();
  const result = await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${unsyncedPredicate(table)} AND permanent_failure = 0`);
  return Number((result.values?.[0] as { n: number } | undefined)?.n ?? 0);
}

/** Manual retry: puts capped rows back into the automatic sync set with a fresh attempt budget. */
export async function resetWorkflowFailures(table: WorkflowTable): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE ${table} SET permanent_failure = 0, sync_attempts = 0, last_sync_error = NULL
     WHERE ${unsyncedPredicate(table)} AND permanent_failure = 1`,
    [],
    /* transaction */ false
  );
}

/** One permanently failed row, described without any personal data, for the needs-attention list. */
export interface FailedWorkflowRow {
  table: WorkflowTable;
  localId: string;
  /** Short plain-language description (kind + date/period/target) — never narrative text or names. */
  label: string;
  lastError: string | null;
}

const FAILED_ROW_SELECTS: readonly { table: WorkflowTable; kind: string; sql: string }[] = [
  {
    table: 'availability_local',
    kind: 'Availability',
    sql: `SELECT local_id, period_start || ' to ' || period_end AS detail, last_sync_error
            FROM availability_local WHERE synced = 0 AND permanent_failure = 1`,
  },
  {
    table: 'accomplishment_entry_local',
    kind: 'Accomplishment entry',
    sql: `SELECT local_id, work_date AS detail, last_sync_error
            FROM accomplishment_entry_local WHERE synced = 0 AND permanent_failure = 1`,
  },
  {
    table: 'referral_local',
    kind: 'Referral',
    sql: `SELECT local_id, referred_to AS detail, last_sync_error
            FROM referral_local WHERE synced = 0 AND permanent_failure = 1`,
  },
  {
    table: 'school_checkin_local',
    kind: 'School check-in',
    sql: `SELECT local_id, school_name || ' ' || substr(checked_in_at, 1, 10) AS detail, last_sync_error
            FROM school_checkin_local WHERE (synced = 0 OR checkout_pending = 1) AND permanent_failure = 1`,
  },
];

/** The rows the automatic sync gave up on, across the four workflow tables (the discard list). */
export async function listFailedWorkflowRows(): Promise<FailedWorkflowRow[]> {
  const db = await openLocalDatabase();
  const out: FailedWorkflowRow[] = [];
  for (const spec of FAILED_ROW_SELECTS) {
    const result = await db.query(spec.sql);
    for (const raw of (result.values ?? []) as { local_id: string; detail: string | null; last_sync_error: string | null }[]) {
      out.push({
        table: spec.table,
        localId: raw.local_id,
        label: raw.detail ? `${spec.kind} — ${raw.detail}` : spec.kind,
        lastError: raw.last_sync_error,
      });
    }
  }
  return out;
}

/**
 * Deletes ONE permanently failed row from this phone (the user confirmed in the UI). It only ever
 * removes a row the server has not accepted — `permanent_failure = 1` and still unconfirmed — so
 * it cannot throw away a synced record. Nothing is changed on the server.
 */
export async function discardFailedWorkflowRow(table: WorkflowTable, localId: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `DELETE FROM ${table} WHERE local_id = ? AND permanent_failure = 1 AND ${unsyncedPredicate(table)}`,
    [localId],
    /* transaction */ false
  );
}
