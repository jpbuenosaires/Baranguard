/** Marker (pin) helpers for LiveMapCanvas: shells, in-place sync, label thinning. */
import { Marker, type Map as MaplibreMap } from 'maplibre-gl';
import type { NearbyIncident, NearbyTanod } from '../../services/apiService';
import { incidentAriaLabel, pinLabel, shortPersonLabel, tanodAriaLabel, tanodInitials } from '../../utils/liveMapPolicy';
import { thinLabels, type LabelCandidate } from '../../utils/liveMapHud';
import type { FocusTarget } from './mapBasemap';

export function priorityMarkerClass(priority: string): string {
  if (priority === 'critical') return 'map-marker map-marker--critical';
  if (priority === 'high') return 'map-marker map-marker--high';
  return 'map-marker map-marker--normal';
}

/** One reusable MapLibre marker plus the DOM bits updated in place on each poll. */
export interface PinEntry<T> {
  marker: Marker;
  container: HTMLDivElement;
  el: HTMLDivElement;
  label: HTMLSpanElement;
  item: T;
}

export function createPinShell(iconSvg: string): { container: HTMLDivElement; el: HTMLDivElement; label: HTMLSpanElement } {
  const container = document.createElement('div');
  container.className = 'lm-pin-hit';
  container.tabIndex = 0;
  container.setAttribute('role', 'button');
  const el = document.createElement('div');
  el.innerHTML = iconSvg;
  const label = document.createElement('span');
  label.className = 'live-map__pin-label lm-pin-label--off';
  el.appendChild(label);
  container.appendChild(el);
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      container.click();
    }
  });
  return { container, el, label };
}

export const INCIDENT_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>';
export const TANOD_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

/** Incident markers are created once and updated in place on every poll; only ids that disappeared are removed. */
export function syncIncidentPins(
  map: MaplibreMap,
  pins: Map<number, PinEntry<NearbyIncident>>,
  incidents: NearbyIncident[],
  opts: {
    focusTarget?: FocusTarget | null;
    selectedIncidentId?: number | null;
    dataStale?: boolean;
    onSelect: () => ((incident: NearbyIncident) => void) | undefined;
  }
): void {
  const { focusTarget, selectedIncidentId, dataStale } = opts;
  const seen = new Set<number>();

  for (const incident of incidents) {
    if (typeof incident.longitude !== 'number' || typeof incident.latitude !== 'number' || isNaN(incident.longitude) || isNaN(incident.latitude)) continue;
    const id = incident.incidentId;
    seen.add(id);

    const isDestination =
      !!focusTarget &&
      Math.abs(incident.latitude - focusTarget.latitude) < 0.00005 &&
      Math.abs(incident.longitude - focusTarget.longitude) < 0.00005;
    const isCritical = incident.priority === 'critical';
    const isSelected = selectedIncidentId === id;

    let pin = pins.get(id);
    if (!pin) {
      const shell = createPinShell(INCIDENT_ICON);
      const created: PinEntry<NearbyIncident> = {
        ...shell,
        item: incident,
        marker: new Marker({ element: shell.container }).setLngLat([incident.longitude, incident.latitude]).addTo(map),
      };
      shell.container.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onSelect()?.(created.item);
      });
      pins.set(id, created);
      pin = created;
    }
    pin.item = incident;
    pin.marker.setLngLat([incident.longitude, incident.latitude]);

    const cls = isDestination
      ? `map-marker map-marker--destination ${priorityMarkerClass(incident.priority)}`
      : `map-marker map-marker--incident ${isCritical ? 'map-marker--incident-critical' : ''} ${isSelected ? 'map-marker--focused' : ''}`;
    if (pin.el.className !== cls) pin.el.className = cls;
    pin.label.classList.add('live-map__pin-label--incident');
    pin.label.classList.toggle('live-map__pin-label--critical', isCritical);
    pin.container.classList.toggle('lm-pin--data-stale', !!dataStale);
    pin.el.title = `${incident.incidentType.replace(/_/g, ' ')} · ${incident.priority} · ${Math.floor(incident.ageSeconds / 60)}m ago`;
    pin.container.setAttribute(
      'aria-label',
      id < 0 ? 'Picked location' : incidentAriaLabel({ incidentId: id, priority: incident.priority, status: incident.status })
    );
  }

  pins.forEach((pin, id) => {
    if (!seen.has(id)) {
      pin.marker.remove();
      pins.delete(id);
    }
  });
}

