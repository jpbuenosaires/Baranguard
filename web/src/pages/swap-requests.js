/**
 * swap-requests.js — Personnel > Swap Requests Tab.
 * Overhauled UI/UX:
 * - Visual Swap Flow Cell: Requester avatar ➔ Target avatar / "Open Request" tag
 * - Dedicated reason quote callout box
 * - Shift details with patrol zone badge and calculated duration
 * - Interactive StatStrip (Pending, Approved, Denied)
 * - Filter bar with live search and status filter chips
 * - High-density action buttons with confirmation dialogs
 */

import { getShiftSwapRequests, getShifts, getUsers, resolveShiftSwapRequest, ApiClientError } from '../api/apiClient.js';
import { DataTable } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { avatarInitials } from '../components/Avatar.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { icons } from '../components/icons.js';

const STATUS_PILL_CLASS = {
  pending: 'status-pill--pending',
  approved: 'status-pill--success',
  denied: 'status-pill--neutral',
};

const COLUMNS = [
  { key: 'swapFlow', label: 'Swap Flow & Reason' },
  { key: 'shift', label: 'Shift Details' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: 'Actions', align: 'right' },
];

/**
 * Personnel > Swap requests tab.
 *
 * @param {HTMLElement} container tab body to render into
 * @param {{fullName:string, role:string}} user
 * @param {() => void} [onCountsChanged] re-fetches badge counters
 */
