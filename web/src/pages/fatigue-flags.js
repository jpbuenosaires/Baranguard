/**
 * fatigue-flags.js — W13 Fatigue Flags (§9): "Sorted by over-threshold
 * hours. Acknowledgment never deletes or hides the historical record."
 * Roles: Admin (full), Punong Barangay (read-only — no Acknowledge
 * button shown).
 *
 * 2026-09-02: migrated header to PageHeader and the stacked-row list to
 * the shared DataTable component (Figma-alignment pass).
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getFatigueFlags, getUsers, acknowledgeFatigueFlag, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { avatarInitials } from '../components/Avatar.js';
import { showToast } from '../components/Toast.js';

// The project's own safety rule (FatigueCalculator.php): 56 scheduled
// hours in a rolling 7-day window. Mirrored here only to render the bar
// and the "N h over" figure — the flag itself is always raised
// server-side, never inferred from this constant.
const FATIGUE_THRESHOLD_HOURS = 56;

const COLUMNS = [
  { key: 'tanod', label: 'Tanod' },
  { key: 'hours', label: `Hours (7-day, limit ${FATIGUE_THRESHOLD_HOURS})` },
  { key: 'flagged', label: 'Flagged' },
  { key: 'action', label: 'Status', align: 'right' },
];

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
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({ title: 'Fatigue Flags', subtitle: 'Tanods scheduled over the safe 7-day hours threshold', icon: icons.batteryWarning });
  header.appendChild(pageHeader.el);

  const body = document.createElement('div');
  content.appendChild(body);

  // audit A16: the sidebar badge would otherwise sit contradicting this
  // screen for up to a minute after the last flag is acknowledged.
  const onChanged = () => { load(); shell.refreshNavCounts?.(); };

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
        renderList(body, flagsRes.items, namesById, canAcknowledge, onChanged);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading fatigue flags.';
      renderError(body, message, load);
    }
  }
}

function renderList(container, flags, namesById, canAcknowledge, onChanged) {
  container.innerHTML = '';
  const table = DataTable({
    columns: COLUMNS,
    rows: flags,
    rowKey: (row) => row.flagId,
    caption: 'Fatigue flags',
    renderCell: (flag, key) => {
      const name = namesById.get(flag.userId) || `Tanod #${flag.userId}`;
      switch (key) {
        case 'tanod': {
          const span = document.createElement('span');
          span.className = 'avatar-row';
          span.innerHTML = `${avatarInitials(name, 24)}${escapeHtml(name)}`;
          return span;
        }
        case 'hours': {
          // audit W13: "62.50" alone means nothing without the rule it
          // broke. Shown against the threshold with a proportional bar, so
          // how far over someone is reads at a glance rather than asking
          // the reader to remember the limit.
          const hours = Number(flag.hoursWorked7Day);
          const overBy = hours - FATIGUE_THRESHOLD_HOURS;
          const cell = document.createElement('span');
          cell.className = 'fatigue-hours';
          const figure = document.createElement('span');
          figure.className = 'fatigue-hours__figure';
          figure.textContent = `${hours} / ${FATIGUE_THRESHOLD_HOURS} h`;
          const bar = document.createElement('span');
          bar.className = 'fatigue-hours__bar';
          const fill = document.createElement('span');
          fill.className = 'fatigue-hours__fill';
          // Capped at 100% — the bar says "at or past the limit"; the
          // exact overage is spelled out in the line below it.
          fill.style.width = `${Math.min(100, (hours / FATIGUE_THRESHOLD_HOURS) * 100)}%`;
          bar.appendChild(fill);
          const over = document.createElement('span');
          over.className = 'fatigue-hours__over';
          over.textContent = overBy > 0
            ? `${overBy.toFixed(2).replace(/\.?0+$/, '')} h over · ${flag.calculationBasis.replace('_', ' ')}`
            : `at threshold · ${flag.calculationBasis.replace('_', ' ')}`;
          cell.append(figure, bar, over);
          return cell;
        }
        case 'flagged':
          return new Date(flag.flaggedAt).toLocaleString();
        case 'action':
          return renderActionCell(flag, canAcknowledge, onChanged);
        default:
          return '';
      }
    },
  });
  container.appendChild(table);
}

function renderActionCell(flag, canAcknowledge, onChanged) {
  const wrap = document.createElement('span');
  wrap.className = 'data-table__actions';

  if (flag.acknowledgedAt) {
    const pill = document.createElement('span');
    pill.className = 'status-pill status-pill--success';
    pill.textContent = 'Acknowledged';
    wrap.appendChild(pill);
    return wrap;
  }

  const pill = document.createElement('span');
  pill.className = 'status-pill status-pill--critical';
  pill.textContent = 'Needs review';
  wrap.appendChild(pill);

  if (canAcknowledge) {
    const ackButton = document.createElement('button');
    ackButton.className = 'primary';
    ackButton.textContent = 'Acknowledge';
    ackButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      ackButton.disabled = true;
      ackButton.textContent = 'Acknowledging…';
      try {
        await acknowledgeFatigueFlag(flag.flagId);
        onChanged();
      } catch (err) {
        const message = err instanceof ApiClientError ? err.message : 'Could not acknowledge this flag.';
        showToast(message, { variant: 'error' });
        ackButton.disabled = false;
        ackButton.textContent = 'Acknowledge';
      }
    });
    wrap.appendChild(ackButton);
  }

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
  wrap.setAttribute('aria-label', 'Loading fatigue flags');
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
  block.innerHTML = '<h3>No fatigue flags</h3><p>No Tanod has exceeded the safe scheduled-hours threshold recently.</p>';
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
