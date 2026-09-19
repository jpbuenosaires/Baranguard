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
 * here — see that file's header comment) at TWO levels: whole-session
 * (no package installed yet, or the installed one fails to open — see
 * init() below) AND per-tile (2026-09-18: a package exists and opens
 * fine, but the requested z/x/y simply isn't in it — e.g. a Tanod has
 * walked outside their downloaded package's covered area. The offline
 * reader stays PRIMARY either way — this only reaches the network for
 * the specific tiles the local package doesn't have, never for ones it
 * does, so the common in-barangay/poor-signal case still costs zero
 * network requests).
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
  setWorkerUrl,
  type GeoJSONSource,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { locateOutline } from 'ionicons/icons';
import { IonIcon } from '@ionic/react';
import { MbtilesReader } from '../services/mbtilesReader';
import { getActiveMapPackage, readMapPackageBytes } from '../services/mapPackageService';
import type { NearbyIncident, NearbyTanod } from '../services/apiService';
import type { DevicePosition } from '../services/geolocation';
import { splitRouteAtSnap } from '../utils/routeProgress';

// Register MapLibre's worker bundle with Vite so GeoJSON sources (route polyline) can be tiled in the background.
// Without this, MapLibre defaults to an empty workerUrl in bundled/Capacitor environments, causing GeoJSON sources
// to remain unloaded indefinitely and preventing vector lines from rendering.
setWorkerUrl(maplibreWorkerUrl);

/** Pilar, Sorsogon — matches web/src/components/LiveMap.js's default center. */
const DEFAULT_CENTER: [number, number] = [123.6667, 12.9186];
const DEFAULT_ZOOM = 13;
const POSITION_ZOOM = 15;
const TILE_PROTOCOL = 'baranguard-mbtiles';
const ROUTE_SOURCE_ID = 'route';
const ROUTE_CASING_LAYER_ID = 'route-line-casing';
const ROUTE_LAYER_ID = 'route-line';
const ROUTE_TRAVELED_SOURCE_ID = 'route-traveled';
const ROUTE_TRAVELED_LAYER_ID = 'route-line-traveled';
const ROUTE_REMAINING_SOURCE_ID = 'route-remaining';
const ROUTE_REMAINING_CASING_LAYER_ID = 'route-remaining-casing';
const ROUTE_REMAINING_LAYER_ID = 'route-line-remaining';
const ROUTE_GUIDELINE_SOURCE_ID = 'route-guideline';
const ROUTE_GUIDELINE_LAYER_ID = 'route-guideline-line';

/** Vibrant royal blue for the active route line (Google Maps style). */
const ROUTE_LINE_COLOR = '#2563eb';
/** White halo/casing separating the route from complex basemaps. */
const ROUTE_CASING_COLOR = '#ffffff';
/** Dimmed slate gray for the traveled portion of the route in navigation mode. */
const ROUTE_TRAVELED_COLOR = '#cbd5e1';
const NAV_FOLLOW_ZOOM = 17;

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
  /** Smoothly fly camera to specific coordinates with optional zoom */
  focusCoordinates: (lat: number, lng: number, zoom?: number) => void;
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
  /**
   * A road-snapped route geometry (already-decoded GeoJSON LineString —
   * see `apiService.getDispatchRoute()`/`OrsClient.php`'s own doc block
   * for why no polyline decoding is ever needed here) drawn on top of
   * the basemap. `null`/`undefined` draws nothing — assignment-detail.tsx
   * is the only caller that ever sets this, after its explicit "Get
   * Route" action.
   */
  routeGeometry?: { type: string; coordinates: [number, number][] } | null;
  /**
   * When true, the map enters navigation follow mode: auto-follows the
   * user's position, shows heading-up rotation, and splits the route
   * into traveled (gray) and remaining (blue) segments. Driven by the
   * "Start Navigation" button in assignment-detail.tsx.
   */
  navigationMode?: boolean;
  /**
   * Navigation progress data from routeProgress.ts — drives the camera
   * position, route split point, and bearing in navigation mode. Only
   * meaningful when `navigationMode` is true and a route is loaded.
   */
  routeProgress?: {
    snappedPoint: { lng: number; lat: number };
    routeBearing: number;
    snappedSegmentIndex: number;
    progressFraction: number;
  } | null;
  /**
   * Called when the user manually pans/drags the map during navigation
   * mode — the parent should pause auto-follow and show a "Re-center"
   * prompt. The existing recenter FAB already handles reactivation.
   */
  onUserPan?: () => void;
  /** Optional custom map container height (defaults to '340px' or '68vh' in nav mode) */
  height?: string;
  /** When true, expands the map container edge-to-edge without border radius or card shadow */
  fullScreen?: boolean;
  /** When true, suppresses the internal floating locate FAB (for screens providing their own control rail) */
  hideRecenterFab?: boolean;
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

