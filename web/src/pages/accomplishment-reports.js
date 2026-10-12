/**
 * accomplishment-reports.js — monthly Accomplishment Reports for Barangay
 * Tanods (contract §4 / §10): list by person, month and status; a detail
 * view with every entry (system-flagged durations marked); a return action
 * for officials who hold the authority; and a print layout
 * that mirrors the barangay's own form (letterhead, name / position /
 * month / duration, 31 day rows, Prepared / Noted / Approved By).
 *
 * Printed and signed on paper: the app only prints. It does not track who
 * noted or approved a report; the signature lines print blank.
 *
 * Statuses: open (tanod still editing), prepared (submitted by the tanod),
 * returned (sent back by an official).
 *
 * Gating, all UX only (REFERENCE.md §2 Rule 2 — the server re-checks):
 *   - Return ............... status prepared, viewer holds
 *                            note_report or approve_report
 * A 409 for the preparer-must-differ rule is shown as a plain-language
 * message, not a raw error.
 *
 * Privacy: an entry's text is only rendered when the server sent it (it
 * withholds text from roles that may not read it). Nothing here puts a
 * person's minutes or text into a toast, URL or log.
 *
 * `param` (from the Approvals deep links): a report id, or
 * `{reportId?, status?, month?}`.
 */

import { DataTable } from '../components/DataTable.js';
import { avatarInitials } from '../components/Avatar.js';
import { showToast } from '../components/Toast.js';
import { promptText } from '../components/ConfirmDialog.js';
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';
import { icons } from '../components/icons.js';
import {
  getAccomplishmentReports, getAccomplishmentReport,
  returnAccomplishmentReport, getUserNames,
  REPORT_STATUS_LABELS,
} from '../services/tanodWorkflowApi.js';
import {
  h, escapeHtml, mountPageFrame, showLoading, showError, showEmpty, card, selectOf,
  getMyAuthority, statusPill, formatMonthLabel, formatMinutes, minutesToHours, formatManilaDate,
  formatManilaDateTime, formatDateOnly, trimTime, daysInMonth, actionErrorMessage,
  loadLetterhead, letterheadHtml,
} from '../services/tanodWorkflowUi.js';

const PAGE_SIZE = 10;
const STATUS_FILTERS = ['', 'open', 'prepared', 'returned'];
const TANOD_POSITION = 'Barangay Tanod'; // fallback when the user record carries no official_title

const COLUMNS = [
  { key: 'select', label: '', width: '40px' },
  { key: 'person', label: 'Tanod Personnel', width: '27%' },
  { key: 'month', label: 'Month', width: '13%' },
  { key: 'status', label: 'Status', width: '12%' },
  { key: 'entries', label: 'Entries', align: 'right', width: '9%' },
  { key: 'total', label: 'Total time', align: 'right', width: '11%' },
  { key: 'flagged', label: 'Flagged', align: 'right', width: '11%' },
  { key: 'action', label: 'Actions', align: 'right', width: '15%' },
];

function normalizeParam(param) {
  if (param === undefined || param === null) return {};
  if (typeof param === 'object') return param;
  return { reportId: param };
}

/** Entry count from whichever aggregate the list row carries (contract says "aggregated counts"). */
function entryCountOf(row) {
  if (typeof row.entryCount === 'number') return row.entryCount;
  if (typeof row.entriesCount === 'number') return row.entriesCount;
  if (Array.isArray(row.entries)) return row.entries.length;
  return null;
}

/**
 * @param {HTMLElement} root
 * @param {{userId:number, fullName:string, role:string, barangayId:number}} user
 * @param {() => void} onLoggedOut
 * @param {(page:string, param?:any) => void} navigate
 * @param {number|{reportId?:number,status?:string,month?:string}} [param]
 */
