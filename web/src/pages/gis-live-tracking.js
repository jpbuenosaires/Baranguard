/**
 * gis-live-tracking.js — W4 GIS Live Tracking (§9): "Shows freshness
 * (age_seconds, stale badge) on every responder marker. A stale location
 * is not visually presented as live. SOS markers remain visible above
 * ordinary map filters." Roles: Admin, Punong Barangay (read-only) — §7
 * "View live tracking": Admin full, PB read-only; since this screen has
 * no write action, both roles just render the same GET calls.
 *
 * Extended by the 2026-09-05 UX pass (see
 * .claude/plans/fancy-crafting-lark.md) with a stat strip, roster
 * filters, a Call action, and a Live Activity feed — all built from
 * endpoints this app already has:
 *   - Stat strip / roster filters / activity feed use `GET /duty-status`
 *     and `GET /dispatch`, both already open to Admin AND Punong
 *     Barangay server-side (`DutyStatusController`/`DispatchController`),
 *     so they render identically for both roles.
 *   - The Call button additionally needs `GET /users` for a contact
 *     number, which is Admin-only server-side (`UsersController::index`)
 *     — so it only renders for Admin; PB's roster row simply has no Call
 *     action, same graceful degradation `incident-management.js` uses
 *     for the same reason.
 *   - The activity feed is assembled CLIENT-SIDE from real timestamped
 *     rows already returned by the endpoints above (each dispatch's own
 *     stage timestamps, each duty_status row's changed_at, each SOS's
 *     triggered_at) — not a new backend endpoint, and not fabricated
 *     data (§2 Rule 6): every line traces to a real row this screen
 *     already fetched.
 *   - Everything here stays scoped to the signed-in user's own
 *     `barangayId`, exactly as before — no cross-barangay data is ever
 *     requested or displayed.
 *
 * Reuses the shared `LiveMap` component built for W3 — §9 is explicit
 * this does not get a second map implementation.
 *
 * Polling: §6 doesn't specify a refresh cadence for `GET /gps/live`;
 * resolved decision (logged in DEVLOG.md) — poll every 15 seconds while
 * this page is open, matching the same order of magnitude as the
 * 120-second staleness threshold without being wasteful. Stops polling
 * when the user navigates away (own `stop()` returned to main.js).
 *
 * kebab-case filename per §4.
 */

import {
  getGpsLive, getTanodSos, getDutyStatus, getDispatches, getUsers, logout, ApiClientError,
} from '../api/apiClient.js';
import { LiveMap } from '../components/LiveMap.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { escapeHtml } from '../utils/escapeHtml.js';

const POLL_INTERVAL_MS = 15000;
const ACTIVE_DISPATCH_STATUSES = ['assigned', 'en_route', 'arrived'];
// Labels only (2026-09-05 bug pass) — 'available' really means "on duty
// and not currently responding," and 'dispatched' means "has an active
// dispatch," which "Dispatched" alone doesn't convey from the Tanod's own
// point of view. Filter keys/values are unchanged — only what the chip
// reads as.
const ROSTER_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'available', label: 'On Duty' },
  { key: 'dispatched', label: 'Responding' },
  { key: 'stale', label: 'Stale' },
];
const DUTY_EVENT_LABEL = { on_duty: 'marked as available', responding: 'marked as responding', off_duty: 'went off duty' };
const ACTIVITY_FEED_LIMIT = 10;

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 * @returns {{stop: () => void}}
 */
