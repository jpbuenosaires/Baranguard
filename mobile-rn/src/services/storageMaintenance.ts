/**
 * On-device storage usage telemetry, and the evidence-cleanup rule that
 * keeps it from growing forever. Ported from ../mobile's
 * storageMaintenance.ts.
 *
 * Deliberately does NOT report the encrypted SQLite database's own file
 * size — expo-sqlite manages that file's path internally with no size/stat
 * API this app can call without guessing at an unverified path, and a
 * made-up number would be exactly the kind of fabricated diagnostic to
 * avoid. What IS measured (evidence attachments, offline map packages) is
 * what this app's own file-system writes can actually account for.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { deleteEvidenceFile } from './evidenceCapture';
import { clearEvidenceFilePath, listPrunableEvidence } from './db/evidenceRepository';

const EVIDENCE_SUBDIR = 'evidence';
const MAP_PACKAGE_SUBDIR = 'map-packages';
const EVIDENCE_RETENTION_DAYS_ON_DEVICE = 30;

export interface DirectoryUsage {
  fileCount: number;
  totalBytes: number;
}

function measureDirectory(subdir: string): DirectoryUsage {
  const dir = new Directory(Paths.document, subdir);
  if (!dir.exists) return { fileCount: 0, totalBytes: 0 };
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of dir.list()) {
    if (entry instanceof File) {
      fileCount += 1;
      totalBytes += entry.size;
    }
  }
  return { fileCount, totalBytes };
}

export interface StorageSnapshot {
  evidence: DirectoryUsage;
  mapPackages: DirectoryUsage;
}

export function getStorageSnapshot(): StorageSnapshot {
  return { evidence: measureDirectory(EVIDENCE_SUBDIR), mapPackages: measureDirectory(MAP_PACKAGE_SUBDIR) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface PruneResult {
  prunedCount: number;
  freedBytes: number;
}

/**
 * Clears the on-disk binary (never the database ROW) for evidence
 * confirmed-uploaded 30+ days ago. Metadata stays for history (M14 "My
 * Reports" still shows the record); only the local copy of bytes already
 * safely on the workstation is removed.
 */
export async function pruneOldSyncedEvidenceFiles(): Promise<PruneResult> {
  const prunable = await listPrunableEvidence(EVIDENCE_RETENTION_DAYS_ON_DEVICE);
  let prunedCount = 0;
  let freedBytes = 0;
  for (const row of prunable) {
    deleteEvidenceFile(row.filePath);
    await clearEvidenceFilePath(row.localId);
    prunedCount += 1;
    freedBytes += row.byteSize;
  }
  return { prunedCount, freedBytes };
}
