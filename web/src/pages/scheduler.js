/**
 * scheduler.js — Personnel > Scheduler Tab.
 * Overhauled UI/UX:
 * - Visual status badges: Active Now (with pulse dot), Upcoming, Completed
 * - Formatted date/time with calculated shift duration (e.g. "8 hrs")
 * - Patrol zone tags with location icon styling
 * - Tanod identity cell with avatar initials
 * - Quick shift duration presets (Morning 06-14, Afternoon 14-22, Night 22-06)
 * - Clean Edit Shift modal dialog replacing awkward inline row replacement
 * - Interactive StatStrip and filter bar with search and status chips
 */

import { getUsers, getShifts, createShift, updateShift, getBarangays, ApiClientError } from '../api/apiClient.js';
import { DataTable } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';
import { avatarInitials } from '../components/Avatar.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';

const SCHEDULE_COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'tanod', label: 'Assigned Tanod' },
  { key: 'zone', label: 'Patrol Zone' },
  { key: 'timeRange', label: 'Schedule & Duration' },
  { key: 'actions', label: 'Actions', align: 'right' },
];

/**
 * Personnel > Scheduler tab.
 *
 * @param {HTMLElement} container tab body to render into
 * @param {{fullName:string, role:string, barangayId?:number}} user
 * @param {ReturnType<import('../components/PageHeader.js').PageHeader>} [pageHeader]
 * @param {{searchQuery?: string}} [initialData]
 */
