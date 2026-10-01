/**
 * referralRepository.ts — `referral_local` (contract §5, migration 6).
 *
 * A referral records a HANDOFF: the Tanod handed an incident to PNP, BFP,
 * EMS, a barangay official, etc. It never changes the dispatch or the
 * incident's status, and it is not an acknowledgement — nothing here (or in
 * the screens built on it) may imply the receiving agency accepted the case.
 * `contact_name` is the receiving unit/official, never a citizen.
 *
 * Offline-first (Rule 7): persisted to encrypted SQLite first, sent via
 * `/sync/batch`'s `referrals[]` keyed by `client_event_id`. Two ways to name
 * the incident:
 *   - `server_incident_id` — the dispatch's incident (Assignment Detail);
 *   - `incident_local_id`  — an incident captured on THIS phone. At sync time
 *     it is resolved against `incident_local`: once that incident has a
 *     server id the referral sends `incident_id`, otherwise it sends
 *     `incident_client_event_id` and the server resolves it (contract §6).
 */

import { openLocalDatabase } from './localDatabase';
import type { IncidentLocalRow, ReferralLocalRow, ReferralTarget } from './localSchema';
import { uuid } from '../uuid';
import { markWorkflowSyncFailed } from './workflowSync';

/** Referral targets in the order shown to the Tanod, with plain-language labels (contract §5 enum). */
export const REFERRAL_TARGETS: readonly { value: ReferralTarget; label: string; hint: string }[] = [
  { value: 'pnp', label: 'PNP (Pulis)', hint: 'Police' },
  { value: 'bfp', label: 'BFP (Bumbero)', hint: 'Fire protection' },
  { value: 'ambulance_ems', label: 'Ambulance / EMS', hint: 'Medical emergency services' },
  { value: 'barangay_official', label: 'Barangay official', hint: 'Kagawad, Punong Barangay, etc.' },
  { value: 'vaw_desk', label: 'VAW Desk', hint: 'Violence against women and children desk' },
  { value: 'social_welfare', label: 'Social welfare (MSWDO)', hint: 'Social welfare office' },
  { value: 'higher_lgu', label: 'Higher LGU', hint: 'Municipal or provincial office' },
  { value: 'doh', label: 'DOH', hint: 'Department of Health' },
  { value: 'dpwh', label: 'DPWH', hint: 'Public works' },
  { value: 'other', label: 'Other (specify)', hint: 'Another agency or person' },
];

export function referralTargetLabel(value: ReferralTarget): string {
  return REFERRAL_TARGETS.find((t) => t.value === value)?.label ?? value;
}

export const MAX_OTHER_TEXT = 100;
export const MAX_CONTACT_NAME = 100;
export const MAX_REFERENCE_NO = 64;

export interface NewReferralInput {
  /** The dispatch's server incident id, when referring from Assignment Detail. */
  serverIncidentId?: number | null;
  /** `incident_local.local_id`, when referring from the submitted-incident view. */
  incidentLocalId?: string | null;
  referredTo: ReferralTarget;
  otherText?: string;
  contactName?: string;
  referenceNo?: string;
}

/** Returns a human-readable problem, or null when valid. */
export function validateReferral(input: NewReferralInput): string | null {
  if (!REFERRAL_TARGETS.some((t) => t.value === input.referredTo)) return 'Choose who the case was referred to.';
  if (input.serverIncidentId == null && !input.incidentLocalId) return 'This referral is not linked to an incident.';
  const other = (input.otherText ?? '').trim();
  if (input.referredTo === 'other' && !other) return 'Say who the case was referred to.';
  if (other.length > MAX_OTHER_TEXT) return `Keep the agency name under ${MAX_OTHER_TEXT} characters.`;
  if ((input.contactName ?? '').trim().length > MAX_CONTACT_NAME) {
    return `Keep the receiving person/unit under ${MAX_CONTACT_NAME} characters.`;
  }
  if ((input.referenceNo ?? '').trim().length > MAX_REFERENCE_NO) {
    return `Keep the reference number under ${MAX_REFERENCE_NO} characters.`;
  }
  return null;
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Persists a referral locally. `referred_at` is the moment the Tanod recorded the handoff. */
export async function saveReferralLocally(input: NewReferralInput): Promise<{ localId: string; clientEventId: string }> {
  const problem = validateReferral(input);
  if (problem) throw new Error(problem);

  const db = await openLocalDatabase();
  const localId = uuid();
  const clientEventId = uuid();
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO referral_local
       (local_id, incident_local_id, server_incident_id, referred_to, other_text, contact_name, reference_no,
        referred_at, created_offline_at, client_event_id, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      localId,
      input.incidentLocalId ?? null,
      input.serverIncidentId ?? null,
      input.referredTo,
      blankToNull(input.otherText),
      blankToNull(input.contactName),
      blankToNull(input.referenceNo),
      now,
      now,
      clientEventId,
    ],
    /* transaction */ false
  );
  return { localId, clientEventId };
}

