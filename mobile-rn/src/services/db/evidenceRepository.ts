/**
 * Local write path for `evidence_attachment_local`. Mirrors
 * `incidentRepository.ts`'s shape: a stable `local_id` per row, nothing
 * here touches the network. The evidence UPLOAD half
 * (`/incidents/:id/evidence`) is `syncService.ts`'s job.
 *
 * Ported from ../mobile's evidenceRepository.ts, unchanged.
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
 * the incident FIRST (`saveIncidentLocally`) so `incidentLocalId` is real.
 */
export async function saveEvidenceLocally(incidentLocalId: string, staged: StagedAttachment): Promise<SavedEvidence> {
  const db = await openLocalDatabase();
  const localId = uuid();

  await db.beginTransaction();
  try {
    await db.run(
      `INSERT INTO evidence_attachment_local
         (local_id, incident_local_id, type, file_path, sha256, byte_size, mime_type, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [localId, incidentLocalId, staged.type, staged.filePath, staged.sha256, staged.byteSize, staged.mimeType],
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
  const result = await db.query<EvidenceAttachmentLocalRow>('SELECT * FROM evidence_attachment_local WHERE incident_local_id = ?', [
    incidentLocalId,
  ]);
  return result.values;
}

// --- Upload worker support ---------------------------------------------------
// Mirrors incidentRepository.ts's own "capture screens only read; the sync
// worker owns everything below" split.

export interface PendingEvidenceUpload {
  /** Doubles as the server's client_request_id idempotency key. */
  localId: string;
  incidentServerId: number;
  type: string;
  filePath: string;
  mimeType: string;
  sha256: string;
}

/**
 * Evidence ready to upload: not yet synced, AND its parent incident has
 * already synced and been assigned a real server id. Evidence for a
 * still-local-only incident is invisible here — there's no
 * `/incidents/:id/evidence` to POST to until the incident has one.
 */
export async function listPendingEvidenceUploads(): Promise<PendingEvidenceUpload[]> {
  const db = await openLocalDatabase();
  const result = await db.query<{
    local_id: string;
    server_incident_id: number;
    type: string;
    file_path: string;
    mime_type: string;
    sha256: string;
  }>(
    `SELECT e.local_id, i.server_incident_id, e.type, e.file_path, e.mime_type, e.sha256
     FROM evidence_attachment_local e
     JOIN incident_local i ON i.local_id = e.incident_local_id
     WHERE e.synced = 0 AND i.synced = 1 AND i.server_incident_id IS NOT NULL
     ORDER BY e.local_id ASC`,
  );
  return result.values.map((row) => ({
    localId: row.local_id,
    incidentServerId: row.server_incident_id,
    type: row.type,
    filePath: row.file_path,
    mimeType: row.mime_type,
    sha256: row.sha256,
  }));
}

/** Applies a confirmed upload. `synced_at` is what the 30-day cleanup rule measures from. */
export async function markEvidenceSynced(localId: string, serverAttachmentId: number): Promise<void> {
  const db = await openLocalDatabase();
  const now = new Date().toISOString();
  await db.run(
    `UPDATE evidence_attachment_local
     SET synced = 1, server_attachment_id = ?, synced_at = ?, last_attempt_at = ?
     WHERE local_id = ?`,
    [serverAttachmentId, now, now, localId],
  );
}

/** Records a failed upload attempt — the row stays unsynced for the next pass to retry. */
export async function markEvidenceAttemptFailed(localId: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run('UPDATE evidence_attachment_local SET attempts = attempts + 1, last_attempt_at = ? WHERE local_id = ?', [
    new Date().toISOString(),
    localId,
  ]);
}

// --- Storage cleanup ---------------------------------------------------------

export interface PrunableEvidence {
  localId: string;
  filePath: string;
  byteSize: number;
}

/**
 * Evidence confirmed-uploaded at least `retentionDays` ago and still
 * holding a local file reference. `file_path != ''` excludes rows an
 * earlier prune pass already cleared (this repository never deletes the
 * ROW, only the path/file).
 */
export async function listPrunableEvidence(retentionDays: number): Promise<PrunableEvidence[]> {
  const db = await openLocalDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.query<{ local_id: string; file_path: string; byte_size: number }>(
    `SELECT local_id, file_path, byte_size FROM evidence_attachment_local
     WHERE synced = 1 AND synced_at IS NOT NULL AND synced_at < ? AND file_path != ''`,
    [cutoff],
  );
  return result.values.map((row) => ({ localId: row.local_id, filePath: row.file_path, byteSize: row.byte_size }));
}

/** Clears the local file reference after the file itself has been deleted — the row and its metadata stay for M14's history. */
export async function clearEvidenceFilePath(localId: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(`UPDATE evidence_attachment_local SET file_path = '' WHERE local_id = ?`, [localId]);
}
