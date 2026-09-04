/**
 * sms-log.js — W14 SMS Activity Log (§9): "Roles: Admin only ·
 * API: GET /sms/logs". Sprint_Prompts.md is explicit that this stays
 * READ-ONLY this sprint and every sprint after unless deliberately
 * rescoped — the Figma reference's two-way chat/reply/broadcast console
 * needs send/reply/broadcast endpoints that don't exist in §6 (see that
 * file's own "Adopted UI reference" exclusion list). This screen shows
 * exactly what `GET /sms/logs` returns and nothing else: no reply box,
 * no compose button, no "send" affordance anywhere.
 *
 * `sender_number`/`receiver_number` are deliberately never displayed —
 * they were never part of §6's documented response shape in the first
 * place (see SmsController.php's own doc), so there is nothing to mask
 * here; the row identifies a message by its correlation/gateway id and
 * incident/dispatch linkage instead.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getSmsLogs, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable, exportRowsToCsv } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { icons } from '../components/icons.js';

const PAGE_SIZE = 25;

const MESSAGE_TYPES = ['incident', 'dispatch', 'priority_alert', 'coord_ping', 'confirmation', 'duty_status', 'sos'];
const DIRECTIONS = ['inbound', 'outbound'];
const STATUSES = ['queued', 'pending', 'sent', 'failed', 'refunded', 'received', 'rejected', 'deduplicated'];

const STATUS_PILL_CLASS = {
  sent: 'status-pill--success',
  received: 'status-pill--success',
  pending: 'status-pill--info',
  queued: 'status-pill--info',
  failed: 'status-pill--critical',
  rejected: 'status-pill--critical',
  refunded: 'status-pill--pending', // §8's tinted-warning class is named --pending, not --warning.
  deduplicated: 'status-pill--neutral',
};

const COLUMNS = [
  { key: 'id', label: 'ID', width: '4.5rem', csvValue: (row) => row.logId },
  { key: 'direction', label: 'Direction', width: '7rem', csvValue: (row) => row.direction },
  { key: 'type', label: 'Type', width: '9rem', csvValue: (row) => row.messageType },
  { key: 'transport', label: 'Transport', width: '8rem', csvValue: (row) => row.transport },
  {
    key: 'linked', label: 'Linked to',
    csvValue: (row) => [
      row.incidentId ? `incident:${row.incidentId}` : null,
      row.dispatchId ? `dispatch:${row.dispatchId}` : null,
      row.reportId ? `report:${row.reportId}` : null,
    ].filter(Boolean).join(' '),
  },
  { key: 'when', label: 'Sent / Received', csvValue: (row) => row.sentAt || row.receivedAt || row.createdAt || '' },
  { key: 'status', label: 'Status', align: 'right', csvValue: (row) => row.status },
];

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderSmsLogPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'sms-log', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'SMS Activity Log',
    subtitle: 'Read-only record of every inbound and outbound SMS/GSM message',
    icon: icons.messageSquare,
  });
  header.appendChild(pageHeader.el);

  // §3.3 of the UI/UX review — exports the CURRENT page only (whatever
  // `currentPageItems` holds after the last load()), not a second
  // unfiltered fetch; see exportRowsToCsv's own doc.
  let currentPageItems = [];
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'ghost';
  exportButton.innerHTML = `<span aria-hidden="true">${icons.download(16)}</span><span>Export CSV</span>`;
  exportButton.addEventListener('click', () => exportRowsToCsv(COLUMNS, currentPageItems, 'baranguard-sms-log'));
  pageHeader.actions.appendChild(exportButton);

  // Phase 8 (mockup-driven UI round 2) — a real stat strip, four counts
  // from the SAME date-range/filter-independent totals `GET /sms/logs`
  // itself returns (each a scoped `limit=1` request, reading `.total`),
  // not a client-side tally over just the current page.
  const statStripHost = document.createElement('div');
  header.appendChild(statStripHost);

  const filterPanel = document.createElement('div');
  filterPanel.className = 'filter-panel';

  const typeSelect = buildFilterSelect('sms-log-type', 'Message type', ['All types', ...MESSAGE_TYPES]);
  const directionSelect = buildFilterSelect('sms-log-direction', 'Direction', ['Both directions', ...DIRECTIONS]);
  const statusSelect = buildFilterSelect('sms-log-status', 'Status', ['All statuses', ...STATUSES]);
  const fromLabel = document.createElement('label');
  fromLabel.className = 'sr-only';
  fromLabel.htmlFor = 'sms-log-from';
  fromLabel.textContent = 'From date';
  const fromInput = document.createElement('input');
  fromInput.id = 'sms-log-from';
  fromInput.type = 'date';
  const toLabel = document.createElement('label');
  toLabel.className = 'sr-only';
  toLabel.htmlFor = 'sms-log-to';
  toLabel.textContent = 'To date';
  const toInput = document.createElement('input');
  toInput.id = 'sms-log-to';
  toInput.type = 'date';
  filterPanel.append(
    typeSelect.fragment, directionSelect.fragment, statusSelect.fragment,
    fromLabel, fromInput, toLabel, toInput
  );
  header.appendChild(filterPanel);

  const layout = document.createElement('div');
  layout.className = 'split-panel';
  content.appendChild(layout);
  const body = document.createElement('div');
  layout.appendChild(body);
  const detailPane = document.createElement('div');
  detailPane.className = 'blotter-detail-pane';
  layout.appendChild(detailPane);
  renderDetailPlaceholder(detailPane);

  // §3.3 of the UI/UX review — real server-side pagination, unlike
  // Blotter List (which keeps its own client-side text-search-over-a-
  // fixed-fetch pattern; mixing that with real paging would make the
  // search silently incomplete). SMS Log has only server-side dropdown
  // filters, so a filter change or page change both just re-fetch — no
  // conflict.
  let currentPage = 1;
  [typeSelect.select, directionSelect.select, statusSelect.select, fromInput, toInput].forEach((el) => {
    el.addEventListener('change', () => { currentPage = 1; load(); refreshStats(); });
  });

  load();
  refreshStats();

  function activeFilters() {
    return {
      messageType: typeSelect.select.value || undefined,
      direction: directionSelect.select.value || undefined,
      status: statusSelect.select.value || undefined,
      dateFrom: fromInput.value || undefined,
      dateTo: toInput.value || undefined,
    };
  }

  async function refreshStats() {
    const base = activeFilters();
    try {
      const [total, inbound, outbound, failed] = await Promise.all([
        getSmsLogs({ ...base, limit: 1 }),
        getSmsLogs({ ...base, direction: 'inbound', limit: 1 }),
        getSmsLogs({ ...base, direction: 'outbound', limit: 1 }),
        getSmsLogs({ ...base, status: 'failed', limit: 1 }),
      ]);
      statStripHost.innerHTML = '';
      statStripHost.appendChild(StatStrip({
        items: [
          { label: 'Total', value: total.total },
          { label: 'Inbound', value: inbound.total, tone: 'info' },
          { label: 'Outbound', value: outbound.total, tone: 'info' },
          { label: 'Failed', value: failed.total, tone: failed.total > 0 ? 'critical' : 'default' },
        ],
      }));
    } catch {
      // The stat strip is a summary convenience; a failed fetch just
      // leaves whatever was there before (or nothing, on first load).
    }
  }

  async function load() {
    renderLoading(body);
    try {
      const result = await getSmsLogs({ ...activeFilters(), page: currentPage, limit: PAGE_SIZE });
      currentPageItems = result.items;
      renderList(body, result.items, result.total, (nextPage) => {
        currentPage = nextPage;
        load();
      });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the SMS log.';
      renderError(body, message, load);
    }
  }

  let selectedLogId = null;

  function renderList(container, items, totalItems, onPageChange) {
    container.innerHTML = '';
    const table = DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.logId,
      selectedKey: selectedLogId,
      onRowClick: (row) => { selectedLogId = row.logId; renderRowDetail(detailPane, row); },
      caption: 'SMS activity log',
      emptyIcon: icons.messageSquare,
      emptyMessage: 'No SMS activity matches these filters yet.',
      page: currentPage,
      totalItems,
      pageSize: PAGE_SIZE,
      onPageChange,
      renderCell: renderSmsLogCell,
    });
    container.appendChild(table);
  }
}

function renderDetailPlaceholder(pane) {
  pane.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card state-block';
  card.innerHTML = '<h3>Select a message</h3><p>Choose a row to see its correlation and gateway identifiers.</p>';
  pane.appendChild(card);
}

/** The "expandable row detail" Phase 8 asked for — correlation/gateway/modem ids, not shown in the compact table row. */
function renderRowDetail(pane, row) {
  pane.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  const heading = document.createElement('h3');
  heading.textContent = `Message #${row.logId}`;
  card.appendChild(heading);

  const fields = document.createElement('dl');
  fields.className = 'detail-fields';
  const addField = (label, value) => {
    if (value === null || value === undefined) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    fields.append(dt, dd);
  };
  addField('Correlation ID', row.correlationId);
  addField('Gateway message ID', row.gatewayMessageId);
  addField('Modem message ID', row.modemMessageId);
  addField('Incident', row.incidentId ? `#${row.incidentId}` : null);
  addField('Dispatch', row.dispatchId ? `#${row.dispatchId}` : null);
  addField('Citizen report', row.reportId ? `#${row.reportId}` : null);
  addField('Sent', row.sentAt ? new Date(row.sentAt).toLocaleString() : null);
  addField('Received', row.receivedAt ? new Date(row.receivedAt).toLocaleString() : null);
  addField('Logged', new Date(row.createdAt).toLocaleString());
  if (fields.children.length === 0) {
    const none = document.createElement('p');
    none.className = 'note';
    none.textContent = 'No correlation or gateway identifiers recorded for this message.';
    card.appendChild(none);
  } else {
    card.appendChild(fields);
  }

  if (row.failureReason) {
    const failure = document.createElement('p');
    failure.className = 'note';
    failure.textContent = `Failure reason: ${row.failureReason}`;
    card.appendChild(failure);
  }

  pane.appendChild(card);
}

