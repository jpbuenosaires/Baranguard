/**
 * LiveMap — the shared MapLibre component §9 W4 requires ("build the
 * shared LiveMap component here; W3's map pane reuses it later, it does
 * not get a second implementation"). Both `dispatch-center.js` (W3) and
 * `gis-live-tracking.js` (W4) instantiate this; neither hand-rolls its
 * own map.
 *
 * PascalCase filename per §4 (component convention).
 *
 * Tactical CAD Enhancements:
 *   - Screen-pixel clustering for both Tanods and Incidents to eliminate
 *     marker clutter and pin collision in dense Poblacion areas.
 *   - Clustered incident flyout/popup dossier when points share identical
 *     coordinates, ensuring every stacked incident is accessible and assignable.
 *   - Category micro-icons and severity-based tactical badges.
 *   - Smart adaptive label density with hover/zoom reveal so labels never overlap.
 *   - Distance & Estimated Walking Time (ETA) badges on dispatch links.
 *   - Official barangay boundary (PSA polygons, see data/barangayBoundaries.js).
 *   - Community Landmarks & POIs layer (Barangay Hall, Schools, Evacuation Centers).
 *   - GPS Accuracy radius circles for approximate/weak signals.
 *   - 100% tokenized CSS integration.
 */

import { onThemeChange } from './themeEvents.js';
import { attachBasemapFallback, OSM_TILE_URL } from '../utils/mapFallback.js';
import { formatSosCode, formatIncidentCode } from '../services/tanodWorkflowUi.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { boundaryFor, centerFor } from '../data/barangayBoundaries.js';

const DEFAULT_ZOOM = 15; // a barangay (about 1-2 km across) fills the viewport
const CLUSTER_RADIUS_PX = 44; // Screen-pixel distance for Tanod grouping
const INCIDENT_CLUSTER_RADIUS_PX = 46; // Screen-pixel distance for Incident grouping

/**
 * Community Landmarks and Critical Infrastructure POIs in Pilar.
 * Coordinates are the OpenStreetMap positions (Overpass query, 2026-10-17), not estimates.
 */
export const PILAR_COMMUNITY_POIS = [
  { id: 'bgy-hall', name: 'Dao Brgy Hall & HQ', category: 'command', lat: 12.922, lng: 123.67449, glyph: '🏛️' },
  { id: 'evac-center', name: 'Binanuahan Evac Center', category: 'evacuation', lat: 12.92331, lng: 123.67567, glyph: '🛡️' },
  { id: 'public-market', name: 'Pilar Public Market', category: 'market', lat: 12.92199, lng: 123.67514, glyph: '🛒' },
  { id: 'rhu-clinic', name: 'Rural Health Unit', category: 'medical', lat: 12.9255, lng: 123.66714, glyph: '🏥' },
  { id: 'pilar-central', name: 'Pilar Central School', category: 'school', lat: 12.92262, lng: 123.67314, glyph: '🏫' },
  { id: 'banuyo-elem', name: 'Banuyo Elem School', category: 'school', lat: 12.9255, lng: 123.67468, glyph: '🏫' },
  { id: 'pilar-port', name: 'Port of Pilar', category: 'port', lat: 12.92144, lng: 123.67585, glyph: '⚓' },
];

/**
 * Calculates geodesic distance in meters between two lat/lng pairs.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} meters
 */
export function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * Formats distance and estimated walking time (~80 meters / min).
 * @param {number} meters
 * @returns {string} e.g. "350m · ~4m walk"
 */
