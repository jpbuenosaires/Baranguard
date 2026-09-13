/**
 * mapPackageService.ts — downloads, SHA-256-verifies, and locally
 * activates the per-barangay offline MBTiles basemap package (§6 "Map
 * packages", §2 Rule 14: "client verifies SHA-256 before activation").
 *
 * DELIBERATE DEVIATION from `offline_map_package_local`'s pre-declared
 * schema (`db/localSchema.ts`): that table lives in the SQLCipher local
 * database, which `db/localDatabase.ts` refuses to open on the web
 * platform BY DESIGN (Android-only — see that file's own comment). Using
 * it here would make this whole feature untestable outside a physical
 * device, the same A1 blocker that has stalled the rest of the
 * local-storage layer (REMAINING.md A1). A basemap package carries no
 * PII/narrative — it's public map tiles, not incident data — so the
 * SQLCipher-at-rest guarantee that table exists for was never actually
 * needed here. Activation metadata is tracked instead via
 * `@capacitor/preferences` (already this app's pattern for
 * `deviceIdentity.ts`/`session.ts`, and cross-platform), and the package
 * bytes via `@capacitor/filesystem`'s `Directory.Data` (the same
 * app-private storage `evidenceCapture.ts` already uses for photo/voice
 * evidence). `offline_map_package_local` stays unused for now — a future
 * session could migrate onto it once this path is device-verified,
 * without changing the exported functions below.
 */

import { Directory, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { downloadMapPackage, getMapPackage } from './apiService';

const PACKAGE_DIR = 'map-packages';
const ACTIVE_KEY_PREFIX = 'baranguard.mapPackage.';

export interface ActiveMapPackage {
  barangayId: number;
  version: string;
  checksumSha256: string;
  /** Capacitor Filesystem-relative path, always under Directory.Data. */
  filePath: string;
  /** ISO 8601 UTC. */
  installedAt: string;
}

function prefKey(barangayId: number): string {
  return `${ACTIVE_KEY_PREFIX}${barangayId}`;
}

async function ensurePackageDir(): Promise<void> {
  try {
    await Filesystem.mkdir({ path: PACKAGE_DIR, directory: Directory.Data, recursive: true });
  } catch {
    // Filesystem.mkdir throws if the directory already exists — the
    // common case after the first download, same pattern as
    // evidenceCapture.ts's ensureEvidenceDir().
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS 5.7+ made TypedArray generic over its backing buffer
  // (Uint8Array<ArrayBufferLike> vs. lib.dom's BufferSource wanting
  // <ArrayBuffer> specifically) — a type-modeling gap between the two
  // lib defs, not a real runtime mismatch; every Uint8Array this module
  // passes here is always ArrayBuffer-backed.
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Chunked to avoid blowing the call stack on `String.fromCharCode(...bytes)` for a multi-MB file. */
function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function base64ToBytes(base64: string): Promise<Uint8Array> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whichever package is currently installed for this barangay, or null if none has ever downloaded. */
export async function getActiveMapPackage(barangayId: number): Promise<ActiveMapPackage | null> {
  const { value } = await Preferences.get({ key: prefKey(barangayId) });
  if (!value) return null;
  try {
    return JSON.parse(value) as ActiveMapPackage;
  } catch {
    return null;
  }
}

/** Reads the installed package's raw MBTiles bytes back out, for `mbtilesReader.ts` to open. */
export async function readMapPackageBytes(pkg: ActiveMapPackage): Promise<Uint8Array> {
  const read = await Filesystem.readFile({ path: pkg.filePath, directory: Directory.Data });
  if (typeof read.data === 'string') {
    return base64ToBytes(read.data);
  }
  // Web platform's Filesystem implementation returns a Blob (native
  // returns base64 — see @capacitor/filesystem's own ReadFileResult doc).
  return new Uint8Array(await read.data.arrayBuffer());
}

async function downloadAndInstall(
  barangayId: number,
  version: string,
  expectedChecksum: string
): Promise<ActiveMapPackage | null> {
  const bytes = await downloadMapPackage(barangayId);
  const actualChecksum = await sha256Hex(bytes);
  if (actualChecksum !== expectedChecksum) {
    // §2 Rule 14 / §6: never activate an unverified package — a
    // corrupted or tampered transfer must fall back to whatever (if
    // anything) was already installed, not silently replace it.
    return null;
  }

  await ensurePackageDir();
  const filePath = `${PACKAGE_DIR}/barangay-${barangayId}-${version}.mbtiles`;
  await Filesystem.writeFile({ path: filePath, directory: Directory.Data, data: bytesToBase64(bytes) });

  const record: ActiveMapPackage = {
    barangayId,
    version,
    checksumSha256: actualChecksum,
    filePath,
    installedAt: new Date().toISOString(),
  };
  await Preferences.set({ key: prefKey(barangayId), value: JSON.stringify(record) });
  return record;
}

/**
 * Checks the server for the published package and downloads it only if
 * this device doesn't already have that exact version installed. NEVER
 * THROWS — offline or a server error just means "keep using whatever's
 * already installed" (§2 Rule 15's degrade-not-crash), the same non-fatal
 * treatment `runPostLoginSetup()` in login.tsx already gives this same
 * check.
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
