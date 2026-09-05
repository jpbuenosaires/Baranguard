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
 *   - **Basemap tiles: OpenStreetMap raster, online.** Resolved
 *     2026-09-04, user's explicit choice over the offline-MBTiles
 *     alternative (the `map_package`/`GET /map-packages` upload system
 *     already exists for that path but no package has been uploaded on
 *     this deployment yet, and the user wanted the map working now, not
 *     after an upload step). This is a deliberate, logged deviation from
 *     §2 Rule 7 (local-only/no-internet-assumed): the rule was written
 *     for the field mobile app's offline capture guarantee, not the
 *     office web dashboard, and a missing basemap is a worse operator
 *     experience than a dashboard that needs the workstation's internet
 *     connection to show map tiles. If this workstation ever runs
 *     genuinely offline, the map degrades to the flat background color
 *     below (tiles simply fail to load) — markers/GPS data still render
 *     on top either way, since those never depended on tile source.
 *     OSM's tile usage policy (light/moderate use, real attribution,
 *     no bulk scraping) is respected: this is a handful of viewers on
 *     one LAN admin console, and `AttributionControl` is enabled below.
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
 *   - **Tanod marker clustering (§4.2/§4.3 of the UI/UX review) is a
 *     hand-rolled, SCREEN-PIXEL-DISTANCE grouping over the existing DOM
 *     markers — deliberately NOT MapLibre's native GeoJSON
 *     `cluster: true` source/layer approach.** That native approach was
 *     the original plan, but it requires markers to be circle/symbol
 *     LAYERS rather than `maplibregl.Marker` DOM elements, which would
 *     have meant giving up everything DOM markers already provide and
 *     were already tested: the native browser `title` tooltip, the
 *     freshness pulse CSS animation (`marker-pulse`, §9's own "a stale
 *     location is not visually presented as live" requirement), and the
 *     stale/fresh color distinction — all built on CSS, none of it
 *     portable to a MapLibre paint-property layer without materially more
 *     code and a real behavior regression risk. The DOM-based approach
 *     below delivers the same user-facing capability (grouped counts,
 *     click-to-zoom into a cluster, individual markers still clickable)
 *     while keeping every already-tested marker behavior unchanged.
 *     SOS markers are deliberately NEVER clustered — clustering them
 *     would risk hiding an individual SOS inside a count bubble, directly
 *     against the "SOS markers remain visible above ordinary map filters"
 *     rule already established above.
 */

const DEFAULT_CENTER = [123.6667, 12.9186]; // Pilar, Sorsogon [lng, lat]
const DEFAULT_ZOOM = 13;
const CLUSTER_RADIUS_PX = 44; // Screen-pixel distance under which two Tanod markers merge into one cluster bubble.

/**
 * @param {HTMLElement} container
 * @returns {{
 *   setMarkers: (markers: Array<{userId:number, fullName:string, latitude:number, longitude:number, ageSeconds:number, isStale:boolean}>) => void,
 *   setSosMarkers: (sosItems: Array<{sosId:number, latitude:number, longitude:number, status:string}>) => void,
 *   setIncidentMarkers: (items: Array<{incidentId:number, latitude:number, longitude:number, incidentType:string, priority:string, typeLabel?:string}>, onAssign?: (incidentId:number) => void) => void,
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
  // Required by OSM's tile usage policy ("you must display an
  // OpenStreetMap attribution") — compact so it doesn't crowd the small
  // map panes this component renders into (W3's sidebar pane vs. W4's
  // full page).
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  let tanodMarkers = [];
  let sosMarkers = [];
  let incidentMarkers = [];
  let ready = false;
  const pendingBoundary = { value: null };
  let lastRawMarkers = []; // re-clustered on zoom/move — see recluster() below.
  let reclusterHandle = null;

  map.on('load', () => {
    ready = true;
    if (pendingBoundary.value) {
      applyBoundary(map, pendingBoundary.value);
    }
  });

  // Recompute clustering on zoom/pan — screen-pixel distances between two
  // fixed lng/lat points change as the map moves, so a group that was one
  // cluster at a wide zoom may need to split apart at a closer one, and
  // vice versa. Debounced onto 'moveend'/'zoomend' (the gesture's OWN end),
  // not 'move'/'zoom' (fires continuously mid-drag) — reclustering on every
  // intermediate frame would be wasted work and visibly janky.
  map.on('moveend', () => scheduleRecluster());
  map.on('zoomend', () => scheduleRecluster());
  function scheduleRecluster() {
    if (!ready || lastRawMarkers.length === 0) return;
    clearTimeout(reclusterHandle);
    reclusterHandle = setTimeout(() => renderTanodMarkers(lastRawMarkers), 120);
  }

  function clearMarkers(list) {
    for (const marker of list) marker.remove();
    return [];
  }

  /**
   * Greedy screen-pixel clustering: project every marker to its current
   * screen position, then repeatedly pull the first unassigned marker and
   * absorb every other unassigned marker within CLUSTER_RADIUS_PX of it
   * into the same group. Not a strict nearest-neighbour clustering
   * algorithm (a marker joins the FIRST group it's close enough to, not
   * necessarily the closest) — deliberately simple, since this only ever
   * runs over one barangay's own Tanod roster (a handful of points, not a
   * citywide dataset where the greedy approximation would visibly matter).
   */
  function clusterByScreenDistance(markers) {
    const points = markers.map((item) => ({ item, px: map.project([item.longitude, item.latitude]) }));
    const groups = [];
    const used = new Array(points.length).fill(false);
    for (let i = 0; i < points.length; i++) {
      if (used[i]) continue;
      const group = [points[i]];
      used[i] = true;
      for (let j = i + 1; j < points.length; j++) {
        if (used[j]) continue;
        const dx = points[i].px.x - points[j].px.x;
        const dy = points[i].px.y - points[j].px.y;
        if (Math.sqrt(dx * dx + dy * dy) <= CLUSTER_RADIUS_PX) {
          group.push(points[j]);
          used[j] = true;
        }
      }
      groups.push(group);
    }
    return groups;
  }

  function renderTanodMarkers(markers) {
    tanodMarkers = clearMarkers(tanodMarkers);
    const bounds = new maplibregl.LngLatBounds();
    let hasPoint = false;

    for (const group of clusterByScreenDistance(markers)) {
      if (group.length === 1) {
        const item = group[0].item;
        const el = document.createElement('div');
        el.className = 'live-map__marker live-map__marker--tanod' + (item.isStale ? ' live-map__marker--stale' : '');
        el.title = `${item.fullName} — ${formatAge(item.ageSeconds)}${item.isStale ? ' (stale)' : ''}`;
        // §4.3 — a real popup on click (not just the hover-only `title`
        // tooltip above, which a touch/keyboard user can't reach at all).
        const popup = new maplibregl.Popup({ offset: 12, closeButton: false })
          .setText(`${item.fullName} — ${formatAge(item.ageSeconds)}${item.isStale ? ' (stale)' : ''}`);
        // `.setPopup()` wires MapLibre's own built-in click-to-toggle
        // behavior — no separate click listener needed.
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([item.longitude, item.latitude])
          .setPopup(popup)
          .addTo(map);
        tanodMarkers.push(marker);
      } else {
        // §4.2/§4.3 — a cluster bubble: shows the count, click zooms in on
        // that group's own bounding box (§4.3's "click-to-zoom").
        const clusterBounds = new maplibregl.LngLatBounds();
        for (const point of group) clusterBounds.extend([point.item.longitude, point.item.latitude]);
        const center = clusterBounds.getCenter();

        const el = document.createElement('div');
        el.className = 'live-map__cluster';
        el.textContent = String(group.length);
        el.title = `${group.length} Tanods — click to zoom in`;
        el.addEventListener('click', (event) => {
          event.stopPropagation();
          map.fitBounds(clusterBounds, { padding: 80, maxZoom: 18, duration: 400 });
        });

        const marker = new maplibregl.Marker({ element: el }).setLngLat(center).addTo(map);
        tanodMarkers.push(marker);
      }
      for (const point of group) {
        bounds.extend([point.item.longitude, point.item.latitude]);
        hasPoint = true;
      }
    }

    // Re-add SOS markers on top so Tanod markers/clusters never cover them (§9).
    for (const marker of sosMarkers) marker.addTo(map);

    return { bounds, hasPoint };
  }

  function setMarkers(markers) {
    lastRawMarkers = markers;
    const { bounds, hasPoint } = renderTanodMarkers(markers);
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

  /**
   * Pending-incident markers (2026-09-05 UX pass) — Dispatch Center's
   * queue had no map presence at all before this; a dispatcher had to
   * cross-reference the table to know where anything actually was.
   * `onAssign(incidentId)` opens the same Tanod-picker-dialog +
   * `POST /dispatch` flow the table's own Assign button already uses
   * (`promptDispatchTanod` in DispatchAction.js) — this is a second
   * entry point into that one flow, not a new one.
   *
   * @param {Array<{incidentId:number, latitude:number, longitude:number, incidentType:string, priority:string, typeLabel:string}>} items
   * @param {(incidentId:number) => void} [onAssign]
   */
  function setIncidentMarkers(items, onAssign) {
    incidentMarkers = clearMarkers(incidentMarkers);
    for (const item of items) {
      if (item.latitude == null || item.longitude == null) continue;

      const el = document.createElement('div');
      el.className = 'live-map__marker live-map__marker--incident'
        + (item.priority === 'critical' ? ' live-map__marker--incident-critical' : '');
      el.title = `${item.typeLabel || item.incidentType} — ${item.priority} priority`;

      const popupContent = document.createElement('div');
      popupContent.className = 'live-map__incident-popup';
      const heading = document.createElement('div');
      heading.className = 'live-map__incident-popup-heading';
      heading.textContent = `#${item.incidentId} — ${item.typeLabel || item.incidentType}`;
      const priorityPill = document.createElement('span');
      priorityPill.className = 'status-pill' + (item.priority === 'critical' ? ' status-pill--critical' : ' status-pill--pending');
      priorityPill.textContent = item.priority;
      popupContent.append(heading, priorityPill);

      if (onAssign) {
        const assignButton = document.createElement('button');
        assignButton.type = 'button';
        assignButton.className = 'primary';
        assignButton.textContent = 'Assign';
        // Real DOM node + addEventListener via setDOMContent, not an
        // inline handler string via setHTML — same reasoning as every
        // other interactive control in this codebase.
        assignButton.addEventListener('click', () => onAssign(item.incidentId));
        popupContent.appendChild(assignButton);
      }

      const popup = new maplibregl.Popup({ offset: 12 }).setDOMContent(popupContent);
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([item.longitude, item.latitude])
        .setPopup(popup)
        .addTo(map);
      incidentMarkers.push(marker);
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
    clearTimeout(reclusterHandle);
    clearMarkers(tanodMarkers);
    clearMarkers(sosMarkers);
    clearMarkers(incidentMarkers);
    map.remove();
  }

  /**
   * Centre on one point — used by W3's SOS banner ("Show on map") and by
   * W4's roster rows, so a coordinate the operator can already see in a
   * list becomes one click away on the map instead of a manual hunt.
   * Guards on `destroyed` for the same reason destroy() does.
   */
  function flyTo(latitude, longitude, zoom = 17) {
    if (destroyed) return;
    map.flyTo({ center: [longitude, latitude], zoom, duration: 500 });
  }

  return { setMarkers, setSosMarkers, setIncidentMarkers, setBoundary, flyTo, destroy };
}

/**
 * MapLibre paint properties need a literal color value, not a live
 * `var(--token)` reference the way a CSS `background` string can use one
 * (see DonutChart.js, which stays theme-safe for free that way) — so this
 * reads the CURRENT computed token value at the moment the map/layer is
 * built. §1.1/dark-mode pass: these three colors are exactly
 * --color-accent/--color-primary/--color-surface-blue, which already have
 * real dark-mode values in base.css; this just resolves them instead of
 * hardcoding the light-mode hex. Known limitation, stated rather than
 * hidden: a theme toggle happening WHILE this page is already open does
 * not repaint an already-built map — the flat `background` layer is only
 * ever visible now as the brief fallback while OSM tiles are still
 * loading (or if they fail to load at all, e.g. no internet on this
 * workstation), not the map's normal appearance, so a stale color until
 * the next page load is an acceptable gap rather than something worth a
 * live `setPaintProperty` listener for.
 */
function themeToken(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
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
    paint: { 'fill-color': themeToken('--color-accent', '#3B82F6'), 'fill-opacity': 0.05 },
  });
  map.addLayer({
    id: 'barangay-boundary-line',
    type: 'line',
    source: 'barangay-boundary',
    paint: { 'line-color': themeToken('--color-primary', '#1D4ED8'), 'line-width': 2 },
  });
}

function buildStyle() {
  return {
    version: 8,
    sources: {
      // Standard OSM raster tile XYZ endpoint — no API key, no build-time
      // vendoring needed (§1: this stack has no bundler/asset pipeline
      // for a vector style + fonts + sprites anyway, so raster over the
      // vendored-vector-style approach some MapLibre setups use). See the
      // "Basemap tiles" resolved decision at the top of this file for why
      // this is online rather than the offline-MBTiles path.
      'osm-raster': {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      },
    },
    layers: [
      // Fallback color, painted first — only ever visible for the instant
      // before tiles load, or if they never do (see the class doc above).
      { id: 'background', type: 'background', paint: { 'background-color': themeToken('--color-surface-blue', '#E0F2FE') } },
      { id: 'osm-raster-layer', type: 'raster', source: 'osm-raster' },
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
