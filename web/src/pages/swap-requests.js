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

import { getShiftSwapRequests, getShifts, resolveShiftSwapRequest, ApiClientError } from '../api/apiClient.js';
import { loadTanodRoster } from '../services/tanodRoster.js';
import { manilaToday, formatShiftRange, formatShiftCode, formatSwapCode } from '../services/tanodWorkflowUi.js';
import { addDays, fetchAllPages } from '../services/rosterWindow.js';
import { DataTable } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { avatarInitials } from '../components/Avatar.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { icons } from '../components/icons.js';
import { escapeHtml } from '../utils/escapeHtml.js';

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
  searchInput.setAttribute('aria-label', 'Search swap requests');
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderFiltered();
  });
  searchWrap.append(searchIcon, searchInput);

  // Status Chips with integrated KPI counters (Option A: Unified Command Card)
  const filterChipsWrap = document.createElement('div');
  filterChipsWrap.className = 'personnel-filter-bar__right';
  filterChipsWrap.setAttribute('role', 'toolbar');
  filterChipsWrap.setAttribute('aria-label', 'Filter requests by status');

  const statusOptions = [
    { id: 'all', label: 'All Requests' },
    { id: 'pending', label: 'Pending', tone: 'warning' },
    { id: 'approved', label: 'Approved', tone: 'success' },
    { id: 'denied', label: 'Denied' },
  ];

  let selectedStatus = 'all';
  let searchQuery = '';

  const statusChips = [];
  statusOptions.forEach((opt) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip ${selectedStatus === opt.id ? 'is-active' : ''}`;
    chip.setAttribute('aria-pressed', selectedStatus === opt.id ? 'true' : 'false');

    const labelSpan = document.createElement('span');
    labelSpan.textContent = opt.label;

    const countSpan = document.createElement('span');
    countSpan.className = `chip-count${opt.tone ? ' tone-' + opt.tone : ''}`;
    countSpan.textContent = '0';

    chip.append(labelSpan, countSpan);

    chip.addEventListener('click', () => {
      selectedStatus = opt.id;
      statusChips.forEach(({ btn, id }) => {
        const isActive = id === selectedStatus;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      renderFiltered();
    });

    statusChips.push({ btn: chip, id: opt.id, countSpan, label: opt.label });
    filterChipsWrap.appendChild(chip);
  });

  filterBar.append(searchWrap, filterChipsWrap);

  const body = document.createElement('div');
  body.className = 'swap-table-body';

  const tableCard = document.createElement('div');
  tableCard.className = 'personnel-table-card unified-table-card';
  tableCard.append(filterBar, body);
  container.appendChild(tableCard);

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
        // Shifts for the lookup: a window from 30 days ago onward, all pages (audit F-09).
        fetchAllPages((p) => getShifts({ from: addDays(manilaToday(), -30), ...p })),
        loadTanodRoster(user).then((items) => ({ items })),
      ]);
      allRequests = requestsRes.items;
      shiftsById = new Map(shiftsRes.items.map((s) => [s.shiftId, s]));
      namesById = new Map(tanodsRes.items.map((t) => [t.userId, t.fullName]));

      updateFilterChipCounts(allRequests);
      renderFiltered();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading swap requests.';
      renderError(body, message, load);
    }
  }

  function updateFilterChipCounts(requests) {
    const pendingCount = requests.filter((r) => r.status === 'pending').length;
    const approvedCount = requests.filter((r) => r.status === 'approved').length;
    const deniedCount = requests.filter((r) => r.status === 'denied').length;

    const counts = {
      all: requests.length,
      pending: pendingCount,
      approved: approvedCount,
      denied: deniedCount,
    };

    statusChips.forEach(({ id, countSpan, label }) => {
      const val = counts[id] ?? 0;
      countSpan.textContent = String(val);
      if (id === 'pending') {
        countSpan.className = `chip-count${val > 0 ? ' tone-warning' : ''}`;
      }
    });
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

            // Swap code pill (SWP-xxxx)
            const codePill = document.createElement('span');
            codePill.className = 'c1-inc-code-pill';
            codePill.style.cssText = 'width: fit-content; margin-bottom: 4px;';
            codePill.textContent = formatSwapCode(req.requestId);
            cell.appendChild(codePill);

            // Flow row: Requester ➔ Target
            const flowRow = document.createElement('div');
            flowRow.className = 'swap-flow-cell';

            // Requester (Relieving)
            const reqParty = document.createElement('div');
            reqParty.className = 'swap-party swap-party--requester';
            const reqRole = document.createElement('span');
            reqRole.className = 'swap-role-badge';
            reqRole.textContent = 'Relief';
            const reqIdentity = document.createElement('div');
            reqIdentity.className = 'swap-party__identity';
            reqIdentity.innerHTML = `${avatarInitials(requesterName, 24)}<span class="swap-party__name">${escapeHtml(requesterName)}</span>`;
            reqParty.append(reqRole, reqIdentity);

            // Direction indicator
            const arrow = document.createElement('span');
            arrow.className = 'swap-arrow';
            arrow.innerHTML = '➔';
            arrow.title = 'Transfers shift to';
            arrow.setAttribute('aria-hidden', 'true');

            // Target (Covering)
            flowRow.append(reqParty, arrow);
            if (targetName) {
              const targetParty = document.createElement('div');
              targetParty.className = 'swap-party swap-party--target';
              const targetRole = document.createElement('span');
              targetRole.className = 'swap-role-badge swap-role-badge--target';
              targetRole.textContent = 'Covering';
              const targetIdentity = document.createElement('div');
              targetIdentity.className = 'swap-party__identity';
              targetIdentity.innerHTML = `${avatarInitials(targetName, 24)}<span class="swap-party__name">${escapeHtml(targetName)}</span>`;
              targetParty.append(targetRole, targetIdentity);
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
              wrap.textContent = formatShiftCode(req.shiftId);
              return wrap;
            }

            if (shift.patrolZone) {
              const zoneTag = document.createElement('span');
              zoneTag.className = 'shift-zone-tag';
              zoneTag.style.cssText = 'width: fit-content; margin-bottom: 2px;';
              zoneTag.innerHTML = `<span style="color:var(--color-primary);">${icons.map(12)}</span><span>${escapeHtml(shift.patrolZone)}</span>`; // free text (V-03): always escaped
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
              note.textContent = '⚠️ Unassigned — reassignment required';
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
  return formatShiftRange(startAt, endAt);
}

function formatDuration(startAt, endAt) {
  const ms = new Date(endAt).getTime() - new Date(startAt).getTime();
  if (isNaN(ms) || ms <= 0) return '';
  const hours = ms / (1000 * 60 * 60);
  return hours % 1 === 0 ? `${hours} hrs` : `${hours.toFixed(1)} hrs`;
}

// 2026-10-12: approving a swap on a published shift keeps it PUBLISHED —
// the roster was already signed, only the name changes, so there is no
// re-approval step. Releasing with no named target leaves it unassigned
// (assigning someone later is a normal edit, which does return it to draft).
function swapApproveNote(req) {
  return req.targetUserId === null
    ? 'The shift stays published but becomes unassigned until you assign a Tanod.'
    : 'The shift stays published with the new Tanod; no roster re-approval is needed.';
}

function renderActionsCell(req, requesterName, shift, onChanged) {
  const wrap = document.createElement('div');
  wrap.className = 'user-actions-group';

  const approveButton = document.createElement('button');
  approveButton.className = 'user-action-btn user-action-btn--primary';
  approveButton.textContent = 'Approve';
  approveButton.setAttribute('aria-label', `Approve shift swap for ${requesterName}`);

  const denyButton = document.createElement('button');
  denyButton.className = 'user-action-btn user-action-btn--danger';
  denyButton.textContent = 'Deny';
  denyButton.setAttribute('aria-label', `Deny shift swap for ${requesterName}`);

  const shiftDescription = shift
    ? formatShiftRange(shift.startAt, shift.endAt)
    : formatShiftCode(req.shiftId);

  const resolve = async (status, button, event) => {
    event.stopPropagation();
    const confirmed = await confirmDialog({
      title: status === 'approved' ? 'Approve shift swap request?' : 'Deny shift swap request?',
      description: status === 'approved'
        ? `${requesterName} — ${shiftDescription}. ${swapApproveNote(req)}`
        : `${requesterName} — ${shiftDescription}`,
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