/** Tanod markers: same reuse rule as incidents. */
export function syncTanodPins(
  map: MaplibreMap,
  pins: Map<number, PinEntry<NearbyTanod>>,
  tanods: NearbyTanod[],
  opts: {
    selectedTanodId?: number | null;
    dataStale?: boolean;
    onSelect: () => ((tanod: NearbyTanod) => void) | undefined;
  }
): void {
  const { selectedTanodId, dataStale } = opts;
  const seen = new Set<number>();

  for (const tanod of tanods) {
    if (typeof tanod.longitude !== 'number' || typeof tanod.latitude !== 'number' || isNaN(tanod.longitude) || isNaN(tanod.latitude)) continue;
    const id = tanod.userId;
    seen.add(id);
    const isSelected = selectedTanodId === id;
    const isDispatched = tanod.dispatchId !== null;

    let pin = pins.get(id);
    if (!pin) {
      const shell = createPinShell(TANOD_ICON);
      const created: PinEntry<NearbyTanod> = {
        ...shell,
        item: tanod,
        marker: new Marker({ element: shell.container }).setLngLat([tanod.longitude, tanod.latitude]).addTo(map),
      };
      shell.container.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onSelect()?.(created.item);
      });
      pins.set(id, created);
      pin = created;
    }
    pin.item = tanod;
    pin.marker.setLngLat([tanod.longitude, tanod.latitude]);

    const cls = `map-marker ${tanod.isStale ? 'map-marker--tanod-stale' : isDispatched ? 'map-marker--tanod-dispatched' : 'map-marker--tanod-live'} ${isSelected ? 'map-marker--focused' : ''}`;
    if (pin.el.className !== cls) pin.el.className = cls;
    pin.container.classList.toggle('lm-pin--data-stale', !!dataStale);
    pin.el.title = `${tanod.fullName} — ${tanod.isStale ? 'stale' : 'live'} · ${Math.floor(tanod.ageSeconds / 60)}m ago`;
    pin.container.setAttribute(
      'aria-label',
      tanodAriaLabel({ fullName: tanod.fullName, isStale: tanod.isStale, dispatchId: tanod.dispatchId, ageSeconds: tanod.ageSeconds })
    );
  }

  pins.forEach((pin, id) => {
    if (!seen.has(id)) {
      pin.marker.remove();
      pins.delete(id);
    }
  });
}

/** Which markers show text at this zoom, thinned by overlap. Selected, destination and the user's own marker are always labelled. */
export function applyPinLabels(
  map: MaplibreMap,
  ctx: {
    selfMarker: Marker | null;
    selfLabel: HTMLSpanElement | null;
    incidentPins: Map<number, PinEntry<NearbyIncident>>;
    tanodPins: Map<number, PinEntry<NearbyTanod>>;
    selected: { incident: number | null; tanod: number | null };
    focusTarget: FocusTarget | null | undefined;
  }
): void {
  const zoom = map.getZoom();
  const candidates: LabelCandidate[] = [];
  const apply: Array<{ id: string; label: HTMLSpanElement; text: string }> = [];
  const sel = ctx.selected;
  const ft = ctx.focusTarget;
  if (ctx.selfMarker && ctx.selfLabel) {
    const p = map.project(ctx.selfMarker.getLngLat());
    candidates.push({ id: 'self', x: p.x, y: p.y, text: 'You', always: true });
    apply.push({ id: 'self', label: ctx.selfLabel, text: 'You' });
  }
  ctx.incidentPins.forEach((pin, id) => {
    const inc = pin.item;
    const isDestination = !!ft && Math.abs(inc.latitude - ft.latitude) < 0.00005 && Math.abs(inc.longitude - ft.longitude) < 0.00005;
    const selected = sel.incident === id;
    const text = id < 0 ? '' : pinLabel({ kind: 'incident', zoom, selected, pinned: isDestination, fullText: `#${id}` }).text;
    const p = map.project([inc.longitude, inc.latitude]);
    candidates.push({ id: `i${id}`, x: p.x, y: p.y, text, always: selected || isDestination, rank: inc.priority === 'critical' ? 1 : 3 });
    apply.push({ id: `i${id}`, label: pin.label, text });
  });
  ctx.tanodPins.forEach((pin, id) => {
    const t = pin.item;
    const selected = sel.tanod === id;
    const text = pinLabel({
      kind: 'tanod',
      zoom,
      selected,
      fullText: shortPersonLabel(t.fullName),
      shortText: tanodInitials(t.fullName),
    }).text;
    const p = map.project([t.longitude, t.latitude]);
    candidates.push({ id: `t${id}`, x: p.x, y: p.y, text, always: selected, rank: t.dispatchId !== null ? 2 : 4 });
    apply.push({ id: `t${id}`, label: pin.label, text });
  });

  const keep = thinLabels(candidates);
  for (const a of apply) {
    const show = a.text !== '' && keep.has(a.id);
    if (a.label.textContent !== a.text) a.label.textContent = a.text;
    a.label.classList.toggle('lm-pin-label--off', !show);
  }
}
