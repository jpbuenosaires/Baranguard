/**
 * main.js — app bootstrap/router. No framework (§1), so this is a small
 * hand-rolled state machine rather than a router library: show the login
 * page if there's no valid session, otherwise show whichever built
 * screen the caller's role/current page selection allows, or an honest
 * "not built yet" message for any role with no built screen at all
 * (Tanod — mobile-only, §6 doesn't gate login by role so a Tanod account
 * can still authenticate here, it just has no web screen to land on).
 *
 * `currentPage` is in-memory only (no URL routing exists yet in this
 * vanilla-JS, no-bundler stack) — a reload always returns to the default
 * page for the role. The one exception is `#/citizen-report` (W19): a
 * hash fragment never reaches the server, so it works as a zero-config
 * public entry point on the same index.html without needing a real
 * server-side route — checked before the session-gated boot() below,
 * since W19 is reachable with no session at all.
 */

import { getSession, logout } from './api/apiClient.js';
import { renderLoginPage } from './pages/login.js';
import { renderAdminDashboardPage } from './pages/admin-dashboard.js';
import { renderDispatchCenterPage } from './pages/dispatch-center.js';
import { renderGisLiveTrackingPage } from './pages/gis-live-tracking.js';
import { renderHistoricalHeatmapPage } from './pages/historical-heatmap.js';
import { renderBlotterListPage } from './pages/blotter-list.js';
import { renderStatisticalReportsPage } from './pages/statistical-reports.js';
import { renderSettingsPage } from './pages/settings.js';
import { renderCitizenReportsInboxPage } from './pages/citizen-reports-inbox.js';
import { renderCitizenReportPage } from './pages/citizen-report.js';
import { renderSchedulerPage } from './pages/scheduler.js';
import { renderSwapRequestsPage } from './pages/swap-requests.js';
import { renderFatigueFlagsPage } from './pages/fatigue-flags.js';

const PAGE_ROLES = {
  dashboard: ['admin', 'punong_barangay'],
  dispatch: ['admin'],
  gis: ['admin', 'punong_barangay'],
  heatmap: ['admin', 'punong_barangay'],
  blotter: ['admin', 'secretary', 'punong_barangay'],
  reports: ['admin', 'punong_barangay'],
  'citizen-inbox': ['admin', 'secretary'],
  scheduler: ['admin'],
  'swap-requests': ['admin'],
  fatigue: ['admin', 'punong_barangay'],
  settings: ['admin', 'secretary', 'punong_barangay'],
};

let activeStop = null;

function boot(currentPage) {
  if (activeStop) {
    activeStop();
    activeStop = null;
  }

  const root = document.getElementById('app');
  const session = getSession();

  if (!session) {
    renderLoginPage(root, () => boot());
    return;
  }

  const role = session.user.role;
  let page = currentPage;
  if (!page || !PAGE_ROLES[page]?.includes(role)) {
    page = Object.keys(PAGE_ROLES).find((key) => PAGE_ROLES[key].includes(role)) ?? null;
  }

  if (page === null) {
    renderUnavailable(root, session.user);
    return;
  }

  const navigate = (nextPage) => boot(nextPage);
  const onLoggedOut = () => boot();

  if (page === 'dashboard') {
    renderAdminDashboardPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'dispatch') {
    renderDispatchCenterPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'gis') {
    const handle = renderGisLiveTrackingPage(root, session.user, onLoggedOut, navigate);
    activeStop = handle?.stop ?? null;
  } else if (page === 'heatmap') {
    renderHistoricalHeatmapPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'blotter') {
    renderBlotterListPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'reports') {
    renderStatisticalReportsPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'citizen-inbox') {
    renderCitizenReportsInboxPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'scheduler') {
    renderSchedulerPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'swap-requests') {
    renderSwapRequestsPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'fatigue') {
    renderFatigueFlagsPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'settings') {
    renderSettingsPage(root, session.user, onLoggedOut, navigate);
  }
}

function renderUnavailable(root, user) {
  root.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'login-page';
  const card = document.createElement('div');
  card.className = 'card login-card state-block';
  const heading = document.createElement('h3');
  heading.textContent = `Signed in as ${user.fullName}`;
  const text = document.createElement('p');
  text.textContent = `The ${user.role.replace('_', ' ')} role has no built web screen yet.`;
  const signOutButton = document.createElement('button');
  signOutButton.className = 'primary';
  signOutButton.textContent = 'Sign out';
  signOutButton.addEventListener('click', async () => {
    await logout();
    boot();
  });
  card.append(heading, text, signOutButton);
  page.appendChild(card);
  root.appendChild(page);
}

if (window.location.hash.startsWith('#/citizen-report')) {
  renderCitizenReportPage(document.getElementById('app'));
} else {
  boot();
}