export function renderSwapRequestsTab(container, user, onCountsChanged) {
  const statStripHost = document.createElement('div');
  container.appendChild(statStripHost);

  // Filter Bar
  const filterBar = document.createElement('div');
  filterBar.className = 'personnel-filter-bar';

  // Search
  const searchWrap = document.createElement('div');
  searchWrap.className = 'personnel-search-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'personnel-search-icon';
  searchIcon.innerHTML = icons.search(16);
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'personnel-search-input';
  searchInput.placeholder = 'Search by tanod name or reason…';
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderFiltered();
  });
  searchWrap.append(searchIcon, searchInput);

  // Status Chips
  const filterChipsWrap = document.createElement('div');
  filterChipsWrap.className = 'personnel-filter-bar__right';

  const statusOptions = [
    { id: 'all', label: 'All Requests' },
    { id: 'pending', label: 'Pending' },
    { id: 'approved', label: 'Approved' },
    { id: 'denied', label: 'Denied' },
  ];

  let selectedStatus = 'all';
  let searchQuery = '';

  const statusChipBtns = [];
  statusOptions.forEach((opt) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip ${selectedStatus === opt.id ? 'is-active' : ''}`;
    chip.textContent = opt.label;
    chip.addEventListener('click', () => {
      selectedStatus = opt.id;
      statusChipBtns.forEach((b) => b.classList.remove('is-active'));
      chip.classList.add('is-active');
      renderFiltered();
    });
    statusChipBtns.push(chip);
    filterChipsWrap.appendChild(chip);
  });

  filterBar.append(searchWrap, filterChipsWrap);
  container.appendChild(filterBar);

  const body = document.createElement('div');
  container.appendChild(body);

  let allRequests = [];
  let shiftsById = new Map();
  let namesById = new Map();

  const onChanged = () => {
    load();
    onCountsChanged?.();
  };

  load();

  async function load() {
    renderLoading(body);
    try {
      const [requestsRes, shiftsRes, tanodsRes] = await Promise.all([
        getShiftSwapRequests({ limit: 100 }),
        getShifts({ limit: 100 }),
        getUsers({ role: 'tanod', limit: 100 }),
      ]);
      allRequests = requestsRes.items;
      shiftsById = new Map(shiftsRes.items.map((s) => [s.shiftId, s]));
      namesById = new Map(tanodsRes.items.map((t) => [t.userId, t.fullName]));

      renderStatStrip(allRequests);
      renderFiltered();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading swap requests.';
      renderError(body, message, load);
    }
  }

  function renderStatStrip(requests) {
    statStripHost.innerHTML = '';
    const pendingCount = requests.filter((r) => r.status === 'pending').length;
    const approvedCount = requests.filter((r) => r.status === 'approved').length;
    const deniedCount = requests.filter((r) => r.status === 'denied').length;

    const strip = StatStrip({
      items: [
        { label: 'Total Requests', value: requests.length },
        { label: 'Pending Review', value: pendingCount, tone: pendingCount > 0 ? 'warning' : 'neutral' },
        { label: 'Approved', value: approvedCount, tone: 'success' },
        { label: 'Denied', value: deniedCount },
      ],
    });

    const cards = strip.querySelectorAll('.stat-card');
    if (cards[0]) {
      cards[0].style.cursor = 'pointer';
      cards[0].title = 'Show all requests';
      cards[0].addEventListener('click', () => {
        selectedStatus = 'all';
        statusChipBtns.forEach((b, i) => b.classList.toggle('is-active', i === 0));
        renderFiltered();
      });
    }
    if (cards[1]) {
      cards[1].style.cursor = 'pointer';
      cards[1].title = 'Filter: Pending Review';
      cards[1].addEventListener('click', () => {
        selectedStatus = 'pending';
        statusChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent === 'Pending'));
        renderFiltered();
      });
    }
    if (cards[2]) {
      cards[2].style.cursor = 'pointer';
      cards[2].title = 'Filter: Approved';
      cards[2].addEventListener('click', () => {
        selectedStatus = 'approved';
        statusChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent === 'Approved'));
        renderFiltered();
      });
    }
    if (cards[3]) {
      cards[3].style.cursor = 'pointer';
      cards[3].title = 'Filter: Denied';
      cards[3].addEventListener('click', () => {
        selectedStatus = 'denied';
        statusChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent === 'Denied'));
        renderFiltered();
      });
    }

    statStripHost.appendChild(strip);
  }

  function getFilteredRequests() {
    return allRequests.filter((req) => {
      if (selectedStatus !== 'all' && req.status !== selectedStatus) return false;

      if (searchQuery) {
        const requesterName = (namesById.get(req.requestingUserId) || '').toLowerCase();
        const targetName = req.targetUserId ? (namesById.get(req.targetUserId) || '').toLowerCase() : '';
        const reason = (req.reason || '').toLowerCase();
        if (!requesterName.includes(searchQuery) && !targetName.includes(searchQuery) && !reason.includes(searchQuery)) {
          return false;
        }
      }
      return true;
    });
  }

  function renderFiltered() {
    body.innerHTML = '';
    const filtered = getFilteredRequests();

    if (allRequests.length === 0) {
      renderEmpty(body);
      return;
    }

    const table = DataTable({
      columns: COLUMNS,
      rows: filtered,
      rowKey: (req) => req.requestId,
      caption: 'Shift Swap Requests',
      emptyIcon: icons.repeat,
      emptyMessage: (searchQuery || selectedStatus !== 'all') ? 'No swap requests match your filter.' : 'No swap requests found.',
      renderCell: (req, key) => {
        const shift = shiftsById.get(req.shiftId);
        const requesterName = namesById.get(req.requestingUserId) || `Tanod #${req.requestingUserId}`;
        const targetName = req.targetUserId !== null ? (namesById.get(req.targetUserId) || `Tanod #${req.targetUserId}`) : null;

        switch (key) {
          case 'swapFlow': {
            const cell = document.createElement('div');

            // Flow row: Requester ➔ Target
            const flowRow = document.createElement('div');
            flowRow.className = 'swap-flow-cell';

            // Requester
            const reqParty = document.createElement('span');
            reqParty.className = 'swap-party';
            reqParty.innerHTML = `${avatarInitials(requesterName, 24)}<span>${requesterName}</span>`;

            // Arrow
            const arrow = document.createElement('span');
            arrow.className = 'swap-arrow';
            arrow.innerHTML = '➔';

            // Target
            flowRow.append(reqParty, arrow);
            if (targetName) {
              const targetParty = document.createElement('span');
              targetParty.className = 'swap-party';
              targetParty.innerHTML = `${avatarInitials(targetName, 24)}<span>${targetName}</span>`;
              flowRow.appendChild(targetParty);
            } else {
              const openBadge = document.createElement('span');
              openBadge.className = 'swap-target--open';
              openBadge.textContent = 'Any eligible Tanod';
              flowRow.appendChild(openBadge);
            }

            cell.appendChild(flowRow);

            // Optional Reason Quote
            if (req.reason) {
              const reasonBox = document.createElement('div');
              reasonBox.className = 'swap-reason-box';
              reasonBox.textContent = `"${req.reason}"`;
              cell.appendChild(reasonBox);
            }

            return cell;
          }

          case 'shift': {
            const wrap = document.createElement('div');
            wrap.className = 'shift-time-range-wrap';

            if (!shift) {
              wrap.textContent = `Shift #${req.shiftId}`;
              return wrap;
            }

            if (shift.patrolZone) {
              const zoneTag = document.createElement('span');
              zoneTag.className = 'shift-zone-tag';
              zoneTag.style.cssText = 'width: fit-content; margin-bottom: 2px;';
              zoneTag.innerHTML = `<span style="color:var(--color-primary);">${icons.map(12)}</span><span>${shift.patrolZone}</span>`;
              wrap.appendChild(zoneTag);
            }

            const dates = document.createElement('span');
            dates.className = 'shift-time-dates';
            dates.textContent = formatShiftTimeRange(shift.startAt, shift.endAt);

            const duration = document.createElement('span');
            duration.className = 'shift-time-duration';
            duration.textContent = formatDuration(shift.startAt, shift.endAt);

            wrap.append(dates, duration);
            return wrap;
          }

          case 'status': {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';

            const pillClass = STATUS_PILL_CLASS[req.status] || 'status-pill--neutral';
            const pill = document.createElement('span');
            pill.className = `status-pill ${pillClass}`;
            pill.style.width = 'fit-content';
            pill.textContent = req.status.charAt(0).toUpperCase() + req.status.slice(1);
            wrap.appendChild(pill);

            if (req.status === 'approved' && req.targetUserId === null) {
              const note = document.createElement('div');
              note.className = 'data-table__sub';
              note.style.color = 'var(--color-warning-text)';
              note.style.fontWeight = '600';
              note.textContent = '⚠️ Unassigned — Admin action required';
              wrap.appendChild(note);
            }
            return wrap;
          }

          case 'actions': {
            return req.status === 'pending'
              ? renderActionsCell(req, requesterName, shift, onChanged)
              : '';
          }

          default:
            return '';
        }
      },
    });

    body.appendChild(table);
  }
}

