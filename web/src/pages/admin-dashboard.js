/**
 * admin-dashboard.js — W2 Admin Dashboard (§9): "KPI cards plus trend
 * chart. The API returns trend[] with a defined date bucket and counts,
 * so the chart never invents a client-side data shape. Fresh deployments
 * show an intentional empty state." Roles: Admin, Punong Barangay
 * (read-only) — this screen has no write action at all, so there is
 * nothing role-specific to disable in the UI; both roles just call the
 * same GET.
 *
 * 2026-09-02 "Phase 1" addition — Recent Incidents panel, Tanods On Duty
 * panel, and KPI period-over-period deltas. All three are built entirely
 * from endpoints that already exist (GET /incidents, GET /duty-status,
 * GET /users?role=, and a second GET /reports/summary call for the
 * previous period) — no new backend route or response field was added.
 * The delta is computed client-side by calling GET /reports/summary a
 * second time for the immediately-preceding period of equal length; that
 * second call is best-effort (wrapped separately from the main load) so
 * a slow/failed previous-period fetch never blocks the dashboard's core
 * data from rendering.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getReportsSummary, getIncidents, getDutyStatus, getUsers, getTanodSos, getBarangays, logout, ApiClientError } from '../api/apiClient.js';
import { KpiCard } from '../components/KpiCard.js';
import { LineChart } from '../components/LineChart.js';
import { DonutChart } from '../components/DonutChart.js';
import { DataTable } from '../components/DataTable.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { avatarInitials } from '../components/Avatar.js';
import { InfoTip } from '../components/Tooltip.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};
// §8 "Adopted UI reference": categorical chart palette, cycled since §5
// fixes incident_type to exactly these 11 enum members.
const INCIDENT_TYPE_COLORS = [
  'var(--chart-cat-1)', 'var(--chart-cat-2)', 'var(--chart-cat-3)', 'var(--chart-cat-4)',
  'var(--chart-cat-5)', 'var(--chart-cat-6)', 'var(--chart-cat-7)', 'var(--chart-cat-8)',
  'var(--chart-cat-1)', 'var(--chart-cat-2)', 'var(--chart-cat-3)',
];
const STATUS_LABELS = { pending: 'Pending', dispatched: 'Dispatched', resolved: 'Resolved' };
const STATUS_PILL_CLASS = { pending: 'status-pill--pending', dispatched: 'status-pill--info', resolved: 'status-pill--success' };
const DUTY_STATUS_LABELS = { on_duty: 'On Duty', responding: 'Responding', off_duty: 'Off Duty' };
const DUTY_STATUS_PILL_CLASS = { on_duty: 'status-pill--success', responding: 'status-pill--info', off_duty: 'status-pill--neutral' };

const RECENT_INCIDENTS_COLUMNS = [
  { key: 'id', label: 'ID', width: '4.5rem' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'date', label: 'Date', align: 'right' },
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
/** Inclusive day count between two `YYYY-MM-DD` dates, e.g. 8/1-8/10 -> 10. */
function rangeDaysBetween(fromIso, toIso) {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86400000) + 1;
}
/**
 * The immediately-preceding period of equal length to [dateFrom, dateTo]
 * (both inclusive `YYYY-MM-DD`), e.g. 8/1-8/10 (10 days) -> 7/22-7/31.
 */
