/** Basemap helpers for LiveMapCanvas: camera framing, offline MBTiles protocol, raster styles. */
import { LngLatBounds, Map as MaplibreMap, addProtocol, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { MbtilesReader } from '../../services/mbtilesReader';
import type { DevicePosition } from '../../services/geolocation';

// Register MapLibre's worker bundle with Vite so GeoJSON sources (route polyline) can be tiled in the background.
// Without this, MapLibre defaults to an empty workerUrl in bundled/Capacitor environments, causing GeoJSON sources
// to remain unloaded indefinitely and preventing vector lines from rendering.
setWorkerUrl(maplibreWorkerUrl);

/** Pilar, Sorsogon — matches web/src/components/LiveMap.js's default center. */
export const DEFAULT_CENTER: [number, number] = [123.6667, 12.9186];
export const DEFAULT_ZOOM = 13;
export const POSITION_ZOOM = 15;
const TILE_PROTOCOL = 'baranguard-mbtiles';
export const NAV_FOLLOW_ZOOM = 17;

export interface FocusTarget {
  latitude: number;
  longitude: number;
}

/** Frames the camera on whichever of self/focusTarget are available; both → fits bounds, one → centers on it. */
export function centerMap(
  map: MaplibreMap,
  position: DevicePosition | null,
  focusTarget: FocusTarget | null | undefined,
  animate: boolean
): void {
  const points: [number, number][] = [];
  if (position) points.push([position.longitude, position.latitude]);
  if (focusTarget) points.push([focusTarget.longitude, focusTarget.latitude]);
  if (points.length === 0) return;

  if (points.length === 1) {
    if (animate) {
      map.flyTo({ center: points[0], zoom: POSITION_ZOOM });
    } else {
      map.jumpTo({ center: points[0], zoom: POSITION_ZOOM });
    }
    return;
  }

  const bounds = points.slice(1).reduce((b, p) => b.extend(p), new LngLatBounds(points[0], points[0]));
  map.fitBounds(bounds, { padding: 56, maxZoom: POSITION_ZOOM, duration: animate ? 800 : 0 });
}

// The active reader and protocol registration are module-level, not
// per-component-instance: MapLibre's addProtocol() is a GLOBAL registry,
// so registering once and swapping the reader it reads from avoids
// double-registration races across mount/unmount (React dev double-invoke
// included) rather than trying to add/remove the protocol every mount.
let currentReader: MbtilesReader | null = null;
let protocolRegistered = false;

export function ensureProtocolRegistered(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  addProtocol(TILE_PROTOCOL, async (params) => {
    const match = /\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
    if (!match || !currentReader) {
      throw new Error('Offline basemap tile not available.');
    }
    const [, z, x, y] = match;
    const tile = currentReader.getTile(Number(z), Number(x), Number(y));
    if (tile) {
      return { data: tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength) };
    }
    // Not in the downloaded package — most likely the Tanod has walked
    // outside its covered area. The local package stays the PRIMARY
    // source (see this file's header comment); this per-tile network
    // fetch only ever runs for coordinates the package doesn't have, so
    // it never adds latency to a tile the offline reader could already
    // serve. If there's no connectivity out here either, this throws
    // like before and MapLibre just leaves that tile blank.
    const online = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
    if (!online.ok) {
      throw new Error('Tile not present in the offline package, and the online fallback failed.');
    }
    return { data: await online.arrayBuffer() };
  });
}

export function buildOnlineStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  };
}

export function buildOfflineStyle(reader: MbtilesReader): StyleSpecification {
  const { minzoom, maxzoom } = reader.info;
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [`${TILE_PROTOCOL}://tile/{z}/{x}/{y}`],
        tileSize: 256,
        minzoom: minzoom ?? 0,
        maxzoom: maxzoom ?? 19,
        // Deliberately NOT setting `bounds` from the package's metadata
        // here: MapLibre uses a source's `bounds` to decide which tiles
        // are even worth requesting, so a bounds clamp would stop it
        // from ever asking the TILE_PROTOCOL handler for coordinates
        // outside the downloaded package — which is exactly the case
        // that handler's online fallback exists to serve. Leaving bounds
        // unset costs nothing extra: the handler still answers
        // in-package tiles from disk with zero network calls.
      },
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  };
}

/** Swaps the reader the tile protocol serves from, closing the previous one. */
export function setCurrentReader(reader: MbtilesReader): void {
  currentReader?.close();
  currentReader = reader;
}

/** Closes and clears the active reader (map teardown). */
export function closeCurrentReader(): void {
  if (currentReader) {
    currentReader.close();
    currentReader = null;
  }
}
