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
import { TrendChart } from '../components/TrendChart.js';
import { AppShell } from '../components/AppShell.js';
import { icons } from '../components/icons.js';

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
 * @param {(page: string) => void} navigate
 */
export function renderStatisticalReportsPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'reports', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { content } = shell;
  root.appendChild(shell.el);

  content.innerHTML = `<h2 style="margin-bottom:16px; display:flex; align-items:center; gap:10px;">${icons.barChart(22)}Statistical Reports</h2>`;

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:24px; flex-wrap:wrap;';
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.value = daysAgoIso(29);
  fromInput.style.width = 'auto';
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.value = todayIso();
  toInput.style.width = 'auto';
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
  chartSkeleton.className = 'card skeleton';
  chartSkeleton.style.height = '176px';
  container.appendChild(chartSkeleton);
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
    kpiTile('Total Incidents', summary.totalIncidents),
    kpiTile('Resolved', summary.resolvedCount),
    kpiTile('Avg. Response Time', summary.avgResponseTimeMinutes === null ? 'No arrivals yet' : `${summary.avgResponseTimeMinutes} min`),
    kpiTile('Active Tanods', summary.activeTanods)
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

  container.append(kpiGrid, trendCard, breakdownGrid);
}

function kpiTile(label, value) {
  const el = document.createElement('div');
  el.className = 'card kpi-card';
  const labelEl = document.createElement('div');
  labelEl.className = 'label kpi-card__label';
  labelEl.textContent = label;
  const valueEl = document.createElement('div');
  valueEl.className = 'kpi-card__value';
  valueEl.textContent = String(value);
  el.append(labelEl, valueEl);
  return el;
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