export function renderGisLiveTrackingPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const isAdmin = user.role === 'admin';

  const shell = AppShell(user, 'gis', navigate, async () => {
    shell.logoutButton.disabled = true;
    stopPolling();
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  // Lock outer page scrolling so only internal roster/map are interactive
  content.classList.add('gis-page-container');
  if (content.parentElement) {
    content.parentElement.classList.add('page-content--no-scroll');
  }

  // Standard Page Header
  const pageHeader = PageHeader({
    title: 'Live Tracking',
    subtitle: 'Real-time GPS tracking and Tanod responder deployment',
    icon: icons.map,
  });
  header.appendChild(pageHeader.el);

  const wrapper = document.createElement('div');
  wrapper.className = 'gis-page-wrapper';
  content.appendChild(wrapper);

  const body = document.createElement('div');
  body.className = 'gis-page-body';
  wrapper.appendChild(body);

  let liveMap = null;
  let timer = null;
  let rosterFilter = 'all';
  let renderCurrentRosterAndMap = () => {};
  let tanodRosterById = new Map();

  // Layout DOM references cached across poll updates
  let layoutEl = null;
  let statCardsEl = null;
  let filterBarEl = null;
  let filterBadgeEl = null;
  let personnelHeaderEl = null;
  let personnelListEl = null;
  let mapSubtitleEl = null;
  let floatingActivityListEl = null;

  load(true);
  timer = setInterval(() => load(false), POLL_INTERVAL_MS);

  function stopPolling() {
    if (timer) clearInterval(timer);
    if (liveMap) liveMap.destroy();
  }

  async function load(showLoadingState) {
    if (showLoadingState && !layoutEl) renderLoading(body);
    try {
      const [gpsItems, sosItems, dutyStatuses, dispatchesRes, usersRes] = await Promise.all([
        getGpsLive(user.barangayId),
        getTanodSos({}).catch(() => []),
        getDutyStatus(user.barangayId).catch(() => []),
        getDispatches({ limit: 100 }).catch(() => ({ items: [] })),
        isAdmin ? getUsers({ role: 'tanod', limit: 100 }).catch(() => ({ items: [] })) : Promise.resolve(null),
      ]);
      if (usersRes) tanodRosterById = new Map(usersRes.items.map((u) => [u.userId, u]));
      const openSos = sosItems.filter((s) => s.status !== 'resolved');
      renderPopulated(body, gpsItems, openSos, dutyStatuses, dispatchesRes.items);
    } catch (err) {
      if (showLoadingState && !layoutEl) {
        const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading live tracking.';
        renderError(body, message, () => load(true));
      }
    }
  }

  function renderPopulated(container, gpsItems, openSos, dutyStatuses, dispatches) {
    const onDutyIds = new Set(dutyStatuses.filter((d) => d.status === 'on_duty').map((d) => d.userId));
    const activeDispatches = dispatches.filter((d) => ACTIVE_DISPATCH_STATUSES.includes(d.status));
    const dispatchedMap = new Map();
    for (const d of activeDispatches) {
      if (d.tanodId) dispatchedMap.set(d.tanodId, d);
    }
    const dispatchedIds = new Set(dispatchedMap.keys());
    const availableCount = [...onDutyIds].filter((id) => !dispatchedIds.has(id)).length;
    const dispatchedCount = dispatchedIds.size;
    const activeAlertsCount = openSos.length;

    // First time mounting the console
    if (!layoutEl) {
      container.innerHTML = '';

      layoutEl = document.createElement('div');
      layoutEl.className = 'gis-layout';

      // ── LEFT COLUMN: Personnel & Status Panel ──
      const sidebar = document.createElement('aside');
      sidebar.className = 'gis-sidebar';

      // 3 Mini Status Cards
      statCardsEl = document.createElement('div');
      statCardsEl.className = 'gis-stats-grid';
      sidebar.appendChild(statCardsEl);

      // Map Filters Row
      filterBarEl = document.createElement('div');
      filterBarEl.className = 'gis-filter-bar';
      filterBarEl.innerHTML = `
        <div class="gis-filter-bar__left">
          ${icons.filter(15)}
          <span>Map Filters</span>
        </div>
      `;
      filterBadgeEl = document.createElement('span');
      filterBadgeEl.className = 'gis-filter-bar__badge';
      filterBarEl.appendChild(filterBadgeEl);
      filterBarEl.addEventListener('click', () => {
        // Toggle roster filter in a simple cycle: all -> available -> dispatched -> all
        if (rosterFilter === 'all') rosterFilter = 'available';
        else if (rosterFilter === 'available') rosterFilter = 'dispatched';
        else rosterFilter = 'all';
        updateMiniStatCardsSelection();
        renderCurrentRosterAndMap();
      });
      sidebar.appendChild(filterBarEl);

      // Personnel List Section Header
      personnelHeaderEl = document.createElement('div');
      personnelHeaderEl.className = 'gis-personnel-header';
      sidebar.appendChild(personnelHeaderEl);

      // Personnel Cards Scrollable Container
      personnelListEl = document.createElement('div');
      personnelListEl.className = 'gis-personnel-list';
      sidebar.appendChild(personnelListEl);

      // ── RIGHT COLUMN: GIS Map & Overlays ──
      const mapCard = document.createElement('div');
      mapCard.className = 'gis-map-card';

      // Map Header Bar
      const mapHeader = document.createElement('div');
      mapHeader.className = 'gis-map-header';

      const mapTitleGroup = document.createElement('div');
      mapTitleGroup.className = 'gis-map-header__title-group';
      const mapTitle = document.createElement('h3');
      mapTitle.className = 'gis-map-header__title';
      mapTitle.textContent = 'GIS Map - Real-Time Tracking';
      mapSubtitleEl = document.createElement('div');
      mapSubtitleEl.className = 'gis-map-header__subtitle';
      mapTitleGroup.append(mapTitle, mapSubtitleEl);

      const mapActions = document.createElement('div');
      mapActions.className = 'gis-map-header__actions';

      const layersBtn = document.createElement('button');
      layersBtn.type = 'button';
      layersBtn.className = 'gis-map-tool-btn';
      layersBtn.title = 'Map Layers';
      layersBtn.setAttribute('aria-label', 'Map Layers');
      layersBtn.innerHTML = icons.layers(16);

      const zoomInBtn = document.createElement('button');
      zoomInBtn.type = 'button';
      zoomInBtn.className = 'gis-map-tool-btn';
      zoomInBtn.title = 'Zoom in';
      zoomInBtn.setAttribute('aria-label', 'Zoom in');
      zoomInBtn.innerHTML = icons.zoomIn(16);
      zoomInBtn.addEventListener('click', () => liveMap?.zoomIn());

      const zoomOutBtn = document.createElement('button');
      zoomOutBtn.type = 'button';
      zoomOutBtn.className = 'gis-map-tool-btn';
      zoomOutBtn.title = 'Zoom out';
      zoomOutBtn.setAttribute('aria-label', 'Zoom out');
      zoomOutBtn.innerHTML = icons.zoomOut(16);
      zoomOutBtn.addEventListener('click', () => liveMap?.zoomOut());

      const myLocationBtn = document.createElement('button');
      myLocationBtn.type = 'button';
      myLocationBtn.className = 'gis-map-primary-btn';
      myLocationBtn.innerHTML = `${icons.compass(15)}<span>My Location</span>`;
      myLocationBtn.title = 'Centre and fit all responders and incidents';
      myLocationBtn.addEventListener('click', () => liveMap?.fitAll());

      mapActions.append(layersBtn, zoomInBtn, zoomOutBtn, myLocationBtn);
      mapHeader.append(mapTitleGroup, mapActions);
      mapCard.appendChild(mapHeader);

      // Map Viewport with LiveMap instance
      const mapViewport = document.createElement('div');
      mapViewport.className = 'gis-map-viewport';
      mapCard.appendChild(mapViewport);

      // Floating Live Activity Widget (Top-Right of Map)
      const activityWidget = document.createElement('div');
      activityWidget.className = 'gis-floating-activity';
      activityWidget.innerHTML = `
        <div class="gis-floating-activity__header" role="button" tabindex="0" aria-expanded="true" aria-label="Toggle Live Activity panel">
          <div class="gis-floating-activity__title-group">
            ${icons.activity(16)}
            <span>Live Activity</span>
          </div>
          <button type="button" class="gis-floating-activity__toggle" aria-label="Collapse Live Activity" title="Collapse Live Activity">
            ${icons.chevronDown(16)}
          </button>
        </div>
      `;
      floatingActivityListEl = document.createElement('div');
      floatingActivityListEl.className = 'gis-floating-activity__list';
      activityWidget.appendChild(floatingActivityListEl);
      mapViewport.appendChild(activityWidget);

      const activityHeader = activityWidget.querySelector('.gis-floating-activity__header');
      const collapseBtn = activityWidget.querySelector('.gis-floating-activity__toggle');
      const toggleCollapse = () => {
        const isCollapsed = activityWidget.classList.toggle('is-collapsed');
        const label = isCollapsed ? 'Expand Live Activity' : 'Collapse Live Activity';
        collapseBtn.setAttribute('aria-label', label);
        collapseBtn.title = label;
        activityHeader.setAttribute('aria-expanded', String(!isCollapsed));
      };

      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapse();
      });

      activityHeader.addEventListener('click', () => {
        toggleCollapse();
      });

      activityHeader.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleCollapse();
        }
      });

      // Floating Map Legend Widget (Bottom-Left of Map)
      const legendWidget = document.createElement('div');
      legendWidget.className = 'gis-floating-legend';
      legendWidget.innerHTML = `
        <div class="gis-floating-legend__title">Map Legend</div>
        <div class="gis-floating-legend__row">
          <span class="gis-floating-legend__dot gis-floating-legend__dot--available"></span>
          <span>Available Tanod</span>
        </div>
        <div class="gis-floating-legend__row">
          <span class="gis-floating-legend__dot gis-floating-legend__dot--dispatched"></span>
          <span>Dispatched / En Route</span>
        </div>
        <div class="gis-floating-legend__row">
          <span class="gis-floating-legend__dot gis-floating-legend__dot--emergency"></span>
          <span>Emergency Incident</span>
        </div>
      `;
      mapViewport.appendChild(legendWidget);

      layoutEl.append(sidebar, mapCard);
      container.appendChild(layoutEl);

      liveMap = LiveMap(mapViewport, { showNavControl: false });
    }

    // ── Update 3 Mini Status Cards ──
    statCardsEl.innerHTML = `
      <div class="gis-mini-stat gis-mini-stat--available ${rosterFilter === 'available' ? 'is-active' : ''}" data-filter="available">
        <div class="gis-mini-stat__value">${availableCount}</div>
        <div class="gis-mini-stat__label">Available</div>
      </div>
      <div class="gis-mini-stat gis-mini-stat--dispatched ${rosterFilter === 'dispatched' ? 'is-active' : ''}" data-filter="dispatched">
        <div class="gis-mini-stat__value">${dispatchedCount}</div>
        <div class="gis-mini-stat__label">Dispatched</div>
      </div>
      <div class="gis-mini-stat gis-mini-stat--active ${rosterFilter === 'active' ? 'is-active' : ''}" data-filter="active">
        <div class="gis-mini-stat__value">${activeAlertsCount}</div>
        <div class="gis-mini-stat__label">Active</div>
      </div>
    `;

    statCardsEl.querySelectorAll('.gis-mini-stat').forEach((card) => {
      card.addEventListener('click', () => {
        const filter = card.getAttribute('data-filter');
        if (rosterFilter === filter) {
          rosterFilter = 'all';
        } else {
          rosterFilter = filter;
        }
        updateMiniStatCardsSelection();
        renderCurrentRosterAndMap();
      });
    });

    function updateMiniStatCardsSelection() {
      statCardsEl.querySelectorAll('.gis-mini-stat').forEach((card) => {
        card.classList.toggle('is-active', card.getAttribute('data-filter') === rosterFilter);
      });
    }

    // ── Update Filter Bar Badge & Subtitle ──
    const activeFiltersCount = rosterFilter === 'all' ? 0 : 1;
    filterBadgeEl.textContent = activeFiltersCount > 0 ? `${rosterFilter.toUpperCase()} filter active` : 'All filter active';

    mapSubtitleEl.textContent = `Monitoring ${gpsItems.length} field personnel across Pilar barangays`;

    renderCurrentRosterAndMap = renderRosterAndMap;
    renderRosterAndMap();
    renderActivityFeed(floatingActivityListEl, dispatches, dutyStatuses, openSos, gpsItems);

    function renderRosterAndMap() {
      const filtered = gpsItems.filter((g) => {
        const isDisp = dispatchedIds.has(g.userId);
        const isOnDuty = onDutyIds.has(g.userId);
        if (rosterFilter === 'available') return isOnDuty && !isDisp;
        if (rosterFilter === 'dispatched') return isDisp;
        if (rosterFilter === 'active') return isDisp || openSos.some((s) => s.userId === g.userId);
        if (rosterFilter === 'stale') return g.isStale;
        return true;
      });

      personnelHeaderEl.textContent = `FIELD PERSONNEL (${filtered.length})`;

      // Map Markers
      liveMap.setMarkers(filtered.map((g) => ({
        userId: g.userId,
        fullName: g.fullName,
        latitude: g.latitude,
        longitude: g.longitude,
        ageSeconds: g.ageSeconds,
        isStale: g.isStale,
        status: dispatchedIds.has(g.userId) ? 'dispatched' : 'available',
        isDispatched: dispatchedIds.has(g.userId),
      })));
      liveMap.setSosMarkers(openSos.map((s) => ({ sosId: s.sosId, latitude: s.latitude, longitude: s.longitude, status: s.status })));

      // Render Field Personnel Cards
      personnelListEl.innerHTML = '';
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'note';
        empty.style.padding = '1.5rem 0.5rem';
        empty.style.textAlign = 'center';
        empty.textContent = gpsItems.length === 0
          ? 'No Tanod locations reported yet.'
          : 'No personnel match the selected filter.';
        personnelListEl.appendChild(empty);
        return;
      }

      for (const g of filtered) {
        const isDispatched = dispatchedIds.has(g.userId);
        const dispatchObj = dispatchedMap.get(g.userId);
        const tanodUser = tanodRosterById.get(g.userId);
        const badgeCode = tanodUser?.badgeNumber || `T-${String(g.userId).padStart(3, '0')}`;
        const locationText = tanodUser?.barangayName ? `Brgy. ${tanodUser.barangayName}` : 'Brgy. Dao';

        const card = document.createElement('div');
        card.className = 'gis-personnel-card';
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Center map on ${g.fullName}`);

        const avatarModifier = g.isStale
          ? 'gis-personnel-card__avatar--stale'
          : isDispatched
            ? 'gis-personnel-card__avatar--dispatched'
            : 'gis-personnel-card__avatar--available';

        const statusClass = g.isStale
          ? 'gis-personnel-card__status-pill--stale'
          : isDispatched
            ? 'gis-personnel-card__status-pill--dispatched'
            : 'gis-personnel-card__status-pill--available';

        const statusText = g.isStale
          ? 'STALE'
          : isDispatched
            ? 'DISPATCHED'
            : 'AVAILABLE';

        const incidentBadgeHtml = (isDispatched && dispatchObj)
          ? `<span class="gis-personnel-card__incident-pill">INC-${String(dispatchObj.incidentId).padStart(3, '0')}</span>`
          : '';

        const contactNumber = tanodUser?.contactNumber;
        const callBtnHtml = contactNumber
          ? `<a href="tel:${contactNumber}" class="gis-personnel-card__phone-btn" title="Call ${g.fullName}" aria-label="Call ${g.fullName}" onclick="event.stopPropagation()">${icons.phone(16)}</a>`
          : `<span class="gis-personnel-card__phone-btn" style="opacity:0.3;" title="No phone on file">${icons.phone(16)}</span>`;

        card.innerHTML = `
          <div class="gis-personnel-card__left">
            <div class="gis-personnel-card__avatar ${avatarModifier}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
            </div>
            <div class="gis-personnel-card__info">
              <div class="gis-personnel-card__name">${escapeHtml(g.fullName)}</div>
              <div class="gis-personnel-card__tag">${escapeHtml(badgeCode)}</div>
              <div class="gis-personnel-card__location">
                ${icons.mapPin(13)}
                <span>${escapeHtml(locationText)}</span>
              </div>
              <div class="gis-personnel-card__pills">
                <span class="gis-personnel-card__status-pill ${statusClass}">${statusText}</span>
                ${incidentBadgeHtml}
              </div>
            </div>
          </div>
          ${callBtnHtml}
        `;

        card.addEventListener('click', () => {
          personnelListEl.querySelectorAll('.gis-personnel-card').forEach((c) => c.classList.remove('is-selected'));
          card.classList.add('is-selected');
          if (g.latitude && g.longitude) {
            liveMap?.flyTo(Number(g.latitude), Number(g.longitude));
          }
        });

        personnelListEl.appendChild(card);
      }
    }
  }

  /**
   * Client-side derived event feed matching the live activity card in the sample image
   */
  function renderActivityFeed(container, dispatches, dutyStatuses, openSos, gpsItems) {
    if (!container) return;
    const gpsNameById = new Map(gpsItems.map((g) => [g.userId, g.fullName]));
    const resolveName = (id) => {
      const u = tanodRosterById.get(id);
      if (u) {
        const badge = u.badgeNumber || `T-${String(u.userId).padStart(3, '0')}`;
        return badge;
      }
      return `T-${String(id).padStart(3, '0')}`;
    };

    const events = [];
    for (const d of dispatches) {
      const code = resolveName(d.tanodId);
      const incCode = `INC-${String(d.incidentId).padStart(3, '0')}`;
      if (d.dispatchedAt) {
        events.push({
          ts: d.dispatchedAt,
          tone: 'info',
          text: `${code} dispatched to ${incCode}`,
        });
      }
      if (d.arrivedAt) {
        events.push({
          ts: d.arrivedAt,
          tone: 'info',
          text: `${code} arrived at incident location`,
        });
      }
      if (d.completedAt) {
        events.push({
          ts: d.completedAt,
          tone: 'success',
          text: `${code} completed ${incCode}`,
        });
      }
      if (d.cancelledAt) {
        events.push({
          ts: d.cancelledAt,
          tone: 'neutral',
          text: `Dispatch for ${code} on ${incCode} cancelled`,
        });
      }
    }

    for (const s of dutyStatuses) {
      const code = resolveName(s.userId);
      const label = DUTY_EVENT_LABEL[s.status];
      if (label) {
        events.push({
          ts: s.changedAt,
          tone: s.status === 'on_duty' ? 'success' : 'neutral',
          text: `${code} ${label}`,
        });
      }
    }

    for (const s of openSos) {
      const code = resolveName(s.userId);
      events.push({
        ts: s.triggeredAt,
        tone: 'critical',
        text: `New SOS alert from ${code} in Brgy. Dao`,
      });
    }

    events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const recent = events.slice(0, ACTIVITY_FEED_LIMIT);

    container.innerHTML = '';
    if (recent.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'note';
      empty.style.padding = '0.5rem';
      empty.style.textAlign = 'center';
      empty.textContent = 'No recent activity to show.';
      container.appendChild(empty);
      return;
    }

    for (const event of recent) {
      const item = document.createElement('div');
      item.className = 'gis-floating-activity__item';

      const dotModifier = `gis-floating-activity__dot--${event.tone || 'info'}`;
      const elapsed = formatElapsed(event.ts);

      item.innerHTML = `
        <div class="gis-floating-activity__text-row">
          <span class="gis-floating-activity__dot ${dotModifier}"></span>
          <span class="gis-floating-activity__desc">${escapeHtml(event.text)}</span>
        </div>
        <div class="gis-floating-activity__time">${escapeHtml(elapsed)}</div>
      `;

      container.appendChild(item);
    }
  }

  return { stop: stopPolling };
}

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

function renderLoading(container) {
  container.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'gis-layout';
  page.setAttribute('role', 'status');
  page.setAttribute('aria-label', 'Loading live tracking');
  page.innerHTML = `
    <div class="gis-sidebar">
      <div class="skeleton" style="height: 3rem; margin-bottom: 0.5rem;"></div>
      <div class="skeleton" style="height: 4.5rem; margin-bottom: 0.5rem;"></div>
      <div class="skeleton" style="height: 2.5rem; margin-bottom: 0.5rem;"></div>
      <div class="skeleton" style="flex: 1; min-height: 20rem;"></div>
    </div>
    <div class="skeleton gis-page__map-wrapper--fill" style="border-radius: var(--radius-xl, 16px);"></div>
  `;
  container.appendChild(page);
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
