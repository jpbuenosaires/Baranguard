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
  createDispatch, cancelDispatch, acknowledgeTanodSos, logout, ApiClientError,
} from '../api/apiClient.js';
import { LiveMap } from '../components/LiveMap.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatStrip } from '../components/StatStrip.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog, promptSelect } from '../components/ConfirmDialog.js';

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
  // audit W3: the ID used to be folded into the "Reported" cell as
  // "#12 · 9/3/2026, 4:13:43 PM", so the one value dispatchers say aloud
  // on the radio couldn't be scanned down a column. It gets its own.
  { key: 'id', label: 'ID', width: '4.5rem', sortable: true, sortValue: (i) => i.incidentId },
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
    stopPolling();
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({ title: 'Dispatch Center', subtitle: 'Assign on-duty Tanods and track active responses', icon: icons.radio });
  header.appendChild(pageHeader.el);

  const wrapper = document.createElement('div');
  wrapper.className = 'flex-col';
  content.appendChild(wrapper);
  const body = document.createElement('div');
  body.className = '';
  wrapper.appendChild(body);

  let liveMap = null;
  let mapPane = null;
  let pollTimer = null;

  // audit W3 (blocking): this screen used to load once and then only on an
  // assign/cancel. A new incident — or a new Tanod SOS — never reached the
  // dispatcher until they happened to act or navigate away and back. The
  // one screen whose entire job is watching the queue was the only
  // operational screen not refreshing itself.
  // Cadence matches GIS Live Tracking's existing 15s, and follows the same
  // contract: a background poll that fails must not blank a queue that is
  // already on screen.
  const POLL_INTERVAL_MS = 15000;

  const freshness = document.createElement('span');
  freshness.className = 'note dashboard-freshness';
  freshness.setAttribute('role', 'status');

  load(true);
  pollTimer = setInterval(() => load(false), POLL_INTERVAL_MS);

  // audit A16: assigning or cancelling changes the pending count the
  // sidebar badges, which would otherwise stay wrong for up to a minute.
  const onQueueChanged = () => { load(false); shell.refreshNavCounts?.(); };

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (liveMap) liveMap.destroy();
    liveMap = null;
  }

  async function load(showLoadingState) {
    if (showLoadingState) renderLoading(body);
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

      // Names for the SOS banner come from the tanod list this page
      // already fetches — GET /tanod-sos returns user_id only, and
      // resolving it client-side avoids adding a field to that endpoint
      // for one label (the same join admin-dashboard.js already does for
      // its duty roster).
      const tanodNames = new Map(usersRes.items.map((u) => [u.userId, u.fullName]));

      renderPopulated(body, {
        pendingIncidents: incidentsRes.items,
        activeDispatches,
        eligibleTanods,
        openSos: openSos.map((s) => ({ ...s, fullName: tanodNames.get(s.userId) })),
        gpsItems,
        tanodNames,
      });
      freshness.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch (err) {
      // A failed BACKGROUND poll leaves the queue that is already on
      // screen alone — replacing a working queue with an error block
      // because one refresh missed would be worse than showing data 15
      // seconds stale, and the timestamp above stops updating, which is
      // the honest signal that something is wrong.
      if (!showLoadingState) return;
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the Dispatch Center.';
      renderError(body, message, () => load(true));
    }
  }

  function renderPopulated(container, { pendingIncidents, activeDispatches, eligibleTanods, openSos, gpsItems, tanodNames }) {
    container.innerHTML = '';
    container.className = '';

    const criticalCount = pendingIncidents.filter((i) => i.priority === 'critical').length;
    // This wipes the actions slot on every render, so the freshness stamp
    // must be re-attached HERE rather than once at construction —
    // otherwise the first render silently removes it.
    pageHeader.actions.innerHTML = '';
    pageHeader.actions.appendChild(freshness);
    pageHeader.actions.appendChild(StatStrip({
      items: [
        { label: 'Pending', value: pendingIncidents.length },
        { label: 'Active', value: activeDispatches.length, tone: 'info' },
        { label: 'Critical', value: criticalCount, tone: criticalCount > 0 ? 'critical' : 'default' },
        { label: 'SOS', value: openSos.length, tone: openSos.length > 0 ? 'critical' : 'default' },
      ],
    }));

    if (openSos.length > 0) {
      // audit W3: the banner reported a count and nothing else — not which
      // Tanod, not where, and no acknowledge control, although
      // POST /tanod-sos/:id/acknowledge has existed since Sprint 4. It
      // also had no role=alert, so it appeared silently for a
      // screen-reader user.
      const banner = document.createElement('div');
      banner.className = 'sos-banner';
      banner.setAttribute('role', 'alert');

      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = icons.alertTriangle(20);

      const text = document.createElement('div');
      text.className = 'sos-banner__text';
      const headline = document.createElement('div');
      headline.textContent = openSos.length === 1
        ? '1 Tanod SOS requires attention.'
        : `${openSos.length} Tanod SOS alerts require attention.`;
      const names = document.createElement('div');
      names.className = 'sos-banner__list';
      names.textContent = openSos
        .map((s) => `${s.fullName ?? `Tanod #${s.userId}`}${s.status === 'acknowledged' ? ' (acknowledged)' : ''}`)
        .join(' · ');
      text.append(headline, names);
      banner.append(icon, text);

      // Centring the map on the alert is the dispatcher's actual first
      // move, and it needs no new endpoint — the coordinates are already
      // in the SOS rows this page fetched.
      const located = openSos.filter((s) => s.latitude != null && s.longitude != null);
      if (located.length > 0) {
        const showButton = document.createElement('button');
        showButton.type = 'button';
        showButton.textContent = 'Show on map';
        // `liveMap` is resolved at CLICK time, not here: the banner is
        // built before the map pane further down this same function, so
        // testing it now would drop the button on every first render.
        showButton.addEventListener('click', () => {
          liveMap?.flyTo(Number(located[0].latitude), Number(located[0].longitude));
        });
        banner.appendChild(showButton);
      }

      const unacknowledged = openSos.filter((s) => s.status !== 'acknowledged');
      if (unacknowledged.length > 0) {
        const ackButton = document.createElement('button');
        ackButton.type = 'button';
        ackButton.textContent = unacknowledged.length === 1 ? 'Acknowledge' : `Acknowledge all (${unacknowledged.length})`;
        ackButton.addEventListener('click', async () => {
          ackButton.disabled = true;
          ackButton.textContent = 'Acknowledging…';
          try {
            await Promise.all(unacknowledged.map((s) => acknowledgeTanodSos(s.sosId)));
            showToast('SOS acknowledged. The alert stays visible until it is resolved.', { variant: 'success' });
            load(false);
          } catch (err) {
            ackButton.disabled = false;
            ackButton.textContent = 'Acknowledge';
            showToast(err instanceof ApiClientError ? err.message : 'Could not acknowledge the SOS.', { variant: 'error' });
          }
        });
        banner.appendChild(ackButton);
      }

      container.appendChild(banner);
    }

    const layout = document.createElement('div');
    layout.className = 'dispatch-layout';

    const queue = document.createElement('div');
    queue.className = 'dispatch-queue';

    const pendingTitle = document.createElement('h3');
    pendingTitle.className = 'dispatch-queue__section-title';
    pendingTitle.textContent = `Pending Incidents (${pendingIncidents.length})`;
    queue.appendChild(pendingTitle);

    if (pendingIncidents.length === 0) {
      queue.appendChild(emptyNote('No pending incidents right now.'));
    } else {
      queue.appendChild(renderPendingIncidentsTable(pendingIncidents, eligibleTanods, onQueueChanged));
    }

    const activeTitle = document.createElement('h3');
    activeTitle.className = 'dispatch-queue__section-title dispatch-queue__section-title--spaced';
      activeTitle.textContent = `Active Dispatches (${activeDispatches.length})`;
    queue.appendChild(activeTitle);

    if (activeDispatches.length === 0) {
      queue.appendChild(emptyNote('No active dispatches right now.'));
    } else {
      queue.appendChild(renderActiveDispatchesTable(activeDispatches, onQueueChanged));
    }

    // audit W3: the map used to be destroyed and rebuilt on every reload,
    // so any pan or zoom the dispatcher had set up was thrown away on
    // every assign, every cancel — and now, every 15-second poll, which
    // would have made the screen unusable. The pane element is created
    // once and re-attached; only the markers are updated.
    if (!mapPane) {
      mapPane = document.createElement('div');
      mapPane.className = 'dispatch-map-pane';
    }
    layout.append(queue, mapPane);
    container.appendChild(layout);

    if (!liveMap) liveMap = LiveMap(mapPane);
    liveMap.setMarkers(gpsItems.map((g) => ({
      userId: g.userId, fullName: g.fullName, latitude: g.latitude, longitude: g.longitude,
      ageSeconds: g.ageSeconds, isStale: g.isStale,
    })));
    liveMap.setSosMarkers(openSos.map((s) => ({ sosId: s.sosId, latitude: s.latitude, longitude: s.longitude, status: s.status })));
  }

  // Same contract as W4/W8: main.js calls this before rendering the next
  // page, so the poll and the map never outlive the screen that owns them.
  return { stop: stopPolling };
}

