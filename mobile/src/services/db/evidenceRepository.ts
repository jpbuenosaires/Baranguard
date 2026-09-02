/**
 * evidenceRepository.ts — the local write path for `evidence_attachment_local`.
 *
 * Mirrors `incidentRepository.ts`'s shape deliberately: a stable
 * `local_id` per row, nothing here touches the network, and a row is
 * fully written or not at all. §9 M3 groups "local SQLite, POST incident,
 * sync, evidence upload" under the same API list — this file is the
 * local-SQLite quarter of that; the evidence UPLOAD half
 * (`/incidents/:id/evidence`, per §6's sync section) is Sprint 3+ scope,
 * same as incident sync itself.
 */

import { openLocalDatabase } from './localDatabase';
import type { EvidenceAttachmentLocalRow } from './localSchema';
import type { StagedAttachment } from '../evidenceCapture';
import { uuid } from '../uuid';

export interface SavedEvidence {
  localId: string;
}

/**
 * Persists one captured photo/voice attachment, linked to an
 * already-saved `incident_local` row by its `local_id`. Callers must save
 * the incident FIRST (`saveIncidentLocally`) so `incidentLocalId` is real
 * — this mirrors §9 M3's own ordering ("every field writes locally
 * immediately... a stable client_event_id is created when the record is
 * first saved").
 */
export async function saveEvidenceLocally(
  incidentLocalId: string,
  staged: StagedAttachment
): Promise<SavedEvidence> {
  const db = await openLocalDatabase();
  const localId = uuid();

  await db.beginTransaction();
  try {
    await db.run(
      `INSERT INTO evidence_attachment_local
         (local_id, incident_local_id, type, file_path, sha256, byte_size, mime_type, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [localId, incidentLocalId, staged.type, staged.filePath, staged.sha256, staged.byteSize, staged.mimeType],
      /* transaction */ false
    );
    await db.commitTransaction();
  } catch (error) {
    await db.rollbackTransaction();
    throw error;
  }

  return { localId };
}

/** All evidence captured for one incident, for M3's staged-list display and M4's confirmation screen. */
export async function getEvidenceForIncident(incidentLocalId: string): Promise<EvidenceAttachmentLocalRow[]> {
  const db = await openLocalDatabase();
  const result = await db.query('SELECT * FROM evidence_attachment_local WHERE incident_local_id = ?', [
    incidentLocalId,
  ]);
  return (result.values ?? []) as EvidenceAttachmentLocalRow[];
}