function previousPeriodRange(dateFrom, dateTo) {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  const rangeDays = Math.round((to - from) / 86400000) + 1;
  const prevTo = new Date(from);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - (rangeDays - 1));
  return [prevFrom.toISOString().slice(0, 10), prevTo.toISOString().slice(0, 10)];
}

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderAdminDashboardPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'dashboard', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({ title: 'Admin Dashboard', subtitle: 'Barangay-wide incident summary and activity', icon: icons.layoutDashboard });
  header.appendChild(pageHeader.el);

  // 2026-09-05 UX pass: the topbar never showed which of the 4 barangays
  // a session is scoped to. GET /barangays is public/unauthenticated
  // (apiClient.js's own doc) and tiny (4 rows, fixed) — best-effort, own
  // catch, never blocks the dashboard's real data.
  getBarangays().then((rows) => {
    const match = rows.find((b) => b.barangayId === user.barangayId);
    if (!match) return;
    const badge = document.createElement('span');
    badge.className = 'dashboard-barangay-badge';
    badge.textContent = `Brgy. ${match.name}`;
    pageHeader.el.querySelector('.page-header__title')?.appendChild(badge);
  }).catch(() => {
    // Cosmetic only — the dashboard works fine without the badge.
  });

  // Date range controls — 2026-09-06 UX pass: replaced the always-visible
  // From/To/Apply trio plus a separate row of preset chips (six controls
  // competing for attention, two different ways to express the same
  // range) with one dropdown. The explicit date fields only appear once
  // "Custom range" is chosen — progressive disclosure, not gone — so the
  // 95% case (a preset) is a single control and the escape hatch for an
  // arbitrary range is still one click away, not removed.
  const PRESET_DAYS_AGO = { 7: 6, 30: 29, 90: 89 };

  const rangeSelect = document.createElement('select');
  rangeSelect.className = 'input--auto range-select';
  rangeSelect.setAttribute('aria-label', 'Date range');
  for (const [value, label] of [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['custom', 'Custom range']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    rangeSelect.appendChild(option);
  }
  rangeSelect.value = '30';

  const customRow = document.createElement('div');
  customRow.className = 'filter-bar range-picker-custom-row';
  customRow.hidden = true;

  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.value = daysAgoIso(29);
  fromInput.classList.add('input--auto');
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.value = todayIso();
  toInput.classList.add('input--auto');
  const applyButton = document.createElement('button');
  applyButton.className = 'primary';
  applyButton.textContent = 'Apply';

  // audit W2: nothing said how fresh the figures were. A dashboard that
  // loads once and never timestamps itself leaves a Punong Barangay
  // unable to tell two-minute-old numbers from two-hour-old ones.
  const freshness = document.createElement('span');
  freshness.className = 'note dashboard-freshness';
  freshness.setAttribute('role', 'status');

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'ghost';
  refreshButton.innerHTML = `<span aria-hidden="true">${icons.repeat(15)}</span><span>Refresh</span>`;
  refreshButton.setAttribute('aria-label', 'Refresh dashboard');
  refreshButton.addEventListener('click', () => load(fromInput.value, toInput.value));

  // 2026-09-06: moved next to Refresh, in the page header, rather than its
  // own row under it — one control that's always visible belongs beside
  // the other "how current is this view" action, not on a separate line.
  pageHeader.actions.append(freshness, refreshButton, rangeSelect);

  // Validation before the round trip — an inverted range used to be caught
  // only by the server, which returned a full-page error block.
  const rangeError = document.createElement('span');
  rangeError.className = 'app-inline-error';
  rangeError.hidden = true;
  rangeError.setAttribute('role', 'alert');
  const validateRange = () => {
    const invalid = Boolean(fromInput.value && toInput.value && fromInput.value > toInput.value);
    applyButton.disabled = invalid;
    rangeError.hidden = !invalid;
    rangeError.textContent = invalid ? 'From date must be on or before To date.' : '';
  };
  fromInput.addEventListener('change', validateRange);
  toInput.addEventListener('change', validateRange);

  rangeSelect.addEventListener('change', () => {
    if (rangeSelect.value === 'custom') {
      customRow.hidden = false;
      return;
    }
    customRow.hidden = true;
    const daysAgo = PRESET_DAYS_AGO[rangeSelect.value];
    fromInput.value = daysAgoIso(daysAgo);
    toInput.value = todayIso();
    load(fromInput.value, toInput.value);
  });

  customRow.append(
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'From' }),
    fromInput,
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'To' }),
    toInput,
    applyButton,
    rangeError
  );
  const body = document.createElement('div');

  content.append(customRow, body);

  applyButton.addEventListener('click', () => load(fromInput.value, toInput.value));
  // Initial load sends NO date params, deliberately — see load()'s comment
  // below for why. fromInput/toInput start out showing a client-computed
  // guess only so the date pickers aren't empty; load() overwrites them
  // with the server's actual range once the response comes back, and that
  // same handler reconciles rangeSelect/customRow to whatever range the
  // server actually used.
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
      // Reconcile the dropdown/custom-row visibility to whatever range this
      // load actually used — but ONLY for the true initial load (dateFrom/
      // dateTo both undefined, meaning nobody had picked anything yet).
      // Every other call already knows its own mode (the preset handler
      // hides the row before calling load; Apply and Refresh fire with the
      // row already in whatever state the user left it) — re-deriving it
      // here from the server's returned trend[] would fight that, because
      // the server can round the requested range by a day at a timezone
      // boundary (see the comment above): picking "Last 7 days" then
      // getting back 6 or 8 days of trend used to silently fall through to
      // "no exact preset match" and re-reveal the custom row even though a
      // preset was clearly chosen.
      if (dateFrom === undefined && dateTo === undefined) {
        const matchedDays = Object.keys(PRESET_DAYS_AGO).find((days) => PRESET_DAYS_AGO[days] + 1 === rangeDaysBetween(fromInput.value, toInput.value));
        rangeSelect.value = matchedDays || 'custom';
        customRow.hidden = rangeSelect.value !== 'custom';
      }

      const isFreshDeployment = summary.totalIncidents === 0 && summary.activeTanods === 0;
      if (isFreshDeployment) {
        renderEmpty(body, navigate, user.role);
        return;
      }

      renderPopulated(body, summary, navigate, user.role);

      // Best-effort extras: each wrapped in its own catch so a failure
      // here never blocks the KPI/trend/breakdown data above, which has
      // already rendered. Uses the server-corrected range (fromInput/
      // toInput, just set above), not the possibly-undefined dateFrom/
      // dateTo params, so this always compares against the range that
      // actually produced `summary`.
      freshness.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

      loadDeltas(body, fromInput.value, toInput.value, summary);
      loadRecentIncidents(body, navigate);
      loadTanodsOnDuty(body, user.barangayId);
      loadAttentionBanner(body, navigate, user.role, summary.byStatus.pending || 0);
    } catch (err) {
      const message = err instanceof ApiClientError
        ? err.message
        : 'Something went wrong loading the dashboard.';
      renderError(body, message, () => load(dateFrom, dateTo));
    }
  }
}

