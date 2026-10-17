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
 * page for the role. (The public `#/citizen-report` page was removed
 * 2026-10-07: walk-ins are logged by staff from Incident Management, and
 * `POST /citizen-reports` no longer exists. The public transparency report
 * is a separate static page, not a route of this app.)
 */

import { getSession, logout, login, onSessionExpired, SESSION_EXPIRED_MESSAGE } from './api/apiClient.js';
import { showToast } from './components/Toast.js';
import { renderLoginPage } from './pages/login.js';
import { renderAdminDashboardPage } from './pages/admin-dashboard.js';
import { renderDispatchCenterPage } from './pages/dispatch-center.js';
import { renderIncidentManagementPage } from './pages/incident-management.js';
import { renderGisLiveTrackingPage } from './pages/gis-live-tracking.js';
import { renderAnalyticsPage } from './pages/analytics.js';
import { renderSettingsPage } from './pages/settings.js';
import { renderPersonnelPage } from './pages/personnel.js';
import { renderIncidentDetailPage } from './pages/incident-detail.js';
import { renderSmsMonitorPage } from './pages/sms-monitor.js';
import { renderAuditLogPage } from './pages/audit-log.js';
import { renderServiceHealthPage } from './pages/service-health.js';
import { renderMapPackagesPage } from './pages/map-packages.js';
// 2026-10 tanod-workflow pages (docs/FEATURE_CONTRACT_2026-10.md §10).
import { renderApprovalsPage } from './pages/approvals.js';
import { renderAccomplishmentReportsPage } from './pages/accomplishment-reports.js';
import { renderReferralLogPage } from './pages/referral-log.js';
import { renderSchoolZonesPage } from './pages/school-zones.js';
import { renderStyleGuidePage } from './pages/style-guide.js';
import { DEFAULT_PAGE_KEY } from './pages/settings.js';

// The Secretary can open the Dispatch Center as back-up dispatcher but still lands on records work.
const ROLE_HOME = { secretary: 'incident-management' };

const PAGE_ROLES = {
  dashboard: ['admin', 'punong_barangay'],
  dispatch: ['admin', 'secretary'],
  'incident-management': ['admin', 'secretary'],
  gis: ['admin', 'punong_barangay'],
  // 2026-09-05 merge of W9 Statistical Reports + W5 Historical Heatmap
  // into one tabbed screen — see pages/analytics.js. Same role pair both
  // already had, so (unlike `personnel` below) no per-tab role gating.
  analytics: ['admin', 'punong_barangay'],
  // 2026-09-05 merge of W10-W12 (User Management/Scheduler/Swap Requests)
  // into one tabbed screen — see pages/personnel.js. Role list is the
  // union of the three; personnel.js gates individual tabs below that.
  // 2026-10: Secretary and Punong Barangay get
  // the Scheduler tab only (read-only availability / roster publishing, which
  // the Approvals page deep-links to); Users and Swap requests stay Admin —
  // see personnel.js. The server gates every action by role + authority.
  personnel: ['admin', 'secretary', 'punong_barangay'],
  // §9 W14 — Admin only, explicitly.
  'sms-log': ['admin'],
  // §9 W17 and W20 — both Admin only, explicitly.
  'audit-log': ['admin'],
  'service-health': ['admin'],
  // §D/W18 — Admin only, explicitly.
  'map-packages': ['admin'],
  settings: ['admin', 'secretary', 'punong_barangay'],
  // Per-incident detail view — the app's ONLY one, and the landing point
  // for search, notifications, Incident Management and the dashboard.
  // The lifecycle controls inside are Secretary-only, and the server
  // enforces all of it independently (§2 Rule 6: client-side hiding is
  // UX, not a boundary).
  'incident-detail': ['admin', 'secretary', 'punong_barangay'],
  // 2026-10 tanod-workflow pages (contract §10). Appended AFTER the screens
  // above on purpose: the default landing page is the first PAGE_ROLES match
  // for a role, and these must not change anyone's existing landing page.
  // Each page's own actions are additionally gated server-side by role AND
  // by the account's approval_authority (§2); hiding here is UX only.
  approvals: ['admin', 'secretary', 'punong_barangay'],
  'accomplishment-reports': ['admin', 'secretary', 'punong_barangay'],
  referrals: ['admin', 'secretary', 'punong_barangay'],
  'school-zones': ['admin', 'secretary', 'punong_barangay'],
  'style-guide': ['admin', 'secretary', 'punong_barangay'],
};

// Pages that cannot render without a parameter — never chosen as a role's
// default landing page, since there is no id to land on.
const DETAIL_PAGES = new Set(['incident-detail']);