export function formatDistanceAndEta(meters) {
  const walkingSpeedMpm = 80;
  const minutes = Math.max(1, Math.round(meters / walkingSpeedMpm));
  const distStr = meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${meters}m`;
  return `${distStr} · ~${minutes}m walk`;
}

/**
 * Shortens official incident code for compact map callout badges (e.g. "INC-2026-144" -> "INC-144").
 * @param {string} codeStr
 * @returns {string}
 */
export function formatIncidentMapBadge(codeStr) {
  if (!codeStr) return '';
  return String(codeStr).replace(/^INC-\d{4}-/, 'INC-').replace(/^INC-#/, 'INC-');
}

/**
 * Returns an inline SVG string for the given incident type.
 * @param {string} type
 * @param {number} [size=13]
 * @returns {string}
 */
export function getIncidentCategorySvg(type, size = 13) {
  switch (type) {
    case 'theft':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6z"/></svg>`;
    case 'physical_injury':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v8m-4-4h8"/><rect x="3" y="3" width="18" height="18" rx="4"/></svg>`;
    case 'fire':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c1 3-3 4-3 8a3 3 0 0 0 6 0c0-1-1-2-1-3 2 1 3 4 3 6a5 5 0 0 1-10 0c0-5 3-6 5-11z"/></svg>`;
    case 'medical_emergency':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`;
    case 'traffic_incident':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M5 17H3v-4l2-5h14l2 5v4h-2m-10 0h6"/></svg>`;
    case 'domestic_dispute':
    case 'disturbance':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 11l2 2 4-4"/></svg>`;
    case 'vandalism':
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
    default:
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>`;
  }
}

/**
 * @param {HTMLElement} container
 * @param {object} [options]
 */
export function LiveMap(container, options = {}) {
  container.classList.add('live-map');
  const BOUNDARY = boundaryFor(options.barangayId);
  const DEFAULT_CENTER = centerFor(options.barangayId);

  const map = new maplibregl.Map({
    container,
    style: buildStyle(),
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    attributionControl: false,
    preserveDrawingBuffer: true,
  });

  if (options.showNavControl !== false) {
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  }
  map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');

  const detachBasemapFallback = attachBasemapFallback(map, 'osm-raster');

  let tanodMarkers = [];
  let sosMarkers = [];
  let incidentMarkers = [];
  let dispatchLinkEtaMarkers = [];
  let poiMarkers = [];

  const tanodMarkersById = new Map();
  const sosMarkersById = new Map();
  const incidentMarkersById = new Map();

  let activeFocusedTanodId = null;
  let activePopupTanodId = null;
  let focusTimeoutHandle = null;

  let activeFocusedIncidentId = null;
  let activePopupIncidentId = null;
  let incidentFocusTimeoutHandle = null;

  let labelMode = 'auto'; // 'auto' | 'always' | 'hover'
  let incidentFilterQuery = '';
  let incidentFilterPriority = 'all';
  let incidentFilterStatus = 'all';

  let ready = false;
  let hasFittedBounds = false;
  const pendingBoundary = { value: null };
  const pendingRoute = { value: undefined };
  const pendingLinks = { value: undefined };

  let lastRawMarkers = [];
  let lastRawSosItems = [];
  let lastSosResolve = null;
  let lastSosAck = null;
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
    poi: Boolean(options.showPois),
  };

  function updateLabelDensity() {
    if (labelMode === 'always') {
      container.classList.add('live-map--show-all-labels');
      container.classList.remove('live-map--labels-compact');
    } else if (labelMode === 'hover') {
      container.classList.remove('live-map--show-all-labels');
      container.classList.add('live-map--labels-compact');
    } else {
      container.classList.remove('live-map--show-all-labels');
      if (map.getZoom() < 16.5) {
        container.classList.add('live-map--labels-compact');
      } else {
        container.classList.remove('live-map--labels-compact');
      }
    }
  }

  map.on('load', () => {
    ready = true;
    updateLabelDensity();
    if (pendingBoundary.value) {
      applyBoundary(map, pendingBoundary.value);
    } else {
      applyBoundary(map, BOUNDARY);
    }
    renderPoiMarkers();
    if (pendingLinks.value !== undefined) {
      renderDispatchLinks();
    }
    if (pendingRoute.value !== undefined) {
      renderRoute();
    }
  });

  map.on('moveend', () => {
    updateLabelDensity();
    scheduleRecluster();
  });
  map.on('zoomend', () => {
    updateLabelDensity();
    scheduleRecluster();
  });

  map.on('click', (e) => {
    if (e?.originalEvent?.target?.closest?.('.live-map__marker')) {
      return;
    }
    clearTimeout(focusTimeoutHandle);
    clearTimeout(incidentFocusTimeoutHandle);

    if (activeFocusedTanodId != null) {
      const entry = tanodMarkersById.get(activeFocusedTanodId);
      if (entry?.el) entry.el.classList.remove('live-map__marker--focused');
      activeFocusedTanodId = null;
    }
    activePopupTanodId = null;

    if (activeFocusedIncidentId != null) {
      const entry = incidentMarkersById.get(activeFocusedIncidentId);
      if (entry?.el) entry.el.classList.remove('live-map__marker--focused');
      activeFocusedIncidentId = null;
    }
    activePopupIncidentId = null;
  });

  function scheduleRecluster() {
    if (!ready) return;
    clearTimeout(reclusterHandle);
    reclusterHandle = setTimeout(() => {
      if (lastRawMarkers.length > 0) renderTanodMarkers(lastRawMarkers);
      if (lastRawIncidents.length > 0) renderIncidentMarkers(lastRawIncidents, lastIncidentAssign, lastIncidentViewRecord);
    }, 120);
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

  function renderPoiMarkers() {
    poiMarkers = clearMarkers(poiMarkers);
    if (!visibleLayers.poi) return;

    for (const poi of PILAR_COMMUNITY_POIS) {
      const el = document.createElement('div');
      el.className = 'live-map__marker live-map__marker--poi';
      el.innerHTML = `<span aria-hidden="true">${poi.glyph}</span>`;
      el.title = `${poi.name} · ${poi.category.toUpperCase()}`;

      const labelEl = document.createElement('span');
      labelEl.className = 'live-map__pin-label';
      labelEl.textContent = poi.name;
      el.appendChild(labelEl);

      const popupContent = document.createElement('div');
      popupContent.className = 'live-map__incident-popup';
      popupContent.innerHTML = `
        <div class="live-map__popup-top-row">
          <div class="live-map__incident-popup-heading">${poi.glyph} ${escapeHtml(poi.name)}</div>
          <span class="status-pill status-pill--info">${escapeHtml(poi.category.toUpperCase())}</span>
        </div>
        <div class="live-map__popup-meta">
          <span>Barangay Infrastructure · Key Community Point</span>
          <span>Coordinates: ${poi.lat.toFixed(4)}, ${poi.lng.toFixed(4)}</span>
        </div>
      `;

      const popup = new maplibregl.Popup({ offset: 14, closeButton: true }).setDOMContent(popupContent);
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([poi.lng, poi.lat])
        .setPopup(popup)
        .addTo(map);

      poiMarkers.push(marker);
    }
  }

  /**
   * Greedy screen-pixel clustering for Tanods
   */
  function clusterTanodsByScreenDistance(markers) {
    const points = markers.map((item) => ({ item, px: map.project([item.longitude, item.latitude]) }));
    const groups = [];
    const used = new Array(points.length).fill(false);
    for (let i = 0; i < points.length; i++) {
      if (used[i]) continue;
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

    for (const group of clusterTanodsByScreenDistance(filteredMarkers)) {
      if (group.length === 1) {
        const item = group[0].item;
        const el = document.createElement('div');
        const isDispatched = item.status === 'dispatched' || item.isDispatched;
        const markerTypeClass = isDispatched ? ' live-map__marker--dispatched' : ' live-map__marker--available';
        const isFocused = activeFocusedTanodId === item.userId;
        const focusedClass = isFocused ? ' live-map__marker--focused' : '';

        // GPS accuracy circle: if accuracy is weak (>30m), draw subtle translucent accuracy radius
        const isApproxGps = (item.accuracy_m != null && item.accuracy_m > 30) || item.isStale;
        const approxClass = isApproxGps ? ' live-map__marker--approx-gps' : '';
        if (isApproxGps) {
          const circleRem = Math.min(5, Math.max(2.5, (item.accuracy_m || 40) / 16));
          el.style.setProperty('--approx-circle-size', `${circleRem}rem`);
        }

        const isNearIncident = lastRawIncidents.some((inc) => (
          inc.latitude != null && inc.longitude != null &&
          Math.abs(Number(item.latitude) - Number(inc.latitude)) < 0.0002 &&
          Math.abs(Number(item.longitude) - Number(inc.longitude)) < 0.0002
        ));
        const stackClass = isNearIncident ? ' live-map__marker--stacked-left' : '';

        el.className = 'live-map__marker live-map__marker--tanod' + markerTypeClass + (item.isStale ? ' live-map__marker--stale' : '') + approxClass + focusedClass + stackClass;
        el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

        const labelEl = document.createElement('span');
        labelEl.className = 'live-map__pin-label';
        labelEl.textContent = shortPersonLabel(item.fullName);
        el.appendChild(labelEl);

        el.title = `${item.fullName} — ${isDispatched ? 'Dispatched' : 'Available'} · ${formatAge(item.ageSeconds)}${item.isStale ? ' (stale)' : ''}`;

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

        if (item.accuracy_m != null) {
          const accSpan = document.createElement('span');
          accSpan.textContent = `Accuracy: ±${Math.round(item.accuracy_m)}m${item.accuracy_m > 30 ? ' (approximate fix)' : ' (precise)'}`;
          metaEl.appendChild(accSpan);
        }

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

    if (visibleLayers.sos) {
      for (const marker of sosMarkers) marker.addTo(map);
    }

    return { bounds, hasPoint };
  }

  function setMarkers(markers) {
    lastRawMarkers = markers || [];
    const { bounds, hasPoint } = renderTanodMarkers(lastRawMarkers);
    if (hasPoint && !hasFittedBounds) {
      map.fitBounds(bounds, { padding: 64, maxZoom: 16, duration: 300 });
      hasFittedBounds = true;
    }
  }

  function setSosMarkers(sosItems, onResolve, onAcknowledge) {
    lastRawSosItems = sosItems || [];
    lastSosResolve = onResolve;
    lastSosAck = onAcknowledge;
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
      const isLastKnown = item.locationSource === 'last_known';
      const lastKnownAt = isLastKnown ? manilaClock(item.locationRecordedAt) : null;
      const lastKnownText = isLastKnown ? `last known position${lastKnownAt ? ` (${lastKnownAt})` : ''}` : null;
      const sosCode = formatSosCode(item.sosId);
      const baseLabel = item.fullName ? `SOS · ${shortPersonLabel(item.fullName)}` : sosCode;
      labelEl.textContent = lastKnownText ? `${baseLabel} · ${lastKnownText}` : baseLabel;
      el.appendChild(labelEl);
      if (isLastKnown) {
        el.classList.add('live-map__marker--sos-last-known');
      }

      el.title = `${sosCode} — ${item.status || 'Active'}${lastKnownText ? ` — ${lastKnownText}` : ''}`;

      const popupContent = document.createElement('div');
      popupContent.className = 'live-map__incident-popup';
      const topRow = document.createElement('div');
      topRow.className = 'live-map__popup-top-row';
      const heading = document.createElement('div');
      heading.className = 'live-map__incident-popup-heading';
      heading.textContent = `${sosCode}${item.fullName ? ' (' + item.fullName + ')' : ''}`;
      const statusPill = document.createElement('span');
      statusPill.className = 'status-pill status-pill--critical';
      statusPill.textContent = (item.status || 'active').toUpperCase();
      topRow.append(heading, statusPill);
      popupContent.appendChild(topRow);
      if (lastKnownText) {
        const note = document.createElement('div');
        note.className = 'live-map__incident-popup-meta';
        note.textContent = `Position is the ${lastKnownText}, not a live fix. Call the tanod.`;
        popupContent.appendChild(note);
      }

      let marker;
      if (onAcknowledge && item.status === 'active') {
        const ackBtn = document.createElement('button');
        ackBtn.type = 'button';
        ackBtn.className = 'live-map__popup-ack-btn';
        ackBtn.style.marginTop = '6px';
        ackBtn.style.width = '100%';
        ackBtn.textContent = 'Acknowledge SOS';
        ackBtn.addEventListener('click', () => {
          marker?.getPopup()?.remove();
          onAcknowledge(item.sosId);
        });
        popupContent.appendChild(ackBtn);
      }
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
        const targetZoom = isLastKnown ? Math.max(map.getZoom(), 15) : Math.max(map.getZoom(), 18.5);
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

  /**
   * Screen-distance clustering for Incidents
   */
  function clusterIncidentsByScreenDistance(items) {
    const points = items.map((item) => ({ item, px: map.project([item.longitude, item.latitude]) }));
    const groups = [];
    const used = new Array(points.length).fill(false);
    for (let i = 0; i < points.length; i++) {
      if (used[i]) continue;
      const isTargeted = (activeFocusedIncidentId != null && points[i].item.incidentId === activeFocusedIncidentId) ||
                         (activePopupIncidentId != null && points[i].item.incidentId === activePopupIncidentId);
      if (isTargeted) {
        groups.push([points[i]]);
        used[i] = true;
        continue;
      }
      const group = [points[i]];
      used[i] = true;
      for (let j = i + 1; j < points.length; j++) {
        if (used[j]) continue;
        const isNeighborTargeted = (activeFocusedIncidentId != null && points[j].item.incidentId === activeFocusedIncidentId) ||
                                   (activePopupIncidentId != null && points[j].item.incidentId === activePopupIncidentId);
        if (isNeighborTargeted) {
          continue;
        }
        const dx = points[i].px.x - points[j].px.x;
        const dy = points[i].px.y - points[j].px.y;
        if (Math.sqrt(dx * dx + dy * dy) <= INCIDENT_CLUSTER_RADIUS_PX) {
          group.push(points[j]);
          used[j] = true;
        }
      }
      groups.push(group);
    }
    return groups;
  }

  function renderIncidentMarkers(items, onAssign, onViewRecord) {
    lastRawIncidents = items || [];
    lastIncidentAssign = onAssign;
    lastIncidentViewRecord = onViewRecord;
    incidentMarkers = clearMarkers(incidentMarkers);
    incidentMarkersById.clear();
    if (!visibleLayers.incident) return;

    const filtered = lastRawIncidents.filter((item) => {
      if (item.latitude == null || item.longitude == null) return false;
      if (incidentFilterQuery) {
        const q = incidentFilterQuery.toLowerCase();
        const code = formatIncidentCode(item.incidentId, item.displayId).toLowerCase();
        const type = (item.typeLabel || item.incidentType || '').toLowerCase();
        const loc = (item.locationText || '').toLowerCase();
        if (!code.includes(q) && !type.includes(q) && !loc.includes(q)) return false;
      }
      if (incidentFilterPriority && incidentFilterPriority !== 'all') {
        if (item.priority !== incidentFilterPriority) return false;
      }
      if (incidentFilterStatus && incidentFilterStatus !== 'all') {
        if (item.status !== incidentFilterStatus) return false;
      }
      return true;
    });

    for (const group of clusterIncidentsByScreenDistance(filtered)) {
      if (group.length === 1) {
        const item = group[0].item;
        const isCritical = item.priority === 'critical';
        const isDispatched = item.status === 'dispatched';
        const codeStr = formatIncidentCode(item.incidentId, item.displayId);
        const isFocused = activeFocusedIncidentId === item.incidentId;
        const focusedClass = isFocused ? ' live-map__marker--focused' : '';
        const catKey = (item.incidentType || 'other').replace(/_/g, '-');

        const isNearTanod = lastRawMarkers.some((tanod) => (
          tanod.latitude != null && tanod.longitude != null &&
          Math.abs(Number(item.latitude) - Number(tanod.latitude)) < 0.0002 &&
          Math.abs(Number(item.longitude) - Number(tanod.longitude)) < 0.0002
        ));
        const stackClass = isNearTanod ? ' live-map__marker--stacked-right' : '';

        const el = document.createElement('div');
        el.className = 'live-map__marker live-map__marker--incident'
          + (isCritical ? ' live-map__marker--incident-critical' : '')
          + (isDispatched ? ' live-map__marker--incident-dispatched' : '')
          + ` live-map__marker--cat-${catKey}`
          + focusedClass
          + stackClass;
        el.setAttribute('data-incident-id', String(item.incidentId));
        el.innerHTML = `<span class="live-map__incident-diamond" aria-hidden="true">${getIncidentCategorySvg(item.incidentType || 'other', 13)}</span>`;

        const labelEl = document.createElement('span');
        labelEl.className = 'live-map__pin-label live-map__pin-label--incident';
        labelEl.textContent = formatIncidentMapBadge(codeStr);
        el.appendChild(labelEl);

        el.title = `${codeStr}: ${item.typeLabel || item.incidentType} — ${item.priority} priority`;

        const popupContent = document.createElement('div');
        popupContent.className = 'live-map__incident-popup';

        const topRow = document.createElement('div');
        topRow.className = 'live-map__popup-top-row';
        const heading = document.createElement('div');
        heading.className = 'live-map__incident-popup-heading';
        heading.textContent = `${codeStr} — ${item.typeLabel || item.incidentType}`;
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
          assignButton.addEventListener('click', (e) => {
            e.stopPropagation();
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
          recordBtn.addEventListener('click', (e) => {
            e.stopPropagation();
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
          applyIncidentFocus(item.incidentId, false);
          if (typeof options.onSelectIncident === 'function') {
            options.onSelectIncident(item.incidentId);
          }
        });

        const popup = new maplibregl.Popup({ offset: 18, closeButton: true }).setDOMContent(popupContent);
        if (typeof popup.on === 'function') {
          popup.on('open', () => {
            activePopupIncidentId = item.incidentId;
          });
          popup.on('close', () => {
            if (activePopupIncidentId === item.incidentId) {
              activePopupIncidentId = null;
            }
          });
        }
        marker = new maplibregl.Marker({ element: el })
          .setLngLat([item.longitude, item.latitude])
          .setPopup(popup)
          .addTo(map);

        marker.el = el;
        marker.popup = popup;
        incidentMarkers.push(marker);
        incidentMarkersById.set(item.incidentId, marker);

        if (isFocused || activePopupIncidentId === item.incidentId) {
          try {
            if (!popup.isOpen()) marker.togglePopup();
          } catch {}
        }
      } else {
        const clusterBounds = new maplibregl.LngLatBounds();
        let hasCritical = false;
        let allDispatched = true;
        for (const point of group) {
          clusterBounds.extend([point.item.longitude, point.item.latitude]);
          if (point.item.priority === 'critical') hasCritical = true;
          if (point.item.status !== 'dispatched') allDispatched = false;
        }
        const center = clusterBounds.getCenter();

        const el = document.createElement('div');
        el.className = 'live-map__marker live-map__cluster live-map__cluster--incident'
          + (hasCritical ? ' live-map__cluster--has-critical' : '')
          + (allDispatched ? ' live-map__cluster--all-dispatched' : '');
        el.innerHTML = `<span class="live-map__cluster-icon" aria-hidden="true">${hasCritical ? '⚠️' : '📍'}</span><span>${group.length}</span>`;
        el.title = `${group.length} Incidents in this area (${hasCritical ? 'Critical alert' : 'Click to inspect'})`;

        const clusterPopupContent = document.createElement('div');
        clusterPopupContent.className = 'live-map__cluster-popup';

        const header = document.createElement('div');
        header.className = 'live-map__cluster-popup-header';
        header.innerHTML = `<span>${group.length} Incidents at Location</span>`;
        clusterPopupContent.appendChild(header);

        for (const point of group) {
          const inc = point.item;
          const incCode = formatIncidentCode(inc.incidentId, inc.displayId);
          const incItemEl = document.createElement('div');
          incItemEl.className = 'live-map__cluster-popup-item';

          const itemTop = document.createElement('div');
          itemTop.className = 'live-map__cluster-popup-item-top';
          const codeSpan = document.createElement('span');
          codeSpan.className = 'live-map__cluster-popup-item-title';
          codeSpan.textContent = incCode;
          if (typeof options.onSelectIncident === 'function') {
            codeSpan.style.cursor = 'pointer';
            codeSpan.title = 'Click to inspect in drawer';
            codeSpan.addEventListener('click', (e) => {
              e.stopPropagation();
              options.onSelectIncident(inc.incidentId);
            });
          }
          const pill = document.createElement('span');
          pill.className = 'status-pill' + (inc.priority === 'critical' ? ' status-pill--critical' : inc.status === 'dispatched' ? ' status-pill--info' : ' status-pill--pending');
          pill.textContent = inc.priority;
          itemTop.append(codeSpan, pill);

          const sub = document.createElement('div');
          sub.className = 'live-map__cluster-popup-item-sub';
          sub.textContent = `${inc.typeLabel || inc.incidentType}${inc.locationText ? ` · ${inc.locationText}` : ''}`;

          const actions = document.createElement('div');
          actions.className = 'live-map__popup-actions';
          if (onAssign) {
            const assignBtn = document.createElement('button');
            assignBtn.type = 'button';
            assignBtn.className = (inc.status === 'dispatched' ? 'ghost' : 'primary') + ' live-map__popup-btn';
            assignBtn.textContent = inc.status === 'dispatched' ? '+ Add' : 'Assign';
            assignBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              clusterMarker?.getPopup()?.remove();
              onAssign(inc.incidentId);
            });
            actions.appendChild(assignBtn);
          }
          if (onViewRecord) {
            const viewBtn = document.createElement('button');
            viewBtn.type = 'button';
            viewBtn.className = 'ghost live-map__popup-btn';
            viewBtn.textContent = 'View';
            viewBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              clusterMarker?.getPopup()?.remove();
              onViewRecord(inc.incidentId);
            });
            actions.appendChild(viewBtn);
          }

          incItemEl.append(itemTop, sub);
          if (actions.children.length > 0) incItemEl.appendChild(actions);
          clusterPopupContent.appendChild(incItemEl);
        }

        const clusterPopup = new maplibregl.Popup({ offset: 18, closeButton: true }).setDOMContent(clusterPopupContent);

        el.addEventListener('click', (event) => {
          if (map.getZoom() < 17) {
            event.stopPropagation();
            map.fitBounds(clusterBounds, { padding: 80, maxZoom: 18.5, duration: 400 });
          }
        });

        const clusterMarker = new maplibregl.Marker({ element: el })
          .setLngLat(center)
          .setPopup(clusterPopup)
          .addTo(map);

        clusterMarker.el = el;
        clusterMarker.popup = clusterPopup;
        incidentMarkers.push(clusterMarker);

        for (const point of group) {
          incidentMarkersById.set(point.item.incidentId, clusterMarker);
        }
      }
    }
  }

  // The map opens on the barangay centre, which can leave most incident pins off screen
  // (the legend counts them all); frame them once, on the first data, then leave the view to the user.
  let didInitialFit = false;
  function setIncidentMarkers(items, onAssign, onViewRecord) {
    renderIncidentMarkers(items, onAssign, onViewRecord);
    if (!didInitialFit && incidentMarkers.length > 0 && activeFocusedIncidentId == null) {
      didInitialFit = true;
      fitAll();
    }
  }

  function applyIncidentFocus(incidentId, openPopup = true) {
    clearTimeout(incidentFocusTimeoutHandle);
    activeFocusedIncidentId = incidentId;
    if (openPopup) {
      activePopupIncidentId = incidentId;
    }
    const entry = incidentMarkersById.get(incidentId);
    if (entry?.el) {
      entry.el.classList.add('live-map__marker--focused');
      if (openPopup && entry.popup) {
        try {
          if (!entry.popup.isOpen()) entry.marker.togglePopup();
        } catch {}
      }
    }
    incidentFocusTimeoutHandle = setTimeout(() => {
      if (entry?.el) entry.el.classList.remove('live-map__marker--focused');
      if (activeFocusedIncidentId === incidentId) {
        activeFocusedIncidentId = null;
      }
    }, 8000);
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
    dispatchLinkEtaMarkers = clearMarkers(dispatchLinkEtaMarkers);

    if (!visibleLayers.dispatched || !visibleLayers.incident) {
      applyDispatchLinks(map, []);
      return;
    }

    const validLinks = Array.isArray(lastDispatchLinks)
      ? lastDispatchLinks.filter((l) => l && l.fromLng != null && l.fromLat != null && l.toLng != null && l.toLat != null)
      : [];

    applyDispatchLinks(map, validLinks);

    for (const link of validLinks) {
      const fromLng = Number(link.fromLng);
      const fromLat = Number(link.fromLat);
      const toLng = Number(link.toLng);
      const toLat = Number(link.toLat);
      const meters = calculateDistanceMeters(fromLat, fromLng, toLat, toLng);
      if (meters < 25) continue;

      const midLng = (fromLng + toLng) / 2;
      const midLat = (fromLat + toLat) / 2;
      const etaText = formatDistanceAndEta(meters);

      const el = document.createElement('div');
      el.className = 'live-map__link-eta-badge';
      el.textContent = etaText;
      el.title = `Estimated distance: ${etaText}`;

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([midLng, midLat])
        .addTo(map);

      dispatchLinkEtaMarkers.push(marker);
    }
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
    renderIncidentMarkers(lastRawIncidents, lastIncidentAssign, lastIncidentViewRecord);
    setSosMarkers(lastRawSosItems, lastSosResolve, lastSosAck);
    renderPoiMarkers();
    renderDispatchLinks();
    renderRoute();
    return { ...visibleLayers };
  }

  function resetLayers() {
    visibleLayers.available = true;
    visibleLayers.dispatched = true;
    visibleLayers.incident = true;
    visibleLayers.sos = true;
    visibleLayers.poi = Boolean(options.showPois);
    renderTanodMarkers(lastRawMarkers);
    renderIncidentMarkers(lastRawIncidents, lastIncidentAssign, lastIncidentViewRecord);
    setSosMarkers(lastRawSosItems, lastSosResolve, lastSosAck);
    renderPoiMarkers();
    renderDispatchLinks();
    renderRoute();
    return { ...visibleLayers };
  }

  function getLayerVisibility() {
    return { ...visibleLayers };
  }

  function setRoute(geojson) {
    lastRouteGeojson = geojson;
    if (!ready) {
      pendingRoute.value = geojson;
      return;
    }
    renderRoute();
  }

  const offTheme = onThemeChange(container, () => {
    if (!destroyed && ready) applyThemeColors(map);
  });

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    offTheme();
    clearTimeout(reclusterHandle);
    clearTimeout(focusTimeoutHandle);
    clearTimeout(incidentFocusTimeoutHandle);
    clearMarkers(tanodMarkers);
    tanodMarkersById.clear();
    clearMarkers(sosMarkers);
    sosMarkersById.clear();
    clearMarkers(incidentMarkers);
    incidentMarkersById.clear();
    clearMarkers(dispatchLinkEtaMarkers);
    clearMarkers(poiMarkers);
    applyDispatchLinks(map, []);
    applyRoute(map, null);
    detachBasemapFallback();
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

    const isDispatched = raw.status === 'dispatched' || raw.isDispatched;
    if (isDispatched && !visibleLayers.dispatched) {
      visibleLayers.dispatched = true;
    }
    if (!isDispatched && !visibleLayers.available) {
      visibleLayers.available = true;
    }

    const targetZoom = Math.max(map.getZoom(), zoom);
    map.flyTo({ center: [Number(raw.longitude), Number(raw.latitude)], zoom: targetZoom, duration: 600 });

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
    const approx = lastRawSosItems.find((s) => s.sosId === sosId)?.locationSource === 'last_known';
    const targetZoom = Math.max(map.getZoom(), approx ? Math.min(zoom, 15) : zoom);
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
    const raw = lastRawIncidents.find((i) => i.incidentId === incidentId);
    if (!raw || raw.latitude == null || raw.longitude == null) return false;

    activeFocusedIncidentId = incidentId;
    activePopupIncidentId = incidentId;
    const targetZoom = Math.max(map.getZoom(), zoom);
    map.flyTo({ center: [Number(raw.longitude), Number(raw.latitude)], zoom: targetZoom, duration: 600 });

    renderIncidentMarkers(lastRawIncidents, lastIncidentAssign, lastIncidentViewRecord);
    applyIncidentFocus(incidentId);
    return true;
  }

  function previewIncident(incidentId, active = true) {
    if (destroyed) return;
    const marker = incidentMarkersById.get(incidentId);
    if (marker?.el) {
      if (active) {
        marker.el.classList.add('live-map__marker--focused');
      } else if (activeFocusedIncidentId !== incidentId) {
        marker.el.classList.remove('live-map__marker--focused');
      }
    }
  }

  function setIncidentFilter(filter = {}) {
    if ('query' in filter) incidentFilterQuery = String(filter.query || '').trim();
    if ('priority' in filter) incidentFilterPriority = filter.priority || 'all';
    if ('status' in filter) incidentFilterStatus = filter.status || 'all';
    renderIncidentMarkers(lastRawIncidents, lastIncidentAssign, lastIncidentViewRecord);
  }

  function toggleLabelMode() {
    if (labelMode === 'auto') labelMode = 'always';
    else if (labelMode === 'always') labelMode = 'hover';
    else labelMode = 'auto';
    updateLabelDensity();
    return labelMode;
  }

  function getLabelMode() {
    return labelMode;
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
      map.fitBounds(bounds, {
        padding: { top: 60, bottom: 95, left: 70, right: 60 },
        maxZoom: 16,
        duration: 600,
      });
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

  function manilaClock(value) {
    const d = value ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Manila' });
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
    setIncidentFilter,
    toggleLabelMode,
    getLabelMode,
    previewIncident,
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

export function applyThemeColors(map) {
  const set = (layer, prop, value) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  };
  set('background', 'background-color', themeToken('--color-surface-blue', '#E0F2FE'));
  set('barangay-boundary-fill', 'fill-color', themeToken('--color-accent', '#3B82F6'));
  set('barangay-boundary-line', 'line-color', themeToken('--color-primary', '#1D4ED8'));
  set('dispatch-links-layer', 'line-color', themeToken('--color-primary', '#2563EB'));
  set('dispatch-route-line', 'line-color', themeToken('--color-primary', '#1D4ED8'));
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
    paint: { 'fill-color': themeToken('--color-accent', '#3B82F6'), 'fill-opacity': 0.06 },
  });
  map.addLayer({
    id: 'barangay-boundary-line',
    type: 'line',
    source: 'barangay-boundary',
    paint: {
      'line-color': themeToken('--color-primary', '#1D4ED8'),
      'line-width': 2.5,
      'line-dasharray': [4, 2],
      'line-opacity': 0.8,
    },
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
      'line-opacity': 0.85,
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
      'osm-raster': {
        type: 'raster',
        tiles: [OSM_TILE_URL],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      },
    },
    layers: [
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
