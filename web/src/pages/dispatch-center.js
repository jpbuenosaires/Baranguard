/**
 * dispatch-center.js — W3 Dispatch Center (§9): "Split-pane queue + live
 * map. Queue contains pending incidents and active dispatches. The Tanod
 * picker includes only same-barangay active Tanods who are currently
 * eligible for assignment. Critical incident presentation is driven by
 * the incident/dispatch state and disappears when the item is
 * dispatched/resolved; SOS stays until resolved."
 *
 * This session's W3a (read-only queue + Tanod picker) and W3b
 * (create/cancel actions) together — Admin only per §7 (Punong Barangay
 * gets a read-only dispatch *board*, W3's create/cancel actions are
 * Admin-only, so this page is not offered to PB at all; §9 gives PB no
 * separate W3 variant).
 *
 * kebab-case filename per §4.
 */

import {
  getIncidents, getDispatches, getDutyStatus, getUsers, getGpsLive, getTanodSos,
  createDispatch, cancelDispatch, logout, ApiClientError,
} from '../api/apiClient.js';
import { LiveMap } from '../components/LiveMap.js';
import { AppShell } from '../components/AppShell.js';

const ACTIVE_DISPATCH_STATUSES = ['assigned', 'en_route', 'arrived'];
const PRIORITY_LABELS = { normal: 'Normal', high: 'High', critical: 'Critical' };
const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderDispatchCenterPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'dispatch', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { content } = shell;
  root.appendChild(shell.el);

  content.innerHTML = '<h2 style="margin-bottom:16px;">Dispatch Center</h2>';
  const body = document.createElement('div');
  body.style.cssText = 'height:calc(100% - 40px); min-height:0;';
  content.appendChild(body);

  let liveMap = null;

  load();

  async function load() {
    renderLoading(body);
    try {
      const [incidentsRes, dispatchesRes, dutyStatuses, usersRes, sosItems, gpsItems] = await Promise.all([
        getIncidents({ status: 'pending', limit: 100 }),
        getDispatches({ limit: 100 }),
        getDutyStatus(user.barangayId),
        getUsers({ role: 'tanod', limit: 100 }),
        getTanodSos({}).catch(() => []),
        getGpsLive(user.barangayId).catch(() => []),
      ]);

      const onDutyUserIds = new Set(dutyStatuses.filter((d) => d.status === 'on_duty').map((d) => d.userId));
      const eligibleTanods = usersRes.items.filter((u) => u.isActive && onDutyUserIds.has(u.userId));
      const activeDispatches = dispatchesRes.items.filter((d) => ACTIVE_DISPATCH_STATUSES.includes(d.status));
      // §9: SOS stays visible until resolved, not just while "active".
      const openSos = sosItems.filter((s) => s.status !== 'resolved');

      renderPopulated(body, {
        pendingIncidents: incidentsRes.items,
        activeDispatches,
        eligibleTanods,
        openSos,
        gpsItems,
      });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the Dispatch Center.';
      renderError(body, message, load);
    }
  }

  function renderPopulated(container, { pendingIncidents, activeDispatches, eligibleTanods, openSos, gpsItems }) {
    container.innerHTML = '';

    if (openSos.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'sos-banner';
      banner.textContent = openSos.length === 1
        ? '1 Tanod SOS requires attention.'
        : `${openSos.length} Tanod SOS alerts require attention.`;
      container.appendChild(banner);
    }

    const layout = document.createElement('div');
    layout.className = 'dispatch-layout';
    layout.style.height = openSos.length > 0 ? 'calc(100% - 56px)' : '100%';

    const queue = document.createElement('div');
    queue.className = 'dispatch-queue';

    const pendingTitle = document.createElement('h3');
    pendingTitle.className = 'dispatch-queue__section-title';
    pendingTitle.textContent = `Pending Incidents (${pendingIncidents.length})`;
    queue.appendChild(pendingTitle);

    if (pendingIncidents.length === 0) {
      queue.appendChild(emptyNote('No pending incidents right now.'));
    } else {
      for (const incident of pendingIncidents) {
        queue.appendChild(renderPendingCard(incident, eligibleTanods, () => load()));
      }
    }

    const activeTitle = document.createElement('h3');
    activeTitle.className = 'dispatch-queue__section-title';
    activeTitle.style.marginTop = '24px';
    activeTitle.textContent = `Active Dispatches (${activeDispatches.length})`;
    queue.appendChild(activeTitle);

    if (activeDispatches.length === 0) {
      queue.appendChild(emptyNote('No active dispatches right now.'));
    } else {
      for (const dispatch of activeDispatches) {
        queue.appendChild(renderActiveCard(dispatch, () => load()));
      }
    }

    const mapPane = document.createElement('div');
    mapPane.className = 'dispatch-map-pane';
    layout.append(queue, mapPane);
    container.appendChild(layout);

    if (liveMap) liveMap.destroy();
    liveMap = LiveMap(mapPane);
    liveMap.setMarkers(gpsItems.map((g) => ({
      userId: g.userId, fullName: g.fullName, latitude: g.latitude, longitude: g.longitude,
      ageSeconds: g.ageSeconds, isStale: g.isStale,
    })));
    liveMap.setSosMarkers(openSos.map((s) => ({ sosId: s.sosId, latitude: s.latitude, longitude: s.longitude, status: s.status })));
  }
}