export function renderAccomplishmentReportsPage(root, user, onLoggedOut, navigate, param) {
  const initial = normalizeParam(param);
  const { pageHeader, container } = mountPageFrame({
    root, user, onLoggedOut, navigate,
    activeKey: 'accomplishment-reports',
    title: 'Accomplishment Reports',
    subtitle: 'Monthly reports by Barangay Tanods — review, print for signing on paper or return',
    icon: icons.fileText,
  });

  const state = {
    month: typeof initial.month === 'string' ? initial.month : '',
    status: STATUS_FILTERS.includes(initial.status) ? initial.status : '',
    search: '',
    page: 1,
    names: null,
  };
  const selectedReportIds = new Set();
  let lastResult = null;

  const listHost = h('div', 'tw-reports-list');
  const detailHost = h('div', 'tw-reports-detail');
  detailHost.hidden = true;
  container.append(listHost, detailHost);

  async function ensureNames() {
    if (state.names) return state.names;
    try { state.names = await getUserNames(); } catch { state.names = new Map(); }
    return state.names;
  }
  const personName = (row) => row.fullName || state.names?.get(row.userId) || `Tanod #${row.userId}`;

  // ----- list view ----------------------------------------------------------

  function buildFilters(onChange) {
    const wrap = h('div', 'acc-filters-container');
    const bar = h('div', 'acc-control-bar');

    // Tanod search input
    const searchWrap = h('div', 'acc-search-box');
    searchWrap.innerHTML = `<span class="acc-search-icon" aria-hidden="true">${icons.search ? icons.search(16) : '🔍'}</span>`;
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'acc-search-input';
    searchInput.id = 'tw-acc-search';
    searchInput.placeholder = 'Search tanod name...';
    searchInput.setAttribute('aria-label', 'Search reports by tanod name');
    searchWrap.appendChild(searchInput);

    // Controls group on the right
    const controlsRight = h('div', 'acc-control-right');

    // Month picker
    const monthWrap = h('div', 'acc-filter-field');
    const monthLabel = h('label', 'acc-filter-label', 'Month');
    monthLabel.htmlFor = 'tw-acc-month';
    const month = document.createElement('input');
    month.type = 'month';
    month.id = 'tw-acc-month';
    month.className = 'acc-month-input';
    month.value = state.month;
    month.setAttribute('aria-label', 'Filter by month');
    month.addEventListener('change', () => { state.month = month.value; state.page = 1; onChange(); });
    monthWrap.append(monthLabel, month);

    // Status select
    const statusWrap = h('div', 'acc-filter-field');
    const statusLabel = h('label', 'acc-filter-label', 'Status');
    statusLabel.htmlFor = 'tw-acc-status';
    const status = selectOf(
      STATUS_FILTERS.map((s) => ({ value: s, label: s ? REPORT_STATUS_LABELS[s] : 'All statuses' })),
      { value: state.status },
    );
    status.id = 'tw-acc-status';
    status.className = 'acc-status-select';
    status.setAttribute('aria-label', 'Filter by report status');
    status.addEventListener('change', () => {
      state.status = status.value;
      state.page = 1;
      onChange();
    });
    statusWrap.append(statusLabel, status);

    const clear = h('button', 'ghost acc-clear-btn', 'Clear filters');
    clear.type = 'button';
    clear.setAttribute('aria-label', 'Clear all active filters');
    clear.addEventListener('click', () => {
      state.month = ''; state.status = ''; state.search = ''; state.page = 1;
      month.value = ''; status.value = ''; searchInput.value = '';
      onChange();
    });

    controlsRight.append(monthWrap, statusWrap, clear);
    bar.append(searchWrap, controlsRight);

    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        state.search = searchInput.value.trim().toLowerCase();
        if (lastResult) renderList(lastResult);
      }, 200);
    });

    return bar;
  }

  let listBody = null;

  function showList() {
    detailHost.hidden = true;
    detailHost.innerHTML = '';
    listHost.hidden = false;
    pageHeader.actions.innerHTML = '';
    if (!listBody) {
      listHost.innerHTML = '';
      const tableCard = h('div', 'acc-table-card unified-table-card');
      tableCard.appendChild(buildFilters(loadList));
      listBody = h('div', 'tw-reports-list__body');
      tableCard.appendChild(listBody);
      listHost.appendChild(tableCard);
    }
    loadList();
  }

  async function loadList() {
    showLoading(listBody, 'Loading accomplishment reports');
    try {
      const res = await getAccomplishmentReports({
        month: state.month, status: state.status, page: state.page, limit: PAGE_SIZE,
      });
      await ensureNames();
      lastResult = res;
      renderList(res);
    } catch (err) {
      showError(listBody, err, loadList, 'Could not load accomplishment reports.');
    }
  }

  function renderList(res) {
    listBody.innerHTML = '';
    let rows = res.items;

    if (state.search) {
      const q = state.search;
      rows = rows.filter((r) => personName(r).toLowerCase().includes(q));
    }

    if (res.total === 0 && res.items.length === 0) {
      showEmpty(
        listBody,
        'No accomplishment reports',
        state.month || state.status
          ? 'No reports match these filters.'
          : 'Reports appear here once a tanod logs accomplishments for a month.',
      );
      return;
    }

    if (rows.length === 0) {
      showEmpty(listBody, 'No matching tanod reports', 'No reports match your search query. Clear or adjust your search keywords.');
      return;
    }

    // Floating / Docked Batch Action Bar
    const batchBar = h('div', 'acc-batch-bar');
    batchBar.hidden = selectedReportIds.size === 0;

    function syncBatchBar() {
      const count = selectedReportIds.size;
      batchBar.hidden = count === 0;
      if (count === 0) return;
      batchBar.innerHTML = '';

      const countLabel = h('div', 'acc-batch-count');
      countLabel.innerHTML = `<span class="acc-batch-pip"></span><span><strong>${count}</strong> ${count === 1 ? 'report' : 'reports'} selected</span>`;

      const actionsWrap = h('div', 'acc-batch-actions');

      const printBatchBtn = h('button', 'primary acc-batch-btn');
      printBatchBtn.type = 'button';
      printBatchBtn.innerHTML = `${icons.printer ? icons.printer(16) : '🖨️'}<span>Batch Preview &amp; print (${count})</span>`;
      printBatchBtn.addEventListener('click', async () => {
        printBatchBtn.disabled = true;
        const selectedReports = rows.filter((r) => selectedReportIds.has(r.reportId));
        try {
          showToast(`Preparing print package for ${selectedReports.length} reports...`, { variant: 'info' });
          const [lh, ...fullReports] = await Promise.all([
            loadLetterhead(user),
            ...selectedReports.map((r) => getAccomplishmentReport(r.reportId)),
          ]);
          const sheetsHtml = fullReports.map((rep) => {
            const entries = Array.isArray(rep.entries) ? rep.entries : [];
            const person = personName(rep);
            const totalMinutes = rep.totalMinutesConfirmed ?? entries.reduce((s, ent) => s + (Number(ent.durationMinutes) || 0), 0);
            return `<div class="acc-batch-sheet-break">${buildPrintHtml({ report: rep, entries, person, totalMinutes, lh })}</div>`;
          }).join('');

          openPrintPreviewModal({
            title: 'Batch Accomplishment Reports',
            subtitle: `${selectedReports.length} Tanod Reports`,
            sheetId: 'printable-accomplishment-report',
            sheetHtml: sheetsHtml,
          });
        } catch (err) {
          showToast(actionErrorMessage(err, 'Could not prepare batch print preview.'), { variant: 'error' });
        } finally {
          printBatchBtn.disabled = false;
        }
      });

      const clearBtn = h('button', 'ghost acc-batch-clear-btn', 'Deselect all');
      clearBtn.type = 'button';
      clearBtn.addEventListener('click', () => {
        selectedReportIds.clear();
        renderList(lastResult);
      });

      actionsWrap.append(printBatchBtn, clearBtn);
      batchBar.append(countLabel, actionsWrap);
    }

    const tableEl = DataTable({
      columns: COLUMNS,
      rows: rows,
      rowKey: (r) => r.reportId,
      caption: 'Accomplishment reports',
      emptyMessage: 'No reports on this page.',
      emptyIcon: icons.fileText,
      onRowClick: (r) => openDetail(r.reportId),
      page: res.page,
      totalItems: state.search ? rows.length : res.total,
      pageSize: PAGE_SIZE,
      onPageChange: (next) => { state.page = next; loadList(); },
      renderCell: (row, key) => {
        switch (key) {
          case 'select': {
            const wrap = h('label', 'acc-checkbox-cell');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'acc-row-checkbox';
            cb.checked = selectedReportIds.has(row.reportId);
            cb.setAttribute('aria-label', `Select report for ${personName(row)}`);
            cb.addEventListener('click', (e) => e.stopPropagation());
            cb.addEventListener('change', () => {
              if (cb.checked) selectedReportIds.add(row.reportId);
              else selectedReportIds.delete(row.reportId);
              syncHeaderCheckbox();
              syncBatchBar();
            });
            wrap.appendChild(cb);
            return wrap;
          }
          case 'person': {
            const cell = h('div', 'acc-tanod-cell');
            const avatar = h('div', 'acc-tanod-avatar');
            avatar.innerHTML = avatarInitials(personName(row), 30);
            const info = h('div', 'acc-tanod-info');
            const name = h('span', 'acc-tanod-name', personName(row));
            const pos = h('span', 'acc-tanod-pos', row.officialTitle || TANOD_POSITION);
            info.append(name, pos);
            cell.append(avatar, info);
            return cell;
          }
          case 'month': return h('span', 'acc-month-text', formatMonthLabel(row.month));
          case 'status': return statusPill(row.status);
          case 'entries': { const n = entryCountOf(row); return h('span', 'acc-num-cell', n === null ? '—' : n); }
          case 'total': return h('span', 'acc-num-cell', row.totalMinutes === undefined || row.totalMinutes === null ? '—' : formatMinutes(row.totalMinutes));
          case 'flagged': {
            const n = Number(row.flaggedEntries) || 0;
            return n > 0 
              ? h('span', 'tw-flag acc-flag-badge', `${n} to check`) 
              : h('span', 'acc-num-cell', '0');
          }
          case 'action': {
            const wrap = h('div', 'acc-row-actions');

            // Quick Print shortcut from list view
            const printBtn = h('button', 'ghost acc-row-action-btn acc-row-action-btn--icon');
            printBtn.type = 'button';
            printBtn.title = `Preview & print ${personName(row)}'s report`;
            printBtn.setAttribute('aria-label', `Preview and print report for ${personName(row)}`);
            printBtn.innerHTML = `<span aria-hidden="true">${icons.printer ? icons.printer(14) : '🖨️'}</span>`;
            printBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              printBtn.disabled = true;
              try {
                const [fullReport, lh] = await Promise.all([
                  getAccomplishmentReport(row.reportId),
                  loadLetterhead(user),
                ]);
                const entries = Array.isArray(fullReport.entries) ? fullReport.entries : [];
                const person = personName(fullReport);
                const totalMinutes = fullReport.totalMinutesConfirmed ?? entries.reduce((s, ent) => s + (Number(ent.durationMinutes) || 0), 0);

                openPrintPreviewModal({
                  title: 'Accomplishment Report',
                  subtitle: `${person} — ${formatMonthLabel(fullReport.month)}`,
                  sheetId: 'printable-accomplishment-report',
                  sheetHtml: buildPrintHtml({ report: fullReport, entries, person, totalMinutes, lh }),
                });
              } catch (err) {
                showToast(actionErrorMessage(err, 'Could not open print preview.'), { variant: 'error' });
              } finally {
                printBtn.disabled = false;
              }
            });

            // Review button
            const reviewBtn = h('button', 'ghost acc-row-action-btn acc-row-action-btn--primary');
            reviewBtn.type = 'button';
            reviewBtn.setAttribute('aria-label', `Review accomplishment report for ${personName(row)}`);
            reviewBtn.innerHTML = `<span>Review</span><span aria-hidden="true">${icons.arrowRight ? icons.arrowRight(14) : '→'}</span>`;
            reviewBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              openDetail(row.reportId);
            });

            wrap.append(printBtn, reviewBtn);
            return wrap;
          }
          default: return '';
        }
      },
    });

    // Mount select-all checkbox in header
    const firstTh = tableEl.querySelector('thead th');
    let headerCheckbox = null;
    if (firstTh) {
      firstTh.innerHTML = '';
      const thLabel = h('label', 'acc-checkbox-cell');
      headerCheckbox = document.createElement('input');
      headerCheckbox.type = 'checkbox';
      headerCheckbox.className = 'acc-select-all-checkbox';
      headerCheckbox.setAttribute('aria-label', 'Select all reports on this page');
      headerCheckbox.addEventListener('change', () => {
        const checked = headerCheckbox.checked;
        rows.forEach((r) => {
          if (checked) selectedReportIds.add(r.reportId);
          else selectedReportIds.delete(r.reportId);
        });
        tableEl.querySelectorAll('.acc-row-checkbox').forEach((cb) => { cb.checked = checked; });
        syncBatchBar();
      });
      thLabel.appendChild(headerCheckbox);
      firstTh.appendChild(thLabel);
    }

    function syncHeaderCheckbox() {
      if (!headerCheckbox) return;
      const allSelected = rows.length > 0 && rows.every((r) => selectedReportIds.has(r.reportId));
      const someSelected = rows.some((r) => selectedReportIds.has(r.reportId));
      headerCheckbox.checked = allSelected;
      headerCheckbox.indeterminate = someSelected && !allSelected;
    }

    syncHeaderCheckbox();
    syncBatchBar();

    listBody.append(tableEl, batchBar);
  }

  // ----- detail view --------------------------------------------------------

  async function openDetail(reportId) {
    listHost.hidden = true;
    detailHost.hidden = false;
    pageHeader.actions.innerHTML = '';
    await loadDetail(reportId);
  }

  async function loadDetail(reportId) {
    showLoading(detailHost, 'Loading accomplishment report');
    try {
      const [report, mine] = await Promise.all([getAccomplishmentReport(reportId), getMyAuthority(user)]);
      await ensureNames();
      renderDetail(report, mine, reportId);
    } catch (err) {
      showError(detailHost, err, () => loadDetail(reportId), 'Could not load this report.');
    }
  }

  function renderDetail(report, mine, reportId) {
    detailHost.innerHTML = '';
    const entries = Array.isArray(report.entries) ? report.entries : [];
    const person = personName(report);
    const totalMinutes = report.totalMinutesConfirmed ?? entries.reduce((s, e) => s + (Number(e.durationMinutes) || 0), 0);
    const flaggedCount = entries.filter((e) => e.durationFlag === true || e.durationFlag === 1).length;

    // Filter state for entries detail view: 'all' | 'flagged'
    let activeFilter = 'all';

    // Top action handlers
    const canReturn = report.userId !== user.userId && report.status === 'prepared'
      && (mine.authority.has('note_report') || mine.authority.has('approve_report'));

    async function handlePrint() {
      try {
        const lh = await loadLetterhead(user);
        openPrintPreviewModal({
          title: 'Accomplishment Report',
          subtitle: `${person} — ${formatMonthLabel(report.month)}`,
          sheetId: 'printable-accomplishment-report',
          sheetHtml: buildPrintHtml({ report, entries, person, totalMinutes, lh }),
        });
      } catch (err) {
        showToast(actionErrorMessage(err, 'Could not open print preview.'), { variant: 'error' });
      }
    }

    async function handleReturn() {
      const reason = await promptText({
        title: 'Return this report?',
        description: 'The tanod can edit their entries again and resubmit. Say what needs fixing.',
        label: 'Reason (shown to the tanod)',
        placeholder: 'For example: the March 12 duration looks too long.',
        confirmLabel: 'Return report',
        onConfirmAsync: async (value) => {
          const trimmed = (value || '').trim();
          if (trimmed.length < 1 || trimmed.length > 255) throw new Error('Enter a reason of 1 to 255 characters.');
          try {
            await returnAccomplishmentReport(report.reportId, trimmed);
          } catch (err) {
            throw new Error(actionErrorMessage(err, 'Could not return this report.'));
          }
        },
      });
      if (reason !== null) {
        showToast('Report returned to the tanod.', { variant: 'info' });
        loadDetail(reportId);
      }
    }

    // Top Page Header Actions: back button integrated cleanly into pageHeader.actions
    pageHeader.actions.innerHTML = '';
    const backBtn = h('button', 'ghost acc-header-back-btn');
    backBtn.type = 'button';
    backBtn.setAttribute('aria-label', 'Return to accomplishment reports list');
    backBtn.innerHTML = `<span aria-hidden="true">${icons.chevronLeft ? icons.chevronLeft(16) : '←'}</span><span>Back to reports</span>`;
    backBtn.addEventListener('click', () => { listBody = null; showList(); });
    pageHeader.actions.appendChild(backBtn);

    // =========================================================================
    // Single Unified Card (Hero Header + Actions + Guidance + KPI Grid + Table)
    // =========================================================================
    const unifiedCard = card();
    unifiedCard.classList.add('acc-unified-card');

    // 1. Officer Identity & Unified Action Cluster
    const heroHeader = h('div', 'acc-unified-hero');

    const officerIdentity = h('div', 'acc-officer-identity');
    const officerAvatar = h('div', 'acc-officer-avatar');
    officerAvatar.innerHTML = avatarInitials(person, 46);

    const officerInfo = h('div', 'acc-officer-details');
    officerInfo.innerHTML = `
      <div class="acc-officer-title-row">
        <h3 class="acc-officer-name">${escapeHtml(person)}</h3>
        <span class="acc-officer-tag">${escapeHtml(report.officialTitle || TANOD_POSITION)}</span>
      </div>
      <div class="acc-officer-meta">
        <span class="acc-meta-item">
          <span class="acc-meta-label">Month:</span>
          <strong>${escapeHtml(formatMonthLabel(report.month))}</strong>
        </span>
        ${report.preparedAt ? `
          <span class="acc-meta-dot" aria-hidden="true">·</span>
          <span class="acc-meta-item">
            <span class="acc-meta-label">Submitted:</span>
            <span>${escapeHtml(formatManilaDateTime(report.preparedAt))}</span>
          </span>` : ''}
      </div>
    `;
    officerIdentity.append(officerAvatar, officerInfo);

    // Right-aligned status pill & action controls
    const heroActions = h('div', 'acc-hero-actions');
    heroActions.appendChild(statusPill(report.status));

    if (canReturn) {
      const returnBtn = h('button', 'danger acc-action-btn acc-return-btn', 'Return to tanod');
      returnBtn.type = 'button';
      returnBtn.addEventListener('click', handleReturn);
      heroActions.appendChild(returnBtn);
    }

    if (report.status === 'prepared') {
      const printBtn = h('button', 'primary acc-action-btn acc-print-btn');
      printBtn.type = 'button';
      printBtn.innerHTML = `${icons.printer ? icons.printer(16) : '🖨️'}<span>Preview &amp; print</span>`;
      printBtn.addEventListener('click', handlePrint);
      heroActions.appendChild(printBtn);
    }

    heroHeader.append(officerIdentity, heroActions);
    unifiedCard.appendChild(heroHeader);

    // 2. Return Callout or Guidance Notice
    if (report.status === 'returned' && report.returnReason) {
      const callout = h('div', 'tw-callout tw-callout--warning acc-return-callout');
      callout.append(h('strong', '', 'Returned to the tanod: '), document.createTextNode(report.returnReason));
      unifiedCard.appendChild(callout);
    } else {
      const guidanceHint = reasonNoActions(report);
      if (guidanceHint) {
        const guidance = h('div', 'acc-guidance-banner');
        guidance.innerHTML = `
          <span class="acc-guidance-icon" aria-hidden="true">${icons.info ? icons.info(16) : 'ℹ️'}</span>
          <span class="acc-guidance-text">${escapeHtml(guidanceHint)}</span>
        `;
        unifiedCard.appendChild(guidance);
      }
    }

    // 3. Proportional 3-Column Metric KPI Grid
    const kpiGrid = h('div', 'acc-kpi-grid');

    // KPI 1: Total Logged Entries
    const kpi1 = h('div', 'card acc-kpi-card');
    kpi1.innerHTML = `
      <div class="acc-kpi-header">
        <span class="acc-kpi-label">Total Logged Entries</span>
        <span class="icon-badge icon-badge--feature acc-kpi-icon accent-blue" aria-hidden="true">${icons.fileText ? icons.fileText(18) : '📋'}</span>
      </div>
      <div class="acc-kpi-value">${entries.length}</div>
      <div class="acc-kpi-subtext">Logged shifts this month</div>
    `;

    // KPI 2: Confirmed Time
    const kpi2 = h('div', 'card acc-kpi-card');
    kpi2.innerHTML = `
      <div class="acc-kpi-header">
        <span class="acc-kpi-label">Confirmed Duty Time</span>
        <span class="icon-badge icon-badge--feature acc-kpi-icon accent-teal" aria-hidden="true">${icons.clock ? icons.clock(18) : '⏱️'}</span>
      </div>
      <div class="acc-kpi-value text-primary">${escapeHtml(formatMinutes(totalMinutes))}</div>
      <div class="acc-kpi-subtext">Accumulated verified time</div>
    `;

    // KPI 3: Verification Status
    const kpi3 = h('div', `card acc-kpi-card ${flaggedCount > 0 ? 'acc-kpi-card--warning' : 'acc-kpi-card--success'}`);
    const flagIcon = flaggedCount > 0 
      ? (icons.alertTriangle ? icons.alertTriangle(18) : '⚠️')
      : (icons.checkCircle ? icons.checkCircle(18) : '✓');
    const flagTone = flaggedCount > 0 ? 'accent-orange' : 'accent-green';
    const flagSub = flaggedCount > 0
      ? `${flaggedCount} entry differs from dispatch by &gt;30m`
      : 'All shift hours match dispatch logs';
    kpi3.innerHTML = `
      <div class="acc-kpi-header">
        <span class="acc-kpi-label">Entries to check</span>
        <span class="icon-badge icon-badge--feature acc-kpi-icon ${flagTone}" aria-hidden="true">${flagIcon}</span>
      </div>
      <div class="acc-kpi-value ${flaggedCount > 0 ? 'tone-warning' : 'tone-success'}">${flaggedCount}</div>
      <div class="acc-kpi-subtext">${flagSub}</div>
    `;

    kpiGrid.append(kpi1, kpi2, kpi3);
    unifiedCard.appendChild(kpiGrid);

    // 4. Entries Section Header with Segmented Filter Controls
    const sectionBar = h('div', 'acc-entries-section-bar');

    const titleGroup = h('div', 'acc-section-title-group');
    titleGroup.innerHTML = `
      <div class="acc-title-with-badge">
        <h4 class="acc-section-title">Report Entries</h4>
        <span class="acc-section-badge" id="acc-visible-count">${entries.length} items</span>
      </div>
      <p class="acc-section-hint">
        <span class="acc-hint-icon" aria-hidden="true">${icons.info ? icons.info(13) : 'ⓘ'}</span>
        <span>A flagged duration differs from system dispatch on-duty time by &gt;30 mins. It is a prompt to verify, not an error.</span>
      </p>
    `;

    // Segmented Filter Control
    const filterGroup = h('div', 'acc-filter-group');
    filterGroup.setAttribute('role', 'tablist');
    filterGroup.setAttribute('aria-label', 'Filter report entries');

    const allFilterBtn = h('button', 'acc-filter-tab is-active', `All Entries (${entries.length})`);
    allFilterBtn.type = 'button';
    allFilterBtn.setAttribute('role', 'tab');
    allFilterBtn.setAttribute('aria-selected', 'true');

    const flagLabel = flaggedCount > 0
      ? `Flagged to Check (${flaggedCount})`
      : 'Flagged to Check (0 ✓)';
    const flagFilterBtn = h('button', `acc-filter-tab ${flaggedCount > 0 ? 'acc-filter-tab--warning' : ''}`, flagLabel);
    flagFilterBtn.type = 'button';
    flagFilterBtn.setAttribute('role', 'tab');
    flagFilterBtn.setAttribute('aria-selected', 'false');

    filterGroup.append(allFilterBtn, flagFilterBtn);
    sectionBar.append(titleGroup, filterGroup);
    unifiedCard.appendChild(sectionBar);

    // 5. Entries Table Host
    const tableHost = h('div', 'acc-entries-table-host');
    unifiedCard.appendChild(tableHost);

    function formatDateWithWeekday(value) {
      if (!value || !/^\d{4}-\d{2}-\d{2}/.test(String(value))) return '—';
      const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-PH', {
        timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      });
    }

    function renderEntriesTable() {
      tableHost.innerHTML = '';
      const visibleEntries = activeFilter === 'flagged'
        ? entries.filter((e) => e.durationFlag === true || e.durationFlag === 1)
        : entries;

      const countBadge = unifiedCard.querySelector('#acc-visible-count');
      if (countBadge) {
        countBadge.textContent = `${visibleEntries.length} ${activeFilter === 'flagged' ? 'flagged' : 'items'}`;
      }

      if (visibleEntries.length === 0) {
        if (activeFilter === 'flagged') {
          tableHost.appendChild(h('div', 'tw-empty-note acc-empty-box', 'No flagged discrepancies found for this month. All entries align with dispatch records.'));
        } else {
          tableHost.appendChild(h('div', 'tw-empty-note acc-empty-box', 'This report has no entries yet.'));
        }
        return;
      }

      tableHost.appendChild(DataTable({
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'text', label: 'Accomplishment' },
          { key: 'time', label: 'Time' },
          { key: 'confirmed', label: 'Confirmed', align: 'right' },
          { key: 'suggested', label: 'System saw on duty', align: 'right' },
        ],
        rows: visibleEntries,
        rowKey: (e) => e.entryId,
        caption: 'Report entries',
        rowClass: (e) => (e.durationFlag === true || e.durationFlag === 1 ? 'tw-row--flagged' : undefined),
        renderCell: (e, key) => {
          switch (key) {
            case 'date': return h('span', 'acc-date-cell', formatDateWithWeekday(e.workDate));
            case 'text': return e.accomplishmentText === undefined || e.accomplishmentText === null
              ? h('span', 'tw-muted', 'Text is not shown for your role.')
              : h('span', 'tw-entry-text', e.accomplishmentText);
            case 'time': return h('span', 'acc-time-cell', e.startTime && e.endTime ? `${trimTime(e.startTime)}–${trimTime(e.endTime)}` : '—');
            case 'confirmed': return h('span', 'acc-num-cell', formatMinutes(e.durationMinutes));
            case 'suggested': {
              const wrap = h('div', 'acc-suggested-cell');
              const baseText = e.suggestedDurationMinutes === null || e.suggestedDurationMinutes === undefined
                ? '—'
                : formatMinutes(e.suggestedDurationMinutes);
              wrap.appendChild(document.createTextNode(baseText));

              if (e.durationFlag === true || e.durationFlag === 1) {
                const diffMin = (Number(e.durationMinutes) || 0) - (Number(e.suggestedDurationMinutes) || 0);
                const deltaLabel = diffMin > 0 ? `+${formatMinutes(diffMin)}` : formatMinutes(diffMin);
                const flagBadge = h('span', 'tw-flag acc-discrepancy-chip', `${deltaLabel} Check`);
                wrap.appendChild(flagBadge);
              } else if (e.suggestedDurationMinutes !== null && e.suggestedDurationMinutes !== undefined) {
                const matchPill = h('span', 'acc-match-pill', '✓ Match');
                matchPill.title = 'Confirmed time aligns with dispatch records';
                wrap.appendChild(matchPill);
              }
              return wrap;
            }
            default: return '';
          }
        },
      }));

      // Table Footer Summary Bar
      const visibleMinutes = visibleEntries.reduce((s, ent) => s + (Number(ent.durationMinutes) || 0), 0);
      const visibleFlags = visibleEntries.filter((ent) => ent.durationFlag === true || ent.durationFlag === 1).length;
      const footerBar = h('div', 'acc-table-summary-bar');
      footerBar.innerHTML = `
        <div class="acc-summary-item">
          <span class="acc-summary-label">Showing:</span>
          <strong>${visibleEntries.length} ${visibleEntries.length === 1 ? 'entry' : 'entries'}</strong>
        </div>
        <span class="acc-summary-pip" aria-hidden="true">·</span>
        <div class="acc-summary-item">
          <span class="acc-summary-label">Total Time:</span>
          <strong class="text-primary">${escapeHtml(formatMinutes(visibleMinutes))}</strong>
        </div>
        <span class="acc-summary-pip" aria-hidden="true">·</span>
        <div class="acc-summary-item">
          <span class="acc-summary-label">Status:</span>
          <span class="${visibleFlags > 0 ? 'acc-flag-badge' : 'acc-match-badge'}">
            ${visibleFlags > 0 ? `${visibleFlags} to check` : 'All dispatch verified ✓'}
          </span>
        </div>
      `;
      tableHost.appendChild(footerBar);
    }

    allFilterBtn.addEventListener('click', () => {
      activeFilter = 'all';
      allFilterBtn.classList.add('is-active');
      allFilterBtn.setAttribute('aria-selected', 'true');
      flagFilterBtn.classList.remove('is-active');
      flagFilterBtn.setAttribute('aria-selected', 'false');
      renderEntriesTable();
    });

    flagFilterBtn.addEventListener('click', () => {
      activeFilter = 'flagged';
      flagFilterBtn.classList.add('is-active');
      flagFilterBtn.setAttribute('aria-selected', 'true');
      allFilterBtn.classList.remove('is-active');
      allFilterBtn.setAttribute('aria-selected', 'false');
      renderEntriesTable();
    });

    renderEntriesTable();
    detailHost.appendChild(unifiedCard);
  }

  function reasonNoActions(report) {
    if (report.userId === user.userId) return 'You cannot return your own report.';
    if (report.status === 'open' || report.status === 'returned') return 'Waiting for the tanod to submit this report.';
    if (report.status === 'prepared') return 'Ready to print. Use Preview & print, then have it signed on paper.';
    return 'No actions are available for you on this report.';
  }

  // ----- boot ---------------------------------------------------------------

  if (initial.reportId !== undefined && initial.reportId !== null) openDetail(initial.reportId);
  else showList();
}

