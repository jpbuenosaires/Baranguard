/**
 * HeatmapMap — W5 Historical Heatmap's map component.
 *
 * Provides a calibrated multi-stop thermal density heatmap (Cyan -> Green -> Yellow -> Orange -> Red),
 * official PSA barangay boundary polygon, and interactive view controls (Recenter, Zoom, Fullscreen).
 */

import { onThemeChange, readThemeToken } from './themeEvents.js';
import { attachBasemapFallback, OSM_TILE_URL } from '../utils/mapFallback.js';
import { centerFor, boundaryFor } from '../data/barangayBoundaries.js';

const DEFAULT_CENTER = centerFor(1); // Dao boundary centre [lng, lat]
const DEFAULT_ZOOM = 13.5;
const SOURCE_ID = 'incident-heat';
const BOUNDARY_SOURCE_ID = 'barangay-boundary';

/**
 * @param {HTMLElement} container
 * @param {object} [options={}]
 * @param {number} [options.barangayId=1]
 * @param {object} [options.boundary]
 * @returns {{
 *   setPoints: (points: Array<{latitude:number, longitude:number, weight:number}>) => void,
 *   setBoundary: (geojson: object) => void,
 *   recenter: () => void,
 *   zoomIn: () => void,
 *   zoomOut: () => void,
 *   toggleFullscreen: () => void,
 *   destroy: () => void,
 *   map: object
 * }}
 */
