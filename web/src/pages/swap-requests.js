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
  { key: 'swapFlow', label: 'Swap Flow & Reason', width: '42%', sortable: true },
  { key: 'shift', label: 'Shift Details', width: '28%', sortable: true },
  { key: 'status', label: 'Status', width: '14%', sortable: true },
  { key: 'actions', label: 'Actions', align: 'right', width: '16%' },
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

  // Left side: Search & Date Scope Toggle
  const leftWrap = document.createElement('div');
  leftWrap.className = 'personnel-filter-bar__left';

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

  // Time scope toggle: All Dates vs Active & Upcoming
  const timeToggle = document.createElement('div');
  timeToggle.className = 'swap-time-toggle';
  timeToggle.setAttribute('role', 'group');
  timeToggle.setAttribute('aria-label', 'Filter shifts by date scope');

  const allTimeBtn = document.createElement('button');
  allTimeBtn.type = 'button';
  allTimeBtn.className = 'swap-time-btn is-active';
  allTimeBtn.textContent = 'All Dates';

  const upcomingBtn = document.createElement('button');
  upcomingBtn.type = 'button';
  upcomingBtn.className = 'swap-time-btn';
  upcomingBtn.textContent = 'Active & Upcoming';

  allTimeBtn.addEventListener('click', () => {
    selectedTimeScope = 'all';
    allTimeBtn.classList.add('is-active');
    upcomingBtn.classList.remove('is-active');
    renderFiltered();
  });

  upcomingBtn.addEventListener('click', () => {
    selectedTimeScope = 'upcoming';
    upcomingBtn.classList.add('is-active');
    allTimeBtn.classList.remove('is-active');
    renderFiltered();
  });

  timeToggle.append(allTimeBtn, upcomingBtn);
  leftWrap.append(searchWrap, timeToggle);

  // Right side: Status Chips & Batch Approve Action
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
  let selectedTimeScope = 'all';
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

  // Batch "Approve all pending" button
  const batchApproveBtn = document.createElement('button');
  batchApproveBtn.type = 'button';
  batchApproveBtn.className = 'primary swap-batch-approve-btn';
  batchApproveBtn.style.display = 'none';
  batchApproveBtn.addEventListener('click', async () => {
    const pending = allRequests.filter((r) => r.status === 'pending');
    if (pending.length === 0) return;

    const count = pending.length;
    const ok = await confirmDialog({
      title: `Approve all ${count} pending swap requests?`,
      description: `This will approve all ${count} pending shift swaps and update roster assignments for all covering Tanods.`,
      confirmLabel: `Approve All (${count})`,
      cancelLabel: 'Cancel',
    });
    if (!ok) return;

    batchApproveBtn.disabled = true;
    batchApproveBtn.textContent = 'Approving…';
    let successes = 0;
    let failures = 0;

    for (const req of pending) {
      try {
        await resolveShiftSwapRequest(req.requestId, 'approved', req.version);
        successes++;
      } catch {
        failures++;
      }
    }

    if (successes > 0) {
      showToast(
        failures === 0
          ? `Approved all ${successes} shift swap requests.`
          : `Approved ${successes} requests (${failures} failed).`,
        { variant: failures === 0 ? 'success' : 'warning' }
      );
    } else {
      showToast('Could not approve swap requests.', { variant: 'error' });
    }

    onChanged();
  });
  filterChipsWrap.appendChild(batchApproveBtn);

  filterBar.append(leftWrap, filterChipsWrap);

  const body = document.createElement('div');
  body.className = 'swap-table-body';

  const tableCard = document.createElement('div');
  tableCard.className = 'personnel-table-card unified-table-card';
  tableCard.append(filterBar, body);
  container.appendChild(tableCard);

  let allRequests = [];
  let allShifts = [];
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
      allShifts = shiftsRes.items;
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

    statusChips.forEach(({ id, countSpan }) => {
      const val = counts[id] ?? 0;
      countSpan.textContent = String(val);
      if (id === 'pending') {
        countSpan.className = `chip-count${val > 0 ? ' tone-warning' : ''}`;
      }
    });

    if (pendingCount > 0) {
      batchApproveBtn.style.display = 'inline-flex';
      batchApproveBtn.disabled = false;
      batchApproveBtn.innerHTML = `<span aria-hidden="true">${icons.check(14)}</span><span>Approve all (${pendingCount})</span>`;
      batchApproveBtn.setAttribute('aria-label', `Approve all ${pendingCount} pending swap requests`);
    } else {
      batchApproveBtn.style.display = 'none';
    }
  }

  function getFilteredRequests() {
    const now = Date.now();
    return allRequests.filter((req) => {
      if (selectedStatus !== 'all' && req.status !== selectedStatus) return false;

      if (selectedTimeScope === 'upcoming') {
        const shift = shiftsById.get(req.shiftId);
        if (shift) {
          const shiftEnd = new Date(shift.endAt).getTime();
          // Exclude shifts that have already completed
          if (shiftEnd < now) return false;
        }
      }

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

    const tableColumns = [
      {
        key: 'swapFlow',
        label: 'Swap Flow & Reason',
        width: '42%',
        sortable: true,
        sortValue: (req) => {
          const requester = (namesById.get(req.requestingUserId) || '').toLowerCase();
          return requester;
        },
      },
      {
        key: 'shift',
        label: 'Shift Details',
        width: '28%',
        sortable: true,
        sortValue: (req) => {
          const shift = shiftsById.get(req.shiftId);
          return shift ? new Date(shift.startAt).getTime() : 0;
        },
      },
      {
        key: 'status',
        label: 'Status',
        width: '14%',
        sortable: true,
        sortValue: (req) => {
          const priority = { pending: 1, approved: 2, denied: 3 };
          return priority[req.status] || 99;
        },
      },
      {
        key: 'actions',
        label: 'Actions',
        align: 'right',
        width: '16%',
      },
    ];

    const table = DataTable({
      columns: tableColumns,
      rows: filtered,
      rowKey: (req) => req.requestId,
      initialSort: { key: 'status', direction: 'asc' },
      caption: 'Shift Swap Requests',
      emptyIcon: icons.repeat,
      emptyMessage: (searchQuery || selectedStatus !== 'all' || selectedTimeScope !== 'all') ? 'No swap requests match your filter.' : 'No swap requests found.',
      renderCell: (req, key) => {
        const shift = shiftsById.get(req.shiftId);
        const requesterName = namesById.get(req.requestingUserId) || `Tanod #${req.requestingUserId}`;
        const targetName = req.targetUserId !== null ? (namesById.get(req.targetUserId) || `Tanod #${req.targetUserId}`) : null;

        switch (key) {
          case 'swapFlow': {
            const cell = document.createElement('div');
            cell.className = 'swap-cell-wrapper';
            const swapCode = formatSwapCode(req.requestId);
            const targetDisplay = targetName || 'Any eligible Tanod';
            cell.setAttribute(
              'aria-label',
              `Swap request ${swapCode}: ${requesterName} (Relief) transferring shift to ${targetDisplay} (Covering). Reason: ${req.reason || 'None provided'}`
            );

            // Swap code pill (SWP-xxxx) & Safety status badge
            const metaRow = document.createElement('div');
            metaRow.className = 'swap-cell-meta';
            const codePill = document.createElement('span');
            codePill.className = 'c1-inc-code-pill';
            codePill.textContent = swapCode;
            metaRow.appendChild(codePill);

            // Availability / Conflict check for covering tanod placed cleanly in metaRow
            if (shift && req.status === 'pending' && req.targetUserId) {
              const conflict = getCoveringConflict(req.targetUserId, shift, allShifts);
              if (conflict) {
                const conflictBadge = document.createElement('span');
                conflictBadge.className = `swap-conflict-badge swap-conflict-badge--${conflict.type}`;
                conflictBadge.title = conflict.tooltip;
                const iconSvg = conflict.type === 'danger'
                  ? icons.alertTriangle(12)
                  : conflict.type === 'warning'
                    ? icons.alertCircle(12)
                    : icons.check(12);
                conflictBadge.innerHTML = `<span aria-hidden="true">${iconSvg}</span><span>Covering: ${escapeHtml(conflict.label)}</span>`;
                metaRow.appendChild(conflictBadge);
              }
            }
            cell.appendChild(metaRow);

            // Flow row: Requester ➔ Target
            const flowRow = document.createElement('div');
            flowRow.className = 'swap-flow-cell';

            // Requester (Relief)
            const reqParty = document.createElement('div');
            reqParty.className = 'swap-party swap-party--requester';
            reqParty.innerHTML = `
              ${avatarInitials(requesterName, 22)}
              <span class="swap-party__name">${escapeHtml(requesterName)}</span>
              <span class="swap-role-tag swap-role-tag--relief">Relief</span>
            `;

            // Direction indicator (Crisp SVG arrow)
            const arrow = document.createElement('span');
            arrow.className = 'swap-arrow';
            arrow.innerHTML = icons.arrowRight ? icons.arrowRight(14) : '➔';
            arrow.title = 'Transfers shift to';
            arrow.setAttribute('aria-hidden', 'true');

            // Target (Covering)
            flowRow.append(reqParty, arrow);
            if (targetName) {
              const targetParty = document.createElement('div');
              targetParty.className = 'swap-party swap-party--target';
              targetParty.innerHTML = `
                ${avatarInitials(targetName, 22)}
                <span class="swap-party__name">${escapeHtml(targetName)}</span>
                <span class="swap-role-tag swap-role-tag--covering">Covering</span>
              `;
              flowRow.appendChild(targetParty);
            } else {
              const openBadge = document.createElement('span');
              openBadge.className = 'swap-target--open';
              openBadge.textContent = 'Any eligible Tanod';
              flowRow.appendChild(openBadge);
            }

            cell.appendChild(flowRow);

            // Optional Reason Quote (Flat subtle chip, no left color border)
            if (req.reason) {
              const reasonBox = document.createElement('div');
              reasonBox.className = 'swap-reason-box';
              reasonBox.textContent = `“${req.reason}”`;
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

            const topRow = document.createElement('div');
            topRow.style.cssText = 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 2px;';

            if (shift.patrolZone) {
              const zoneTag = document.createElement('span');
              zoneTag.className = 'shift-zone-tag';
              zoneTag.style.cssText = 'width: fit-content;';
              zoneTag.innerHTML = `<span style="color:var(--color-primary);">${icons.map(12)}</span><span>${escapeHtml(shift.patrolZone)}</span>`;
              topRow.appendChild(zoneTag);
            }

            // Live shift urgency badge (Active Now / Upcoming / Past)
            const urgency = getShiftUrgency(shift, req.status);
            if (urgency) {
              const urgencyPill = document.createElement('span');
              urgencyPill.className = urgency.className;
              urgencyPill.textContent = urgency.text;
              topRow.appendChild(urgencyPill);
            }

            wrap.appendChild(topRow);

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

/**
 * Checks covering tanod's schedule for overlaps or back-to-back duty fatigue.
 */
function getCoveringConflict(targetUserId, shift, allShifts) {
  if (!targetUserId || !shift || !allShifts) return null;
  const targetId = Number(targetUserId);
  const swapStart = new Date(shift.startAt).getTime();
  const swapEnd = new Date(shift.endAt).getTime();
  if (isNaN(swapStart) || isNaN(swapEnd)) return null;

  for (const other of allShifts) {
    if (other.shiftId === shift.shiftId) continue;
    if (Number(other.userId) !== targetId) continue;

    const otherStart = new Date(other.startAt).getTime();
    const otherEnd = new Date(other.endAt).getTime();
    if (isNaN(otherStart) || isNaN(otherEnd)) continue;

    // Overlap:
    if (swapStart < otherEnd && swapEnd > otherStart) {
      return {
        type: 'danger',
        label: 'Shift Overlap',
        tooltip: `Conflicts with assigned shift: ${other.patrolZone || 'Patrol'} (${formatShiftRange(other.startAt, other.endAt)})`,
      };
    }

    // Back-to-back: gap < 4 hours
    const gapHours = (swapStart >= otherEnd)
      ? (swapStart - otherEnd) / (1000 * 60 * 60)
      : (otherStart - swapEnd) / (1000 * 60 * 60);

    if (gapHours >= 0 && gapHours < 4) {
      return {
        type: 'warning',
        label: 'Back-to-back duty',
        tooltip: `Only ${Math.round(gapHours * 10) / 10}h rest from ${other.patrolZone || 'patrol'} (${formatShiftRange(other.startAt, other.endAt)})`,
      };
    }
  }

  return {
    type: 'ok',
    label: 'Available',
    tooltip: 'No scheduling conflicts found in duty roster',
  };
}

/**
 * Computes shift timeline status (Active Now / Upcoming / Past).
 */
function getShiftUrgency(shift, requestStatus) {
  if (!shift) return null;
  const now = Date.now();
  const start = new Date(shift.startAt).getTime();
  const end = new Date(shift.endAt).getTime();
  if (isNaN(start) || isNaN(end)) return null;

  if (now >= start && now <= end) {
    return {
      type: 'active',
      className: 'swap-urgency-pill swap-urgency-pill--active',
      text: '● Active Now',
    };
  }

  if (now > end) {
    if (requestStatus === 'pending') {
      return {
        type: 'past',
        className: 'swap-urgency-pill swap-urgency-pill--past',
        text: '⚠️ Past Shift',
      };
    }
    return {
      type: 'completed',
      className: 'swap-urgency-pill swap-urgency-pill--completed',
      text: 'Past Shift',
    };
  }

  const hoursUntilStart = (start - now) / (1000 * 60 * 60);
  if (hoursUntilStart <= 24) {
    return {
      type: 'upcoming',
      className: 'swap-urgency-pill swap-urgency-pill--upcoming',
      text: 'Upcoming (<24h)',
    };
  }

  return {
    type: 'future',
    className: 'swap-urgency-pill swap-urgency-pill--upcoming',
    text: 'Upcoming',
  };
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
