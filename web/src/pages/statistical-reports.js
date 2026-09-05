/**
 * statistical-reports.js — W9 Statistical Reports, Generate only (§9):
 * "Contains exact trend, incident, status, response-time, and
 * notification reliability datasets. Generate and Export are separate;
 * Export calls GET /reports/export and is audited." Roles: Admin, Punong
 * Barangay (read-only) — same as W2, both just call the same GET.
 *
 * Two things deliberately scoped out of this cut, logged in DEVLOG.md:
 *   - **Export** is `GET /reports/export`, a separate Sprint 7 "Today's
 *     cut" box per Sprint_Prompts.md ("excluding export/service-health
 *     which are S7") — not built here, no Export button on this page.
 *   - **Notification reliability** isn't shown. §6's
 *     `GET /reports/notifications-summary` isn't in Sprint 1's own listed
 *     endpoint set, and its data model (notification/notification_target/
 *     notification_delivery) is Sprint 4 scope — nothing would ever
 *     populate it yet. Building an endpoint outside this sprint's listed
 *     set risked getting ahead of a dependency chain the same way
 *     `DispatchController` deliberately didn't write bare `notification`
 *     rows for the same reason.
 *
 * Deliberately distinct from W2 Admin Dashboard: this is an explicit
 * "Generate" action for a chosen range (no auto-load on open), producing
 * the fuller trend/type/status/response-time breakdown — not just the
 * top-line KPI cards.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getReportsSummary, exportReport, downloadReportExport, getBlotterList, getCitizenReports, ApiClientError } from '../api/apiClient.js';
import { showToast } from '../components/Toast.js';
import { KpiCard } from '../components/KpiCard.js';
import { LineChart } from '../components/LineChart.js';
import { BarChart } from '../components/BarChart.js';
import { DonutChart } from '../components/DonutChart.js';
import { StatStrip } from '../components/StatStrip.js';
import { icons } from '../components/icons.js';

// 12-hour clock labels for the by-hour bar chart's 24 buckets.
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => {
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${period}`;
});

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
// Same wording/tones as blotter-list.js's own CASE_STATUS_LABELS/
// CASE_STATUS_PILL_CLASS (kept in sync deliberately, not copy-drifted —
// this codebase's established pattern is a small local label map per
// page rather than a shared module, same as INCIDENT_TYPE_LABELS above).
const CASE_STATUS_LABELS = {
  active: 'Active', under_investigation: 'Under Investigation', settled: 'Settled', resolved: 'Resolved',
};
const CASE_STATUS_PILL_CLASS = {
  active: 'status-pill--info', under_investigation: 'status-pill--pending',
  settled: 'status-pill--success', resolved: 'status-pill--neutral',
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
/** "2026-09-04" -> "Sep 4", for the Key Insights card. */
function shortDate(iso) {
  const [, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

/**
 * Personnel > Reports tab. Was the standalone W9 Statistical Reports
 * page (`renderStatisticalReportsPage`) before the 2026-09-05 Analytics
 * merge — see `pages/analytics.js` for the shared AppShell/PageHeader/
 * tab shell (and why Heatmap was the one screen worth merging this into,
 * unlike Incident Management).
 *
 * @param {HTMLElement} container tab body to render into
 * @param {ReturnType<import('../components/PageHeader.js').PageHeader>} pageHeader shared page header (for the Export CSV action)
 * @param {{fullName:string, role:string}} user
 */
export function renderReportsTab(container, pageHeader, user) {
  // 2026-09-06 UX pass: same dropdown + progressive-disclosure pattern as
  // the Admin Dashboard's date range control (admin-dashboard.js), moved
  // into the page header's own actions row rather than a From/To/Generate
  // row under the header — one control visible by default (a preset),
  // with the explicit date fields only appearing once "Custom range" is
  // picked. Unlike the dashboard, nothing here ever corrects fromInput/
  // toInput after a fetch (this screen has no "server default range" to
  // reconcile against — every load is an explicit, client-chosen range),
  // so there's no equivalent of that file's post-load reconciliation step.
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

  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.value = daysAgoIso(29);
  fromInput.classList.add('input--auto');
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.value = todayIso();
  toInput.classList.add('input--auto');
  const generateButton = document.createElement('button');
  generateButton.className = 'primary';
  generateButton.textContent = 'Generate';

  const customRow = document.createElement('div');
  customRow.className = 'filter-bar range-picker-custom-row';
  customRow.hidden = true;
  customRow.append(
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'From' }),
    fromInput,
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'To' }),
    toInput,
    generateButton
  );

  rangeSelect.addEventListener('change', () => {
    if (rangeSelect.value === 'custom') {
      customRow.hidden = false;
      return;
    }
    customRow.hidden = true;
    fromInput.value = daysAgoIso(PRESET_DAYS_AGO[rangeSelect.value]);
    toInput.value = todayIso();
    load(fromInput.value, toInput.value);
  });

  pageHeader.actions.appendChild(rangeSelect);

  const body = document.createElement('div');
  container.append(customRow, body);

  // §9 W9: "Generate and Export are separate; Export calls
  // GET /reports/export and is audited." Separate deliberately — Export
  // writes a real file server-side and an audit_log row, so it is a
  // distinct action, not a second rendering of what Generate produced.
  // Sprint 7's "W9 Export button" cut. PDF added 2026-09-06 alongside the
  // original CSV button — same generate-then-download flow, just a second
  // format (see ReportsController::export()'s doc for that decision).
  //
  // The download itself (2026-09-06 fix) is a real authenticated fetch
  // producing a Blob, not `window.open()`/an `<a href>` on the API URL —
  // this app has no session cookie, only a Bearer token, and a plain
  // browser navigation cannot attach one. `window.open()`/a plain href
  // here would 401 every time; see `downloadReportExport()`'s own doc.
  function buildExportButton(format, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    const idleLabel = `<span aria-hidden="true">${icons.download(16)}</span><span>${label}</span>`;
    button.innerHTML = idleLabel;
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Exporting…';
      try {
        await exportReport({ dateFrom: fromInput.value, dateTo: toInput.value, format });
        const blob = await downloadReportExport({ format });
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = `baranguard-report.${format}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
        showToast('Export generated. This action was recorded in the audit log.', { variant: 'success' });
      } catch (err) {
        showToast(err instanceof ApiClientError ? err.message : 'Could not generate the export.', { variant: 'error' });
      } finally {
        button.disabled = false;
        button.innerHTML = idleLabel;
      }
    });
    return button;
  }
  pageHeader.actions.append(buildExportButton('csv', 'Export CSV'), buildExportButton('pdf', 'Export PDF'));

  generateButton.addEventListener('click', () => load(fromInput.value, toInput.value));
  // 2026-09-06: this used to be "Generate only, no auto-load" (see this
  // file's header comment) — landing on the tab showed a bare "Choose a
  // date range" prompt with no charts until Generate was clicked. That
  // was a deliberate original decision, but it reads as "the graphs are
  // missing" now that the dashboard auto-loads its own charts and the
  // reference mockup this tab is being aligned to shows charts populated
  // immediately. Generate/the date fields still work exactly the same
  // way for switching to a different range.
  load(fromInput.value, toInput.value);

  async function load(dateFrom, dateTo) {
    renderLoading(body);
    generateButton.disabled = true;
    try {
      const summary = await getReportsSummary({ dateFrom, dateTo });
      renderReport(body, summary, user.role);
      // Best-effort extras (2026-09-06) — each wrapped in its own catch so
      // a failure never blocks the main report, which has already
      // rendered. Both are ALL-TIME snapshots, not scoped to the chosen
      // range: neither `GET /blotter` nor `GET /citizen-reports` accepts a
      // date filter (unlike `GET /reports/summary`), and inventing one
      // wasn't in scope here — same "live snapshot, not range-bucketed"
      // precedent admin-dashboard.js's own Tanods On Duty card already
      // uses, just labelled honestly rather than silently implied.
      loadCaseStatusBreakdown(body);
      if (user.role === 'admin') loadCitizenReportsConversion(body);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong generating the report.';
      renderError(body, message, () => load(dateFrom, dateTo));
    } finally {
      generateButton.disabled = false;
    }
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const chartSkeleton = document.createElement('div');
  chartSkeleton.className = 'card skeleton skeleton--chart';
  chartSkeleton.setAttribute('role', 'status');
  chartSkeleton.setAttribute('aria-label', 'Generating report');
  container.appendChild(chartSkeleton);
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

function renderReport(container, summary, role) {
  container.innerHTML = '';

  const isEmpty = summary.totalIncidents === 0;
  if (isEmpty) {
    const block = document.createElement('div');
    block.className = 'card state-block';
    block.innerHTML = `
      <h3>No incidents in this range</h3>
      <p>No incidents were reported in the selected date range. Try widening it.</p>
    `;
    container.appendChild(block);
    return;
  }

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'kpi-grid';
  kpiGrid.append(
    KpiCard({ label: 'Total Incidents', value: summary.totalIncidents, icon: icons.bell, accent: 'blue' }),
    KpiCard({ label: 'Resolved', value: summary.resolvedCount, icon: icons.checkCircle, accent: 'green' }),
    KpiCard({
      label: 'Avg. Response Time',
      value: summary.avgResponseTimeMinutes === null ? null : `${summary.avgResponseTimeMinutes} min`,
      emptyText: 'No arrivals yet',
      icon: icons.clock,
      accent: 'orange',
    }),
    KpiCard({ label: 'Active Tanods', value: summary.activeTanods, icon: icons.users, accent: 'teal' })
  );

  // Key Insights (2026-09-06) — three highlights derived entirely from
  // `summary` fields this screen already fetches (trend/byIncidentType/
  // byHour), so unlike the cross-domain row below, these ARE scoped to
  // the selected range, no extra request needed. Placed right after the
  // KPI row so the range's headline facts read before the charts that
  // back them up.
  const insightsCard = document.createElement('div');
  insightsCard.className = 'card';
  const insightsHeading = document.createElement('h3');
  insightsHeading.className = 'card-header__title report-section-title';
  insightsHeading.textContent = 'Key Insights';
  insightsCard.appendChild(insightsHeading);
  const busiestDay = summary.trend.reduce((best, day) => (day.count > best.count ? day : best), summary.trend[0]);
  const topType = Object.entries(summary.byIncidentType).reduce(
    (best, [key, count]) => (count > best.count ? { key, count } : best),
    { key: null, count: -1 }
  );
  let peakHour = { hour: 0, count: -1 };
  summary.byHour.forEach((count, hour) => {
    if (count > peakHour.count) peakHour = { hour, count };
  });
  insightsCard.appendChild(StatStrip({
    items: [
      { label: 'Busiest Day', value: shortDate(busiestDay.date) },
      { label: 'Most Common Type', value: INCIDENT_TYPE_LABELS[topType.key] || topType.key },
      { label: 'Peak Hour', value: HOUR_LABELS[peakHour.hour] },
    ],
  }));

  const trendCard = document.createElement('div');
  trendCard.className = 'card';
  const trendHeading = document.createElement('h3');
  trendHeading.className = 'card-header__title report-section-title';
  trendHeading.textContent = 'Incident Trends';
  trendCard.appendChild(trendHeading);
  trendCard.appendChild(LineChart({
    points: summary.trend.map((day) => ({ label: day.date.slice(5), values: [day.count, day.resolved ?? 0] })),
    series: [
      { name: 'Reported', colorVar: '--chart-line-1' },
      { name: 'Resolved', colorVar: '--chart-line-2' },
    ],
    caption: 'Incidents reported and resolved by day',
  }));

  const breakdownGrid = document.createElement('div');
  breakdownGrid.className = 'two-col-grid dashboard-row';
  breakdownGrid.append(
    renderBreakdownCard('By Status', summary.byStatus, STATUS_LABELS, STATUS_PILL_CLASS),
    renderIncidentTypeDonutCard(summary.byIncidentType)
  );

  // Cross-domain breakdowns (2026-09-06) — Blotter case status and (Admin
  // only — Punong Barangay has no access to GET /citizen-reports, §3 role
  // matrix) Citizen Reports conversion. Both load asynchronously below
  // (loadCaseStatusBreakdown/loadCitizenReportsConversion) since they're
  // separate requests from `summary`, same "render the main report now,
  // fill in extras as they arrive" pattern admin-dashboard.js uses for
  // Recent Incidents/Tanods On Duty.
  const crossDomainGrid = document.createElement('div');
  crossDomainGrid.className = 'two-col-grid dashboard-row';

  const caseStatusCard = document.createElement('div');
  caseStatusCard.className = 'card';
  const caseStatusHeading = document.createElement('h3');
  caseStatusHeading.className = 'card-header__title report-section-title';
  caseStatusHeading.textContent = 'Blotter Case Status';
  const caseStatusSubtitle = document.createElement('p');
  caseStatusSubtitle.className = 'card-header__subtitle';
  caseStatusSubtitle.textContent = 'All finalized blotter entries, all time — not scoped to the range above';
  const caseStatusHost = document.createElement('div');
  caseStatusHost.setAttribute('data-case-status-host', '');
  caseStatusHost.appendChild(Object.assign(document.createElement('div'), { className: 'skeleton skeleton--block' }));
  caseStatusCard.append(caseStatusHeading, caseStatusSubtitle, caseStatusHost);
  crossDomainGrid.appendChild(caseStatusCard);

  if (role === 'admin') {
    const citizenCard = document.createElement('div');
    citizenCard.className = 'card';
    const citizenHeading = document.createElement('h3');
    citizenHeading.className = 'card-header__title report-section-title';
    citizenHeading.textContent = 'Citizen Reports';
    const citizenSubtitle = document.createElement('p');
    citizenSubtitle.className = 'card-header__subtitle';
    citizenSubtitle.textContent = 'All submitted reports, all time — not scoped to the range above';
    const citizenHost = document.createElement('div');
    citizenHost.setAttribute('data-citizen-conversion-host', '');
    citizenHost.appendChild(Object.assign(document.createElement('div'), { className: 'skeleton skeleton--block' }));
    citizenCard.append(citizenHeading, citizenSubtitle, citizenHost);
    crossDomainGrid.appendChild(citizenCard);
  }

  // Phase 9 (Analytics upgrade, mockup-driven UI round 2): incidents by
  // hour of day (§8's named legitimate replacement for the rejected
  // cross-barangay comparison chart) and the response-time trend, both
  // real `GET /reports/summary` series added this cut — see
  // ReportsController::summary() for exactly what each buckets.
  const analyticsGrid = document.createElement('div');
  analyticsGrid.className = 'two-col-grid dashboard-row';

  const byHourCard = document.createElement('div');
  byHourCard.className = 'card';
  const byHourHeading = document.createElement('h3');
  byHourHeading.className = 'card-header__title report-section-title';
  byHourHeading.textContent = 'Incidents by Hour of Day';
  byHourCard.appendChild(byHourHeading);
  byHourCard.appendChild(BarChart({
    bars: summary.byHour.map((count, hour) => ({ label: HOUR_LABELS[hour], value: count })),
    colorVar: '--chart-line-1',
    caption: 'Incidents by hour of day (Asia/Manila)',
  }));

  const responseTimeCard = document.createElement('div');
  responseTimeCard.className = 'card';
  const responseTimeHeading = document.createElement('h3');
  responseTimeHeading.className = 'card-header__title report-section-title';
  responseTimeHeading.textContent = 'Response Time Trend';
  responseTimeCard.appendChild(responseTimeHeading);
  responseTimeCard.appendChild(LineChart({
    points: summary.responseTimeTrend.map((day) => ({ label: day.date.slice(5), values: [day.avgMinutes ?? 0] })),
    series: [{ name: 'Avg. minutes to arrival', colorVar: '--chart-line-2' }],
    caption: 'Average response time by day',
  }));

  analyticsGrid.append(byHourCard, responseTimeCard);

  container.append(kpiGrid, insightsCard, trendCard, breakdownGrid, crossDomainGrid, analyticsGrid);
}

/**
 * Blotter case_status has no summary/count endpoint and `GET /blotter`
 * has no date filter (unlike `GET /reports/summary`) — so this fetches
 * every page (bounded, `MAX_PAGES` below) and counts client-side. Real
 * deployments here are single-barangay and blotter records are only
 * FINALIZED incidents (a subset of all incidents), so this stays small in
 * practice; the bound exists so a future much larger dataset degrades to
 * "stop early" rather than an unbounded loop.
 */
async function loadCaseStatusBreakdown(container) {
  const host = container.querySelector('[data-case-status-host]');
  if (!host) return;
  const MAX_PAGES = 20;
  const PAGE_LIMIT = 100;
  try {
    const counts = { active: 0, under_investigation: 0, settled: 0, resolved: 0 };
    let page = 1;
    let fetched = 0;
    let total = Infinity;
    while (fetched < total && page <= MAX_PAGES) {
      const result = await getBlotterList({ page, limit: PAGE_LIMIT });
      total = result.total;
      for (const row of result.items) {
        if (row.caseStatus in counts) counts[row.caseStatus]++;
      }
      fetched += result.items.length;
      if (result.items.length === 0) break;
      page++;
    }
    renderCaseStatusList(host, counts);
  } catch {
    host.innerHTML = '<p class="note">Could not load blotter case status.</p>';
  }
}

function renderCaseStatusList(host, counts) {
  host.innerHTML = '';
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    host.innerHTML = '<p class="note">No finalized blotter entries yet.</p>';
    return;
  }
  const list = document.createElement('div');
  list.className = 'stack';
  for (const [key, count] of Object.entries(counts)) {
    const row = document.createElement('div');
    row.className = 'row-between breakdown-row';
    const label = document.createElement('span');
    label.innerHTML = `<span class="status-pill ${CASE_STATUS_PILL_CLASS[key]}">${CASE_STATUS_LABELS[key]}</span>`;
    const value = document.createElement('span');
    value.className = 'breakdown-row__value';
    value.textContent = String(count);
    row.append(label, value);
    list.appendChild(row);
  }
  host.appendChild(list);
}

/**
 * `GET /citizen-reports` has no "converted" status filter (only
 * "unconverted", §6/CitizenReportsController::index()) — so conversion
 * count is derived from two cheap `limit:1` calls (only `.total` is
 * used from each) rather than fetching every report just to count them.
 */
async function loadCitizenReportsConversion(container) {
  const host = container.querySelector('[data-citizen-conversion-host]');
  if (!host) return;
  try {
    const [allResult, unconvertedResult] = await Promise.all([
      getCitizenReports({ limit: 1 }),
      getCitizenReports({ status: 'unconverted', limit: 1 }),
    ]);
    const totalReports = allResult.total;
    const unconverted = unconvertedResult.total;
    const converted = Math.max(0, totalReports - unconverted);
    renderCitizenConversion(host, { totalReports, converted, unconverted });
  } catch {
    host.innerHTML = '<p class="note">Could not load citizen report data.</p>';
  }
}

function renderCitizenConversion(host, { totalReports, converted, unconverted }) {
  host.innerHTML = '';
  if (totalReports === 0) {
    host.innerHTML = '<p class="note">No citizen reports submitted yet.</p>';
    return;
  }
  const pct = Math.round((converted / totalReports) * 100);
  host.appendChild(StatStrip({
    items: [
      { label: 'Submitted', value: totalReports },
      { label: 'Converted', value: converted, tone: 'success' },
      { label: 'Awaiting Review', value: unconverted, tone: unconverted > 0 ? 'warning' : 'default' },
      { label: 'Conversion Rate', value: `${pct}%` },
    ],
  }));
}

function renderIncidentTypeDonutCard(counts) {
  const card = document.createElement('div');
  card.className = 'card';
  const heading = document.createElement('h3');
  heading.className = 'card-header__title report-section-title';
  heading.textContent = 'By Incident Type';
  const rows = Object.entries(counts).map(([key, count], i) => ({
    key, count, label: INCIDENT_TYPE_LABELS[key] || key, color: INCIDENT_TYPE_COLORS[i % INCIDENT_TYPE_COLORS.length],
  }));
  card.append(heading, DonutChart({ rows }));
  return card;
}

function renderBreakdownCard(title, counts, labels, pillClasses) {
  const card = document.createElement('div');
  card.className = 'card';
  const heading = document.createElement('h3');
  heading.className = 'card-header__title report-section-title';
  heading.className = 'card-header__title report-section-title';
  heading.textContent = title;
  card.appendChild(heading);

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
