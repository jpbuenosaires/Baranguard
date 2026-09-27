/**
 * Downloads, SHA-256-verifies, and locally activates the per-barangay
 * offline MBTiles basemap package (Rule 14: verify before activation).
 *
 * Ported from ../mobile's mapPackageService.ts. Same deliberate deviation
 * from `offline_map_package_local`'s schema: a basemap carries no PII, so
 * it doesn't need to live inside the encrypted SQLCipher store — tracked
 * instead via AsyncStorage (metadata) + expo-file-system (bytes).
 *
 * Differs from the old app in mechanism, not behavior: expo-sqlite's
 * File.downloadFileAsync() streams straight to disk (no base64 round
 * trip through a multi-MB string), and Phase 5's MapLibre RN component
 * takes the file's URI directly rather than raw bytes for a JS-side
 * sql.js reader.
 */
import { digest, CryptoDigestAlgorithm } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { mapPackageDownloadUrl, getMapPackage } from './apiService';
import { loadSession } from './session';
import { prefs } from './storage';

const PACKAGE_DIR_NAME = 'map-packages';
const ACTIVE_KEY_PREFIX = 'baranguard.mapPackage.';

export interface ActiveMapPackage {
  barangayId: number;
  version: string;
  checksumSha256: string;
  /** file:// URI under the app's document directory. */
  fileUri: string;
  /** ISO 8601 UTC. */
  installedAt: string;
}

function prefKey(barangayId: number): string {
  return `${ACTIVE_KEY_PREFIX}${barangayId}`;
}

function packageDir(): Directory {
  const dir = new Directory(Paths.document, PACKAGE_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

async function sha256Hex(file: File): Promise<string> {
  const bytes = await digest(CryptoDigestAlgorithm.SHA256, await file.arrayBuffer());
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whichever package is currently installed for this barangay, or null if none has ever downloaded. */
export async function getActiveMapPackage(barangayId: number): Promise<ActiveMapPackage | null> {
  const value = await prefs.get(prefKey(barangayId));
  if (!value) return null;
  try {
    return JSON.parse(value) as ActiveMapPackage;
  } catch {
    return null;
  }
}

async function downloadAndInstall(barangayId: number, version: string, expectedChecksum: string): Promise<ActiveMapPackage | null> {
  const session = await loadSession();
  if (!session) return null;

  const destination = new File(packageDir(), `barangay-${barangayId}-${version}.mbtiles`);
  let downloaded: File;
  try {
    downloaded = await File.downloadFileAsync(mapPackageDownloadUrl(barangayId), destination, {
      headers: { Authorization: `Bearer ${session.token}` },
      idempotent: true,
    });
  } catch {
    return null;
  }

  const actualChecksum = await sha256Hex(downloaded);
  if (actualChecksum !== expectedChecksum) {
    // Rule 14: never activate an unverified package — leave whatever was
    // already installed in place, don't silently swap it for a corrupted one.
    downloaded.delete();
    return null;
  }

  const record: ActiveMapPackage = {
    barangayId,
    version,
    checksumSha256: actualChecksum,
    fileUri: downloaded.uri,
    installedAt: new Date().toISOString(),
  };
  await prefs.set(prefKey(barangayId), JSON.stringify(record));
  return record;
}

/**
 * Downloads the published package only if this device doesn't already have
 * that exact version. NEVER THROWS — offline or a server error just means
 * "keep using whatever's already installed" (degrade, don't crash).
 */
export async function ensureMapPackageDownloaded(barangayId: number): Promise<ActiveMapPackage | null> {
  const existing = await getActiveMapPackage(barangayId);
  try {
    const metadata = await getMapPackage(barangayId);
    if (!metadata) return existing;
    if (existing && existing.version === metadata.version && existing.checksumSha256 === metadata.checksumSha256) {
      return existing;
    }
    const installed = await downloadAndInstall(barangayId, metadata.version, metadata.checksumSha256);
    return installed ?? existing;
  } catch {
    return existing;
  }
}
