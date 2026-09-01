/**
 * LiveMap — the shared MapLibre component §9 W4 requires ("build the
 * shared LiveMap component here; W3's map pane reuses it later, it does
 * not get a second implementation"). Both `dispatch-center.js` (W3) and
 * `gis-live-tracking.js` (W4) instantiate this; neither hand-rolls its
 * own map.
 *
 * PascalCase filename per §4 (component convention) even though this
 * exports a factory function rather than a class — consistent with
 * KpiCard.js/TrendChart.js already doing the same for a DOM-returning
 * function.
 *
 * Resolved decisions, logged in DEVLOG.md:
 *   - **No basemap tile source.** No online/offline tile source is wired
 *     up for the web dashboard yet (that's a distinct, undocumented-for-
 *     Sprint-1 dependency — see backend/DEVLOG.md). The MapLibre style
 *     here has no raster/vector tile `source`, just a flat background
 *     color plus a GeoJSON source/layer for the barangay boundary (when
 *     available) and DOM markers for Tanods/SOS. Real basemap tiles can
 *     be added later purely by extending `sources`/`layers` in
 *     `buildStyle()` below — the marker/data layer this file owns
 *     doesn't change.
 *   - **No barangay boundary endpoint exists yet** (`barangay.
 *     boundary_geojson` per §5 is never returned by any built §6
 *     endpoint). Falls back to a fixed default view centered on Pilar,
 *     Sorsogon (~12.9186°N, 123.6667°E — the municipality's real
 *     approximate coordinates, not a placeholder), then fits bounds to
 *     whatever markers are actually present. `setBoundary()` exists so a
 *     future barangay-metadata endpoint can just call it.
 *   - **Freshness styling** (§9 W4: "Shows freshness... A stale location
 *     is not visually presented as live"): a marker's dot color follows
 *     §8's status-pill tokens (`--color-success` fresh, `--color-text-
 *     secondary` stale) and its tooltip always states the age in words —
 *     never color alone (§8 accessibility rule).
 *   - **SOS markers always render above Tanod markers** (§9: "SOS
 *     markers remain visible above ordinary map filters") — SOS markers
 *     are added to the map after Tanod markers on every `setSosMarkers`
 *     call, and re-added after every `setMarkers` call too, so stacking
 *     order can't invert depending on call sequence.
 */

const DEFAULT_CENTER = [123.6667, 12.9186]; // Pilar, Sorsogon [lng, lat]
const DEFAULT_ZOOM = 13;

/**
 * @param {HTMLElement} container
 * @returns {{
 *   setMarkers: (markers: Array<{userId:number, fullName:string, latitude:number, longitude:number, ageSeconds:number, isStale:boolean}>) => void,
 *   setSosMarkers: (sosItems: Array<{sosId:number, latitude:number, longitude:number, status:string}>) => void,
 *   setBoundary: (geojson: object) => void,
 *   destroy: () => void,
 * }}
 */
export function LiveMap(container) {
  container.classList.add('live-map');

  const map = new maplibregl.Map({
    container,
    style: buildStyle(),
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  let tanodMarkers = [];
  let sosMarkers = [];
  let ready = false;
  const pendingBoundary = { value: null };

  map.on('load', () => {
    ready = true;
    if (pendingBoundary.value) {
      applyBoundary(map, pendingBoundary.value);
    }
  });

  function clearMarkers(list) {
    for (const marker of list) marker.remove();
    return [];
  }

  function setMarkers(markers) {
    tanodMarkers = clearMarkers(tanodMarkers);
    const bounds = new maplibregl.LngLatBounds();
    let hasPoint = false;

    for (const item of markers) {
      const el = document.createElement('div');
      el.className = 'live-map__marker live-map__marker--tanod' + (item.isStale ? ' live-map__marker--stale' : '');
      el.title = `${item.fullName} — ${formatAge(item.ageSeconds)}${item.isStale ? ' (stale)' : ''}`;

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([item.longitude, item.latitude])
        .addTo(map);
      tanodMarkers.push(marker);
      bounds.extend([item.longitude, item.latitude]);
      hasPoint = true;
    }

    // Re-add SOS markers on top so Tanod markers never cover them (§9).
    for (const marker of sosMarkers) marker.addTo(map);

    if (hasPoint) {
      map.fitBounds(bounds, { padding: 64, maxZoom: 16, duration: 300 });
    }
  }

  function setSosMarkers(sosItems) {
    sosMarkers = clearMarkers(sosMarkers);
    for (const item of sosItems) {
      const el = document.createElement('div');
      el.className = 'live-map__marker live-map__marker--sos';
      el.title = `SOS — ${item.status}`;
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([item.longitude, item.latitude])
        .addTo(map);
      sosMarkers.push(marker);
    }
  }

  function setBoundary(geojson) {
    if (!ready) {
      pendingBoundary.value = geojson;
      return;
    }
    applyBoundary(map, geojson);
  }

  // A real bug caught by this session's own Playwright walkthrough (not
  // just claimed working): main.js's boot() stops the outgoing page's
  // poll/map via a stored handle on every navigation, including the one
  // that follows sign-out — but the outgoing page's own onLogout handler
  // also stops itself first, for immediate responsiveness. That means
  // destroy() can legitimately be called twice for the same LiveMap
  // instance. A second `map.remove()` throws inside MapLibre's own
  // teardown ("Cannot read properties of undefined (reading 'destroy')")
  // because it isn't idempotent — so this function has to be, instead of
  // relying on every caller to invoke it exactly once.
  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearMarkers(tanodMarkers);
    clearMarkers(sosMarkers);
    map.remove();
  }

  return { setMarkers, setSosMarkers, setBoundary, destroy };
}

function applyBoundary(map, geojson) {
  if (map.getSource('barangay-boundary')) {
    map.getSource('barangay-boundary').setData(geojson);
    return;
  }
  map.addSource('barangay-boundary', { type: 'geojson', data: geojson });
  map.addLayer({
    id: 'barangay-boundary-fill',
    type: 'fill',
    source: 'barangay-boundary',
    paint: { 'fill-color': '#3B82F6', 'fill-opacity': 0.05 },
  });
  map.addLayer({
    id: 'barangay-boundary-line',
    type: 'line',
    source: 'barangay-boundary',
    paint: { 'line-color': '#1D4ED8', 'line-width': 2 },
  });
}

function buildStyle() {
  return {
    version: 8,
    sources: {},
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#E0F2FE' } },
    ],
  };
}

function formatAge(ageSeconds) {
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
