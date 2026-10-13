/**
 * draftRepository.ts — the unsent incident-report draft (schema v9).
 *
 * One row per user. Autosaved so a back-swipe or app kill does not lose the
 * narrative. A draft is not a report: it never enters the sync queue, and it is
 * deleted when the report is saved locally or the Tanod discards it.
 * Photos and voice notes are NOT part of the draft.
 */

import { openLocalDatabase } from './localDatabase';

export interface IncidentDraft {
  incidentType: string;
  narrative: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  schoolId: string;
  c1Summary: string;
  c1ActionTaken: string;
  c1StatusNotes: string;
}

export function draftKey(userId: number | null): string {
  return `user-${userId ?? 'unknown'}`;
}

/**
 * True when the form holds nothing worth keeping. The incident type alone
 * (it always has a default) and a bare school pick do not count.
 */
export function isDraftEmpty(d: IncidentDraft): boolean {
  return (
    d.narrative.trim() === '' &&
    d.c1Summary.trim() === '' &&
    d.c1ActionTaken.trim() === '' &&
    d.c1StatusNotes.trim() === '' &&
    d.latitude === null
  );
}

/** Saves the draft, or removes it when the form is empty. */
export async function saveIncidentDraft(userId: number | null, draft: IncidentDraft): Promise<void> {
  const db = await openLocalDatabase();
  const key = draftKey(userId);
  if (isDraftEmpty(draft)) {
    await db.run('DELETE FROM incident_draft WHERE draft_id = ?', [key], false);
    return;
  }
  await db.run(
    `INSERT OR REPLACE INTO incident_draft
       (draft_id, incident_type, narrative, latitude, longitude, accuracy_m, school_id,
        c1_summary, c1_action_taken, c1_status_notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      key,
      draft.incidentType,
      draft.narrative,
      draft.latitude,
      draft.longitude,
      draft.accuracyM,
      draft.schoolId || null,
      draft.c1Summary || null,
      draft.c1ActionTaken || null,
      draft.c1StatusNotes || null,
      new Date().toISOString(),
    ],
    false
  );
}

export async function loadIncidentDraft(userId: number | null): Promise<IncidentDraft | null> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT * FROM incident_draft WHERE draft_id = ?', [draftKey(userId)]);
  const r = result.values?.[0];
  if (!r) return null;
  return {
    incidentType: String(r.incident_type),
    narrative: String(r.narrative ?? ''),
    latitude: r.latitude ?? null,
    longitude: r.longitude ?? null,
    accuracyM: r.accuracy_m ?? null,
    schoolId: r.school_id ?? '',
    c1Summary: r.c1_summary ?? '',
    c1ActionTaken: r.c1_action_taken ?? '',
    c1StatusNotes: r.c1_status_notes ?? '',
  };
}

export async function clearIncidentDraft(userId: number | null): Promise<void> {
  const db = await openLocalDatabase();
  await db.run('DELETE FROM incident_draft WHERE draft_id = ?', [draftKey(userId)], false);
}