// ----- print layout (mirrors the barangay's own Accomplishment Report form) --

function buildPrintHtml({ report, entries, person, totalMinutes, lh }) {
  const position = report.officialTitle || TANOD_POSITION;
  const days = 31;
  const byDay = new Map();
  for (const e of entries) {
    const day = Number(String(e.workDate || '').slice(8, 10));
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const monthDays = daysInMonth(report.month);

  let rows = '';
  for (let day = 1; day <= days; day += 1) {
    const list = byDay.get(day) || [];
    const text = list.map((e) => e.accomplishmentText).filter(Boolean).join('; ');
    const time = list.map((e) => (e.startTime && e.endTime ? `${trimTime(e.startTime)}–${trimTime(e.endTime)}` : formatMinutes(e.durationMinutes))).join('; ');
    const dim = day > monthDays ? ' tw-acc-form__row--na' : '';
    rows += `<tr class="${dim.trim()}"><td class="tw-acc-form__day">${day}.</td><td>${escapeHtml(text)}</td><td class="tw-acc-form__time">${escapeHtml(time)}</td></tr>`;
  }

  const sign = (caption, name, title) => `
    <div class="tw-sign__col">
      <div class="tw-sign__cap">${escapeHtml(caption)}</div>
      <div class="tw-sign__line">${escapeHtml(name || '')}</div>
      <div class="tw-sign__pos">${escapeHtml(title || '')}</div>
    </div>`;

  return `
    <div class="tw-print tw-acc-form">
      ${letterheadHtml(lh)}
      <h4 class="tw-print__title">Accomplishment Report</h4>
      <table class="tw-acc-form__info">
        <tr>
          <td class="tw-acc-form__info-left">
            <div class="tw-acc-form__field"><span class="tw-acc-form__label">Name:</span><span class="tw-acc-form__value">${escapeHtml(person)}</span></div>
            <div class="tw-acc-form__field"><span class="tw-acc-form__label">Position:</span><span class="tw-acc-form__value">${escapeHtml(position)}</span></div>
            <div class="tw-acc-form__field"><span class="tw-acc-form__label">Month:</span><span class="tw-acc-form__value">${escapeHtml(formatMonthLabel(report.month))}</span></div>
          </td>
          <td class="tw-acc-form__info-right">Duration<br>Hours<div class="tw-acc-form__hours">${escapeHtml(minutesToHours(totalMinutes))}</div></td>
        </tr>
      </table>
      <table class="tw-acc-form__log">
        <thead><tr><th class="tw-acc-form__c-day">Day</th><th class="tw-acc-form__c-acc">Accomplishment</th><th class="tw-acc-form__c-time">Time</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="tw-sign">
        ${sign('Prepared By:', person, position)}
        ${sign('Noted By:', '', '')}
        ${sign('Approved By:', '', '')}
      </div>
      <p class="tw-print__footnote">Report status: ${escapeHtml(REPORT_STATUS_LABELS[report.status] || report.status || '')} · Printed ${escapeHtml(formatManilaDate(new Date().toISOString()))}</p>
    </div>`;
}