function formatShiftTimeRange(startAt, endAt) {
  const s = new Date(startAt);
  const e = new Date(endAt);
  const isSameDay = s.toDateString() === e.toDateString();
  const timeOpts = { hour: '2-digit', minute: '2-digit', hour12: true };
  const dateOpts = { month: 'short', day: 'numeric' };

  if (isSameDay) {
    return `${s.toLocaleDateString([], dateOpts)} · ${s.toLocaleTimeString([], timeOpts)} – ${e.toLocaleTimeString([], timeOpts)}`;
  }
  return `${s.toLocaleDateString([], dateOpts)} ${s.toLocaleTimeString([], timeOpts)} – ${e.toLocaleDateString([], dateOpts)} ${e.toLocaleTimeString([], timeOpts)}`;
}

function formatDuration(startAt, endAt) {
  const ms = new Date(endAt).getTime() - new Date(startAt).getTime();
  if (isNaN(ms) || ms <= 0) return '';
  const hours = ms / (1000 * 60 * 60);
  return hours % 1 === 0 ? `${hours} hrs` : `${hours.toFixed(1)} hrs`;
}

function renderActionsCell(req, requesterName, shift, onChanged) {
  const wrap = document.createElement('div');
  wrap.className = 'user-actions-group';

  const approveButton = document.createElement('button');
  approveButton.className = 'user-action-btn user-action-btn--primary';
  approveButton.textContent = 'Approve';

  const denyButton = document.createElement('button');
  denyButton.className = 'user-action-btn user-action-btn--danger';
  denyButton.textContent = 'Deny';

  const shiftDescription = shift
    ? `${new Date(shift.startAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} – ${new Date(shift.endAt).toLocaleTimeString([], { timeStyle: 'short' })}`
    : `Shift #${req.shiftId}`;

  const resolve = async (status, button, event) => {
    event.stopPropagation();
    const confirmed = await confirmDialog({
      title: status === 'approved' ? 'Approve shift swap request?' : 'Deny shift swap request?',
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
      showToast(status === 'approved' ? 'Swap request approved.' : 'Swap request denied.', {
        variant: status === 'approved' ? 'success' : 'info',
      });
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
