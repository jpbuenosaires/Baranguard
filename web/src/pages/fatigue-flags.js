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
  { key: 'riskMeter', label: `Hours When Flagged (Limit: ${FATIGUE_THRESHOLD_HOURS}h)` },
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
/**
 * Personnel > Fatigue flags tab.
 *
 * @param {HTMLElement} container tab body to render into
 * @param {{fullName:string, role:string}} user
 * @param {() => void} [onCountsChanged] re-fetches badge count
 * @param {(tabKey: string, data?: any) => void} [onSwitchTab] switches personnel tab
 */
export function renderFatigueFlagsTab(container, user, onCountsChanged, onSwitchTab) {
  const canAcknowledge = user.role === 'admin';
  const canLookUpNames = user.role === 'admin';
  const canViewScheduler = user.role === 'admin' && typeof onSwitchTab === 'function';

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
  searchInput.setAttribute('aria-label', 'Search fatigue flags');
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

            let tierClass = 'is-safe';
            let tierLabel = 'Under Limit';
            if (hours >= 70) {
              tierClass = 'is-severe';
              tierLabel = 'Severe Overload';
            } else if (hours >= 60) {
              tierClass = 'is-high';
              tierLabel = 'High Risk';
            } else if (hours >= FATIGUE_THRESHOLD_HOURS) {
              tierClass = 'is-moderate';
              tierLabel = 'Moderate Risk';
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

            // Track & Fill Bar with Threshold Marker Line
            const track = document.createElement('div');
            track.className = 'fatigue-meter-track';

            const marker = document.createElement('span');
            marker.className = 'fatigue-meter-threshold-marker';
            marker.title = `Safety limit: ${FATIGUE_THRESHOLD_HOURS}h / week`;
            track.appendChild(marker);

            const fill = document.createElement('div');
            fill.className = `fatigue-meter-fill ${tierClass}`;
            // Scale track against 80h ceiling for prominent visual gradient
            const percent = Math.min(100, Math.max(8, Math.round((hours / 80) * 100)));
            fill.style.width = `${percent}%`;
            track.appendChild(fill);

            // Sub text: accurate overage and basis with alert timestamp context
            const overText = document.createElement('div');
            overText.className = 'fatigue-meter-over';
            const alertDateStr = new Date(flag.flaggedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
            if (overBy > 0) {
              overText.textContent = `+${overBy.toFixed(1)}h over safe limit at alert (${alertDateStr})`;
            } else if (overBy === 0) {
              overText.textContent = `At threshold limit (56.0h) at alert (${alertDateStr})`;
            } else {
              overText.textContent = `${Math.abs(overBy).toFixed(1)}h under limit (historical alert) · ${alertDateStr}`;
            }

            card.append(header, track, overText);
            return card;
          }

          case 'flagged': {
            return new Date(flag.flaggedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
          }

          case 'action': {
            const onSwitchToScheduler = canViewScheduler
              ? () => onSwitchTab('scheduler', { searchQuery: name })
              : null;
            return renderActionCell(flag, name, canAcknowledge, onChanged, onSwitchToScheduler);
          }

          default:
            return '';
        }
      },
    });

    body.appendChild(table);
  }
}

function renderActionCell(flag, name, canAcknowledge, onChanged, onSwitchToScheduler) {
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
  } else {
    const pill = document.createElement('span');
    pill.className = 'status-pill status-pill--critical';
    pill.textContent = 'Needs Review';
    wrap.appendChild(pill);

    if (canAcknowledge) {
      const ackButton = document.createElement('button');
      ackButton.type = 'button';
      ackButton.className = 'user-action-btn user-action-btn--primary';
      ackButton.textContent = 'Acknowledge';
      ackButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        await handleAcknowledgeFlag(flag, name, ackButton, onChanged);
      });
      wrap.appendChild(ackButton);
    }
  }

  // Details button
  const detailsBtn = document.createElement('button');
  detailsBtn.type = 'button';
  detailsBtn.className = 'user-action-btn';
  detailsBtn.title = `View fatigue alert details for ${name}`;
  detailsBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">${icons.eye(13)}<span>Details</span></span>`;
  detailsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openFatigueDetailsModal({
      flag,
      name,
      canAcknowledge,
      onAcknowledge: () => handleAcknowledgeFlag(flag, name, null, onChanged),
      onViewInScheduler: onSwitchToScheduler,
    });
  });
  wrap.appendChild(detailsBtn);

  // View in Scheduler button (admin only)
  if (onSwitchToScheduler) {
    const schedBtn = document.createElement('button');
    schedBtn.type = 'button';
    schedBtn.className = 'user-action-btn';
    schedBtn.title = `Inspect ${name}'s schedule in the Scheduler`;
    schedBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">${icons.calendar(13)}<span>View Shifts</span></span>`;
    schedBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      onSwitchToScheduler();
    });
    wrap.appendChild(schedBtn);
  }

  return wrap;
}

