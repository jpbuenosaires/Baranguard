/**
 * Reads an MBTiles package's own `metadata` table (format/minzoom/maxzoom/
 * bounds) via expo-sqlite — replaces ../mobile's mbtilesReader.ts (sql.js +
 * WASM), which read the exact same table for the exact same reason.
 *
 * Tile serving itself no longer goes through JS at all: MapLibre Native's
 * Android SDK understands an `mbtiles://<absolute-path>` tile URL directly
 * (LiveMapCanvas.tsx converts the downloaded package's `file://` URI to that
 * scheme), so this file's only job is the small amount of metadata MapLibre
 * doesn't infer on its own — the RasterSource's `minzoom`/`maxzoom` (an
 * unset range defaults to 0-22, which would have the map requesting zoom
 * levels this package was never built for).
 *
 * Opening a plain (non-SQLCipher) database with this build's SQLCipher-
 * enabled expo-sqlite is safe: SQLCipher only encrypts once a `PRAGMA key`
 * is set on a connection, which this function never does — an MBTiles file
 * carries no PII (Rule 1 doesn't apply) so it was never encrypted to begin
 * with.
 */
import { openDatabaseAsync } from 'expo-sqlite';

export interface MbtilesInfo {
  /** 'png' | 'jpg' | 'jpeg' | 'webp' — anything else is passed through as-is. */
  format: string;
  minzoom: number | null;
  maxzoom: number | null;
  /** [west, south, east, north], degrees — MBTiles' own `bounds` metadata key. */
  bounds: [number, number, number, number] | null;
}

/**
 * `fileUri` is the `file://…` URI expo-file-system returned when the
 * package was downloaded (`mapPackageService.ts`'s `ActiveMapPackage.fileUri`).
 * Returns null on any failure (corrupt/partial file, wrong shape) — callers
 * fall back to MapLibre's own defaults rather than crash.
 */
export async function readMbtilesMetadata(fileUri: string): Promise<MbtilesInfo | null> {
  const match = /^file:\/\/(\/.*\/)([^/]+)$/.exec(fileUri);
  if (!match) return null;
  const [, directory, databaseName] = match;

  let db;
  try {
    db = await openDatabaseAsync(databaseName, undefined, directory);
    const rows = await db.getAllAsync<{ name: string; value: string }>('SELECT name, value FROM metadata');
    const map = new Map(rows.map((row) => [row.name, row.value]));

    const boundsRaw = map.get('bounds');
    const parsedBounds = boundsRaw ? boundsRaw.split(',').map(Number) : null;
    const validBounds =
      parsedBounds && parsedBounds.length === 4 && parsedBounds.every((n) => Number.isFinite(n))
        ? (parsedBounds as [number, number, number, number])
        : null;

    return {
      format: map.get('format') ?? 'png',
      minzoom: map.has('minzoom') ? Number(map.get('minzoom')) : null,
      maxzoom: map.has('maxzoom') ? Number(map.get('maxzoom')) : null,
      bounds: validBounds,
    };
  } catch {
    return null;
  } finally {
    await db?.closeAsync().catch(() => undefined);
  }
}

/** `file://` -> `mbtiles://`, what MapLibre Native's Android SDK recognizes as a local-file raster tile source. */
export function toMbtilesUrl(fileUri: string): string {
  return fileUri.replace(/^file:\/\//, 'mbtiles://');
}
