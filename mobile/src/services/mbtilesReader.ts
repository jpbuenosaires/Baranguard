/**
 * mbtilesReader.ts — reads raster tiles out of a downloaded MBTiles
 * (SQLite) basemap package entirely in JS/WASM via sql.js.
 *
 * This is what lets M7 Live Map render a real offline basemap without the
 * native map-rendering plugin `live-map.tsx`'s own header comment used to
 * flag as the blocker (see REMAINING.md C4): MapLibre GL JS and sql.js
 * both run inside the same Capacitor WebView as the rest of this app —
 * no AndroidManifest change, no new native Capacitor plugin.
 *
 * MBTiles spec (https://github.com/mapbox/mbtiles-spec): a `tiles(
 * zoom_level, tile_column, tile_row, tile_data)` table using TMS row
 * numbering, which is Y-flipped from the XYZ scheme MapLibre/OSM/this
 * app's other GPS code all use — `getTile()` below takes XYZ and does the
 * flip internally so callers never have to think about it. A `metadata(
 * name, value)` table carries `format`/`bounds`/`minzoom`/`maxzoom`.
 * `MapPackagesController.php`'s upload validation already confirms both
 * tables exist before a package is ever published, so a package that
 * reaches this reader is expected to have this shape.
 */

import initSqlJs from 'sql.js/dist/sql-wasm.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

let sqlJsPromise: ReturnType<typeof initSqlJs> | null = null;

function loadSqlJs() {
  if (!sqlJsPromise) {
    // `locateFile` points sql.js at the Vite-bundled, same-origin wasm
    // asset instead of its own default (a relative-to-script-tag guess
    // that doesn't hold once Vite has hashed/relocated the file) — no
    // network fetch ever leaves the device, matching this app's
    // vendor-don't-fetch precedent for Inter (theme/variables.css).
    sqlJsPromise = initSqlJs({ locateFile: () => sqlWasmUrl });
  }
  return sqlJsPromise;
}

type SqlJsModule = Awaited<ReturnType<typeof loadSqlJs>>;
type SqlDatabase = InstanceType<SqlJsModule['Database']>;

export interface MbtilesInfo {
  /** 'png' | 'jpg' | 'jpeg' | 'webp' — anything else is passed through as-is. */
  format: string;
  minzoom: number | null;
  maxzoom: number | null;
  /** [west, south, east, north], degrees — MBTiles' own `bounds` metadata key. */
  bounds: [number, number, number, number] | null;
  name: string | null;
}

const MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** MIME type for the package's declared tile format, for whoever serves the tile bytes onward. */
export function mimeTypeForFormat(format: string): string {
  return MIME_BY_FORMAT[format.toLowerCase()] ?? 'image/png';
}

export class MbtilesReader {
  private constructor(private readonly db: SqlDatabase, readonly info: MbtilesInfo) {}

  static async open(bytes: Uint8Array): Promise<MbtilesReader> {
    const SQL = await loadSqlJs();
    const db = new SQL.Database(bytes);
    return new MbtilesReader(db, readMetadata(db));
  }

  /**
   * `z`/`x`/`y` in the XYZ scheme (what MapLibre and every other caller in
   * this app use); MBTiles' own `tile_row` is TMS, so this flips it.
   * Returns null for "no tile at this coordinate" (a genuinely sparse
   * package, e.g. only certain zoom levels captured) — not an error.
   */
  getTile(z: number, x: number, y: number): Uint8Array | null {
    const tmsY = 2 ** z - 1 - y;
    const result = this.db.exec(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ? LIMIT 1',
      [z, x, tmsY]
    );
    const value = result[0]?.values?.[0]?.[0];
    return value instanceof Uint8Array ? value : null;
  }

  close(): void {
    this.db.close();
  }
}

function readMetadata(db: SqlDatabase): MbtilesInfo {
  const rows = db.exec('SELECT name, value FROM metadata');
  const map = new Map<string, string>();
  for (const [name, value] of rows[0]?.values ?? []) {
    if (typeof name === 'string' && typeof value === 'string') map.set(name, value);
  }

  const bounds = map.get('bounds');
  const parsedBounds = bounds ? bounds.split(',').map(Number) : null;
  const validBounds =
    parsedBounds && parsedBounds.length === 4 && parsedBounds.every((n) => Number.isFinite(n))
      ? (parsedBounds as [number, number, number, number])
      : null;

  return {
    format: map.get('format') ?? 'png',
    minzoom: map.has('minzoom') ? Number(map.get('minzoom')) : null,
    maxzoom: map.has('maxzoom') ? Number(map.get('maxzoom')) : null,
    bounds: validBounds,
    name: map.get('name') ?? null,
  };
}
