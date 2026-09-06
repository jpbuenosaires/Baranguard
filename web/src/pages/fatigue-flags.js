/**
 * fatigue-flags.js — Personnel > Fatigue Flags Tab.
 * Overhauled UI/UX:
 * - Tiered fatigue meter card with dynamic risk tiering:
 *     🟡 Moderate (56–60h)
 *     🟠 High Risk (60–70h)
 *     🔴 Severe Overload (>70h) with animated glow
 * - Tanod identity cell with avatar initials
 * - Safety StatStrip (Needs Review, Acknowledged, Total Incidents)
 * - Filter bar with live search and review-status chips
 * - Preserved role-gating: Admin (full with Acknowledge), Punong Barangay (read-only)
 */

import { getFatigueFlags, getUsers, acknowledgeFatigueFlag, ApiClientError } from '../api/apiClient.js';
import { DataTable } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { avatarInitials } from '../components/Avatar.js';
import { showToast } from '../components/Toast.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { icons } from '../components/icons.js';

const FATIGUE_THRESHOLD_HOURS = 56;

const COLUMNS = [
  { key: 'tanod', label: 'Tanod' },
  { key: 'riskMeter', label: `7-Day Scheduled Hours (Limit: ${FATIGUE_THRESHOLD_HOURS}h)` },
  { key: 'flagged', label: 'Flagged Date' },
  { key: 'action', label: 'Status & Action', align: 'right' },
];

/**
 * Personnel > Fatigue flags tab.
 *
 * @param {HTMLElement} container tab body to render into
 * @param {{fullName:string, role:string}} user
 * @param {() => void} [onCountsChanged] re-fetches badge count
 */
