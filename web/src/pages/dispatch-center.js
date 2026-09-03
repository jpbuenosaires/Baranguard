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
 * 2026-09-02: migrated both queue lists (Pending Incidents, Active
 * Dispatches) from stacked cards to the shared `DataTable` component —
 * each row's own inline Tanod-picker/Assign or Cancel action now lives
 * in a `data-table__actions` cell instead of a card footer. Priority is
 * now conveyed by the dedicated Priority column's pill color, which
 * replaces the old card-level `dispatch-card--critical`/`--high`
 * left-dot accent (the same signal, in a real column instead of a
 * decorative pseudo-element — nothing lost, just relocated).
 *
 * kebab-case filename per §4.
 */

import {
  getIncidents, getDispatches, getDutyStatus, getUsers, getGpsLive, getTanodSos,
  createDispatch, cancelDispatch, logout, ApiClientError,
} from '../api/apiClient.js';
import { LiveMap } from '../components/LiveMap.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatStrip } from '../components/StatStrip.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';

const ACTIVE_DISPATCH_STATUSES = ['assigned', 'en_route', 'arrived'];
const PRIORITY_LABELS = { normal: 'Normal', high: 'High', critical: 'Critical' };
const PRIORITY_PILL_CLASS = { normal: 'status-pill--neutral', high: 'status-pill--pending', critical: 'status-pill--critical' };
const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};

// §3.3: column sorting wired here as the concrete first example — see
// DataTable.js's own doc comment for why sortValue is required per column
// rather than defaulted from the row.
const PRIORITY_RANK = { normal: 0, high: 1, critical: 2 };
const PENDING_COLUMNS = [
  { key: 'type', label: 'Type', sortable: true, sortValue: (i) => INCIDENT_TYPE_LABELS[i.incidentType] || i.incidentType },
  { key: 'priority', label: 'Priority', sortable: true, sortValue: (i) => PRIORITY_RANK[i.priority] ?? -1 },
  { key: 'reported', label: 'Reported', sortable: true, sortValue: (i) => i.createdAt },
  { key: 'assign', label: 'Assign', align: 'right' },
];
const ACTIVE_COLUMNS = [
  { key: 'dispatch', label: 'Dispatch', sortable: true, sortValue: (d) => d.dispatchedAt },
  { key: 'tanod', label: 'Tanod', sortable: true, sortValue: (d) => d.tanodId },
  { key: 'status', label: 'Status', sortable: true, sortValue: (d) => d.status },
  { key: 'actions', label: 'Actions', align: 'right' },
];

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
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({ title: 'Dispatch Center', subtitle: 'Assign on-duty Tanods and track active responses', icon: icons.radio });
  header.appendChild(pageHeader.el);

  const wrapper = document.createElement('div');
  wrapper.className = 'flex-col grow';
  content.appendChild(wrapper);
  const body = document.createElement('div');
  body.className = 'grow';
  wrapper.appendChild(body);

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
    container.className = 'grow flex-col';

    const criticalCount = pendingIncidents.filter((i) => i.priority === 'critical').length;
    pageHeader.actions.innerHTML = '';
    pageHeader.actions.appendChild(StatStrip({
      items: [
        { label: 'Pending', value: pendingIncidents.length },
        { label: 'Active', value: activeDispatches.length, tone: 'info' },
        { label: 'Critical', value: criticalCount, tone: criticalCount > 0 ? 'critical' : 'default' },
        { label: 'SOS', value: openSos.length, tone: openSos.length > 0 ? 'critical' : 'default' },
      ],
    }));

    if (openSos.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'sos-banner';
      const bannerText = openSos.length === 1
        ? '1 Tanod SOS requires attention.'
        : `${openSos.length} Tanod SOS alerts require attention.`;
      banner.innerHTML = `${icons.alertTriangle(20)}<span>${bannerText}</span>`;
      container.appendChild(banner);
    }

    const layout = document.createElement('div');
    layout.className = 'dispatch-layout grow';

    const queue = document.createElement('div');
    queue.className = 'dispatch-queue';

    const pendingTitle = document.createElement('h3');
    pendingTitle.className = 'dispatch-queue__section-title';
    pendingTitle.textContent = `Pending Incidents (${pendingIncidents.length})`;
    queue.appendChild(pendingTitle);

    if (pendingIncidents.length === 0) {
      queue.appendChild(emptyNote('No pending incidents right now.'));
    } else {
      queue.appendChild(renderPendingIncidentsTable(pendingIncidents, eligibleTanods, () => load()));
    }

    const activeTitle = document.createElement('h3');
    activeTitle.className = 'dispatch-queue__section-title';
    activeTitle.style.marginTop = '24px';
    activeTitle.textContent = `Active Dispatches (${activeDispatches.length})`;
    queue.appendChild(activeTitle);

    if (activeDispatches.length === 0) {
      queue.appendChild(emptyNote('No active dispatches right now.'));
    } else {
      queue.appendChild(renderActiveDispatchesTable(activeDispatches, () => load()));
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

function renderPendingIncidentsTable(incidents, eligibleTanods, onChanged) {
  return DataTable({
    columns: PENDING_COLUMNS,
    rows: incidents,
    rowKey: (row) => row.incidentId,
    caption: 'Pending incidents',
    renderCell: (incident, key) => {
      switch (key) {
        case 'type':
          return INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;
        case 'priority': {
          const span = document.createElement('span');
          span.className = `status-pill ${PRIORITY_PILL_CLASS[incident.priority] || 'status-pill--neutral'}`;
          span.textContent = PRIORITY_LABELS[incident.priority] || incident.priority;
          return span;
        }
        case 'reported':
          return `#${incident.incidentId} · ${new Date(incident.createdAt).toLocaleString()}`;
        case 'assign':
          return renderAssignCell(incident, eligibleTanods, onChanged);
        default:
          return '';
      }
    },
  });
}

function renderAssignCell(incident, eligibleTanods, onChanged) {
  const wrap = document.createElement('span');
  wrap.className = 'data-table__actions';

  if (eligibleTanods.length === 0) {
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = 'No on-duty Tanods available';
    wrap.appendChild(note);
    return wrap;
  }

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
  assignButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    assignButton.disabled = true;
    assignButton.textContent = 'Assigning…';
    try {
      await createDispatch({
        incidentId: incident.incidentId,
        tanodId: Number(select.value),
        requestId: crypto.randomUUID(),
      });
      const tanodName = select.options[select.selectedIndex]?.textContent || 'Tanod';
      showToast(`Dispatch assigned to ${tanodName}`, { variant: 'success' });
      onChanged();
    } catch (err) {
      assignButton.disabled = false;
      assignButton.textContent = 'Assign';
      const message = err instanceof ApiClientError ? err.message : 'Could not create the dispatch.';
      showToast(message, { variant: 'error' });
    }
  });
  wrap.append(select, assignButton);
  return wrap;
}