/**
 * 2026-09-05 UX pass: the dashboard used to be entirely retrospective (a
 * date-range summary) with no "what needs my attention right now" signal
 * — an Admin had to separately open Dispatch Center to discover a pending
 * incident or an open Tanod SOS. `summary.byStatus.pending` is already
 * fetched by `load()`, so only the SOS count is a new (best-effort, own
 * catch) call — same `status !== 'resolved'` definition of "open"
 * `dispatch-center.js`'s own SOS banner already uses, kept in sync
 * deliberately.
 */
async function loadAttentionBanner(container, navigate, role, pendingCount) {
  const host = container.querySelector('[data-attention-banner]');
  if (!host) return;
  let openSosCount = 0;
  try {
    const sosItems = await getTanodSos({});
    openSosCount = sosItems.filter((s) => s.status !== 'resolved').length;
  } catch {
    // Best-effort — the banner still shows the pending-incident count below.
  }

  host.innerHTML = '';
  if (pendingCount === 0 && openSosCount === 0) return;

  const banner = document.createElement('div');
  banner.className = `attention-banner attention-banner--${openSosCount > 0 ? 'critical' : 'warning'}`;
  banner.setAttribute('role', openSosCount > 0 ? 'alert' : 'status');
  banner.innerHTML = `<span aria-hidden="true">${icons.alertTriangle(22)}</span>`;

  const text = document.createElement('span');
  text.className = 'attention-banner__text';
  const parts = [];
  if (openSosCount > 0) parts.push(openSosCount === 1 ? '1 Tanod SOS alert' : `${openSosCount} Tanod SOS alerts`);
  if (pendingCount > 0) parts.push(pendingCount === 1 ? '1 incident pending dispatch' : `${pendingCount} incidents pending dispatch`);
  text.textContent = `${parts.join(' and ')} — needs attention.`;
  banner.appendChild(text);

  // Dispatch Center is Admin-only (§7) — Punong Barangay is read-only
  // oversight and has no screen to act on this from, so it sees the same
  // informational banner with no button rather than one that would just
  // bounce them back to their own default page.
  if (role === 'admin') {
    const goButton = document.createElement('button');
    goButton.type = 'button';
    goButton.className = openSosCount > 0 ? 'ghost' : 'primary';
    goButton.textContent = 'Go to Dispatch Center';
    goButton.addEventListener('click', () => navigate('dispatch'));
    banner.appendChild(goButton);
  }

  host.appendChild(banner);
}

