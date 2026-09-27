/**
 * LiveMapCanvas.tsx — the rendered basemap for M7 Live Map and M6 Assignment
 * Detail's in-app destination view. Port of ../mobile's LiveMapCanvas.tsx
 * (MapLibre GL JS + sql.js) onto `@maplibre/maplibre-react-native` (MapLibre
 * Native), which is what actually removes the JS-side offline-tile-reader
 * dependency that file's own header comment described — MapLibre Native's
 * Android SDK understands an `mbtiles://<absolute-path>` tile URL directly,
 * so the downloaded MBTiles package (`mapPackageService.ts`) is read
 * natively with zero network requests per tile, no sql.js/WASM involved.
 * `mbtilesMetadata.ts` only supplies the small amount of metadata MapLibre
 * doesn't infer on its own (minzoom/maxzoom).
 *
 * Falls back to online OpenStreetMap raster tiles — same source and same
 * "deliberate, logged deviation" reasoning as `web/src/components/LiveMap.js`
 * — at whole-session granularity (no package installed yet, or the
 * installed one fails to read) rather than per-tile: MapLibre Native's own
 * `mbtiles://` handler doesn't expose a JS-reachable per-tile-missing hook
 * the way the old sql.js reader's custom protocol did, so a Tanod walking
 * outside their downloaded package's covered area sees blank tiles rather
 * than an automatic per-tile online fetch. The offline reader stays PRIMARY
 * either way, which is what matters for §2 Rule 7/15's offline-first
 * requirement inside the covered area.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  Marker,
  RasterSource,
  type CameraRef,
  type LngLat,
  type LngLatBounds,
} from '@maplibre/maplibre-react-native';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { getActiveMapPackage } from '../services/mapPackageService';
import { readMbtilesMetadata, toMbtilesUrl } from '../services/mbtilesMetadata';
import type { NearbyIncident, NearbyTanod } from '../services/apiService';
import type { DevicePosition } from '../services/geolocation';
import { splitRouteAtSnap } from '../utils/routeProgress';

/** Pilar, Sorsogon — matches ../mobile's and web's default center. */
const DEFAULT_CENTER: LngLat = [123.6667, 12.9186];
const DEFAULT_ZOOM = 13;
const POSITION_ZOOM = 15;
const NAV_FOLLOW_ZOOM = 17;
const FIT_PADDING = { top: 56, right: 56, bottom: 56, left: 56 };

/** No basemap of its own — the OSM/mbtiles RasterSource below is the entire visual layer. */
const EMPTY_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] };

const ROUTE_LINE_COLOR = '#2563eb';
const ROUTE_CASING_COLOR = '#ffffff';
const ROUTE_TRAVELED_COLOR = '#cbd5e1';

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
  recenter: () => void;
  focusCoordinates: (lat: number, lng: number, zoom?: number) => void;
}

interface Props {
  barangayId: number | null;
  position: DevicePosition | null;
  incidents: NearbyIncident[];
  tanods: NearbyTanod[];
  onStatusChange?: (status: BasemapStatus) => void;
  focusTarget?: FocusTarget | null;
  onMapClick?: (point: FocusTarget) => void;
  routeGeometry?: { type: string; coordinates: [number, number][] } | null;
  navigationMode?: boolean;
  routeProgress?: {
    snappedPoint: { lng: number; lat: number };
    routeBearing: number;
    snappedSegmentIndex: number;
    progressFraction: number;
  } | null;
  onUserPan?: () => void;
  /** Container height in dp. Defaults to 340, or 420 in navigation mode. */
  height?: number;
  hideRecenterFab?: boolean;
}