export function renderFatigueFlagsTab(container, user, onCountsChanged) {
  const canAcknowledge = user.role === 'admin';
  const canLookUpNames = user.role === 'admin';

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
  searchInput.placeholder = 'Search by tanod name or calculation basis…';
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderFiltered();
  });
  searchWrap.append(searchIcon, searchInput);

  // Status Chips
  const filterChipsWrap = document.createElement('div');
  filterChipsWrap.className = 'personnel-filter-bar__right';

  const statusOptions = [
    { id: 'all', label: 'All Flags' },
    { id: 'review', label: 'Needs Review' },
    { id: 'acknowledged', label: 'Acknowledged' },
  ];

  let selectedStatus = 'all';
  let searchQuery = '';

  const statusChipBtns = [];
  statusOptions.forEach((opt) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `personnel-filter-chip ${selectedStatus === opt.id ? 'is-active' : ''}`;
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

  let allFlags = [];
  let namesById = new Map();

  const onChanged = () => {
    load();
    onCountsChanged?.();
  };

  load();

  async function load() {
    renderLoading(body);
    try {
      const [flagsRes, tanodsRes] = await Promise.all([
        getFatigueFlags({ limit: 100 }),
        canLookUpNames ? getUsers({ role: 'tanod', limit: 100 }) : Promise.resolve({ items: [] }),
      ]);
      allFlags = flagsRes.items;
      namesById = new Map(tanodsRes.items.map((t) => [t.userId, t.fullName]));

      renderStatStrip(allFlags);
      renderFiltered();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading fatigue flags.';
      renderError(body, message, load);
    }
  }

  function renderStatStrip(flags) {
    statStripHost.innerHTML = '';
    const needsReviewCount = flags.filter((f) => !f.acknowledgedAt).length;
    const ackCount = flags.filter((f) => !!f.acknowledgedAt).length;

    const strip = StatStrip({
      items: [
        { label: 'Total Alerts', value: flags.length },
        { label: 'Needs Review', value: needsReviewCount, tone: needsReviewCount > 0 ? 'critical' : 'neutral' },
        { label: 'Acknowledged', value: ackCount, tone: 'success' },
        { label: 'Safety Limit', value: `${FATIGUE_THRESHOLD_HOURS}h / wk`, tone: 'info' },
      ],
    });

    const cards = strip.querySelectorAll('.stat-card');
    if (cards[0]) {
      cards[0].style.cursor = 'pointer';
      cards[0].title = 'Show all flags';
      cards[0].addEventListener('click', () => {
        selectedStatus = 'all';
        statusChipBtns.forEach((b, i) => b.classList.toggle('is-active', i === 0));
        renderFiltered();
      });
    }
    if (cards[1]) {
      cards[1].style.cursor = 'pointer';
      cards[1].title = 'Filter: Needs Review';
      cards[1].addEventListener('click', () => {
        selectedStatus = 'review';
        statusChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent === 'Needs Review'));
        renderFiltered();
      });
    }
    if (cards[2]) {
      cards[2].style.cursor = 'pointer';
      cards[2].title = 'Filter: Acknowledged';
      cards[2].addEventListener('click', () => {
        selectedStatus = 'acknowledged';
        statusChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent === 'Acknowledged'));
        renderFiltered();
      });
    }

    statStripHost.appendChild(strip);
  }

  function getFilteredFlags() {
    return allFlags.filter((f) => {
      if (selectedStatus === 'review' && f.acknowledgedAt) return false;
      if (selectedStatus === 'acknowledged' && !f.acknowledgedAt) return false;

      if (searchQuery) {
        const name = (namesById.get(f.userId) || `Tanod #${f.userId}`).toLowerCase();
        const basis = (f.calculationBasis || '').toLowerCase();
        if (!name.includes(searchQuery) && !basis.includes(searchQuery)) return false;
      }
      return true;
    });
  }

  function renderFiltered() {
    body.innerHTML = '';
    const filtered = getFilteredFlags();

    if (allFlags.length === 0) {
      renderEmpty(body);
      return;
    }

    const table = DataTable({
      columns: COLUMNS,
      rows: filtered,
      rowKey: (row) => row.flagId,
      caption: 'Fatigue Flags',
      emptyIcon: icons.batteryWarning,
      emptyMessage: (searchQuery || selectedStatus !== 'all') ? 'No fatigue flags match your filter.' : 'No fatigue flags recorded.',
      renderCell: (flag, key) => {
        const name = namesById.get(flag.userId) || `Tanod #${flag.userId}`;

        switch (key) {
          case 'tanod': {
            const cell = document.createElement('div');
            cell.className = 'user-identity-cell';
            const avatar = document.createElement('div');
            avatar.innerHTML = avatarInitials(name, 28);
            const info = document.createElement('div');
            info.className = 'user-identity-info';
            const nameEl = document.createElement('span');
            nameEl.className = 'user-identity-name';
            nameEl.textContent = name;
            info.appendChild(nameEl);
            cell.append(avatar.firstElementChild || avatar, info);
            return cell;
          }

          case 'riskMeter': {
            const hours = Number(flag.hoursWorked7Day);
            const overBy = hours - FATIGUE_THRESHOLD_HOURS;

            let tierClass = 'is-moderate';
            let tierLabel = 'Moderate';
            if (hours >= 70) {
              tierClass = 'is-severe';
              tierLabel = 'Severe Overload';
            } else if (hours >= 60) {
              tierClass = 'is-high';
              tierLabel = 'High Risk';
            }

            const card = document.createElement('div');
            card.className = 'fatigue-meter-card';

            // Header: hours & risk tier
            const header = document.createElement('div');
            header.className = 'fatigue-meter-header';

            const hoursSpan = document.createElement('span');
            hoursSpan.className = `fatigue-meter-hours ${tierClass}`;
            hoursSpan.textContent = `${hours.toFixed(1)} hrs / ${FATIGUE_THRESHOLD_HOURS}h max`;

            const tierBadge = document.createElement('span');
            tierBadge.className = `fatigue-meter-tier ${tierClass}`;
            tierBadge.textContent = tierLabel;

            header.append(hoursSpan, tierBadge);

            // Track & Fill Bar
            const track = document.createElement('div');
            track.className = 'fatigue-meter-track';

            const fill = document.createElement('div');
            fill.className = `fatigue-meter-fill ${tierClass}`;
            // Scale track against 80h ceiling for prominent visual gradient
            const percent = Math.min(100, Math.max(10, Math.round((hours / 80) * 100)));
            fill.style.width = `${percent}%`;
            track.appendChild(fill);

            // Sub text: overage and basis
            const overText = document.createElement('div');
            overText.className = 'fatigue-meter-over';
            const formattedBasis = (flag.calculationBasis || 'scheduled_hours').replace(/_/g, ' ');
            overText.textContent = overBy > 0
              ? `+${overBy.toFixed(1)}h over safe limit · ${formattedBasis}`
              : `At threshold limit · ${formattedBasis}`;

            card.append(header, track, overText);
            return card;
          }

          case 'flagged': {
            return new Date(flag.flaggedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
          }

          case 'action': {
            return renderActionCell(flag, name, canAcknowledge, onChanged);
          }

          default:
            return '';
        }
      },
    });

    body.appendChild(table);
  }
}

function renderActionCell(flag, name, canAcknowledge, onChanged) {
  const wrap = document.createElement('div');
  wrap.className = 'user-actions-group';

  if (flag.acknowledgedAt) {
    const wrapAck = document.createElement('div');
    wrapAck.style.cssText = 'display: flex; flex-direction: column; align-items: flex-end; gap: 2px;';

    const pill = document.createElement('span');
    pill.className = 'status-pill status-pill--success';
    pill.textContent = 'Acknowledged';

    const dateNote = document.createElement('span');
    dateNote.className = 'data-table__sub';
    dateNote.textContent = new Date(flag.acknowledgedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

    wrapAck.append(pill, dateNote);
    wrap.appendChild(wrapAck);
    return wrap;
  }

  const pill = document.createElement('span');
  pill.className = 'status-pill status-pill--critical';
  pill.textContent = 'Needs Review';
  wrap.appendChild(pill);

  if (canAcknowledge) {
    const ackButton = document.createElement('button');
    ackButton.className = 'user-action-btn user-action-btn--primary';
    ackButton.textContent = 'Acknowledge';
    ackButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      const confirmed = await confirmDialog({
        title: 'Acknowledge fatigue alert?',
        description: `Confirms ${name} has been reviewed for scheduled-hours overage. This action never deletes or hides the historical safety record.`,
        confirmLabel: 'Acknowledge',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;

      ackButton.disabled = true;
      ackButton.textContent = 'Acknowledging…';
      try {
        await acknowledgeFatigueFlag(flag.flagId);
        showToast(`Fatigue flag for ${name} acknowledged.`, { variant: 'success' });
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