async function loadDeltas(container, dateFrom, dateTo, summary) {
  const kpiGrid = container.querySelector('.kpi-grid');
  if (!kpiGrid) return;
  try {
    const [prevFrom, prevTo] = previousPeriodRange(dateFrom, dateTo);
    const prevSummary = await getReportsSummary({ dateFrom: prevFrom, dateTo: prevTo });
    // audit W2: these two cards used to be REPLACED wholesale once the
    // previous-period request landed, so both visibly blinked and
    // re-rendered a beat after the page had settled — and any focus
    // inside them was thrown away. KpiCard now exposes setDelta(), so the
    // existing nodes are mutated instead.
    // Second argument is the PRIOR value, which is what turns the delta
    // into a percentage; a prior period of zero has no percentage, and
    // KpiCard falls back to the raw difference in that case.
    kpiGrid.children[0]?.setDelta?.(summary.totalIncidents - prevSummary.totalIncidents, prevSummary.totalIncidents);
    kpiGrid.children[1]?.setDelta?.(summary.resolvedCount - prevSummary.resolvedCount, prevSummary.resolvedCount);
  } catch {
    // No previous-period data (e.g. barangay has no history before this
    // range) — the KPI cards already rendered without a delta, which is
    // the correct fallback, not an error state.
  }
}

async function loadRecentIncidents(container, navigate) {
  const host = container.querySelector('[data-recent-incidents]');
  if (!host) return;
  try {
    const result = await getIncidents({ limit: 6 });
    renderRecentIncidentsTable(host, result.items, navigate);
  } catch {
    host.innerHTML = '<p class="note">Could not load recent incidents.</p>';
  }
}

async function loadTanodsOnDuty(container, barangayId) {
  const host = container.querySelector('[data-tanods-on-duty]');
  if (!host) return;
  try {
    const [dutyStatuses, tanodsRes] = await Promise.all([
      getDutyStatus(barangayId),
      getUsers({ role: 'tanod', limit: 100 }),
    ]);
    const namesById = new Map(tanodsRes.items.map((t) => [t.userId, t.fullName]));
    const roster = dutyStatuses
      .filter((d) => namesById.has(d.userId))
      .map((d) => ({ userId: d.userId, fullName: namesById.get(d.userId), status: d.status }));
    renderTanodsOnDutyList(host, roster);
  } catch {
    host.innerHTML = '<p class="note">Could not load Tanod duty status.</p>';
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'kpi-grid';
  grid.setAttribute('role', 'status');
  grid.setAttribute('aria-label', 'Loading dashboard');
  for (let i = 0; i < 4; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'card';
    skeleton.innerHTML = '<div class="skeleton skeleton--line"></div><div class="skeleton skeleton--figure"></div>';
    grid.appendChild(skeleton);
  }
  const chartSkeleton = document.createElement('div');
  chartSkeleton.className = 'card skeleton skeleton--chart';
  container.append(grid, chartSkeleton);
}

function renderEmpty(container, navigate, role) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = `
    <h3>No activity yet</h3>
    <p>This barangay hasn't logged any incidents or on-duty Tanods yet. Once incidents are reported and Tanods are on duty, this dashboard fills in automatically.</p>
  `;
  // 2026-09-05 UX pass: gave a fresh deployment a first real action
  // instead of just describing what happens "automatically" — Incident
  // Management's create form is Admin/Secretary (§7); Punong Barangay is
  // read-only oversight and has no create action anywhere, so it keeps
  // the description-only empty state.
  if (role === 'admin') {
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'primary';
    cta.textContent = 'Log an Incident';
    cta.addEventListener('click', () => navigate('incident-management'));
    block.appendChild(cta);
  }
  container.appendChild(block);
}

