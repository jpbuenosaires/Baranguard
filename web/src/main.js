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
import { renderIncidentManagementPage } from './pages/incident-management.js';
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
import { renderAiReviewPage } from './pages/ai-review.js';
import { renderBlotterDetailPage } from './pages/blotter-detail.js';
import { renderSmsLogPage } from './pages/sms-log.js';
import { renderAuditLogPage } from './pages/audit-log.js';
import { renderServiceHealthPage } from './pages/service-health.js';
import { DEFAULT_PAGE_KEY } from './pages/settings.js';

const PAGE_ROLES = {
  dashboard: ['admin', 'punong_barangay'],
  dispatch: ['admin'],
  'incident-management': ['admin', 'secretary'],
  gis: ['admin', 'punong_barangay'],
  heatmap: ['admin', 'punong_barangay'],
  blotter: ['admin', 'secretary', 'punong_barangay'],
  reports: ['admin', 'punong_barangay'],
  'citizen-inbox': ['admin', 'secretary'],
  scheduler: ['admin'],
  'swap-requests': ['admin'],
  fatigue: ['admin', 'punong_barangay'],
  // §9 W14 — Admin only, explicitly.
  'sms-log': ['admin'],
  // §9 W17 and W20 — both Admin only, explicitly.
  'audit-log': ['admin'],
  'service-health': ['admin'],
  settings: ['admin', 'secretary', 'punong_barangay'],
  // W8 is a per-incident DETAIL view, not a destination in its own right:
  // it needs an incident id, so it has no sidebar entry and is reached by
  // clicking a row in W6 Electronic Blotter. Listed here purely so the
  // role gate below covers it.
  'ai-review': ['secretary'],
  // W7 Electronic Blotter Detail — also a per-incident detail view. Every
  // role that can see the blotter list can open an entry; the finalize/
  // amend controls inside are Secretary-only, and the server enforces that
  // independently (§2 Rule 6: client-side hiding is UX, not a boundary).
  'blotter-detail': ['admin', 'secretary', 'punong_barangay'],
};

// Pages that cannot render without a parameter — never chosen as a role's
// default landing page, since there is no id to land on.
const DETAIL_PAGES = new Set(['ai-review', 'blotter-detail']);

let activeStop = null;

function boot(currentPage, param) {
  if (activeStop) {
    activeStop();
    activeStop = null;
  }

  const root = document.getElementById('app');
  const session = getSession();

  if (!session) {
    renderLoginPage(root, () => boot());
    document.title = 'Sign in — Baranguard';
    return;
  }

  const role = session.user.role;
  let page = currentPage;
  if (!page || !PAGE_ROLES[page]?.includes(role)) {
    // W15 Settings > Appearance > Default landing page — a real per-user
    // preference, honoured only when it names a page this role can
    // actually see; otherwise falls back to the normal first-match.
    let preferred = null;
    try { preferred = localStorage.getItem(DEFAULT_PAGE_KEY); } catch { /* private mode */ }
    page = (preferred && PAGE_ROLES[preferred]?.includes(role) && !DETAIL_PAGES.has(preferred))
      ? preferred
      : Object.keys(PAGE_ROLES).find((key) => PAGE_ROLES[key].includes(role) && !DETAIL_PAGES.has(key)) ?? null;
  }
  // A detail page reached without its parameter (e.g. a stray navigate)
  // falls back rather than rendering a broken screen.
  if (DETAIL_PAGES.has(page) && param === undefined) {
    page = Object.keys(PAGE_ROLES).find(
      (key) => PAGE_ROLES[key].includes(role) && !DETAIL_PAGES.has(key)
    ) ?? null;
  }

  if (page === null) {
    renderUnavailable(root, session.user);
    return;
  }

  const navigate = (nextPage, nextParam) => boot(nextPage, nextParam);
  const onLoggedOut = () => boot();

  if (page === 'dashboard') {
    renderAdminDashboardPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'dispatch') {
    // Returns a stop handle now that W3 polls its queue every 15s (audit
    // W3) — same contract the GIS and AI Review pages already use.
    const handle = renderDispatchCenterPage(root, session.user, onLoggedOut, navigate);
    activeStop = handle?.stop ?? null;
  } else if (page === 'incident-management') {
    renderIncidentManagementPage(root, session.user, onLoggedOut, navigate);
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
  } else if (page === 'sms-log') {
    renderSmsLogPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'audit-log') {
    renderAuditLogPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'service-health') {
    // Returns a stop handle: W20 re-checks health every 30s and that
    // interval must not outlive the page.
    const handle = renderServiceHealthPage(root, session.user, onLoggedOut, navigate);
    activeStop = handle?.stop ?? null;
  } else if (page === 'settings') {
    renderSettingsPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'blotter-detail') {
    renderBlotterDetailPage(root, session.user, onLoggedOut, navigate, param);
  } else if (page === 'ai-review') {
    // Returns a stop handle: W8 polls the AI draft while a job is queued,
    // and that interval must not outlive the page (same contract the GIS
    // page already uses).
    const handle = renderAiReviewPage(root, session.user, onLoggedOut, navigate, param);
    activeStop = handle?.stop ?? null;
  }

  setDocumentTitle(root);
  focusPageHeading(root);
}

/**
 * audit A6: document.title was never touched, so every screen, every
 * history entry and every bookmark read "Baranguard" — tab-switching
 * between Dispatch and Blotter was guesswork and browser history was
 * useless. Read from the heading the page just rendered rather than
 * maintained as a second lookup table beside PAGE_ROLES, which would be
 * one more thing to keep in sync with the PageHeader titles.
 */
function setDocumentTitle(root) {
  const heading = root.querySelector('.page-header__title, h1, h2');
  const name = heading?.textContent?.trim();
  document.title = name ? `${name} — Baranguard` : 'Baranguard';
}

/**
 * §6.3 of the UI/UX review: move focus to the new page's own title after
 * every navigation, so a keyboard/screen-reader user isn't left on a DOM
 * node `root.innerHTML = ''` (inside each render*Page call) just deleted
 * out from under them — the same problem the skip-link's own `#page-main`
 * target solves for the FIRST Tab press on a page, extended here to every
 * subsequent navigation, not just the initial load.
 *
 * Centralized here rather than added to each of the dozen render*Page
 * functions individually — every one of them already builds its
 * `PageHeader` synchronously before any async data load starts (confirmed
 * by reading several), so the title exists in the DOM by the time this
 * runs, immediately after the dispatch above returns.
 *
 * `tabindex="-1"` makes an element that isn't normally focusable (a
 * heading) a valid `.focus()` target without adding it to the Tab order —
 * the standard pattern for a programmatic focus move, not a UI trap.
 */
function focusPageHeading(root) {
  const heading = root.querySelector('.page-header__title, h1, h2');
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
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
