/**
 * analytics.js — Analytics (2026-09-05 UX pass): merges W9 Statistical
 * Reports and W5 Historical Heatmap into one tabbed screen, the same
 * shared-AppShell/PageHeader/`.filter-chip-row` tab pattern
 * `sms-monitor.js`/`personnel.js` already use.
 *
 * Why these two specifically: both are Admin/Punong Barangay (read-only)
 * — the exact same role pair, so unlike Personnel there is no per-tab
 * gating at all — and both are bounded, historical, no-write-action
 * screens (pick a date range, look at aggregate data). This is the pair
 * the user asked about right after Incident Management + Heatmap, which
 * was declined for the opposite reasons (different roles, and Incident
 * Management's live/operational nature clashing with Heatmap's explicit
 * "not predictive or real-time" framing) — see `backend/DEVLOG.md`.
 *
 * Each tab's real logic still lives in its own file (Reports ->
 * `statistical-reports.js`'s `renderReportsTab`, Heatmap ->
 * `historical-heatmap.js`'s `renderHeatmapTab`) — only the outer shell
 * is new here.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { logout } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { renderReportsTab } from './statistical-reports.js';
import { renderHeatmapTab } from './historical-heatmap.js';

const TABS = [
  { key: 'reports', label: 'Reports' },
  { key: 'heatmap', label: 'Heatmap' },
];

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderAnalyticsPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'analytics', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'Analytics',
    subtitle: 'Reports and historical patterns for a chosen date range',
    icon: icons.barChart,
  });
  header.appendChild(pageHeader.el);

  const tabBar = document.createElement('div');
  tabBar.className = 'page-tabs-bar';

  const tabRow = document.createElement('div');
  tabRow.className = 'filter-chip-row';
  const tabButtons = {};
  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip';
    btn.textContent = tab.label;
    btn.addEventListener('click', () => setActiveTab(tab.key));
    tabButtons[tab.key] = btn;
    tabRow.appendChild(btn);
  }
  tabBar.appendChild(tabRow);
  header.appendChild(tabBar);

  const body = document.createElement('div');
  content.appendChild(body);

  let activeTab = TABS[0].key;

  function syncTabButtons() {
    for (const [key, btn] of Object.entries(tabButtons)) btn.classList.toggle('is-active', key === activeTab);
  }

  function setActiveTab(key) {
    activeTab = key;
    syncTabButtons();
    renderActiveTab();
  }

  function renderActiveTab() {
    pageHeader.actions.innerHTML = '';
    body.innerHTML = '';
    if (activeTab === 'reports') {
      renderReportsTab(body, pageHeader, user);
    } else if (activeTab === 'heatmap') {
      renderHeatmapTab(body, pageHeader, user);
    }
  }

  syncTabButtons();
  renderActiveTab();
}
