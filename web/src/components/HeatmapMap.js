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
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#E0F2FE' } }],
    },
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

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
        'heatmap-intensity': 1,
        'heatmap-radius': 22,
        'heatmap-opacity': 0.8,
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(59,130,246,0)',
          0.3, '#3B82F6',
          0.6, '#D97706',
          1, '#DC2626',
        ],
      },
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

  let destroyed = false;
  function destroy() {
    if (destroyed) return; // Same double-destroy guard as LiveMap.js — see its comment.
    destroyed = true;
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
