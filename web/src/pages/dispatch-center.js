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
  cancelDispatch, acknowledgeTanodSos, resolveTanodSos, logout, ApiClientError,
} from '../api/apiClient.js';
import { getDispatchOffers, openDispatchOffer, cancelDispatchOffer } from '../services/shellWorkflowApi.js';
import { LiveMap } from '../components/LiveMap.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog, promptText } from '../components/ConfirmDialog.js';
import { requireReason } from '../utils/reasonText.js';
import { promptDispatchTanod } from '../components/DispatchAction.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { openReferralDialog } from '../components/IncidentCaseCards.js';

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

// Dispatch offers (Wave 2): a broadcast to on-duty tanods, up to 3 rounds of
// 180 s each (OfferService), then `escalated` = nobody can accept, assign one.
const OFFER_MAX_ROUNDS = 3;
const LIVE_OFFER_STATUSES = ['open', 'escalated'];

function formatCountdown(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** One-line, non-identifying summary of an offer, or null when nothing worth showing. */
function offerLineText(offer) {
  if (!offer) return null;
  if (offer.status === 'open') {
    const n = offer.recipientCount;
    return `Broadcast to ${n} tanod${n === 1 ? '' : 's'}, round ${offer.round}/${OFFER_MAX_ROUNDS}, expires ${formatCountdown(offer.expiresAt)}`;
  }
  if (offer.status === 'escalated') return 'Escalated: no tanod accepted. Assign a responder.';
  if (offer.status === 'accepted') return `Accepted by ${offer.acceptedByName || 'a tanod'}`;
  return null;
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
  let alertResolveBtnEl = null;
  let kpiCardEl = null;
  let queueListEl = null;
  let chipsContainerEl = null;
  let mapCardEl = null;
  let mapViewportEl = null;
  let mapSummaryPillEl = null;
  let legendCardEl = null;
  let pollTimer = null;

  // Filter state
  let searchQuery = '';
  let activeCategory = 'all';
  let latestData = null;
  // incidentId -> newest dispatch offer (GET /dispatch-offers is newest-first).
  let offerByIncident = new Map();
  const isAdmin = user.role === 'admin';

  const POLL_INTERVAL_MS = 15000;

  // Read-only route display (2026-09-13) — which dispatch's route, if
  // any, is currently drawn on the map. Survives updateQueueView()'s
  // full DOM rebuild on every poll/filter change; synced against fresh
  // data at the end of that function (see below).
  let activeRouteDispatchId = null;

  let liveElapsedTimer = setInterval(() => {
    if (!queueListEl) return;
    const timeRows = queueListEl.querySelectorAll('.queue-incident-card__time[data-timestamp]');
    for (const row of timeRows) {
      const ts = row.dataset.timestamp;
      const span = row.querySelector('.queue-incident-card__elapsed');
      if (span && ts) {
        span.textContent = formatElapsed(ts);
      }
    }
    // Live countdown on open offers (re-rendered fully on each poll).
    for (const el of queueListEl.querySelectorAll('[data-offer-expires]')) {
      const offer = offerByIncident.get(Number(el.dataset.incidentId));
      const text = offerLineText(offer);
      if (text && el.textContent !== text) el.textContent = text;
    }
  }, 1000);

  load(true);
  pollTimer = setInterval(() => load(false), POLL_INTERVAL_MS);

  const onQueueChanged = () => { load(false); shell.refreshNavCounts?.(); };

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (liveElapsedTimer) clearInterval(liveElapsedTimer);
    liveElapsedTimer = null;
    if (liveMap) liveMap.destroy();
    liveMap = null;
  }

  async function load(showLoadingState) {
    if (showLoadingState && !layoutEl) renderLoading(body);
    try {
      const [incidentsRes, reopenedIncidentsRes, dispatchedIncidentsRes, dispatchesRes, dutyStatuses, usersRes, sosItems, gpsItems, offersRes] = await Promise.all([
        getIncidents({ status: 'pending', limit: 100 }),
        // A Secretary-reopened incident is back in active handling: queue it
        // beside pending ones so the Admin can dispatch it. Additive — if it
        // cannot be read the board still works.
        getIncidents({ status: 'reopened', limit: 100 }).catch(() => ({ items: [] })),
        // 2026-09-13: fetched so grouped dispatch cards (below) can show
        // the incident's REAL type/location/display id — GET /dispatch's
        // own rows don't carry those (see mapDispatch()), so a dispatched
        // card previously fell back to generic "Emergency"/"Location
        // pinned on map" text regardless of what the incident actually was.
        getIncidents({ status: 'dispatched', limit: 100 }),
        getDispatches({ limit: 100 }),
        getDutyStatus(user.barangayId),
        getUsers({ role: 'tanod', limit: 100 }),
        getTanodSos({}).catch(() => []),
        getGpsLive(user.barangayId).catch(() => []),
        // Offer state is additive: if it cannot be read the board still works.
        getDispatchOffers({ limit: 100 }).catch(() => ({ items: [] })),
      ]);

      offerByIncident = new Map();
      for (const offer of offersRes.items) {
        if (!offerByIncident.has(offer.incidentId)) offerByIncident.set(offer.incidentId, offer);
      }

      const incidentById = new Map(
        [...incidentsRes.items, ...reopenedIncidentsRes.items, ...dispatchedIncidentsRes.items].map((i) => [i.incidentId, i])
      );
      const onDutyUserIds = new Set(dutyStatuses.filter((d) => d.status === 'on_duty').map((d) => d.userId));
      const eligibleTanods = usersRes.items.filter((u) => u.isActive && onDutyUserIds.has(u.userId));
      const activeDispatches = dispatchesRes.items.filter((d) => ACTIVE_DISPATCH_STATUSES.includes(d.status));

      // 2026-09-13, docs/REMAINING.md G-backlog "second responder": an
      // incident can now have more than one concurrent active dispatch.
      // Group by incidentId into ONE queue item per incident (carrying
      // its own real incident fields plus the full list of responders)
      // rather than one item per dispatch row — the queue used to render
      // a second/third full duplicate card for the same incident.
      const groupsByIncident = new Map();
      for (const dispatch of activeDispatches) {
        if (!groupsByIncident.has(dispatch.incidentId)) {
          groupsByIncident.set(dispatch.incidentId, { ...incidentById.get(dispatch.incidentId), incidentId: dispatch.incidentId, dispatches: [] });
        }
        groupsByIncident.get(dispatch.incidentId).dispatches.push(dispatch);
      }
      const groupedActiveDispatches = [...groupsByIncident.values()].map((group) => ({
        ...group,
        // Earliest responder's own dispatchedAt represents "when this
        // incident was first engaged" for sort/elapsed-time purposes.
        dispatchedAt: group.dispatches.reduce((earliest, d) => (
          !earliest || new Date(d.dispatchedAt) < new Date(earliest) ? d.dispatchedAt : earliest
        ), null),
      }));

      const openSos = sosItems.filter((s) => s.status !== 'resolved');
      const tanodNames = new Map(usersRes.items.map((u) => [u.userId, u.fullName]));

      latestData = {
        pendingIncidents: [...incidentsRes.items, ...reopenedIncidentsRes.items],
        activeDispatches: groupedActiveDispatches,
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

      const alertActions = document.createElement('div');
      alertActions.className = 'dispatch-priority-alert__actions';

      alertBtnEl = document.createElement('button');
      alertBtnEl.type = 'button';
      alertBtnEl.className = 'dispatch-priority-alert__btn';
      alertBtnEl.textContent = 'Dispatch Now';

      alertResolveBtnEl = document.createElement('button');
      alertResolveBtnEl.type = 'button';
      alertResolveBtnEl.className = 'dispatch-priority-alert__btn dispatch-priority-alert__btn--resolve';
      alertResolveBtnEl.textContent = 'Resolve SOS';
      alertResolveBtnEl.style.display = 'none';

      alertActions.append(alertBtnEl, alertResolveBtnEl);
      priorityAlertEl.append(alertLeft, alertActions);
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
      searchInputEl.setAttribute('aria-label', 'Search the emergency queue');
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

      const mapTitleWrap = document.createElement('div');
      mapTitleWrap.className = 'dispatch-map-header__title-wrap';

      const mapTitle = document.createElement('h3');
      mapTitle.className = 'dispatch-map-header__title';
      mapTitle.textContent = `Live Map - ${bName || ''}Pilar, Sorsogon`;

      const mapMetaRow = document.createElement('div');
      mapMetaRow.className = 'dispatch-map-header__meta';
      const livePill = document.createElement('span');
      livePill.className = 'dispatch-map-live-pill';
      livePill.innerHTML = `<span class="dispatch-map-live-dot" aria-hidden="true"></span><span>Live · 15s sync</span>`;
      mapSummaryPillEl = document.createElement('span');
      mapSummaryPillEl.className = 'dispatch-map-summary-pill';
      mapMetaRow.append(livePill, mapSummaryPillEl);
      mapTitleWrap.append(mapTitle, mapMetaRow);

      const mapActions = document.createElement('div');
      mapActions.className = 'dispatch-map-header__actions';

      const fitAllBtn = document.createElement('button');
      fitAllBtn.type = 'button';
      fitAllBtn.className = 'btn-recenter';
      fitAllBtn.title = 'Fit all active Tanods and Incidents into view';
      fitAllBtn.innerHTML = `${icons.mapPin(14)} <span>Fit All</span>`;
      fitAllBtn.addEventListener('click', () => {
        liveMap?.fitAll();
      });

      const gisJumpBtn = document.createElement('button');
      gisJumpBtn.type = 'button';
      gisJumpBtn.className = 'btn-recenter';
      gisJumpBtn.title = 'Open dedicated GIS Live Tracking console';
      gisJumpBtn.innerHTML = `${icons.compass(14)} <span>GIS Console</span>`;
      gisJumpBtn.addEventListener('click', () => {
        navigate('gis');
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

      mapActions.append(fitAllBtn, gisJumpBtn, fullscreenBtn);
      mapHeader.append(mapTitleWrap, mapActions);

      mapViewportEl = document.createElement('div');
      mapViewportEl.className = 'dispatch-map-viewport';

      legendCardEl = document.createElement('div');
      legendCardEl.className = 'dispatch-map-legend-card';
      mapViewportEl.appendChild(legendCardEl);

      mapCardEl.append(mapHeader, mapViewportEl);
      mapCol.appendChild(mapCardEl);

      layoutEl.append(queueCol, mapCol);
      container.appendChild(layoutEl);

      liveMap = LiveMap(mapViewportEl);
    }

    const handleResolveSingleSos = async (sosId) => {
      const sos = openSos.find((s) => s.sosId === sosId);
      const tanodName = sos?.fullName || (sos ? `Tanod #${sos.userId}` : `SOS #${sosId}`);
      const confirmed = await confirmDialog({
        title: `Resolve SOS Emergency #${sosId}?`,
        description: `Confirm that ${tanodName} is secure and the emergency response is complete. This will mark the SOS as resolved and remove the alert.`,
        confirmLabel: 'Mark Resolved',
        cancelLabel: 'Keep Active',
      });
      if (!confirmed) return;
      try {
        await resolveTanodSos(sosId);
        showToast(`SOS #${sosId} for ${tanodName} marked as resolved.`, { variant: 'success' });
        onQueueChanged();
      } catch (err) {
        showToast(err instanceof ApiClientError ? err.message : 'Could not resolve SOS.', { variant: 'error' });
      }
    };

    // Update Priority Alert Banner
    const urgentSos = openSos.find((s) => s.status !== 'resolved');
    const urgentCritical = pendingIncidents.find((i) => i.priority === 'critical');

    if (urgentSos) {
      priorityAlertEl.style.display = 'flex';
      const tanodLabel = urgentSos.fullName || `Tanod #${urgentSos.userId}`;
      if (openSos.length > 1) {
        alertTextEl.textContent = `PRIORITY ALERT: ${openSos.length} Active Tanod SOS Emergencies — Latest: ${tanodLabel}`;
      } else {
        alertTextEl.textContent = `PRIORITY ALERT: SOS Emergency for ${tanodLabel} - Requires immediate dispatch`;
      }
      alertBtnEl.textContent = 'Locate on Map';
      alertBtnEl.onclick = () => {
        if (urgentSos.latitude != null && urgentSos.longitude != null) {
          const found = liveMap?.highlightSos?.(urgentSos.sosId, 18.5);
          if (!found) {
            liveMap?.flyTo(Number(urgentSos.latitude), Number(urgentSos.longitude), 18.5);
          }
        } else {
          liveMap?.fitAll();
        }
      };

      alertResolveBtnEl.style.display = 'inline-flex';
      alertResolveBtnEl.textContent = openSos.length > 1 ? `Resolve All (${openSos.length})` : 'Resolve SOS';
      alertResolveBtnEl.onclick = async () => {
        if (openSos.length > 1) {
          const confirmed = await confirmDialog({
            title: `Resolve ${openSos.length} SOS Emergencies?`,
            description: `Confirm that all ${openSos.length} active Tanod SOS emergencies have been attended to and can be marked as resolved.`,
            confirmLabel: `Resolve All (${openSos.length})`,
            cancelLabel: 'Keep Active',
          });
          if (!confirmed) return;
          try {
            await Promise.all(openSos.map((s) => resolveTanodSos(s.sosId)));
            showToast(`All ${openSos.length} SOS emergencies marked as resolved.`, { variant: 'success' });
            onQueueChanged();
          } catch (err) {
            showToast(err instanceof ApiClientError ? err.message : 'Could not resolve all SOS emergencies.', { variant: 'error' });
          }
        } else {
          await handleResolveSingleSos(urgentSos.sosId);
        }
      };
    } else if (urgentCritical) {
      priorityAlertEl.style.display = 'flex';
      alertResolveBtnEl.style.display = 'none';
      alertBtnEl.textContent = 'Dispatch Now';
      const typeLabel = INCIDENT_TYPE_LABELS[urgentCritical.incidentType] || urgentCritical.incidentType;
      const locLabel = urgentCritical.locationDescription || urgentCritical.location_description || 'Barangay Area';
      alertTextEl.textContent = `PRIORITY ALERT: ${typeLabel} in ${locLabel} - Requires immediate dispatch`;
      alertBtnEl.onclick = async () => {
        await promptDispatchTanod({ incident: urgentCritical, incidentTypeLabel: typeLabel, eligibleTanods, tanodPositions: gpsItems });
        onQueueChanged();
      };
    } else {
      priorityAlertEl.style.display = 'none';
      alertResolveBtnEl.style.display = 'none';
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

    // Build lookup of which Tanods are currently dispatched to which incident
    const dispatchByTanodId = new Map();
    for (const group of activeDispatches) {
      for (const d of group.dispatches || []) {
        if (d.tanodId) {
          dispatchByTanodId.set(d.tanodId, {
            incidentId: group.incidentId,
            incidentCode: formatIncidentCode(group),
            incidentLat: group.latitude,
            incidentLng: group.longitude,
          });
        }
      }
    }

    // Update LiveMap Tanod Pins with real Available vs Dispatched status + rich popup metadata
    liveMap.setMarkers(gpsItems.map((g) => {
      const activeDisp = dispatchByTanodId.get(g.userId);
      const hasActiveSos = openSos.some((s) => s.userId === g.userId && s.status !== 'resolved');
      return {
        userId: g.userId,
        fullName: g.fullName,
        latitude: g.latitude,
        longitude: g.longitude,
        ageSeconds: g.ageSeconds,
        isStale: g.isStale,
        status: activeDisp ? 'dispatched' : 'available',
        isDispatched: Boolean(activeDisp),
        hasActiveSos,
        incidentId: activeDisp?.incidentId || null,
        incidentCode: activeDisp?.incidentCode || null,
        onViewIncident: (incId) => navigate('incident-detail', incId),
      };
    }));

    liveMap.setSosMarkers(
      openSos.map((s) => ({ sosId: s.sosId, latitude: s.latitude, longitude: s.longitude, status: s.status, fullName: s.fullName })),
      handleResolveSingleSos
    );

    // Combine Pending Incidents + Active Dispatched Incidents with coordinates on the map
    const mapIncidents = [
      ...pendingIncidents.map((incident) => ({
        incidentId: incident.incidentId,
        displayId: formatIncidentCode(incident),
        latitude: incident.latitude,
        longitude: incident.longitude,
        incidentType: incident.incidentType,
        typeLabel: INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType,
        priority: incident.priority,
        status: 'pending',
        locationText: incident.locationDescription || incident.location_description || '',
        elapsedText: incident.createdAt ? `Reported ${formatElapsed(incident.createdAt)}` : '',
      })),
      ...activeDispatches
        .filter((group) => group.latitude != null && group.longitude != null)
        .map((group) => ({
          incidentId: group.incidentId,
          displayId: formatIncidentCode(group),
          latitude: group.latitude,
          longitude: group.longitude,
          incidentType: group.incidentType || 'other',
          typeLabel: INCIDENT_TYPE_LABELS[group.incidentType] || group.incidentType || 'Dispatched Incident',
          priority: group.priority || 'normal',
          status: 'dispatched',
          locationText: group.locationDescription || group.location_description || '',
          elapsedText: group.dispatchedAt ? `Dispatched ${formatElapsed(group.dispatchedAt)}` : '',
          responderText: `Assigned: ${(group.dispatches || []).map((d) => d.tanodName || `Tanod #${d.tanodId}`).join(', ')}`,
        })),
    ];

    liveMap.setIncidentMarkers(
      mapIncidents,
      eligibleTanods.length === 0 ? undefined : async (incidentId) => {
        const incident = pendingIncidents.find((i) => i.incidentId === incidentId)
          || activeDispatches.find((i) => i.incidentId === incidentId);
        if (!incident) return;
        const assignedIds = new Set((incident.dispatches || []).map((d) => d.tanodId));
        const availableEligible = eligibleTanods.filter((t) => !assignedIds.has(t.userId));
        if (availableEligible.length === 0) {
          showToast('All eligible on-duty Tanods are already assigned to this incident.', { variant: 'info' });
          return;
        }
        const typeLabel = INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType || 'Incident';
        const dispatched = await promptDispatchTanod({
          incident,
          incidentTypeLabel: typeLabel,
          eligibleTanods: availableEligible,
          tanodPositions: gpsItems,
        });
        if (dispatched) onQueueChanged();
      },
      (incidentId) => navigate('incident-detail', incidentId)
    );

    // Draw dashed tactical connection lines between Dispatched Tanods and their assigned Incident pins
    const dispatchLinks = [];
    for (const g of gpsItems) {
      const activeDisp = dispatchByTanodId.get(g.userId);
      if (activeDisp && g.latitude != null && g.longitude != null && activeDisp.incidentLat != null && activeDisp.incidentLng != null) {
        dispatchLinks.push({
          fromLng: g.longitude,
          fromLat: g.latitude,
          toLng: activeDisp.incidentLng,
          toLat: activeDisp.incidentLat,
        });
      }
    }
    liveMap.setDispatchLinks(dispatchLinks);

    // Update Map Header Summary Pill & Interactive Legend Counts
    const availMapCount = gpsItems.filter((g) => !dispatchByTanodId.has(g.userId) && g.latitude != null && g.longitude != null).length;
    const dispMapCount = gpsItems.filter((g) => dispatchByTanodId.has(g.userId) && g.latitude != null && g.longitude != null).length;
    const incMapCount = mapIncidents.filter((i) => i.latitude != null && i.longitude != null).length;
    const sosMapCount = openSos.filter((s) => s.latitude != null && s.longitude != null).length;

    if (mapSummaryPillEl) {
      mapSummaryPillEl.textContent = `${availMapCount + dispMapCount} Tanods · ${incMapCount} Incidents`;
    }

    renderInteractiveLegend(availMapCount, dispMapCount, incMapCount, sosMapCount);

    // Update Queue Cards view
    updateQueueView();
  }

  function renderInteractiveLegend(availCount, dispCount, incCount, sosCount) {
    if (!legendCardEl || !liveMap) return;
    const vis = liveMap.getLayerVisibility();
    const anyHidden = !vis.available || !vis.dispatched || !vis.incident || !vis.sos;

    legendCardEl.innerHTML = '';
    const titleRow = document.createElement('div');
    titleRow.className = 'legend-title-row';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'legend-title';
    titleSpan.textContent = 'Legend';
    titleRow.appendChild(titleSpan);

    if (anyHidden) {
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'legend-reset-btn';
      resetBtn.textContent = 'Reset';
      resetBtn.addEventListener('click', () => {
        liveMap.resetLayers();
        renderInteractiveLegend(availCount, dispCount, incCount, sosCount);
      });
      titleRow.appendChild(resetBtn);
    }
    legendCardEl.appendChild(titleRow);

    const rows = [
      { key: 'available', label: 'Available Tanod', dotClass: 'legend-dot--green', count: availCount },
      { key: 'dispatched', label: 'Dispatched', dotClass: 'legend-dot--blue', count: dispCount },
      { key: 'incident', label: 'Incident Pin', dotClass: 'legend-dot--amber', count: incCount },
      { key: 'sos', label: 'Emergency SOS', dotClass: 'legend-dot--red', count: sosCount },
    ];

    for (const row of rows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `legend-item legend-item-btn${vis[row.key] ? '' : ' is-muted'}`;
      btn.title = `Click to ${vis[row.key] ? 'hide' : 'show'} ${row.label} pins on map`;
      btn.innerHTML = `
        <span class="legend-item__left">
          <span class="legend-dot ${row.dotClass}"></span>
          <span>${escapeHtml(row.label)}</span>
        </span>
        <span class="legend-count-pill">${row.count}</span>
      `;
      btn.addEventListener('click', () => {
        liveMap.toggleLayer(row.key);
        renderInteractiveLegend(availCount, dispCount, incCount, sosCount);
      });
      legendCardEl.appendChild(btn);
    }
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
      // A grouped dispatched item has `dispatches[]` (one or more
      // responders); a pending item has neither — matches any responder's
      // name, not just a single one.
      const tanodStr = (item.dispatches || []).map((d) => d.tanodName || '').join(' ').toLowerCase();
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

      // "Delegated to" (2026-10, contract §5): records that the incident was
      // referred to another party (PNP, BFP, EMS ...). It only writes a
      // referral row; it never changes the dispatch or incident status.
      const delegateBtn = document.createElement('button');
      delegateBtn.type = 'button';
      delegateBtn.className = 'queue-incident-card__add-responder-btn';
      delegateBtn.innerHTML = `${icons.send(13)} <span>Delegated to</span>`;
      delegateBtn.title = 'Record that this incident was referred to another party';
      delegateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openReferralDialog({ incidentId: item.incidentId, incidentLabel: formatIncidentCode(item) });
      });

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
      badge.textContent = item.itemStatus === 'pending'
        ? (item.status === 'reopened' ? 'REOPENED' : 'PENDING')
        : 'DISPATCHED';

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
      if (timestamp) timeRow.dataset.timestamp = timestamp;
      timeRow.innerHTML = `${icons.clock(13)} <span class="queue-incident-card__elapsed">${formatElapsed(timestamp)}</span>`;

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
          const dispatched = await promptDispatchTanod({ incident: item, incidentTypeLabel: typeLabel, eligibleTanods, tanodPositions: gpsItems });
          if (dispatched) {
            onQueueChanged();
          } else {
            dispatchBtn.disabled = false;
          }
        });
        card.append(cardHeader, titleRow, locRow, timeRow, dispatchBtn, delegateBtn);
      } else {
        // Dispatched item — one row per responder (docs/REMAINING.md
        // G-backlog "second responder": an incident can now have more
        // than one concurrent active dispatch; this used to render a
        // full SEPARATE duplicate card per responder on the SAME
        // incident, which is what this groups away).
        const dispatchedList = document.createElement('div');
        dispatchedList.className = 'queue-incident-card__dispatched-list';

        for (const dispatch of item.dispatches) {
          const dispatchedInfo = document.createElement('div');
          dispatchedInfo.className = 'queue-incident-card__dispatched-info';

          const nameSpan = document.createElement('span');
          nameSpan.className = 'queue-incident-card__dispatched-name';
          nameSpan.textContent = `Assigned: ${dispatch.tanodName || `Tanod #${dispatch.tanodId}`}`;

          const actionsGroup = document.createElement('div');
          actionsGroup.style.display = 'flex';
          actionsGroup.style.alignItems = 'center';
          actionsGroup.style.gap = '0.375rem';

          const tanodGps = gpsItems.find((g) => g.userId === dispatch.tanodId);
          if (tanodGps && tanodGps.latitude != null && tanodGps.longitude != null) {
            const locateBtn = document.createElement('button');
            locateBtn.type = 'button';
            locateBtn.className = 'queue-incident-card__locate-btn';
            locateBtn.innerHTML = `${icons.mapPin(11)} Locate`;
            locateBtn.title = 'Focus on Tanod on live map';
            locateBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              const found = liveMap?.highlightTanod?.(dispatch.tanodId, 18.5);
              if (!found) {
                liveMap?.flyTo(Number(tanodGps.latitude), Number(tanodGps.longitude), 18.5);
              }
            });
            actionsGroup.appendChild(locateBtn);
          }

          // Read-only route display (2026-09-13): shows whatever route a
          // Tanod's own mobile "Get Route" tap already computed —
          // Dispatch Center never requests a route itself (no
          // geolocation/coordinate-input concept exists on the web
          // dashboard, and routing from the Admin's own desk position
          // wouldn't be operationally meaningful anyway). Only rendered
          // once a route has been computed at least once (routeStatus
          // 'available' or 'stale') — never for 'unavailable', same
          // "no control that looks functional and does nothing"
          // principle the conditional Locate button above already follows.
          if (dispatch.routeJson) {
            const routeBtn = document.createElement('button');
            routeBtn.type = 'button';
            routeBtn.className = 'queue-incident-card__route-btn';
            const isActiveRoute = activeRouteDispatchId === dispatch.dispatchId;
            routeBtn.classList.toggle('is-active', isActiveRoute);
            const staleTag = dispatch.routeStatus === 'stale' ? ' (may be outdated)' : '';
            routeBtn.innerHTML = `${icons.map(11)} ${isActiveRoute ? 'Hide Route' : 'Show Route'}`;
            routeBtn.title = `${isActiveRoute ? 'Hide' : 'Show'} this Tanod's route to the incident${staleTag}`;
            routeBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              // Single-active-route model: showing one clears/replaces
              // any other — avoids cluttering the map when an incident
              // has several concurrent responders (second-responder
              // feature), matching Locate's own single-focus precedent.
              if (activeRouteDispatchId === dispatch.dispatchId) {
                activeRouteDispatchId = null;
                liveMap?.setRoute(null);
              } else {
                activeRouteDispatchId = dispatch.dispatchId;
                liveMap?.setRoute(dispatch.routeJson.geometry);
              }
              updateQueueView();
            });
            actionsGroup.appendChild(routeBtn);
          }

          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'queue-incident-card__cancel-btn';
          cancelBtn.textContent = 'Cancel';
          cancelBtn.title = 'Cancel this dispatch';
          cancelBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            // A reason is REQUIRED (1-255 chars) and cancelling is allowed
            // from every active state, including `arrived`. Validation and
            // the PATCH both run inside the dialog's confirm hook, so a
            // client or server rejection shows inline and the dialog stays
            // open with what was typed.
            const arrivedNote = dispatch.status === 'arrived'
              ? ' This responder has already arrived at the scene.'
              : '';
            const reason = await promptText({
              title: `Cancel dispatch #${dispatch.dispatchId}?`,
              // 2026-09-13: was "The incident will return to the pending
              // queue" unconditionally — no longer always true once a
              // second responder can stay active after this cancellation.
              description: `This removes ${dispatch.tanodName || 'this responder'} from the incident.${arrivedNote} A reason is required and is kept with the dispatch.`,
              label: 'Reason for cancelling (required)',
              confirmLabel: 'Cancel dispatch',
              cancelLabel: 'Keep it',
              onConfirmAsync: async (value) => {
                await cancelDispatch(dispatch.dispatchId, requireReason(value, 'cancellation reason'));
              },
            });
            if (reason === null) return;
            showToast(`Dispatch #${dispatch.dispatchId} cancelled`, { variant: 'info' });
            onQueueChanged();
          });
          actionsGroup.appendChild(cancelBtn);

          dispatchedInfo.append(nameSpan, actionsGroup);
          dispatchedList.appendChild(dispatchedInfo);
        }

        const assignedIds = new Set((item.dispatches || []).map((d) => d.tanodId));
        const unassignedEligible = eligibleTanods.filter((t) => !assignedIds.has(t.userId));

        const addResponderBtn = document.createElement('button');
        addResponderBtn.type = 'button';
        addResponderBtn.className = 'queue-incident-card__add-responder-btn';
        addResponderBtn.innerHTML = `${icons.plus(13)} <span>Add Responder</span>`;
        addResponderBtn.disabled = unassignedEligible.length === 0;
        addResponderBtn.title = unassignedEligible.length === 0
          ? 'All eligible on-duty Tanods are already assigned'
          : 'Dispatch an additional backup responder to this incident';
        addResponderBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          addResponderBtn.disabled = true;
          const typeLabel = INCIDENT_TYPE_LABELS[item.incidentType] || item.incidentType || 'Incident';
          const dispatched = await promptDispatchTanod({
            incident: item,
            incidentTypeLabel: typeLabel,
            eligibleTanods: unassignedEligible,
            tanodPositions: gpsItems,
          });
          if (dispatched) {
            onQueueChanged();
          } else {
            addResponderBtn.disabled = unassignedEligible.length === 0;
          }
        });

        card.append(cardHeader, titleRow, locRow, timeRow, dispatchedList, addResponderBtn, delegateBtn);
      }

      // Dispatch offer state (Wave 2): a live line under the elapsed time,
      // plus Admin-only broadcast/cancel. Non-identifying data only — counts,
      // round and (once accepted) the responder's name, which the dispatched
      // card already shows.
      const offer = offerByIncident.get(item.incidentId);
      const offerText = offerLineText(offer);
      const offerLive = offer && LIVE_OFFER_STATUSES.includes(offer.status);
      const offerBlock = document.createElement('div');
      offerBlock.className = 'queue-incident-card__dispatched-list';
      if (offerText) {
        const line = document.createElement('div');
        line.className = `queue-incident-card__meta`;
        if (offer.status === 'open') line.dataset.offerExpires = '1';
        line.dataset.incidentId = String(item.incidentId);
        line.setAttribute('role', 'status');
        line.textContent = offerText;
        offerBlock.appendChild(line);
      }
      if (isAdmin && item.itemStatus === 'pending' && !offerLive) {
        const broadcastBtn = document.createElement('button');
        broadcastBtn.type = 'button';
        broadcastBtn.className = 'queue-incident-card__add-responder-btn';
        broadcastBtn.innerHTML = `${icons.radio(13)} <span>Broadcast to on-duty tanods</span>`;
        broadcastBtn.title = 'Offer this incident to every on-duty tanod; the first to accept is dispatched';
        broadcastBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          broadcastBtn.disabled = true;
          try {
            const res = await openDispatchOffer(item.incidentId, crypto.randomUUID());
            showToast(res.status === 'escalated'
              ? 'No on-duty tanod could be offered this incident. Assign a responder.'
              : `Broadcast sent to ${res.recipientCount} tanod${res.recipientCount === 1 ? '' : 's'}.`, { variant: res.status === 'escalated' ? 'warning' : 'success' });
            onQueueChanged();
          } catch (err) {
            broadcastBtn.disabled = false;
            showToast(err instanceof ApiClientError ? err.message : 'Could not start the broadcast.', { variant: 'error' });
          }
        });
        offerBlock.appendChild(broadcastBtn);
      }
      if (isAdmin && offerLive) {
        const cancelOfferBtn = document.createElement('button');
        cancelOfferBtn.type = 'button';
        cancelOfferBtn.className = 'queue-incident-card__cancel-btn';
        cancelOfferBtn.textContent = 'Cancel broadcast';
        cancelOfferBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          cancelOfferBtn.disabled = true;
          try {
            await cancelDispatchOffer(offer.offerId, crypto.randomUUID());
            showToast('Broadcast cancelled.', { variant: 'info' });
            onQueueChanged();
          } catch (err) {
            cancelOfferBtn.disabled = false;
            showToast(err instanceof ApiClientError ? err.message : 'Could not cancel the broadcast.', { variant: 'error' });
          }
        });
        offerBlock.appendChild(cancelOfferBtn);
      }
      if (offerBlock.childElementCount > 0) timeRow.after(offerBlock);

      // Card Click: Focus on Map
      card.addEventListener('click', () => {
        if (item.latitude != null && item.longitude != null) {
          const found = liveMap?.highlightIncident(item.incidentId, 18.5);
          if (!found) {
            liveMap?.flyTo(Number(item.latitude), Number(item.longitude), 18.5);
          }
        } else {
          // Fallback if incident lacks coordinates: fly to first responder with live GPS
          const tanodGps = (item.dispatches || [])
            .map((d) => gpsItems.find((g) => g.userId === d.tanodId))
            .find((g) => g && g.latitude != null && g.longitude != null);
          if (tanodGps) {
            const found = liveMap?.highlightTanod?.(tanodGps.userId, 18.5);
            if (!found) {
              liveMap?.flyTo(Number(tanodGps.latitude), Number(tanodGps.longitude), 18.5);
            }
          }
        }
      });

      queueListEl.appendChild(card);
    }

    // Keep the currently-shown route (if any) in sync with this fresh
    // poll: re-draw it if its dispatch still has a route (so a Tanod
    // requesting a fresh one on their phone shows up here within one
    // 15s poll cycle), or clear it if that dispatch dropped out of the
    // active list entirely (cancelled/completed) rather than leaving a
    // stale line pointing at a dispatch that no longer exists.
    if (activeRouteDispatchId != null) {
      const stillActive = sorted
        .flatMap((item) => item.dispatches || [])
        .find((d) => d.dispatchId === activeRouteDispatchId);
      if (stillActive && stillActive.routeJson) {
        liveMap?.setRoute(stillActive.routeJson.geometry);
      } else {
        activeRouteDispatchId = null;
        liveMap?.setRoute(null);
      }
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