function renderPendingCard(incident, eligibleTanods, onChanged) {
  const card = document.createElement('div');
  card.className = 'dispatch-card' + (incident.priority === 'critical' ? ' dispatch-card--critical' : incident.priority === 'high' ? ' dispatch-card--high' : '');

  const header = document.createElement('div');
  header.className = 'dispatch-card__header';
  header.innerHTML = `<strong>${INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType}</strong>
    <span class="status-pill status-pill--pending">${PRIORITY_LABELS[incident.priority] || incident.priority}</span>`;

  const meta = document.createElement('div');
  meta.className = 'dispatch-card__meta';
  meta.textContent = `Incident #${incident.incidentId} · Reported ${new Date(incident.createdAt).toLocaleString()}`;

  const actions = document.createElement('div');
  actions.className = 'dispatch-card__actions';

  if (eligibleTanods.length === 0) {
    const note = document.createElement('span');
    note.className = 'label';
    note.textContent = 'No on-duty Tanods available';
    actions.appendChild(note);
  } else {
    const select = document.createElement('select');
    select.style.width = 'auto';
    for (const tanod of eligibleTanods) {
      const option = document.createElement('option');
      option.value = String(tanod.userId);
      option.textContent = tanod.fullName;
      select.appendChild(option);
    }
    const assignButton = document.createElement('button');
    assignButton.className = 'primary';
    assignButton.textContent = 'Assign';
    assignButton.addEventListener('click', async () => {
      assignButton.disabled = true;
      assignButton.textContent = 'Assigning…';
      try {
        await createDispatch({
          incidentId: incident.incidentId,
          tanodId: Number(select.value),
          requestId: crypto.randomUUID(),
        });
        onChanged();
      } catch (err) {
        assignButton.disabled = false;
        assignButton.textContent = 'Assign';
        const message = err instanceof ApiClientError ? err.message : 'Could not create the dispatch.';
        alert(message);
      }
    });
    actions.append(select, assignButton);
  }

  card.append(header, meta, actions);
  return card;
}

function renderActiveCard(dispatch, onChanged) {
  const card = document.createElement('div');
  card.className = 'dispatch-card';

  const header = document.createElement('div');
  header.className = 'dispatch-card__header';
  header.innerHTML = `<strong>Dispatch #${dispatch.dispatchId}</strong>
    <span class="status-pill status-pill--info">${dispatch.status.replace('_', ' ')}</span>`;

  const meta = document.createElement('div');
  meta.className = 'dispatch-card__meta';
  meta.textContent = `Incident #${dispatch.incidentId} · Tanod #${dispatch.tanodId} · Since ${new Date(dispatch.dispatchedAt).toLocaleString()}`;
  if (dispatch.routeStatus === 'unavailable') {
    meta.textContent += ' · Route unavailable';
  }

  const actions = document.createElement('div');
  actions.className = 'dispatch-card__actions';
  const cancelButton = document.createElement('button');
  cancelButton.className = 'danger';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', async () => {
    if (!confirm(`Cancel dispatch #${dispatch.dispatchId}? The incident will return to the pending queue.`)) return;
    cancelButton.disabled = true;
    cancelButton.textContent = 'Cancelling…';
    try {
      await cancelDispatch(dispatch.dispatchId);
      onChanged();
    } catch (err) {
      cancelButton.disabled = false;
      cancelButton.textContent = 'Cancel';
      const message = err instanceof ApiClientError ? err.message : 'Could not cancel the dispatch.';
      alert(message);
    }
  });
  actions.appendChild(cancelButton);

  card.append(header, meta, actions);
  return card;
}

function emptyNote(text) {
  const note = document.createElement('p');
  note.className = 'label';
  note.style.cssText = 'text-transform:none; font-weight:400; padding:12px 0;';
  note.textContent = text;
  return note;
}

function renderLoading(container) {
  container.innerHTML = '';
  const layout = document.createElement('div');
  layout.className = 'dispatch-layout';
  const queue = document.createElement('div');
  queue.className = 'dispatch-queue';
  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.style.cssText = 'height:96px; border-radius:12px;';
    queue.appendChild(skeleton);
  }
  const mapSkeleton = document.createElement('div');
  mapSkeleton.className = 'skeleton dispatch-map-pane';
  layout.append(queue, mapSkeleton);
  container.appendChild(layout);
}

function renderError(container, message, onRetry) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block state-block--error';
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}