export function HeatmapMap(container, options = {}) {
  container.classList.add('live-map');

  const barangayId = options.barangayId || 1;
  let currentBoundary = options.boundary || boundaryFor(barangayId);

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

  map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
  const detachBasemapFallback = attachBasemapFallback(map, 'osm-raster');

  let ready = false;
  let pendingPoints = null;
  let currentPoints = [];

  map.on('load', () => {
    ready = true;

    // 1. Primary GeoJSON source for heatmap points (added first so test queries find it first)
    map.addSource(SOURCE_ID, { type: 'geojson', data: toFeatureCollection(pendingPoints ?? []) });

    // 2. Official Barangay Boundary (PSA Polygon)
    if (currentBoundary) {
      map.addSource(BOUNDARY_SOURCE_ID, { type: 'geojson', data: currentBoundary });
      map.addLayer({
        id: 'barangay-boundary-fill',
        type: 'fill',
        source: BOUNDARY_SOURCE_ID,
        paint: {
          'fill-color': readThemeToken('--color-accent', '#3B82F6'),
          'fill-opacity': 0.05,
        },
      });
      map.addLayer({
        id: 'barangay-boundary-line',
        type: 'line',
        source: BOUNDARY_SOURCE_ID,
        paint: {
          'line-color': readThemeToken('--color-primary', '#1D4ED8'),
          'line-width': 2.5,
          'line-dasharray': [4, 2],
          'line-opacity': 0.85,
        },
      });
    }

    // 3. Multi-stop thermal heatmap layer with balanced radius & intensity
    map.addLayer({
      id: 'incident-heat-layer',
      type: 'heatmap',
      source: SOURCE_ID,
      paint: {
        'heatmap-weight': ['get', 'weight'],
        'heatmap-intensity': [
          'interpolate', ['linear'], ['zoom'],
          9, 0.35,
          12, 0.65,
          15, 1.15
        ],
        'heatmap-radius': [
          'interpolate', ['linear'], ['zoom'],
          9, 12,
          12, 18,
          14, 26,
          16, 36,
          18, 48
        ],
        'heatmap-opacity': 0.82,
        // Thermal spectrum (matching legend): cyan -> green -> amber -> orange -> red -> dark crimson
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0, 0, 0, 0)',
          0.12, 'rgba(14, 165, 233, 0.45)', // Sky blue / cyan
          0.28, 'rgba(16, 185, 129, 0.7)',  // Emerald green
          0.48, 'rgba(234, 179, 8, 0.82)',  // Amber / yellow
          0.68, 'rgba(249, 115, 22, 0.88)', // Warm orange
          0.88, 'rgba(239, 68, 68, 0.95)',  // Bright red
          1.0, 'rgba(153, 27, 27, 1.0)'     // Deep crimson peak
        ],
      },
    });

    // 4. Individual incident points when zooming in close (zoom >= 13)
    map.addLayer({
      id: 'incident-point-layer',
      type: 'circle',
      source: SOURCE_ID,
      minzoom: 13,
      paint: {
        'circle-radius': 5,
        'circle-color': readThemeToken('--color-surface-elevated', '#0F172A'),
        'circle-stroke-color': readThemeToken('--color-white', '#FFFFFF'),
        'circle-stroke-width': 2,
        'circle-opacity': [
          'interpolate', ['linear'], ['zoom'],
          13, 0,
          14, 0.95
        ],
        'circle-stroke-opacity': [
          'interpolate', ['linear'], ['zoom'],
          13, 0,
          14, 0.95
        ]
      }
    });

    if (pendingPoints) {
      currentPoints = pendingPoints;
      fitToPoints(pendingPoints);
      pendingPoints = null;
    }
  });

  function setPoints(points) {
    currentPoints = points || [];
    if (!ready) {
      pendingPoints = points;
      return;
    }
    const source = map.getSource(SOURCE_ID);
    if (source) source.setData(toFeatureCollection(points));
    fitToPoints(points);
  }

  function setBoundary(geojson) {
    currentBoundary = geojson;
    if (!ready) return;
    const bSource = map.getSource(BOUNDARY_SOURCE_ID);
    if (bSource) {
      bSource.setData(geojson);
    } else if (geojson) {
      map.addSource(BOUNDARY_SOURCE_ID, { type: 'geojson', data: geojson });
      map.addLayer({
        id: 'barangay-boundary-fill',
        type: 'fill',
        source: BOUNDARY_SOURCE_ID,
        paint: {
          'fill-color': readThemeToken('--color-accent', '#3B82F6'),
          'fill-opacity': 0.05,
        },
      }, 'incident-heat-layer');
      map.addLayer({
        id: 'barangay-boundary-line',
        type: 'line',
        source: BOUNDARY_SOURCE_ID,
        paint: {
          'line-color': readThemeToken('--color-primary', '#1D4ED8'),
          'line-width': 2.5,
          'line-dasharray': [4, 2],
          'line-opacity': 0.85,
        },
      }, 'incident-heat-layer');
    }
  }

  function fitToPoints(points) {
    if (!points || points.length === 0) {
      recenter();
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const p of points) bounds.extend([p.longitude, p.latitude]);
    map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 400 });
  }

  function recenter() {
    if (currentPoints && currentPoints.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const p of currentPoints) bounds.extend([p.longitude, p.latitude]);
      map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 500 });
    } else if (currentBoundary?.features?.[0]?.geometry?.coordinates?.[0]) {
      const ring = currentBoundary.features[0].geometry.coordinates[0];
      const bounds = new maplibregl.LngLatBounds();
      for (const coord of ring) bounds.extend(coord);
      map.fitBounds(bounds, { padding: 40, maxZoom: 14, duration: 500 });
    } else {
      map.flyTo({ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, duration: 500 });
    }
  }

  function zoomIn() {
    if (typeof map.zoomIn === 'function') map.zoomIn();
    else if (typeof map.setZoom === 'function') map.setZoom((map.getZoom?.() || DEFAULT_ZOOM) + 1);
  }

  function zoomOut() {
    if (typeof map.zoomOut === 'function') map.zoomOut();
    else if (typeof map.setZoom === 'function') map.setZoom((map.getZoom?.() || DEFAULT_ZOOM) - 1);
  }

  function toggleFullscreen() {
    const targetEl = container.closest('.heatmap-map-panel') || container;
    const isDocFs = !!document.fullscreenElement;
    if (isDocFs) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } else if (targetEl.requestFullscreen) {
      targetEl.requestFullscreen().catch(() => {
        targetEl.classList.toggle('is-fullscreen');
        setTimeout(() => map.resize?.(), 60);
      });
    } else {
      targetEl.classList.toggle('is-fullscreen');
      setTimeout(() => map.resize?.(), 60);
    }
  }

  // Floating map action controls overlay
  const controls = document.createElement('div');
  controls.className = 'heatmap-map-controls';
  controls.setAttribute('role', 'toolbar');
  controls.setAttribute('aria-label', 'Map navigation and display controls');
  controls.innerHTML = `
    <button type="button" class="heatmap-control-btn" id="heatmap-recenter-btn" title="Recenter on Barangay boundary & incidents" aria-label="Recenter map">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
      </svg>
      <span>Recenter</span>
    </button>
    <div class="heatmap-control-divider" aria-hidden="true"></div>
    <button type="button" class="heatmap-control-btn heatmap-control-btn--icon-only" id="heatmap-zoom-in-btn" title="Zoom in" aria-label="Zoom in">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
    <button type="button" class="heatmap-control-btn heatmap-control-btn--icon-only" id="heatmap-zoom-out-btn" title="Zoom out" aria-label="Zoom out">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
    <div class="heatmap-control-divider" aria-hidden="true"></div>
    <button type="button" class="heatmap-control-btn" id="heatmap-fullscreen-btn" title="Toggle Fullscreen view" aria-label="Toggle full screen">
      <svg class="heatmap-fs-icon-expand" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
      <svg class="heatmap-fs-icon-compress" style="display:none;" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
      <span class="heatmap-fs-label">Full Screen</span>
    </button>
    <div class="heatmap-control-divider" aria-hidden="true"></div>
    <div class="heatmap-boundary-badge" title="Official PSA Barangay Dao boundary outline active">
      <span class="heatmap-boundary-badge__dot" aria-hidden="true"></span>
      <span>Boundary</span>
    </div>
  `;
  container.appendChild(controls);

  const recenterBtn = controls.querySelector('#heatmap-recenter-btn');
  const zoomInBtn = controls.querySelector('#heatmap-zoom-in-btn');
  const zoomOutBtn = controls.querySelector('#heatmap-zoom-out-btn');
  const fullscreenBtn = controls.querySelector('#heatmap-fullscreen-btn');

  recenterBtn.addEventListener('click', recenter);
  zoomInBtn.addEventListener('click', zoomIn);
  zoomOutBtn.addEventListener('click', zoomOut);
  fullscreenBtn.addEventListener('click', toggleFullscreen);

  const onFsChange = () => {
    const targetEl = container.closest('.heatmap-map-panel') || container;
    const isFs = document.fullscreenElement === targetEl || targetEl.classList.contains('is-fullscreen');
    targetEl.classList.toggle('is-fullscreen', isFs);
    const expandIcon = controls.querySelector('.heatmap-fs-icon-expand');
    const compressIcon = controls.querySelector('.heatmap-fs-icon-compress');
    const label = controls.querySelector('.heatmap-fs-label');
    if (expandIcon) expandIcon.style.display = isFs ? 'none' : 'inline-block';
    if (compressIcon) compressIcon.style.display = isFs ? 'inline-block' : 'none';
    if (label) label.textContent = isFs ? 'Exit' : 'Full Screen';
    setTimeout(() => map.resize?.(), 60);
  };
  document.addEventListener('fullscreenchange', onFsChange);

  // Re-read token colours when theme flips
  const offTheme = onThemeChange(container, () => {
    if (destroyed || !ready) return;
    if (map.getLayer('background')) map.setPaintProperty('background', 'background-color', readThemeToken('--color-surface-blue', '#E0F2FE'));
    if (map.getLayer('barangay-boundary-fill')) map.setPaintProperty('barangay-boundary-fill', 'fill-color', readThemeToken('--color-accent', '#3B82F6'));
    if (map.getLayer('barangay-boundary-line')) map.setPaintProperty('barangay-boundary-line', 'line-color', readThemeToken('--color-primary', '#1D4ED8'));
    if (map.getLayer('incident-point-layer')) {
      map.setPaintProperty('incident-point-layer', 'circle-color', readThemeToken('--color-surface-elevated', '#0F172A'));
      map.setPaintProperty('incident-point-layer', 'circle-stroke-color', readThemeToken('--color-white', '#FFFFFF'));
    }
  });

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    document.removeEventListener('fullscreenchange', onFsChange);
    offTheme();
    detachBasemapFallback();
    controls.remove();
    map.remove();
  }

  return {
    setPoints,
    setBoundary,
    recenter,
    zoomIn,
    zoomOut,
    toggleFullscreen,
    destroy,
    map,
  };
}

function toFeatureCollection(points) {
  return {
    type: 'FeatureCollection',
    features: (points || []).map((p) => ({
      type: 'Feature',
      properties: { weight: p.weight ?? 1, incidentType: p.incidentType, priority: p.priority },
      geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
    })),
  };
}
