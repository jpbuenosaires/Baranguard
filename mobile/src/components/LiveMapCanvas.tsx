/**
 * LiveMapCanvas.tsx — the rendered basemap for M7 Live Map, and (since
 * 2026-09-13) for M6 Assignment Detail's in-app destination view.
 *
 * Renders via MapLibre GL JS, installed as a real npm dependency (mobile
 * has a genuine Vite bundle, unlike `web/`, which hand-vendors everything
 * because it has no build step at all — see package.json). Tile source is
 * OFFLINE-FIRST: when this barangay has a downloaded, checksum-verified
 * MBTiles package (`mapPackageService.ts`), tiles are read locally
 * through sql.js (`mbtilesReader.ts`) via a MapLibre custom protocol — no
 * network request per tile, honoring §2 Rule 7/15's offline-first
 * requirement for the field app. Falls back to online OpenStreetMap
 * raster tiles (the same source `web/src/components/LiveMap.js` already
 * uses, and the same "deliberate, logged deviation" reasoning applies
 * here — see that file's header comment) only when no package is
 * installed yet, or the installed one fails to open.
 *
 * Everything here runs inside the existing Capacitor WebView. No native
 * map plugin, no AndroidManifest change — this is what removes the
 * "materially bigger native dependency" blocker `live-map.tsx` used to
 * document (REMAINING.md C4).
 *
 * `focusTarget` (2026-09-13): assignment-detail.tsx has exactly ONE point
 * of interest (the assignment's destination), unlike Live Map's
 * open-ended incident/Tanod lists — passing it here makes the camera fit
 * self+destination via `fitBounds` instead of centering on self alone.
 * This is also what replaced assignment-detail's old `geo:` intent
 * hand-off to the device's external maps app: a Tanod now sees the
 * destination on Baranguard's OWN map instead of losing focus to Google
 * Maps. `LiveMapCanvasHandle.recenter()` (via `forwardRef`) is what that
 * screen's "Navigate" button now calls, reusing the exact same framing
 * logic (`centerMap`) the internal recenter FAB already used.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  LngLatBounds,
  Map as MaplibreMap,
  Marker,
  NavigationControl,
  addProtocol,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { locateOutline } from 'ionicons/icons';
import { IonIcon } from '@ionic/react';
import { MbtilesReader } from '../services/mbtilesReader';
import { getActiveMapPackage, readMapPackageBytes } from '../services/mapPackageService';
import type { NearbyIncident, NearbyTanod } from '../services/apiService';
import type { DevicePosition } from '../services/geolocation';

/** Pilar, Sorsogon — matches web/src/components/LiveMap.js's default center. */
const DEFAULT_CENTER: [number, number] = [123.6667, 12.9186];
const DEFAULT_ZOOM = 13;
const POSITION_ZOOM = 15;
const TILE_PROTOCOL = 'baranguard-mbtiles';

export type BasemapStatus =
  | { kind: 'loading' }
  | { kind: 'offline'; version: string }
  | { kind: 'online' }
  | { kind: 'unavailable' };

export interface FocusTarget {
  latitude: number;
  longitude: number;
}

export interface LiveMapCanvasHandle {
  /** Re-frames the camera on self + focusTarget (whichever are available) — the same logic the internal recenter FAB uses. */
  recenter: () => void;
}

interface Props {
  barangayId: number | null;
  position: DevicePosition | null;
  incidents: NearbyIncident[];
  tanods: NearbyTanod[];
  onStatusChange?: (status: BasemapStatus) => void;
  /**
   * When set, the camera fits both self and this point instead of just
   * centering on self — assignment-detail.tsx uses this to keep the
   * Tanod's own position AND the assignment's destination in view at
   * once, since that screen has exactly one point of interest rather than
   * Live Map's open-ended incident/Tanod lists.
   */
  focusTarget?: FocusTarget | null;
  /**
   * When set, tapping the map calls this with the tapped coordinate
   * instead of doing nothing — `LocationPickerModal.tsx` (M3 GPS/map
   * picker, Mobile Improvement Plan Phase 2.1) uses this to let a Tanod
   * drop a pin rather than only ever trusting the device's own GPS fix.
   */
  onMapClick?: (point: FocusTarget) => void;
}