function renderActiveDispatchesTable(dispatches, onChanged) {
  return DataTable({
    columns: ACTIVE_COLUMNS,
    rows: dispatches,
    rowKey: (row) => row.dispatchId,
    caption: 'Active dispatches',
    renderCell: (dispatch, key) => {
      switch (key) {
        case 'dispatch': {
          const wrap = document.createElement('div');
          const main = document.createElement('div');
          main.textContent = `#${dispatch.dispatchId} · Incident #${dispatch.incidentId}`;
          const sub = document.createElement('div');
          sub.className = 'data-table__sub';
          sub.textContent = `Since ${new Date(dispatch.dispatchedAt).toLocaleString()}`
            + (dispatch.routeStatus === 'unavailable' ? ' · Route unavailable' : '');
          wrap.append(main, sub);
          return wrap;
        }
        case 'tanod':
          return `Tanod #${dispatch.tanodId}`;
        case 'status': {
          const span = document.createElement('span');
          span.className = 'status-pill status-pill--info';
          span.textContent = dispatch.status.replace('_', ' ');
          return span;
        }
        case 'actions':
          return renderCancelCell(dispatch, onChanged);
        default:
          return '';
      }
    },
  });
}

function renderCancelCell(dispatch, onChanged) {
  const wrap = document.createElement('span');
  wrap.className = 'data-table__actions';
  const cancelButton = document.createElement('button');
  cancelButton.className = 'danger';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    // Same guarantee window.confirm() gave (an explicit yes/no awaited
    // before proceeding), via the app's own ConfirmDialog component (§3.2).
    const confirmed = await confirmDialog({
      title: `Cancel dispatch #${dispatch.dispatchId}?`,
      description: 'The incident will return to the pending queue.',
      confirmLabel: 'Cancel dispatch',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!confirmed) return;
    cancelButton.disabled = true;
    cancelButton.textContent = 'Cancelling…';
    try {
      await cancelDispatch(dispatch.dispatchId);
      showToast(`Dispatch #${dispatch.dispatchId} cancelled`, { variant: 'info' });
      onChanged();
    } catch (err) {
      cancelButton.disabled = false;
      cancelButton.textContent = 'Cancel';
      const message = err instanceof ApiClientError ? err.message : 'Could not cancel the dispatch.';
      showToast(message, { variant: 'error' });
    }
  });
  wrap.appendChild(cancelButton);
  return wrap;
}

function emptyNote(text) {
  const note = document.createElement('p');
  note.className = 'note';
  note.style.padding = 'var(--spacing-sm) 0';
  note.textContent = text;
  return note;
}

function renderLoading(container) {
  container.innerHTML = '';
  const layout = document.createElement('div');
  layout.className = 'dispatch-layout';
  layout.setAttribute('role', 'status');
  layout.setAttribute('aria-label', 'Loading dispatch center');
  const queue = document.createElement('div');
  queue.className = 'dispatch-queue';
  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.style.cssText = 'height:2.75rem; border-radius:0.5rem;';
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
  block.setAttribute('role', 'alert');
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}
