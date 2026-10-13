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

import { getReportsSummary, exportReport, downloadReportExport, getCitizenReports, getBarangays, ApiClientError } from '../api/apiClient.js';
import { showToast } from '../components/Toast.js';
import { KpiCard, KpiHeroCard } from '../components/KpiCard.js';
import { LineChart } from '../components/LineChart.js';
import { BarChart } from '../components/BarChart.js';
import { DonutChart } from '../components/DonutChart.js';
import { InfoTip } from '../components/Tooltip.js';
import { icons } from '../components/icons.js';
import { DateRangePicker, manilaTodayIso } from '../components/DateRangePicker.js';
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { formatManilaDate, formatManilaDateTime } from '../utils/manilaTime.js';
import { INCIDENT_STATUS_LABELS } from '../utils/statusLabels.js';

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
// Audit P-06 (2026-10-09): by_status now carries every incident status
// (migration 0025's lifecycle states too), so the rows add up to the total.
const STATUS_LABELS = INCIDENT_STATUS_LABELS;
const STATUS_PILL_CLASS = {
  pending: 'status-pill--pending', dispatched: 'status-pill--info', resolved: 'status-pill--success',
  reopened: 'status-pill--warning', cancelled: 'status-pill--neutral', invalid: 'status-pill--neutral', duplicate: 'status-pill--neutral',
};
// Lifecycle statuses are listed only when they actually occur in the range,
// so a normal range keeps its familiar three rows.
const CORE_STATUSES = new Set(['pending', 'dispatched', 'resolved']);
// Bar/segment colour classes exist for the core three; the lifecycle
// states borrow the nearest existing style instead of an unstyled class.
const STATUS_STYLE_KEY = { reopened: 'pending', cancelled: 'settled', invalid: 'settled', duplicate: 'settled' };
const OPEN_STATUSES = ['pending', 'dispatched', 'reopened'];

/**
 * One wording for the response-time metric everywhere (audits N-01, N-02,
 * P-02..P-05, 2026-10-09). The backend measures incident.created_at to the
 * FIRST dispatch arrived_at, per incident (de-duplicated), so the clock
 * starts when the incident was recorded, NOT at dispatch. No target or
 * benchmark exists in any project document, so none is shown. It is an
 * operational measure for the barangay, never a ranking of tanods.
 */
const RESPONSE_METRIC_LABEL = 'Incident reported to first Tanod arrival (average)';
const RESPONSE_OFFLINE_FOOTNOTE = 'An incident captured offline on a Tanod phone starts the clock when it synced, not when it was captured.';

/**
 * Number of incidents behind the average: the sum of trend[].arrivals
 * (each day's incidents that had a first arrival). Null when the server
 * did not send the per-day counts, so the UI says nothing rather than
 * inventing a sample size.
 */
function responseSampleSize(summary) {
  const days = summary?.trend || [];
  if (days.length === 0 || days.some((d) => typeof d.arrivals !== 'number')) return null;
  return days.reduce((sum, d) => sum + d.arrivals, 0);
}

/** "Based on N incidents with a Tanod arrival" footer, or a neutral line when n is unknown. */
function responseFooter(summary) {
  const n = responseSampleSize(summary);
  if (n === null) return 'Incident reported to first Tanod arrival';
  if (n === 0) return 'No incident in this range had a Tanod arrival';
  return `Based on ${n} incident${n === 1 ? '' : 's'} with a Tanod arrival`;
}

