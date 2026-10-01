/**
 * accomplishment-reports.js — monthly Accomplishment Reports for Barangay
 * Tanods (contract §4 / §10): list by person, month and status; a detail
 * view with every entry (system-flagged durations marked); note / approve /
 * return actions for officials who hold the authority; and a print layout
 * that mirrors the barangay's own form (letterhead, name / position /
 * month / duration, 31 day rows, Prepared / Noted / Approved By).
 *
 * Gating, all UX only (REFERENCE.md §2 Rule 2 — the server re-checks):
 *   - Note ........ status prepared, viewer holds note_report
 *   - Approve ..... status noted, viewer holds approve_report
 *   - Return ...... status prepared or noted, viewer holds either
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
import { StatStrip } from '../components/StatStrip.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog, promptText } from '../components/ConfirmDialog.js';
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';
import { icons } from '../components/icons.js';
import {
  getAccomplishmentReports, getAccomplishmentReport, noteAccomplishmentReport,
  approveAccomplishmentReport, returnAccomplishmentReport, getUserNames, getUserById,
  REPORT_STATUS_LABELS,
} from '../services/tanodWorkflowApi.js';
import {
  h, escapeHtml, mountPageFrame, showLoading, showError, showEmpty, card, selectOf,
  getMyAuthority, statusPill, formatMonthLabel, formatMinutes, minutesToHours, formatManilaDate,
  formatManilaDateTime, formatDateOnly, trimTime, daysInMonth, actionErrorMessage,
  loadLetterhead, letterheadHtml,
} from '../services/tanodWorkflowUi.js';

const PAGE_SIZE = 25;
const STATUS_FILTERS = ['', 'open', 'prepared', 'noted', 'approved', 'returned'];
const TANOD_POSITION = 'Barangay Tanod'; // fallback when the user record carries no official_title

const COLUMNS = [
  { key: 'person', label: 'Tanod' },
  { key: 'month', label: 'Month' },
  { key: 'status', label: 'Status' },
  { key: 'entries', label: 'Entries', align: 'right' },
  { key: 'total', label: 'Total time', align: 'right' },
  { key: 'flagged', label: 'Flagged', align: 'right' },
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
    subtitle: 'Monthly reports by Barangay Tanods — review, note, approve or return',
    icon: icons.fileText,
  });

  const state = {
    month: typeof initial.month === 'string' ? initial.month : '',
    status: STATUS_FILTERS.includes(initial.status) ? initial.status : '',
    page: 1,
    names: null,
  };

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
    const bar = h('div', 'tw-filter-bar');

    const monthWrap = h('div', 'form-stack tw-field');
    const monthLabel = h('label', 'label', 'Month');
    monthLabel.htmlFor = 'tw-acc-month';
    const month = document.createElement('input');
    month.type = 'month';
    month.id = 'tw-acc-month';
    month.value = state.month;
    month.addEventListener('change', () => { state.month = month.value; state.page = 1; onChange(); });
    monthWrap.append(monthLabel, month);

    const statusWrap = h('div', 'form-stack tw-field');
    const statusLabel = h('label', 'label', 'Status');
    statusLabel.htmlFor = 'tw-acc-status';
    const status = selectOf(
      STATUS_FILTERS.map((s) => ({ value: s, label: s ? REPORT_STATUS_LABELS[s] : 'All statuses' })),
      { value: state.status },
    );
    status.id = 'tw-acc-status';
    status.addEventListener('change', () => { state.status = status.value; state.page = 1; onChange(); });
    statusWrap.append(statusLabel, status);

    const clear = h('button', 'ghost', 'Clear filters');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      state.month = ''; state.status = ''; state.page = 1;
      month.value = ''; status.value = '';
      onChange();
    });

    bar.append(monthWrap, statusWrap, clear);
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
      listHost.appendChild(buildFilters(loadList));
      listBody = h('div', 'tw-reports-list__body');
      listHost.appendChild(listBody);
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
      renderList(res);
    } catch (err) {
      showError(listBody, err, loadList, 'Could not load accomplishment reports.');
    }
  }

  function renderList(res) {
    listBody.innerHTML = '';
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
    const flaggedOnPage = res.items.reduce((sum, r) => sum + (Number(r.flaggedEntries) || 0), 0);
    listBody.appendChild(StatStrip({
      items: [
        { label: 'Reports matching filters', value: res.total },
        { label: 'Flagged entries on this page', value: flaggedOnPage, tone: flaggedOnPage > 0 ? 'warning' : 'default' },
      ],
    }));
    listBody.appendChild(DataTable({
      columns: COLUMNS,
      rows: res.items,
      rowKey: (r) => r.reportId,
      caption: 'Accomplishment reports',
      emptyMessage: 'No reports on this page.',
      emptyIcon: icons.fileText,
      onRowClick: (r) => openDetail(r.reportId),
      page: res.page,
      totalItems: res.total,
      pageSize: PAGE_SIZE,
      onPageChange: (next) => { state.page = next; loadList(); },
      renderCell: (row, key) => {
        switch (key) {
          case 'person': return h('span', '', personName(row));
          case 'month': return h('span', '', formatMonthLabel(row.month));
          case 'status': return statusPill(row.status);
          case 'entries': { const n = entryCountOf(row); return h('span', '', n === null ? '—' : n); }
          case 'total': return h('span', '', row.totalMinutes === undefined || row.totalMinutes === null ? '—' : formatMinutes(row.totalMinutes));
          case 'flagged': {
            const n = Number(row.flaggedEntries) || 0;
            return n > 0 ? h('span', 'tw-flag', `${n} to check`) : h('span', '', '0');
          }
          default: return '';
        }
      },
    }));
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
      const signatories = await resolveSignatories(report, mine);
      renderDetail(report, mine, signatories, reportId);
    } catch (err) {
      showError(detailHost, err, () => loadDetail(reportId), 'Could not load this report.');
    }
  }

  /** Name + official title for whoever noted / approved, for the printed signature block. */
  async function resolveSignatories(report, mine) {
    const one = async (id, name, title) => {
      if (!id) return { name: '', title: '' };
      if (name) return { name, title: title || '' };
      if (id === user.userId) return { name: user.fullName, title: mine.officialTitle || '' };
      try {
        const u = await getUserById(id);
        return { name: u.fullName, title: u.officialTitle || '' };
      } catch {
        return { name: state.names?.get(id) || '', title: '' };
      }
    };
    const [noted, approved] = await Promise.all([
      one(report.notedBy, report.notedByName, report.notedByTitle),
      one(report.approvedBy, report.approvedByName, report.approvedByTitle),
    ]);
    return { noted, approved };
  }

  function renderDetail(report, mine, signatories, reportId) {
    detailHost.innerHTML = '';
    const entries = Array.isArray(report.entries) ? report.entries : [];
    const person = personName(report);
    const totalMinutes = report.totalMinutesConfirmed ?? entries.reduce((s, e) => s + (Number(e.durationMinutes) || 0), 0);
    const flagged = entries.filter((e) => e.durationFlag === true || e.durationFlag === 1).length;

    const back = h('button', 'ghost', 'Back to reports');
    back.type = 'button';
    back.addEventListener('click', () => { listBody = null; showList(); });

    const printBtn = h('button', 'ghost');
    printBtn.type = 'button';
    printBtn.innerHTML = `${icons.printer(16)}<span>Preview &amp; print</span>`;
    printBtn.addEventListener('click', async () => {
      printBtn.disabled = true;
      try {
        const lh = await loadLetterhead(user);
        openPrintPreviewModal({
          title: 'Accomplishment Report',
          subtitle: `${person} — ${formatMonthLabel(report.month)}`,
          sheetId: 'printable-accomplishment-report',
          sheetHtml: buildPrintHtml({ report, entries, person, totalMinutes, signatories, lh }),
        });
      } finally {
        printBtn.disabled = false;
      }
    });
    pageHeader.actions.innerHTML = '';
    pageHeader.actions.appendChild(printBtn);

    // header card
    const head = card();
    head.classList.add('tw-detail-head');
    const titleRow = h('div', 'tw-detail-head__row');
    const titles = h('div');
    titles.append(
      h('h3', 'tw-card__title', person),
      h('p', 'tw-card__subtitle', `${report.officialTitle || TANOD_POSITION} · ${formatMonthLabel(report.month)}`),
    );
    titleRow.append(titles, statusPill(report.status));
    head.appendChild(titleRow);
    head.appendChild(StatStrip({
      items: [
        { label: 'Entries', value: entries.length },
        { label: 'Confirmed time', value: formatMinutes(totalMinutes) },
        { label: 'Entries to check', value: flagged, tone: flagged > 0 ? 'warning' : 'default' },
      ],
    }));

    const trail = h('ul', 'tw-trail');
    const addTrail = (label, value) => {
      const li = h('li', 'tw-trail__item');
      li.append(h('span', 'tw-trail__label', label), h('span', 'tw-trail__value', value));
      trail.appendChild(li);
    };
    if (report.preparedAt) addTrail('Submitted by tanod', formatManilaDateTime(report.preparedAt));
    if (report.notedAt) addTrail(`Noted${signatories.noted.name ? ` by ${signatories.noted.name}` : ''}`, formatManilaDateTime(report.notedAt));
    if (report.approvedAt) addTrail(`Approved${signatories.approved.name ? ` by ${signatories.approved.name}` : ''}`, formatManilaDateTime(report.approvedAt));
    if (trail.children.length) head.appendChild(trail);

    if (report.status === 'returned' && report.returnReason) {
      const callout = h('div', 'tw-callout tw-callout--warning');
      callout.append(h('strong', '', 'Returned to the tanod: '), document.createTextNode(report.returnReason));
      head.appendChild(callout);
    }
    detailHost.append(back, head);

    // entries
    const entriesCard = card('Entries', flagged > 0
      ? 'A flagged duration differs from the on-duty time the system recorded by more than 30 minutes. It is a prompt to ask, not an error.'
      : 'Confirmed by the tanod, alongside the on-duty time the system recorded for that day.');
    if (entries.length === 0) {
      entriesCard.appendChild(h('p', 'tw-empty-note', 'This report has no entries yet.'));
    } else {
      entriesCard.appendChild(DataTable({
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'text', label: 'Accomplishment' },
          { key: 'time', label: 'Time' },
          { key: 'confirmed', label: 'Confirmed', align: 'right' },
          { key: 'suggested', label: 'System saw on duty', align: 'right' },
        ],
        rows: entries,
        rowKey: (e) => e.entryId,
        caption: 'Report entries',
        rowClass: (e) => (e.durationFlag === true || e.durationFlag === 1 ? 'tw-row--flagged' : undefined),
        renderCell: (e, key) => {
          switch (key) {
            case 'date': return h('span', '', formatDateOnly(e.workDate));
            case 'text': return e.accomplishmentText === undefined || e.accomplishmentText === null
              ? h('span', 'tw-muted', 'Text is not shown for your role.')
              : h('span', 'tw-entry-text', e.accomplishmentText);
            case 'time': return h('span', '', e.startTime && e.endTime ? `${trimTime(e.startTime)}–${trimTime(e.endTime)}` : '—');
            case 'confirmed': return h('span', '', formatMinutes(e.durationMinutes));
            case 'suggested': {
              const wrap = h('span');
              wrap.appendChild(document.createTextNode(e.suggestedDurationMinutes === null || e.suggestedDurationMinutes === undefined ? '—' : formatMinutes(e.suggestedDurationMinutes)));
              if (e.durationFlag === true || e.durationFlag === 1) wrap.appendChild(h('span', 'tw-flag', 'Check'));
              return wrap;
            }
            default: return '';
          }
        },
      }));
    }
    detailHost.appendChild(entriesCard);

    // actions
    const actions = buildActions({ report, mine, reportId });
    if (actions) detailHost.appendChild(actions);
  }

  function buildActions({ report, mine, reportId }) {
    const own = report.userId === user.userId;
    const canNote = !own && report.status === 'prepared' && mine.authority.has('note_report');
    const canApprove = !own && report.status === 'noted' && mine.authority.has('approve_report');
    const canReturn = !own && (report.status === 'prepared' || report.status === 'noted')
      && (mine.authority.has('note_report') || mine.authority.has('approve_report'));

    const wrap = card('Actions');
    if (mine.failed) {
      wrap.appendChild(h('p', 'tw-empty-note', 'Could not check your approval authority, so no actions are offered. Reload to try again.'));
      return wrap;
    }
    if (!canNote && !canApprove && !canReturn) {
      wrap.appendChild(h('p', 'tw-empty-note', reasonNoActions(report, mine)));
      return wrap;
    }
    const bar = h('div', 'tw-action-bar');

    if (canNote) {
      const btn = h('button', 'primary', 'Note this report');
      btn.type = 'button';
      btn.addEventListener('click', () => runDecision({
        title: 'Note this report?',
        description: 'Noting confirms you have reviewed it. It then goes on for approval.',
        confirmLabel: 'Note report',
        call: () => noteAccomplishmentReport(report.reportId),
        success: 'Report noted.',
        reportId,
      }));
      bar.appendChild(btn);
    }
    if (canApprove) {
      const btn = h('button', 'primary', 'Approve this report');
      btn.type = 'button';
      btn.addEventListener('click', () => runDecision({
        title: 'Approve this report?',
        description: 'Approval is final. The signed printout can be filed afterwards.',
        confirmLabel: 'Approve report',
        call: () => approveAccomplishmentReport(report.reportId),
        success: 'Report approved.',
        reportId,
      }));
      bar.appendChild(btn);
    }
    if (canReturn) {
      const btn = h('button', 'danger', 'Return to tanod');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
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
      });
      bar.appendChild(btn);
    }
    wrap.appendChild(bar);
    return wrap;
  }

  function reasonNoActions(report, mine) {
    if (report.userId === user.userId) return 'You cannot note or approve your own report.';
    if (report.status === 'approved') return 'This report is approved. Nothing further to do.';
    if (report.status === 'open' || report.status === 'returned') return 'Waiting for the tanod to submit this report.';
    if (report.status === 'prepared') return 'This report is waiting to be noted by an official with the note authority.';
    if (report.status === 'noted') return 'This report is waiting for an official with the approve authority.';
    return 'No actions are available for you on this report.';
  }

  async function runDecision({ title, description, confirmLabel, call, success, reportId }) {
    const ok = await confirmDialog({
      title, description, confirmLabel,
      onConfirmAsync: async () => {
        try {
          await call();
        } catch (err) {
          // Thrown inside the dialog's async hook => shown inline, dialog stays open.
          throw new Error(actionErrorMessage(err));
        }
      },
    });
    if (ok) {
      showToast(success, { variant: 'success' });
      loadDetail(reportId);
    }
  }

  // ----- boot ---------------------------------------------------------------

  if (initial.reportId !== undefined && initial.reportId !== null) openDetail(initial.reportId);
  else showList();
}

// ----- print layout (mirrors the barangay's own Accomplishment Report form) --

function buildPrintHtml({ report, entries, person, totalMinutes, signatories, lh }) {
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

  const sign = (caption, name, title, underline) => `
    <div class="tw-sign__col">
      <div class="tw-sign__cap">${escapeHtml(caption)}</div>
      <div class="${underline ? 'tw-sign__name' : 'tw-sign__line'}">${escapeHtml(name || '')}</div>
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
        ${sign('Prepared By:', person, position, false)}
        ${sign('Noted By:', signatories.noted.name, signatories.noted.title, true)}
        ${sign('Approved By:', signatories.approved.name, signatories.approved.title, true)}
      </div>
      <p class="tw-print__footnote">Approval status at printing: ${escapeHtml(REPORT_STATUS_LABELS[report.status] || report.status || '')} · Printed ${escapeHtml(formatManilaDate(new Date().toISOString()))}</p>
    </div>`;
}
