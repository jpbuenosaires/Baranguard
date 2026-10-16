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
import { Map as MaplibreMap, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { locateOutline } from 'ionicons/icons';
import { IonIcon } from '@ionic/react';
import { MbtilesReader } from '../services/mbtilesReader';
import { getActiveMapPackage, readMapPackageBytes } from '../services/mapPackageService';
import type { NearbyIncident, NearbyTanod } from '../services/apiService';
import type { DevicePosition } from '../services/geolocation';
import {
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  NAV_FOLLOW_ZOOM,
  POSITION_ZOOM,
  buildOfflineStyle,
  buildOnlineStyle,
  centerMap,
  closeCurrentReader,
  ensureProtocolRegistered,
  setCurrentReader,
  type FocusTarget,
} from './map/mapBasemap';
import { applyPinLabels, syncIncidentPins, syncTanodPins, type PinEntry } from './map/mapPins';
import { drawRoute } from './map/mapRoute';

export type { FocusTarget };


export type BasemapStatus =
  | { kind: 'loading' }
  | { kind: 'offline'; version: string }
  | { kind: 'online' }
  | { kind: 'unavailable' };

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
  /** Optional custom map container height (defaults to '340px' or '68dvh' in nav mode) */
  height?: string;
  /** When true, expands the map container edge-to-edge without border radius or card shadow */
  fullScreen?: boolean;
  /** When true, suppresses the internal floating locate FAB (for screens providing their own control rail) */
  hideRecenterFab?: boolean;
  /** Callback triggered when a Tanod pin is tapped on the map */
  onSelectTanod?: (tanod: NearbyTanod) => void;
  /** Callback triggered when an incident pin is tapped on the map */
  onSelectIncident?: (incident: NearbyIncident) => void;
  /** Callback triggered when empty map space is tapped */
  onDeselect?: () => void;
  /** Currently selected Tanod ID (highlights marker) */
  selectedTanodId?: number | null;
  /** Currently selected Incident ID (highlights marker) */
  selectedIncidentId?: number | null;
  /** True when the nearby data on screen is old or failed to refresh: markers are dimmed so they never read as live. */
  dataStale?: boolean;
}

