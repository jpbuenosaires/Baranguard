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
  cancelDispatch, acknowledgeTanodSos, logout, ApiClientError,
} from '../api/apiClient.js';
import { LiveMap } from '../components/LiveMap.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { promptDispatchTanod } from '../components/DispatchAction.js';
import { escapeHtml } from '../utils/escapeHtml.js';

const ACTIVE_DISPATCH_STATUSES = ['assigned', 'en_route', 'arrived'];

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft Incident',
  physical_injury: 'Physical Injury',
  disturbance: 'Disturbance Emergency',
  domestic_dispute: 'Domestic Dispute',
  vandalism: 'Vandalism Report',
  traffic_incident: 'Traffic Incident',
  fire: 'Fire Emergency',
  medical_emergency: 'Medical Emergency',
  missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint',
  other: 'General Incident',
  sos: 'SOS Emergency',
};

const CATEGORY_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'sos', label: 'SOS' },
  { key: 'fire', label: 'Fire' },
  { key: 'medical', label: 'Medical' },
  { key: 'disturbance', label: 'Disturbance' },
];

function formatElapsed(timestamp) {
  if (!timestamp) return 'Just now';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function formatIncidentCode(incident) {
  if (incident.displayId) return incident.displayId;
  const num = String(incident.incidentId || 0).padStart(3, '0');
  return `INC-${num}`;
}

function getIncidentIcon(type, priority) {
  if (type === 'fire') return icons.flame(16);
  if (type === 'medical_emergency') return icons.activity(16);
  if (priority === 'critical' || type === 'sos') return icons.alertTriangle(16);
  if (type === 'disturbance' || type === 'physical_injury') return icons.alertCircle(16);
  return icons.alertTriangle(16);
}

function getIncidentColorBullet(type, priority, status) {
  if (priority === 'critical' || type === 'sos') return 'queue-bullet--red';
  if (priority === 'high' || type === 'fire' || type === 'medical_emergency') return 'queue-bullet--orange';
  if (status === 'dispatched') return 'queue-bullet--blue';
  return 'queue-bullet--green';
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string, barangayId:number, barangayName?:string}} user
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

  // Lock outer page scrolling so only internal lists/map are scrollable
  content.classList.add('dispatch-page-container');
  if (content.parentElement) {
    content.parentElement.classList.add('page-content--no-scroll');
  }

  // Standard Page Header
  const bName = user.barangayName ? `Brgy. ${user.barangayName}, ` : '';
  const pageHeader = PageHeader({
    title: 'Dispatch Center',
    subtitle: `${bName}Pilar, Sorsogon Emergency Operations`,
    icon: icons.radio,
  });
  header.appendChild(pageHeader.el);

  const wrapper = document.createElement('div');
  wrapper.className = 'dispatch-page-wrapper';
  content.appendChild(wrapper);

  const body = document.createElement('div');
  body.className = 'dispatch-page-body';
  wrapper.appendChild(body);

  let liveMap = null;
  let layoutEl = null;
  let priorityAlertEl = null;
  let alertTextEl = null;
  let alertBtnEl = null;
  let kpiCardEl = null;
  let queueListEl = null;
  let chipsContainerEl = null;
  let mapCardEl = null;
  let mapViewportEl = null;
  let pollTimer = null;

  // Filter state
  let searchQuery = '';
  let activeCategory = 'all';
  let latestData = null;

  const POLL_INTERVAL_MS = 15000;

  load(true);
  pollTimer = setInterval(() => load(false), POLL_INTERVAL_MS);

  const onQueueChanged = () => { load(false); shell.refreshNavCounts?.(); };

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (liveMap) liveMap.destroy();
    liveMap = null;
  }

  async function load(showLoadingState) {
    if (showLoadingState && !layoutEl) renderLoading(body);
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
      const openSos = sosItems.filter((s) => s.status !== 'resolved');
      const tanodNames = new Map(usersRes.items.map((u) => [u.userId, u.fullName]));

      latestData = {
        pendingIncidents: incidentsRes.items,
        activeDispatches,
        eligibleTanods,
        openSos: openSos.map((s) => ({ ...s, fullName: tanodNames.get(s.userId) })),
        gpsItems,
        tanodNames,
      };

      renderPopulated(body, latestData);
    } catch (err) {
      if (!showLoadingState) return;
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the Dispatch Center.';
      renderError(body, message, () => load(true));
    }
  }

  function renderPopulated(container, data) {
    const { pendingIncidents, activeDispatches, eligibleTanods, openSos, gpsItems } = data;

    // Initialize layout skeleton once
    if (!layoutEl) {
      container.innerHTML = '';

      // 1. Top Red Priority Alert Banner
      priorityAlertEl = document.createElement('div');
      priorityAlertEl.className = 'dispatch-priority-alert';
      priorityAlertEl.style.display = 'none';

      const alertLeft = document.createElement('div');
      alertLeft.className = 'dispatch-priority-alert__left';
      alertLeft.innerHTML = icons.alertTriangle(20);
      alertTextEl = document.createElement('span');
      alertLeft.appendChild(alertTextEl);

      alertBtnEl = document.createElement('button');
      alertBtnEl.type = 'button';
      alertBtnEl.className = 'dispatch-priority-alert__btn';
      alertBtnEl.textContent = 'Dispatch Now';

      priorityAlertEl.append(alertLeft, alertBtnEl);
      container.appendChild(priorityAlertEl);

      // 2. 3-KPI Card in PageHeader Actions
      if (!kpiCardEl) {
        kpiCardEl = document.createElement('div');
        kpiCardEl.className = 'dispatch-kpi-card';
        pageHeader.actions.appendChild(kpiCardEl);
      }

      // 3. Main Split Grid (Queue + Live Map)
      layoutEl = document.createElement('div');
      layoutEl.className = 'dispatch-layout';

      // Left Column: Emergency Queue
      const queueCol = document.createElement('div');
      queueCol.className = 'dispatch-queue-column';

      const queueCard = document.createElement('div');
      queueCard.className = 'dispatch-queue-card';

      const queueHeader = document.createElement('div');
      queueHeader.className = 'dispatch-queue-card__header';

      const titleRow = document.createElement('div');
      titleRow.className = 'dispatch-queue-card__title-row';
      const queueTitle = document.createElement('h2');
      queueTitle.className = 'dispatch-queue-card__title';
      queueTitle.textContent = 'Emergency Queue';

      const filterIconBtn = document.createElement('button');
      filterIconBtn.type = 'button';
      filterIconBtn.className = 'dispatch-queue-card__filter-icon';
      filterIconBtn.title = 'Filter queue';
      filterIconBtn.innerHTML = icons.filter(18);

      const searchBox = document.createElement('div');
      searchBox.className = 'dispatch-queue-search-inline';
      searchBox.style.display = 'none';
      const searchInputEl = document.createElement('input');
      searchInputEl.type = 'text';
      searchInputEl.className = 'dispatch-queue-search-inline__input';
      searchInputEl.placeholder = 'Search by ID, type, tanod, or location…';
      searchInputEl.value = searchQuery;
      searchInputEl.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase().trim();
        updateQueueView();
      });
      searchBox.appendChild(searchInputEl);

      filterIconBtn.addEventListener('click', () => {
        const isHidden = searchBox.style.display === 'none';
        searchBox.style.display = isHidden ? 'block' : 'none';
        if (isHidden) searchInputEl.focus();
      });

      titleRow.append(queueTitle, filterIconBtn);

      chipsContainerEl = document.createElement('div');
      chipsContainerEl.className = 'dispatch-filter-chips';

      queueHeader.append(titleRow, searchBox, chipsContainerEl);

      queueListEl = document.createElement('div');
      queueListEl.className = 'dispatch-queue-card__list';

      queueCard.append(queueHeader, queueListEl);

      const newEmergencyBtn = document.createElement('button');
      newEmergencyBtn.type = 'button';
      newEmergencyBtn.className = 'btn-new-emergency';
      newEmergencyBtn.innerHTML = `${icons.bell(18)} <span>New Emergency Report</span>`;
      newEmergencyBtn.addEventListener('click', () => {
        navigate('incidents');
      });

      queueCol.append(queueCard, newEmergencyBtn);

      // Right Column: Live Map Container
      const mapCol = document.createElement('div');
      mapCol.className = 'dispatch-map-column';

      mapCardEl = document.createElement('div');
      mapCardEl.className = 'dispatch-map-container';

      const mapHeader = document.createElement('div');
      mapHeader.className = 'dispatch-map-header';

      const mapTitle = document.createElement('h3');
      mapTitle.className = 'dispatch-map-header__title';
      mapTitle.textContent = `Live Map - ${bName || ''}Pilar, Sorsogon`;

      const mapActions = document.createElement('div');
      mapActions.className = 'dispatch-map-header__actions';

      const recenterBtn = document.createElement('button');
      recenterBtn.type = 'button';
      recenterBtn.className = 'btn-recenter';
      recenterBtn.innerHTML = `${icons.mapPin(14)} <span>Recenter</span>`;
      recenterBtn.addEventListener('click', () => {
        liveMap?.fitAll();
      });

      const fullscreenBtn = document.createElement('button');
      fullscreenBtn.type = 'button';
      fullscreenBtn.className = 'btn-fullscreen';
      fullscreenBtn.innerHTML = `<span>Full Screen</span>`;
      fullscreenBtn.addEventListener('click', () => {
        const isFull = mapCardEl.classList.toggle('is-fullscreen');
        fullscreenBtn.innerHTML = `<span>${isFull ? 'Exit Full Screen' : 'Full Screen'}</span>`;
        liveMap?.resize();
      });

      mapActions.append(recenterBtn, fullscreenBtn);
      mapHeader.append(mapTitle, mapActions);

      mapViewportEl = document.createElement('div');
      mapViewportEl.className = 'dispatch-map-viewport';

      const legendCard = document.createElement('div');
      legendCard.className = 'dispatch-map-legend-card';
      legendCard.innerHTML = `
        <div class="legend-title">Legend</div>
        <div class="legend-item"><span class="legend-dot legend-dot--green"></span> Available Tanod</div>
        <div class="legend-item"><span class="legend-dot legend-dot--blue"></span> Dispatched</div>
        <div class="legend-item"><span class="legend-dot legend-dot--red"></span> Emergency</div>
      `;
      mapViewportEl.appendChild(legendCard);

      mapCardEl.append(mapHeader, mapViewportEl);
      mapCol.appendChild(mapCardEl);

      layoutEl.append(queueCol, mapCol);
      container.appendChild(layoutEl);

      liveMap = LiveMap(mapViewportEl);
    }

    // Update Priority Alert Banner
    const urgentSos = openSos.find((s) => s.status !== 'resolved');
    const urgentCritical = pendingIncidents.find((i) => i.priority === 'critical');

    if (urgentSos) {
      priorityAlertEl.style.display = 'flex';
      const tanodLabel = urgentSos.fullName || `Tanod #${urgentSos.userId}`;
      alertTextEl.textContent = `PRIORITY ALERT: SOS Emergency for ${tanodLabel} - Requires immediate dispatch`;
      alertBtnEl.onclick = () => {
        if (urgentSos.latitude != null && urgentSos.longitude != null) {
          liveMap?.flyTo(Number(urgentSos.latitude), Number(urgentSos.longitude), 18);
        } else {
          liveMap?.fitAll();
        }
      };
    } else if (urgentCritical) {
      priorityAlertEl.style.display = 'flex';
      const typeLabel = INCIDENT_TYPE_LABELS[urgentCritical.incidentType] || urgentCritical.incidentType;
      const locLabel = urgentCritical.locationDescription || urgentCritical.location_description || 'Barangay Area';
      alertTextEl.textContent = `PRIORITY ALERT: ${typeLabel} in ${locLabel} - Requires immediate dispatch`;
      alertBtnEl.onclick = async () => {
        await promptDispatchTanod({ incident: urgentCritical, incidentTypeLabel: typeLabel, eligibleTanods });
        onQueueChanged();
      };
    } else {
      priorityAlertEl.style.display = 'none';
    }

    // Update 3-KPI Card
    kpiCardEl.innerHTML = `
      <div class="dispatch-kpi-col">
        <div class="dispatch-kpi-val dispatch-kpi-val--online">${eligibleTanods.length}</div>
        <div class="dispatch-kpi-label">Online</div>
      </div>
      <div class="dispatch-kpi-col">
        <div class="dispatch-kpi-val dispatch-kpi-val--dispatched">${activeDispatches.length}</div>
        <div class="dispatch-kpi-label">Dispatched</div>
      </div>
      <div class="dispatch-kpi-col">
        <div class="dispatch-kpi-val dispatch-kpi-val--pending">${pendingIncidents.length}</div>
        <div class="dispatch-kpi-label">Pending</div>
      </div>
    `;

    // Update LiveMap Pins
    liveMap.setMarkers(gpsItems.map((g) => ({
      userId: g.userId, fullName: g.fullName, latitude: g.latitude, longitude: g.longitude,
      ageSeconds: g.ageSeconds, isStale: g.isStale,
    })));
    liveMap.setSosMarkers(openSos.map((s) => ({ sosId: s.sosId, latitude: s.latitude, longitude: s.longitude, status: s.status })));
    liveMap.setIncidentMarkers(
      pendingIncidents.map((incident) => ({
        incidentId: incident.incidentId,
        latitude: incident.latitude,
        longitude: incident.longitude,
        incidentType: incident.incidentType,
        typeLabel: INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType,
        priority: incident.priority,
      })),
      eligibleTanods.length === 0 ? undefined : async (incidentId) => {
        const incident = pendingIncidents.find((i) => i.incidentId === incidentId);
        if (!incident) return;
        const typeLabel = INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType;
        const dispatched = await promptDispatchTanod({ incident, incidentTypeLabel: typeLabel, eligibleTanods });
        if (dispatched) onQueueChanged();
      },
    );

    // Update Queue Cards view
    updateQueueView();
  }

  function updateQueueView() {
    if (!latestData || !chipsContainerEl || !queueListEl) return;
    const { pendingIncidents, activeDispatches, eligibleTanods, gpsItems } = latestData;

    // Render filter chips
    chipsContainerEl.innerHTML = '';
    for (const chip of CATEGORY_CHIPS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `filter-chip${activeCategory === chip.key ? ' is-active' : ''}`;
      btn.textContent = chip.label;
      btn.addEventListener('click', () => {
        activeCategory = chip.key;
        updateQueueView();
      });
      chipsContainerEl.appendChild(btn);
    }

    // Normalize and assemble combined queue items
    const items = [
      ...pendingIncidents.map((i) => ({ ...i, itemStatus: 'pending' })),
      ...activeDispatches.map((d) => ({ ...d, itemStatus: 'dispatched' })),
    ];

    // Filter by Category
    const categoryFiltered = items.filter((item) => {
      if (activeCategory === 'all') return true;
      if (activeCategory === 'sos') return item.priority === 'critical' || item.incidentType === 'sos';
      if (activeCategory === 'fire') return item.incidentType === 'fire';
      if (activeCategory === 'medical') return item.incidentType === 'medical_emergency';
      if (activeCategory === 'disturbance') return item.incidentType === 'disturbance';
      return true;
    });

    // Filter by Search Query
    const searchFiltered = categoryFiltered.filter((item) => {
      if (!searchQuery) return true;
      const idStr = String(item.displayId || item.incidentId || item.dispatchId || '').toLowerCase();
      const typeStr = (INCIDENT_TYPE_LABELS[item.incidentType] || item.incidentType || '').toLowerCase();
      const locStr = (item.locationDescription || item.location_description || '').toLowerCase();
      const tanodStr = (item.tanodName || '').toLowerCase();
      return idStr.includes(searchQuery) || typeStr.includes(searchQuery) || locStr.includes(searchQuery) || tanodStr.includes(searchQuery);
    });

    // Sort: Pending first (critical > high > normal), then Dispatched
    const sorted = searchFiltered.sort((a, b) => {
      if (a.itemStatus === 'pending' && b.itemStatus !== 'pending') return -1;
      if (a.itemStatus !== 'pending' && b.itemStatus === 'pending') return 1;
      if (a.itemStatus === 'pending' && b.itemStatus === 'pending') {
        const pRank = { critical: 2, high: 1, normal: 0 };
        const prDiff = (pRank[b.priority] || 0) - (pRank[a.priority] || 0);
        if (prDiff !== 0) return prDiff;
        return new Date(a.createdAt) - new Date(b.createdAt);
      }
      return new Date(b.dispatchedAt) - new Date(a.dispatchedAt);
    });

    // Render cards list
    queueListEl.innerHTML = '';
    if (sorted.length === 0) {
      const isFiltered = searchQuery || activeCategory !== 'all';
      const emptyCard = document.createElement('div');
      emptyCard.className = 'dispatch-empty-card';
      emptyCard.innerHTML = `
        <div class="dispatch-empty-card__icon">${icons.checkCircle(24)}</div>
        <div class="dispatch-empty-card__title">${isFiltered ? 'No matching emergency calls' : 'All caught up!'}</div>
        <div class="dispatch-empty-card__desc">${isFiltered ? 'No incidents match the active category or search query.' : 'There are no active or pending incidents in the dispatch queue.'}</div>
      `;
      queueListEl.appendChild(emptyCard);
      return;
    }

    for (const item of sorted) {
      const card = document.createElement('div');
      card.className = `queue-incident-card${item.priority === 'critical' ? ' is-critical' : ''}`;

      // Card Header: • INC-XXX + Status Badge
      const cardHeader = document.createElement('div');
      cardHeader.className = 'queue-incident-card__header';

      const idGroup = document.createElement('div');
      idGroup.className = 'queue-incident-card__id';
      const bullet = document.createElement('span');
      bullet.className = `queue-bullet ${getIncidentColorBullet(item.incidentType, item.priority, item.itemStatus)}`;
      const idText = document.createElement('span');
      idText.textContent = formatIncidentCode(item);
      idGroup.append(bullet, idText);

      const badge = document.createElement('span');
      badge.className = `queue-badge ${item.itemStatus === 'pending' ? 'queue-badge--pending' : 'queue-badge--dispatched'}`;
      badge.textContent = item.itemStatus === 'pending' ? 'PENDING' : 'DISPATCHED';

      cardHeader.append(idGroup, badge);

      // Card Title: Warning Icon + Emergency Title
      const titleRow = document.createElement('div');
      titleRow.className = 'queue-incident-card__title';
      titleRow.innerHTML = `${getIncidentIcon(item.incidentType, item.priority)} <span>${escapeHtml(INCIDENT_TYPE_LABELS[item.incidentType] || item.incidentType || 'Emergency')}</span>`;

      // Location
      const locRow = document.createElement('div');
      locRow.className = 'queue-incident-card__meta';
      const locText = item.locationDescription || item.location_description || (item.latitude && item.longitude ? `${Number(item.latitude).toFixed(4)}, ${Number(item.longitude).toFixed(4)}` : 'Location pinned on map');
      locRow.innerHTML = `${icons.mapPin(13)} <span>${escapeHtml(locText)}</span>`;

      // Elapsed Time
      const timeRow = document.createElement('div');
      timeRow.className = 'queue-incident-card__time';
      const timestamp = item.itemStatus === 'pending' ? item.createdAt : item.dispatchedAt;
      timeRow.innerHTML = `${icons.clock(13)} <span>${formatElapsed(timestamp)}</span>`;

      // Card Action
      if (item.itemStatus === 'pending') {
        const dispatchBtn = document.createElement('button');
        dispatchBtn.className = 'queue-incident-card__dispatch-btn';
        dispatchBtn.type = 'button';
        dispatchBtn.textContent = 'Dispatch Tanod';
        dispatchBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          dispatchBtn.disabled = true;
          const typeLabel = INCIDENT_TYPE_LABELS[item.incidentType] || item.incidentType;
          const dispatched = await promptDispatchTanod({ incident: item, incidentTypeLabel: typeLabel, eligibleTanods });
          if (dispatched) {
            onQueueChanged();
          } else {
            dispatchBtn.disabled = false;
          }
        });
        card.append(cardHeader, titleRow, locRow, timeRow, dispatchBtn);
      } else {
        // Dispatched item
        const dispatchedInfo = document.createElement('div');
        dispatchedInfo.className = 'queue-incident-card__dispatched-info';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'queue-incident-card__dispatched-name';
        nameSpan.textContent = `Assigned: ${item.tanodName || `Tanod #${item.tanodId}`}`;

        const actionsGroup = document.createElement('div');
        actionsGroup.style.display = 'flex';
        actionsGroup.style.alignItems = 'center';
        actionsGroup.style.gap = '0.375rem';

        const tanodGps = gpsItems.find((g) => g.userId === item.tanodId);
        if (tanodGps && tanodGps.latitude != null && tanodGps.longitude != null) {
          const locateBtn = document.createElement('button');
          locateBtn.type = 'button';
          locateBtn.className = 'queue-incident-card__locate-btn';
          locateBtn.innerHTML = `${icons.mapPin(11)} Locate`;
          locateBtn.title = 'Focus on Tanod on live map';
          locateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            liveMap?.flyTo(Number(tanodGps.latitude), Number(tanodGps.longitude), 17);
          });
          actionsGroup.appendChild(locateBtn);
        }

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'queue-incident-card__cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.title = 'Cancel this dispatch';
        cancelBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const confirmed = await confirmDialog({
            title: `Cancel dispatch #${item.dispatchId}?`,
            description: 'The incident will return to the pending queue.',
            confirmLabel: 'Cancel dispatch',
            cancelLabel: 'Keep it',
            danger: true,
          });
          if (!confirmed) return;
          try {
            await cancelDispatch(item.dispatchId);
            showToast(`Dispatch #${item.dispatchId} cancelled`, { variant: 'info' });
            onQueueChanged();
          } catch (err) {
            showToast(err instanceof ApiClientError ? err.message : 'Could not cancel dispatch.', { variant: 'error' });
          }
        });
        actionsGroup.appendChild(cancelBtn);

        dispatchedInfo.append(nameSpan, actionsGroup);
        card.append(cardHeader, titleRow, locRow, timeRow, dispatchedInfo);
      }

      // Card Click: Focus on Map
      card.addEventListener('click', () => {
        if (item.itemStatus === 'pending') {
          if (item.latitude != null && item.longitude != null) {
            const found = liveMap?.highlightIncident(item.incidentId);
            if (!found) {
              liveMap?.flyTo(Number(item.latitude), Number(item.longitude), 17);
            }
          }
        } else {
          const tanodGps = gpsItems.find((g) => g.userId === item.tanodId);
          if (tanodGps && tanodGps.latitude != null && tanodGps.longitude != null) {
            liveMap?.flyTo(Number(tanodGps.latitude), Number(tanodGps.longitude), 17);
          }
        }
      });

      queueListEl.appendChild(card);
    }
  }

  function renderLoading(container) {
    container.innerHTML = '';
    const layout = document.createElement('div');
    layout.className = 'dispatch-layout';
    layout.setAttribute('role', 'status');
    layout.setAttribute('aria-label', 'Loading dispatch center');
    const queue = document.createElement('div');
    queue.className = 'dispatch-queue-column';
    for (let i = 0; i < 3; i++) {
      const skeleton = document.createElement('div');
      skeleton.className = 'skeleton skeleton--row';
      skeleton.style.height = '7rem';
      skeleton.style.borderRadius = '12px';
      queue.appendChild(skeleton);
    }
    const mapSkeleton = document.createElement('div');
    mapSkeleton.className = 'skeleton dispatch-map-container';
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

  return { stop: stopPolling };
}