/** YYYYMMDD-HHMM (Asia/Manila) suffix for a unique-per-print reference (audit P-17). */
function referenceStamp(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}`;
}


/** 14 -> "2:00 PM – 3:00 PM" */
/** "2026-10-09" (a Manila calendar day from the API) -> "Oct 9, 2026". */
function dayLabel(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? formatManilaDate(`${iso}T00:00:00+08:00`) : 'Not recorded';
}

function formatHourRange(h) {
  const startPeriod = h < 12 ? 'AM' : 'PM';
  const startH = h % 12 === 0 ? 12 : h % 12;
  const nextH = (h + 1) % 24;
  const endPeriod = nextH < 12 ? 'AM' : 'PM';
  const endH = nextH % 12 === 0 ? 12 : nextH % 12;
  return `${startH}:00 ${startPeriod} – ${endH}:00 ${endPeriod}`;
}

function cardHeader(title, subtitle, icon, description, viewAll, chip) {
  const el = document.createElement('div');
  el.className = 'card-header';
  const titles = document.createElement('div');
  const h = document.createElement('h3');
  h.className = 'card-header__title report-section-title';
  h.append(title);
  if (chip) {
    const chipEl = document.createElement('span');
    chipEl.className = 'card-header__chip';
    if (chip.tone) chipEl.classList.add('card-header__chip--' + chip.tone);
    chipEl.textContent = chip.text;
    h.appendChild(chipEl);
  }
  if (description) h.appendChild(InfoTip(description));
  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'card-header__subtitle';
    sub.textContent = subtitle;
    titles.append(h, sub);
  } else {
    titles.append(h);
  }

  let corner;
  if (viewAll) {
    corner = document.createElement('button');
    corner.type = 'button';
    corner.className = 'card-header__action-btn';
    corner.innerHTML = `<span>${escapeHtml(viewAll.label)}</span> ${icons.arrowUpRight(14)}`;
    corner.setAttribute('aria-label', viewAll.label);
    corner.title = viewAll.label;
    corner.addEventListener('click', viewAll.onClick);
    el.append(titles, corner);
  } else if (icon) {
    corner = document.createElement('span');
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
 * @param {{fullName:string, role:string, barangayId?:number}} user
 */
/** "2026-09-04" -> "Sep 4", for chart tick labels. */
function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

/**
 * Opens an A4 Printable Statistical Report Preview modal that mirrors
 * the server-generated Statistical Report PDF 1-for-1.
 */
function openStatisticalReportPrintModal(summary, range, user, barangayInfo, triggerExport) {
  const total = summary.totalIncidents || 0;
  const resolvedCount = summary.resolvedCount || 0;
  const resolutionRate = total > 0 ? ((resolvedCount / total) * 100).toFixed(1) : '0.0';
  const avgResp = summary.avgResponseTimeMinutes !== null && summary.avgResponseTimeMinutes !== undefined
    ? `${summary.avgResponseTimeMinutes} min`
    : 'No data';
  const sampleSize = responseSampleSize(summary);
  const avgRespSub = sampleSize === null ? 'Reported to first arrival' : `Reported to first arrival, n=${sampleSize}`;

  const busiestDay = summary.trend && summary.trend.length > 0
    ? summary.trend.reduce((best, day) => (day.count > best.count ? day : best), summary.trend[0])
    : { date: range.to || manilaTodayIso(), count: 0 };

  const topType = Object.entries(summary.byIncidentType || {}).reduce(
    (best, [key, count]) => (count > best.count ? { key, count } : best),
    { key: null, count: 0 }
  );
  const topTypeLabel = topType.key ? (INCIDENT_TYPE_LABELS[topType.key] || 'Other') : 'None';
  const topTypeShare = total > 0 ? ((topType.count / total) * 100).toFixed(1) : '0.0';

  let peakHour = { hour: 0, count: 0 };
  (summary.byHour || []).forEach((count, hour) => {
    if (count > peakHour.count) peakHour = { hour, count };
  });
  const peakHourStr = peakHour.count > 0
    ? `${formatHourRange(peakHour.hour)} (${peakHour.count} ${peakHour.count === 1 ? 'incident' : 'incidents'})`
    : 'No incidents recorded';

  const activeLoad = OPEN_STATUSES.reduce((sum, key) => sum + (summary.byStatus?.[key] || 0), 0);
  const now = new Date();
  const nowStr = formatManilaDateTime(now);
  // Audit P-01/N-18 (2026-10-09): this sheet used to print the viewer as
  // "Prepared By" over a signature line and "HON. PUNONG BARANGAY ·
  // Attested & Approved" under a pre-written sworn oath nobody had made.
  // It is now an unsigned system summary; the person who asked for it is
  // named only as the requester, and the reviewer block stays blank until
  // someone signs on paper.
  const requestedBy = user?.fullName || 'a signed-in user';
  const refCode = `BRGY-${user?.barangayId ?? '?'}-${referenceStamp(now)}`;

  const sublineHtml = barangayInfo
    ? `<p class="print-sheet__subline">Province of ${escapeHtml(barangayInfo.province)} · Municipality of ${escapeHtml(barangayInfo.municipality)}</p>`
    : '';
  const officeHeading = barangayInfo
    ? `BARANGAY ${escapeHtml(barangayInfo.name.toUpperCase())} — PEACEKEEPING &amp; OPERATIONS DESK`
    : 'BARANGAY PEACEKEEPING &amp; OPERATIONS DESK';

  const typeRowsHtml = Object.entries(summary.byIncidentType || {}).map(([typeKey, count]) => {
    const share = total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '0.0%';
    const label = INCIDENT_TYPE_LABELS[typeKey] || 'Other';
    return `
      <tr>
        <td>${escapeHtml(label)}</td>
        <td class="print-sheet__table-num">${escapeHtml(String(count))}</td>
        <td class="print-sheet__table-num">${escapeHtml(share)}</td>
      </tr>
    `;
  }).join('');

  const statusRowsHtml = Object.entries(summary.byStatus || {}).map(([statusKey, count]) => {
    const share = total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '0.0%';
    const label = STATUS_LABELS[statusKey] || 'Unknown';
    return `
      <tr>
        <td>${escapeHtml(label)}</td>
        <td class="print-sheet__table-num">${escapeHtml(String(count))}</td>
        <td class="print-sheet__table-num">${escapeHtml(share)}</td>
      </tr>
    `;
  }).join('');

  const sheetHtml = `
    <div class="print-sheet__masthead">
      <p class="print-sheet__republic">Republic of the Philippines</p>
      ${sublineHtml}
      <h2 class="print-sheet__office">${officeHeading}</h2>
      <p class="print-sheet__doctype">BARANGAY INCIDENT &amp; PEACEKEEPING STATISTICAL REPORT</p>
    </div>

    <div class="print-sheet__meta-bar">
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__label">Report Reference</span>
        <strong class="print-sheet__mono">${escapeHtml(refCode)}</strong>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__label">Coverage Period</span>
        <strong>${escapeHtml(dayLabel(range.from))} to ${escapeHtml(dayLabel(range.to))}</strong>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__label">Prepared By</span>
        <strong>System-generated (not signed)</strong>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__label">Date Generated</span>
        <strong>${escapeHtml(nowStr)}</strong>
      </div>
    </div>

    <div class="print-sheet__kpi-grid">
      <div class="print-sheet__kpi-card">
        <span class="print-sheet__label">Total Incidents</span>
        <p class="print-sheet__kpi-val">${escapeHtml(String(total))}</p>
        <p class="print-sheet__kpi-sub">Logged during coverage</p>
      </div>
      <div class="print-sheet__kpi-card">
        <span class="print-sheet__label">Resolution Rate</span>
        <p class="print-sheet__kpi-val">${escapeHtml(resolutionRate)}%</p>
        <p class="print-sheet__kpi-sub">${escapeHtml(String(resolvedCount))} of ${escapeHtml(String(total))} resolved</p>
      </div>
      <div class="print-sheet__kpi-card">
        <span class="print-sheet__label">Avg Response Time</span>
        <p class="print-sheet__kpi-val">${escapeHtml(avgResp)}</p>
        <p class="print-sheet__kpi-sub">${escapeHtml(avgRespSub)}</p>
      </div>
      <div class="print-sheet__kpi-card">
        <span class="print-sheet__label">Tanods On Duty</span>
        <p class="print-sheet__kpi-val">${escapeHtml(String(summary.activeTanods ?? 0))}</p>
        <p class="print-sheet__kpi-sub">At time of printing</p>
      </div>
    </div>

    <div class="print-sheet__grid-2col">
      <div class="print-sheet__field-box">
        <span class="print-sheet__label">Leading Incident Category</span>
        <p class="print-sheet__field-val">${escapeHtml(topTypeLabel)} (${escapeHtml(String(topType.count))} cases, ${escapeHtml(topTypeShare)}% of total)</p>
      </div>
      <div class="print-sheet__field-box">
        <span class="print-sheet__label">Peak Reporting Hours</span>
        <p class="print-sheet__field-val">${escapeHtml(peakHourStr)}</p>
      </div>
    </div>

    <div class="print-sheet__grid-2col">
      <div class="print-sheet__field-box">
        <span class="print-sheet__label">Highest Activity Date</span>
        <p class="print-sheet__field-val">${busiestDay.count > 0 ? `${escapeHtml(dayLabel(busiestDay.date))} (${escapeHtml(String(busiestDay.count))} cases logged)` : 'Evenly distributed / No incidents'}</p>
      </div>
      <div class="print-sheet__field-box">
        <span class="print-sheet__label">Active Caseload Requiring Action</span>
        <p class="print-sheet__field-val">${escapeHtml(String(activeLoad))} still open (Pending / Responding / Reopened)</p>
      </div>
    </div>

    <div class="print-sheet__section">
      <span class="print-sheet__label">1. Classification of Reported Incidents</span>
      <table class="print-sheet__table">
        <thead>
          <tr>
            <th scope="col">Incident Classification / Type</th>
            <th scope="col" class="print-sheet__table-num">Recorded Cases</th>
            <th scope="col" class="print-sheet__table-num">Percentage Share</th>
          </tr>
        </thead>
        <tbody>
          ${typeRowsHtml}
          <tr class="print-sheet__table-total">
            <td>TOTAL INCIDENTS RECORDED</td>
            <td class="print-sheet__table-num">${escapeHtml(String(total))}</td>
            <td class="print-sheet__table-num">100.0%</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="print-sheet__section">
      <span class="print-sheet__label">2. Case Disposition &amp; Resolution Breakdown</span>
      <table class="print-sheet__table">
        <thead>
          <tr>
            <th scope="col">Case Disposition / Status</th>
            <th scope="col" class="print-sheet__table-num">Case Count</th>
            <th scope="col" class="print-sheet__table-num">Resolution Share</th>
          </tr>
        </thead>
        <tbody>
          ${statusRowsHtml}
          <tr class="print-sheet__table-total">
            <td>TOTAL CASES PROCESSED</td>
            <td class="print-sheet__table-num">${escapeHtml(String(total))}</td>
            <td class="print-sheet__table-num">100.0%</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="print-sheet__section">
      <span class="print-sheet__label">Notes</span>
      <div class="print-sheet__narrative">System-generated summary, not signed or attested. Compiled from Baranguard records on ${escapeHtml(nowStr)} (Asia/Manila), requested by ${escapeHtml(requestedBy)}. This report contains aggregate operational figures only; no personal data. Avg Response Time = ${escapeHtml(RESPONSE_METRIC_LABEL)}${sampleSize === null ? '' : `, over ${escapeHtml(String(sampleSize))} incident(s) that had an arrival`}. ${escapeHtml(RESPONSE_OFFLINE_FOOTNOTE)} It is an operational measure, not a rating of any Tanod.</div>
    </div>

    <div class="print-sheet__signatures">
      <div class="print-sheet__sig-col">
        <div class="print-sheet__sig-line"></div>
        <p class="print-sheet__sig-name">Prepared by: system-generated summary</p>
        <p class="print-sheet__sig-role">(not signed)</p>
      </div>
      <div class="print-sheet__sig-col">
        <div class="print-sheet__sig-line"></div>
        <p class="print-sheet__sig-name">Reviewed and approved by:</p>
        <p class="print-sheet__sig-role">Punong Barangay &nbsp;&nbsp;&nbsp; Date: ____________</p>
      </div>
    </div>

    <p class="print-sheet__footer">
      System-generated statistical summary (${escapeHtml(dayLabel(range.from))} to ${escapeHtml(dayLabel(range.to))}) · Generated ${escapeHtml(nowStr)} from the Baranguard Operations Console.
    </p>
  `;

  openPrintPreviewModal({
    title: 'Printable Statistical & Operations Report',
    subtitle: `Formatted A4 summary (${dayLabel(range.from)} to ${dayLabel(range.to)}) • Aggregate figures only, unsigned`,
    sheetId: 'printable-report-sheet',
    sheetHtml,
    extraActions: [
      {
        label: 'Export CSV',
        icon: icons.download(16),
        className: 'ghost',
        onClick: (btn) => triggerExport('csv', btn, 'Export CSV', icons.download(16)),
      },
      {
        label: 'Download PDF',
        icon: icons.fileText(16),
        className: 'ghost',
        onClick: (btn) => triggerExport('pdf', btn, 'Download PDF', icons.fileText(16)),
      },
    ],
  });
}

export function renderReportsTab(container, pageHeader, user, navigate) {
  let latestSummary = null;
  let barangayInfo = null;

  if (user?.barangayId) {
    getBarangays().then((rows) => {
      barangayInfo = rows.find((b) => b.barangayId === user.barangayId) || null;
    }).catch(() => {
      // Best-effort header enrichment for the printable sheet
    });
  }

  // 2026-09-06 UI/UX audit: was a copy of the Admin Dashboard's ~120-line
  // picker (one of five that had drifted apart). Now the shared component.
  // Unlike the dashboard this screen has no "server default range" to
  // reconcile against — every load is an explicit, client-chosen range —
  // so it never calls reconcile()/setDates().
  const rangePicker = DateRangePicker({
    value: '30',
    ariaLabel: 'Date range',
    onChange: ({ from, to }) => load(from, to),
  });

  async function triggerExport(format, button, label, iconSvg) {
    const idleHtml = `<span aria-hidden="true">${iconSvg}</span><span>${escapeHtml(label)}</span>`;
    button.disabled = true;
    button.innerHTML = `<span class="is-spinning" aria-hidden="true">${icons.repeat(14)}</span><span>Exporting…</span>`;
    try {
      const range = rangePicker.getState();
      await exportReport({ dateFrom: range.from, dateTo: range.to, format });
      const blob = await downloadReportExport({ format });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `baranguard-report-${range.from}-to-${range.to}.${format}`;
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
  }

  function buildExportButton(format, label, iconSvg) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.innerHTML = `<span aria-hidden="true">${iconSvg}</span><span>${escapeHtml(label)}</span>`;
    button.addEventListener('click', () => triggerExport(format, button, label, iconSvg));
    return button;
  }

  const previewPrintButton = document.createElement('button');
  previewPrintButton.type = 'button';
  previewPrintButton.className = 'ghost';
  previewPrintButton.id = 'preview-report-print-btn';
  previewPrintButton.innerHTML = `<span aria-hidden="true">${icons.printer(16)}</span><span>Preview &amp; Print</span>`;
  previewPrintButton.addEventListener('click', () => {
    if (!latestSummary) {
      showToast('Report data is still loading. Please wait a moment.', { variant: 'info' });
      return;
    }
    openStatisticalReportPrintModal(latestSummary, rangePicker.getState(), user, barangayInfo, triggerExport);
  });

  const exportGroup = document.createElement('div');
  exportGroup.className = 'export-btn-group';
  exportGroup.append(
    previewPrintButton,
    buildExportButton('csv', 'Export CSV', icons.download(16)),
    buildExportButton('pdf', 'Export PDF', icons.fileText(16))
  );

  pageHeader.actions.append(rangePicker.el, exportGroup);

  const body = document.createElement('div');
  body.className = 'dashboard-body';
  container.append(body);

  const initialRange = rangePicker.getState();
  load(initialRange.from, initialRange.to);

  async function load(dateFrom, dateTo) {
    const isInitial = body.children.length === 0;
    if (isInitial) {
      renderLoading(body);
    } else {
      body.classList.add('is-reloading');
    }
    try {
      const summary = await getReportsSummary({ dateFrom, dateTo });
      latestSummary = summary;
      renderReport(body, summary, user.role, navigate);
      if (user.role === 'admin') loadCitizenReportsConversion(body, navigate);
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

function renderReport(container, summary, role, navigate) {
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
    KpiHeroCard({
      label: 'Total Incidents',
      value: summary.totalIncidents,
      icon: icons.bell,
      accent: 'blue',
      resolvedCount: summary.resolvedCount,
      sparkline: summary.trend?.map((day) => day.count),
      description: 'Every incident reported in the selected date range, alongside resolution progress and trend activity.',
    }),
    // Audits N-01/P-03 (2026-10-09): the "Target < 20m" chip is gone -- no
    // document defines a response target, and a null value was painted as
    // a warning. See RESPONSE_METRIC_LABEL for the one wording used.
    KpiCard({
      label: 'Avg. Response Time',
      value: summary.avgResponseTimeMinutes === null ? null : `${summary.avgResponseTimeMinutes} min`,
      emptyText: 'No arrivals recorded in this range',
      icon: icons.clock,
      accent: 'orange',
      footerNote: responseFooter(summary),
      description: `${RESPONSE_METRIC_LABEL}. Only incidents with a Tanod arrival are counted; incidents resolved without a dispatch are not included. ${RESPONSE_OFFLINE_FOOTNOTE} An operational measure for the barangay, not a rating of any Tanod.`,
    }),
    KpiCard({
      label: 'Active Tanods',
      value: summary.activeTanods,
      icon: icons.users,
      accent: 'teal',
      badgeChip: {
        text: 'Live Roster',
        tone: 'live',
      },
      footerNote: 'Currently marked On Duty or Responding',
      description: 'Tanods currently marked On Duty or Responding right now.',
    })
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
    : { date: manilaTodayIso(), count: 0 };
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

  const typeLabel = topType.count > 0 ? (INCIDENT_TYPE_LABELS[topType.key] || 'Other') : 'None';
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

  let citizenCard = null;
  if (role === 'admin') {
    citizenCard = document.createElement('div');
    citizenCard.className = 'card dashboard-row citizen-reports-card';
    citizenCard.setAttribute('data-citizen-card', '');
    citizenCard.appendChild(cardHeader(
      'Citizen Reports Intake & Conversion',
      'Citizen submission pipeline & triage efficiency (All time)',
      icons.messageSquare,
      'Conversion tracking from citizen submissions into formalized incidents — not scoped to the date range above.',
      navigate ? { label: 'Review Inbox', onClick: () => navigate('citizen-inbox') } : null
    ));
    const citizenHost = document.createElement('div');
    citizenHost.setAttribute('data-citizen-conversion-host', '');
    citizenHost.style.display = 'flex';
    citizenHost.style.flexDirection = 'column';
    citizenHost.style.flex = '1';
    citizenHost.appendChild(Object.assign(document.createElement('div'), { className: 'skeleton skeleton--block' }));
    citizenCard.append(citizenHost);
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
    'Average minutes from report to first arrival, by day',
    icons.activity,
    `${RESPONSE_METRIC_LABEL}, per day the incident was reported. Days with no arrival are gaps, not zero. ${RESPONSE_OFFLINE_FOOTNOTE}`
  ));
  responseTimeCard.appendChild(LineChart({
    points: summary.responseTimeTrend.map((day) => ({ label: shortDate(day.date), values: [day.avgMinutes] })),
    series: [{ name: 'Avg. minutes, report to first arrival', colorVar: '--chart-line-2' }],
    caption: 'Average minutes from incident report to first Tanod arrival, by day',
  }));

  analyticsGrid.append(byHourCard, responseTimeCard);

  container.append(kpiGrid, insightsCard, trendCard, breakdownGrid);
  if (citizenCard) container.appendChild(citizenCard);
  container.appendChild(analyticsGrid);
}

/**
 * `GET /citizen-reports` has no "converted" status filter (only
 * "unconverted", §6/CitizenReportsController::index()) — so conversion
 * count is derived from two cheap `limit:1` calls (only `.total` is
 * used from each) rather than fetching every report just to count them.
 */
async function loadCitizenReportsConversion(container, navigate) {
  const host = container.querySelector('[data-citizen-conversion-host]');
  if (!host) return;
  const card = container.querySelector('[data-citizen-card]');
  try {
    const [allResult, unconvertedResult] = await Promise.all([
      getCitizenReports({ limit: 1 }),
      getCitizenReports({ status: 'unconverted', limit: 1 }),
    ]);
    const totalReports = allResult.total;
    const unconverted = unconvertedResult.total;
    const converted = Math.max(0, totalReports - unconverted);

    if (card) {
      const headerTitle = card.querySelector('.card-header__title');
      if (headerTitle && !headerTitle.querySelector('.card-header__chip')) {
        const chipEl = document.createElement('span');
        chipEl.className = `card-header__chip ${unconverted > 0 ? 'card-header__chip--warning' : ''}`;
        chipEl.textContent = unconverted > 0 ? `${unconverted} Pending` : `${totalReports} Total`;
        const tip = headerTitle.querySelector('.tooltip-wrap');
        if (tip) {
          headerTitle.insertBefore(chipEl, tip);
        } else {
          headerTitle.appendChild(chipEl);
        }
      }
    }

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
  const convertedPct = Math.round((converted / totalReports) * 100);
  const unconvertedPct = totalReports > 0 ? Math.round((unconverted / totalReports) * 100) : 0;

  const container = document.createElement('div');
  container.className = 'citizen-conversion-body';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = 'var(--spacing-sm)';

  // Conversion Efficiency Hero Banner
  const heroBanner = document.createElement('div');
  heroBanner.className = 'conversion-hero-banner';
  heroBanner.innerHTML = `
    <div class="conversion-hero-banner__left">
      <span class="conversion-hero-banner__badge ${convertedPct >= 50 ? 'conversion-hero-banner__badge--success' : 'conversion-hero-banner__badge--warning'}" aria-hidden="true">
        ${icons.trendingUp(16)}
      </span>
      <div class="conversion-hero-banner__text">
        <span class="conversion-hero-banner__title">Intake Conversion Efficiency</span>
        <span class="conversion-hero-banner__caption">${converted} of ${totalReports} citizen submissions formalized into incidents</span>
      </div>
    </div>
    <div class="conversion-hero-banner__right">
      <span class="conversion-hero-banner__val">${convertedPct}%</span>
      <span class="conversion-hero-banner__rate-label">Formalized</span>
    </div>
  `;
  container.appendChild(heroBanner);

  // Multi-Segment Proportional Pipeline Bar
  const pipelineBar = document.createElement('div');
  pipelineBar.className = 'pipeline-stacked-bar';
  pipelineBar.setAttribute('aria-hidden', 'true');
  if (converted > 0) {
    const seg = document.createElement('div');
    const pct = ((converted / totalReports) * 100).toFixed(1);
    seg.className = 'pipeline-stacked-segment pipeline-stacked-segment--resolved';
    seg.style.width = `${pct}%`;
    seg.title = `Converted: ${converted} (${convertedPct}%)`;
    pipelineBar.appendChild(seg);
  }
  if (unconverted > 0) {
    const seg = document.createElement('div');
    const pct = ((unconverted / totalReports) * 100).toFixed(1);
    seg.className = 'pipeline-stacked-segment pipeline-stacked-segment--pending';
    seg.style.width = `${pct}%`;
    seg.title = `Awaiting Review: ${unconverted} (${unconvertedPct}%)`;
    pipelineBar.appendChild(seg);
  }
  container.appendChild(pipelineBar);

  // Clean Dual Operational Summary Footer (Direct & Non-Redundant)
  const footer = document.createElement('div');
  footer.className = 'category-summary-footer';
  footer.innerHTML = `
    <div class="category-summary-tile">
      <span class="category-summary-tile__val">
        <span class="summary-tile-pip" style="background:var(--color-warning);" aria-hidden="true"></span>
        ${unconverted} Awaiting Review
      </span>
      <span class="category-summary-tile__sub">${unconvertedPct}% pending operational triage</span>
    </div>
    <div class="category-summary-tile">
      <span class="category-summary-tile__val">
        <span class="summary-tile-pip" style="background:var(--color-success);" aria-hidden="true"></span>
        ${converted} Formalized
      </span>
      <span class="category-summary-tile__sub">${convertedPct}% converted to active incident record</span>
    </div>
  `;
  container.appendChild(footer);

  host.appendChild(container);
}

function renderIncidentTypeDonutCard(counts) {
  const card = document.createElement('div');
  card.className = 'card incident-type-donut-card';

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
      'By Incident Type',
      'Distribution by category',
      icons.activity,
      'Breakdown of incidents across categories for this date range.',
      null,
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
          <span class="summary-tile-pip" style="background:var(--chart-cat-8);" aria-hidden="true"></span>
          ${activeCatsCount} Active ${activeCatsCount === 1 ? 'Category' : 'Categories'}
        </span>
        <span class="category-summary-tile__sub">Out of 11 classified types</span>
      </div>
    `;
    card.appendChild(footer);
  }

  return card;
}

