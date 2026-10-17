/**
 * adminIncidentOutboxRepository.ts — the Chief Tanod console's incident outbox (schema v10).
 *
 * A report logged from the phone is written here before the screen is left
 * (Rule 7), sent with its own idempotency key, and deleted once the server
 * confirms. The row holds the narrative only until then.
 */

import { openLocalDatabase } from './localDatabase';

export interface AdminIncidentPayload {
  incidentType: string;
  priority: string;
  reportChannel: string;
  locationDescription: string;
  complainantName: string;
  narrative: string;
}

export interface AdminIncidentOutboxRow {
  idempotencyKey: string;
  payload: AdminIncidentPayload;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export async function addAdminIncidentToOutbox(idempotencyKey: string, payload: AdminIncidentPayload): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    'INSERT INTO admin_incident_outbox (idempotency_key, payload_json, created_at) VALUES (?, ?, ?)',
    [idempotencyKey, JSON.stringify(payload), new Date().toISOString()],
    /* transaction */ false
  );
}

/** Unsent reports, oldest first. */
export async function listAdminIncidentOutbox(): Promise<AdminIncidentOutboxRow[]> {
  const db = await openLocalDatabase();
  const res = await db.query(
    'SELECT idempotency_key, payload_json, created_at, attempts, last_error FROM admin_incident_outbox ORDER BY created_at ASC'
  );
  return (res.values ?? []).map((r) => ({
    idempotencyKey: String(r.idempotency_key),
    payload: JSON.parse(String(r.payload_json)) as AdminIncidentPayload,
    createdAt: String(r.created_at),
    attempts: Number(r.attempts),
    lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error),
  }));
}

export async function removeAdminIncidentFromOutbox(idempotencyKey: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run('DELETE FROM admin_incident_outbox WHERE idempotency_key = ?', [idempotencyKey], false);
}

/** A server refusal (not a lost connection): keep the row and say why. */
export async function recordAdminIncidentFailure(idempotencyKey: string, message: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    'UPDATE admin_incident_outbox SET attempts = attempts + 1, last_error = ? WHERE idempotency_key = ?',
    [message.slice(0, 255), idempotencyKey],
    false
  );
}
