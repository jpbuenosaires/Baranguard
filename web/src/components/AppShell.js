/**
 * AppShell — the sidebar + topbar nav shell (§8 "Nav shell: Web — dark
 * navy collapsible sidebar, role-filtered per §7; white top bar
 * (breadcrumbs, search, avatar dropdown)"). Extracted here once a second
 * real screen existed (W2 originally inlined its own single-item nav in
 * admin-dashboard.js — that was fine when only one screen existed; with
 * three now built this session, every screen should show the same real
 * nav rather than three slightly different hand-rolled copies).
 *
 * §8 "no demo/prototype tells": the nav lists only screens that actually
 * exist, same rule W2 already followed when it shipped with just one
 * item.
 *
 * PascalCase filename per §4 (component convention), plain
 * DOM-returning function like KpiCard.js/TrendChart.js.
 */
import { icons } from './icons.js';
import { avatarInitials } from './Avatar.js';
import { Menu, MenuItem, MenuDivider } from './Menu.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { search as apiSearch, getSystemHealth, getNavCounts, getNotifications, acknowledgeNotification, acknowledgeAllNotifications, getOllamaStatus, getAiQueueStatus, getBarangays } from '../api/apiClient.js';
import { playCriticalAlertTone } from '../utils/criticalAlertSound.js';

// notification.notification_type values that should play an audible cue
// the moment they first appear — an SOS or a priority-flagged incident is
// exactly the case where a dispatcher shouldn't have to be looking at the
// bell to notice. Plain 'dispatch'/'other' notifications stay silent.
const AUDIBLE_NOTIFICATION_TYPES = new Set(['sos', 'priority_alert']);

// The four barangays are fixed (REFERENCE.md §1), so one lookup serves
// every navigation instead of one per AppShell mount.
let barangaysPromise = null;

// Shared by the topbar jurisdiction chip and the avatar-menu jurisdiction
// label — both resolve the same user.barangayId to a name and reveal
// themselves once it's known; previously duplicated near-identically in
// two places (a code-review finding).
function applyBarangayName(chipEl, barangayId, { setTitle = false } = {}) {
  barangaysPromise ??= getBarangays().catch((err) => { barangaysPromise = null; throw err; });
  barangaysPromise.then((items) => {
    const name = items.find((b) => b.barangayId === barangayId)?.name;
    if (!name) return;
    chipEl.querySelector('span').textContent = `Brgy. ${name}`;
    if (setTitle) chipEl.title = `Active Jurisdiction: Barangay ${name}`;
    chipEl.hidden = false;
  }).catch(() => { /* chip stays hidden rather than guessing a barangay */ });
}

// notification.notification_type is an ENUM — these are display labels for
// its four members, not a second source of truth for what types exist.
const NOTIFICATION_LABELS = {
  dispatch: 'Dispatch assigned',
  sos: 'Tanod SOS',
  priority_alert: 'Priority alert',
  other: 'Notification',
};

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};
const SEARCH_DEBOUNCE_MS = 300;

// --- Theme toggle (§1.1/§7.1 of the UI/UX review) --------------------------
// Two explicit states only (light/dark), not a three-way light/dark/system
// cycle — a single icon button can't cleanly expose a third state without a
// dropdown, and once a Tanod/Admin has clicked it once they have expressed
// a real preference that should stick, not silently fall back to "system"
// again. No stored preference at all (first-ever load) still follows the
// OS: since the 2026-09-06 UI/UX audit, index.html's bootstrap always
// stamps a RESOLVED data-theme (and keeps following the OS until a value
// is actually stored), so `[data-theme]` is always present and page-level
// `[data-theme="dark"]` rules apply in every dark state. Only an explicit
// click here writes localStorage, which is what stops the OS-following.
const THEME_KEY = 'baranguard.theme';
function readStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}
function writeStoredTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode — toggle just won't persist */ }
}
function isCurrentlyDark() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// AppShell() runs fresh on every page navigation (main.js's boot() re-
// renders from scratch) — a document-level listener added *inside*
// AppShell() would pile up one per navigation and never get removed
// (the old shell's DOM is discarded, but the listener isn't). Registered
// once at module scope instead; each AppShell() call just repoints this
// shared reference at whichever search widget is currently mounted.
let activeSearchHost = null;
let activeSearchResults = null;
document.addEventListener('click', (event) => {
  if (activeSearchHost && !activeSearchHost.contains(event.target) && activeSearchResults) {
    activeSearchResults.hidden = true;
  }
});

// Same "AppShell rebuilt from scratch on every navigate()" trap as above —
// a code-review finding caught that this had been declared as a LOCAL
// variable inside AppShell(), so the critical-alert sound's "already seen"
// baseline was silently wiped on every single navigation, not just a real
// page load. A genuinely new SOS/priority_alert notification arriving
// around a nav click would get folded into the fresh (post-navigation)
// baseline and never sound. Module scope persists it across navigations
// the same way activeSearchHost does; resetOnLogout() below clears it so
// a different user signing in on the same tab doesn't inherit the
// previous user's "already seen" state.
let knownNotificationIds = null;
function resetNotificationBaselineOnLogout() {
  knownNotificationIds = null;
}


