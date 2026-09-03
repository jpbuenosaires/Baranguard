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
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';

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
  { key: 'id', label: 'ID', width: '4.5rem' },
  { key: 'direction', label: 'Direction', width: '7rem' },
  { key: 'type', label: 'Type', width: '9rem' },
  { key: 'transport', label: 'Transport', width: '8rem' },
  { key: 'linked', label: 'Linked to' },
  { key: 'when', label: 'Sent / Received' },
  { key: 'status', label: 'Status', align: 'right' },
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

  const filterPanel = document.createElement('div');
  filterPanel.className = 'filter-panel';

  const typeSelect = buildFilterSelect('sms-log-type', 'Message type', ['All types', ...MESSAGE_TYPES]);
  const directionSelect = buildFilterSelect('sms-log-direction', 'Direction', ['Both directions', ...DIRECTIONS]);
  const statusSelect = buildFilterSelect('sms-log-status', 'Status', ['All statuses', ...STATUSES]);
  filterPanel.append(typeSelect.fragment, directionSelect.fragment, statusSelect.fragment);
  header.appendChild(filterPanel);

  const body = document.createElement('div');
  content.appendChild(body);

  [typeSelect.select, directionSelect.select, statusSelect.select].forEach((select) => {
    select.addEventListener('change', () => load());
  });

  load();

  async function load() {
    renderLoading(body);
    try {
      const result = await getSmsLogs({
        messageType: typeSelect.select.value || undefined,
        direction: directionSelect.select.value || undefined,
        status: statusSelect.select.value || undefined,
        limit: 100,
      });
      if (result.items.length === 0) {
        renderEmpty(body);
      } else {
        renderList(body, result.items);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the SMS log.';
      renderError(body, message, load);
    }
  }
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

function renderList(container, items) {
  container.innerHTML = '';
  const table = DataTable({
    columns: COLUMNS,
    rows: items,
    rowKey: (row) => row.logId,
    caption: 'SMS activity log',
    renderCell: (row, key) => {
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
          const span = document.createElement('span');
          const cls = STATUS_PILL_CLASS[row.status] || 'status-pill--neutral';
          span.className = `status-pill ${cls}`;
          span.textContent = row.status.toUpperCase();
          if (row.failureReason) span.title = row.failureReason;
          return span;
        }
        default:
          return '';
      }
    },
  });
  container.appendChild(table);
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading SMS activity log');
  for (let i = 0; i < 6; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.style.cssText = 'height:2.75rem; border-radius:0.5rem;';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderEmpty(container) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = `
    <h3>No SMS activity yet</h3>
    <p>Inbound and outbound SMS/GSM messages will appear here as they happen.</p>
  `;
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
