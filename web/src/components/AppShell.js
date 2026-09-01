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
 *
 * @param {{fullName:string, role:string}} user
 * @param {string} activePage
 * @param {(page: string) => void} navigate
 * @param {() => void} onLogout
 * @returns {{el:HTMLElement, content:HTMLElement, logoutButton:HTMLButtonElement}}
 */
export function AppShell(user, activePage, navigate, onLogout) {
  const el = document.createElement('div');
  el.className = 'app-shell';

  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  const brand = document.createElement('div');
  brand.className = 'sidebar__brand';
  brand.textContent = 'Baranguard';
  const nav = document.createElement('nav');
  nav.className = 'sidebar__nav';

  // §9 role gates: W2 Dashboard and W4 Live Map are Admin + Punong
  // Barangay (read-only); W3 Dispatch Center's create/cancel actions are
  // Admin only, with no separate read-only variant built this session —
  // so PB simply doesn't get that nav item rather than landing on a page
  // that silently can't do anything.
  const NAV_ITEMS = [
    { key: 'dashboard', label: 'Dashboard', roles: ['admin', 'punong_barangay'] },
    { key: 'dispatch', label: 'Dispatch Center', roles: ['admin'] },
    { key: 'gis', label: 'Live Map', roles: ['admin', 'punong_barangay'] },
  ].filter((item) => item.roles.includes(user.role));
  for (const item of NAV_ITEMS) {
    const navItem = document.createElement('div');
    navItem.className = 'sidebar__nav-item' + (item.key === activePage ? ' active' : '');
    navItem.textContent = item.label;
    navItem.addEventListener('click', () => navigate(item.key));
    nav.appendChild(navItem);
  }
  sidebar.append(brand, nav);

  const mainColumn = document.createElement('div');
  mainColumn.className = 'main-column';

  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  const roleLabel = user.role === 'punong_barangay' ? 'Punong Barangay (read-only)' : 'Admin';
  const titleHost = document.createElement('div');
  const topbarUser = document.createElement('div');
  topbarUser.className = 'topbar__user';
  const userLabel = document.createElement('span');
  userLabel.textContent = `${user.fullName} · ${roleLabel}`;
  const logoutButton = document.createElement('button');
  logoutButton.className = 'ghost';
  logoutButton.textContent = 'Sign out';
  logoutButton.addEventListener('click', onLogout);
  topbarUser.append(userLabel, logoutButton);
  topbar.append(titleHost, topbarUser);

  const content = document.createElement('div');
  content.className = 'page-content';

  mainColumn.append(topbar, content);
  el.append(sidebar, mainColumn);

  return { el, content, logoutButton };
}
