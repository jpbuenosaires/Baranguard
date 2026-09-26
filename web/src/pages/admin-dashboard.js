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
 * CORRECTION, found by browser-verifying Punong Barangay's own nav
 * (2026-09-13, docs/REMAINING.md B5): the class doc above used to claim
 * "both roles just call the same GET" for this whole screen. That was
 * false for the Tanods On Duty panel specifically — `GET /users?role=`
 * is Admin-only server-side (§3; UsersController::index() requires the
 * `admin` role), so Punong Barangay 403'd on every single dashboard load
 * and `loadTanodsOnDuty()`'s catch-all turned that permanent, by-design
 * 403 into a generic "Could not load Tanod duty status." — indistinguishable
 * from a real transient failure. See that function's own note below.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getReportsSummary, getIncidents, getDutyStatus, getUsers, getTanodSos, getBarangays, getReportsDigest, downloadReportsDigest, logout, ApiClientError } from '../api/apiClient.js';
import { showToast } from '../components/Toast.js';
import { KpiCard, KpiHeroCard } from '../components/KpiCard.js';
import { DateRangePicker } from '../components/DateRangePicker.js';
import { LineChart } from '../components/LineChart.js';
import { DonutChart } from '../components/DonutChart.js';
import { DataTable } from '../components/DataTable.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';
import { avatarInitials } from '../components/Avatar.js';
import { InfoTip } from '../components/Tooltip.js';
import { escapeHtml } from '../utils/escapeHtml.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};
const INCIDENT_TYPE_COLORS = {
  theft: 'var(--cat-theft)',
  physical_injury: 'var(--cat-injury)',
  disturbance: 'var(--cat-disturbance)',
  domestic_dispute: 'var(--cat-dispute)',
  vandalism: 'var(--cat-vandalism)',
  traffic_incident: 'var(--cat-traffic)',
  fire: 'var(--cat-fire)',
  medical_emergency: 'var(--cat-medical)',
  missing_person: 'var(--cat-missing)',
  animal_complaint: 'var(--cat-animal)',
  other: 'var(--cat-other)',
};
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

  // Date range control. 2026-09-06 UI/UX audit: this screen used to build
  // its own ~120-line picker; four other screens had copy-pasted the same
  // block and drifted. It is now the shared DateRangePicker component —
  // see that file for what the copies disagreed about and the two bugs
  // (leaked document listeners, UTC "today") the consolidation fixed.
  const rangePicker = DateRangePicker({
    value: '30',
    ariaLabel: 'Date range',
    onChange: ({ from, to }) => load(from, to),
  });

  const freshness = document.createElement('span');
  freshness.className = 'note dashboard-freshness';
  freshness.setAttribute('role', 'status');

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'ghost';
  refreshButton.innerHTML = `<span aria-hidden="true">${icons.repeat(15)}</span><span>Refresh</span>`;
  refreshButton.setAttribute('aria-label', 'Refresh dashboard');
  refreshButton.addEventListener('click', () => {
    const { from, to } = rangePicker.getState();
    load(from, to);
  });

  pageHeader.actions.append(freshness, refreshButton, rangePicker.el);

  const body = document.createElement('div');
  body.className = 'dashboard-body';
  content.append(body);

  load(undefined, undefined);

  async function load(dateFrom, dateTo) {
    const isInitial = body.children.length === 0;
    if (isInitial) {
      renderLoading(body);
    } else {
      body.classList.add('is-reloading');
    }
    refreshButton.disabled = true;
    refreshButton.classList.add('is-spinning');

    try {
      const summary = await getReportsSummary({ dateFrom, dateTo });

      if (summary.trend && summary.trend.length > 0) {
        const trendFrom = summary.trend[0].date;
        const trendTo = summary.trend[summary.trend.length - 1].date;
        // Only the first, deliberately unbounded load lets the SERVER pick
        // the window, so only that one re-points the select at whatever
        // came back. A user-chosen range must not be silently relabelled.
        if (dateFrom === undefined && dateTo === undefined) {
          rangePicker.reconcile(trendFrom, trendTo);
        } else {
          rangePicker.setDates(trendFrom, trendTo);
        }
      }

      const isFreshDeployment = summary.totalIncidents === 0 && summary.activeTanods === 0;
      if (isFreshDeployment) {
        renderEmpty(body, navigate, user.role);
        return;
      }

      renderPopulated(body, summary, navigate, user.role);

      freshness.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

      const committed = rangePicker.getState();
      loadDeltas(body, committed.from, committed.to, summary);
      loadRecentIncidents(body, navigate);
      loadTanodsOnDuty(body, user.barangayId, user.role);
      loadAttentionBanner(body, navigate, user.role, summary.byStatus.pending || 0);
      if (user.role === 'punong_barangay') loadPbDigest(body);
    } catch (err) {
      const message = err instanceof ApiClientError
        ? err.message
        : 'Something went wrong loading the dashboard.';
      renderError(body, message, () => load(dateFrom, dateTo));
    } finally {
      body.classList.remove('is-reloading');
      refreshButton.disabled = false;
      refreshButton.classList.remove('is-spinning');
    }
  }
}

