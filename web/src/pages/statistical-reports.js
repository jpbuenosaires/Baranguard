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
import { InfoTip } from '../components/Tooltip.js';
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
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

/** 14 -> "2:00 PM – 3:00 PM" */
function formatHourRange(h) {
  const startPeriod = h < 12 ? 'AM' : 'PM';
  const startH = h % 12 === 0 ? 12 : h % 12;
  const nextH = (h + 1) % 24;
  const endPeriod = nextH < 12 ? 'AM' : 'PM';
  const endH = nextH % 12 === 0 ? 12 : nextH % 12;
  return `${startH}:00 ${startPeriod} – ${endH}:00 ${endPeriod}`;
}

function cardHeader(title, subtitle, icon, description) {
  const el = document.createElement('div');
  el.className = 'card-header';
  const titles = document.createElement('div');
  const h = document.createElement('h3');
  h.className = 'card-header__title report-section-title';
  h.append(title);
  if (description) h.appendChild(InfoTip(description));
  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'card-header__subtitle';
    sub.textContent = subtitle;
    titles.append(h, sub);
  } else {
    titles.append(h);
  }

  if (icon) {
    const corner = document.createElement('span');
    corner.className = 'card-header__icon';
    corner.setAttribute('aria-hidden', 'true');
    corner.innerHTML = icon(18);
    el.append(titles, corner);
  } else {
    el.append(titles);
  }
  return el;
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

  const rangeWrapper = document.createElement('div');
  rangeWrapper.className = 'date-range-picker-wrapper';

  const rangeSelect = document.createElement('select');
  rangeSelect.className = 'input--auto range-select';
  rangeSelect.setAttribute('aria-label', 'Date range');
  for (const [value, label] of [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['custom', 'Custom range...']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    rangeSelect.appendChild(option);
  }
  rangeSelect.value = '30';
  let previousSelectValue = '30';

  const popover = document.createElement('div');
  popover.className = 'date-range-popover';
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Custom date range');

  const popoverTitle = document.createElement('div');
  popoverTitle.className = 'date-range-popover__title';
  popoverTitle.textContent = 'Custom Date Range';

  const gridFields = document.createElement('div');
  gridFields.className = 'date-range-popover__grid';

  const fromField = document.createElement('div');
  fromField.className = 'date-range-popover__field';
  const fromLabel = document.createElement('label');
  fromLabel.className = 'date-range-popover__label';
  fromLabel.textContent = 'From';
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.className = 'date-range-popover__input';
  fromInput.value = daysAgoIso(29);
  fromField.append(fromLabel, fromInput);

  const toField = document.createElement('div');
  toField.className = 'date-range-popover__field';
  const toLabel = document.createElement('label');
  toLabel.className = 'date-range-popover__label';
  toLabel.textContent = 'To';
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.className = 'date-range-popover__input';
  toInput.value = todayIso();
  toField.append(toLabel, toInput);

  gridFields.append(fromField, toField);

  const rangeError = document.createElement('span');
  rangeError.className = 'app-inline-error';
  rangeError.hidden = true;
  rangeError.setAttribute('role', 'alert');

  const actions = document.createElement('div');
  actions.className = 'date-range-popover__actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'ghost';
  cancelButton.textContent = 'Cancel';

  const applyButton = document.createElement('button');
  applyButton.type = 'button';
  applyButton.className = 'primary';
  applyButton.textContent = 'Apply Range';

  actions.append(cancelButton, applyButton);
  popover.append(popoverTitle, gridFields, rangeError, actions);
  rangeWrapper.append(rangeSelect, popover);

  const validateRange = () => {
    const invalid = Boolean(fromInput.value && toInput.value && fromInput.value > toInput.value);
    applyButton.disabled = invalid;
    rangeError.hidden = !invalid;
    rangeError.textContent = invalid ? 'From date must be on or before To date.' : '';
  };
  fromInput.addEventListener('change', validateRange);
  toInput.addEventListener('change', validateRange);

  const openPopover = () => {
    popover.hidden = false;
    validateRange();
    fromInput.focus();
  };

  const closePopover = (restorePrevious = false) => {
    popover.hidden = true;
    rangeError.hidden = true;
    if (restorePrevious) {
      rangeSelect.value = previousSelectValue;
    }
  };

  cancelButton.addEventListener('click', () => closePopover(true));
  document.addEventListener('click', (e) => {
    if (!popover.hidden && !rangeWrapper.contains(e.target)) closePopover(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) closePopover(true);
  });

  applyButton.addEventListener('click', () => {
    if (fromInput.value && toInput.value && fromInput.value > toInput.value) return;
    previousSelectValue = 'custom';
    const customOption = rangeSelect.querySelector('option[value="custom"]');
    if (customOption) {
      customOption.textContent = `Custom (${shortDate(fromInput.value)} – ${shortDate(toInput.value)})`;
    }
    rangeSelect.value = 'custom';
    closePopover(false);
    load(fromInput.value, toInput.value);
  });

  rangeSelect.addEventListener('change', () => {
    if (rangeSelect.value === 'custom') {
      openPopover();
      return;
    }
    closePopover(false);
    previousSelectValue = rangeSelect.value;
    fromInput.value = daysAgoIso(PRESET_DAYS_AGO[rangeSelect.value]);
    toInput.value = todayIso();
    load(fromInput.value, toInput.value);
  });

  function buildExportButton(format, label, iconSvg) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    const idleHtml = `<span aria-hidden="true">${iconSvg}</span><span>${label}</span>`;
    button.innerHTML = idleHtml;
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.innerHTML = `<span class="is-spinning" aria-hidden="true">${icons.repeat(14)}</span><span>Exporting…</span>`;
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
        button.innerHTML = idleHtml;
      }
    });
    return button;
  }

  const exportGroup = document.createElement('div');
  exportGroup.className = 'export-btn-group';
  exportGroup.append(
    buildExportButton('csv', 'Export CSV', icons.download(16)),
    buildExportButton('pdf', 'Export PDF', icons.fileText(16))
  );

  pageHeader.actions.append(rangeWrapper, exportGroup);

  const body = document.createElement('div');
  body.className = 'dashboard-body';
  container.append(body);

  load(fromInput.value, toInput.value);

  async function load(dateFrom, dateTo) {
    const isInitial = body.children.length === 0;
    if (isInitial) {
      renderLoading(body);
    } else {
      body.classList.add('is-reloading');
    }
    try {
      const summary = await getReportsSummary({ dateFrom, dateTo });
      renderReport(body, summary, user.role);
      loadCaseStatusBreakdown(body);
      if (user.role === 'admin') loadCitizenReportsConversion(body);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong generating the report.';
      renderError(body, message, () => load(dateFrom, dateTo));
    } finally {
      body.classList.remove('is-reloading');
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
  kpiGrid.className = 'kpi-grid dashboard-row';
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

  const insightsCard = document.createElement('div');
  insightsCard.className = 'card dashboard-row';
  insightsCard.appendChild(cardHeader(
    'Key Insights',
    'Headline patterns derived from this date range',
    icons.activity
  ));
  const busiestDay = summary.trend && summary.trend.length > 0
    ? summary.trend.reduce((best, day) => (day.count > best.count ? day : best), summary.trend[0])
    : { date: todayIso(), count: 0 };
  const topType = Object.entries(summary.byIncidentType).reduce(
    (best, [key, count]) => (count > best.count ? { key, count } : best),
    { key: null, count: 0 }
  );
  let peakHour = { hour: 0, count: 0 };
  summary.byHour.forEach((count, hour) => {
    if (count > peakHour.count) peakHour = { hour, count };
  });

  const topTypePct = summary.totalIncidents > 0 && topType.count > 0
    ? Math.round((topType.count / summary.totalIncidents) * 100)
    : 0;

  const insightsGrid = document.createElement('div');
  insightsGrid.className = 'insights-grid';

  const busiestTile = document.createElement('div');
  busiestTile.className = 'insight-tile';
  busiestTile.innerHTML = `
    <div class="insight-tile__header">
      <span aria-hidden="true">${icons.calendar(16)}</span>
      <span>Busiest Day</span>
    </div>
    <div class="insight-tile__value">${busiestDay.count > 0 ? shortDate(busiestDay.date) : 'None'}</div>
    <div class="insight-tile__badge">${busiestDay.count > 0 ? `${busiestDay.count} ${busiestDay.count === 1 ? 'incident' : 'incidents'} logged` : 'No incidents recorded'}</div>
  `;

  const typeLabel = topType.count > 0 ? (INCIDENT_TYPE_LABELS[topType.key] || topType.key) : 'None';
  const typeTile = document.createElement('div');
  typeTile.className = 'insight-tile';
  typeTile.innerHTML = `
    <div class="insight-tile__header">
      <span aria-hidden="true">${icons.alertTriangle(16)}</span>
      <span>Most Common Type</span>
    </div>
    <div class="insight-tile__value">${typeLabel}</div>
    <div class="insight-tile__badge">${topType.count > 0 ? `${topType.count} cases (${topTypePct}% of total)` : 'No cases recorded'}</div>
  `;

  const peakHourTile = document.createElement('div');
  peakHourTile.className = 'insight-tile';
  peakHourTile.innerHTML = `
    <div class="insight-tile__header">
      <span aria-hidden="true">${icons.clock(16)}</span>
      <span>Peak Reporting Hour</span>
    </div>
    <div class="insight-tile__value">${peakHour.count > 0 ? formatHourRange(peakHour.hour) : 'None'}</div>
    <div class="insight-tile__badge">${peakHour.count > 0 ? `${peakHour.count} ${peakHour.count === 1 ? 'incident' : 'incidents'} recorded` : 'No activity detected'}</div>
  `;

  insightsGrid.append(busiestTile, typeTile, peakHourTile);
  insightsCard.appendChild(insightsGrid);

  const trendCard = document.createElement('div');
  trendCard.className = 'card dashboard-row';
  trendCard.appendChild(cardHeader(
    'Incident Trends',
    'Reported against resolved, by day',
    icons.trendingUp,
    'Total reported incidents versus resolved cases for each day across the selected range.'
  ));
  trendCard.appendChild(LineChart({
    points: summary.trend.map((day) => ({ label: shortDate(day.date), values: [day.count, day.resolved ?? 0] })),
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

  const crossDomainGrid = document.createElement('div');
  crossDomainGrid.className = 'two-col-grid dashboard-row';

  const caseStatusCard = document.createElement('div');
  caseStatusCard.className = 'card';
  caseStatusCard.appendChild(cardHeader(
    'Blotter Case Status',
    'All finalized blotter entries, all time',
    icons.fileText,
    'Cumulative status of all finalized blotter entries to date — not scoped to the date range above.'
  ));
  const caseStatusHost = document.createElement('div');
  caseStatusHost.setAttribute('data-case-status-host', '');
  caseStatusHost.appendChild(Object.assign(document.createElement('div'), { className: 'skeleton skeleton--block' }));
  caseStatusCard.append(caseStatusHost);
  crossDomainGrid.appendChild(caseStatusCard);

  if (role === 'admin') {
    const citizenCard = document.createElement('div');
    citizenCard.className = 'card';
    citizenCard.appendChild(cardHeader(
      'Citizen Reports',
      'All submitted reports, all time',
      icons.messageSquare,
      'Conversion tracking from citizen submissions into blotter records — not scoped to the date range above.'
    ));
    const citizenHost = document.createElement('div');
    citizenHost.setAttribute('data-citizen-conversion-host', '');
    citizenHost.appendChild(Object.assign(document.createElement('div'), { className: 'skeleton skeleton--block' }));
    citizenCard.append(citizenHost);
    crossDomainGrid.appendChild(citizenCard);
  }

  const analyticsGrid = document.createElement('div');
  analyticsGrid.className = 'two-col-grid dashboard-row';

  const byHourCard = document.createElement('div');
  byHourCard.className = 'card';
  byHourCard.appendChild(cardHeader(
    'Incidents by Hour of Day',
    'Distribution across 24 hours (Asia/Manila)',
    icons.clock,
    'Hourly frequency of reported incidents.'
  ));
  byHourCard.appendChild(BarChart({
    bars: summary.byHour.map((count, hour) => ({ label: HOUR_LABELS[hour], value: count })),
    colorVar: '--chart-line-1',
    caption: 'Incidents by hour of day (Asia/Manila)',
  }));

  const responseTimeCard = document.createElement('div');
  responseTimeCard.className = 'card';
  responseTimeCard.appendChild(cardHeader(
    'Response Time Trend',
    'Average minutes to arrival by day',
    icons.activity,
    'Average response time from dispatch to arrival on scene.'
  ));
  responseTimeCard.appendChild(LineChart({
    points: summary.responseTimeTrend.map((day) => ({ label: shortDate(day.date), values: [day.avgMinutes ?? 0] })),
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
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const item = document.createElement('div');
    item.className = 'breakdown-item';

    const row = document.createElement('div');
    row.className = 'row-between breakdown-row';
    const label = document.createElement('span');
    label.innerHTML = `<span class="status-pill ${CASE_STATUS_PILL_CLASS[key]}">${CASE_STATUS_LABELS[key]}</span>`;
    const value = document.createElement('span');
    value.className = 'breakdown-row__value';
    value.innerHTML = `<strong>${count}</strong> <span class="breakdown-row__pct">(${pct}%)</span>`;
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
  const rows = Object.entries(counts).map(([key, count], i) => ({
    key, count, label: INCIDENT_TYPE_LABELS[key] || key, color: INCIDENT_TYPE_COLORS[i % INCIDENT_TYPE_COLORS.length],
  }));
  card.append(
    cardHeader('By Incident Type', 'Distribution by category', icons.activity, 'Breakdown of incidents across categories for this date range.'),
    DonutChart({ rows })
  );
  return card;
}

function renderBreakdownCard(title, counts, labels, pillClasses) {
  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(cardHeader(
    title,
    'Breakdown by resolution stage',
    icons.barChart,
    'Distribution of incidents across pending, dispatched, and resolved stages.'
  ));

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const list = document.createElement('div');
  list.className = 'stack';
  for (const [key, count] of Object.entries(counts)) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const item = document.createElement('div');
    item.className = 'breakdown-item';

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
    value.innerHTML = `<strong>${count}</strong> <span class="breakdown-row__pct">(${pct}%)</span>`;
    row.append(label, value);

    const track = document.createElement('div');
    track.className = 'breakdown-progress-track';
    const fill = document.createElement('div');
    fill.className = 'breakdown-progress-fill';
    if (pillClass) fill.classList.add(`breakdown-progress-fill--${key}`);
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    item.append(row, track);
    list.appendChild(item);
  }
  card.appendChild(list);
  return card;
}
