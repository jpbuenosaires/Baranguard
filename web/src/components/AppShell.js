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
import { search as apiSearch, getSystemHealth } from '../api/apiClient.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};
const SEARCH_DEBOUNCE_MS = 300;

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
const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', roles: ['admin', 'punong_barangay'], icon: icons.layoutDashboard },
  { key: 'dispatch', label: 'Dispatch Center', roles: ['admin'], icon: icons.radio },
  { key: 'gis', label: 'Live Map', roles: ['admin', 'punong_barangay'], icon: icons.map },
  { key: 'heatmap', label: 'Historical Heatmap', roles: ['admin', 'punong_barangay'], icon: icons.flame },
  { key: 'blotter', label: 'Electronic Blotter', roles: ['admin', 'secretary', 'punong_barangay'], icon: icons.fileText },
  { key: 'reports', label: 'Statistical Reports', roles: ['admin', 'punong_barangay'], icon: icons.barChart },
  { key: 'citizen-inbox', label: 'Citizen Reports', roles: ['admin', 'secretary'], icon: icons.inbox },
  { key: 'scheduler', label: 'Shift Scheduler', roles: ['admin'], icon: icons.calendar },
  { key: 'swap-requests', label: 'Swap Requests', roles: ['admin'], icon: icons.repeat },
  { key: 'fatigue', label: 'Fatigue Flags', roles: ['admin', 'punong_barangay'], icon: icons.batteryWarning },
  // §9 W14 — Admin only, explicitly.
  { key: 'sms-log', label: 'SMS Activity Log', roles: ['admin'], icon: icons.messageSquare },
  { key: 'settings', label: 'Settings', roles: ['admin', 'secretary', 'punong_barangay'], icon: icons.settings },
];

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

  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar' + (readSidebarCollapsed() ? ' is-collapsed' : '');

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
  for (const item of NAV_ITEMS.filter((i) => i.roles.includes(user.role))) {
    const isActive = item.key === activePage;
    const navItem = document.createElement('button');
    navItem.type = 'button';
    navItem.className = 'sidebar__nav-item' + (isActive ? ' active' : '');
    if (isActive) navItem.setAttribute('aria-current', 'page');
    navItem.setAttribute('aria-label', item.label);
    navItem.innerHTML = `<span class="sidebar__nav-icon" aria-hidden="true">${item.icon(18)}</span><span class="sidebar__nav-label">${item.label}</span>`;
    navItem.addEventListener('click', () => navigate(item.key));
    nav.appendChild(navItem);
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

  const topbar = document.createElement('div');
  topbar.className = 'topbar';
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

  async function runSearch(q) {
    let results;
    try {
      results = await apiSearch(q);
    } catch {
      searchResults.innerHTML = '<div class="topbar__search-empty">Search failed. Try again.</div>';
      searchResults.hidden = false;
      return;
    }
    if (results.length === 0) {
      searchResults.innerHTML = '<div class="topbar__search-empty">No matching incidents.</div>';
      searchResults.hidden = false;
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
        navigate('blotter');
      });
      searchResults.appendChild(row);
    }
    searchResults.hidden = false;
  }

  const topbarUser = document.createElement('div');
  topbarUser.className = 'topbar__user';

  // Real system-status badge — GET /system/health (Admin only per §6).
  // Replaces a hardcoded permanently-green "All Systems Operational"
  // badge (§8's exclusions) — this one reflects the API/DB check that
  // actually ran, and is simply omitted for roles that can't call the
  // endpoint rather than showing a fake status for them.
  if (user.role === 'admin') {
    const statusBadge = document.createElement('div');
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

  const userAvatar = document.createElement('span');
  const userLabel = document.createElement('span');
  userLabel.className = 'topbar__user-name';
  const renderUserLabel = (fullName) => {
    userLabel.textContent = fullName;
    userAvatar.innerHTML = avatarInitials(fullName, 32);
    renderSidebarUser(fullName);
  };
  renderUserLabel(user.fullName);
  const logoutButton = document.createElement('button');
  logoutButton.className = 'ghost';
  logoutButton.innerHTML = `<span aria-hidden="true">${icons.logOut(16)}</span><span>Sign out</span>`;
  logoutButton.addEventListener('click', onLogout);
  topbarUser.append(userAvatar, userLabel, logoutButton);
  topbar.append(searchHost, topbarUser);

  // Full-bleed slot for a PageHeader, above the scrolling area so the
  // page title/actions stay fixed while content scrolls (reference
  // behaviour). Pages that don't mount one just leave it empty — it
  // collapses to zero height.
  const header = document.createElement('div');
  header.className = 'page-header-host';

  const content = document.createElement('div');
  content.className = 'page-content';
  content.id = 'page-main';
  // tabindex="-1": not in the normal Tab order, but DOES become a valid
  // focus target for the skip-link's anchor jump — the standard pattern
  // for a skip link whose destination isn't itself a natural focus stop.
  content.tabIndex = -1;

  mainColumn.append(topbar, header, content);
  el.append(sidebar, mainColumn);

  // W15 Settings can rename the signed-in user without a full page
  // navigation (so its own success message stays visible) — a real bug
  // caught by this session's own Playwright walkthrough: the topbar name
  // is otherwise only ever set once, from the `user` object AppShell was
  // constructed with, and a sessionStorage update after the fact doesn't
  // retroactively touch an already-rendered DOM text node.
  return { el, header, content, logoutButton, setFullName: renderUserLabel };
}
