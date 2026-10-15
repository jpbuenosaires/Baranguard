/** Route line drawing (GeoJSON layers) for LiveMapCanvas. */
import type { GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
import type { DevicePosition } from '../../services/geolocation';
import { splitRouteAtSnap } from '../../utils/routeProgress';
import type { FocusTarget } from './mapBasemap';

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

export interface RouteProgressInput {
  snappedPoint: { lng: number; lat: number };
  routeBearing: number;
  snappedSegmentIndex: number;
  progressFraction: number;
}

export interface DrawRouteOptions {
  routeGeometry?: { type: string; coordinates: [number, number][] } | null;
  position: DevicePosition | null;
  focusTarget?: FocusTarget | null;
  navigationMode?: boolean;
  routeProgress?: RouteProgressInput | null;
}

/**
 * Draws/updates/clears the route line. Returns a cleanup that removes any
 * queued one-time listeners.
 */
export function drawRoute(map: MaplibreMap, opts: DrawRouteOptions): () => void {
  const { routeGeometry, position, focusTarget, navigationMode, routeProgress } = opts;
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
      const existingGuide = map.getSource(ROUTE_GUIDELINE_SOURCE_ID) as GeoJSONSource | undefined;
      if (existingGuide) {
        existingGuide.setData(directFeature);
        return;
      }
      clearAllRouteLayers();
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
}