function renderPendingIncidentsTable(incidents, eligibleTanods, onChanged) {
  // audit W3: the queue arrived newest-first, so a critical incident could
  // sit below routine ones and was distinguishable only by a pill colour.
  // Triage order is the queue's whole purpose: critical first, then by
  // age within a priority (oldest first — the one waiting longest goes
  // out next).
  const triaged = [...incidents].sort((a, b) => {
    const byPriority = (PRIORITY_RANK[b.priority] ?? -1) - (PRIORITY_RANK[a.priority] ?? -1);
    if (byPriority !== 0) return byPriority;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
  return DataTable({
    columns: PENDING_COLUMNS,
    rows: triaged,
    rowKey: (row) => row.incidentId,
    caption: 'Pending incidents',
    renderCell: (incident, key) => {
      switch (key) {
        case 'id':
          return `#${incident.incidentId}`;
        case 'type':
          return INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;
        case 'priority': {
          const span = document.createElement('span');
          span.className = `status-pill ${PRIORITY_PILL_CLASS[incident.priority] || 'status-pill--neutral'}`;
          span.textContent = PRIORITY_LABELS[incident.priority] || incident.priority;
          return span;
        }
        case 'reported':
          return new Date(incident.createdAt).toLocaleString();
        case 'assign':
          return renderAssignCell(incident, eligibleTanods, onChanged);
        default:
          return '';
      }
    },
  });
}

/**
 * The Tanod picker used to live INSIDE this cell as a full-width <select>
 * of every eligible Tanod's full name, plus a button, in every row — about
 * 300px of intrinsic width per row inside a 420px column. That is what
 * forced the queue table into permanent horizontal scroll (audit Phase 1).
 * The row now carries one compact button and the choice happens in a
 * dialog, so the table fits its column at every desktop width.
 */
function renderAssignCell(incident, eligibleTanods, onChanged) {
  const wrap = document.createElement('span');
  wrap.className = 'data-table__actions';

  if (eligibleTanods.length === 0) {
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = 'None on duty';
    note.title = 'No on-duty Tanods are available to assign right now.';
    wrap.appendChild(note);
    return wrap;
  }

  const assignButton = document.createElement('button');
  assignButton.className = 'primary dispatch-assign-button';
  assignButton.type = 'button';
  assignButton.textContent = 'Assign';
  assignButton.addEventListener('click', async (event) => {
    event.stopPropagation();

    const typeLabel = INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;
    const tanodId = await promptSelect({
      title: `Assign incident #${incident.incidentId}`,
      description: `${typeLabel} · ${PRIORITY_LABELS[incident.priority] || incident.priority} priority. The assigned Tanod is notified immediately.`,
      label: 'On-duty Tanod',
      options: eligibleTanods.map((t) => ({ value: t.userId, label: t.fullName })),
      confirmLabel: 'Assign',
    });
    if (tanodId === null) return;

    assignButton.disabled = true;
    assignButton.textContent = 'Assigning…';
    try {
      await createDispatch({
        incidentId: incident.incidentId,
        tanodId: Number(tanodId),
        requestId: crypto.randomUUID(),
      });
      const tanodName = eligibleTanods.find((t) => String(t.userId) === String(tanodId))?.fullName || 'Tanod';
      showToast(`Dispatch assigned to ${tanodName}`, { variant: 'success' });
      onChanged();
    } catch (err) {
      assignButton.disabled = false;
      assignButton.textContent = 'Assign';
      const message = err instanceof ApiClientError ? err.message : 'Could not create the dispatch.';
      showToast(message, { variant: 'error' });
    }
  });
  wrap.appendChild(assignButton);
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
    skeleton.className = 'skeleton skeleton--row';
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
