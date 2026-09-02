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
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getShiftSwapRequests, getShifts, getUsers, resolveShiftSwapRequest, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { icons } from '../components/icons.js';

const STATUS_PILL_CLASS = { pending: 'status-pill--pending', approved: 'status-pill--success', denied: 'status-pill--neutral' };

/** @param {HTMLElement} root @param {{fullName:string, role:string}} user */
export function renderSwapRequestsPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'swap-requests', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { content } = shell;
  root.appendChild(shell.el);

  content.innerHTML = `<h2 style="margin-bottom:16px; display:flex; align-items:center; gap:10px;">${icons.repeat(22)}Shift Swap Requests</h2>`;
  const body = document.createElement('div');
  content.appendChild(body);

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
        renderList(body, requestsRes.items, shiftsById, namesById, load);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading swap requests.';
      renderError(body, message, load);
    }
  }
}

function renderList(container, requests, shiftsById, namesById, onChanged) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  for (const req of requests) {
    list.appendChild(renderRequestCard(req, shiftsById, namesById, onChanged));
  }
  container.appendChild(list);
}

function renderRequestCard(req, shiftsById, namesById, onChanged) {
  const card = document.createElement('div');
  card.className = 'card';

  const shift = shiftsById.get(req.shiftId);
  const requesterName = namesById.get(req.requestingUserId) || `Tanod #${req.requestingUserId}`;
  const targetName = req.targetUserId !== null ? (namesById.get(req.targetUserId) || `Tanod #${req.targetUserId}`) : null;
  const pillClass = STATUS_PILL_CLASS[req.status] || 'status-pill--neutral';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';
  header.innerHTML = `<strong>${escapeHtml(requesterName)}</strong><span class="status-pill ${pillClass}">${req.status}</span>`;

  const meta = document.createElement('div');
  meta.className = 'label';
  meta.style.cssText = 'text-transform:none; font-weight:400; margin-top:8px;';
  meta.textContent = shift
    ? `Shift: ${shift.patrolZone ? shift.patrolZone + ' · ' : ''}${new Date(shift.startAt).toLocaleString()} – ${new Date(shift.endAt).toLocaleString()}`
    : `Shift #${req.shiftId}`;

  const targetLine = document.createElement('div');
  targetLine.className = 'label';
  targetLine.style.cssText = 'text-transform:none; font-weight:400; margin-top:4px;';
  targetLine.textContent = targetName ? `Requested swap with: ${targetName}` : 'No specific target — any eligible Tanod';

  card.append(header, meta, targetLine);

  if (req.reason) {
    const reasonLine = document.createElement('p');
    reasonLine.style.marginTop = '8px';
    reasonLine.textContent = req.reason;
    card.appendChild(reasonLine);
  }

  if (req.status === 'approved' && req.targetUserId === null) {
    const note = document.createElement('div');
    note.className = 'status-pill status-pill--pending';
    note.style.marginTop = '8px';
    note.textContent = 'Unassigned — Admin action required';
    card.appendChild(note);
  }

  if (req.status === 'pending') {
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:8px; margin-top:12px;';
    const approveButton = document.createElement('button');
    approveButton.className = 'primary';
    approveButton.textContent = 'Approve';
    const denyButton = document.createElement('button');
    denyButton.className = 'danger';
    denyButton.textContent = 'Deny';

    const resolve = async (status, button) => {
      approveButton.disabled = true;
      denyButton.disabled = true;
      button.textContent = status === 'approved' ? 'Approving…' : 'Denying…';
      try {
        await resolveShiftSwapRequest(req.requestId, status, req.version);
        onChanged();
      } catch (err) {
        const message = err instanceof ApiClientError ? err.message : 'Could not resolve this request.';
        alert(message);
        approveButton.disabled = false;
        denyButton.disabled = false;
        approveButton.textContent = 'Approve';
        denyButton.textContent = 'Deny';
      }
    };
    approveButton.addEventListener('click', () => resolve('approved', approveButton));
    denyButton.addEventListener('click', () => resolve('denied', denyButton));
    actions.append(approveButton, denyButton);
    card.appendChild(actions);
  }

  return card;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.style.cssText = 'height:96px; border-radius:12px;';
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
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}
