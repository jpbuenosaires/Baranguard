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

import { getReportsSummary, logout, ApiClientError } from '../api/apiClient.js';
import { KpiCard } from '../components/KpiCard.js';
import { LineChart } from '../components/LineChart.js';
import { BarChart } from '../components/BarChart.js';
import { DonutChart } from '../components/DonutChart.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
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
 * @param {(page: string) => void} navigate
 */
export function renderStatisticalReportsPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'reports', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({ title: 'Analytics', subtitle: 'Generate a trend, status, and response-time breakdown for a date range', icon: icons.barChart });
  header.appendChild(pageHeader.el);

  const controls = document.createElement('div');
  controls.className = 'filter-bar';
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
  controls.append(
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'From' }),
    fromInput,
    Object.assign(document.createElement('span'), { className: 'label', textContent: 'To' }),
    toInput,
    generateButton
  );

  const body = document.createElement('div');
  content.append(controls, body);
  renderPrompt(body);

  generateButton.addEventListener('click', () => load(fromInput.value, toInput.value));

  async function load(dateFrom, dateTo) {
    renderLoading(body);
    generateButton.disabled = true;
    try {
      const summary = await getReportsSummary({ dateFrom, dateTo });
      renderReport(body, summary);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong generating the report.';
      renderError(body, message, () => load(dateFrom, dateTo));
    } finally {
      generateButton.disabled = false;
    }
  }
}

function renderPrompt(container) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = `
    <h3>Choose a date range</h3>
    <p>Pick a From/To range above and click Generate to produce the incident, status, and response-time breakdown for that period.</p>
  `;
  container.appendChild(block);
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

function renderReport(container, summary) {
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

  container.append(kpiGrid, trendCard, breakdownGrid, analyticsGrid);
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