function renderError(container, message, onRetry) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block state-block--error';
  block.setAttribute('role', 'alert');
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}

function renderPopulated(container, summary, navigate, role) {
  container.innerHTML = '';

  const attentionHost = document.createElement('div');
  attentionHost.setAttribute('data-attention-banner', '');
  container.appendChild(attentionHost);

  const grid = document.createElement('div');
  grid.className = 'kpi-grid';
  grid.append(
    // §4.4 — sparkline built from summary.trend[].count, a real per-day
    // series that genuinely measures "incidents created," matching this
    // KPI exactly. `Resolved` deliberately has none — see KpiCard.js's
    // own doc for why that series doesn't describe it.
    KpiCard({
      label: 'Total Incidents', value: summary.totalIncidents, icon: icons.bell, accent: 'blue',
      sparkline: summary.trend.map((day) => day.count),
      description: 'Every incident reported in the selected date range, regardless of status.',
    }),
    // Resolved going UP is unambiguously good; Total Incidents has no
    // inherent good direction so it deliberately gets no `trend`.
    KpiCard({
      label: 'Resolved Cases', value: summary.resolvedCount, icon: icons.checkCircle, accent: 'green', trend: 'up-good',
      description: 'Incidents in this range whose current status is Resolved.',
    }),
    KpiCard({
      label: 'Avg. Response Time',
      value: summary.avgResponseTimeMinutes === null ? null : `${summary.avgResponseTimeMinutes} min`,
      emptyText: 'No arrivals yet',
      icon: icons.clock,
      accent: 'orange',
      // Faster response is better, so a NEGATIVE delta is the good one.
      trend: 'down-good',
      description: 'Average time from an incident being reported to a Tanod’s dispatch marked Arrived. Incidents with no arrival yet aren’t counted.',
    }),
    // No period-over-period delta here — this is a live current-state
    // snapshot (§9), not a range-bucketed count, so "vs previous period"
    // isn't a meaningful comparison for it.
    KpiCard({
      label: 'Tanods On Duty', value: summary.activeTanods, icon: icons.users, accent: 'teal',
      description: 'Tanods currently marked On Duty or Responding, right now — not scoped to the date range above.',
    })
  );

  // Trend + type breakdown side by side, each in a card carrying the
  // shared card-header (title / subtitle / corner icon) rather than a bare
  // <h3> with an inline margin — audit A4 removed the inline pixel values
  // from this file, and .card-header already existed in base.css for
  // exactly this pattern.
  const chartsGrid = document.createElement('div');
  chartsGrid.className = 'two-col-grid dashboard-row';

  const trendCard = document.createElement('div');
  trendCard.className = 'card';
  trendCard.appendChild(cardHeader(
    'Incident Trends', 'Reported against resolved, by day', icons.trendingUp,
    'Incidents reported each day (blue) versus incidents resolved that same day (green), across the selected range.',
    { label: 'View all reports', onClick: () => navigate('analytics') }
  ));
  trendCard.appendChild(LineChart({
    points: summary.trend.map((day) => ({ label: shortDate(day.date), values: [day.count, day.resolved ?? 0] })),
    series: [
      { name: 'Reported', colorVar: '--chart-line-1' },
      { name: 'Resolved', colorVar: '--chart-line-2' },
    ],
    caption: 'Incidents reported and resolved by day',
  }));

  chartsGrid.append(trendCard, renderIncidentTypeDonutCard(summary.byIncidentType, navigate));

  const breakdownGrid = document.createElement('div');
  breakdownGrid.className = 'two-col-grid dashboard-row';

  const recentCard = document.createElement('div');
  recentCard.className = 'card';
  recentCard.appendChild(cardHeader(
    'Recent Incidents', 'Newest six reports', icons.fileText,
    'The six most recently reported incidents, regardless of the date range above.',
    { label: 'View all incidents', onClick: () => navigate('incident-management') }
  ));
  const recentHost = document.createElement('div');
  recentHost.setAttribute('data-recent-incidents', '');
  recentHost.appendChild(blockSkeleton());
  recentCard.append(recentHost);

  const dutyCard = document.createElement('div');
  dutyCard.className = 'card';
  dutyCard.appendChild(cardHeader(
    'Tanods On Duty', 'Current shift roster', icons.users,
    'Every Tanod’s current shift status, live — not scoped to the date range above.',
    { label: 'View Personnel', onClick: () => navigate('personnel') }
  ));
  const dutyHost = document.createElement('div');
  dutyHost.setAttribute('data-tanods-on-duty', '');
  dutyHost.appendChild(blockSkeleton());
  dutyCard.append(dutyHost);

  breakdownGrid.append(recentCard, dutyCard);

  const statusRow = document.createElement('div');
  statusRow.className = 'two-col-grid dashboard-row';
  statusRow.append(renderBreakdownCard('By Status', summary.byStatus, STATUS_LABELS, STATUS_PILL_CLASS, navigate));
  // 2026-09-06 UX pass: this row's second column was always empty (a
  // `two-col-grid` with one child) — Admin's most common next steps from
  // the dashboard (log an incident, open dispatch, message a resident,
  // review the blotter) had no single home; each was a sidebar hop away.
  // Punong Barangay is read-only oversight (§3, no write action anywhere
  // on this screen already), so it keeps the single-column status card
  // exactly as before rather than gaining a card of actions it can't use.
  if (role === 'admin') statusRow.append(renderQuickActionsCard(navigate));

  container.append(grid, chartsGrid, breakdownGrid, statusRow);
}

