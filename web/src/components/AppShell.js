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
  { key: 'settings', label: 'Settings', roles: ['admin', 'secretary', 'punong_barangay'], icon: icons.settings },
];

/**
 * @param {{fullName:string, role:string}} user
 * @param {string} activePage
 * @param {(page: string) => void} navigate
 * @param {() => void} onLogout
 * @returns {{el:HTMLElement, content:HTMLElement, logoutButton:HTMLButtonElement, setFullName:(fullName:string)=>void}}
 */
export function AppShell(user, activePage, navigate, onLogout) {
  const el = document.createElement('div');
  el.className = 'app-shell';

  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  const brand = document.createElement('div');
  brand.className = 'sidebar__brand';
  brand.innerHTML = `<span class="icon-badge icon-badge--brand">${icons.shield(22)}</span><span>Baranguard</span>`;
  const nav = document.createElement('nav');
  nav.className = 'sidebar__nav';

  for (const item of NAV_ITEMS.filter((i) => i.roles.includes(user.role))) {
    const navItem = document.createElement('div');
    navItem.className = 'sidebar__nav-item' + (item.key === activePage ? ' active' : '');
    navItem.innerHTML = `<span class="sidebar__nav-icon">${item.icon(18)}</span><span class="sidebar__nav-label">${item.label}</span>`;
    navItem.addEventListener('click', () => navigate(item.key));
    nav.appendChild(navItem);
  }
  sidebar.append(brand, nav);

  const mainColumn = document.createElement('div');
  mainColumn.className = 'main-column';

  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  const ROLE_LABELS = { admin: 'Admin', secretary: 'Secretary', punong_barangay: 'Punong Barangay (read-only)' };
  const roleLabel = ROLE_LABELS[user.role] ?? user.role;
  const titleHost = document.createElement('div');
  const topbarUser = document.createElement('div');
  topbarUser.className = 'topbar__user';
  const userLabel = document.createElement('span');
  const renderUserLabel = (fullName) => { userLabel.textContent = `${fullName} · ${roleLabel}`; };
  renderUserLabel(user.fullName);
  const logoutButton = document.createElement('button');
  logoutButton.className = 'ghost';
  logoutButton.innerHTML = `${icons.logOut(16)}<span>Sign out</span>`;
  logoutButton.addEventListener('click', onLogout);
  topbarUser.append(userLabel, logoutButton);
  topbar.append(titleHost, topbarUser);

  const content = document.createElement('div');
  content.className = 'page-content';

  mainColumn.append(topbar, content);
  el.append(sidebar, mainColumn);

  // W15 Settings can rename the signed-in user without a full page
  // navigation (so its own success message stays visible) — a real bug
  // caught by this session's own Playwright walkthrough: the topbar name
  // is otherwise only ever set once, from the `user` object AppShell was
  // constructed with, and a sessionStorage update after the fact doesn't
  // retroactively touch an already-rendered DOM text node.
  return { el, content, logoutButton, setFullName: renderUserLabel };
}