// §9 role gates: W2 Dashboard and W4 Live Map are Admin + Punong Barangay
// (read-only); W3 Dispatch Center's create/cancel actions are Admin only,
// with no separate read-only variant built this session — so PB simply
// doesn't get that nav item rather than landing on a page that silently
// can't do anything. Icons match the Figma export's DashboardLayout.tsx
// nav (LayoutDashboard/Radio/Map from lucide-react) — see icons.js.
// `countKey`, when present, keys into GET /reports/nav-counts' response
// (§4.1 of the UI/UX review) — Admin-only, matching that endpoint's own
// gating, so a nav item shared with Punong Barangay (e.g. Fatigue Flags)
// still only shows a badge for the Admin viewing it.
//
// `group` clusters related items under a small-caps sidebar header (the
// 2026-09-05 sidebar redesign — 17 flat items for Admin had become hard
// to scan). `null` means no header (Dashboard sits alone at the top, the
// implicit "home"). A header only ever renders if at least one item in
// that group is visible to the signed-in role — see the render loop
// below — so Secretary/Punong Barangay still see small, sparse groups
// rather than empty headers.
const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', roles: ['admin', 'punong_barangay'], icon: icons.layoutDashboard, group: null },

  { key: 'dispatch', label: 'Dispatch Center', roles: ['admin'], icon: icons.radio, countKey: 'pendingIncidents', group: 'Operations' },
  { key: 'incident-management', label: 'Incident Management', roles: ['admin', 'secretary'], icon: icons.alertTriangle, group: 'Operations' },
  { key: 'gis', label: 'Live Map', roles: ['admin', 'punong_barangay'], icon: icons.map, group: 'Operations' },

  // W6 Electronic Blotter (the records LIST) was removed 2026-09-10. DILG
  // BIMSS is mandated for all barangays and its KPIS module already is the
  // Katarungang Pambarangay case database, so shipping a competing ledger
  // duplicated the system Baranguard is required to complement rather than
  // replace. The per-incident detail view survives as 'blotter-detail' —
  // it is the app's only incident detail screen — reached from Incident
  // Management, the dashboard, search and notifications.
  { key: 'citizen-inbox', label: 'Citizen Reports', roles: ['admin', 'secretary'], icon: icons.inbox, countKey: 'unconvertedCitizenReports', group: 'Records & Reporting' },
  // 2026-09-05 merge of Historical Heatmap + Analytics (W5 + W9) into one
  // tabbed screen — see pages/analytics.js. Same role pair both already
  // had, so no per-tab gating needed there (unlike Personnel below).
  { key: 'analytics', label: 'Analytics', roles: ['admin', 'punong_barangay'], icon: icons.barChart, group: 'Records & Reporting' },
  // There is deliberately NO "AI Tools" entry. The original four
  // local-model assistants (migration 0015) lived inside the screens
  // where their work happened — Classifier in Incident Management,
  // Blotter Assistant in incident detail, SMS Composer in SMS Monitor,
  // Threat Analyzer as an Analytics tab — rather than behind a standalone
  // AI menu (one shipped and was dissolved the same day, 2026-09-10: an
  // operator is mid-task and wants help with that task, not a detour).
  // All four, and the AiToolPanel.js component that rendered them, were
  // since removed (migrations 0027/0028) — this note is kept for the
  // navigation-design rationale, in case a future AI tool faces the same
  // "standalone screen vs. embedded" choice.

  // 2026-09-05 merge of what used to be four separate nav items (Shift
  // Scheduler/Swap Requests/Fatigue Flags/User Management) into one
  // tabbed screen — see pages/personnel.js. No countKey here: the two
  // badges those used to carry (pendingSwapRequests/
  // unacknowledgedFatigueFlags) moved onto the matching tab chip inside
  // the page itself instead of the sidebar.
  { key: 'personnel', label: 'Personnel', roles: ['admin', 'punong_barangay'], icon: icons.users, group: 'Personnel' },

  // §9 W14 — Admin only, explicitly.
  { key: 'sms-log', label: 'SMS Monitor', roles: ['admin'], icon: icons.messageSquare, group: 'System' },
  // §9 W17 / W20 — Admin-only operational screens.
  { key: 'audit-log', label: 'Audit Log', roles: ['admin'], icon: icons.shield, group: 'System' },
  { key: 'service-health', label: 'Service Health', roles: ['admin'], icon: icons.activity, group: 'System' },
  // §D/W18 — Admin only, built as a deliberate Sprint 8 exception.
  { key: 'map-packages', label: 'Map Packages', roles: ['admin'], icon: icons.map, group: 'System' },
  { key: 'settings', label: 'Settings', roles: ['admin', 'secretary', 'punong_barangay'], icon: icons.settings, group: 'System' },
];
const NAV_COUNTS_POLL_MS = 60000; // Not time-critical — see ReportsController::navCounts()'s own doc.