function boundsOf(points: LngLat[]): LngLatBounds {
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

function priorityMarkerColor(priority: string): string {
  if (priority === 'critical') return '#dc2626';
  if (priority === 'high') return '#f59e0b';
  return '#2563eb';
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
    hideRecenterFab,
  },
  ref,
) {
  const cameraRef = useRef<CameraRef>(null);
  const framedOnce = useRef(false);
  const userPannedRef = useRef(false);
  const [status, setStatus] = useState<BasemapStatus>({ kind: 'loading' });
  const [tileUrl, setTileUrl] = useState<string | null>(null);
  const [zoomBounds, setZoomBounds] = useState<{ min?: number; max?: number }>({});

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  // Resolve the tile source once per barangay — a Tanod's barangay never
  // changes mid-session (re-login required), so this doesn't need to react
  // to position/incidents/tanods updates.
  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: 'loading' });

    async function init() {
      if (barangayId !== null) {
        try {
          const pkg = await getActiveMapPackage(barangayId);
          if (pkg) {
            const info = await readMbtilesMetadata(pkg.fileUri);
            if (cancelled) return;
            setTileUrl(toMbtilesUrl(pkg.fileUri));
            setZoomBounds({ min: info?.minzoom ?? undefined, max: info?.maxzoom ?? undefined });
            setStatus({ kind: 'offline', version: pkg.version });
            return;
          }
        } catch {
          // Corrupt/partial file, or metadata unreadable — fall back to online below.
        }
      }
      if (cancelled) return;
      setTileUrl(null);
      setZoomBounds({});
      setStatus({ kind: 'online' });
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [barangayId]);

  const performRecenter = useCallback(
    (animated: boolean) => {
      userPannedRef.current = false;
      if (navigationMode && routeProgress && position) {
        cameraRef.current?.easeTo({
          center: [position.longitude, position.latitude],
          zoom: NAV_FOLLOW_ZOOM,
          bearing: routeProgress.routeBearing,
          duration: 500,
        });
        return;
      }
      const points: LngLat[] = [];
      if (position) points.push([position.longitude, position.latitude]);
      if (focusTarget) points.push([focusTarget.longitude, focusTarget.latitude]);
      if (points.length === 1) {
        if (animated) cameraRef.current?.flyTo({ center: points[0], zoom: POSITION_ZOOM, duration: 800 });
        else cameraRef.current?.jumpTo({ center: points[0], zoom: POSITION_ZOOM });
      } else if (points.length === 2) {
        cameraRef.current?.fitBounds(boundsOf(points), { padding: FIT_PADDING, duration: animated ? 800 : 0 });
      }
    },
    [navigationMode, routeProgress, position, focusTarget],
  );

  // Frame the camera exactly once overall (self alone, focusTarget alone, or
  // both via fitBounds once position arrives after being centered on
  // focusTarget alone) — live polling never yanks the view out from under a
  // Tanod who has manually panned/zoomed.
  useEffect(() => {
    if (framedOnce.current || (!position && !focusTarget)) return;
    framedOnce.current = true;
    performRecenter(false);
  }, [position, focusTarget, performRecenter]);

  // Navigation auto-follow: smoothly track the user's position with
  // heading-up rotation on every GPS update, unless manually panned.
  useEffect(() => {
    if (!navigationMode || !routeProgress || !position || userPannedRef.current) return;
    cameraRef.current?.easeTo({
      center: [position.longitude, position.latitude],
      zoom: NAV_FOLLOW_ZOOM,
      bearing: routeProgress.routeBearing,
      duration: 500,
    });
  }, [navigationMode, position, routeProgress]);

  useImperativeHandle(
    ref,
    () => ({
      recenter: () => performRecenter(true),
      focusCoordinates: (lat: number, lng: number, zoom = 16) => {
        userPannedRef.current = true;
        cameraRef.current?.flyTo({ center: [lng, lat], zoom, duration: 800 });
      },
    }),
    [performRecenter],
  );

  const routeSplit = useMemo(() => {
    if (!navigationMode || !routeProgress || !routeGeometry) return null;
    return splitRouteAtSnap(routeGeometry.coordinates, routeProgress.snappedSegmentIndex, routeProgress.snappedPoint);
  }, [navigationMode, routeProgress, routeGeometry]);

  const initialPoint = focusTarget ?? position;

  return (
    <View style={[styles.container, height ? { height } : null]}>
      <MapLibreMap
        style={StyleSheet.absoluteFill}
        mapStyle={EMPTY_STYLE}
        compass={false}
        onPress={(event) => {
          const nativeEvent = event.nativeEvent as { lngLat?: LngLat };
          if (!nativeEvent.lngLat) return;
          const [lng, lat] = nativeEvent.lngLat;
          onMapClick?.({ latitude: lat, longitude: lng });
        }}
        onRegionWillChange={(event) => {
          if (event.nativeEvent.userInteraction) {
            userPannedRef.current = true;
            onUserPan?.();
          }
        }}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{
            center: initialPoint ? [initialPoint.longitude, initialPoint.latitude] : DEFAULT_CENTER,
            zoom: initialPoint ? POSITION_ZOOM : DEFAULT_ZOOM,
          }}
        />

        {tileUrl ? (
          <RasterSource id="basemap" tiles={[tileUrl]} tileSize={256} minzoom={zoomBounds.min} maxzoom={zoomBounds.max}>
            <Layer type="raster" id="basemap-layer" />
          </RasterSource>
        ) : (
          <RasterSource
            id="basemap"
            tiles={['https://tile.openstreetmap.org/{z}/{x}/{y}.png']}
            tileSize={256}
            attribution="© OpenStreetMap contributors"
          >
            <Layer type="raster" id="basemap-layer" />
          </RasterSource>
        )}

        {routeGeometry && !navigationMode ? (
          <GeoJSONSource id="route" data={{ type: 'LineString', coordinates: routeGeometry.coordinates }}>
            <Layer
              type="line"
              id="route-casing"
              layout={{ 'line-join': 'round', 'line-cap': 'round' }}
              paint={{ 'line-color': ROUTE_CASING_COLOR, 'line-width': 11, 'line-opacity': 0.95 }}
            />
            <Layer
              type="line"
              id="route-line"
              layout={{ 'line-join': 'round', 'line-cap': 'round' }}
              paint={{ 'line-color': ROUTE_LINE_COLOR, 'line-width': 7, 'line-opacity': 0.95 }}
            />
          </GeoJSONSource>
        ) : null}

        {routeSplit ? (
          <>
            <GeoJSONSource id="route-traveled" data={{ type: 'LineString', coordinates: routeSplit.traveled }}>
              <Layer
                type="line"
                id="route-traveled-line"
                layout={{ 'line-join': 'round', 'line-cap': 'round' }}
                paint={{ 'line-color': ROUTE_TRAVELED_COLOR, 'line-width': 5, 'line-opacity': 0.6 }}
              />
            </GeoJSONSource>
            <GeoJSONSource id="route-remaining" data={{ type: 'LineString', coordinates: routeSplit.remaining }}>
              <Layer
                type="line"
                id="route-remaining-casing"
                layout={{ 'line-join': 'round', 'line-cap': 'round' }}
                paint={{ 'line-color': ROUTE_CASING_COLOR, 'line-width': 11, 'line-opacity': 0.95 }}
              />
              <Layer
                type="line"
                id="route-remaining-line"
                layout={{ 'line-join': 'round', 'line-cap': 'round' }}
                paint={{ 'line-color': ROUTE_LINE_COLOR, 'line-width': 7, 'line-opacity': 0.95 }}
              />
            </GeoJSONSource>
          </>
        ) : null}

        {!routeGeometry && position && focusTarget ? (
          <GeoJSONSource
            id="route-guideline"
            data={{
              type: 'LineString',
              coordinates: [
                [position.longitude, position.latitude],
                [focusTarget.longitude, focusTarget.latitude],
              ],
            }}
          >
            <Layer
              type="line"
              id="route-guideline-line"
              layout={{ 'line-join': 'round', 'line-cap': 'round' }}
              paint={{ 'line-color': ROUTE_LINE_COLOR, 'line-width': 4, 'line-dasharray': [2, 2], 'line-opacity': 0.85 }}
            />
          </GeoJSONSource>
        ) : null}

        {position ? (
          <Marker lngLat={[position.longitude, position.latitude]}>
            <View style={[styles.selfMarker, navigationMode ? styles.selfMarkerNavigating : null]} />
          </Marker>
        ) : null}

        {focusTarget ? (
          <Marker lngLat={[focusTarget.longitude, focusTarget.latitude]}>
            <View style={styles.destinationMarker}>
              <Ionicons name="flag" size={12} color="#fff" />
            </View>
          </Marker>
        ) : null}

        {incidents
          .filter((incident) => Number.isFinite(incident.latitude) && Number.isFinite(incident.longitude))
          .map((incident) => (
            <Marker key={`incident-${incident.incidentId}`} lngLat={[incident.longitude, incident.latitude]}>
              <View style={[styles.incidentMarker, { backgroundColor: priorityMarkerColor(incident.priority) }]} />
            </Marker>
          ))}

        {tanods
          .filter((tanod) => Number.isFinite(tanod.latitude) && Number.isFinite(tanod.longitude))
          .map((tanod) => (
            <Marker key={`tanod-${tanod.userId}`} lngLat={[tanod.longitude, tanod.latitude]}>
              <View style={[styles.tanodMarker, tanod.isStale ? styles.tanodMarkerStale : styles.tanodMarkerLive]} />
            </Marker>
          ))}
      </MapLibreMap>

      {!hideRecenterFab && (position || focusTarget) ? (
        <Pressable style={styles.recenterFab} onPress={() => performRecenter(true)}>
          <Ionicons name="locate" size={20} color="#2563eb" />
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { width: '100%', height: 340, borderRadius: 16, overflow: 'hidden', backgroundColor: '#e2e8f0' },
  selfMarker: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#2563eb',
    borderWidth: 3,
    borderColor: '#fff',
  },
  selfMarkerNavigating: { backgroundColor: '#16a34a' },
  destinationMarker: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  incidentMarker: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#fff' },
  tanodMarker: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#fff' },
  tanodMarkerLive: { backgroundColor: '#16a34a' },
  tanodMarkerStale: { backgroundColor: '#94a3b8' },
  recenterFab: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
});

export default LiveMapCanvas;
