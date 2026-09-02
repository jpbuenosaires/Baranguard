/**
 * fatigue-flags.js — W13 Fatigue Flags (§9): "Sorted by over-threshold
 * hours. Acknowledgment never deletes or hides the historical record."
 * Roles: Admin (full), Punong Barangay (read-only — no Acknowledge
 * button shown).
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getFatigueFlags, getUsers, acknowledgeFatigueFlag, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { icons } from '../components/icons.js';

/** @param {HTMLElement} root @param {{fullName:string, role:string}} user */
export function renderFatigueFlagsPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  // GET /users is Admin-only server-side (UsersController.php) — a PB
  // session (this screen's read-only role) would 403 on it, so only ask
  // for it as Admin; PB falls back to "Tanod #id" labels instead of a
  // crashed page. Found before shipping, not discovered by a test.
  const canAcknowledge = user.role === 'admin';
  const canLookUpNames = user.role === 'admin';

  const shell = AppShell(user, 'fatigue', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { content } = shell;
  root.appendChild(shell.el);

  content.innerHTML = `<h2 style="margin-bottom:16px; display:flex; align-items:center; gap:10px;">${icons.batteryWarning(22)}Fatigue Flags</h2>`;
  const body = document.createElement('div');
  content.appendChild(body);

  load();

  async function load() {
    renderLoading(body);
    try {
      const [flagsRes, tanodsRes] = await Promise.all([
        getFatigueFlags({ limit: 100 }),
        canLookUpNames ? getUsers({ role: 'tanod', limit: 100 }) : Promise.resolve({ items: [] }),
      ]);
      const namesById = new Map(tanodsRes.items.map((t) => [t.userId, t.fullName]));
      if (flagsRes.items.length === 0) {
        renderEmpty(body);
      } else {
        renderList(body, flagsRes.items, namesById, canAcknowledge, load);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading fatigue flags.';
      renderError(body, message, load);
    }
  }
}

function renderList(container, flags, namesById, canAcknowledge, onChanged) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  for (const flag of flags) {
    list.appendChild(renderFlagRow(flag, namesById, canAcknowledge, onChanged));
  }
  container.appendChild(list);
}

function renderFlagRow(flag, namesById, canAcknowledge, onChanged) {
  const row = document.createElement('div');
  row.className = 'card';
  row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:16px;';

  const name = namesById.get(flag.userId) || `Tanod #${flag.userId}`;
  const left = document.createElement('div');
  left.innerHTML = `
    <strong>${escapeHtml(name)}</strong>
    <div class="label" style="text-transform:none; font-weight:400; margin-top:4px;">
      ${flag.hoursWorked7Day} hrs in 7 days (${flag.calculationBasis.replace('_', ' ')}) · flagged ${new Date(flag.flaggedAt).toLocaleString()}
    </div>
  `;

  const right = document.createElement('div');
  right.style.cssText = 'display:flex; align-items:center; gap:12px;';
  if (flag.acknowledgedAt) {
    const pill = document.createElement('span');
    pill.className = 'status-pill status-pill--success';
    pill.textContent = 'Acknowledged';
    right.appendChild(pill);
  } else {
    const pill = document.createElement('span');
    pill.className = 'status-pill status-pill--critical';
    pill.textContent = 'Needs review';
    right.appendChild(pill);
    if (canAcknowledge) {
      const ackButton = document.createElement('button');
      ackButton.className = 'primary';
      ackButton.textContent = 'Acknowledge';
      ackButton.addEventListener('click', async () => {
        ackButton.disabled = true;
        ackButton.textContent = 'Acknowledging…';
        try {
          await acknowledgeFatigueFlag(flag.flagId);
          onChanged();
        } catch (err) {
          const message = err instanceof ApiClientError ? err.message : 'Could not acknowledge this flag.';
          alert(message);
          ackButton.disabled = false;
          ackButton.textContent = 'Acknowledge';
        }
      });
      right.appendChild(ackButton);
    }
  }

  row.append(left, right);
  return row;
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
    skeleton.style.cssText = 'height:64px; border-radius:12px;';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderEmpty(container) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = '<h3>No fatigue flags</h3><p>No Tanod has exceeded the safe scheduled-hours threshold recently.</p>';
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