function buildFilterSelect(id, srLabel, optionLabels) {
  // .filter-panel select is already styled directly (AppShell.css) — no
  // wrapper element needed, unlike .filter-panel__search's icon+input pair.
  const fragment = document.createDocumentFragment();
  const label = document.createElement('label');
  label.className = 'sr-only';
  label.htmlFor = id;
  label.textContent = srLabel;
  const select = document.createElement('select');
  select.id = id;
  optionLabels.forEach((text, i) => {
    const option = document.createElement('option');
    option.value = i === 0 ? '' : text;
    option.textContent = i === 0 ? text : text.replace(/_/g, ' ');
    select.appendChild(option);
  });
  fragment.append(label, select);
  return { fragment, select };
}

function renderSmsLogCell(row, key) {
  switch (key) {
    case 'id':
      return `#${row.logId}`;
    case 'direction': {
      const span = document.createElement('span');
      span.className = 'data-table__sub';
      span.innerHTML = (row.direction === 'inbound' ? icons.arrowDownLeft(14) : icons.arrowUpRight(14));
      span.append(' ' + (row.direction === 'inbound' ? 'Inbound' : 'Outbound'));
      return span;
    }
    case 'type': {
      const span = document.createElement('span');
      span.textContent = row.messageType.replace(/_/g, ' ');
      return span;
    }
    case 'transport': {
      const span = document.createElement('span');
      span.textContent = row.transport === 'gsm_modem' ? 'GSM modem' : 'Semaphore';
      return span;
    }
    case 'linked': {
      const span = document.createElement('span');
      span.className = 'data-table__sub';
      const parts = [];
      if (row.incidentId) parts.push(`Incident #${row.incidentId}`);
      if (row.dispatchId) parts.push(`Dispatch #${row.dispatchId}`);
      if (row.reportId) parts.push(`Report #${row.reportId}`);
      span.textContent = parts.length ? parts.join(' · ') : '—';
      return span;
    }
    case 'when': {
      const at = row.sentAt || row.receivedAt || row.createdAt;
      return at ? new Date(at).toLocaleString() : '—';
    }
    case 'status': {
      const wrap = document.createElement('span');
      wrap.className = 'data-table__stacked';
      const pill = document.createElement('span');
      const cls = STATUS_PILL_CLASS[row.status] || 'status-pill--neutral';
      pill.className = `status-pill ${cls}`;
      pill.textContent = row.status.toUpperCase();
      wrap.appendChild(pill);
      // Phase 8: failure_reason surfaced inline, not just in a hover title
      // — a title is invisible on touch and to anyone not hovering.
      if (row.failureReason) {
        const reason = document.createElement('span');
        reason.className = 'data-table__sub';
        reason.textContent = row.failureReason;
        wrap.appendChild(reason);
      }
      return wrap;
    }
    default:
      return '';
  }
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading SMS activity log');
  for (let i = 0; i < 6; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--row';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
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