export function renderSchedulerTab(container, user, pageHeader, initialData) {
  // Stat Strip Host
  const statStripHost = document.createElement('div');
  container.appendChild(statStripHost);

  // Split Panel Layout
  const layout = document.createElement('div');
  layout.className = 'split-panel';
  layout.style.alignItems = 'flex-start';
  container.appendChild(layout);

  const listPane = document.createElement('div');
  listPane.style.flex = '1 1 65%';

  let formPane = document.createElement('div');
  formPane.style.flex = '1 1 35%';
  layout.append(listPane, formPane);

  let tanods = [];
  let shifts = [];
  let barangayName = 'Barangay Peacekeeping Watch';
  let selectedStatus = 'all';
  let searchQuery = initialData?.searchQuery ? initialData.searchQuery.trim().toLowerCase() : '';

  if (pageHeader && pageHeader.actions) {
    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.id = 'preview-schedule-print-btn';
    printBtn.className = 'ghost';
    printBtn.innerHTML = `${icons.printer(15)} <span>Preview & Print Schedule</span>`;
    printBtn.addEventListener('click', () => {
      openSchedulePrintModal({
        shifts: getFilteredShifts(),
        allShifts: shifts,
        tanods,
        selectedStatus,
        searchQuery,
        user,
        barangayName,
      });
    });
    pageHeader.actions.appendChild(printBtn);
  }

  getBarangays().then((list) => {
    const found = list.find((b) => b.barangayId === (user?.barangayId ?? 1)) || list[0];
    if (found) barangayName = `Barangay ${found.name}`;
  }).catch(() => {});

  load();

  async function load() {
    renderLoading(listPane);
    try {
      const [tanodsRes, shiftsRes] = await Promise.all([
        getUsers({ role: 'tanod', limit: 100 }),
        getShifts({ limit: 100 }),
      ]);
      tanods = tanodsRes.items;
      shifts = shiftsRes.items;

      renderStatStrip();
      const newFormPane = buildNewShiftForm(tanods, load, shifts);
      layout.replaceChild(newFormPane, formPane);
      formPane = newFormPane;

      renderShiftsTable();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the scheduler.';
      renderError(listPane, message, load);
    }
  }

  function renderStatStrip() {
    statStripHost.innerHTML = '';
    const now = Date.now();
    let activeNow = 0;
    let upcoming = 0;
    let completed = 0;

    shifts.forEach((s) => {
      const start = new Date(s.startAt).getTime();
      const end = new Date(s.endAt).getTime();
      if (now >= start && now <= end) activeNow++;
      else if (now < start) upcoming++;
      else completed++;
    });

    const strip = StatStrip({
      items: [
        { label: 'Total Shifts', value: shifts.length },
        { label: 'Active Now', value: activeNow, tone: 'success' },
        { label: 'Upcoming', value: upcoming, tone: 'info' },
        { label: 'Completed', value: completed },
      ],
    });

    const cards = strip.querySelectorAll('.stat-card');
    if (cards[0]) {
      cards[0].style.cursor = 'pointer';
      cards[0].title = 'Show all shifts';
      cards[0].addEventListener('click', () => {
        selectedStatus = 'all';
        statusChipBtns.forEach((b, i) => b.classList.toggle('is-active', i === 0));
        renderShiftsTable();
      });
    }
    if (cards[1]) {
      cards[1].style.cursor = 'pointer';
      cards[1].title = 'Filter: Active Now';
      cards[1].addEventListener('click', () => {
        selectedStatus = 'active';
        statusChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent.includes('Active')));
        renderShiftsTable();
      });
    }
    if (cards[2]) {
      cards[2].style.cursor = 'pointer';
      cards[2].title = 'Filter: Upcoming';
      cards[2].addEventListener('click', () => {
        selectedStatus = 'upcoming';
        statusChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent.includes('Upcoming')));
        renderShiftsTable();
      });
    }
    if (cards[3]) {
      cards[3].style.cursor = 'pointer';
      cards[3].title = 'Filter: Completed';
      cards[3].addEventListener('click', () => {
        selectedStatus = 'completed';
        statusChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent.includes('Completed')));
        renderShiftsTable();
      });
    }

    statStripHost.appendChild(strip);
  }

  // Filter Bar elements
  const filterBar = document.createElement('div');
  filterBar.className = 'personnel-filter-bar';
  filterBar.style.marginBottom = 'var(--spacing-md)';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'personnel-search-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'personnel-search-icon';
  searchIcon.innerHTML = icons.search(16);
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'personnel-search-input';
  searchInput.placeholder = 'Search by tanod or patrol zone…';
  if (initialData?.searchQuery) {
    searchInput.value = initialData.searchQuery;
  }
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderShiftsTable();
  });
  searchWrap.append(searchIcon, searchInput);

  const filterChipsWrap = document.createElement('div');
  filterChipsWrap.className = 'personnel-filter-bar__right';

  const statusOptions = [
    { id: 'all', label: 'All Shifts' },
    { id: 'active', label: 'Active Now' },
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'completed', label: 'Completed' },
  ];

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
      renderShiftsTable();
    });
    statusChipBtns.push(chip);
    filterChipsWrap.appendChild(chip);
  });

  filterBar.append(searchWrap, filterChipsWrap);

  function getFilteredShifts() {
    const now = Date.now();
    return shifts.filter((s) => {
      const start = new Date(s.startAt).getTime();
      const end = new Date(s.endAt).getTime();
      const status = (now >= start && now <= end) ? 'active' : (now < start ? 'upcoming' : 'completed');

      if (selectedStatus !== 'all' && status !== selectedStatus) return false;

      if (searchQuery) {
        const tanod = tanods.find((t) => t.userId === s.userId);
        const name = (tanod ? tanod.fullName : 'Unassigned').toLowerCase();
        const zone = (s.patrolZone || '').toLowerCase();
        if (!name.includes(searchQuery) && !zone.includes(searchQuery)) return false;
      }
      return true;
    });
  }

  function renderShiftsTable() {
    listPane.innerHTML = '';
    listPane.appendChild(filterBar);

    const filtered = getFilteredShifts();

    if (shifts.length === 0) {
      renderEmpty(listPane);
      return;
    }

    const table = DataTable({
      columns: SCHEDULE_COLUMNS,
      rows: filtered,
      rowKey: (row) => row.shiftId,
      caption: 'Shift Schedule',
      emptyIcon: icons.calendar,
      emptyMessage: (searchQuery || selectedStatus !== 'all') ? 'No shifts match your filter.' : 'No shifts scheduled yet.',
      renderCell: (shift, key) => {
        switch (key) {
          case 'status': {
            const status = getShiftStatus(shift.startAt, shift.endAt);
            const pill = document.createElement('span');
            pill.className = status.className;
            pill.textContent = status.label;
            return pill;
          }

          case 'tanod': {
            const tanod = tanods.find((t) => t.userId === shift.userId);
            const cell = document.createElement('div');
            cell.className = 'user-identity-cell';

            if (tanod) {
              const avatar = document.createElement('div');
              avatar.innerHTML = avatarInitials(tanod.fullName, 28);
              const info = document.createElement('div');
              info.className = 'user-identity-info';
              const name = document.createElement('span');
              name.className = 'user-identity-name';
              name.textContent = tanod.fullName;
              info.appendChild(name);
              cell.append(avatar.firstElementChild || avatar, info);
            } else {
              const unassigned = document.createElement('span');
              unassigned.className = 'text-tertiary';
              unassigned.style.fontStyle = 'italic';
              unassigned.textContent = 'Unassigned';
              cell.appendChild(unassigned);
            }
            return cell;
          }

          case 'zone': {
            if (!shift.patrolZone) {
              return '<span class="text-tertiary">—</span>';
            }
            const tag = document.createElement('span');
            tag.className = 'shift-zone-tag';
            tag.innerHTML = `<span style="color:var(--color-primary);">${icons.map(14)}</span><span>${escapeHtml(shift.patrolZone)}</span>`;
            return tag;
          }

          case 'timeRange': {
            const wrap = document.createElement('div');
            wrap.className = 'shift-time-range-wrap';

            const dates = document.createElement('span');
            dates.className = 'shift-time-dates';
            dates.textContent = formatShiftTimeRange(shift.startAt, shift.endAt);

            const duration = document.createElement('span');
            duration.className = 'shift-time-duration';
            duration.textContent = formatDuration(shift.startAt, shift.endAt);

            wrap.append(dates, duration);
            return wrap;
          }

          case 'actions': {
            const button = document.createElement('button');
            button.className = 'user-action-btn';
            button.type = 'button';
            button.textContent = 'Edit Shift';
            button.addEventListener('click', (event) => {
              event.stopPropagation();
              openEditModal(shift, tanods, load, shifts);
            });
            return button;
          }

          default:
            return '';
        }
      },
    });

    listPane.appendChild(table);
  }
}

