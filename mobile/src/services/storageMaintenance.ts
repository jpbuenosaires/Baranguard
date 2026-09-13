/**
 * storageMaintenance.ts — on-device storage usage telemetry, and the
 * evidence-cleanup rule that keeps it from growing forever (Mobile
 * Improvement Plan Phase 3.3).
 *
 * Deliberately does NOT report the encrypted SQLite database's own file
 * size: `@capacitor-community/sqlite` manages that file's path internally
 * and exposes no size/stat API this app can call without guessing at an
 * unverified internal path — reporting a made-up number would be exactly
 * the kind of fabricated diagnostic §2 Rule 6 forbids. What IS measured
 * here (evidence attachments, offline map packages) is what this app's
 * OWN `@capacitor/filesystem` writes can actually account for.
 */

import { Directory, Filesystem } from '@capacitor/filesystem';
import { deleteEvidenceFile } from './evidenceCapture';
import { clearEvidenceFilePath, listPrunableEvidence } from './db/evidenceRepository';

const EVIDENCE_SUBDIR = 'evidence';
const MAP_PACKAGE_SUBDIR = 'map-packages';
const EVIDENCE_RETENTION_DAYS_ON_DEVICE = 30;

export interface DirectoryUsage {
  fileCount: number;
  totalBytes: number;
}

async function measureDirectory(path: string): Promise<DirectoryUsage> {
  try {
    const { files } = await Filesystem.readdir({ path, directory: Directory.Data });
    let totalBytes = 0;
    let fileCount = 0;
    for (const file of files) {
      if (file.type === 'directory') continue;
      totalBytes += file.size;
      fileCount += 1;
    }
    return { fileCount, totalBytes };
  } catch {
    // Directory doesn't exist yet (nothing captured/downloaded so far) — zero usage, not an error.
    return { fileCount: 0, totalBytes: 0 };
  }
}

export interface StorageSnapshot {
  evidence: DirectoryUsage;
  mapPackages: DirectoryUsage;
}

export async function getStorageSnapshot(): Promise<StorageSnapshot> {
  const [evidence, mapPackages] = await Promise.all([
    measureDirectory(EVIDENCE_SUBDIR),
    measureDirectory(MAP_PACKAGE_SUBDIR),
  ]);
  return { evidence, mapPackages };
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
 * confirmed-uploaded 30+ days ago. Metadata — sha256, byte_size, type,
 * timestamps — stays for history (M14 "My Reports" still shows the
 * record); only the local copy of bytes already safely on the
 * workstation is removed, freeing space on a field device that has no
 * reason to keep re-holding a photo the server has long since confirmed.
 */
export async function pruneOldSyncedEvidenceFiles(): Promise<PruneResult> {
  const prunable = await listPrunableEvidence(EVIDENCE_RETENTION_DAYS_ON_DEVICE);
  let prunedCount = 0;
  let freedBytes = 0;
  for (const row of prunable) {
    await deleteEvidenceFile(row.filePath);
    await clearEvidenceFilePath(row.localId);
    prunedCount += 1;
    freedBytes += row.byteSize;
  }
  return { prunedCount, freedBytes };
}
