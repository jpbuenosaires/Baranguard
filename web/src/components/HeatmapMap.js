/**
 * HeatmapMap — W5 Historical Heatmap's map component. Separate from
 * `LiveMap.js` on purpose: LiveMap is the shared component §9 explicitly
 * reserves for W3/W4's live-tracking marker maps ("it does not get a
 * second implementation") — a historical density heatmap is a different
 * visualization (a MapLibre `heatmap` layer over a GeoJSON point source,
 * no per-Tanod markers/freshness/SOS logic at all), not a second copy of
 * that same live-tracking map, so it doesn't reuse or extend LiveMap.
 *
 * Same "no basemap tile source yet" situation as LiveMap.js — flat
 * background only, see that file's own doc for why.
 */

import { onThemeChange, readThemeToken } from './themeEvents.js';
import { attachBasemapFallback, OSM_TILE_URL } from '../utils/mapFallback.js';

const DEFAULT_CENTER = [123.6667, 12.9186]; // Pilar, Sorsogon [lng, lat]
const DEFAULT_ZOOM = 12;
const SOURCE_ID = 'incident-heat';

/**
 * @param {HTMLElement} container
 * @returns {{ setPoints: (points: Array<{latitude:number, longitude:number, weight:number}>) => void, destroy: () => void }}
 */
export function HeatmapMap(container) {
  container.classList.add('live-map');

  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        'osm-raster': {
          type: 'raster',
          tiles: [OSM_TILE_URL],
          tileSize: 256,
          maxzoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        },
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': readThemeToken('--color-surface-blue', '#E0F2FE') } },
        { id: 'osm-raster-layer', type: 'raster', source: 'osm-raster' },
      ],
    },
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    attributionControl: false,
    preserveDrawingBuffer: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
  const detachBasemapFallback = attachBasemapFallback(map, 'osm-raster');

  let ready = false;
  let pendingPoints = null;

  map.on('load', () => {
    ready = true;
    map.addSource(SOURCE_ID, { type: 'geojson', data: toFeatureCollection(pendingPoints ?? []) });
    map.addLayer({
      id: 'incident-heat-layer',
      type: 'heatmap',
      source: SOURCE_ID,
      paint: {
        'heatmap-weight': ['get', 'weight'],
        'heatmap-intensity': [
          'interpolate', ['linear'], ['zoom'],
          11, 1,
          15, 3
        ],
        'heatmap-radius': [
          'interpolate', ['linear'], ['zoom'],
          10, 20,
          14, 38,
          17, 55
        ],
        'heatmap-opacity': 0.85,
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(33, 102, 172, 0)',
          0.2, 'rgb(103, 169, 207)',
          0.4, 'rgb(209, 229, 240)',
          0.6, 'rgb(253, 219, 199)',
          0.8, 'rgb(239, 138, 98)',
          1, 'rgb(178, 24, 43)'
        ],
      },
    });
    // Add glowing circular point clusters when zooming in close
    map.addLayer({
      id: 'incident-point-layer',
      type: 'circle',
      source: SOURCE_ID,
      minzoom: 13,
      paint: {
        'circle-radius': 6,
        // Tokens rather than literal hex (D-12); re-read on theme change below.
        'circle-color': readThemeToken('--color-critical-solid', '#DC2626'),
        'circle-stroke-color': readThemeToken('--color-white', '#FFFFFF'),
        'circle-stroke-width': 2,
        'circle-opacity': [
          'interpolate', ['linear'], ['zoom'],
          13, 0,
          14, 0.9
        ],
        'circle-stroke-opacity': [
          'interpolate', ['linear'], ['zoom'],
          13, 0,
          14, 0.9
        ]
      }
    });
    if (pendingPoints) {
      fitToPoints(pendingPoints);
      pendingPoints = null;
    }
  });

  function setPoints(points) {
    if (!ready) {
      pendingPoints = points;
      return;
    }
    map.getSource(SOURCE_ID).setData(toFeatureCollection(points));
    fitToPoints(points);
  }

  function fitToPoints(points) {
    if (points.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const p of points) bounds.extend([p.longitude, p.latitude]);
    map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 300 });
  }

  // D-10: re-read token colours when the theme flips.
  const offTheme = onThemeChange(container, () => {
    if (destroyed || !ready) return;
    if (map.getLayer('background')) map.setPaintProperty('background', 'background-color', readThemeToken('--color-surface-blue', '#E0F2FE'));
    if (map.getLayer('incident-point-layer')) {
      map.setPaintProperty('incident-point-layer', 'circle-color', readThemeToken('--color-critical-solid', '#DC2626'));
      map.setPaintProperty('incident-point-layer', 'circle-stroke-color', readThemeToken('--color-white', '#FFFFFF'));
    }
  });

  let destroyed = false;
  function destroy() {
    if (destroyed) return; // Same double-destroy guard as LiveMap.js — see its comment.
    destroyed = true;
    offTheme();
    detachBasemapFallback();
    map.remove();
  }

  return { setPoints, destroy };
}

function toFeatureCollection(points) {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      properties: { weight: p.weight },
      geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
    })),
  };
}