const LiveMapCanvas = forwardRef<LiveMapCanvasHandle, Props>(function LiveMapCanvas(
  {
    barangayId,
    position,
    incidents,
    tanods,
    onStatusChange,
    focusTarget,
    onMapClick,
    routeGeometry,
    navigationMode,
    routeProgress,
    onUserPan,
    height,
    fullScreen,
    hideRecenterFab,
    onSelectTanod,
    onSelectIncident,
    onDeselect,
    selectedTanodId,
    selectedIncidentId,
    dataStale,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const selfMarkerRef = useRef<Marker | null>(null);
  const selfLabelRef = useRef<HTMLSpanElement | null>(null);
  const incidentPinsRef = useRef(new Map<number, PinEntry<NearbyIncident>>());
  const tanodPinsRef = useRef(new Map<number, PinEntry<NearbyTanod>>());
  /** Re-runs label thinning for the current zoom and screen positions. */
  const applyLabelsRef = useRef<() => void>(() => {});
  const selectedIdsRef = useRef<{ incident: number | null; tanod: number | null }>({ incident: null, tanod: null });
  selectedIdsRef.current = { incident: selectedIncidentId ?? null, tanod: selectedTanodId ?? null };
  const focusTargetRef = useRef(focusTarget);
  focusTargetRef.current = focusTarget;
  // Latest callback without re-subscribing the map's click listener on
  // every render (same "ref holds the current callback" idiom
  // FormFields.tsx's useElementEvent already uses in this codebase).
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const onUserPanRef = useRef(onUserPan);
  onUserPanRef.current = onUserPan;
  const onSelectTanodRef = useRef(onSelectTanod);
  onSelectTanodRef.current = onSelectTanod;
  const onSelectIncidentRef = useRef(onSelectIncident);
  onSelectIncidentRef.current = onSelectIncident;
  const onDeselectRef = useRef(onDeselect);
  onDeselectRef.current = onDeselect;
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
    const incidentPins = incidentPinsRef.current;
    const tanodPins = tanodPinsRef.current;
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
            setCurrentReader(reader);
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
        // Credit is the fixed .lm-canvas__credit pill below, for online and offline alike.
        attributionControl: false,
      });
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      map.on('click', (e) => {
        onDeselectRef.current?.();
        onMapClickRef.current?.({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
      });
      // Detect manual user interaction to pause navigation auto-follow.
      map.on('dragstart', () => {
        userPannedRef.current = true;
        onUserPanRef.current?.();
      });
      // Label thinning depends on zoom and on where markers sit on screen.
      map.on('moveend', () => applyLabelsRef.current());
      mapRef.current = map;
      setStatus(nextStatus);
    }

    void init();

    return () => {
      cancelled = true;
      selfMarkerRef.current?.remove();
      selfMarkerRef.current = null;
      selfLabelRef.current = null;
      incidentPins.forEach((p) => p.marker.remove());
      incidentPins.clear();
      tanodPins.forEach((p) => p.marker.remove());
      tanodPins.clear();
      mapRef.current?.remove();
      mapRef.current = null;
      closeCurrentReader();
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
      // Map-matching (Google Maps style road snapping): in navigation mode the
      // self marker sits on the road-snapped point so the dot glides along
      // the road instead of floating beside it due to raw GPS noise.
      const markerLng = (navigationMode && routeProgress)
        ? routeProgress.snappedPoint.lng
        : position.longitude;
      const markerLat = (navigationMode && routeProgress)
        ? routeProgress.snappedPoint.lat
        : position.latitude;

      // One marker for the session: moved and restyled in place, not rebuilt.
      let marker = selfMarkerRef.current;
      let el: HTMLElement | null = null;
      if (!marker) {
        const container = document.createElement('div');
        el = document.createElement('div');
        const label = document.createElement('span');
        label.className = 'live-map__pin-label';
        label.textContent = 'You';
        el.appendChild(label);
        container.appendChild(el);
        selfLabelRef.current = label;
        marker = new Marker({ element: container }).setLngLat([markerLng, markerLat]).addTo(map);
        selfMarkerRef.current = marker;
      } else {
        marker.setLngLat([markerLng, markerLat]);
        el = marker.getElement().firstElementChild as HTMLElement | null;
      }
      if (el) {
        const cls = navigationMode ? 'map-marker map-marker--self-navigating' : 'map-marker map-marker--self';
        if (el.className !== cls) el.className = cls;
        el.title = `Your position, accuracy ±${position.accuracyM.toFixed(0)}m`;
      }
    } else if (selfMarkerRef.current) {
      selfMarkerRef.current.remove();
      selfMarkerRef.current = null;
      selfLabelRef.current = null;
    }
    applyLabelsRef.current();

    if (!framedOnce.current && (position || focusTarget)) {
      framedOnce.current = true;
      centerMap(map, position, focusTarget, false);
    }
  // routeProgress added: re-snap marker on every nav update even if raw GPS didn't change.
  }, [position, focusTarget, status, navigationMode, routeProgress]);

  // Navigation auto-follow: when in navigation mode and the user hasn't
  // manually panned, smoothly track the user's snapped position with
  // heading-up rotation on every GPS update.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !navigationMode || !routeProgress || !position || userPannedRef.current) return;

    // Map-matching: camera follows the road-snapped point, not raw GPS.
    // This keeps the viewport centered on the road exactly like Google Maps.
    map.easeTo({
      center: [routeProgress.snappedPoint.lng, routeProgress.snappedPoint.lat],
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
          // Map-matching: snap back to the road point, not raw GPS.
          map?.easeTo({
            center: [routeProgress.snappedPoint.lng, routeProgress.snappedPoint.lat],
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
          speed: 1.2,
          curve: 1.42,
          essential: true,
        });
      },
    }),
    [position, focusTarget, navigationMode, routeProgress]
  );


  // Label policy: which markers show text at this zoom, thinned by overlap.
  applyLabelsRef.current = () => {
    const map = mapRef.current;
    if (!map) return;
    applyPinLabels(map, {
      selfMarker: selfMarkerRef.current,
      selfLabel: selfLabelRef.current,
      incidentPins: incidentPinsRef.current,
      tanodPins: tanodPinsRef.current,
      selected: selectedIdsRef.current,
      focusTarget: focusTargetRef.current,
    });
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncIncidentPins(map, incidentPinsRef.current, incidents, {
      focusTarget,
      selectedIncidentId,
      dataStale,
      onSelect: () => onSelectIncidentRef.current,
    });
    applyLabelsRef.current();
  }, [incidents, status, focusTarget, selectedIncidentId, dataStale]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncTanodPins(map, tanodPinsRef.current, tanods, {
      selectedTanodId,
      dataStale,
      onSelect: () => onSelectTanodRef.current,
    });
    applyLabelsRef.current();
  }, [tanods, status, selectedTanodId, dataStale]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    return drawRoute(map, { routeGeometry, position, focusTarget, navigationMode, routeProgress });
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
  const mapHeight = height ?? (navigationMode ? '68dvh' : '340px');

  return (
    <div className={`lm-canvas ${isFull ? 'lm-canvas--full' : ''}`}>
      <div
        ref={containerRef}
        className={`lm-canvas__map ${isFull ? 'lm-canvas__map--full' : ''} ${navigationMode ? 'map-container--navigating' : ''}`}
        style={isFull ? undefined : { height: mapHeight }}
      />
      <span className="lm-canvas__credit">© OpenStreetMap contributors</span>
      {!hideRecenterFab && (position || focusTarget) && (
        <button type="button" onClick={recenter} aria-label="Recenter map" className="lm-canvas__recenter">
          <IonIcon icon={locateOutline} />
        </button>
      )}
    </div>
  );
});

export default LiveMapCanvas;