/**
 * When an un-dispatched high/critical incident's wait escalates the
 * banner from "here is a count" to "this one has been ignored".
 *
 * THIS IS A DISPLAY HEURISTIC, NOT AN SLA. No document in this project
 * defines a dispatch response target — §11 sets retention windows, and
 * Sprint 8's response-time box measures `created_at → arrived_at` without
 * asserting what it should be. So this number decides only when the
 * escalation line changes wording and colour; it is never presented to
 * the operator as a breached standard, and the minutes shown beside it
 * are always the real measured wait. If a real SLA is ever adopted, it
 * belongs in the reference first and this constant follows it.
 */
const STALE_URGENT_MINUTES = 15;

/**
 * Minutes the OLDEST still-pending urgent incident has been waiting, or
 * null when there are none. Reads `createdAt`, which `apiClient`'s
 * `reviveUtcTimestamps` has already normalised to a real UTC instant —
 * parsing the raw `2026-09-06 13:41:20` here would silently shift by the
 * local offset (the bug commit 891a01b fixed across 85 call sites).
 */
function urgentWaitMinutes(urgentItems) {
  const times = urgentItems
    .map((i) => new Date(i.createdAt).getTime())
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return Math.max(0, Math.floor((Date.now() - Math.min(...times)) / 60000));
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
  let hasCriticalOrHighPending = false;
  let criticalCount = 0;
  let oldestUrgentMinutes = null;

  try {
    const [sosItems, pendingRes] = await Promise.all([
      getTanodSos({}).catch(() => []),
      pendingCount > 0 ? getIncidents({ status: 'pending', limit: 100 }).catch(() => null) : Promise.resolve(null),
    ]);
    openSosCount = (sosItems || []).filter((s) => s.status !== 'resolved').length;
    if (pendingRes && Array.isArray(pendingRes.items)) {
      const urgentItems = pendingRes.items.filter((i) => i.priority === 'critical' || i.priority === 'high' || i.incidentType === 'sos');
      criticalCount = urgentItems.length;
      hasCriticalOrHighPending = criticalCount > 0;
      oldestUrgentMinutes = urgentWaitMinutes(urgentItems);
    }
  } catch {
    // Best-effort — the banner still shows the pending-incident count below.
  }

  host.innerHTML = '';
  if (pendingCount === 0 && openSosCount === 0) return;

  const isStale = oldestUrgentMinutes !== null && oldestUrgentMinutes >= STALE_URGENT_MINUTES;
  const isCritical = openSosCount > 0 || hasCriticalOrHighPending;
  const banner = document.createElement('div');
  banner.className = `attention-banner attention-banner--${isCritical ? 'critical' : 'warning'} attention-banner--compact`;
  banner.setAttribute('role', isCritical ? 'alert' : 'status');

  const lead = document.createElement('div');
  lead.className = 'attention-banner__lead';

  const badge = document.createElement('div');
  badge.className = 'attention-banner__badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.innerHTML = isCritical ? icons.alertCircle(18) : icons.alertTriangle(18);
  if (isCritical) {
    const pulseDot = document.createElement('span');
    pulseDot.className = 'attention-banner__pulse-dot';
    badge.appendChild(pulseDot);
  }
  lead.appendChild(badge);

  const textGroup = document.createElement('div');
  textGroup.className = 'attention-banner__text-group';

  const parts = [];
  if (openSosCount > 0) parts.push(openSosCount === 1 ? '1 Tanod SOS alert' : `${openSosCount} Tanod SOS alerts`);
  if (pendingCount > 0) parts.push(pendingCount === 1 ? '1 incident pending dispatch' : `${pendingCount} incidents pending dispatch`);

  const title = document.createElement('span');
  title.className = 'attention-banner__title';
  title.textContent = parts.join(' and ');

  const detail = document.createElement('span');
  detail.className = 'attention-banner__detail';
  detail.textContent = isCritical ? 'Needs immediate response' : 'Needs attention';

  textGroup.append(title, detail);
  lead.appendChild(textGroup);
  banner.appendChild(lead);

  const actions = document.createElement('div');
  actions.className = 'attention-banner__actions';

  if (oldestUrgentMinutes !== null) {
    const chip = document.createElement('span');
    chip.className = `attention-banner__chip${isStale ? ' attention-banner__chip--stale' : ''}`;
    const waited = oldestUrgentMinutes < 60
      ? `${oldestUrgentMinutes}m`
      : `${Math.floor(oldestUrgentMinutes / 60)}h ${oldestUrgentMinutes % 60}m`;
    chip.innerHTML = `<span aria-hidden="true">${icons.clock(13)}</span><span>${isStale ? 'Waited ' + waited : 'Waiting ' + waited}</span>`;
    if (isStale) chip.setAttribute('role', 'alert');
    actions.appendChild(chip);
  }

  if (role === 'admin') {
    const goButton = document.createElement('button');
    goButton.type = 'button';
    goButton.className = 'attention-banner__btn';
    goButton.setAttribute('aria-label', 'Go to Dispatch Center');
    goButton.innerHTML = `<span>Dispatch Now</span><span class="attention-banner__btn-icon" aria-hidden="true">${icons.arrowRight(14)}</span>`;
    goButton.addEventListener('click', () => navigate('dispatch'));
    actions.appendChild(goButton);
  }

  banner.appendChild(actions);
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
    kpiGrid.children[0]?.setResolvedDelta?.(summary.resolvedCount - prevSummary.resolvedCount, prevSummary.resolvedCount);
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

async function loadTanodsOnDuty(container, barangayId, role) {
  const host = container.querySelector('[data-tanods-on-duty]');
  if (!host) return;
  // `GET /users` (needed here purely to resolve a Tanod's display name) is
  // Admin-only server-side (§3) — Punong Barangay has no Personnel/Users
  // reach at all, by design, not by omission. Skip the doomed call rather
  // than let it 403 on every load and report a permissions boundary as a
  // generic load failure; the aggregate "Tanods On Duty" KPI card above
  // this panel already gives PB the count.
  if (role !== 'admin') {
    host.innerHTML = '<p class="note">Named roster is available to Admin. See the count above for the total on duty.</p>';
    return;
  }
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

/**
 * Punong Barangay's Weekly Digest card. `available: false` (no scheduled
 * run yet) is rendered plainly, not as an error — §2 Rule 6's own
 * `not_configured`-is-neutral reasoning applies here too.
 */
async function loadPbDigest(container) {
  const host = container.querySelector('[data-pb-digest]');
  if (!host) return;
  try {
    const digest = await getReportsDigest();
    if (!digest.available) {
      host.innerHTML = '<p class="note">No digest has been generated yet. The first weekly digest will appear here after it runs.</p>';
      return;
    }
    host.innerHTML = '';
    const meta = document.createElement('p');
    meta.className = 'note';
    const generated = new Date(digest.generatedAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    meta.textContent = `Covers ${digest.dateFrom} to ${digest.dateTo}. Generated ${generated}.`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    const idleHtml = `${icons.download(16)} <span>Download PDF</span>`;
    button.innerHTML = idleHtml;
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.innerHTML = `<span class="is-spinning" aria-hidden="true">${icons.repeat(14)}</span><span>Downloading…</span>`;
      try {
        const blob = await downloadReportsDigest();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = 'baranguard-weekly-digest.pdf';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
      } catch (err) {
        showToast(err instanceof ApiClientError ? err.message : 'Could not download the digest.', { variant: 'error' });
      } finally {
        button.disabled = false;
        button.innerHTML = idleHtml;
      }
    });
    host.append(meta, button);
  } catch {
    host.innerHTML = '<p class="note">Could not load the weekly digest.</p>';
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
    KpiHeroCard({
      label: 'Total Incidents',
      value: summary.totalIncidents,
      icon: icons.bell,
      accent: 'blue',
      resolvedCount: summary.resolvedCount,
      sparkline: summary.trend.map((day) => day.count),
      description: 'Every incident reported in the selected date range, alongside resolution progress and trend activity.',
    }),
    KpiCard({
      label: 'Avg. Response Time',
      value: summary.avgResponseTimeMinutes === null ? null : `${summary.avgResponseTimeMinutes} min`,
      emptyText: 'No arrivals yet',
      icon: icons.clock,
      accent: 'orange',
      // Faster response is better, so a NEGATIVE delta is the good one.
      trend: 'down-good',
      badgeChip: {
        text: 'Target < 20m',
        tone: summary.avgResponseTimeMinutes !== null && summary.avgResponseTimeMinutes <= 20 ? 'positive' : 'warning',
      },
      footerNote: 'Incident reported to Tanod arrival',
      description: 'Average time from an incident being reported to a Tanod’s dispatch marked Arrived. Incidents with no arrival yet aren’t counted.',
    }),
    // No period-over-period delta here — this is a live current-state
    // snapshot (§9), not a range-bucketed count, so "vs previous period"
    // isn't a meaningful comparison for it.
    KpiCard({
      label: 'Tanods On Duty',
      value: summary.activeTanods,
      icon: icons.users,
      accent: 'teal',
      badgeChip: {
        text: 'Live Roster',
        tone: 'live',
      },
      footerNote: 'Currently active or responding',
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
    { label: 'View all incidents', onClick: () => navigate('incident-management') },
    { text: '6 newest' }
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
    { label: 'View Personnel', onClick: () => navigate('personnel') },
    { text: 'Live Roster', tone: 'live' }
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
  if (role === 'admin') {
    statusRow.append(renderQuickActionsCard(navigate));
  } else if (role === 'punong_barangay') {
    // Fills the same previously-empty second column the comment above
    // used to describe as "a card of actions it can't use" — the
    // periodic PB digest (REMAINING.md section G) is read-only, so it
    // fits PB's oversight-only role exactly. Loaded async by
    // loadPbDigest(), same skeleton-then-fill pattern as the Tanods On
    // Duty panel below.
    const digestCard = document.createElement('div');
    digestCard.className = 'card';
    digestCard.appendChild(cardHeader(
      'Weekly Digest', 'Auto-generated barangay summary', icons.fileText,
      'A PDF summary of this barangay’s incident activity, regenerated automatically once a week — the same content GET /reports/export?format=pdf produces on demand, just on a timer.',
      null,
      { text: 'PDF' }
    ));
    const digestHost = document.createElement('div');
    digestHost.setAttribute('data-pb-digest', '');
    digestHost.innerHTML = '<div class="skeleton skeleton--line"></div>';
    digestCard.appendChild(digestHost);
    statusRow.append(digestCard);
  }

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
function cardHeader(title, subtitle, icon, description, viewAll, chip) {
  const el = document.createElement('div');
  el.className = 'card-header';
  const titles = document.createElement('div');
  const h = document.createElement('h3');
  h.className = 'card-header__title report-section-title';
  h.append(title);
  if (chip) {
    const chipEl = document.createElement('span');
    chipEl.className = `card-header__chip ${chip.tone ? `card-header__chip--${chip.tone}` : ''}`;
    chipEl.textContent = chip.text;
    h.appendChild(chipEl);
  }
  if (description) h.appendChild(InfoTip(description));
  const sub = document.createElement('p');
  sub.className = 'card-header__subtitle';
  sub.textContent = subtitle;
  titles.append(h, sub);

  let corner;
  if (viewAll) {
    corner = document.createElement('button');
    corner.type = 'button';
    corner.className = 'card-header__action-btn';
    corner.innerHTML = `<span>${escapeHtml(viewAll.label)}</span> ${icons.arrowUpRight(14)}`;
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
        case 'id': {
          const badge = document.createElement('span');
          badge.className = 'incident-id-badge';
          badge.textContent = `#${row.incidentId}`;
          return badge;
        }
        case 'type': {
          const typeEl = document.createElement('span');
          typeEl.style.fontWeight = '500';
          typeEl.textContent = INCIDENT_TYPE_LABELS[row.incidentType] || row.incidentType;
          return typeEl;
        }
        case 'status': {
          const span = document.createElement('span');
          span.className = `status-pill ${STATUS_PILL_CLASS[row.status] || 'status-pill--neutral'}`;
          span.textContent = row.status;
          return span;
        }
        case 'date': {
          const dateEl = document.createElement('span');
          dateEl.className = 'incident-date-cell';
          const d = new Date(row.createdAt);
          dateEl.textContent = isNaN(d.getTime())
            ? row.createdAt
            : d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' });
          dateEl.title = row.createdAt;
          return dateEl;
        }
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
  list.className = 'tanods-roster-scroll';
  for (const tanod of roster) {
    const row = document.createElement('div');
    row.className = 'row-between breakdown-row tanod-roster-item';

    const left = document.createElement('div');
    left.className = 'tanod-roster-item__left';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'tanod-avatar-wrap';
    avatarWrap.innerHTML = `
      ${avatarInitials(tanod.fullName, 32)}
      <span class="tanod-avatar-pip tanod-avatar-pip--${tanod.status}" aria-hidden="true"></span>
    `;

    const info = document.createElement('div');
    info.className = 'tanod-roster-item__info';

    const name = document.createElement('span');
    name.className = 'tanod-roster-item__name';
    name.textContent = tanod.fullName;

    const role = document.createElement('span');
    role.className = 'tanod-roster-item__role';
    role.textContent = 'Barangay Tanod';

    info.append(name, role);
    left.append(avatarWrap, info);

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

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const entries = Object.entries(counts);
  const rows = entries.map(([key, count]) => ({
    key,
    count,
    label: INCIDENT_TYPE_LABELS[key] || key,
    color: INCIDENT_TYPE_COLORS[key] || 'var(--cat-other)',
  }));

  let topCat = { key: 'None', count: 0, label: 'None' };
  let activeCatsCount = 0;
  for (const [key, count] of entries) {
    if (count > 0) activeCatsCount++;
    if (count > topCat.count) {
      topCat = { key, count, label: INCIDENT_TYPE_LABELS[key] || key };
    }
  }
  const topCatPct = total > 0 ? Math.round((topCat.count / total) * 100) : 0;

  card.append(
    cardHeader(
      'Incident Types',
      'Distribution by category',
      icons.activity,
      'How incidents in this range break down by category, out of the 11 fixed incident types.',
      { label: 'View all reports', onClick: () => navigate('analytics') },
      { text: `${total} Incidents` }
    ),
    DonutChart({ rows })
  );

  if (total > 0) {
    const footer = document.createElement('div');
    footer.className = 'category-summary-footer';
    footer.innerHTML = `
      <div class="category-summary-tile">
        <span class="category-summary-tile__val">
          <span class="summary-tile-pip" style="background:${INCIDENT_TYPE_COLORS[topCat.key] || 'var(--color-primary)'};" aria-hidden="true"></span>
          Top: ${escapeHtml(topCat.label)} (${topCat.count})
        </span>
        <span class="category-summary-tile__sub">${topCatPct}% of all incidents</span>
      </div>
      <div class="category-summary-tile">
        <span class="category-summary-tile__val">
          <span class="summary-tile-pip" style="background:var(--chart-cat-8, #8B5CF6);" aria-hidden="true"></span>
          ${activeCatsCount} Active ${activeCatsCount === 1 ? 'Category' : 'Categories'}
        </span>
        <span class="category-summary-tile__sub">Out of 11 classified types</span>
      </div>
    `;
    card.appendChild(footer);
  }

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
    'Shortcuts to the most common tasks — nothing here does anything a full sidebar screen doesn’t already do.',
    null,
    { text: '4 Shortcuts' }
  ));

  const ACTIONS = [
    { label: 'Log an Incident', sub: 'New blotter & intake', icon: icons.alertTriangle, tone: 'amber', page: 'incident-management' },
    { label: 'Dispatch Center', sub: 'Live tracking & roster', icon: icons.radio, tone: 'blue', page: 'dispatch' },
    { label: 'Message a Resident', sub: 'Resident SMS broadcast', icon: icons.messageSquare, tone: 'cyan', page: 'sms-log' },
    { label: 'Analytics', sub: 'Reports, trends & heatmap', icon: icons.barChart, tone: 'violet', page: 'analytics' },
  ];
  const grid = document.createElement('div');
  grid.className = 'quick-actions-grid';
  for (const action of ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-action-tile';
    button.setAttribute('aria-label', action.label);
    button.innerHTML = `
      <div class="quick-action-tile__header">
        <span class="quick-action-tile__badge quick-action-tile__badge--${action.tone}" aria-hidden="true">${action.icon(20)}</span>
        <span class="quick-action-tile__arrow" aria-hidden="true">${icons.arrowUpRight(14)}</span>
      </div>
      <div class="quick-action-tile__body">
        <span class="quick-action-tile__title">${action.label}</span>
        <span class="quick-action-tile__sub">${action.sub}</span>
      </div>
    `;
    button.addEventListener('click', () => navigate(action.page));
    grid.appendChild(button);
  }
  card.appendChild(grid);
  return card;
}

function renderBreakdownCard(title, counts, labels, pillClasses, navigate) {
  const card = document.createElement('div');
  card.className = 'card';

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  card.appendChild(cardHeader(
    title, 'Incidents in the selected range', icons.barChart,
    'How incidents in this range break down by pending, dispatched, or resolved.',
    { label: 'View all reports', onClick: () => navigate('analytics') },
    total > 0 ? { text: `${total} Total` } : null
  ));

  // Multi-Segment Top Proportional Pipeline Strip
  if (total > 0) {
    const pipelineBar = document.createElement('div');
    pipelineBar.className = 'pipeline-stacked-bar';
    pipelineBar.setAttribute('aria-hidden', 'true');
    for (const [key, count] of Object.entries(counts)) {
      if (count > 0) {
        const seg = document.createElement('div');
        const pct = ((count / total) * 100).toFixed(1);
        seg.className = `pipeline-stacked-segment pipeline-stacked-segment--${key}`;
        seg.style.width = `${pct}%`;
        seg.title = `${labels[key] || key}: ${count} (${pct}%)`;
        pipelineBar.appendChild(seg);
      }
    }
    card.appendChild(pipelineBar);
  }

  const list = document.createElement('div');
  list.className = 'stack';
  for (const [key, count] of Object.entries(counts)) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const item = document.createElement('div');
    item.className = 'breakdown-item';

    const row = document.createElement('div');
    row.className = 'breakdown-row';

    const label = document.createElement('span');
    const pillClass = pillClasses[key];
    if (pillClass) {
      label.innerHTML = `<span class="status-pill ${pillClass}">${labels[key] || key}</span>`;
    } else {
      label.textContent = labels[key] || key;
    }

    const value = document.createElement('span');
    value.className = 'breakdown-row__metrics';
    value.innerHTML = `<span class="breakdown-row__value">${count}</span> <span class="breakdown-row__pct">${pct}%</span>`;
    row.append(label, value);

    const track = document.createElement('div');
    track.className = 'breakdown-progress-track';
    const fill = document.createElement('div');
    fill.className = `breakdown-progress-fill breakdown-progress-fill--${key}`;
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    item.append(row, track);
    list.appendChild(item);
  }
  card.appendChild(list);

  // Operational Pipeline Summary Footer (Balances card height with Quick Actions)
  if (total > 0) {
    const activeCount = (counts.pending || 0) + (counts.dispatched || 0);
    const activePct = Math.round((activeCount / total) * 100);
    const resolvedCount = counts.resolved || 0;
    const resolvedPct = Math.round((resolvedCount / total) * 100);

    const footer = document.createElement('div');
    footer.className = 'breakdown-summary-footer';
    footer.innerHTML = `
      <div class="breakdown-summary-tile">
        <span class="breakdown-summary-tile__val">
          <span class="summary-tile-pip" style="background:#3B82F6;" aria-hidden="true"></span>
          ${activeCount} Active in Field
        </span>
        <span class="breakdown-summary-tile__sub">${activePct}% of total workload</span>
      </div>
      <div class="breakdown-summary-tile">
        <span class="breakdown-summary-tile__val">
          <span class="summary-tile-pip" style="background:#16A34A;" aria-hidden="true"></span>
          ${resolvedCount} Closed & Resolved
        </span>
        <span class="breakdown-summary-tile__sub">${resolvedPct}% clearance rate</span>
      </div>
    `;
    card.appendChild(footer);
  }

  return card;
}