// --- Idle lock (audit 2026-10-09 X-02) --------------------------------------
// The dashboard polls every 15 s and every response slides the server session
// (Rule 12), so a tab left open on a shared barangay-hall PC never expires on
// its own. This signs the user out after IDLE_TIMEOUT_MS with no keyboard,
// mouse, touch or scroll input, after a visible IDLE_WARNING_MS warning. It
// is measured by wall clock, so a PC that slept past the limit locks on wake.
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const IDLE_WARNING_MS = 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 5 * 1000;
const IDLE_ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];
export const IDLE_SIGNED_OUT_MESSAGE =
  `You were signed out after ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes without activity. Please sign in again.`;

let lastActivityAt = Date.now();
let idleTimer = null;
let idleWarningDismiss = null;

function noteActivity() {
  lastActivityAt = Date.now();
  if (idleWarningDismiss) {
    idleWarningDismiss();
    idleWarningDismiss = null;
  }
}

function startIdleLock() {
  if (idleTimer !== null) return; // already running across page swaps
  lastActivityAt = Date.now();
  for (const name of IDLE_ACTIVITY_EVENTS) {
    document.addEventListener(name, noteActivity, { capture: true, passive: true });
  }
  idleTimer = setInterval(() => checkIdle(), IDLE_CHECK_INTERVAL_MS);
}

function stopIdleLock() {
  if (idleTimer !== null) clearInterval(idleTimer);
  idleTimer = null;
  for (const name of IDLE_ACTIVITY_EVENTS) {
    document.removeEventListener(name, noteActivity, { capture: true });
  }
  if (idleWarningDismiss) {
    idleWarningDismiss();
    idleWarningDismiss = null;
  }
}

function checkIdle(now = Date.now()) {
  if (idleTimer === null) return;
  const idleFor = now - lastActivityAt;
  if (idleFor >= IDLE_TIMEOUT_MS) {
    signOutForInactivity();
    return;
  }
  if (idleFor >= IDLE_TIMEOUT_MS - IDLE_WARNING_MS && !idleWarningDismiss) {
    const secondsLeft = Math.max(1, Math.ceil((IDLE_TIMEOUT_MS - idleFor) / 1000));
    idleWarningDismiss = showToast(
      `No activity detected. For security you will be signed out in ${secondsLeft} seconds. Move the mouse or press any key to stay signed in.`,
      { variant: 'warning', duration: IDLE_TIMEOUT_MS - idleFor },
    );
  }
}

function signOutForInactivity() {
  stopIdleLock();
  // logout() drops the in-memory session synchronously and revokes the
  // server session in the background (never waits on the network).
  logout();
  endSession(IDLE_SIGNED_OUT_MESSAGE);
}

/** Test-only hooks (the import is cache-busted per test, see web/tests). */
export const __idleLockForTests = {
  check: (now) => checkIdle(now),
  get lastActivityAt() { return lastActivityAt; },
  get running() { return idleTimer !== null; },
};

// --- Session end: back to sign-in, keeping the user's place -----------------
// The token is memory-only (H-05), so a reload still signs out; that trade-off
// is unchanged. What IS kept (in memory, not storage) is the page the user was
// on: signing back in as the SAME user returns there instead of the landing
// page. Unsaved form text is not preserved.

let activeStop = null;
let currentRoute = null; // { page, param, userId } of the screen on display
let resumeRoute = null;  // where to return after a forced sign-out

function endSession(notice) {
  if (currentRoute) resumeRoute = currentRoute;
  currentRoute = null;
  boot(undefined, undefined, { notice });
}

onSessionExpired(() => {
  if (getSession()) return; // already signed in again
  stopIdleLock();
  endSession(SESSION_EXPIRED_MESSAGE);
});