/** Frames the camera on whichever of self/focusTarget are available; both → fits bounds, one → centers on it. */
function centerMap(
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

function ensureProtocolRegistered(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  addProtocol(TILE_PROTOCOL, async (params) => {
    const match = /\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
    if (!match || !currentReader) {
      throw new Error('Offline basemap tile not available.');
    }
    const [, z, x, y] = match;
    const tile = currentReader.getTile(Number(z), Number(x), Number(y));
    if (!tile) {
      throw new Error('Tile not present in the offline package.');
    }
    return { data: tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength) };
  });
}

function buildOnlineStyle(): StyleSpecification {
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

function buildOfflineStyle(reader: MbtilesReader): StyleSpecification {
  const { minzoom, maxzoom, bounds } = reader.info;
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [`${TILE_PROTOCOL}://tile/{z}/{x}/{y}`],
        tileSize: 256,
        minzoom: minzoom ?? 0,
        maxzoom: maxzoom ?? 19,
        ...(bounds ? { bounds } : {}),
      },
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  };
}

function priorityMarkerClass(priority: string): string {
  if (priority === 'critical') return 'map-marker map-marker--critical';
  if (priority === 'high') return 'map-marker map-marker--high';
  return 'map-marker map-marker--normal';
}

const LiveMapCanvas = forwardRef<LiveMapCanvasHandle, Props>(function LiveMapCanvas(
  { barangayId, position, incidents, tanods, onStatusChange, focusTarget, onMapClick },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const selfMarkerRef = useRef<Marker | null>(null);
  const incidentMarkersRef = useRef<Marker[]>([]);
  const tanodMarkersRef = useRef<Marker[]>([]);
  // Latest callback without re-subscribing the map's click listener on
  // every render (same "ref holds the current callback" idiom
  // FormFields.tsx's useElementEvent already uses in this codebase).
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const [status, setStatus] = useState<BasemapStatus>({ kind: 'loading' });

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  // Create the map once per barangay (a Tanod's barangay never changes
  // mid-session — re-login is required to switch). Position/incidents/
  // tanods update markers in a separate effect below rather than
  // recreating the whole map on every 15-30s telemetry refresh.
  useEffect(() => {
    let cancelled = false;
    ensureProtocolRegistered();
    setStatus({ kind: 'loading' });

    async function init() {
      let style = buildOnlineStyle();
      let nextStatus: BasemapStatus = { kind: 'online' };

      if (barangayId !== null) {
        try {
          const pkg = await getActiveMapPackage(barangayId);
          if (pkg) {
            const bytes = await readMapPackageBytes(pkg);
            const reader = await MbtilesReader.open(bytes);
            if (cancelled) {
              reader.close();
              return;
            }
            currentReader?.close();
            currentReader = reader;
            style = buildOfflineStyle(reader);
            nextStatus = { kind: 'offline', version: pkg.version };
          }
        } catch {
          // Corrupt/partial file on disk, or not real MBTiles — fall back
          // to the online style rather than showing a broken map. A
          // re-download on the next `ensureMapPackageDownloaded()` call
          // (next login) is the self-healing path; this component doesn't
          // retry on its own.
        }
      }

      if (cancelled || !containerRef.current) return;

      const initialPoint = focusTarget ?? position;
      const map = new MaplibreMap({
        container: containerRef.current,
        style,
        center: initialPoint ? [initialPoint.longitude, initialPoint.latitude] : DEFAULT_CENTER,
        zoom: initialPoint ? POSITION_ZOOM : DEFAULT_ZOOM,
        attributionControl: nextStatus.kind === 'online' ? undefined : false,
      });
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      map.on('click', (e) => {
        onMapClickRef.current?.({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
      });
      mapRef.current = map;
      setStatus(nextStatus);
    }

    void init();

    return () => {
      cancelled = true;
      selfMarkerRef.current?.remove();
      selfMarkerRef.current = null;
      incidentMarkersRef.current.forEach((m) => m.remove());
      incidentMarkersRef.current = [];
      tanodMarkersRef.current.forEach((m) => m.remove());
      tanodMarkersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
      if (currentReader) {
        currentReader.close();
        currentReader = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- position is intentionally excluded: it only seeds the initial center, not a rebuild trigger.
  }, [barangayId]);

  // Self marker — recreated whenever position changes. Frames the camera
  // exactly ONCE overall (self alone, focusTarget alone, or — the case
  // assignment-detail.tsx cares about — both via fitBounds once position
  // arrives after the map was already centered on focusTarget alone) so
  // live polling never yanks the view out from under a Tanod who has
  // manually panned/zoomed.
  const framedOnce = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (position) {
      selfMarkerRef.current?.remove();
      const el = document.createElement('div');
      el.className = 'map-marker map-marker--self';
      el.title = `Your position — accuracy ±${position.accuracyM.toFixed(0)}m`;
      selfMarkerRef.current = new Marker({ element: el }).setLngLat([position.longitude, position.latitude]).addTo(map);
    }

    if (!framedOnce.current && (position || focusTarget)) {
      framedOnce.current = true;
      centerMap(map, position, focusTarget, false);
    }
  }, [position, focusTarget, status]);

  useImperativeHandle(
    ref,
    () => ({
      recenter: () => {
        const map = mapRef.current;
        if (map) centerMap(map, position, focusTarget, true);
      },
    }),
    [position, focusTarget]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    incidentMarkersRef.current.forEach((m) => m.remove());
    incidentMarkersRef.current = incidents.map((incident: NearbyIncident) => {
      const el = document.createElement('div');
      el.className = priorityMarkerClass(incident.priority);
      el.title = `${incident.incidentType.replace(/_/g, ' ')} · ${incident.priority} · ${Math.floor(incident.ageSeconds / 60)}m ago`;
      return new Marker({ element: el }).setLngLat([incident.longitude, incident.latitude]).addTo(map);
    });
  }, [incidents, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tanodMarkersRef.current.forEach((m) => m.remove());
    tanodMarkersRef.current = tanods.map((tanod: NearbyTanod) => {
      const el = document.createElement('div');
      el.className = `map-marker ${tanod.isStale ? 'map-marker--tanod-stale' : 'map-marker--tanod-live'}`;
      el.title = `${tanod.fullName} — ${tanod.isStale ? 'stale' : 'live'} · ${Math.floor(tanod.ageSeconds / 60)}m ago`;
      return new Marker({ element: el }).setLngLat([tanod.longitude, tanod.latitude]).addTo(map);
    });
  }, [tanods, status]);

  function recenter() {
    const map = mapRef.current;
    if (map) centerMap(map, position, focusTarget, true);
  }

  return (
    <div style={{ position: 'relative', borderRadius: 'var(--radius-md)', overflow: 'hidden', boxShadow: 'var(--shadow-elevated)' }}>
      <div ref={containerRef} style={{ width: '100%', height: '280px', background: 'var(--tint-neutral-bg)' }} />
      {(position || focusTarget) && (
        <button
          type="button"
          onClick={recenter}
          aria-label="Recenter map"
          style={{
            position: 'absolute',
            right: '10px',
            bottom: '10px',
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            border: 'none',
            background: 'var(--color-bg)',
            color: 'var(--color-primary)',
            boxShadow: 'var(--shadow-fab)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.25rem',
          }}
        >
          <IonIcon icon={locateOutline} />
        </button>
      )}
    </div>
  );
});

export default LiveMapCanvas;