function getShiftStatus(startAt, endAt) {
  const now = Date.now();
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();

  if (now >= start && now <= end) {
    return { id: 'active', label: 'Active Now', className: 'shift-status-pill shift-status-pill--active' };
  } else if (now < start) {
    return { id: 'upcoming', label: 'Upcoming', className: 'shift-status-pill shift-status-pill--upcoming' };
  } else {
    return { id: 'completed', label: 'Completed', className: 'shift-status-pill shift-status-pill--completed' };
  }
}

function formatDuration(startAt, endAt) {
  const ms = new Date(endAt).getTime() - new Date(startAt).getTime();
  if (isNaN(ms) || ms <= 0) return '';
  const hours = ms / (1000 * 60 * 60);
  return hours % 1 === 0 ? `Duration: ${hours} hrs` : `Duration: ${hours.toFixed(1)} hrs`;
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

const FATIGUE_THRESHOLD_HOURS = 56.0;

/**
 * Calculates total scheduled shift hours for a tanod in the 7-day rolling window ending at targetEndAt.
 * Mirrors backend FatigueCalculator logic: window = [end_at - 7 days, end_at).
 */
function calculateTanodHoursInWindow(shifts, userId, targetEndAt, excludeShiftId = null) {
  if (!userId || !targetEndAt || !Array.isArray(shifts)) return 0;
  const end = new Date(targetEndAt).getTime();
  if (isNaN(end)) return 0;
  const windowStart = end - (7 * 24 * 60 * 60 * 1000);

  let sum = 0;
  for (const s of shifts) {
    if (s.userId !== userId) continue;
    if (excludeShiftId && s.shiftId === excludeShiftId) continue;
    const sStart = new Date(s.startAt).getTime();
    const sEnd = new Date(s.endAt).getTime();
    if (isNaN(sStart) || isNaN(sEnd) || sEnd <= sStart) continue;
    if (sStart >= windowStart && sStart < end) {
      sum += (sEnd - sStart) / (1000 * 60 * 60);
    }
  }
  return Math.round(sum * 10) / 10;
}

/**
 * Computes projected rolling hours if the given shift is assigned.
 */
function previewShiftFatigue(shifts, userId, startAt, endAt, excludeShiftId = null) {
  if (!userId || !startAt || !endAt || !Array.isArray(shifts)) return null;
  const s = new Date(startAt).getTime();
  const e = new Date(endAt).getTime();
  if (isNaN(s) || isNaN(e) || e <= s) return null;

  const shiftDuration = (e - s) / (1000 * 60 * 60);
  const priorHours = calculateTanodHoursInWindow(shifts, userId, endAt, excludeShiftId);
  const projectedHours = priorHours + shiftDuration;
  const overBy = projectedHours - FATIGUE_THRESHOLD_HOURS;

  let status = 'safe';
  if (projectedHours > FATIGUE_THRESHOLD_HOURS) {
    status = 'critical';
  } else if (projectedHours >= 48) {
    status = 'caution';
  }

  return {
    shiftDuration,
    priorHours,
    projectedHours,
    overBy,
    status,
  };
}

function updateFatigueCalloutElement(calloutEl, preview, tanodName = 'this Tanod') {
  if (!preview) {
    calloutEl.hidden = true;
    calloutEl.innerHTML = '';
    return;
  }

  calloutEl.hidden = false;
  if (preview.status === 'critical') {
    calloutEl.className = 'scheduler-fatigue-callout scheduler-fatigue-callout--critical';
    calloutEl.innerHTML = `
      <div class="scheduler-fatigue-callout__title">
        <span style="display:flex;align-items:center;">${icons.batteryWarning(16)}</span>
        <span>Fatigue Safety Warning: Exceeds Safe Limit</span>
      </div>
      <div class="scheduler-fatigue-callout__desc">
        Adding this <strong>${preview.shiftDuration.toFixed(1)}h</strong> shift brings ${tanodName}'s 7-day schedule to <strong>${preview.projectedHours.toFixed(1)} hrs</strong> (+${preview.overBy.toFixed(1)}h over the 56h threshold). A fatigue safety flag will be triggered.
      </div>
    `;
  } else if (preview.status === 'caution') {
    calloutEl.className = 'scheduler-fatigue-callout scheduler-fatigue-callout--warning';
    calloutEl.innerHTML = `
      <div class="scheduler-fatigue-callout__title">
        <span style="display:flex;align-items:center;">${icons.alertTriangle(16)}</span>
        <span>Approaching Weekly Safety Limit</span>
      </div>
      <div class="scheduler-fatigue-callout__desc">
        Adding this <strong>${preview.shiftDuration.toFixed(1)}h</strong> shift brings ${tanodName} to <strong>${preview.projectedHours.toFixed(1)} hrs / 56h max</strong> (${(FATIGUE_THRESHOLD_HOURS - preview.projectedHours).toFixed(1)}h remaining before safety limit).
      </div>
    `;
  } else {
    calloutEl.className = 'scheduler-fatigue-callout scheduler-fatigue-callout--success';
    calloutEl.innerHTML = `
      <div class="scheduler-fatigue-callout__title">
        <span style="display:flex;align-items:center;">${icons.checkCircle(16)}</span>
        <span>Schedule Capacity: Safe</span>
      </div>
      <div class="scheduler-fatigue-callout__desc">
        Projected 7-day schedule: <strong>${preview.projectedHours.toFixed(1)} hrs / 56h max</strong> (within safe operational limits).
      </div>
    `;
  }
}

/**
 * Builds the right-hand form for creating a new shift with preset buttons.
 */
function buildNewShiftForm(tanods, onCreated, shifts = []) {
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.style.cssText = 'margin-top:0; margin-bottom: var(--spacing-sm); display:flex; align-items:center; gap:0.5rem;';
  heading.innerHTML = `<span aria-hidden="true">${icons.calendar(20)}</span><span>New Shift</span>`;

  const form = document.createElement('form');
  form.className = 'form-stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  // Preset Buttons
  const presetsWrap = document.createElement('div');
  presetsWrap.className = 'shift-presets-wrap';

  const presetsLabel = document.createElement('label');
  presetsLabel.className = 'shift-presets-label';
  presetsLabel.textContent = 'Quick Presets (Today)';

  const presetsRow = document.createElement('div');
  presetsRow.className = 'shift-presets-row';

  const presets = [
    { label: 'Morning', hours: '06:00 – 14:00', type: 'morning' },
    { label: 'Afternoon', hours: '14:00 – 22:00', type: 'afternoon' },
    { label: 'Night', hours: '22:00 – 06:00', type: 'night' },
  ];

  presets.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shift-preset-btn';
    btn.innerHTML = `${p.label}<small>${p.hours}</small>`;
    btn.addEventListener('click', () => {
      applyPreset(p.type, startInput, endInput);
      updateFormFatiguePreview();
    });
    presetsRow.appendChild(btn);
  });

  presetsWrap.append(presetsLabel, presetsRow);

  // Tanod Select
  const tanodLabel = document.createElement('label');
  tanodLabel.className = 'label';
  tanodLabel.htmlFor = 'scheduler-new-tanod';
  tanodLabel.textContent = 'Tanod';
  const tanodSelect = document.createElement('select');
  tanodSelect.id = 'scheduler-new-tanod';
  tanodSelect.className = 'personnel-form-select';
  for (const t of tanods) {
    const currentHours = calculateTanodHoursInWindow(shifts, t.userId, new Date().toISOString());
    const option = document.createElement('option');
    option.value = String(t.userId);
    const badge = currentHours > FATIGUE_THRESHOLD_HOURS ? ' [Over Limit]' : (currentHours >= 48 ? ' [Near Limit]' : '');
    option.textContent = `${t.fullName} (${currentHours.toFixed(1)}h scheduled${badge})`;
    tanodSelect.appendChild(option);
  }

  // Patrol Zone
  const zoneLabel = document.createElement('label');
  zoneLabel.className = 'label';
  zoneLabel.htmlFor = 'scheduler-new-zone';
  zoneLabel.textContent = 'Patrol Zone (optional)';
  const zoneInput = document.createElement('input');
  zoneInput.id = 'scheduler-new-zone';
  zoneInput.type = 'text';
  zoneInput.className = 'personnel-form-input';
  zoneInput.placeholder = 'e.g. Zone 1 - Riverside';

  // Start / End
  const startLabel = document.createElement('label');
  startLabel.className = 'label';
  startLabel.htmlFor = 'scheduler-new-start';
  startLabel.textContent = 'Start Date & Time';
  const startInput = document.createElement('input');
  startInput.id = 'scheduler-new-start';
  startInput.type = 'datetime-local';
  startInput.className = 'personnel-form-input';
  startInput.required = true;

  const endLabel = document.createElement('label');
  endLabel.className = 'label';
  endLabel.htmlFor = 'scheduler-new-end';
  endLabel.textContent = 'End Date & Time';
  const endInput = document.createElement('input');
  endInput.id = 'scheduler-new-end';
  endInput.type = 'datetime-local';
  endInput.className = 'personnel-form-input';
  endInput.required = true;

  // Proactive Fatigue Preview Callout
  const fatigueCallout = document.createElement('div');
  fatigueCallout.className = 'scheduler-fatigue-callout';
  fatigueCallout.hidden = true;

  const updateFormFatiguePreview = () => {
    const selectedUserId = Number(tanodSelect.value);
    const selectedTanod = tanods.find((t) => t.userId === selectedUserId);
    const tanodName = selectedTanod ? selectedTanod.fullName : 'this Tanod';
    const preview = previewShiftFatigue(shifts, selectedUserId, startInput.value, endInput.value);
    updateFatigueCalloutElement(fatigueCallout, preview, tanodName);
  };

  tanodSelect.addEventListener('change', updateFormFatiguePreview);
  startInput.addEventListener('input', updateFormFatiguePreview);
  endInput.addEventListener('input', updateFormFatiguePreview);

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.style.marginTop = 'var(--spacing-xs)';
  submitButton.innerHTML = `<span aria-hidden="true">${icons.plus(16)}</span><span>Create Shift</span>`;

  form.append(
    errorBox,
    presetsWrap,
    tanodLabel, tanodSelect,
    zoneLabel, zoneInput,
    startLabel, startInput,
    endLabel, endInput,
    fatigueCallout,
    submitButton
  );
  card.append(heading, form);

  if (tanods.length === 0) {
    form.hidden = true;
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'No Tanods exist in this barangay yet.';
    card.appendChild(note);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    if (!startInput.value || !endInput.value) {
      errorBox.textContent = 'Start and end times are both required.';
      errorBox.hidden = false;
      return;
    }
    if (new Date(endInput.value) <= new Date(startInput.value)) {
      errorBox.textContent = 'End time must be after the start time.';
      errorBox.hidden = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Creating…';
    try {
      await createShift({
        userId: Number(tanodSelect.value),
        patrolZone: zoneInput.value.trim() || null,
        startAt: startInput.value,
        endAt: endInput.value,
        requestId: crypto.randomUUID(),
      });
      showToast('Shift successfully created.', { variant: 'success' });
      zoneInput.value = '';
      startInput.value = '';
      endInput.value = '';
      fatigueCallout.hidden = true;
      onCreated();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not create this shift.';
      errorBox.textContent = message;
      errorBox.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = `<span aria-hidden="true">${icons.plus(16)}</span><span>Create Shift</span>`;
    }
  });

  return card;
}

