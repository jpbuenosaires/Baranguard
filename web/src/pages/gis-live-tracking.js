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
import { StatStrip } from '../components/StatStrip.js';
import { icons } from '../components/icons.js';
import { avatarInitials } from '../components/Avatar.js';

const POLL_INTERVAL_MS = 15000;
const ACTIVE_DISPATCH_STATUSES = ['assigned', 'en_route', 'arrived'];
const ROSTER_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'available', label: 'Available' },
  { key: 'dispatched', label: 'Dispatched' },
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

  const pageHeader = PageHeader({ title: 'GIS Live Tracking', subtitle: 'Real-time Tanod locations and SOS alerts', icon: icons.map });
  header.appendChild(pageHeader.el);

  const wrapper = document.createElement('div');
  wrapper.className = 'flex-col grow';
  content.appendChild(wrapper);
  const body = document.createElement('div');
  body.className = 'grow';
  wrapper.appendChild(body);

  let liveMap = null;
  let timer = null;
  let rosterFilter = 'all';
  // The filter chips are created ONCE (see `if (!liveMap)` below) but
  // `renderPopulated` re-runs every poll — their click handler must call
  // THIS render cycle's roster-render closure, not the one captured when
  // the chip was first built, or a filter click after the first poll
  // would silently filter stale data forever. Reassigned at the bottom
  // of every `renderPopulated` call.
  let renderCurrentRosterAndMap = () => {};
  // Admin-only: fullName + contactNumber keyed by userId, for the Call
  // button. Never fetched for PB — `GET /users` is Admin-only server-side
  // (see this file's own header), so a PB session simply never calls it.
  let tanodRosterById = new Map();

  load(true);
  timer = setInterval(() => load(false), POLL_INTERVAL_MS);

  function stopPolling() {
    if (timer) clearInterval(timer);
    if (liveMap) liveMap.destroy();
  }

  async function load(showLoadingState) {
    if (showLoadingState) renderLoading(body);
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
      // A background poll failure shouldn't nuke an already-populated
      // map — only show the Error state on the very first load.
      if (showLoadingState) {
        const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading live tracking.';
        renderError(body, message, () => load(true));
      }
    }
  }

  function renderPopulated(container, gpsItems, openSos, dutyStatuses, dispatches) {
    const onDutyIds = new Set(dutyStatuses.filter((d) => d.status === 'on_duty').map((d) => d.userId));
    const dispatchedIds = new Set(dispatches.filter((d) => ACTIVE_DISPATCH_STATUSES.includes(d.status)).map((d) => d.tanodId));
    const availableCount = [...onDutyIds].filter((id) => !dispatchedIds.has(id)).length;
    const staleCount = gpsItems.filter((g) => g.isStale).length;

    // This wipes the actions slot on every render, matching the pattern
    // dispatch-center.js already uses for its own always-current stats.
    pageHeader.actions.innerHTML = '';
    pageHeader.actions.appendChild(StatStrip({
      items: [
        { label: 'Available', value: availableCount },
        { label: 'Dispatched', value: dispatchedIds.size, tone: 'info' },
        { label: 'Stale', value: staleCount, tone: staleCount > 0 ? 'critical' : 'default' },
      ],
    }));

    if (!liveMap) {
      container.innerHTML = '';
      const page = document.createElement('div');
      page.className = 'gis-page';

      const mapWrapper = document.createElement('div');
      mapWrapper.className = 'gis-page__map-wrapper';

      const legend = document.createElement('div');
      legend.className = 'live-map__legend';
      legend.innerHTML = `
        <div class="live-map__legend-row"><span class="live-map__legend-dot" style="background:var(--color-success-solid);"></span> On duty (live)</div>
        <div class="live-map__legend-row"><span class="live-map__legend-dot" style="background:var(--color-text-secondary);"></span> Stale (≥120s)</div>
        <div class="live-map__legend-row"><span class="live-map__legend-dot" style="background:var(--color-critical-solid);"></span> SOS</div>
      `;
      mapWrapper.appendChild(legend);

      const filterRow = document.createElement('div');
      filterRow.className = 'filter-chip-row gis-page__filters';
      const filterChips = {};
      for (const { key, label } of ROSTER_FILTERS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'filter-chip';
        chip.textContent = label;
        chip.addEventListener('click', () => {
          rosterFilter = key;
          for (const [k, c] of Object.entries(filterChips)) c.classList.toggle('is-active', k === key);
          renderCurrentRosterAndMap();
        });
        filterChips[key] = chip;
        filterRow.appendChild(chip);
      }
      filterChips.all.classList.add('is-active');

      const roster = document.createElement('div');
      roster.className = 'card gis-roster gis-page__roster';

      const activityCard = document.createElement('div');
      activityCard.className = 'card gis-activity';

      page.append(mapWrapper, filterRow, roster, activityCard);
      container.appendChild(page);

      liveMap = LiveMap(mapWrapper);
      container._roster = roster;
      container._activityCard = activityCard;
    }

    renderCurrentRosterAndMap = renderRosterAndMap;
    renderRosterAndMap();
    renderActivityFeed(container._activityCard, dispatches, dutyStatuses, openSos, gpsItems);

    function renderRosterAndMap() {
      const filtered = gpsItems.filter((g) => {
        if (rosterFilter === 'available') return onDutyIds.has(g.userId) && !dispatchedIds.has(g.userId);
        if (rosterFilter === 'dispatched') return dispatchedIds.has(g.userId);
        if (rosterFilter === 'stale') return g.isStale;
        return true;
      });

      liveMap.setMarkers(filtered.map((g) => ({
        userId: g.userId, fullName: g.fullName, latitude: g.latitude, longitude: g.longitude,
        ageSeconds: g.ageSeconds, isStale: g.isStale,
      })));
      liveMap.setSosMarkers(openSos.map((s) => ({ sosId: s.sosId, latitude: s.latitude, longitude: s.longitude, status: s.status })));

      const roster = container._roster;
      roster.innerHTML = '';
      if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'note';
        empty.textContent = gpsItems.length === 0
          ? 'No Tanod locations have been reported yet.'
          : 'No Tanods match this filter.';
        roster.appendChild(empty);
        return;
      }
      for (const g of filtered) {
        const row = document.createElement('div');
        row.className = 'gis-roster__row';

        // audit W4: roster and map were unlinked — a name in the list and
        // a dot on the map had no relationship you could act on. A real
        // <button> rather than a click handler on a div, so it is
        // keyboard-operable and announced as activatable.
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'gis-roster__row-main';
        const pillClass = g.isStale ? 'status-pill--neutral' : 'status-pill--success';
        const ageLabel = formatAge(g.ageSeconds);
        main.innerHTML = `<span class="avatar-row">${avatarInitials(g.fullName, 24)}${g.fullName}</span><span class="status-pill ${pillClass}">${g.isStale ? 'Stale' : 'Live'} · ${ageLabel}</span>`;
        main.setAttribute('aria-label', `Centre map on ${g.fullName}`);
        main.addEventListener('click', () => liveMap?.flyTo(Number(g.latitude), Number(g.longitude)));
        row.appendChild(main);

        // Admin-only Call action — `tanodRosterById` is only ever
        // populated for Admin (see load()), so this silently doesn't
        // render for PB rather than showing a dead button.
        const contactNumber = tanodRosterById.get(g.userId)?.contactNumber;
        if (contactNumber) {
          const callLink = document.createElement('a');
          callLink.href = `tel:${contactNumber}`;
          callLink.className = 'ghost gis-roster__call';
          callLink.setAttribute('aria-label', `Call ${g.fullName}`);
          callLink.innerHTML = icons.phone(16);
          row.appendChild(callLink);
        }

        roster.appendChild(row);
      }
    }
  }

  /**
   * Client-side derived event feed (see this file's own header for why
   * this isn't a new backend endpoint) — each dispatch's own stage
   * timestamps, each duty_status row's changed_at, each SOS's
   * triggered_at, merged and sorted newest-first. Names resolve from the
   * Admin-only tanod roster when available, falling back to the GPS
   * roster's own fullName (covers PB, and any Tanod GPS has seen even
   * without the Admin-only roster), and finally to a bare "Tanod #id" —
   * the same graceful-fallback pattern dispatch-center.js's SOS banner
   * already uses.
   */
  function renderActivityFeed(container, dispatches, dutyStatuses, openSos, gpsItems) {
    const gpsNameById = new Map(gpsItems.map((g) => [g.userId, g.fullName]));
    const resolveName = (id) => tanodRosterById.get(id)?.fullName || gpsNameById.get(id) || `Tanod #${id}`;

    const events = [];
    for (const d of dispatches) {
      const name = resolveName(d.tanodId);
      if (d.dispatchedAt) events.push({ ts: d.dispatchedAt, text: `${name} dispatched to incident #${d.incidentId}` });
      if (d.arrivedAt) events.push({ ts: d.arrivedAt, text: `${name} arrived at incident #${d.incidentId}` });
      if (d.completedAt) events.push({ ts: d.completedAt, text: `${name} completed incident #${d.incidentId}` });
      if (d.cancelledAt) events.push({ ts: d.cancelledAt, text: `Dispatch for ${name} on incident #${d.incidentId} was cancelled` });
    }
    for (const s of dutyStatuses) {
      const label = DUTY_EVENT_LABEL[s.status];
      if (label) events.push({ ts: s.changedAt, text: `${resolveName(s.userId)} ${label}` });
    }
    for (const s of openSos) {
      events.push({ ts: s.triggeredAt, text: `SOS alert from ${resolveName(s.userId)}` });
    }

    events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const recent = events.slice(0, ACTIVITY_FEED_LIMIT);

    container.innerHTML = '';
    const heading = document.createElement('h3');
    heading.textContent = 'Live Activity';
    container.appendChild(heading);

    if (recent.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = 'No recent activity to show.';
      container.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'stack gis-activity__list';
    for (const event of recent) {
      const row = document.createElement('div');
      row.className = 'gis-activity__row';
      const text = document.createElement('span');
      text.textContent = event.text;
      const time = document.createElement('span');
      time.className = 'note';
      time.textContent = formatAge(Math.max(0, Math.round((Date.now() - new Date(event.ts).getTime()) / 1000)));
      row.append(text, time);
      list.appendChild(row);
    }
    container.appendChild(list);
  }

  return { stop: stopPolling };
}

function formatAge(ageSeconds) {
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function renderLoading(container) {
  container.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'gis-page';
  page.setAttribute('role', 'status');
  page.setAttribute('aria-label', 'Loading live tracking');
  const mapSkeleton = document.createElement('div');
  mapSkeleton.className = 'skeleton gis-page__map-wrapper';
  const rosterSkeleton = document.createElement('div');
  rosterSkeleton.className = 'skeleton';
  rosterSkeleton.classList.add('skeleton--roster');
  page.append(mapSkeleton, rosterSkeleton);
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
