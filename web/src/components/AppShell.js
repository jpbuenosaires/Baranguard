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
import { Menu, MenuItem } from './Menu.js';
import { search as apiSearch, getSystemHealth, getNavCounts, getNotifications } from '../api/apiClient.js';

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
// again. No stored preference at all (first-ever load) still means
// "system" — index.html's own bootstrap script only sets data-theme when a
// stored value exists, so base.css's `prefers-color-scheme` block is what
// governs a user who has never touched the toggle.
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
const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', roles: ['admin', 'punong_barangay'], icon: icons.layoutDashboard },
  { key: 'dispatch', label: 'Dispatch Center', roles: ['admin'], icon: icons.radio, countKey: 'pendingIncidents' },
  { key: 'incident-management', label: 'Incident Management', roles: ['admin', 'secretary'], icon: icons.alertTriangle },
  { key: 'gis', label: 'Live Map', roles: ['admin', 'punong_barangay'], icon: icons.map },
  { key: 'heatmap', label: 'Historical Heatmap', roles: ['admin', 'punong_barangay'], icon: icons.flame },
  { key: 'blotter', label: 'Electronic Blotter', roles: ['admin', 'secretary', 'punong_barangay'], icon: icons.fileText },
  { key: 'reports', label: 'Analytics', roles: ['admin', 'punong_barangay'], icon: icons.barChart },
  { key: 'citizen-inbox', label: 'Citizen Reports', roles: ['admin', 'secretary'], icon: icons.inbox, countKey: 'unconvertedCitizenReports' },
  { key: 'scheduler', label: 'Shift Scheduler', roles: ['admin'], icon: icons.calendar },
  { key: 'swap-requests', label: 'Swap Requests', roles: ['admin'], icon: icons.repeat, countKey: 'pendingSwapRequests' },
  { key: 'fatigue', label: 'Fatigue Flags', roles: ['admin', 'punong_barangay'], icon: icons.batteryWarning, countKey: 'unacknowledgedFatigueFlags' },
  // §9 W14 — Admin only, explicitly.
  { key: 'sms-log', label: 'SMS Activity Log', roles: ['admin'], icon: icons.messageSquare },
  { key: 'settings', label: 'Settings', roles: ['admin', 'secretary', 'punong_barangay'], icon: icons.settings },
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
  brand.innerHTML = `<span class="icon-badge icon-badge--brand" aria-hidden="true">${icons.shield(22)}</span><span class="sidebar__wordmark">BARANGUARD</span>`;

  // Collapse toggle (the X / Menu button in the reference's logo row).
  const collapseButton = document.createElement('button');
  collapseButton.type = 'button';
  collapseButton.className = 'sidebar__collapse';
  const syncCollapseButton = () => {
    const collapsed = sidebar.classList.contains('is-collapsed');
    collapseButton.innerHTML = collapsed ? icons.menu(18) : icons.x(18);
    collapseButton.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
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
  for (const item of NAV_ITEMS.filter((i) => i.roles.includes(user.role))) {
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
  sidebarUser.append(sidebarAvatar, sidebarUserText);

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

  // Real search — GET /search, incidents only (see SearchController.php's
  // own doc for scope). Replaces a prior placeholder input that called
  // nothing (§8: no decorative control that does nothing when used).
  const searchHost = document.createElement('div');
  searchHost.className = 'topbar__search';
  const searchLabel = document.createElement('label');
  searchLabel.className = 'sr-only';
  searchLabel.htmlFor = 'topbar-search';
  searchLabel.textContent = 'Search incidents';
  const searchInput = document.createElement('input');
  searchInput.id = 'topbar-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search incidents by ID, type, or status…';
  searchInput.autocomplete = 'off';
  const searchResults = document.createElement('div');
  searchResults.className = 'topbar__search-results';
  searchResults.hidden = true;
  searchHost.append(searchLabel, searchInput, searchResults);
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
      row.innerHTML = `<strong>#${item.incidentId} — ${typeLabel}</strong><span class="status-pill status-pill--neutral">${item.status}</span>`;
      row.addEventListener('click', () => {
        searchResults.hidden = true;
        searchInput.value = '';
        // Was navigate('blotter') for every result — searching for an
        // incident by ID and clicking it dumped you on the unfiltered
        // list rather than that incident. blotter-detail takes the id.
        navigate('blotter-detail', item.incidentId);
      });
      searchResults.appendChild(row);
    }
  }

  const topbarUser = document.createElement('div');
  topbarUser.className = 'topbar__user';

  // Theme toggle — every role gets this (unlike the Admin-only status
  // badge below), since it's a personal display preference, not
  // operational diagnostics.
  const themeToggle = document.createElement('button');
  themeToggle.type = 'button';
  themeToggle.className = 'icon-btn';
  const syncThemeToggleIcon = () => {
    const dark = isCurrentlyDark();
    themeToggle.innerHTML = dark ? icons.sun(16) : icons.moon(16);
    themeToggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    themeToggle.title = themeToggle.getAttribute('aria-label');
  };
  syncThemeToggleIcon();
  themeToggle.addEventListener('click', () => {
    const next = isCurrentlyDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    writeStoredTheme(next);
    syncThemeToggleIcon();
  });
  topbarUser.appendChild(themeToggle);

  // Real system-status badge — GET /system/health (Admin only per §6).
  // Replaces a hardcoded permanently-green "All Systems Operational"
  // badge (§8's exclusions) — this one reflects the API/DB check that
  // actually ran, and is simply omitted for roles that can't call the
  // endpoint rather than showing a fake status for them.
  if (user.role === 'admin') {
    const statusBadge = document.createElement('div');
    // The text changes asynchronously once the health probe resolves, so
    // it needs to be announced rather than silently swapped.
    statusBadge.setAttribute('role', 'status');
    statusBadge.className = 'status-badge status-badge--checking';
    statusBadge.innerHTML = '<span class="status-badge__dot"></span><span class="status-badge__text">Checking…</span>';
    topbarUser.appendChild(statusBadge);
    getSystemHealth().then((health) => {
      const operational = health.api === 'healthy' && health.db === 'healthy';
      statusBadge.className = 'status-badge status-badge--' + (operational ? 'ok' : 'down');
      statusBadge.querySelector('.status-badge__text').textContent = operational ? 'All Systems Operational' : 'Database Unavailable';
      statusBadge.title = `API: ${health.api} · DB: ${health.db} · OSRM: ${health.osrm} · Ollama: ${health.ollama} · GSM: ${health.gsmIngestion} · Notifications: ${health.notificationConfig}`;
    }).catch(() => {
      statusBadge.className = 'status-badge status-badge--down';
      statusBadge.querySelector('.status-badge__text').textContent = 'Status unavailable';
    });
  }

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

  const bellMenu = Menu({
    trigger: bellTrigger,
    label: 'Notifications',
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
    if (result.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'menu__empty';
      empty.textContent = 'Nothing to review right now.';
      bellMenu.panel.appendChild(empty);
      return;
    }
    for (const item of result.items) {
      const unread = item.ackStatus === 'pending';
      const row = MenuItem({
        label: NOTIFICATION_LABELS[item.notificationType] ?? item.notificationType,
        icon: item.notificationType === 'sos' ? icons.alertTriangle : icons.bell,
        description: new Date(item.createdAt).toLocaleString(),
        onClick: () => {
          bellMenu.close();
          // Follow the notification to the thing it is about. There is no
          // narrative in the payload by design, so the link IS the content.
          if (item.incidentId) navigate('blotter-detail', item.incidentId);
          else if (item.sosId || item.dispatchId) navigate('dispatch');
        },
      });
      if (unread) row.classList.add('notification-item--unread');
      bellMenu.panel.appendChild(row);
    }
  }

  async function loadNotifications() {
    try {
      renderNotifications(await getNotifications({ limit: 15 }));
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
  const avatarChevron = document.createElement('span');
  avatarChevron.setAttribute('aria-hidden', 'true');
  avatarChevron.innerHTML = icons.chevronDown(14);
  avatarTrigger.append(userAvatar, avatarChevron);

  const avatarMenu = Menu({ trigger: avatarTrigger, label: 'Account' });

  const menuHeader = document.createElement('div');
  menuHeader.className = 'menu__header';
  const menuName = document.createElement('div');
  menuName.className = 'menu__header-name';
  const menuMeta = document.createElement('div');
  menuMeta.className = 'menu__header-meta';
  menuMeta.textContent = roleLabel;
  menuHeader.append(menuName, menuMeta);
  avatarMenu.panel.appendChild(menuHeader);

  if (NAV_ITEMS.find((i) => i.key === 'settings')?.roles.includes(user.role)) {
    avatarMenu.panel.appendChild(MenuItem({
      label: 'Settings',
      icon: icons.settings,
      onClick: () => { avatarMenu.close(); navigate('settings'); },
    }));
  }
  avatarMenu.panel.appendChild(MenuItem({
    label: isCurrentlyDark() ? 'Switch to light theme' : 'Switch to dark theme',
    icon: isCurrentlyDark() ? icons.sun : icons.moon,
    onClick: () => { avatarMenu.close(); themeToggle.click(); },
  }));

  // Kept as a real element (not just a menu row) because callers rely on
  // `shell.logoutButton` to disable it while signing out.
  const logoutButton = MenuItem({
    label: 'Sign out',
    icon: icons.logOut,
    danger: true,
    onClick: () => { avatarMenu.close(); onLogout(); },
  });
  avatarMenu.panel.appendChild(logoutButton);

  const renderUserLabel = (fullName) => {
    userAvatar.innerHTML = avatarInitials(fullName, 32);
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

  mainColumn.append(topbar, header, content);
  el.append(sidebar, scrim, mainColumn);

  // Escape closes the mobile drawer from anywhere. Registered on the shell
  // element's own lifetime via the document, and removed when the shell is
  // detached — main.js rebuilds #app wholesale on every navigate(), so a
  // listener added per AppShell() would otherwise accumulate one per
  // navigation (the same trap the module-scope search listener above
  // already documents).
  const onKeydown = (event) => {
    if (!el.isConnected) { document.removeEventListener('keydown', onKeydown); return; }
    if (event.key === 'Escape' && sidebar.classList.contains('is-open')) closeDrawer();
  };
  document.addEventListener('keydown', onKeydown);

  // W15 Settings can rename the signed-in user without a full page
  // navigation (so its own success message stays visible) — a real bug
  // caught by this session's own Playwright walkthrough: the topbar name
  // is otherwise only ever set once, from the `user` object AppShell was
  // constructed with, and a sessionStorage update after the fact doesn't
  // retroactively touch an already-rendered DOM text node.
  return { el, header, content, logoutButton, setFullName: renderUserLabel, refreshNavCounts };
}