function renderBreakdownCard(title, counts, labels, pillClasses) {
  const card = document.createElement('div');
  card.className = 'card breakdown-status-card';

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  card.appendChild(cardHeader(
    title,
    'Breakdown by resolution stage',
    icons.barChart,
    'Distribution of incidents in this range across every status.'
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
        seg.className = `pipeline-stacked-segment pipeline-stacked-segment--${STATUS_STYLE_KEY[key] || key}`;
        seg.style.width = `${pct}%`;
        seg.title = `${labels[key] || key}: ${count} (${pct}%)`;
        pipelineBar.appendChild(seg);
      }
    }
    card.appendChild(pipelineBar);
  }

  const list = document.createElement('div');
  list.className = 'breakdown-status-grid';
  for (const [key, count] of Object.entries(counts)) {
    if (!CORE_STATUSES.has(key) && STATUS_LABELS[key] && count === 0) continue;
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
    fill.className = `breakdown-progress-fill breakdown-progress-fill--${STATUS_STYLE_KEY[key] || key}`;
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    item.append(row, track);
    list.appendChild(item);
  }
  card.appendChild(list);

  // Operational Pipeline Summary Footer
  if (total > 0) {
    // "Open" = still needs work: pending, dispatched or reopened (audit
    // P-06; "Active in Field" used to include pending, which is not in the
    // field yet, and left out reopened).
    const activeCount = OPEN_STATUSES.reduce((sum, key) => sum + (counts[key] || 0), 0);
    const activePct = Math.round((activeCount / total) * 100);
    const resolvedCount = counts.resolved || 0;
    const resolvedPct = Math.round((resolvedCount / total) * 100);

    const footer = document.createElement('div');
    footer.className = 'breakdown-summary-footer';
    footer.innerHTML = `
      <div class="breakdown-summary-tile">
        <span class="breakdown-summary-tile__val">
          <span class="summary-tile-pip" style="background:var(--chart-line-1);" aria-hidden="true"></span>
          ${activeCount} Open
        </span>
        <span class="breakdown-summary-tile__sub">${activePct}% of incidents in range (pending, dispatched or reopened)</span>
      </div>
      <div class="breakdown-summary-tile">
        <span class="breakdown-summary-tile__val">
          <span class="summary-tile-pip" style="background:var(--chart-line-2);" aria-hidden="true"></span>
          ${resolvedCount} Resolved
        </span>
        <span class="breakdown-summary-tile__sub">${resolvedPct}% of incidents in range</span>
      </div>
    `;
    card.appendChild(footer);
  }

  return card;
}
