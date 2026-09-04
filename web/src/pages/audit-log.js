/**
 * audit-log.js — W17 Audit Log Viewer (§9): "Roles: Admin only ·
 * API: GET /audit-log · Last 7 days default, paginated, no edit/delete
 * controls."
 *
 * "No edit/delete controls" is the defining constraint of this screen,
 * not a detail: §5 makes `audit_log` write-once except controlled
 * retention deletion, and the whole value of an audit trail is that the
 * people it records cannot curate it. So this screen renders rows and
 * nothing else — no row actions, no bulk selection, no delete, and the
 * server offers no endpoint that would let one exist.
 *
 * The 7-day default is applied SERVER-SIDE (see AuditLogController), so
 * an empty date range here means "the documented default view", not
 * "everything ever".
 *
 * kebab-case filename per §4.
 */

import { getAuditLog, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';

const PAGE_SIZE = 25;

// Rule 17's action list, grouped for the filter dropdown. These are
// DISPLAY labels over the real `action` strings this codebase writes —
// the server does not validate against a fixed list (see
// AuditLogController's own note on why), so an action added later still
// shows up in the table even before it appears here.
const ACTION_LABELS = {
  login_success: 'Login — success',
  login_failure: 'Login — failure',
  logout: 'Logout',
  password_changed: 'Password changed',
  user_updated: 'User updated',
  dispatch_created: 'Dispatch created',
  dispatch_cancelled: 'Dispatch cancelled',
  dispatch_status_override: 'Dispatch status override',
  incident_resolved: 'Incident resolved',
  shift_created: 'Shift created',
  shift_updated: 'Shift updated',
  swap_request_resolved: 'Swap decision',
  fatigue_flag_acknowledged: 'Fatigue flag acknowledged',
  ai_redaction_queued: 'AI redaction queued',
  ai_redaction_approved: 'AI redaction approved',
  ai_summary_regeneration_queued: 'AI summary rerun',
  ai_translation_queued: 'AI translation queued',
  blotter_finalized: 'Blotter finalized',
  blotter_amended: 'Blotter amended',
  lupon_packet_generated: 'Lupon packet generated',
  tanod_sos_raised: 'SOS raised',
  tanod_sos_acknowledged: 'SOS acknowledged',
  tanod_sos_resolved: 'SOS resolved',
  device_registered: 'Device registered',
  device_deactivated: 'Device deactivated',
  duty_status_changed: 'Duty status changed',
  map_package_published: 'Map package published',
  citizen_report_submitted: 'Citizen report submitted',
  report_exported: 'Report exported',
};

const COLUMNS = [
  { key: 'when', label: 'When', width: '12rem' },
  { key: 'actor', label: 'Actor' },
  { key: 'action', label: 'Action' },
  { key: 'entity', label: 'Entity' },
  { key: 'metadata', label: 'Details' },
];

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
export function renderAuditLogPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'audit-log', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'Audit Log',
    subtitle: 'Read-only record of administrative actions — last 7 days by default',
    icon: icons.fileText,
  });
  header.appendChild(pageHeader.el);

  const filterPanel = document.createElement('div');
  filterPanel.className = 'filter-panel';

  const actionLabel = document.createElement('label');
  actionLabel.className = 'sr-only';
  actionLabel.htmlFor = 'audit-action';
  actionLabel.textContent = 'Filter by action';
  const actionSelect = document.createElement('select');
  actionSelect.id = 'audit-action';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All actions';
  actionSelect.appendChild(allOption);
  for (const [value, label] of Object.entries(ACTION_LABELS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    actionSelect.appendChild(option);
  }

  const fromLabel = document.createElement('label');
  fromLabel.className = 'sr-only';
  fromLabel.htmlFor = 'audit-from';
  fromLabel.textContent = 'From date';
  const fromInput = document.createElement('input');
  fromInput.id = 'audit-from';
  fromInput.type = 'date';

  const toLabel = document.createElement('label');
  toLabel.className = 'sr-only';
  toLabel.htmlFor = 'audit-to';
  toLabel.textContent = 'To date';
  const toInput = document.createElement('input');
  toInput.id = 'audit-to';
  toInput.type = 'date';

  filterPanel.append(actionLabel, actionSelect, fromLabel, fromInput, toLabel, toInput);
  header.appendChild(filterPanel);

  // Said plainly on the screen rather than left for someone to discover:
  // this is a view, and there is deliberately nothing here to click that
  // would change a row.
  const readOnlyNote = document.createElement('p');
  readOnlyNote.className = 'note';
  readOnlyNote.textContent =
    'Audit entries are write-once. They cannot be edited or deleted from this screen, or from any endpoint — '
    + 'the only path that removes one is the scheduled retention job, after 7 years.';

  const body = document.createElement('div');
  content.append(readOnlyNote, body);

  let currentPage = 1;
  [actionSelect, fromInput, toInput].forEach((el) => {
    el.addEventListener('change', () => { currentPage = 1; load(); });
  });

  load();

  async function load() {
    renderLoading(body);
    try {
      const result = await getAuditLog({
        action: actionSelect.value || undefined,
        dateFrom: fromInput.value || undefined,
        dateTo: toInput.value || undefined,
        page: currentPage,
        limit: PAGE_SIZE,
      });
      renderList(result.items, result.total);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the audit log.';
      renderError(body, message, load);
    }
  }

  function renderList(items, totalItems) {
    body.innerHTML = '';
    body.appendChild(DataTable({
      columns: COLUMNS,
      rows: items,
      rowKey: (row) => row.auditId,
      caption: 'Audit log entries',
      emptyIcon: icons.fileText,
      emptyMessage: 'No audit entries in this range.',
      page: currentPage,
      totalItems,
      pageSize: PAGE_SIZE,
      onPageChange: (nextPage) => { currentPage = nextPage; load(); },
      renderCell: renderAuditCell,
    }));
  }
}

function renderAuditCell(row, key) {
  switch (key) {
    case 'when':
      return new Date(row.createdAt).toLocaleString();
    case 'actor': {
      const wrap = document.createElement('span');
      // A system action (retention jobs) legitimately has no actor —
      // saying so beats rendering a blank cell or inventing a name.
      if (row.actorUserId === null) {
        wrap.className = 'data-table__sub';
        wrap.textContent = 'System';
        return wrap;
      }
      wrap.className = 'data-table__stacked';
      const name = document.createElement('span');
      name.textContent = row.actorUsername || `User #${row.actorUserId}`;
      const id = document.createElement('span');
      id.className = 'data-table__sub';
      id.textContent = `#${row.actorUserId}`;
      wrap.append(name, id);
      return wrap;
    }
    case 'action': {
      const span = document.createElement('span');
      // Unknown actions fall back to the raw string rather than being
      // hidden — a new auditable action must never be invisible here
      // just because this map hasn't caught up.
      span.textContent = ACTION_LABELS[row.action] || row.action.replace(/_/g, ' ');
      return span;
    }
    case 'entity':
      return row.entityId !== null ? `${row.entityType} #${row.entityId}` : row.entityType;
    case 'metadata': {
      const span = document.createElement('span');
      span.className = 'data-table__sub';
      if (!row.metadataJson || Object.keys(row.metadataJson).length === 0) {
        span.textContent = '—';
        return span;
      }
      // textContent, never innerHTML: metadata is server data and this
      // screen must not become a way to render markup from a stored row.
      span.textContent = Object.entries(row.metadataJson)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ');
      return span;
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
  wrap.setAttribute('aria-label', 'Loading audit log');
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
