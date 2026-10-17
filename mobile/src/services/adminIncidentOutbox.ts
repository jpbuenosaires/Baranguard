/**
 * adminIncidentOutbox.ts — log an incident from the Chief Tanod's phone, with or without a signal.
 *
 * Save first (encrypted SQLite), then try to send. A lost connection leaves the
 * row for the next flush; a server refusal is recorded on the row and not
 * retried until the Chief Tanod looks at it. Sending happens only while the app
 * is open: there is no background job for the console (documented limit).
 */

import { ApiError, createAdminIncident } from './apiService';
import {
  addAdminIncidentToOutbox,
  listAdminIncidentOutbox,
  recordAdminIncidentFailure,
  removeAdminIncidentFromOutbox,
  type AdminIncidentPayload,
} from './db/adminIncidentOutboxRepository';
import { uuid } from './uuid';

export interface FlushResult {
  sent: number;
  waiting: number;
  refused: number;
}

let flushing = false;

/** Sends every unsent report, oldest first, and stops at the first lost connection. */
export async function flushAdminIncidentOutbox(): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, waiting: 0, refused: 0 };
  if (flushing) return result;
  flushing = true;
  try {
    const rows = await listAdminIncidentOutbox();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row.lastError !== null && row.attempts >= 3) {
        result.refused += 1;
        continue;
      }
      try {
        await createAdminIncident(row.payload, row.idempotencyKey);
        await removeAdminIncidentFromOutbox(row.idempotencyKey);
        result.sent += 1;
      } catch (error) {
        // A lost connection or an expired session is a wait, not a refusal.
        if (error instanceof ApiError && (error.isOffline || error.status === 401)) {
          result.waiting = rows.length - i;
          return result;
        }
        const message = error instanceof Error ? error.message : 'The server refused this report.';
        await recordAdminIncidentFailure(row.idempotencyKey, message);
        result.refused += 1;
      }
    }
    return result;
  } finally {
    flushing = false;
  }
}

/** Saves the report on the phone, then tries to send everything unsent. */
export async function submitAdminIncident(payload: AdminIncidentPayload): Promise<FlushResult> {
  await addAdminIncidentToOutbox(uuid(), payload);
  return flushAdminIncidentOutbox();
}

export async function countUnsentAdminIncidents(): Promise<number> {
  return (await listAdminIncidentOutbox()).length;
}