/**
 * Shared card title / subtitle / corner-icon header (base.css
 * .card-header). `viewAll` (2026-09-06 UX pass), when given, replaces the
 * purely decorative corner icon with an icon-only button that navigates to
 * that data's full screen — the corner icon has always occupied the
 * "top right of the card" real estate the user asked "View all" to move
 * into, so this reuses that slot rather than adding a second control.
 */
function cardHeader(title, subtitle, icon, description, viewAll) {
  const el = document.createElement('div');
  el.className = 'card-header';
  const titles = document.createElement('div');
  const h = document.createElement('h3');
  h.className = 'card-header__title report-section-title';
  h.append(title);
  if (description) h.appendChild(InfoTip(description));
  const sub = document.createElement('p');
  sub.className = 'card-header__subtitle';
  sub.textContent = subtitle;
  titles.append(h, sub);

  let corner;
  if (viewAll) {
    corner = document.createElement('button');
    corner.type = 'button';
    corner.className = 'card-header__icon card-header__icon--action';
    corner.innerHTML = icons.arrowUpRight(18);
    corner.setAttribute('aria-label', viewAll.label);
    corner.title = viewAll.label;
    corner.addEventListener('click', viewAll.onClick);
  } else {
    corner = document.createElement('span');
    corner.className = 'card-header__icon';
    corner.setAttribute('aria-hidden', 'true');
    corner.innerHTML = icon(18);
  }
  el.append(titles, corner);
  return el;
}

/** Panel-sized loading placeholder — replaces an inline-styled skeleton div. */
function blockSkeleton() {
  const el = document.createElement('div');
  el.className = 'skeleton skeleton--block';
  return el;
}