function applyPreset(type, startInput, endInput) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');

  if (type === 'morning') {
    startInput.value = `${y}-${m}-${d}T06:00`;
    endInput.value = `${y}-${m}-${d}T14:00`;
  } else if (type === 'afternoon') {
    startInput.value = `${y}-${m}-${d}T14:00`;
    endInput.value = `${y}-${m}-${d}T22:00`;
  } else if (type === 'night') {
    startInput.value = `${y}-${m}-${d}T22:00`;
    const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const ndY = nextDay.getFullYear();
    const ndM = String(nextDay.getMonth() + 1).padStart(2, '0');
    const ndD = String(nextDay.getDate()).padStart(2, '0');
    endInput.value = `${ndY}-${ndM}-${ndD}T06:00`;
  }
}

/**
 * Edit Shift Modal
 */
function openEditModal(shift, tanods, onSaved, shifts = []) {
  const overlay = document.createElement('div');
  overlay.className = 'personnel-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'personnel-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'personnel-modal__header';

  const title = document.createElement('h3');
  title.className = 'personnel-modal__title';
  title.innerHTML = `<span aria-hidden="true">${icons.calendar(20)}</span><span>Edit Shift Schedule</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'personnel-modal__close';
  closeBtn.innerHTML = icons.x(18);
  closeBtn.addEventListener('click', () => document.body.removeChild(overlay));

  header.append(title, closeBtn);

  const form = document.createElement('form');

  const body = document.createElement('div');
  body.className = 'personnel-modal__body';

  const grid = document.createElement('div');
  grid.className = 'personnel-form-grid';

  // Tanod select
  const tanodField = document.createElement('div');
  tanodField.className = 'personnel-form-field personnel-form-field--full';
  const tanodLabel = document.createElement('label');
  tanodLabel.className = 'personnel-form-label';
  tanodLabel.textContent = 'Assigned Tanod';
  const tanodSelect = document.createElement('select');
  tanodSelect.className = 'personnel-form-select';
  const unassignedOpt = document.createElement('option');
  unassignedOpt.value = '';
  unassignedOpt.textContent = 'Unassigned';
  tanodSelect.appendChild(unassignedOpt);
  for (const t of tanods) {
    const currentHours = calculateTanodHoursInWindow(shifts, t.userId, new Date().toISOString(), shift.shiftId);
    const opt = document.createElement('option');
    opt.value = String(t.userId);
    const badge = currentHours > FATIGUE_THRESHOLD_HOURS ? ' [Over Limit]' : (currentHours >= 48 ? ' [Near Limit]' : '');
    opt.textContent = `${t.fullName} (${currentHours.toFixed(1)}h scheduled${badge})`;
    if (t.userId === shift.userId) opt.selected = true;
    tanodSelect.appendChild(opt);
  }
  tanodField.append(tanodLabel, tanodSelect);

  // Patrol Zone
  const zoneField = document.createElement('div');
  zoneField.className = 'personnel-form-field personnel-form-field--full';
  const zoneLabel = document.createElement('label');
  zoneLabel.className = 'personnel-form-label';
  zoneLabel.textContent = 'Patrol Zone';
  const zoneInput = document.createElement('input');
  zoneInput.type = 'text';
  zoneInput.className = 'personnel-form-input';
  zoneInput.value = shift.patrolZone || '';
  zoneInput.placeholder = 'e.g. Zone 1 - Riverside';
  zoneField.append(zoneLabel, zoneInput);

  // Start & End
  const startField = document.createElement('div');
  startField.className = 'personnel-form-field';
  const startLabel = document.createElement('label');
  startLabel.className = 'personnel-form-label';
  startLabel.textContent = 'Start Time';
  const startInput = document.createElement('input');
  startInput.type = 'datetime-local';
  startInput.className = 'personnel-form-input';
  startInput.value = toDatetimeLocal(shift.startAt);
  startField.append(startLabel, startInput);

  const endField = document.createElement('div');
  endField.className = 'personnel-form-field';
  const endLabel = document.createElement('label');
  endLabel.className = 'personnel-form-label';
  endLabel.textContent = 'End Time';
  const endInput = document.createElement('input');
  endInput.type = 'datetime-local';
  endInput.className = 'personnel-form-input';
  endInput.value = toDatetimeLocal(shift.endAt);
  endField.append(endLabel, endInput);

  grid.append(tanodField, zoneField, startField, endField);

  // Proactive Fatigue Preview Callout in Edit Modal
  const fatigueCallout = document.createElement('div');
  fatigueCallout.className = 'scheduler-fatigue-callout';
  fatigueCallout.hidden = true;

  const updateEditFatiguePreview = () => {
    const selectedUserId = Number(tanodSelect.value);
    if (!selectedUserId) {
      fatigueCallout.hidden = true;
      fatigueCallout.innerHTML = '';
      return;
    }
    const selectedTanod = tanods.find((t) => t.userId === selectedUserId);
    const tanodName = selectedTanod ? selectedTanod.fullName : 'this Tanod';
    const preview = previewShiftFatigue(shifts, selectedUserId, startInput.value, endInput.value, shift.shiftId);
    updateFatigueCalloutElement(fatigueCallout, preview, tanodName);
  };

  tanodSelect.addEventListener('change', updateEditFatiguePreview);
  startInput.addEventListener('input', updateEditFatiguePreview);
  endInput.addEventListener('input', updateEditFatiguePreview);

  updateEditFatiguePreview();

  body.append(grid, fatigueCallout);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'personnel-modal__footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => document.body.removeChild(overlay));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'primary';
  saveBtn.textContent = 'Save Changes';

  footer.append(cancelBtn, saveBtn);
  form.append(body, footer);
  modal.append(header, form);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) document.body.removeChild(overlay);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (new Date(endInput.value) <= new Date(startInput.value)) {
      showToast('End time must be after the start time.', { variant: 'error' });
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await updateShift(shift.shiftId, {
        userId: tanodSelect.value ? Number(tanodSelect.value) : null,
        patrolZone: zoneInput.value.trim() || null,
        startAt: startInput.value,
        endAt: endInput.value,
        version: shift.version ?? 1,
      });
      showToast('Shift updated successfully.', { variant: 'success' });
      document.body.removeChild(overlay);
      onSaved();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not update this shift.';
      showToast(message, { variant: 'error' });
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  });
}

function toDatetimeLocal(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading scheduler');
  for (let i = 0; i < 4; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--row';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderEmpty(container) {
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = '<h3>No shifts scheduled yet</h3><p>Use the form to create the first shift.</p>';
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

function openSchedulePrintModal({ shifts, allShifts, tanods, selectedStatus, searchQuery, user, barangayName }) {
  const now = Date.now();
  let activeCount = 0;
  let upcomingCount = 0;
  for (const s of allShifts) {
    const start = new Date(s.startAt).getTime();
    const end = new Date(s.endAt).getTime();
    if (now >= start && now <= end) activeCount += 1;
    else if (now < start) upcomingCount += 1;
  }

  const filterDesc = selectedStatus === 'all'
    ? (searchQuery ? `Filtered ("${searchQuery}")` : 'All Scheduled Shifts')
    : `${selectedStatus.toUpperCase()}${searchQuery ? ` ("${searchQuery}")` : ''}`;

  const shiftRowsHtml = shifts.length > 0
    ? shifts.map((shift) => {
        const tanod = tanods.find((t) => t.userId === shift.userId);
        const tanodName = tanod ? tanod.fullName : 'Unassigned';
        const status = getShiftStatus(shift.startAt, shift.endAt);
        const duration = formatDuration(shift.startAt, shift.endAt).replace(/^Duration:\s*/i, '') || '—';
        return `
          <tr>
            <td class="print-sheet__table--mono">#${escapeHtml(String(shift.shiftId))}</td>
            <td><strong>${escapeHtml(tanodName)}</strong></td>
            <td>${escapeHtml(shift.patrolZone || 'General Patrol')}</td>
            <td>${escapeHtml(formatShiftTimeRange(shift.startAt, shift.endAt))}</td>
            <td class="print-sheet__table--right">${escapeHtml(duration)}</td>
            <td>${escapeHtml(status.label)}</td>
          </tr>
        `;
      }).join('')
    : `<tr><td colspan="6" style="text-align:center;color:#64748b;">No shifts match the selected schedule filter.</td></tr>`;

  const activeTanods = tanods.filter((t) => t.isActive !== false && !t.isSuspended);
  const rosterRowsHtml = activeTanods.length > 0
    ? activeTanods.map((t) => `
        <tr>
          <td><strong>${escapeHtml(t.fullName)}</strong></td>
          <td class="print-sheet__table--mono">${escapeHtml(t.username || '—')}</td>
          <td class="print-sheet__table--mono">${escapeHtml(t.contactNumber || '—')}</td>
          <td>Active Duty</td>
        </tr>
      `).join('')
    : `<tr><td colspan="4" style="text-align:center;color:#64748b;">No active Tanod personnel records loaded.</td></tr>`;

  const generatedStamp = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const sheetHtml = `
    <div class="print-sheet__header">
      <img src="assets/logo.svg" alt="" width="44" height="44" class="print-sheet__header-logo" aria-hidden="true" />
      <div class="print-sheet__header-text">
        <p style="margin:0;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;color:#475569;">Republic of the Philippines · Province of Sorsogon · Municipality of Pilar</p>
        <h1 class="print-sheet__doc-title">BARANGAY TANOD DUTY ROSTER &amp; PATROL SCHEDULE</h1>
        <p class="print-sheet__doc-subtitle">${escapeHtml(barangayName)} · Official Bulletin-Board Peacekeeping Schedule</p>
      </div>
    </div>

    <div class="print-sheet__meta-bar">
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__meta-label">Schedule View</span>
        <span class="print-sheet__meta-val">${escapeHtml(filterDesc)}</span>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__meta-label">Shifts Listed</span>
        <span class="print-sheet__meta-val print-sheet__meta-val--mono">${shifts.length} of ${allShifts.length}</span>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__meta-label">Generated On</span>
        <span class="print-sheet__meta-val">${escapeHtml(generatedStamp)}</span>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__meta-label">Prepared By</span>
        <span class="print-sheet__meta-val">${escapeHtml(user?.fullName || 'Barangay Administrator')}</span>
      </div>
    </div>

    <div class="print-sheet__kpi-grid">
      <div class="print-sheet__kpi-card">
        <span class="print-sheet__kpi-val">${allShifts.length}</span>
        <span class="print-sheet__kpi-lbl">Total Scheduled Shifts</span>
      </div>
      <div class="print-sheet__kpi-card">
        <span class="print-sheet__kpi-val print-sheet__kpi-val--success">${activeCount}</span>
        <span class="print-sheet__kpi-lbl">Active Now</span>
      </div>
      <div class="print-sheet__kpi-card">
        <span class="print-sheet__kpi-val print-sheet__kpi-val--info">${upcomingCount}</span>
        <span class="print-sheet__kpi-lbl">Upcoming Shifts</span>
      </div>
      <div class="print-sheet__kpi-card">
        <span class="print-sheet__kpi-val">${activeTanods.length}</span>
        <span class="print-sheet__kpi-lbl">Active Tanod Roster</span>
      </div>
    </div>

    <div class="print-sheet__section">
      <h2 class="print-sheet__section-title">1. Patrol Shift Assignments</h2>
      <table class="print-sheet__table">
        <thead>
          <tr>
            <th>Shift ID</th>
            <th>Assigned Tanod</th>
            <th>Patrol Zone / Sector</th>
            <th>Duty Window (Start — End)</th>
            <th class="print-sheet__table--right">Duration</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${shiftRowsHtml}
        </tbody>
      </table>
    </div>

    <div class="print-sheet__section">
      <h2 class="print-sheet__section-title">2. Active Tanod Personnel Contact Directory</h2>
      <table class="print-sheet__table">
        <thead>
          <tr>
            <th>Tanod Full Name</th>
            <th>System Callsign / Username</th>
            <th>Contact Number</th>
            <th>Roster Standing</th>
          </tr>
        </thead>
        <tbody>
          ${rosterRowsHtml}
        </tbody>
      </table>
    </div>

    <div class="print-sheet__signatures">
      <div class="print-sheet__sig-box">
        <div class="print-sheet__sig-line"></div>
        <div class="print-sheet__sig-name">${escapeHtml(user?.fullName || 'Chief Tanod / Admin Officer')}</div>
        <div class="print-sheet__sig-role">Prepared By · Barangay Peacekeeping Coordinator</div>
      </div>
      <div class="print-sheet__sig-box">
        <div class="print-sheet__sig-line"></div>
        <div class="print-sheet__sig-name">Punong Barangay</div>
        <div class="print-sheet__sig-role">Noted &amp; Approved For Posting</div>
      </div>
    </div>

    <div class="print-sheet__footer">
      <span>BARANGUARD Peacekeeping Operations · Official Bulletin Copy</span>
      <span>Printed ${escapeHtml(generatedStamp)}</span>
    </div>
  `;

  openPrintPreviewModal({
    title: 'Tanod Duty Roster & Shift Schedule — Print Preview',
    subtitle: 'A4 Bulletin-Board Schedule · Ready for Posting or PDF Archiving',
    sheetId: 'printable-schedule-sheet',
    sheetHtml,
  });
}

