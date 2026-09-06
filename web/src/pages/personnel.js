/**
 * personnel.js — Personnel (2026-09-05 UX pass): merges the four
 * standalone W10-W13 screens (User Management, Shift Scheduler, Swap
 * Requests, Fatigue Flags) into one tabbed screen, the same
 * shared-AppShell/PageHeader/`.filter-chip-row` tab pattern
 * `sms-monitor.js` already established for Conversations/Activity Log.
 *
 * Why: all four already lived under the same sidebar "Personnel" group
 * and share one domain (staffing); user asked whether they could just be
 * one screen, and — unlike the Historical Heatmap/Incident Management
 * question asked right before this one — the role story here actually
 * supports it (see the tab-visibility gating below), so this is that
 * merge, not a full rebuild.
 *
 * Each tab's real logic still lives in its own file (users tab ->
 * user-management.js's `renderUsersTab`, etc.) — only the outer
 * AppShell/PageHeader/tab-switching shell is new here. Only Fatigue
 * Flags is visible to Punong Barangay (read-only), matching every one of
 * these screens' existing role split; the other three collapse away
 * entirely for that role rather than rendering disabled.
 *
 * Sidebar badges (`pendingSwapRequests`/`unacknowledgedFatigueFlags`)
 * used to live on their own separate nav items via `GET
 * /reports/nav-counts` (Admin only). With those nav items gone, this
 * page fetches the same counts itself and shows them on the matching tab
 * chip instead — same data source, moved from the sidebar to the tab bar.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getNavCounts, logout } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { renderUsersTab } from './user-management.js';
import { renderSchedulerTab } from './scheduler.js';
import { renderSwapRequestsTab } from './swap-requests.js';
import { renderFatigueFlagsTab } from './fatigue-flags.js';

/**
 * @param {HTMLElement} root
 * @param {{userId:number, fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
export function renderPersonnelPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'personnel', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'Personnel',
    subtitle: 'Accounts, scheduling, swap requests, and fatigue in one place',
    icon: icons.users,
  });
  header.appendChild(pageHeader.el);

  const isAdmin = user.role === 'admin';

  // Admin sees all four; Punong Barangay (read-only oversight) sees only
  // the one tab it was ever allowed to see as a standalone page.
  const TABS = [
    isAdmin && { key: 'users', label: 'Users' },
    isAdmin && { key: 'scheduler', label: 'Scheduler' },
    isAdmin && { key: 'swaps', label: 'Swap requests', badgeKey: 'pendingSwapRequests' },
    { key: 'fatigue', label: 'Fatigue flags', badgeKey: 'unacknowledgedFatigueFlags' },
  ].filter(Boolean);

  const tabBar = document.createElement('div');
  tabBar.className = 'page-tabs-bar';

  const tabRow = document.createElement('div');
  tabRow.className = 'filter-chip-row';
  const tabButtons = {};
  const badgeSlots = {};
  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip';
    btn.textContent = tab.label;
    if (tab.badgeKey) {
      const badge = document.createElement('span');
      badge.className = 'sidebar__nav-badge';
      badge.hidden = true;
      btn.appendChild(badge);
      badgeSlots[tab.badgeKey] = badge;
    }
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
    if (activeTab === 'users') {
      renderUsersTab(body, pageHeader, user);
    } else if (activeTab === 'scheduler') {
      renderSchedulerTab(body, user);
    } else if (activeTab === 'swaps') {
      renderSwapRequestsTab(body, user, refreshBadges);
    } else if (activeTab === 'fatigue') {
      renderFatigueFlagsTab(body, user, refreshBadges);
    }
  }

  // Admin-only endpoint (same restriction the old per-nav-item badges
  // already had — a Punong Barangay session never saw a badge either).
  function refreshBadges() {
    if (!isAdmin) return;
    getNavCounts().then((counts) => {
      for (const [key, badge] of Object.entries(badgeSlots)) {
        const count = counts[key];
        badge.hidden = !count;
        if (count) badge.textContent = String(count);
      }
    }).catch(() => {
      // Badge counts are a convenience; a failed fetch just leaves them hidden.
    });
  }

  syncTabButtons();
  renderActiveTab();
  refreshBadges();
}
