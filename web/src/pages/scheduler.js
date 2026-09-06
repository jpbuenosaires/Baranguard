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

import { getUsers, getShifts, createShift, updateShift, ApiClientError } from '../api/apiClient.js';
import { DataTable } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';
import { avatarInitials } from '../components/Avatar.js';

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
 * @param {{fullName:string, role:string}} user
 */
export function renderSchedulerTab(container, user) {
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
  let selectedStatus = 'all';
  let searchQuery = '';

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
      const newFormPane = buildNewShiftForm(tanods, load);
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
    chip.className = `personnel-filter-chip ${selectedStatus === opt.id ? 'is-active' : ''}`;
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
            tag.innerHTML = `<span style="color:var(--color-primary);">${icons.map(14)}</span><span>${shift.patrolZone}</span>`;
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
              openEditModal(shift, tanods, load);
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

/**
 * Builds the right-hand form for creating a new shift with preset buttons.
 */
function buildNewShiftForm(tanods, onCreated) {
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
    const option = document.createElement('option');
    option.value = String(t.userId);
    option.textContent = t.fullName;
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
function openEditModal(shift, tanods, onSaved) {
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
    const opt = document.createElement('option');
    opt.value = String(t.userId);
    opt.textContent = t.fullName;
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
  body.appendChild(grid);

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
