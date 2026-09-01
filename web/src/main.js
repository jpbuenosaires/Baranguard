/**
 * main.js — app bootstrap/router. No framework (§1), so this is a small
 * hand-rolled state machine rather than a router library: show the login
 * page if there's no valid session, otherwise show whichever of the
 * three built screens (W2 Dashboard, W3 Dispatch Center, W4 Live
 * Tracking) the caller's role/current page selection allows, or an
 * honest "not built yet" message for any other role that successfully
 * signs in (Secretary, Tanod can authenticate — §6 doesn't gate login by
 * role, only lupon is blocked at the account level — but their own
 * screens aren't built yet; showing nothing/blank would be worse than
 * saying so).
 *
 * `currentPage` is in-memory only (no URL routing exists yet in this
 * vanilla-JS, no-bundler stack) — a reload always returns to the default
 * page for the role, same as before this session when only one screen
 * existed.
 */

import { getSession, logout } from './api/apiClient.js';
import { renderLoginPage } from './pages/login.js';
import { renderAdminDashboardPage } from './pages/admin-dashboard.js';
import { renderDispatchCenterPage } from './pages/dispatch-center.js';
import { renderGisLiveTrackingPage } from './pages/gis-live-tracking.js';

const PAGE_ROLES = {
  dashboard: ['admin', 'punong_barangay'],
  dispatch: ['admin'],
  gis: ['admin', 'punong_barangay'],
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
  text.textContent = `The ${user.role.replace('_', ' ')} screens haven't been built yet — only the Admin/Punong Barangay screens exist so far.`;
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

boot();
