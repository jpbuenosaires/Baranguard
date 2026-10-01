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
export function LiveMap(container, options = {}) {
  container.classList.add('live-map');

  const map = new maplibregl.Map({
    container,
    style: buildStyle(),
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    attributionControl: false,
  });
  if (options.showNavControl !== false) {
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  }
  // Required by OSM's tile usage policy ("you must display an
  // OpenStreetMap attribution") — compact so it doesn't crowd the small
  // map panes this component renders into (W3's sidebar pane vs. W4's
  // full page).
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  let tanodMarkers = [];
  let sosMarkers = [];
  let incidentMarkers = [];
  const tanodMarkersById = new Map();
  const sosMarkersById = new Map();
  let activeFocusedTanodId = null;
  let activePopupTanodId = null;
  let focusTimeoutHandle = null;
  let ready = false;
  // Bug fix (2026-09-05): setMarkers() used to re-fit bounds on every poll
  // (every 15s in both Dispatch Center and GIS), re-centering the map even
  // if the operator had zoomed/panned to track something specific. Now
  // fits once, the first time there's a point to fit, and never again.
  let hasFittedBounds = false;
  const pendingBoundary = { value: null };
  // undefined = setRoute() was never called yet (skip the no-op flush
  // below); null = explicitly cleared; a geometry object = pending draw.
  const pendingRoute = { value: undefined };
  const pendingLinks = { value: undefined };
  let lastRawMarkers = []; // re-clustered on zoom/move — see recluster() below.
  let lastRawSosItems = [];
  let lastSosResolve = null;
  let lastRawIncidents = [];
  let lastIncidentAssign = null;
  let lastIncidentViewRecord = null;
  let lastDispatchLinks = [];
  let lastRouteGeojson = null;
  let reclusterHandle = null;

  const visibleLayers = {
    available: true,
    dispatched: true,
    incident: true,
    sos: true,
  };

  map.on('load', () => {
    ready = true;
    if (pendingBoundary.value) {
      applyBoundary(map, pendingBoundary.value);
    }
    if (pendingLinks.value !== undefined) {
      renderDispatchLinks();
    }
    if (pendingRoute.value !== undefined) {
      renderRoute();
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
  map.on('click', (e) => {
    if (e?.originalEvent?.target?.closest?.('.live-map__marker')) {
      return;
    }
    clearTimeout(focusTimeoutHandle);
    if (activeFocusedTanodId != null) {
      const entry = tanodMarkersById.get(activeFocusedTanodId);
      if (entry) entry.el.classList.remove('live-map__marker--focused');
      activeFocusedTanodId = null;
    }
    activePopupTanodId = null;
  });

  function scheduleRecluster() {
    if (!ready || lastRawMarkers.length === 0) return;
    clearTimeout(reclusterHandle);
    reclusterHandle = setTimeout(() => renderTanodMarkers(lastRawMarkers), 120);
  }

  function clearMarkers(list) {
    for (const marker of list) marker.remove();
    return [];
  }

  function shortPersonLabel(fullName) {
    if (!fullName) return 'Tanod';
    const parts = String(fullName).trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return `${parts[0][0]}. ${parts[parts.length - 1]}`;
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
      // If this marker is the actively focused or popup-active Tanod, isolate it so it is never hidden in a cluster bubble
      const isTargeted = (activeFocusedTanodId != null && points[i].item.userId === activeFocusedTanodId) ||
                         (activePopupTanodId != null && points[i].item.userId === activePopupTanodId);
      if (isTargeted) {
        groups.push([points[i]]);
        used[i] = true;
        continue;
      }
      const group = [points[i]];
      used[i] = true;
      for (let j = i + 1; j < points.length; j++) {
        if (used[j]) continue;
        // Don't absorb the focused or popup-active Tanod into this cluster group either
        const isNeighborTargeted = (activeFocusedTanodId != null && points[j].item.userId === activeFocusedTanodId) ||
                                   (activePopupTanodId != null && points[j].item.userId === activePopupTanodId);
        if (isNeighborTargeted) {
          continue;
        }
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
    tanodMarkersById.clear();
    const bounds = new maplibregl.LngLatBounds();
    let hasPoint = false;

    const filteredMarkers = markers.filter((item) => {
      const isDispatched = item.status === 'dispatched' || item.isDispatched;
      if (isDispatched && !visibleLayers.dispatched) return false;
      if (!isDispatched && !visibleLayers.available) return false;
      return item.latitude != null && item.longitude != null;
    });

    for (const group of clusterByScreenDistance(filteredMarkers)) {
      if (group.length === 1) {
        const item = group[0].item;
        const el = document.createElement('div');
        const isDispatched = item.status === 'dispatched' || item.isDispatched;
        const markerTypeClass = isDispatched ? ' live-map__marker--dispatched' : ' live-map__marker--available';
        const isFocused = activeFocusedTanodId === item.userId;
        const focusedClass = isFocused ? ' live-map__marker--focused' : '';
        el.className = 'live-map__marker live-map__marker--tanod' + markerTypeClass + (item.isStale ? ' live-map__marker--stale' : '') + focusedClass;
        el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

        const labelEl = document.createElement('span');
        labelEl.className = 'live-map__pin-label';
        labelEl.textContent = shortPersonLabel(item.fullName);
        el.appendChild(labelEl);

        el.title = `${item.fullName} — ${isDispatched ? 'Dispatched' : 'Available'} · ${formatAge(item.ageSeconds)}${item.isStale ? ' (stale)' : ''}`;

        // Rich structured DOM popup for Tanod markers
        const popupContent = document.createElement('div');
        popupContent.className = 'live-map__incident-popup';

        const topRow = document.createElement('div');
        topRow.className = 'live-map__popup-top-row';
        const heading = document.createElement('div');
        heading.className = 'live-map__incident-popup-heading';
        heading.textContent = item.fullName || `Tanod #${item.userId}`;
        const statusPill = document.createElement('span');
        statusPill.className = `status-pill ${isDispatched ? 'status-pill--info' : 'status-pill--success'}`;
        statusPill.textContent = isDispatched ? 'Dispatched' : 'Available';
        topRow.append(heading, statusPill);
        if (item.hasActiveSos) {
          const sosBadge = document.createElement('span');
          sosBadge.className = 'live-map__popup-sos-badge';
          sosBadge.textContent = '🚨 SOS ACTIVE';
          topRow.appendChild(sosBadge);
        }
        popupContent.appendChild(topRow);

        const metaEl = document.createElement('div');
        metaEl.className = 'live-map__popup-meta';
        const ageText = document.createElement('span');
        ageText.textContent = `GPS fix: ${formatAge(item.ageSeconds)}${item.isStale ? ' · Stale signal' : ' · Live'}`;
        metaEl.appendChild(ageText);

        if (isDispatched && item.incidentCode) {
          const assignedLine = document.createElement('span');
          assignedLine.className = 'live-map__popup-assigned';
          assignedLine.textContent = `Responding to ${item.incidentCode}`;
          metaEl.appendChild(assignedLine);
        }
        popupContent.appendChild(metaEl);

        let marker;
        if (typeof item.onViewIncident === 'function' && item.incidentId) {
          const viewBtn = document.createElement('button');
          viewBtn.type = 'button';
          viewBtn.className = 'ghost live-map__popup-btn';
          viewBtn.textContent = 'Open Incident Dossier';
          viewBtn.addEventListener('click', () => {
            marker?.getPopup()?.remove();
            item.onViewIncident(item.incidentId);
          });
          popupContent.appendChild(viewBtn);
        }

        el.addEventListener('click', () => {
          const targetZoom = Math.max(map.getZoom(), 18.5);
          map.flyTo({ center: [item.longitude, item.latitude], zoom: targetZoom, duration: 500 });
          applyTanodFocus(item.userId, false);
        });

        const popup = new maplibregl.Popup({ offset: 18, closeButton: true }).setDOMContent(popupContent);
        if (typeof popup.on === 'function') {
          popup.on('open', () => {
            activePopupTanodId = item.userId;
          });
          popup.on('close', () => {
            if (activePopupTanodId === item.userId) {
              activePopupTanodId = null;
            }
          });
        }
        marker = new maplibregl.Marker({ element: el })
          .setLngLat([item.longitude, item.latitude])
          .setPopup(popup)
          .addTo(map);
        tanodMarkers.push(marker);
        tanodMarkersById.set(item.userId, { marker, popup, el, item });

        if (isFocused || activePopupTanodId === item.userId) {
          try {
            if (!popup.isOpen()) marker.togglePopup();
          } catch {}
        }
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
          map.fitBounds(clusterBounds, { padding: 80, maxZoom: 18.5, duration: 400 });
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
    if (visibleLayers.sos) {
      for (const marker of sosMarkers) marker.addTo(map);
    }

    return { bounds, hasPoint };
  }

  function setMarkers(markers) {
    lastRawMarkers = markers;
    const { bounds, hasPoint } = renderTanodMarkers(markers);
    if (hasPoint && !hasFittedBounds) {
      map.fitBounds(bounds, { padding: 64, maxZoom: 16, duration: 300 });
      hasFittedBounds = true;
    }
  }

  function setSosMarkers(sosItems, onResolve) {
    lastRawSosItems = sosItems || [];
    lastSosResolve = onResolve;
    sosMarkers = clearMarkers(sosMarkers);
    sosMarkersById.clear();
    if (!visibleLayers.sos) return;

    for (const item of lastRawSosItems) {
      if (item.latitude == null || item.longitude == null) continue;
      const el = document.createElement('div');
      el.className = 'live-map__marker live-map__marker--sos';
      el.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>`;

      const labelEl = document.createElement('span');
      labelEl.className = 'live-map__pin-label live-map__pin-label--sos';
      labelEl.textContent = item.fullName ? `SOS · ${shortPersonLabel(item.fullName)}` : `SOS #${item.sosId}`;
      el.appendChild(labelEl);

      el.title = `SOS Alert #${item.sosId} — ${item.status || 'Active'}`;

      const popupContent = document.createElement('div');
      popupContent.className = 'live-map__incident-popup';
      const topRow = document.createElement('div');
      topRow.className = 'live-map__popup-top-row';
      const heading = document.createElement('div');
      heading.className = 'live-map__incident-popup-heading';
      heading.textContent = `SOS Alert #${item.sosId}${item.fullName ? ' (' + item.fullName + ')' : ''}`;
      const statusPill = document.createElement('span');
      statusPill.className = 'status-pill status-pill--critical';
      statusPill.textContent = (item.status || 'active').toUpperCase();
      topRow.append(heading, statusPill);
      popupContent.appendChild(topRow);

      let marker;
      if (onResolve && item.status !== 'resolved') {
        const resolveBtn = document.createElement('button');
        resolveBtn.type = 'button';
        resolveBtn.className = 'primary';
        resolveBtn.style.marginTop = '6px';
        resolveBtn.style.width = '100%';
        resolveBtn.textContent = 'Resolve SOS';
        resolveBtn.addEventListener('click', () => {
          marker?.getPopup()?.remove();
          onResolve(item.sosId);
        });
        popupContent.appendChild(resolveBtn);
      }

      el.addEventListener('click', () => {
        const targetZoom = Math.max(map.getZoom(), 18.5);
        map.flyTo({ center: [item.longitude, item.latitude], zoom: targetZoom, duration: 500 });
      });

      const popup = new maplibregl.Popup({ offset: 18, closeButton: true }).setDOMContent(popupContent);
      marker = new maplibregl.Marker({ element: el })
        .setLngLat([item.longitude, item.latitude])
        .setPopup(popup)
        .addTo(map);
      sosMarkers.push(marker);
      sosMarkersById.set(item.sosId, marker);
    }
  }

  let incidentMarkersById = new Map();

  /**
   * Pending & active incident markers on Dispatch Center's map.
   *
   * @param {Array<{incidentId:number, displayId?:string, latitude:number, longitude:number, incidentType:string, priority:string, typeLabel:string, status?:string, locationText?:string, elapsedText?:string, responderText?:string}>} items
   * @param {(incidentId:number) => void} [onAssign]
   * @param {(incidentId:number) => void} [onViewRecord]
   */
  function setIncidentMarkers(items, onAssign, onViewRecord) {
    lastRawIncidents = items || [];
    lastIncidentAssign = onAssign;
    lastIncidentViewRecord = onViewRecord;
    incidentMarkers = clearMarkers(incidentMarkers);
    incidentMarkersById.clear();
    if (!visibleLayers.incident) return;

    for (const item of lastRawIncidents) {
      if (item.latitude == null || item.longitude == null) continue;

      const isCritical = item.priority === 'critical';
      const isDispatched = item.status === 'dispatched';
      const codeStr = item.displayId || `INC-${String(item.incidentId).padStart(3, '0')}`;

      const el = document.createElement('div');
      el.className = 'live-map__marker live-map__marker--incident'
        + (isCritical ? ' live-map__marker--incident-critical' : '')
        + (isDispatched ? ' live-map__marker--incident-dispatched' : '');
      el.innerHTML = `<span class="live-map__incident-diamond" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg></span>`;

      const labelEl = document.createElement('span');
      labelEl.className = 'live-map__pin-label live-map__pin-label--incident';
      labelEl.textContent = codeStr;
      el.appendChild(labelEl);

      el.title = `${codeStr}: ${item.typeLabel || item.incidentType} — ${item.priority} priority`;

      const popupContent = document.createElement('div');
      popupContent.className = 'live-map__incident-popup';

      const topRow = document.createElement('div');
      topRow.className = 'live-map__popup-top-row';
      const heading = document.createElement('div');
      heading.className = 'live-map__incident-popup-heading';
      heading.textContent = `#${item.incidentId} — ${item.typeLabel || item.incidentType}`;
      const priorityPill = document.createElement('span');
      priorityPill.className = 'status-pill' + (isCritical ? ' status-pill--critical' : isDispatched ? ' status-pill--info' : ' status-pill--pending');
      priorityPill.textContent = item.priority;
      topRow.append(heading, priorityPill);
      popupContent.appendChild(topRow);

      if (item.locationText || item.elapsedText || item.responderText) {
        const metaEl = document.createElement('div');
        metaEl.className = 'live-map__popup-meta';
        if (item.locationText) {
          const locSpan = document.createElement('span');
          locSpan.textContent = `📍 ${item.locationText}`;
          metaEl.appendChild(locSpan);
        }
        if (item.elapsedText) {
          const timeSpan = document.createElement('span');
          timeSpan.textContent = `⏱ ${item.elapsedText}`;
          metaEl.appendChild(timeSpan);
        }
        if (item.responderText) {
          const respSpan = document.createElement('span');
          respSpan.className = 'live-map__popup-assigned';
          respSpan.textContent = item.responderText;
          metaEl.appendChild(respSpan);
        }
        popupContent.appendChild(metaEl);
      }

      let marker;
      const actionsRow = document.createElement('div');
      actionsRow.className = 'live-map__popup-actions';

      if (onAssign) {
        const assignButton = document.createElement('button');
        assignButton.type = 'button';
        assignButton.className = (isDispatched ? 'ghost' : 'primary') + ' live-map__popup-btn';
        assignButton.textContent = isDispatched ? '+ Add Responder' : 'Assign';
        assignButton.addEventListener('click', () => {
          marker?.getPopup()?.remove();
          onAssign(item.incidentId);
        });
        actionsRow.appendChild(assignButton);
      }

      if (onViewRecord) {
        const recordBtn = document.createElement('button');
        recordBtn.type = 'button';
        recordBtn.className = 'ghost live-map__popup-btn';
        recordBtn.textContent = 'View Incident';
        recordBtn.addEventListener('click', () => {
          marker?.getPopup()?.remove();
          onViewRecord(item.incidentId);
        });
        actionsRow.appendChild(recordBtn);
      }

      if (actionsRow.children.length > 0) {
        popupContent.appendChild(actionsRow);
      }

      el.addEventListener('click', () => {
        const targetZoom = Math.max(map.getZoom(), 18.5);
        map.flyTo({ center: [item.longitude, item.latitude], zoom: targetZoom, duration: 500 });
      });

      const popup = new maplibregl.Popup({ offset: 18, closeButton: true }).setDOMContent(popupContent);
      marker = new maplibregl.Marker({ element: el })
        .setLngLat([item.longitude, item.latitude])
        .setPopup(popup)
        .addTo(map);
      incidentMarkers.push(marker);
      incidentMarkersById.set(item.incidentId, marker);
    }
  }

  function setBoundary(geojson) {
    if (!ready) {
      pendingBoundary.value = geojson;
      return;
    }
    applyBoundary(map, geojson);
  }

  function renderDispatchLinks() {
    if (!ready || destroyed) return;
    // Dispatch connection lines connect Dispatched Tanods to Incident pins.
    // If either Dispatched Tanods or Incidents layer is hidden, the connection lines must disappear.
    if (!visibleLayers.dispatched || !visibleLayers.incident) {
      applyDispatchLinks(map, []);
      return;
    }
    applyDispatchLinks(map, lastDispatchLinks);
  }

  function setDispatchLinks(links) {
    lastDispatchLinks = Array.isArray(links) ? links : [];
    if (!ready) {
      pendingLinks.value = lastDispatchLinks;
      return;
    }
    renderDispatchLinks();
  }

  function renderRoute() {
    if (!ready || destroyed) return;
    if (!visibleLayers.dispatched || !visibleLayers.incident) {
      applyRoute(map, null);
      return;
    }
    applyRoute(map, lastRouteGeojson);
  }

  function toggleLayer(layerKey) {
    if (!(layerKey in visibleLayers)) return visibleLayers;
    visibleLayers[layerKey] = !visibleLayers[layerKey];
    renderTanodMarkers(lastRawMarkers);
    setIncidentMarkers(lastRawIncidents, lastIncidentAssign, lastIncidentViewRecord);
    setSosMarkers(lastRawSosItems, lastSosResolve);
    renderDispatchLinks();
    renderRoute();
    return { ...visibleLayers };
  }

  function resetLayers() {
    visibleLayers.available = true;
    visibleLayers.dispatched = true;
    visibleLayers.incident = true;
    visibleLayers.sos = true;
    renderTanodMarkers(lastRawMarkers);
    setIncidentMarkers(lastRawIncidents, lastIncidentAssign, lastIncidentViewRecord);
    setSosMarkers(lastRawSosItems, lastSosResolve);
    renderDispatchLinks();
    renderRoute();
    return { ...visibleLayers };
  }

  function getLayerVisibility() {
    return { ...visibleLayers };
  }

  /**
   * Draws (or updates, or clears) a single road-snapped route line —
   * Dispatch Center's read-only display of a route a Tanod's own mobile
   * "Get Route" tap already computed (`dispatch.route_json.geometry`,
   * an already-decoded GeoJSON LineString — never a polyline needing
   * decoding). One function, not a separate clear method: `setRoute(null)`
   * removes the line, matching that a dispatch's `routeJson` is already
   * `null` exactly when there's nothing to show — callers never need to
   * special-case "no route."
   */
  function setRoute(geojson) {
    lastRouteGeojson = geojson;
    if (!ready) {
      pendingRoute.value = geojson;
      return;
    }
    renderRoute();
  }

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(reclusterHandle);
    clearTimeout(focusTimeoutHandle);
    clearMarkers(tanodMarkers);
    tanodMarkersById.clear();
    clearMarkers(sosMarkers);
    sosMarkersById.clear();
    clearMarkers(incidentMarkers);
    incidentMarkersById.clear();
    applyDispatchLinks(map, []);
    applyRoute(map, null);
    map.remove();
  }

  function flyTo(latitude, longitude, zoom = 18.5) {
    if (destroyed) return;
    map.flyTo({ center: [longitude, latitude], zoom, duration: 600 });
  }

  function highlightTanod(userId, zoom = 18.5) {
    if (destroyed) return false;
    activeFocusedTanodId = userId;

    const raw = lastRawMarkers.find((m) => m.userId === userId);
    if (!raw || raw.latitude == null || raw.longitude == null) return false;

    // Unhide layer if it was hidden so the Tanod pin is visible
    const isDispatched = raw.status === 'dispatched' || raw.isDispatched;
    if (isDispatched && !visibleLayers.dispatched) {
      visibleLayers.dispatched = true;
    }
    if (!isDispatched && !visibleLayers.available) {
      visibleLayers.available = true;
    }

    const targetZoom = Math.max(map.getZoom(), zoom);
    map.flyTo({ center: [Number(raw.longitude), Number(raw.latitude)], zoom: targetZoom, duration: 600 });

    // Re-render immediately so the targeted marker is guaranteed unclustered and focused
    renderTanodMarkers(lastRawMarkers);
    applyTanodFocus(userId);
    return true;
  }

  function applyTanodFocus(userId, openPopup = true) {
    clearTimeout(focusTimeoutHandle);
    activeFocusedTanodId = userId;
    if (openPopup) {
      activePopupTanodId = userId;
    }
    const entry = tanodMarkersById.get(userId);
    if (entry) {
      entry.el.classList.add('live-map__marker--focused');
      if (openPopup) {
        try {
          if (entry.popup && !entry.popup.isOpen()) {
            entry.marker.togglePopup();
          }
        } catch {}
      }
    }
    focusTimeoutHandle = setTimeout(() => {
      if (entry) entry.el.classList.remove('live-map__marker--focused');
      if (activeFocusedTanodId === userId) {
        activeFocusedTanodId = null;
      }
    }, 8000);
  }

  function highlightSos(sosId, zoom = 18.5) {
    if (destroyed) return false;
    if (!visibleLayers.sos) {
      visibleLayers.sos = true;
    }
    const marker = sosMarkersById.get(sosId);
    if (!marker) return false;
    const lngLat = marker.getLngLat();
    const targetZoom = Math.max(map.getZoom(), zoom);
    map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: targetZoom, duration: 600 });
    try {
      const popup = marker.getPopup();
      if (popup && !popup.isOpen()) {
        marker.togglePopup();
      }
    } catch {}
    return true;
  }

  function highlightIncident(incidentId, zoom = 18.5) {
    if (destroyed) return false;
    if (!visibleLayers.incident) {
      visibleLayers.incident = true;
    }
    const marker = incidentMarkersById.get(incidentId);
    if (!marker) return false;
    const lngLat = marker.getLngLat();
    const targetZoom = Math.max(map.getZoom(), zoom);
    map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: targetZoom, duration: 600 });
    try {
      const popup = marker.getPopup();
      if (popup && !popup.isOpen()) {
        marker.togglePopup();
      }
    } catch {}
    return true;
  }

  function fitAll() {
    if (destroyed) return;
    const bounds = new maplibregl.LngLatBounds();
    let count = 0;
    for (const m of lastRawMarkers) {
      if (m.latitude != null && m.longitude != null) {
        bounds.extend([m.longitude, m.latitude]);
        count++;
      }
    }
    for (const m of sosMarkers) {
      bounds.extend(m.getLngLat());
      count++;
    }
    for (const m of incidentMarkers) {
      bounds.extend(m.getLngLat());
      count++;
    }
    if (count > 0) {
      map.fitBounds(bounds, { padding: 56, maxZoom: 16, duration: 600 });
    } else {
      map.flyTo({ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, duration: 600 });
    }
  }

  function zoomIn() {
    if (!destroyed) map.zoomIn();
  }

  function zoomOut() {
    if (!destroyed) map.zoomOut();
  }

  function resize() {
    if (!destroyed) map.resize();
  }

  return {
    setMarkers,
    setSosMarkers,
    setIncidentMarkers,
    setBoundary,
    setDispatchLinks,
    setRoute,
    toggleLayer,
    resetLayers,
    getLayerVisibility,
    flyTo,
    highlightTanod,
    highlightSos,
    highlightIncident,
    fitAll,
    resize,
    zoomIn,
    zoomOut,
    destroy,
  };
}

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

function applyDispatchLinks(map, links) {
  const validLinks = Array.isArray(links)
    ? links.filter((l) => l && l.fromLng != null && l.fromLat != null && l.toLng != null && l.toLat != null)
    : [];

  if (validLinks.length === 0) {
    if (map.getLayer('dispatch-links-layer')) map.removeLayer('dispatch-links-layer');
    if (map.getSource('dispatch-links')) map.removeSource('dispatch-links');
    return;
  }
  const features = validLinks.map((l) => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: [
        [Number(l.fromLng), Number(l.fromLat)],
        [Number(l.toLng), Number(l.toLat)],
      ],
    },
  }));
  const data = { type: 'FeatureCollection', features };
  if (map.getSource('dispatch-links')) {
    map.getSource('dispatch-links').setData(data);
    return;
  }
  map.addSource('dispatch-links', { type: 'geojson', data });
  map.addLayer({
    id: 'dispatch-links-layer',
    type: 'line',
    source: 'dispatch-links',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': themeToken('--color-primary', '#2563EB'),
      'line-width': 2.5,
      'line-dasharray': [2, 2],
      'line-opacity': 0.75,
    },
  });
}

function applyRoute(map, geojson) {
  if (!geojson) {
    if (map.getLayer('dispatch-route-line')) map.removeLayer('dispatch-route-line');
    if (map.getSource('dispatch-route')) map.removeSource('dispatch-route');
    return;
  }
  const data = { type: 'Feature', properties: {}, geometry: geojson };
  if (map.getSource('dispatch-route')) {
    map.getSource('dispatch-route').setData(data);
    return;
  }
  map.addSource('dispatch-route', { type: 'geojson', data });
  map.addLayer({
    id: 'dispatch-route-line',
    type: 'line',
    source: 'dispatch-route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': themeToken('--color-primary', '#1D4ED8'), 'line-width': 5, 'line-opacity': 0.85 },
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

export function formatAge(ageSeconds) {
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