function boot(currentPage, param, { notice } = {}) {
  if (activeStop) {
    activeStop();
    activeStop = null;
  }

  const root = document.getElementById('app');
  const session = getSession();

  if (!session) {
    stopIdleLock();
    currentRoute = null;
    renderLoginPage(root, (user) => {
      const resume = resumeRoute;
      resumeRoute = null;
      if (resume && user && resume.userId === user.userId) boot(resume.page, resume.param);
      else boot();
    }, { notice });
    document.title = 'Sign in — Baranguard';
    return;
  }

  startIdleLock();

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
      : ROLE_HOME[role] ?? Object.keys(PAGE_ROLES).find((key) => PAGE_ROLES[key].includes(role) && !DETAIL_PAGES.has(key)) ?? null;
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

  currentRoute = { page, param, userId: session.user.userId };
  const navigate = (nextPage, nextParam) => boot(nextPage, nextParam);
  // A deliberate sign-out is not a forced one: no "continue where you left off".
  const onLoggedOut = () => {
    resumeRoute = null;
    currentRoute = null;
    boot();
  };

  if (page === 'dashboard') {
    renderAdminDashboardPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'dispatch') {
    // Returns a stop handle now that W3 polls its queue every 15s (audit
    // W3) — same contract the GIS page already uses.
    const handle = renderDispatchCenterPage(root, session.user, onLoggedOut, navigate);
    activeStop = handle?.stop ?? null;
  } else if (page === 'incident-management') {
    // param is an optional incidentId (e.g. from Citizen Reports Inbox's
    // "View in Incident Management" after a conversion) - undefined for the
    // normal nav-menu entry, same optional-vs-required split DETAIL_PAGES
    // already draws for incident-detail.
    const handle = renderIncidentManagementPage(root, session.user, onLoggedOut, navigate, param);
    activeStop = handle?.stop ?? null;
  } else if (page === 'gis') {
    const handle = renderGisLiveTrackingPage(root, session.user, onLoggedOut, navigate);
    activeStop = handle?.stop ?? null;
  } else if (page === 'analytics') {
    const handle = renderAnalyticsPage(root, session.user, onLoggedOut, navigate);
    activeStop = handle?.stop ?? null;
  } else if (page === 'personnel') {
    renderPersonnelPage(root, session.user, onLoggedOut, navigate, param);
  } else if (page === 'sms-log') {
    // Returns a stop handle: the Live Feed panel polls GET /sms/logs
    // every 10s (2026-09-05 UX pass) and that interval must not outlive
    // the page — same contract as service-health/incident-detail below.
    // param can be an optional target phoneNumber or 'activity-log'.
    const handle = renderSmsMonitorPage(root, session.user, onLoggedOut, navigate, param);
    activeStop = handle?.stop ?? null;
  } else if (page === 'audit-log') {
    renderAuditLogPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'map-packages') {
    renderMapPackagesPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'service-health') {
    // Returns a stop handle: W20 re-checks health every 30s and that
    // interval must not outlive the page.
    const handle = renderServiceHealthPage(root, session.user, onLoggedOut, navigate);
    activeStop = handle?.stop ?? null;
  } else if (page === 'settings') {
    renderSettingsPage(root, session.user, onLoggedOut, navigate);
  } else if (page === 'incident-detail') {
    renderIncidentDetailPage(root, session.user, onLoggedOut, navigate, param);
  } else if (page === 'approvals') {
    // Optional stop handle (a page that polls returns one), same contract as above.
    const handle = renderApprovalsPage(root, session.user, onLoggedOut, navigate, param);
    activeStop = handle?.stop ?? null;
  } else if (page === 'accomplishment-reports') {
    // Optional stop handle (a page that polls returns one), same contract as above.
    const handle = renderAccomplishmentReportsPage(root, session.user, onLoggedOut, navigate, param);
    activeStop = handle?.stop ?? null;
  } else if (page === 'referrals') {
    // Optional stop handle (a page that polls returns one), same contract as above.
    const handle = renderReferralLogPage(root, session.user, onLoggedOut, navigate, param);
    activeStop = handle?.stop ?? null;
  } else if (page === 'school-zones') {
    // Optional stop handle (a page that polls returns one), same contract as above.
    const handle = renderSchoolZonesPage(root, session.user, onLoggedOut, navigate, param);
    activeStop = handle?.stop ?? null;
  } else if (page === 'style-guide') {
    renderStyleGuidePage(root, session.user, onLoggedOut, navigate);
  }

  setDocumentTitle(root);
  focusPageHeading(root);
}

/**
 * audit A6: document.title was never touched, so every screen, every
 * history entry and every bookmark read "Baranguard" — tab-switching
 * between Dispatch and Incidents was guesswork and browser history was
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
    resumeRoute = null;
    boot();
  });
  card.append(heading, text, signOutButton);
  page.appendChild(card);
  root.appendChild(page);
}

/**
 * Dev convenience, localhost only: when `Dev Login.bat` opened the page with
 * `?dev_login=1` (remembered in localStorage; `?dev_login=0` turns it off),
 * sign in with the gitignored `web/dev-login.local.json` before the first
 * screen so a reload while editing the UI never lands on the sign-in page.
 * Never runs on any other hostname, and Apache refuses that file for them.
 */
async function devAutoLogin() {
  const host = location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return;
  try {
    const flag = new URLSearchParams(location.search).get('dev_login');
    if (flag === '1') localStorage.setItem('bg_dev_login', '1');
    if (flag === '0') localStorage.removeItem('bg_dev_login');
    if (localStorage.getItem('bg_dev_login') !== '1' || getSession()) return;
    const res = await fetch('dev-login.local.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { username, password } = await res.json();
    await login(username, password);
  } catch { /* any failure falls through to the normal sign-in page */ }
}

devAutoLogin().finally(() => boot());
