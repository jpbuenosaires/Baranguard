/**
 * swap-requests.js — W12 Shift Swap Requests (§9): "Approvals occur
 * transactionally and revalidate current users, assignment, time
 * overlap, and fatigue. Open approved requests explicitly show
 * 'unassigned — Admin action required.'" Roles: Admin only.
 *
 * Tanod-side request creation isn't reachable from this web app (Tanod
 * has no built web screen — mobile only, unbuilt until Sprint 2+); this
 * page is the Admin approve/deny side only, matching what §7 actually
 * grants a web Admin session.
 *
 * 2026-09-02: migrated header to PageHeader and the stacked-card list to
 * the shared DataTable component (Figma-alignment pass).
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getShiftSwapRequests, getShifts, getUsers, resolveShiftSwapRequest, ApiClientError } from '../api/apiClient.js';
import { DataTable } from '../components/DataTable.js';
import { avatarInitials } from '../components/Avatar.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';

const STATUS_PILL_CLASS = { pending: 'status-pill--pending', approved: 'status-pill--success', denied: 'status-pill--neutral' };

const COLUMNS = [
  { key: 'requester', label: 'Requester' },
  { key: 'shift', label: 'Shift' },
  { key: 'target', label: 'Target' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: 'Actions', align: 'right' },
];

/**
 * Personnel > Swap requests tab. Was the standalone W12 Shift Swap
 * Requests page (`renderSwapRequestsPage`) before the 2026-09-05
 * Personnel merge — see `pages/personnel.js` for the shared AppShell/
 * PageHeader/tab shell, and for the badge-count refresh this used to get
 * from `shell.refreshNavCounts`.
 *
 * @param {HTMLElement} container tab body to render into
 * @param {{fullName:string, role:string}} user
 * @param {() => void} [onCountsChanged] re-fetches this tab's own badge count after an approve/deny
 */
export function renderSwapRequestsTab(container, user, onCountsChanged) {
  const body = document.createElement('div');
  container.appendChild(body);

  // audit A16: keep the tab's own badge count in step with this screen
  // instead of waiting out the 60-second poll.
  const onChanged = () => { load(); onCountsChanged?.(); };

  load();

  async function load() {
    renderLoading(body);
    try {
      const [requestsRes, shiftsRes, tanodsRes] = await Promise.all([
        getShiftSwapRequests({ limit: 100 }),
        getShifts({ limit: 100 }),
        getUsers({ role: 'tanod', limit: 100 }),
      ]);
      const shiftsById = new Map(shiftsRes.items.map((s) => [s.shiftId, s]));
      const namesById = new Map(tanodsRes.items.map((t) => [t.userId, t.fullName]));
      if (requestsRes.items.length === 0) {
        renderEmpty(body);
      } else {
        renderList(body, requestsRes.items, shiftsById, namesById, onChanged);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading swap requests.';
      renderError(body, message, load);
    }
  }
}

function renderList(container, requests, shiftsById, namesById, onChanged) {
  container.innerHTML = '';
  const table = DataTable({
    columns: COLUMNS,
    rows: requests,
    rowKey: (req) => req.requestId,
    caption: 'Shift swap requests',
    renderCell: (req, key) => {
      const shift = shiftsById.get(req.shiftId);
      const requesterName = namesById.get(req.requestingUserId) || `Tanod #${req.requestingUserId}`;
      const targetName = req.targetUserId !== null ? (namesById.get(req.targetUserId) || `Tanod #${req.targetUserId}`) : null;

      switch (key) {
        case 'requester': {
          const span = document.createElement('span');
          span.className = 'avatar-row';
          span.innerHTML = `${avatarInitials(requesterName, 24)}${escapeHtml(requesterName)}`;
          return span;
        }
        case 'shift':
          return shift
            ? `${shift.patrolZone ? escapeHtml(shift.patrolZone) + ' · ' : ''}${new Date(shift.startAt).toLocaleString()} – ${new Date(shift.endAt).toLocaleString()}`
            : `Shift #${req.shiftId}`;
        case 'target': {
          const wrap = document.createElement('div');
          const line = document.createElement('div');
          line.textContent = targetName ? `Swap with ${targetName}` : 'Any eligible Tanod';
          wrap.appendChild(line);
          if (req.reason) {
            const reason = document.createElement('div');
            reason.className = 'data-table__sub';
            reason.textContent = req.reason;
            wrap.appendChild(reason);
          }
          return wrap;
        }
        case 'status': {
          const wrap = document.createElement('div');
          const pillClass = STATUS_PILL_CLASS[req.status] || 'status-pill--neutral';
          const pill = document.createElement('span');
          pill.className = `status-pill ${pillClass}`;
          pill.textContent = req.status;
          wrap.appendChild(pill);
          if (req.status === 'approved' && req.targetUserId === null) {
            const note = document.createElement('div');
            note.className = 'data-table__sub';
            note.textContent = 'Unassigned — Admin action required';
            wrap.appendChild(note);
          }
          return wrap;
        }
        case 'actions':
          return req.status === 'pending' ? renderActionsCell(req, requesterName, shift, onChanged) : '';
        default:
          return '';
      }
    },
  });
  container.appendChild(table);
}

function renderActionsCell(req, requesterName, shift, onChanged) {
  const wrap = document.createElement('span');
  wrap.className = 'data-table__actions';

  const approveButton = document.createElement('button');
  approveButton.className = 'primary';
  approveButton.textContent = 'Approve';
  const denyButton = document.createElement('button');
  denyButton.className = 'danger';
  denyButton.textContent = 'Deny';

  const shiftDescription = shift
    ? `${new Date(shift.startAt).toLocaleString()} – ${new Date(shift.endAt).toLocaleString()}`
    : `Shift #${req.shiftId}`;

  const resolve = async (status, button, event) => {
    event.stopPropagation();
    const confirmed = await confirmDialog({
      title: status === 'approved' ? 'Approve this swap request?' : 'Deny this swap request?',
      description: `${requesterName} — ${shiftDescription}`,
      confirmLabel: status === 'approved' ? 'Approve' : 'Deny',
      cancelLabel: 'Cancel',
      danger: status === 'denied',
    });
    if (!confirmed) return;
    approveButton.disabled = true;
    denyButton.disabled = true;
    button.textContent = status === 'approved' ? 'Approving…' : 'Denying…';
    try {
      await resolveShiftSwapRequest(req.requestId, status, req.version);
      onChanged();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not resolve this request.';
      showToast(message, { variant: 'error' });
      approveButton.disabled = false;
      denyButton.disabled = false;
      approveButton.textContent = 'Approve';
      denyButton.textContent = 'Deny';
    }
  };
  approveButton.addEventListener('click', (event) => resolve('approved', approveButton, event));
  denyButton.addEventListener('click', (event) => resolve('denied', denyButton, event));
  wrap.append(approveButton, denyButton);
  return wrap;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading swap requests');
  for (let i = 0; i < 4; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--row';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderEmpty(container) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = '<h3>No swap requests</h3><p>Tanods\' shift swap requests will appear here once submitted.</p>';
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
