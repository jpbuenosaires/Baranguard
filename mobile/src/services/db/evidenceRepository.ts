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

/** Map of evidence attachment counts grouped by incident local_id. */
export async function getEvidenceCountsByIncident(): Promise<Record<string, number>> {
  const db = await openLocalDatabase();
  const result = await db.query(
    'SELECT incident_local_id, COUNT(*) as count FROM evidence_attachment_local GROUP BY incident_local_id'
  );
  const map: Record<string, number> = {};
  for (const row of (result.values ?? []) as Array<{ incident_local_id: string; count: number }>) {
    map[row.incident_local_id] = row.count;
  }
  return map;
}

// --- Upload worker support (Mobile Improvement Plan Phase 3.2, closes F4) ---
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
 * still-local-only incident is invisible here on purpose — there is no
 * `/incidents/:id/evidence` to POST to until the incident itself has one.
 */
export async function listPendingEvidenceUploads(): Promise<PendingEvidenceUpload[]> {
  const db = await openLocalDatabase();
  const result = await db.query(
    `SELECT e.local_id, i.server_incident_id, e.type, e.file_path, e.mime_type, e.sha256
     FROM evidence_attachment_local e
     JOIN incident_local i ON i.local_id = e.incident_local_id
     WHERE e.synced = 0 AND e.permanent_failure = 0 AND i.synced = 1 AND i.server_incident_id IS NOT NULL
     ORDER BY e.local_id ASC`
  );
  return ((result.values ?? []) as Array<{
    local_id: string;
    server_incident_id: number;
    type: string;
    file_path: string;
    mime_type: string;
    sha256: string;
  }>).map((row) => ({
    localId: row.local_id,
    incidentServerId: row.server_incident_id,
    type: row.type,
    filePath: row.file_path,
    mimeType: row.mime_type,
    sha256: row.sha256,
  }));
}

/** Applies a confirmed upload. `synced_at` (migration 4) is what Phase 3.3's cleanup rule measures 30 days from. */
export async function markEvidenceSynced(localId: string, serverAttachmentId: number): Promise<void> {
  const db = await openLocalDatabase();
  const now = new Date().toISOString();
  await db.run(
    `UPDATE evidence_attachment_local
     SET synced = 1, server_attachment_id = ?, synced_at = ?, last_attempt_at = ?
     WHERE local_id = ?`,
    [serverAttachmentId, now, now, localId],
    /* transaction */ false
  );
}

/**
 * Records a failed upload attempt — the row stays unsynced for the next
 * pass to retry. `maxAttempts` is passed only for a NON-transient failure
 * (server rejected it, or the local file is unreadable): once `attempts`
 * reaches it the row is flagged `permanent_failure` and dropped from the
 * automatic retry set. A transient failure (offline/timeout/5xx) passes
 * `null`, so a long outage can never exhaust the cap.
 */
export async function markEvidenceAttemptFailed(localId: string, maxAttempts: number | null): Promise<void> {
  const db = await openLocalDatabase();
  if (maxAttempts === null) {
    await db.run(
      'UPDATE evidence_attachment_local SET last_attempt_at = ? WHERE local_id = ?',
      [new Date().toISOString(), localId],
      /* transaction */ false
    );
    return;
  }
  await db.run(
    `UPDATE evidence_attachment_local
       SET attempts = attempts + 1, last_attempt_at = ?,
           permanent_failure = CASE WHEN attempts + 1 >= ? THEN 1 ELSE permanent_failure END
     WHERE local_id = ?`,
    [new Date().toISOString(), maxAttempts, localId],
    /* transaction */ false
  );
}

export async function countPermanentlyFailedEvidence(): Promise<number> {
  const db = await openLocalDatabase();
  const result = await db.query(
    'SELECT COUNT(*) AS n FROM evidence_attachment_local WHERE synced = 0 AND permanent_failure = 1'
  );
  return Number((result.values?.[0] as { n: number } | undefined)?.n ?? 0);
}

/** Manual retry: puts capped evidence rows back into the automatic upload set. */
export async function resetFailedEvidence(): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(
    'UPDATE evidence_attachment_local SET permanent_failure = 0, attempts = 0 WHERE synced = 0 AND permanent_failure = 1',
    [],
    /* transaction */ false
  );
}

// --- Storage cleanup (Mobile Improvement Plan Phase 3.3) --------------------

export interface PrunableEvidence {
  localId: string;
  filePath: string;
  byteSize: number;
}

/**
 * Evidence confirmed-uploaded at least `retentionDays` ago and still
 * holding a local file reference — `storageMaintenance.ts`'s prune job
 * reads this, deletes each file, then calls `clearEvidenceFilePath()`
 * below. `file_path != ''` excludes rows an earlier prune pass already
 * cleared (this repository never deletes the ROW, only the path/file).
 */
export async function listPrunableEvidence(retentionDays: number): Promise<PrunableEvidence[]> {
  const db = await openLocalDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.query(
    `SELECT local_id, file_path, byte_size FROM evidence_attachment_local
     WHERE synced = 1 AND synced_at IS NOT NULL AND synced_at < ? AND file_path != ''`,
    [cutoff]
  );
  return ((result.values ?? []) as Array<{ local_id: string; file_path: string; byte_size: number }>).map((row) => ({
    localId: row.local_id,
    filePath: row.file_path,
    byteSize: row.byte_size,
  }));
}

/** Clears the local file reference after the file itself has been deleted — the row and its metadata (sha256, byte_size, timestamps) stay for M14's history. */
export async function clearEvidenceFilePath(localId: string): Promise<void> {
  const db = await openLocalDatabase();
  await db.run(`UPDATE evidence_attachment_local SET file_path = '' WHERE local_id = ?`, [localId], /* transaction */ false);
}