async function handleAcknowledgeFlag(flag, name, buttonEl, onChanged) {
  const confirmed = await confirmDialog({
    title: 'Acknowledge fatigue alert?',
    description: `Confirms ${name} has been reviewed for scheduled-hours overage. This action never deletes or hides the historical safety record.`,
    confirmLabel: 'Acknowledge',
    cancelLabel: 'Cancel',
  });
  if (!confirmed) return;

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Acknowledging…';
  }
  try {
    await acknowledgeFatigueFlag(flag.flagId);
    showToast(`Fatigue flag for ${name} acknowledged.`, { variant: 'success' });
    onChanged();
  } catch (err) {
    const message = err instanceof ApiClientError ? err.message : 'Could not acknowledge this flag.';
    showToast(message, { variant: 'error' });
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Acknowledge';
    }
  }
}

/**
 * Detailed fatigue inspection dialog / drawer.
 */
function openFatigueDetailsModal({ flag, name, canAcknowledge, onAcknowledge, onViewInScheduler }) {
  const overlay = document.createElement('div');
  overlay.className = 'personnel-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'personnel-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', `Fatigue Alert Details for ${name}`);

  const header = document.createElement('div');
  header.className = 'personnel-modal__header';

  const title = document.createElement('h3');
  title.className = 'personnel-modal__title';
  title.innerHTML = `<span style="color:var(--color-critical);display:flex;align-items:center;">${icons.batteryWarning(20)}</span><span>Fatigue Alert Details</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'personnel-modal__close';
  closeBtn.setAttribute('aria-label', 'Close dialog');
  closeBtn.innerHTML = icons.x(18);
  const closeModal = () => {
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  };
  closeBtn.addEventListener('click', closeModal);
  header.append(title, closeBtn);

  const body = document.createElement('div');
  body.className = 'personnel-modal__body';

  // Identity block
  const identity = document.createElement('div');
  identity.className = 'user-identity-cell';
  identity.style.marginBottom = 'var(--spacing-xs)';
  const avatar = document.createElement('div');
  avatar.innerHTML = avatarInitials(name, 36);
  const idInfo = document.createElement('div');
  idInfo.className = 'user-identity-info';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'user-identity-name';
  nameSpan.style.fontSize = 'var(--font-size-md)';
  nameSpan.textContent = name;
  const roleSpan = document.createElement('span');
  roleSpan.className = 'user-identity-username';
  roleSpan.textContent = `Tanod ID #${flag.userId}`;
  idInfo.append(nameSpan, roleSpan);
  identity.append(avatar.firstElementChild || avatar, idInfo);

  // 4-stat metrics grid
  const hours = Number(flag.hoursWorked7Day);
  const overBy = hours - FATIGUE_THRESHOLD_HOURS;
  let tierLabel = 'Under Limit';
  let tierClass = 'is-safe';
  if (hours >= 70) {
    tierClass = 'is-severe';
    tierLabel = 'Severe Overload';
  } else if (hours >= 60) {
    tierClass = 'is-high';
    tierLabel = 'High Risk';
  } else if (hours >= FATIGUE_THRESHOLD_HOURS) {
    tierClass = 'is-moderate';
    tierLabel = 'Moderate Risk';
  }

  const summaryGrid = document.createElement('div');
  summaryGrid.className = 'fatigue-details-summary';

  // Stat 1: Hours When Flagged
  const stat1 = document.createElement('div');
  stat1.className = 'fatigue-details-stat';
  stat1.innerHTML = `
    <span class="fatigue-details-stat__label">Hours When Flagged</span>
    <span class="fatigue-details-stat__value ${tierClass}">
      ${hours.toFixed(1)} hrs
      <span class="fatigue-meter-tier ${tierClass}">${tierLabel}</span>
    </span>
  `;

  // Stat 2: Limit Comparison
  const stat2 = document.createElement('div');
  stat2.className = 'fatigue-details-stat';
  const limitDiffText = overBy > 0
    ? `+${overBy.toFixed(1)}h over`
    : (overBy === 0 ? 'At 56h limit' : `${Math.abs(overBy).toFixed(1)}h under`);
  stat2.innerHTML = `
    <span class="fatigue-details-stat__label">Safety Threshold</span>
    <span class="fatigue-details-stat__value">
      ${FATIGUE_THRESHOLD_HOURS}h / wk
      <span style="font-size:0.75rem;font-weight:600;color:var(--color-text-secondary);">${limitDiffText}</span>
    </span>
  `;

  // Stat 3: Status
  const stat3 = document.createElement('div');
  stat3.className = 'fatigue-details-stat';
  const statusPill = flag.acknowledgedAt
    ? `<span class="status-pill status-pill--success">Acknowledged</span>`
    : `<span class="status-pill status-pill--critical">Needs Review</span>`;
  stat3.innerHTML = `
    <span class="fatigue-details-stat__label">Review Status</span>
    <div style="margin-top:2px;">${statusPill}</div>
  `;

  // Stat 4: Flagged At
  const stat4 = document.createElement('div');
  stat4.className = 'fatigue-details-stat';
  stat4.innerHTML = `
    <span class="fatigue-details-stat__label">Alert Timestamp</span>
    <span class="fatigue-details-stat__value" style="font-size:0.8125rem;">
      ${new Date(flag.flaggedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
    </span>
  `;

  summaryGrid.append(stat1, stat2, stat3, stat4);

  // Triggering Shift Section
  const shiftSection = document.createElement('div');
  shiftSection.className = 'fatigue-details-section';
  const shiftTitle = document.createElement('span');
  shiftTitle.className = 'fatigue-details-section__title';
  shiftTitle.textContent = 'Triggering Shift & Calculation Basis';

  const shiftCard = document.createElement('div');
  shiftCard.className = 'fatigue-details-card';
  const formattedBasis = (flag.calculationBasis || 'scheduled_hours').replace(/_/g, ' ');
  let shiftTimeStr = '';
  if (flag.shiftStartAt && flag.shiftEndAt) {
    const s = new Date(flag.shiftStartAt);
    const e = new Date(flag.shiftEndAt);
    const durHours = ((e.getTime() - s.getTime()) / (1000 * 60 * 60)).toFixed(1);
    shiftTimeStr = `<div><strong>Shift Schedule:</strong> ${s.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${s.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${e.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${durHours} hrs)</div>`;
  }
  const zoneStr = flag.shiftPatrolZone ? `<div><strong>Patrol Zone:</strong> ${flag.shiftPatrolZone}</div>` : '';

  shiftCard.innerHTML = `
    <div><strong>Triggering Shift ID:</strong> #${flag.shiftId}</div>
    ${zoneStr}
    ${shiftTimeStr}
    <div><strong>Basis:</strong> ${formattedBasis} (rolling 7-day cumulative window anchored to shift end)</div>
    <div style="font-size:0.75rem;color:var(--color-text-secondary);margin-top:4px;">
      ℹ️ This alert reflects the cumulative hours at the time the flag occurred (${new Date(flag.flaggedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}). Click <em>Open in Scheduler</em> below to inspect live assignments.
    </div>
  `;
  shiftSection.append(shiftTitle, shiftCard);

  // Audit / Compliance Section
  const auditSection = document.createElement('div');
  auditSection.className = 'fatigue-details-section';
  const auditTitle = document.createElement('span');
  auditTitle.className = 'fatigue-details-section__title';
  auditTitle.textContent = 'Safety Review & Audit Trail';

  const auditCard = document.createElement('div');
  auditCard.className = 'fatigue-details-card';
  if (flag.acknowledgedAt) {
    const ackByName = flag.acknowledgedByName || (flag.acknowledgedBy ? `Admin #${flag.acknowledgedBy}` : 'Administrator');
    auditCard.innerHTML = `
      <div><strong>Reviewed By:</strong> ${ackByName}</div>
      <div><strong>Acknowledged At:</strong> ${new Date(flag.acknowledgedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
      <div style="font-size:0.75rem;color:var(--color-text-secondary);margin-top:2px;">
        Acknowledgment confirms administrative review and preserves this safety record in the permanent audit trail.
      </div>
    `;
  } else {
    auditCard.innerHTML = `
      <div style="color:var(--color-critical);font-weight:600;">Pending Administrative Review</div>
      <div style="font-size:0.75rem;color:var(--color-text-secondary);">
        This tanod is scheduled at or beyond the 56-hour weekly limit. Check upcoming shifts or swap assignments in the Scheduler before acknowledging.
      </div>
    `;
  }
  auditSection.append(auditTitle, auditCard);

  body.append(identity, summaryGrid, shiftSection, auditSection);

  // Footer Actions
  const footer = document.createElement('div');
  footer.className = 'personnel-modal__footer';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'ghost';
  closeButton.textContent = 'Close';
  closeButton.addEventListener('click', closeModal);
  footer.appendChild(closeButton);

  if (onViewInScheduler) {
    const viewSchedBtn = document.createElement('button');
    viewSchedBtn.type = 'button';
    viewSchedBtn.className = 'user-action-btn';
    viewSchedBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">${icons.calendar(14)}<span>Open in Scheduler</span></span>`;
    viewSchedBtn.addEventListener('click', () => {
      closeModal();
      onViewInScheduler();
    });
    footer.appendChild(viewSchedBtn);
  }

  if (canAcknowledge && !flag.acknowledgedAt && onAcknowledge) {
    const ackModalBtn = document.createElement('button');
    ackModalBtn.type = 'button';
    ackModalBtn.className = 'primary';
    ackModalBtn.textContent = 'Acknowledge Alert';
    ackModalBtn.addEventListener('click', async () => {
      closeModal();
      await onAcknowledge();
    });
    footer.appendChild(ackModalBtn);
  }

  modal.append(header, body, footer);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', handleKeyDown);
    }
  };
  document.addEventListener('keydown', handleKeyDown);

  document.body.appendChild(overlay);
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
