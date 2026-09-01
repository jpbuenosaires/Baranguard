/**
 * admin-dashboard.js — W2 Admin Dashboard (§9): "KPI cards plus trend
 * chart. The API returns trend[] with a defined date bucket and counts,
 * so the chart never invents a client-side data shape. Fresh deployments
 * show an intentional empty state." Roles: Admin, Punong Barangay
 * (read-only) — this screen has no write action at all, so there is
 * nothing role-specific to disable in the UI; both roles just call the
 * same GET.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getReportsSummary, logout, ApiClientError } from '../api/apiClient.js';
import { KpiCard } from '../components/KpiCard.js';
import { TrendChart } from '../components/TrendChart.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};
const STATUS_LABELS = { pending: 'Pending', dispatched: 'Dispatched', resolved: 'Resolved' };
const STATUS_PILL_CLASS = { pending: 'status-pill--pending', dispatched: 'status-pill--info', resolved: 'status-pill--success' };

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 */
export function renderAdminDashboardPage(root, user, onLoggedOut) {
  root.innerHTML = '';

  const shell = document.createElement('div');
  shell.className = 'app-shell';

  // --- Sidebar --------------------------------------------------------
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="sidebar__brand">Baranguard</div>
    <nav class="sidebar__nav">
      <div class="sidebar__nav-item active">Dashboard</div>
    </nav>
  `;
  // Only Dashboard exists so far (this is the only built screen this
  // session) — no placeholder links to unbuilt screens, per §8's
  // "no demo/prototype tells" (a dead nav link is its own kind of tell).

  // --- Main column ------------------------------------------------------
  const mainColumn = document.createElement('div');
  mainColumn.className = 'main-column';

  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  const roleLabel = user.role === 'punong_barangay' ? 'Punong Barangay (read-only)' : 'Admin';
  topbar.innerHTML = `<div><h2>Admin Dashboard</h2></div>`;
  const topbarUser = document.createElement('div');
  topbarUser.className = 'topbar__user';
  const userLabel = document.createElement('span');
  userLabel.textContent = `${user.fullName} · ${roleLabel}`;
  const logoutButton = document.createElement('button');
  logoutButton.className = 'ghost';
  logoutButton.textContent = 'Sign out';
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  topbarUser.append(userLabel, logoutButton);
  topbar.appendChild(topbarUser);

  const content = document.createElement('div');
  content.className = 'page-content';

  // Date range controls
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:24px;';
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.value = daysAgoIso(29);
  fromInput.style.width = 'auto';
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.value = todayIso();
  toInput.style.width = 'auto';
  const applyButton = document.createElement('button');
  applyButton.className = 'primary';
  applyButton.textContent = 'Apply';
  controls.append(
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'From' }),
    fromInput,
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'To' }),
    toInput,
    applyButton
  );

  const body = document.createElement('div');

  content.append(controls, body);
  mainColumn.append(topbar, content);
  shell.append(sidebar, mainColumn);
  root.appendChild(shell);

  applyButton.addEventListener('click', () => load(fromInput.value, toInput.value));
  // Initial load sends NO date params, deliberately — see load()'s comment
  // below for why. fromInput/toInput start out showing a client-computed
  // guess only so the date pickers aren't empty; load() overwrites them
  // with the server's actual range once the response comes back.
  load(undefined, undefined);

  async function load(dateFrom, dateTo) {
    renderLoading(body);
    try {
      const summary = await getReportsSummary({ dateFrom, dateTo });

      // The date inputs show a *guess* at the default range, computed in
      // the browser's local timezone (todayIso()/daysAgoIso() above) —
      // that can disagree with the server's Asia/Manila-based default by
      // a day at the boundary. Explicitly sending that guessed range on
      // first load would make the client, not the server, define "the
      // last 30 days" — silently wrong by a day whenever the two
      // timezones' calendar days don't line up. So the initial load omits
      // date_from/date_to entirely and lets the server's real default
      // win; once summary.trend comes back, the inputs are corrected to
      // reflect the range the server actually used, so a later manual
      // Apply starts from truth, not from the initial guess.
      if (summary.trend && summary.trend.length > 0) {
        fromInput.value = summary.trend[0].date;
        toInput.value = summary.trend[summary.trend.length - 1].date;
      }

      const isFreshDeployment = summary.totalIncidents === 0 && summary.activeTanods === 0;
      if (isFreshDeployment) {
        renderEmpty(body);
      } else {
        renderPopulated(body, summary);
      }
    } catch (err) {
      const message = err instanceof ApiClientError
        ? err.message
        : 'Something went wrong loading the dashboard.';
      renderError(body, message, () => load(dateFrom, dateTo));
    }
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'kpi-grid';
  for (let i = 0; i < 4; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'card';
    skeleton.innerHTML = '<div class="skeleton" style="height:14px;width:60%;margin-bottom:12px;"></div><div class="skeleton" style="height:32px;width:40%;"></div>';
    grid.appendChild(skeleton);
  }
  const chartSkeleton = document.createElement('div');
  chartSkeleton.className = 'card skeleton';
  chartSkeleton.style.height = '176px';
  container.append(grid, chartSkeleton);
}

function renderEmpty(container) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = `
    <h3>No activity yet</h3>
    <p>This barangay hasn't logged any incidents or on-duty Tanods yet. Once incidents are reported and Tanods are on duty, this dashboard fills in automatically.</p>
  `;
  container.appendChild(block);
}

function renderError(container, message, onRetry) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block state-block--error';
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}

function renderPopulated(container, summary) {
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'kpi-grid';
  grid.append(
    KpiCard({ label: 'Total Incidents', value: summary.totalIncidents }),
    KpiCard({ label: 'Resolved', value: summary.resolvedCount }),
    KpiCard({
      label: 'Avg. Response Time',
      value: summary.avgResponseTimeMinutes === null ? null : `${summary.avgResponseTimeMinutes} min`,
      emptyText: 'No arrivals yet',
    }),
    KpiCard({ label: 'Tanods On Duty', value: summary.activeTanods })
  );

  const trendCard = document.createElement('div');
  trendCard.className = 'card';
  trendCard.innerHTML = '<h3 style="margin-bottom:16px;">Incident Trend</h3>';
  trendCard.appendChild(TrendChart({ trend: summary.trend }));

  const breakdownGrid = document.createElement('div');
  breakdownGrid.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-top:16px;';
  breakdownGrid.append(
    renderBreakdownCard('By Status', summary.byStatus, STATUS_LABELS, STATUS_PILL_CLASS),
    renderBreakdownCard('By Incident Type', summary.byIncidentType, INCIDENT_TYPE_LABELS, {})
  );

  container.append(grid, trendCard, breakdownGrid);
}

function renderBreakdownCard(title, counts, labels, pillClasses) {
  const card = document.createElement('div');
  card.className = 'card';
  const heading = document.createElement('h3');
  heading.textContent = title;
  heading.style.marginBottom = '12px';
  card.appendChild(heading);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  for (const [key, count] of Object.entries(counts)) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; font-size:0.875rem;';
    const label = document.createElement('span');
    const pillClass = pillClasses[key];
    if (pillClass) {
      label.innerHTML = `<span class="status-pill ${pillClass}">${labels[key] || key}</span>`;
    } else {
      label.textContent = labels[key] || key;
    }
    const value = document.createElement('span');
    value.style.fontWeight = '600';
    value.textContent = String(count);
    row.append(label, value);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}
