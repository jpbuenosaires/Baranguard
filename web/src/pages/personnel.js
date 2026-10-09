/**
 * personnel.js — Personnel (2026-09-05 UX pass): merges the four
 * standalone W10-W13 screens (User Management, Shift Scheduler, Swap
 * Requests, Fatigue Flags) into one tabbed screen, the same
 * shared-AppShell/PageHeader/`.page-tabs` tab pattern
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
 * AppShell/PageHeader/tab-switching shell is new here.
 *
 * 2026-10 (docs/FEATURE_CONTRACT_2026-10.md §10): the Fatigue Flags tab was
 * removed from this hub. Users gained official title/approval authority
 * editing; Scheduler gained availability review, draft/published badges and
 * a Publish action. Swap requests remain their own tab. Admin sees all
 * three tabs; Secretary sees Scheduler + Swap requests (2026-10-07: the
 * Secretary builds the roster and resolves swaps); Punong Barangay sees the
 * Scheduler only (roster approval lives there).
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
// fatigue-flags.js (and its endpoints) are intentionally left in the repo
// but are no longer mounted here: the 2026-10 tanod-workflow contract
// (§8, §10) removes the Fatigue tab from the hub.

/**
 * @param {HTMLElement} root
 * @param {{userId:number, fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 * @param {string} [param] optional initial tab to display
 */
export function renderPersonnelPage(root, user, onLoggedOut, navigate, param) {
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
    subtitle: 'Accounts, approval authority, the duty roster, and swap requests in one place',
    icon: icons.users,
  });
  header.appendChild(pageHeader.el);

  const isAdmin = user.role === 'admin';
  // 2026-10-07: the Secretary resolves shift swaps too (the server allows
  // GET/PATCH /shift-swap-requests for admin and secretary).
  const canResolveSwaps = isAdmin || user.role === 'secretary';

  // Admin: Users, Scheduler, Swap requests. Secretary: Scheduler and Swap
  // requests (build the roster, review availability, resolve swaps).
  // Punong Barangay: Scheduler only (roster publishing). The server checks
  // role and approval authority on every action; the Users endpoints are
  // Admin-only. Swap requests stay a tab of their own so they remain one
  // click from the Scheduler (contract §10).
  const TABS = [
    isAdmin && { key: 'users', label: 'Users', icon: icons.users },
    { key: 'scheduler', label: 'Scheduler', icon: icons.calendar },
    canResolveSwaps && { key: 'swaps', label: 'Swap requests', icon: icons.repeat, badgeKey: 'pendingSwapRequests' },
  ].filter(Boolean);

  const tabBar = document.createElement('div');
  tabBar.className = 'page-tabs-bar';

  const tabRow = document.createElement('div');
  tabRow.className = 'page-tabs';
  const tabButtons = {};
  const badgeSlots = {};

  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-tab';

    if (tab.icon) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'page-tab__icon';
      iconSpan.setAttribute('aria-hidden', 'true');
      iconSpan.innerHTML = tab.icon(16);
      btn.appendChild(iconSpan);
    }

    const labelSpan = document.createElement('span');
    labelSpan.textContent = tab.label;
    btn.appendChild(labelSpan);

    if (tab.badgeKey) {
      const badge = document.createElement('span');
      badge.className = 'page-tab__badge';
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
  body.className = 'personnel-container';
  content.appendChild(body);

  // Initialize with requested tab if valid, or first available tab
  const validTabKeys = TABS.map((t) => t.key);
  // `param` is a tab key string, or an object carrying one (`{ tab }`, as the
  // Approvals page sends) — other callers pass unrelated objects (the audit
  // log sends `{ userId }`), which simply fall back to the first tab.
  const requestedTab = param && typeof param === 'object' ? param.tab : param;
  let activeTab = requestedTab && validTabKeys.includes(requestedTab) ? requestedTab : TABS[0].key;
  let activeTabData = null;

  function syncTabButtons() {
    for (const [key, btn] of Object.entries(tabButtons)) {
      btn.classList.toggle('is-active', key === activeTab);
      // Not colour-only: assistive tech also learns which tab is current.
      if (key === activeTab) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
  }

  function setActiveTab(key, tabData = null) {
    if (activeTab === key && !tabData) return;
    activeTab = key;
    activeTabData = tabData;
    syncTabButtons();
    renderActiveTab();
  }

  function renderActiveTab() {
    pageHeader.actions.innerHTML = '';
    body.innerHTML = '';

    // Re-trigger CSS animation unless reduced motion is preferred
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      body.style.animation = 'none';
      void body.offsetHeight; // trigger reflow
      body.style.animation = '';
    }

    const currentTabData = activeTabData;
    activeTabData = null;

    if (activeTab === 'users') {
      renderUsersTab(body, pageHeader, user);
    } else if (activeTab === 'scheduler') {
      renderSchedulerTab(body, user, pageHeader, currentTabData, canResolveSwaps ? () => { setActiveTab('swaps'); } : undefined);
    } else if (activeTab === 'swaps') {
      renderSwapRequestsTab(body, user, refreshBadges);
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
