/**
 * main.js — app bootstrap/router. No framework (§1), so this is a small
 * hand-rolled state machine rather than a router library: show the login
 * page if there's no valid session, otherwise show the one screen built
 * so far (W2 Admin Dashboard) for the roles §9 grants it to, or an honest
 * "not built yet" message for any other role that successfully signs in
 * (Secretary, Tanod can authenticate — §6 doesn't gate login by role,
 * only lupon is blocked at the account level — but Sprint 1 hasn't built
 * their screens yet; showing nothing/blank would be worse than saying so).
 */

import { getSession, logout } from './api/apiClient.js';
import { renderLoginPage } from './pages/login.js';
import { renderAdminDashboardPage } from './pages/admin-dashboard.js';

const DASHBOARD_ROLES = ['admin', 'punong_barangay'];

function boot() {
  const root = document.getElementById('app');
  const session = getSession();

  if (!session) {
    renderLoginPage(root, () => boot());
    return;
  }

  if (DASHBOARD_ROLES.includes(session.user.role)) {
    renderAdminDashboardPage(root, session.user, () => boot());
    return;
  }

  renderUnavailable(root, session.user);
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
  text.textContent = `The ${user.role.replace('_', ' ')} screens haven't been built yet — only the Admin Dashboard exists so far.`;
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