function priorityMarkerClass(priority: string): string {
  if (priority === 'critical') return 'map-marker map-marker--critical';
  if (priority === 'high') return 'map-marker map-marker--high';
  return 'map-marker map-marker--normal';
}

const LiveMapCanvas = forwardRef<LiveMapCanvasHandle, Props>(function LiveMapCanvas(
  { barangayId, position, incidents, tanods, onStatusChange, focusTarget, onMapClick, routeGeometry, navigationMode, routeProgress, onUserPan, height, fullScreen, hideRecenterFab },
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
  const onUserPanRef = useRef(onUserPan);
  onUserPanRef.current = onUserPan;
  /** Tracks whether the user has manually panned the map (pauses auto-follow in nav mode). */
  const userPannedRef = useRef(false);
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
      // Detect manual user interaction to pause navigation auto-follow.
      map.on('dragstart', () => {
        userPannedRef.current = true;
        onUserPanRef.current?.();
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

    if (position && !isNaN(position.longitude) && !isNaN(position.latitude)) {
      selfMarkerRef.current?.remove();
      const container = document.createElement('div');
      const el = document.createElement('div');
      el.className = navigationMode ? 'map-marker map-marker--self-navigating' : 'map-marker map-marker--self';
      el.title = `Your position — accuracy ±${position.accuracyM.toFixed(0)}m`;
      container.appendChild(el);
      selfMarkerRef.current = new Marker({ element: container }).setLngLat([position.longitude, position.latitude]).addTo(map);
    }

    if (!framedOnce.current && (position || focusTarget)) {
      framedOnce.current = true;
      centerMap(map, position, focusTarget, false);
    }
  }, [position, focusTarget, status, navigationMode]);

  // Navigation auto-follow: when in navigation mode and the user hasn't
  // manually panned, smoothly track the user's snapped position with
  // heading-up rotation on every GPS update.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !navigationMode || !routeProgress || !position || userPannedRef.current) return;

    map.easeTo({
      center: [position.longitude, position.latitude],
      zoom: NAV_FOLLOW_ZOOM,
      bearing: routeProgress.routeBearing,
      duration: 500,
    });
  }, [navigationMode, position, routeProgress]);

  // 2026-09-18: `containerRef`'s height is CSS-animated (340px <-> 68vh
  // <-> 100%, `transition: 'height 0.3s ease'`) whenever navigationMode/
  // fullScreen/height change — e.g. assignment-detail.tsx switching from
  // the briefing view into turn-by-turn navigation. MapLibre sizes its
  // WebGL canvas from the container's dimensions AT THE TIME IT LAST
  // measured them; nothing here was ever calling `map.resize()` after a
  // layout change, so the canvas could stay sized for the OLD (briefing)
  // container while `getCenter()`/`getZoom()` correctly reported the new
  // camera — the route was really being drawn, just into a canvas that
  // no longer matched what was visually on screen. Resize once
  // immediately (covers a discrete height prop change) and once after
  // the CSS transition finishes (covers the animated navigationMode
  // switch, which fires no resize-observer-friendly single event).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.resize();
    const timer = setTimeout(() => map.resize(), 320);
    return () => clearTimeout(timer);
  }, [navigationMode, fullScreen, height]);

  useImperativeHandle(
    ref,
    () => ({
      recenter: () => {
        const map = mapRef.current;
        // Reset the user-panned flag so auto-follow resumes.
        userPannedRef.current = false;
        if (navigationMode && routeProgress && position) {
          // In navigation mode: snap to the user's current position with heading.
          map?.easeTo({
            center: [position.longitude, position.latitude],
            zoom: NAV_FOLLOW_ZOOM,
            bearing: routeProgress.routeBearing,
            duration: 500,
          });
        } else if (map) {
          centerMap(map, position, focusTarget, true);
        }
      },
      focusCoordinates: (lat: number, lng: number, zoom = 16) => {
        const map = mapRef.current;
        if (!map) return;
        userPannedRef.current = true;
        map.flyTo({
          center: [lng, lat],
          zoom,
          duration: 800,
          essential: true,
        });
      },
    }),
    [position, focusTarget, navigationMode, routeProgress]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    incidentMarkersRef.current.forEach((m) => m.remove());
    incidentMarkersRef.current = incidents
      .filter((incident: NearbyIncident) => typeof incident.longitude === 'number' && typeof incident.latitude === 'number' && !isNaN(incident.longitude) && !isNaN(incident.latitude))
      .map((incident: NearbyIncident) => {
        const isDestination =
          focusTarget &&
          Math.abs(incident.latitude - focusTarget.latitude) < 0.00005 &&
          Math.abs(incident.longitude - focusTarget.longitude) < 0.00005;

        // Container div is isolated for MapLibre's coordinate translation transforms
        const container = document.createElement('div');
        container.style.cursor = 'pointer';

        const el = document.createElement('div');
        el.className = isDestination
          ? `map-marker map-marker--destination ${priorityMarkerClass(incident.priority)}`
          : priorityMarkerClass(incident.priority);
        el.title = `${incident.incidentType.replace(/_/g, ' ')} · ${incident.priority} · ${Math.floor(incident.ageSeconds / 60)}m ago`;

        container.appendChild(el);
        return new Marker({ element: container }).setLngLat([incident.longitude, incident.latitude]).addTo(map);
      });
  }, [incidents, status, focusTarget]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tanodMarkersRef.current.forEach((m) => m.remove());
    tanodMarkersRef.current = tanods
      .filter((tanod: NearbyTanod) => typeof tanod.longitude === 'number' && typeof tanod.latitude === 'number' && !isNaN(tanod.longitude) && !isNaN(tanod.latitude))
      .map((tanod: NearbyTanod) => {
        const container = document.createElement('div');
        const el = document.createElement('div');
        el.className = `map-marker ${tanod.isStale ? 'map-marker--tanod-stale' : 'map-marker--tanod-live'}`;
        el.title = `${tanod.fullName} — ${tanod.isStale ? 'stale' : 'live'} · ${Math.floor(tanod.ageSeconds / 60)}m ago`;
        container.appendChild(el);
        return new Marker({ element: container }).setLngLat([tanod.longitude, tanod.latitude]).addTo(map);
      });
  }, [tanods, status]);

  // Draws/updates/clears the route line — a GeoJSON source+layer on top
  // of the raster basemap.
  //
  // Visual Hierarchy (Google Maps quality):
  //   1. Casing / Halo: 11px white line underneath, provides high contrast over roads & terrain
  //   2. Core Line: 7px vibrant royal blue (#2563eb)
  //   3. In Navigation mode: Traveled portion dims to 5px slate gray (#cbd5e1)
  //   4. Fallback Guideline: If route is unavailable/loading, draws a 4px dashed vector
  //      directly between user and target so a line is ALWAYS visible.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    /** Removes all route-related layers and sources. */
    function clearAllRouteLayers() {
      if (!map) return;
      const layers = [
        ROUTE_CASING_LAYER_ID,
        ROUTE_LAYER_ID,
        ROUTE_TRAVELED_LAYER_ID,
        ROUTE_REMAINING_CASING_LAYER_ID,
        ROUTE_REMAINING_LAYER_ID,
        ROUTE_GUIDELINE_LAYER_ID,
      ];
      for (const layerId of layers) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      }
      const sources = [
        ROUTE_SOURCE_ID,
        ROUTE_TRAVELED_SOURCE_ID,
        ROUTE_REMAINING_SOURCE_ID,
        ROUTE_GUIDELINE_SOURCE_ID,
      ];
      for (const sourceId of sources) {
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      }
    }

    function applyRoute() {
      if (!map) return;

      if (!map.isStyleLoaded()) {
        map.once('idle', applyRoute);
        return;
      }

      try {
        applyRouteBody();
      } catch (err) {
        console.warn('[LiveMapCanvas] applyRoute failed, retrying on idle:', err);
        map.once('idle', applyRoute);
      }
    }

    function applyRouteBody() {
      if (!map) return;
      // --- Fallback Guideline: When road route is not yet available, draw dashed direct line ---
      if (!routeGeometry && position && focusTarget) {
        clearAllRouteLayers();
        const directFeature: GeoJSON.Feature = {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [position.longitude, position.latitude],
              [focusTarget.longitude, focusTarget.latitude],
            ],
          },
        };
        map.addSource(ROUTE_GUIDELINE_SOURCE_ID, { type: 'geojson', data: directFeature });
        map.addLayer({
          id: ROUTE_GUIDELINE_LAYER_ID,
          type: 'line',
          source: ROUTE_GUIDELINE_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ROUTE_LINE_COLOR,
            'line-width': 4,
            'line-dasharray': [2, 2],
            'line-opacity': 0.85,
          },
        });
        return;
      }

      if (!routeGeometry) {
        clearAllRouteLayers();
        return;
      }

      // Remove fallback guideline if it was active
      if (map.getLayer(ROUTE_GUIDELINE_LAYER_ID)) map.removeLayer(ROUTE_GUIDELINE_LAYER_ID);
      if (map.getSource(ROUTE_GUIDELINE_SOURCE_ID)) map.removeSource(ROUTE_GUIDELINE_SOURCE_ID);

      // --- Navigation mode: split into traveled + remaining (with casing) ---
      if (navigationMode && routeProgress && routeGeometry.coordinates) {
        // Remove the static line layers if they exist
        if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
        if (map.getLayer(ROUTE_CASING_LAYER_ID)) map.removeLayer(ROUTE_CASING_LAYER_ID);
        if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);

        const { traveled, remaining } = splitRouteAtSnap(
          routeGeometry.coordinates,
          routeProgress.snappedSegmentIndex,
          routeProgress.snappedPoint,
        );

        const traveledFeature: GeoJSON.Feature = {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: traveled },
        };
        const remainingFeature: GeoJSON.Feature = {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: remaining },
        };

        // 1. Traveled layer (dimmed gray trail)
        const existingTraveled = map.getSource(ROUTE_TRAVELED_SOURCE_ID) as GeoJSONSource | undefined;
        if (existingTraveled) {
          existingTraveled.setData(traveledFeature);
        } else {
          map.addSource(ROUTE_TRAVELED_SOURCE_ID, { type: 'geojson', data: traveledFeature });
          map.addLayer({
            id: ROUTE_TRAVELED_LAYER_ID,
            type: 'line',
            source: ROUTE_TRAVELED_SOURCE_ID,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ROUTE_TRAVELED_COLOR, 'line-width': 5, 'line-opacity': 0.6 },
          });
        }

        // 2. Remaining layer (white casing halo + vibrant royal blue core)
        const existingRemaining = map.getSource(ROUTE_REMAINING_SOURCE_ID) as GeoJSONSource | undefined;
        if (existingRemaining) {
          existingRemaining.setData(remainingFeature);
        } else {
          map.addSource(ROUTE_REMAINING_SOURCE_ID, { type: 'geojson', data: remainingFeature });
          // Casing layer first (underneath)
          map.addLayer({
            id: ROUTE_REMAINING_CASING_LAYER_ID,
            type: 'line',
            source: ROUTE_REMAINING_SOURCE_ID,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ROUTE_CASING_COLOR, 'line-width': 11, 'line-opacity': 0.95 },
          });
          // Core route line
          map.addLayer({
            id: ROUTE_REMAINING_LAYER_ID,
            type: 'line',
            source: ROUTE_REMAINING_SOURCE_ID,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ROUTE_LINE_COLOR, 'line-width': 7, 'line-opacity': 0.95 },
          });
        }
        return;
      }

      // --- Static Overview Mode: High-contrast line with white casing ---
      // Clear navigation-mode split layers
      if (map.getLayer(ROUTE_TRAVELED_LAYER_ID)) map.removeLayer(ROUTE_TRAVELED_LAYER_ID);
      if (map.getSource(ROUTE_TRAVELED_SOURCE_ID)) map.removeSource(ROUTE_TRAVELED_SOURCE_ID);
      if (map.getLayer(ROUTE_REMAINING_LAYER_ID)) map.removeLayer(ROUTE_REMAINING_LAYER_ID);
      if (map.getLayer(ROUTE_REMAINING_CASING_LAYER_ID)) map.removeLayer(ROUTE_REMAINING_CASING_LAYER_ID);
      if (map.getSource(ROUTE_REMAINING_SOURCE_ID)) map.removeSource(ROUTE_REMAINING_SOURCE_ID);

      const data: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry: routeGeometry as GeoJSON.Geometry };
      const existing = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
      if (existing) {
        existing.setData(data);
      } else {
        map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data });
        // White casing halo (bottom layer)
        map.addLayer({
          id: ROUTE_CASING_LAYER_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ROUTE_CASING_COLOR, 'line-width': 11, 'line-opacity': 0.95 },
        });
        // Vibrant blue core line (top layer)
        map.addLayer({
          id: ROUTE_LAYER_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': ROUTE_LINE_COLOR, 'line-width': 7, 'line-opacity': 0.95 },
        });
      }
    }

    if (map.isStyleLoaded()) {
      applyRoute();
    } else {
      map.once('load', applyRoute);
      map.once('idle', applyRoute);
    }
    // This effect re-runs on every GPS tick (`position`), so without this
    // cleanup every run that lands before the style is ready leaves
    // another stale-closure `once()` listener queued; `off()` removes
    // one-time listeners too.
    return () => {
      map.off('load', applyRoute);
      map.off('idle', applyRoute);
    };
  }, [routeGeometry, status, navigationMode, routeProgress, position, focusTarget]);

  function recenter() {
    const map = mapRef.current;
    // Reset user-panned flag so auto-follow resumes in navigation mode.
    userPannedRef.current = false;
    if (navigationMode && routeProgress && position) {
      map?.easeTo({
        center: [position.longitude, position.latitude],
        zoom: NAV_FOLLOW_ZOOM,
        bearing: routeProgress.routeBearing,
        duration: 500,
      });
    } else if (map) {
      centerMap(map, position, focusTarget, true);
    }
  }

  const isFull = fullScreen || (navigationMode && height === '100%');
  const mapHeight = height ?? (navigationMode ? '68vh' : '340px');

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: isFull ? '100%' : 'auto',
        borderRadius: isFull ? '0' : 'var(--radius-md)',
        overflow: 'hidden',
        boxShadow: isFull ? 'none' : 'var(--shadow-elevated)',
      }}
    >
      <div
        ref={containerRef}
        className={navigationMode ? 'map-container--navigating' : undefined}
        style={{
          width: '100%',
          height: isFull ? '100%' : mapHeight,
          background: 'var(--tint-neutral-bg)',
          transition: 'height 0.3s ease',
        }}
      />
      {!hideRecenterFab && (position || focusTarget) && (
        <button
          type="button"
          onClick={recenter}
          aria-label="Recenter map"
          style={{
            position: 'absolute',
            right: '12px',
            bottom: '12px',
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
            zIndex: 8,
          }}
        >
          <IonIcon icon={locateOutline} />
        </button>
      )}
    </div>
  );
});

export default LiveMapCanvas;