/** "2026-09-04" -> "Sep 4", for x-axis tick labels. */
function shortDate(iso) {
  const [, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

function renderRecentIncidentsTable(host, items, navigate) {
  host.innerHTML = '';
  if (items.length === 0) {
    host.innerHTML = '<p class="note">No incidents logged yet.</p>';
    return;
  }
  const table = DataTable({
    columns: RECENT_INCIDENTS_COLUMNS,
    rows: items,
    rowKey: (row) => row.incidentId,
    caption: 'Most recent incidents',
    // 2026-09-05 UX pass: this was the one list in the app whose rows led
    // nowhere — every other list (Blotter, Incident Management, topbar
    // search, notifications) already navigates to blotter-detail on
    // click, same destination used here.
    onRowClick: (row) => navigate('blotter-detail', row.incidentId),
    renderCell: (row, key) => {
      switch (key) {
        case 'id':
          return `#${row.incidentId}`;
        case 'type':
          return INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType;
        case 'status': {
          const span = document.createElement('span');
          span.className = `status-pill ${STATUS_PILL_CLASS[row.status] || 'status-pill--neutral'}`;
          span.textContent = row.status;
          return span;
        }
        case 'date':
          return new Date(row.createdAt).toLocaleDateString();
        default:
          return '';
      }
    },
  });
  host.appendChild(table);
}

function renderTanodsOnDutyList(host, roster) {
  host.innerHTML = '';
  if (roster.length === 0) {
    host.innerHTML = '<p class="note">No Tanod duty status recorded yet.</p>';
    return;
  }
  const list = document.createElement('div');
  list.className = 'stack';
  for (const tanod of roster) {
    const row = document.createElement('div');
    row.className = 'row-between breakdown-row';
    const left = document.createElement('span');
    left.className = 'avatar-row';
    left.innerHTML = `${avatarInitials(tanod.fullName, 24)}${escapeHtml(tanod.fullName)}`;
    const pill = document.createElement('span');
    pill.className = `status-pill ${DUTY_STATUS_PILL_CLASS[tanod.status] || 'status-pill--neutral'}`;
    pill.textContent = DUTY_STATUS_LABELS[tanod.status] || tanod.status;
    row.append(left, pill);
    list.appendChild(row);
  }
  host.appendChild(list);
}

function renderIncidentTypeDonutCard(counts, navigate) {
  const card = document.createElement('div');
  card.className = 'card';
  const rows = Object.entries(counts).map(([key, count], i) => ({
    key, count, label: INCIDENT_TYPE_LABELS[key] || key, color: INCIDENT_TYPE_COLORS[i % INCIDENT_TYPE_COLORS.length],
  }));
  card.append(cardHeader(
    'Incident Types', 'Distribution by category', icons.activity,
    'How incidents in this range break down by category, out of the 11 fixed incident types.',
    { label: 'View all reports', onClick: () => navigate('analytics') }
  ), DonutChart({ rows }));
  return card;
}

/**
 * Quick Actions — Admin's most common next steps from the dashboard, all
 * to screens that already exist (§9); nothing here is a new capability,
 * just a shortcut to ones that previously required a sidebar hop. Filled
 * this row's previously-empty second column (see renderPopulated's own
 * comment above the call site).
 */
function renderQuickActionsCard(navigate) {
  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(cardHeader(
    'Quick Actions', 'Common next steps', icons.plus,
    'Shortcuts to the most common tasks — nothing here does anything a full sidebar screen doesn’t already do.'
  ));

  const ACTIONS = [
    { label: 'Log an Incident', icon: icons.alertTriangle, page: 'incident-management' },
    { label: 'Dispatch Center', icon: icons.radio, page: 'dispatch' },
    { label: 'Message a Resident', icon: icons.messageSquare, page: 'sms-log' },
    { label: 'View Blotter', icon: icons.fileText, page: 'blotter' },
  ];
  const grid = document.createElement('div');
  grid.className = 'quick-actions-grid';
  for (const action of ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-action-tile';
    button.innerHTML = `<span class="quick-action-tile__icon" aria-hidden="true">${action.icon(20)}</span>`
      + `<span>${action.label}</span>`;
    button.addEventListener('click', () => navigate(action.page));
    grid.appendChild(button);
  }
  card.appendChild(grid);
  return card;
}

function renderBreakdownCard(title, counts, labels, pillClasses, navigate) {
  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(cardHeader(
    title, 'Incidents in the selected range', icons.barChart,
    'How incidents in this range break down by pending, dispatched, or resolved.',
    { label: 'View all reports', onClick: () => navigate('analytics') }
  ));

  const list = document.createElement('div');
  list.className = 'stack';
  for (const [key, count] of Object.entries(counts)) {
    const row = document.createElement('div');
    row.className = 'row-between breakdown-row';
    const label = document.createElement('span');
    const pillClass = pillClasses[key];
    if (pillClass) {
      label.innerHTML = `<span class="status-pill ${pillClass}">${labels[key] || key}</span>`;
    } else {
      label.textContent = labels[key] || key;
    }
    const value = document.createElement('span');
    value.className = 'breakdown-row__value';
    value.textContent = String(count);
    row.append(label, value);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