/** Referrals recorded on this phone for one incident, newest first. */
export async function listReferralsForIncident(link: {
  serverIncidentId?: number | null;
  incidentLocalId?: string | null;
}): Promise<ReferralLocalRow[]> {
  const db = await openLocalDatabase();
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (link.serverIncidentId != null) {
    clauses.push('server_incident_id = ?');
    params.push(link.serverIncidentId);
  }
  if (link.incidentLocalId) {
    clauses.push('incident_local_id = ?');
    params.push(link.incidentLocalId);
  }
  if (clauses.length === 0) return [];
  const result = await db.query(
    `SELECT * FROM referral_local WHERE ${clauses.join(' OR ')} ORDER BY created_offline_at DESC`,
    params
  );
  return (result.values ?? []) as ReferralLocalRow[];
}

export interface UnsyncedReferral {
  row: ReferralLocalRow;
  /** The incident's server id when known — preferred. */
  incidentId: number | null;
  /** Fallback identity of a phone-only incident (contract §6). */
  incidentClientEventId: string | null;
}

/**
 * Referrals ready to send, oldest first, with the incident link resolved at
 * call time. The sync pass calls this AFTER the incident chunks are applied so
 * a referral to an incident synced in the same pass picks up its fresh server
 * id. A referral whose phone-only incident is itself stuck (capped, or already
 * failed at least once and still unsynced) is held back instead of burning its own retry budget on a failure
 * that is really the incident's.
 */
export async function listUnsyncedReferrals(): Promise<UnsyncedReferral[]> {
  const db = await openLocalDatabase();
  const result = await db.query(
    `SELECT r.*, i.server_incident_id AS resolved_incident_id, i.client_event_id AS incident_event_id,
            i.synced AS incident_synced, i.permanent_failure AS incident_failed,
            i.sync_attempts AS incident_attempts
       FROM referral_local r
       LEFT JOIN incident_local i ON i.local_id = r.incident_local_id
      WHERE r.synced = 0 AND r.permanent_failure = 0
      ORDER BY r.created_offline_at ASC`
  );
  const rows = (result.values ?? []) as (ReferralLocalRow & {
    resolved_incident_id: number | null;
    incident_event_id: string | null;
    incident_synced: number | null;
    incident_failed: number | null;
    incident_attempts: number | null;
  })[];

  const out: UnsyncedReferral[] = [];
  for (const joined of rows) {
    const { resolved_incident_id, incident_event_id, incident_synced, incident_failed, incident_attempts, ...row } = joined;
    const incidentId = row.server_incident_id ?? resolved_incident_id ?? null;
    if (incidentId === null) {
      if (!incident_event_id) continue; // nothing to name the incident by — cannot be sent
      // Parent incident is stuck or already failing: it has been tried (sync_attempts > 0) or capped
      // and still has no server id, so a referral sent now would 404 and burn its own retry budget
      // on a failure that is really the incident's. It goes out once the incident syncs.
      if (incident_synced === 0 && (incident_failed === 1 || (incident_attempts ?? 0) > 0)) continue;
    }
    out.push({ row: row as ReferralLocalRow, incidentId, incidentClientEventId: incident_event_id });
  }
  return out;
}

export async function markReferralSynced(clientEventId: string, serverId: number | null): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    `UPDATE referral_local
       SET synced = 1, server_referral_id = COALESCE(?, server_referral_id), last_sync_error = NULL
     WHERE client_event_id = ?`,
    [serverId, clientEventId],
    /* transaction */ false
  );
}

export function markReferralSyncFailed(clientEventId: string, reason: string, maxAttempts: number): Promise<void> {
  return markWorkflowSyncFailed('referral_local', clientEventId, reason, maxAttempts);
}

/** Type re-export so screens needn't reach into localSchema for the incident row they pass in. */
export type { IncidentLocalRow };