// Sidebar collapse is user state that must survive page navigation —
// AppShell is rebuilt from scratch on every navigate(), so it can't live
// in a local variable. sessionStorage (not localStorage) matches the
// session-scoped storage decision apiClient.js already made.
const SIDEBAR_COLLAPSED_KEY = 'baranguard.sidebarCollapsed';
function readSidebarCollapsed() {
  try { return sessionStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
}
function writeSidebarCollapsed(collapsed) {
  try { sessionStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* private mode — collapse just won't persist */ }
}

/**
 * @param {{fullName:string, role:string}} user
 * @param {string} activePage
 * @param {(page: string) => void} navigate
 * @param {() => void} onLogout
 * @returns {{el:HTMLElement, header:HTMLElement, content:HTMLElement, logoutButton:HTMLButtonElement, setFullName:(fullName:string)=>void}}
 *   `header` is a full-bleed slot above the scrolling content area —
 *   mount a PageHeader into it. `content` is the padded scroll area.
 */
export function AppShell(user, activePage, navigate, onLogout) {
  const handleLogout = () => {
    resetNotificationBaselineOnLogout();
    onLogout();
  };

  const el = document.createElement('div');
  el.className = 'app-shell';

  // §6.1: skip-navigation link — off-screen until Tab-focused, first
  // focusable element on every authenticated page. Targets #page-main
  // below via a real anchor jump (no JS needed for the focus move itself).
  const skipLink = document.createElement('a');
  skipLink.className = 'skip-link';
  skipLink.href = '#page-main';
  skipLink.textContent = 'Skip to main content';
  el.appendChild(skipLink);

  // <aside>, not <div> (audit A5) — the app had no landmark elements at
  // all, so screen-reader landmark navigation, the main way a non-visual
  // user moves around a console this dense, was unavailable. Purely an
  // element swap; the classes still carry every bit of the layout.
  const sidebar = document.createElement('aside');
  sidebar.setAttribute('aria-label', 'Sidebar');
  sidebar.className = 'sidebar' + (readSidebarCollapsed() ? ' is-collapsed' : '');

  // Off-canvas drawer state for the ≤768px breakpoint (audit A13). Above
  // that breakpoint the scrim is display:none and these classes do
  // nothing, so one implementation covers both without a media query in
  // JS (which would need a resize listener to stay correct).
  const scrim = document.createElement('div');
  scrim.className = 'sidebar__scrim';
  scrim.setAttribute('aria-hidden', 'true');
  const closeDrawer = () => {
    sidebar.classList.remove('is-open');
    scrim.classList.remove('is-open');
    drawerButton.setAttribute('aria-expanded', 'false');
  };
  const openDrawer = () => {
    sidebar.classList.add('is-open');
    scrim.classList.add('is-open');
    drawerButton.setAttribute('aria-expanded', 'true');
  };
  scrim.addEventListener('click', closeDrawer);

  const brand = document.createElement('div');
  brand.className = 'sidebar__brand';
  brand.innerHTML = `<img class="icon-badge icon-badge--brand" src="assets/logo.svg" alt="" aria-hidden="true"><span class="sidebar__wordmark">BARANGUARD</span>`;

  // Collapse toggle (the X / Menu button in the reference's logo row).
  const collapseButton = document.createElement('button');
  collapseButton.type = 'button';
  collapseButton.className = 'sidebar__collapse';
  const syncCollapseButton = () => {
    const collapsed = sidebar.classList.contains('is-collapsed');
    collapseButton.innerHTML = collapsed ? icons.menu(18) : icons.chevronLeft(18);
    collapseButton.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    collapseButton.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    collapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  };
  syncCollapseButton();
  collapseButton.addEventListener('click', () => {
    const collapsed = sidebar.classList.toggle('is-collapsed');
    writeSidebarCollapsed(collapsed);
    syncCollapseButton();
  });
  brand.appendChild(collapseButton);

  const nav = document.createElement('nav');
  nav.className = 'sidebar__nav';
  nav.setAttribute('aria-label', 'Main navigation');

  // Real <button> elements (were clickable <div>s — not focusable, not
  // operable by keyboard or screen reader at all). aria-current marks
  // the active page instead of relying on the `.active` class alone;
  // aria-label guarantees an accessible name even at the collapsed
  // 768px breakpoint where the visible label text is hidden via CSS.
  // §4.1 of the UI/UX review — badge dots populated below, once
  // GET /reports/nav-counts resolves (Admin only; see NAV_ITEMS' own
  // comment on why a shared item like Fatigue Flags still only badges
  // for an Admin viewer).
  const countBadges = {};
  let lastRenderedGroup = undefined; // distinct from `null` (dashboard's "no group")
  for (const item of NAV_ITEMS.filter((i) => i.roles.includes(user.role))) {
    if (item.group !== lastRenderedGroup) {
      lastRenderedGroup = item.group;
      if (item.group) {
        const groupLabel = document.createElement('div');
        groupLabel.className = 'sidebar__nav-group-label';
        groupLabel.setAttribute('role', 'presentation');
        groupLabel.textContent = item.group;
        nav.appendChild(groupLabel);
      }
    }
    const isActive = item.key === activePage;
    const navItem = document.createElement('button');
    navItem.type = 'button';
    navItem.className = 'sidebar__nav-item' + (isActive ? ' active' : '');
    if (isActive) navItem.setAttribute('aria-current', 'page');
    navItem.setAttribute('aria-label', item.label);
    // Sighted users get no hover tooltip on touch, and the collapsed rail
    // shows icons only — `title` at least covers the desktop collapsed
    // case, where hover does exist (audit A13).
    navItem.title = item.label;
    navItem.innerHTML = `<span class="sidebar__nav-icon" aria-hidden="true">${item.icon(18)}</span><span class="sidebar__nav-label">${item.label}</span>`;
    if (item.countKey && user.role === 'admin') {
      const badge = document.createElement('span');
      badge.className = 'sidebar__nav-badge';
      badge.hidden = true;
      navItem.appendChild(badge);
      countBadges[item.countKey] = badge;
    }
    navItem.addEventListener('click', () => { closeDrawer(); navigate(item.key); });
    nav.appendChild(navItem);
  }
  // Applying counts is its own function because three things call it: the
  // first load, the poll, and refreshNavCounts() on the returned handle —
  // which a page calls straight after a mutating action so the sidebar
  // can't sit contradicting the screen for up to a minute (audit A16).
  function applyCounts(counts) {
    for (const [key, badge] of Object.entries(countBadges)) {
      const n = counts[key] ?? 0;
      badge.hidden = n === 0;
      badge.textContent = n > 99 ? '99+' : String(n);
      // The collapsed rail renders the badge as a bare pip with no text,
      // so the count has to reach assistive tech through the nav item's
      // own name instead of the badge's contents.
      const navButton = badge.parentElement;
      const base = navButton.title;
      navButton.setAttribute('aria-label', n === 0 ? base : `${base}, ${n} pending`);
    }
  }
  function refreshNavCounts() {
    if (user.role !== 'admin' || Object.keys(countBadges).length === 0) return Promise.resolve();
    return getNavCounts().then(applyCounts).catch(() => {});
  }

  if (user.role === 'admin' && Object.keys(countBadges).length > 0) {
    // AppShell has no explicit "unmount" hook of its own (main.js rebuilds
    // #app wholesale on every navigate(), which detaches this exact `el`
    // from the DOM) — checked at the START of every tick rather than via a
    // separate destroy() call plumbed through main.js, so the interval
    // retires itself the first poll after the shell it belongs to is gone.
    const badgeInterval = setInterval(() => {
      if (!el.isConnected) {
        clearInterval(badgeInterval);
        return;
      }
      // badge counts are a convenience, not core nav — a failed fetch just
      // leaves them as they were
      refreshNavCounts();
    }, NAV_COUNTS_POLL_MS);
    // First fetch runs immediately rather than waiting a full poll
    // interval for the badges to appear on initial load.
    refreshNavCounts();
  }
  // Sidebar user footer (reference shows avatar + name + a second line).
  // The reference's second line is an email address; §5's `user` table
  // has no email column, so this shows the role instead of inventing a
  // field — same rule that keeps every other identity real.
  const sidebarUser = document.createElement('div');
  sidebarUser.className = 'sidebar__user';
  const sidebarUserName = document.createElement('div');
  sidebarUserName.className = 'sidebar__user-name';
  const sidebarUserRole = document.createElement('div');
  sidebarUserRole.className = 'sidebar__user-role';
  const sidebarAvatar = document.createElement('span');
  const renderSidebarUser = (fullName) => {
    sidebarAvatar.innerHTML = avatarInitials(fullName, 36);
    sidebarUserName.textContent = fullName;
  };
  const sidebarUserText = document.createElement('div');
  sidebarUserText.className = 'sidebar__user-text';
  sidebarUserText.append(sidebarUserName, sidebarUserRole);

  const sidebarLogout = document.createElement('button');
  sidebarLogout.type = 'button';
  sidebarLogout.className = 'sidebar__user-action';
  sidebarLogout.title = 'Sign out';
  sidebarLogout.setAttribute('aria-label', 'Sign out');
  sidebarLogout.innerHTML = icons.logOut(16);
  sidebarLogout.addEventListener('click', (e) => {
    e.stopPropagation();
    handleLogout();
  });

  sidebarUser.append(sidebarAvatar, sidebarUserText, sidebarLogout);

  sidebar.append(brand, nav, sidebarUser);

  const mainColumn = document.createElement('div');
  mainColumn.className = 'main-column';

  // <header> landmark (audit A5).
  const topbar = document.createElement('header');
  topbar.className = 'topbar';

  // Drawer trigger — only visible at ≤768px (CSS), where the sidebar is
  // off-canvas (audit A13).
  const drawerButton = document.createElement('button');
  drawerButton.type = 'button';
  drawerButton.className = 'icon-btn topbar__menu';
  drawerButton.innerHTML = icons.menu(20);
  drawerButton.setAttribute('aria-label', 'Open navigation');
  drawerButton.setAttribute('aria-expanded', 'false');
  drawerButton.addEventListener('click', () => {
    if (sidebar.classList.contains('is-open')) closeDrawer();
    else openDrawer();
  });
  topbar.appendChild(drawerButton);
  const ROLE_LABELS = { admin: 'Admin', secretary: 'Secretary', punong_barangay: 'Punong Barangay (read-only)' };
  const roleLabel = ROLE_LABELS[user.role] ?? user.role;

  // --- Left: Wayfinding & Jurisdiction Context ---
  const topbarContext = document.createElement('div');
  topbarContext.className = 'topbar__context';

  const jurisdictionChip = document.createElement('span');
  jurisdictionChip.className = 'topbar__jurisdiction';
  jurisdictionChip.innerHTML = `${icons.mapPin(12)}<span></span>`;
  jurisdictionChip.hidden = true;
  applyBarangayName(jurisdictionChip, user.barangayId, { setTitle: true });

  // Compute breadcrumb path from activePage and NAV_ITEMS
  const currentNav = NAV_ITEMS.find((i) => i.key === activePage);
  let groupTitle = currentNav?.group;
  let pageTitle = currentNav?.label;

  // The dedicated 'blotter-detail'/'ai-review' branches this block used
  // to have here were dead code — renderBlotterDetailPage() has always
  // called AppShell(user, listPage, ...) with 'dashboard'/'incident-
  // management' as activePage (so the SIDEBAR highlights correctly), not
  // the literal string 'blotter-detail', and 'ai-review' as a standalone
  // page no longer exists at all (2026-09-27 tab merge, DEVLOG (38)).
  // Removed rather than left to bit-rot further; `pageTitle` already
  // correctly falls through to "Incident Management" via `currentNav`.
  if (!groupTitle && activePage === 'dashboard') {
    groupTitle = 'Overview';
    pageTitle = 'Dashboard';
  } else if (!pageTitle) {
    pageTitle = activePage.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const breadcrumbs = document.createElement('nav');
  breadcrumbs.className = 'topbar__breadcrumbs';
  breadcrumbs.setAttribute('aria-label', 'Breadcrumb navigation');

  let breadcrumbsHtml = `
    <span class="topbar__crumb topbar__crumb--group">${groupTitle || 'Overview'}</span>
    <span class="topbar__crumb-sep" aria-hidden="true">/</span>
    <span class="topbar__crumb topbar__crumb--current" aria-current="page">${pageTitle}</span>
  `;

  if (user.role === 'punong_barangay') {
    breadcrumbsHtml += `
      <span class="topbar__role-tag" title="Punong Barangay: Executive Oversight & Monitoring (Read-Only)">Executive</span>
    `;
  }

  breadcrumbs.innerHTML = breadcrumbsHtml;
  topbarContext.append(jurisdictionChip, breadcrumbs);
  topbar.appendChild(topbarContext);

  // Mobile search toggle button (visible on <=768px)
  const mobileSearchBtn = document.createElement('button');
  mobileSearchBtn.type = 'button';
  mobileSearchBtn.className = 'topbar__search-toggle icon-btn';
  mobileSearchBtn.setAttribute('aria-label', 'Open search');
  mobileSearchBtn.innerHTML = icons.search(18);
  topbar.appendChild(mobileSearchBtn);

  // Real search — GET /search, incidents only (see SearchController.php's
  // own doc for scope). Replaces a prior placeholder input that called
  // nothing (§8: no decorative control that does nothing when used).
  const searchHost = document.createElement('div');
  searchHost.className = 'topbar__search';
  const searchLabel = document.createElement('label');
  searchLabel.className = 'sr-only';
  searchLabel.htmlFor = 'topbar-search';
  searchLabel.textContent = 'Search incidents';

  const searchInputWrap = document.createElement('div');
  searchInputWrap.className = 'topbar__search-wrap';

  const searchIcon = document.createElement('span');
  searchIcon.className = 'topbar__search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  searchIcon.innerHTML = icons.search(15);

  const searchInput = document.createElement('input');
  searchInput.id = 'topbar-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search incidents, ID, or status…';
  searchInput.autocomplete = 'off';

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent || '');
  const searchKbd = document.createElement('kbd');
  searchKbd.className = 'topbar__search-kbd';
  searchKbd.textContent = isMac ? '⌘K' : 'Ctrl K';
  searchKbd.setAttribute('aria-hidden', 'true');

  searchInputWrap.append(searchIcon, searchInput, searchKbd);

  const mobileSearchClose = document.createElement('button');
  mobileSearchClose.type = 'button';
  mobileSearchClose.className = 'topbar__search-close';
  mobileSearchClose.setAttribute('aria-label', 'Close search');
  mobileSearchClose.innerHTML = icons.x(18);
  mobileSearchClose.addEventListener('click', () => {
    searchHost.classList.remove('is-mobile-open');
    searchResults.hidden = true;
  });

  const searchResults = document.createElement('div');
  searchResults.className = 'topbar__search-results';
  searchResults.hidden = true;
  searchHost.append(searchLabel, searchInputWrap, mobileSearchClose, searchResults);

  mobileSearchBtn.addEventListener('click', () => {
    searchHost.classList.toggle('is-mobile-open');
    if (searchHost.classList.contains('is-mobile-open')) {
      searchInput.focus();
    }
  });

  // Global keyboard shortcut for Ctrl+K / Cmd+K
  const handleGlobalSearchKeydown = (e) => {
    if (!searchInput.isConnected) {
      window.removeEventListener('keydown', handleGlobalSearchKeydown);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName;
      if (activeEl !== searchInput && (tag === 'INPUT' || tag === 'TEXTAREA' || activeEl?.isContentEditable)) {
        return;
      }
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  };
  window.addEventListener('keydown', handleGlobalSearchKeydown);

  activeSearchHost = searchHost;
  activeSearchResults = searchResults;

  let searchDebounceHandle = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceHandle);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      searchResults.hidden = true;
      searchResults.innerHTML = '';
      return;
    }
    searchDebounceHandle = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
  });

  // Escape closes the dropdown; Down arrow moves into the results, so the
  // list is reachable without tabbing through it (audit A15 group).
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchResults.hidden = true;
      return;
    }
    if (event.key === 'ArrowDown' && !searchResults.hidden) {
      const first = searchResults.querySelector('.topbar__search-result');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  searchResults.addEventListener('keydown', (event) => {
    const items = [...searchResults.querySelectorAll('.topbar__search-result')];
    const i = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { searchResults.hidden = true; searchInput.focus(); return; }
    if (event.key === 'ArrowDown' && i > -1 && i < items.length - 1) { event.preventDefault(); items[i + 1].focus(); }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (i > 0) items[i - 1].focus(); else searchInput.focus();
    }
  });

  async function runSearch(q) {
    // Between the debounce and the response the dropdown used to sit
    // empty or stale, with nothing to say a request was in flight.
    searchResults.innerHTML = '<div class="topbar__search-empty">Searching…</div>';
    searchResults.hidden = false;
    let results;
    try {
      results = await apiSearch(q);
    } catch {
      searchResults.innerHTML = '<div class="topbar__search-empty">Search failed. Try again.</div>';
      return;
    }
    // A slower earlier request must not overwrite a newer query's results.
    if (searchInput.value.trim() !== q) return;
    if (results.length === 0) {
      searchResults.innerHTML = '<div class="topbar__search-empty">No matching incidents.</div>';
      return;
    }
    searchResults.innerHTML = '';
    for (const item of results) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'topbar__search-result';
      const typeLabel = INCIDENT_TYPE_LABELS[item.incidentType] || item.incidentType;
      row.innerHTML = `<strong>#${escapeHtml(item.incidentId)} — ${escapeHtml(typeLabel)}</strong><span class="status-pill status-pill--neutral">${escapeHtml(item.status)}</span>`;
      row.addEventListener('click', () => {
        searchResults.hidden = true;
        searchInput.value = '';
        // blotter-detail takes the id and is the app's only per-incident
        // detail view, so a search result opens the incident itself.
        navigate('blotter-detail', item.incidentId);
      });
      searchResults.appendChild(row);
    }
  }

  const topbarUser = document.createElement('div');
  topbarUser.className = 'topbar__user';

  // Live Philippine Standard Time clock and active shift
  const clockContainer = document.createElement('div');
  clockContainer.className = 'topbar__clock';
  clockContainer.setAttribute('aria-label', 'Live local time and active duty shift');

  const clockTimeRow = document.createElement('div');
  clockTimeRow.className = 'topbar__clock-time';

  const clockPulse = document.createElement('span');
  clockPulse.className = 'topbar__clock-dot';

  const clockDigits = document.createElement('span');
  clockDigits.className = 'topbar__clock-digits';

  const clockShift = document.createElement('div');
  clockShift.className = 'topbar__clock-shift';

  clockTimeRow.append(clockPulse, clockDigits);
  clockContainer.append(clockTimeRow, clockShift);
  topbarUser.appendChild(clockContainer);

  let clockInterval;
  const updateClock = () => {
    if (!clockContainer.isConnected) {
      clearInterval(clockInterval);
      return;
    }
    const now = new Date();
    const hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const h12 = hours % 12 || 12;
    const ampm = hours >= 12 ? 'PM' : 'AM';
    clockDigits.textContent = `${h12}:${minutes}:${seconds} ${ampm} PST`;

    const isDay = hours >= 8 && hours < 20;
    clockShift.textContent = isDay ? 'Day Duty (08:00–20:00)' : 'Night Duty (20:00–08:00)';
  };
  updateClock();
  clockInterval = setInterval(updateClock, 1000);

  // Real system-status badge — GET /system/health (Admin only per §6).
  // Replaces a hardcoded permanently-green "All Systems Operational"
  // badge (§8's exclusions) — this one reflects the API/DB check that
  // actually ran, and is simply omitted for roles that can't call the
  // endpoint rather than showing a fake status for them.
  if (user.role === 'admin') {
    const statusBadge = document.createElement('div');
    // The text changes asynchronously once the health probe resolves, so
    // it needs to be announced rather than silently swapped.
    statusBadge.setAttribute('role', 'button');
    statusBadge.setAttribute('tabindex', '0');
    statusBadge.setAttribute('aria-label', 'System health status. Click to open Service Health dashboard.');
    statusBadge.style.cursor = 'pointer';
    statusBadge.className = 'status-badge status-badge--checking';
    statusBadge.innerHTML = '<span class="status-badge__dot"></span><span class="status-badge__text">Checking…</span>';
    statusBadge.addEventListener('click', () => navigate('service-health'));
    statusBadge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') navigate('service-health'); });
    topbarUser.appendChild(statusBadge);
    getSystemHealth().then((health) => {
      const coreDown = health.api !== 'healthy' || health.db !== 'healthy';
      // `not_configured` stays neutral (§2 Rule 6 — a dependency nobody has
      // set up yet is not a failure state), so only a real live-probe
      // failure ('unhealthy') triggers the amber "AI Unavailable" state —
      // otherwise every session on a workstation that has never configured
      // Ollama would show a false alarm.
      const aiDown = health.ollama === 'unhealthy';
      const state = coreDown ? 'down' : aiDown ? 'warn' : 'ok';
      const text = coreDown ? 'Database Unavailable' : aiDown ? 'AI Unavailable' : 'All Systems Operational';
      statusBadge.className = 'status-badge status-badge--' + state;
      statusBadge.querySelector('.status-badge__text').textContent = text;
      statusBadge.title = `API: ${health.api} · DB: ${health.db} · Routing: ${health.ors} · Ollama: ${health.ollama} · GSM: ${health.gsmIngestion} · Notifications: ${health.notificationConfig} (Click to view full health)`;
    }).catch(() => {
      statusBadge.className = 'status-badge status-badge--down';
      statusBadge.querySelector('.status-badge__text').textContent = 'Status unavailable';
    });
  } else if (user.role === 'secretary') {
    // Punong Barangay dropped from this branch: Threat Analyzer (their one
    // AI-consuming feature) was removed with the AI Tools screen
    // (migration 0028), leaving nothing this badge would inform for that
    // role. Secretary still runs real AI jobs (redaction/extraction/
    // summary/translation), so the ambient "is the model up" signal
    // stays — backed by GET /system/ollama-status now, not the removed
    // AI Tools availability endpoint.
    const aiBadge = document.createElement('div');
    aiBadge.className = 'topbar__ai-badge topbar__ai-badge--neutral';
    aiBadge.innerHTML = `<span class="topbar__ai-dot"></span><span class="topbar__ai-icon" aria-hidden="true">${icons.sparkles(12)}</span><span class="topbar__ai-text">AI Ready</span>`;
    aiBadge.style.display = 'none';
    topbarUser.appendChild(aiBadge);

    // Queue depth folded into the same tooltip — Secretary has no Service
    // Health page (Admin-only, §7), so this ambient tooltip is the only
    // "is anything stuck" signal available to the role that actually
    // enqueues these jobs. Before GET /system/ai-queue existed, the only
    // way to see this at all was `ai-worker.php --status` on the
    // workstation itself. Both calls are awaited together (rather than
    // two independent `.then()`s) so whichever resolves last doesn't
    // clobber the other's contribution to `aiBadge.title`.
    Promise.all([
      getOllamaStatus().catch(() => ({ ollama: null })),
      getAiQueueStatus().catch(() => null),
    ]).then(([{ ollama }, q]) => {
      aiBadge.style.display = 'inline-flex';
      const isOk = ollama === 'healthy';
      const isWarn = ollama === 'unhealthy';
      aiBadge.className = `topbar__ai-badge topbar__ai-badge--${isOk ? 'ok' : isWarn ? 'warn' : 'neutral'}`;
      aiBadge.querySelector('.topbar__ai-text').textContent = isOk ? 'AI Ready' : isWarn ? 'AI Offline' : 'AI Inactive';
      const baseTitle = isOk
        ? 'Local Ollama AI model is online and ready.'
        : isWarn
          ? 'Local AI model is not responding. AI drafting is paused.'
          : 'No local AI model is configured on this workstation.';
      const queuedNote = q && q.depth.queued > 0
        ? ` · Queue: ${q.depth.queued} waiting, ${q.depth.processing} processing`
        : '';
      aiBadge.title = baseTitle + queuedNote;
    });
  }

  // Divider between operational metrics (clock + health) and user controls
  const userDivider = document.createElement('div');
  userDivider.className = 'topbar__divider';
  topbarUser.appendChild(userDivider);

  // Theme toggle
  let onThemeChanged = null;
  const themeToggle = document.createElement('button');
  themeToggle.type = 'button';
  themeToggle.className = 'icon-btn topbar__theme-toggle';
  const syncThemeToggleIcon = () => {
    const dark = isCurrentlyDark();
    themeToggle.innerHTML = dark ? icons.sun(16) : icons.moon(16);
    themeToggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    themeToggle.title = themeToggle.getAttribute('aria-label');
    onThemeChanged?.();
  };
  syncThemeToggleIcon();
  themeToggle.addEventListener('click', () => {
    const next = isCurrentlyDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    writeStoredTheme(next);
    syncThemeToggleIcon();
  });
  topbarUser.appendChild(themeToggle);

  sidebarUserRole.textContent = roleLabel;

  // --- Notification bell -------------------------------------------------
  // Backed by GET /notifications (the caller's own targets). The bell is
  // omitted entirely for a role with no targets rather than showing a
  // permanently-empty control — Tanods get theirs in the mobile app, and
  // web roles only ever receive SOS fan-out and dispatch notifications.
  const bellTrigger = document.createElement('button');
  bellTrigger.type = 'button';
  bellTrigger.className = 'icon-btn topbar__bell';
  bellTrigger.innerHTML = icons.bell(18);
  bellTrigger.setAttribute('aria-label', 'Notifications');
  const bellDot = document.createElement('span');
  bellDot.className = 'topbar__bell-dot';
  bellDot.hidden = true;
  bellTrigger.appendChild(bellDot);

  function formatRelativeTime(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffSec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
    if (diffSec < 45) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  let activeNotificationTab = 'all';

  const bellMenu = Menu({
    trigger: bellTrigger,
    label: 'Notifications',
    panelClass: 'menu__panel--notifications',
    onOpen: () => loadNotifications(),
  });

  function renderNotifications(result) {
    bellDot.hidden = result.unreadCount === 0;
    bellDot.textContent = result.unreadCount > 9 ? '9+' : String(result.unreadCount);
    bellTrigger.setAttribute(
      'aria-label',
      result.unreadCount === 0 ? 'Notifications' : `Notifications, ${result.unreadCount} unread`
    );

    bellMenu.panel.innerHTML = '';

    const hasCriticalUnread = result.items.some(
      (item) => item.ackStatus === 'pending' && (item.notificationType === 'sos' || item.notificationType === 'priority_alert')
    );

    // 1. Header with title, unread count badge, and "Mark all read" button
    const header = document.createElement('div');
    header.className = 'notification-panel__header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'notification-panel__title-group';

    const title = document.createElement('h3');
    title.className = 'notification-panel__title';
    title.textContent = 'Notifications';

    const badge = document.createElement('span');
    badge.className = 'notification-panel__badge' + (hasCriticalUnread ? ' notification-panel__badge--critical' : '');
    badge.textContent = result.unreadCount === 0 ? 'All caught up' : `${result.unreadCount} unread`;

    titleGroup.append(title, badge);

    const headerActions = document.createElement('div');
    headerActions.className = 'notification-panel__header-actions';

    const markAllBtn = document.createElement('button');
    markAllBtn.type = 'button';
    markAllBtn.className = 'notification-panel__mark-read';
    markAllBtn.innerHTML = `${icons.check(14)} Mark all read`;
    markAllBtn.title = 'Mark all notifications as read';
    if (result.unreadCount === 0) {
      markAllBtn.hidden = true;
    }
    markAllBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await acknowledgeAllNotifications();
      } catch {
        // graceful offline / fallback handling
      }
      result.items.forEach((item) => { item.ackStatus = 'acknowledged'; });
      result.unreadCount = 0;
      renderNotifications(result);
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'icon-btn notification-panel__close-btn';
    closeBtn.setAttribute('aria-label', 'Close notifications');
    closeBtn.title = 'Close notifications';
    closeBtn.innerHTML = icons.x(16);
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bellMenu.close({ restoreFocus: true });
    });

    headerActions.append(markAllBtn, closeBtn);
    header.append(titleGroup, headerActions);

    // 2. Filter Tabs (All / Unread / Critical)
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'notification-panel__tabs';

    const unreadCount = result.items.filter((i) => i.ackStatus === 'pending').length;
    const criticalCount = result.items.filter((i) => i.notificationType === 'sos' || i.notificationType === 'priority_alert').length;

    const tabDefs = [
      { key: 'all', label: `All (${result.items.length})` },
      { key: 'unread', label: `Unread (${unreadCount})` },
      { key: 'critical', label: `Critical (${criticalCount})` },
    ];

    const listContainer = document.createElement('div');
    listContainer.className = 'notification-panel__list';

    tabDefs.forEach(({ key, label }) => {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'notification-panel__tab' + (activeNotificationTab === key ? ' is-active' : '');
      tabBtn.textContent = label;
      tabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeNotificationTab = key;
        tabsContainer.querySelectorAll('.notification-panel__tab').forEach((b) => b.classList.remove('is-active'));
        tabBtn.classList.add('is-active');
        renderNotificationCards(listContainer, result);
      });
      tabsContainer.appendChild(tabBtn);
    });

    // 3. Notification Cards List
    function renderNotificationCards(container, currentResult) {
      container.innerHTML = '';
      const filtered = currentResult.items.filter((item) => {
        if (activeNotificationTab === 'unread') return item.ackStatus === 'pending';
        if (activeNotificationTab === 'critical') return item.notificationType === 'sos' || item.notificationType === 'priority_alert';
        return true;
      });

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'notification-panel__empty';

        const iconWrap = document.createElement('div');
        iconWrap.className = 'notification-panel__empty-icon';
        iconWrap.innerHTML = icons.checkCircle(22);

        const emptyTitle = document.createElement('div');
        emptyTitle.className = 'notification-panel__empty-title';

        const emptyDesc = document.createElement('div');
        emptyDesc.className = 'notification-panel__empty-desc';

        if (activeNotificationTab === 'unread') {
          emptyTitle.textContent = 'All caught up';
          emptyDesc.textContent = 'You have no unread notifications right now.';
        } else if (activeNotificationTab === 'critical') {
          emptyTitle.textContent = 'No critical alerts';
          emptyDesc.textContent = 'No active emergency SOS or priority alerts recorded.';
        } else {
          emptyTitle.textContent = 'No notifications';
          emptyDesc.textContent = 'Operational alerts and field updates will appear here.';
        }

        empty.append(iconWrap, emptyTitle, emptyDesc);
        container.appendChild(empty);
        return;
      }

      for (const item of filtered) {
        const unread = item.ackStatus === 'pending';
        let iconFn = icons.bell;
        let badgeMod = 'neutral';
        let category = 'NOTIFICATION';
        let itemTitle = 'Alert';
        let code = '';
        let desc = '';

        if (item.notificationType === 'sos') {
          iconFn = icons.alertTriangle;
          badgeMod = 'critical';
          category = 'TANOD SOS';
          itemTitle = item.sosTanodName ? `SOS: ${item.sosTanodName}` : (item.sosId ? `Tanod SOS #${item.sosId}` : 'Emergency SOS');
          code = item.sosId ? `SOS-${item.sosId}` : '';
          desc = 'Field emergency alert — immediate dispatch required';
        } else if (item.notificationType === 'priority_alert') {
          iconFn = icons.alertTriangle;
          badgeMod = 'warning';
          category = 'PRIORITY ALERT';
          itemTitle = item.incidentType ? (INCIDENT_TYPE_LABELS[item.incidentType] || item.incidentType) : 'Priority Alert';
          code = item.incidentDisplayId || (item.incidentId ? `#${item.incidentId}` : '');
          desc = item.incidentPriority && item.incidentPriority !== 'normal'
            ? `Urgent alert · Priority ${item.incidentPriority.toUpperCase()}`
            : 'Priority incident requires attention';
        } else if (item.notificationType === 'dispatch') {
          const isDone = item.dispatchStatus === 'completed';
          const isArrived = item.dispatchStatus === 'arrived';
          badgeMod = isDone ? 'success' : 'info';
          category = isDone ? 'DISPATCH COMPLETED' : (isArrived ? 'TANOD ARRIVED' : 'DISPATCH ASSIGNED');
          iconFn = isDone ? icons.checkCircle : (isArrived ? icons.mapPin : icons.radio);
          itemTitle = item.dispatchTanodName || 'Tanod Officer';
          code = item.incidentDisplayId || (item.dispatchId ? `DSP-${item.dispatchId}` : '');
          desc = item.incidentType ? `Assigned to ${INCIDENT_TYPE_LABELS[item.incidentType] || item.incidentType}` : 'Dispatch mission';
        } else if (item.dispatchStatus === 'completed') {
          iconFn = icons.checkCircle;
          badgeMod = 'success';
          category = 'DISPATCH COMPLETED';
          itemTitle = item.dispatchTanodName || 'Tanod Officer';
          code = item.incidentDisplayId || '';
          desc = 'Dispatch successfully resolved';
        } else if (item.dispatchStatus === 'arrived') {
          iconFn = icons.mapPin;
          badgeMod = 'info';
          category = 'TANOD ARRIVED';
          itemTitle = item.dispatchTanodName || 'Tanod Officer';
          code = item.incidentDisplayId || '';
          desc = 'Officer arrived at the scene';
        } else if (item.incidentType) {
          iconFn = icons.fileText;
          badgeMod = 'neutral';
          category = 'NEW INCIDENT';
          itemTitle = INCIDENT_TYPE_LABELS[item.incidentType] || item.incidentType;
          code = item.incidentDisplayId || (item.incidentId ? `#${item.incidentId}` : '');
          desc = item.incidentPriority && item.incidentPriority !== 'normal'
            ? `Logged incident · Priority: ${item.incidentPriority.toUpperCase()}`
            : '';
        }

        const card = document.createElement('div');
        card.className = 'notification-card' + (unread ? ' notification-card--unread' : '');
        card.setAttribute('role', 'menuitem');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `${category}: ${itemTitle} ${code}, ${unread ? 'unread' : 'read'}`);

        // Left Icon Badge
        const iconBadge = document.createElement('span');
        iconBadge.className = `notification-card__icon-badge notification-card__icon-badge--${badgeMod}`;
        iconBadge.setAttribute('aria-hidden', 'true');
        iconBadge.innerHTML = iconFn(18);
        card.appendChild(iconBadge);

        // Content
        const cardContent = document.createElement('div');
        cardContent.className = 'notification-card__content';

        // Meta row: category tag + relative time
        const meta = document.createElement('div');
        meta.className = 'notification-card__meta';

        const catEl = document.createElement('span');
        catEl.className = `notification-card__category notification-card__category--${badgeMod}`;
        catEl.textContent = category;

        const timeEl = document.createElement('span');
        timeEl.className = 'notification-card__time';
        timeEl.textContent = formatRelativeTime(item.createdAt);
        if (item.createdAt) {
          timeEl.title = new Date(item.createdAt).toLocaleString();
        }
        meta.append(catEl, timeEl);
        cardContent.appendChild(meta);

        // Title row: entity headline + incident code chip
        const titleRow = document.createElement('div');
        titleRow.className = 'notification-card__title-row';

        const titleEl = document.createElement('span');
        titleEl.className = 'notification-card__title';
        titleEl.textContent = itemTitle;
        titleRow.appendChild(titleEl);

        if (code) {
          const codeEl = document.createElement('span');
          codeEl.className = 'notification-card__code';
          codeEl.textContent = code;
          titleRow.appendChild(codeEl);
        }
        cardContent.appendChild(titleRow);

        // Description
        if (desc) {
          const descEl = document.createElement('span');
          descEl.className = 'notification-card__desc';
          descEl.textContent = desc;
          cardContent.appendChild(descEl);
        }
        card.appendChild(cardContent);

        // Unread dot
        if (unread) {
          const dot = document.createElement('span');
          dot.className = 'notification-card__dot';
          dot.setAttribute('aria-hidden', 'true');
          card.appendChild(dot);
        }

        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            card.click();
          }
        });

        card.addEventListener('click', async () => {
          if (unread) {
            item.ackStatus = 'acknowledged';
            card.classList.remove('notification-card--unread');
            card.querySelector('.notification-card__dot')?.remove();
            currentResult.unreadCount = Math.max(0, currentResult.unreadCount - 1);
            bellDot.hidden = currentResult.unreadCount === 0;
            bellDot.textContent = currentResult.unreadCount > 9 ? '9+' : String(currentResult.unreadCount);
            bellTrigger.setAttribute(
              'aria-label',
              currentResult.unreadCount === 0 ? 'Notifications' : `Notifications, ${currentResult.unreadCount} unread`
            );
            try {
              await acknowledgeNotification(item.notificationId);
            } catch {
              // fallback
            }
          }
          bellMenu.close();
          if (item.incidentId) navigate('blotter-detail', item.incidentId);
          else if (item.sosId || item.dispatchId) navigate('dispatch');
        });

        container.appendChild(card);
      }
    }

    renderNotificationCards(listContainer, result);

    // 4. Panel Footer
    const footer = document.createElement('div');
    footer.className = 'notification-panel__footer';

    const statusWrap = document.createElement('span');
    statusWrap.className = 'notification-panel__footer-status';
    const statusDot = document.createElement('span');
    statusDot.className = 'notification-panel__footer-dot';
    const statusText = document.createElement('span');
    statusText.textContent = 'Live alerts active';
    statusWrap.append(statusDot, statusText);

    const canAccessDispatch = NAV_ITEMS.find((i) => i.key === 'dispatch')?.roles.includes(user.role);
    const targetScreen = canAccessDispatch
      ? { page: 'dispatch', label: 'Go to Dispatch Center' }
      : { page: 'incident-management', label: 'Go to Incidents' };

    const footerLink = document.createElement('button');
    footerLink.type = 'button';
    footerLink.className = 'notification-panel__footer-link';
    footerLink.textContent = targetScreen.label;
    footerLink.addEventListener('click', () => {
      bellMenu.close();
      navigate(targetScreen.page);
    });

    footer.append(statusWrap, footerLink);

    bellMenu.panel.append(header, tabsContainer, listContainer, footer);
  }

  // Tracks notification IDs already seen, so the audible cue fires only
  // for ones that are genuinely NEW since the last poll — `null` means
  // "haven't established a baseline yet", which keeps the very first
  // load (a page refresh with existing unread items already sitting
  // there) silent rather than replaying a chime for old news. Declared at
  // module scope above (not here) so it survives AppShell() being rebuilt
  // on every navigation.
  async function loadNotifications() {
    try {
      const result = await getNotifications({ limit: 15 });
      if (knownNotificationIds) {
        const hasNewCritical = result.items.some(
          (item) => !knownNotificationIds.has(item.notificationId) && AUDIBLE_NOTIFICATION_TYPES.has(item.notificationType)
        );
        if (hasNewCritical) playCriticalAlertTone();
      }
      knownNotificationIds = new Set(result.items.map((item) => item.notificationId));
      renderNotifications(result);
    } catch {
      // The bell is a convenience; a failed fetch leaves the previous
      // state rather than replacing the panel with an error.
    }
  }

  // --- Avatar menu -------------------------------------------------------
  // Replaces avatar + full name + a separate Sign out button, which was
  // three controls' worth of topbar for one identity (audit A15). §8's own
  // nav-shell spec already called for an "avatar dropdown"; it was never
  // built until now.
  const avatarTrigger = document.createElement('button');
  avatarTrigger.type = 'button';
  avatarTrigger.className = 'topbar__avatar-button';
  const userAvatar = document.createElement('span');
  userAvatar.className = 'topbar__avatar-chip';
  const avatarChevron = document.createElement('span');
  avatarChevron.className = 'topbar__avatar-chevron';
  avatarChevron.setAttribute('aria-hidden', 'true');
  avatarChevron.innerHTML = icons.chevronDown(14);
  avatarTrigger.append(userAvatar, avatarChevron);

  const avatarMenu = Menu({ trigger: avatarTrigger, label: 'Account', panelClass: 'menu__panel--account' });

  // Overhauled Rich User Identity Header
  const menuHeader = document.createElement('div');
  menuHeader.className = 'menu__account-header menu__header';

  const menuAvatar = document.createElement('div');
  menuAvatar.className = 'menu__account-avatar';

  const menuDetails = document.createElement('div');
  menuDetails.className = 'menu__account-details';

  const menuName = document.createElement('div');
  menuName.className = 'menu__account-name menu__header-name';

  const menuMetaRow = document.createElement('div');
  menuMetaRow.className = 'menu__account-meta-row';

  const rolePill = document.createElement('span');
  rolePill.className = 'menu__account-role-pill';
  rolePill.textContent = roleLabel;

  const menuJurisdiction = document.createElement('span');
  menuJurisdiction.className = 'menu__account-jurisdiction';
  menuJurisdiction.innerHTML = `${icons.mapPin(12)}<span>Loading...</span>`;
  menuJurisdiction.hidden = true;
  applyBarangayName(menuJurisdiction, user.barangayId);

  menuMetaRow.append(rolePill, menuJurisdiction);

  const menuStatus = document.createElement('div');
  menuStatus.className = 'menu__account-status';
  menuStatus.innerHTML = `<span class="menu__account-status-dot" aria-hidden="true"></span><span>Active Session</span>`;

  menuDetails.append(menuName, menuMetaRow, menuStatus);
  menuHeader.append(menuAvatar, menuDetails);
  avatarMenu.panel.appendChild(menuHeader);

  if (NAV_ITEMS.find((i) => i.key === 'settings')?.roles.includes(user.role)) {
    avatarMenu.panel.appendChild(MenuItem({
      label: 'Settings',
      description: 'System preferences & profile',
      icon: icons.settings,
      onClick: () => { avatarMenu.close(); navigate('settings'); },
    }));
  }

  const themeAccessory = document.createElement('span');
  themeAccessory.className = 'menu__item-accessory';

  const themeMenuItem = MenuItem({
    label: isCurrentlyDark() ? 'Switch to light theme' : 'Switch to dark theme',
    description: 'Toggle interface appearance',
    icon: isCurrentlyDark() ? icons.sun : icons.moon,
    rightAccessory: themeAccessory,
    onClick: () => {
      avatarMenu.close();
      themeToggle.click();
    },
  });
  avatarMenu.panel.appendChild(themeMenuItem);

  onThemeChanged = () => {
    const dark = isCurrentlyDark();
    themeAccessory.textContent = dark ? 'Dark' : 'Light';
    const labelEl = themeMenuItem.querySelector('.menu__item-label');
    if (labelEl) labelEl.textContent = dark ? 'Switch to light theme' : 'Switch to dark theme';
    const iconEl = themeMenuItem.querySelector('.menu__item-icon');
    if (iconEl) iconEl.innerHTML = dark ? icons.sun(16) : icons.moon(16);
  };
  onThemeChanged();

  avatarMenu.panel.appendChild(MenuDivider());

  // Kept as a real element (not just a menu row) because callers rely on
  // `shell.logoutButton` to disable it while signing out.
  const logoutButton = MenuItem({
    label: 'Sign out',
    description: 'End current console session',
    icon: icons.logOut,
    danger: true,
    onClick: () => { avatarMenu.close(); handleLogout(); },
  });
  avatarMenu.panel.appendChild(logoutButton);

  const renderUserLabel = (fullName) => {
    userAvatar.innerHTML = avatarInitials(fullName, 32);
    menuAvatar.innerHTML = avatarInitials(fullName, 40);
    avatarTrigger.setAttribute('aria-label', `Account menu for ${fullName}`);
    menuName.textContent = fullName;
    renderSidebarUser(fullName);
  };
  renderUserLabel(user.fullName);

  topbarUser.append(bellMenu.el, avatarMenu.el);
  topbar.append(searchHost, topbarUser);
  loadNotifications();

  // Full-bleed slot for a PageHeader, above the scrolling area so the
  // page title/actions stay fixed while content scrolls (reference
  // behaviour). Pages that don't mount one just leave it empty — it
  // collapses to zero height.
  const header = document.createElement('div');
  header.className = 'page-header-host';

  // <main> landmark (audit A5) — the skip-link's target, and the element a
  // screen-reader user jumps to first on every page.
  const content = document.createElement('main');
  content.className = 'page-content';
  content.id = 'page-main';
  // tabindex="-1": not in the normal Tab order, but DOES become a valid
  // focus target for the skip-link's anchor jump — the standard pattern
  // for a skip link whose destination isn't itself a natural focus stop.
  content.tabIndex = -1;

  const contentContainer = document.createElement('div');
  contentContainer.className = 'page-container';
  content.appendChild(contentContainer);

  mainColumn.append(topbar, header, content);
  el.append(sidebar, scrim, mainColumn);

  // Periodic real-time background notification poller (every 15s).
  // Automatically stops when the shell element is disconnected on navigation.
  const notifPoller = setInterval(() => {
    if (!el.isConnected) {
      clearInterval(notifPoller);
      return;
    }
    loadNotifications();
  }, 15000);

  // Escape closes the mobile drawer from anywhere. Registered on the shell
  // element's own lifetime via the document, and removed when the shell is
  // detached — main.js rebuilds #app wholesale on every navigate(), so a
  // listener added per AppShell() would otherwise accumulate one per
  // navigation (the same trap the module-scope search listener above
  // already documents).
  const onKeydown = (event) => {
    if (!el.isConnected) {
      clearInterval(notifPoller);
      document.removeEventListener('keydown', onKeydown);
      return;
    }
    if (event.key === 'Escape' && sidebar.classList.contains('is-open')) closeDrawer();
  };
  document.addEventListener('keydown', onKeydown);

  // W15 Settings can rename the signed-in user without a full page
  // navigation (so its own success message stays visible) — a real bug
  // caught by this session's own Playwright walkthrough: the topbar name
  // is otherwise only ever set once, from the `user` object AppShell was
  // constructed with, and a sessionStorage update after the fact doesn't
  // retroactively touch an already-rendered DOM text node.
  return { el, header, content: contentContainer, logoutButton, setFullName: renderUserLabel, refreshNavCounts };
}
