/**
 * gis-live-tracking.js — W4 GIS Live Tracking (§9): "Shows freshness
 * (age_seconds, stale badge) on every responder marker. A stale location
 * is not visually presented as live. SOS markers remain visible above
 * ordinary map filters." Roles: Admin, Punong Barangay (read-only) — §7
 * "View live tracking": Admin full, PB read-only; since this screen has
 * no write action, both roles just render the same GET calls.
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

import { getGpsLive, getTanodSos, logout, ApiClientError } from '../api/apiClient.js';
import { LiveMap } from '../components/LiveMap.js';
import { AppShell } from '../components/AppShell.js';
import { icons } from '../components/icons.js';

const POLL_INTERVAL_MS = 15000;

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 * @returns {{stop: () => void}}
 */
export function renderGisLiveTrackingPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'gis', navigate, async () => {
    shell.logoutButton.disabled = true;
    stopPolling();
    await logout();
    onLoggedOut();
  });
  const { content } = shell;
  root.appendChild(shell.el);

  content.innerHTML = `<h2 style="margin-bottom:16px; display:flex; align-items:center; gap:10px;">${icons.map(22)}GIS Live Tracking</h2>`;
  const body = document.createElement('div');
  body.style.cssText = 'height:calc(100% - 40px); min-height:0;';
  content.appendChild(body);

  let liveMap = null;
  let timer = null;

  load(true);
  timer = setInterval(() => load(false), POLL_INTERVAL_MS);

  function stopPolling() {
    if (timer) clearInterval(timer);
    if (liveMap) liveMap.destroy();
  }

  async function load(showLoadingState) {
    if (showLoadingState) renderLoading(body);
    try {
      const [gpsItems, sosItems] = await Promise.all([
        getGpsLive(user.barangayId),
        getTanodSos({}).catch(() => []),
      ]);
      const openSos = sosItems.filter((s) => s.status !== 'resolved');
      renderPopulated(body, gpsItems, openSos);
    } catch (err) {
      // A background poll failure shouldn't nuke an already-populated
      // map — only show the Error state on the very first load.
      if (showLoadingState) {
        const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading live tracking.';
        renderError(body, message, () => load(true));
      }
    }
  }

  function renderPopulated(container, gpsItems, openSos) {
    if (!liveMap) {
      container.innerHTML = '';
      const page = document.createElement('div');
      page.className = 'gis-page';

      const mapWrapper = document.createElement('div');
      mapWrapper.className = 'gis-page__map-wrapper';

      const legend = document.createElement('div');
      legend.className = 'live-map__legend';
      legend.innerHTML = `
        <div class="live-map__legend-row"><span class="live-map__legend-dot" style="background:var(--color-success);"></span> On duty (live)</div>
        <div class="live-map__legend-row"><span class="live-map__legend-dot" style="background:var(--color-text-secondary);"></span> Stale (≥120s)</div>
        <div class="live-map__legend-row"><span class="live-map__legend-dot" style="background:var(--color-critical);"></span> SOS</div>
      `;
      mapWrapper.appendChild(legend);

      const roster = document.createElement('div');
      roster.className = 'card gis-roster';
      roster.style.marginTop = '16px';

      page.append(mapWrapper, roster);
      container.appendChild(page);

      liveMap = LiveMap(mapWrapper);
      container._roster = roster;
    }

    liveMap.setMarkers(gpsItems.map((g) => ({
      userId: g.userId, fullName: g.fullName, latitude: g.latitude, longitude: g.longitude,
      ageSeconds: g.ageSeconds, isStale: g.isStale,
    })));
    liveMap.setSosMarkers(openSos.map((s) => ({ sosId: s.sosId, latitude: s.latitude, longitude: s.longitude, status: s.status })));

    const roster = container._roster;
    roster.innerHTML = '';
    if (gpsItems.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'label';
      empty.style.cssText = 'text-transform:none; font-weight:400;';
      empty.textContent = 'No Tanod locations have been reported yet.';
      roster.appendChild(empty);
    } else {
      for (const g of gpsItems) {
        const row = document.createElement('div');
        row.className = 'gis-roster__row';
        const pillClass = g.isStale ? 'status-pill--neutral' : 'status-pill--success';
        const ageLabel = formatAge(g.ageSeconds);
        row.innerHTML = `<span>${g.fullName}</span><span class="status-pill ${pillClass}">${g.isStale ? 'Stale' : 'Live'} · ${ageLabel}</span>`;
        roster.appendChild(row);
      }
    }
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
  const mapSkeleton = document.createElement('div');
  mapSkeleton.className = 'skeleton gis-page__map-wrapper';
  const rosterSkeleton = document.createElement('div');
  rosterSkeleton.className = 'skeleton';
  rosterSkeleton.style.cssText = 'height:80px; margin-top:16px; border-radius:12px;';
  page.append(mapSkeleton, rosterSkeleton);
  container.appendChild(page);
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
