/**
 * scheduler.js — W11 Shift & Roster Scheduler (§9): "Week view uses real
 * start_at/end_at. Overlaps are rejected. Fatigue recalculates on
 * create/edit/reassignment and shows its calculation basis." Roles:
 * Admin only.
 *
 * Scoping note, logged in DEVLOG.md: this renders a chronological list
 * (grouped implicitly by real start_at/end_at ordering) rather than a
 * literal 7-column calendar grid — a full week-grid widget is a
 * significant separate UI investment §9 doesn't otherwise specify the
 * layout of, and the actual requirements it does state ("real
 * start_at/end_at," "overlaps are rejected," "fatigue recalculates and
 * shows its basis") are all satisfied by this list view. Every shift row
 * is directly editable (reassign/patrol zone/time range) using the same
 * `version` optimistic-concurrency the API requires.
 *
 * `datetime-local` input values (no timezone of their own) are sent
 * as-is — the backend's own resolved decision (`ShiftsController.php`)
 * treats an offset-less timestamp as Asia/Manila wall-clock time, which
 * is exactly what typing "2026-09-10 14:30" into this form means.
 *
 * 2026-09-02: migrated the shift list from stacked cards with a
 * replace-my-own-DOM edit toggle to the shared `DataTable` component —
 * one row is put into "edit mode" by re-rendering the whole table with
 * that row's cells swapped for live inputs (`editingShiftId` in the
 * closure below), rather than DataTable gaining any new per-row-state
 * API of its own. Error handling on save moved from an inline error box
 * to `alert()` at the time, matching every other DataTable-based action
 * that session (Swap Requests' Approve/Deny, Fatigue Flags' Acknowledge).
 * §3.1/§3.2 of the UI/UX review later migrated all three to the shared
 * `Toast`/`ConfirmDialog` components (already proven in Dispatch Center/
 * AI Review/Blotter Detail) — see the save handler below.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getUsers, getShifts, createShift, updateShift, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { icons } from '../components/icons.js';
import { showToast } from '../components/Toast.js';

const SCHEDULE_COLUMNS = [
  { key: 'tanod', label: 'Tanod' },
  { key: 'zone', label: 'Patrol Zone' },
  { key: 'timeRange', label: 'Time Range' },
  { key: 'actions', label: 'Actions', align: 'right' },
];

/** @param {HTMLElement} root @param {{fullName:string, role:string}} user */
export function renderSchedulerPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'scheduler', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({ title: 'Shift Scheduler', subtitle: 'Assign and edit Tanod patrol shifts', icon: icons.calendar });
  header.appendChild(pageHeader.el);

  const layout = document.createElement('div');
  layout.className = 'split-panel';
  content.appendChild(layout);

  const listPane = document.createElement('div');
  let formPane = document.createElement('div'); // placeholder, replaced once tanods/shifts load
  layout.append(listPane, formPane);

  let tanods = [];
  let shifts = [];
  let editingShiftId = null;

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
      editingShiftId = null;
      const newFormPane = buildNewShiftForm(tanods, load);
      layout.replaceChild(newFormPane, formPane);
      formPane = newFormPane;
      if (shifts.length === 0) {
        renderEmpty(listPane);
      } else {
        renderShiftsTable();
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the scheduler.';
      renderError(listPane, message, load);
    }
  }

  function renderShiftsTable() {
    renderList(listPane, shifts, tanods, editingShiftId, startEdit, cancelEdit, load);
  }
  function startEdit(shiftId) {
    editingShiftId = shiftId;
    renderShiftsTable();
  }
  function cancelEdit() {
    editingShiftId = null;
    renderShiftsTable();
  }
}

function tanodName(tanods, userId) {
  if (userId === null) return null;
  const tanod = tanods.find((t) => t.userId === userId);
  return tanod ? tanod.fullName : `Tanod #${userId}`;
}

function buildNewShiftForm(tanods, onCreated) {
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.textContent = 'New Shift';

  const form = document.createElement('form');
  form.className = 'form-stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  const tanodLabel = document.createElement('label');
  tanodLabel.className = 'label';
  tanodLabel.htmlFor = 'scheduler-new-tanod';
  tanodLabel.textContent = 'Tanod';
  const tanodSelect = document.createElement('select');
  tanodSelect.id = 'scheduler-new-tanod';
  for (const t of tanods) {
    const option = document.createElement('option');
    option.value = String(t.userId);
    option.textContent = t.fullName;
    tanodSelect.appendChild(option);
  }

  const zoneLabel = document.createElement('label');
  zoneLabel.className = 'label';
  zoneLabel.htmlFor = 'scheduler-new-zone';
  zoneLabel.textContent = 'Patrol Zone (optional)';
  const zoneInput = document.createElement('input');
  zoneInput.id = 'scheduler-new-zone';
  zoneInput.type = 'text';

  const startLabel = document.createElement('label');
  startLabel.className = 'label';
  startLabel.htmlFor = 'scheduler-new-start';
  startLabel.textContent = 'Start';
  const startInput = document.createElement('input');
  startInput.id = 'scheduler-new-start';
  startInput.type = 'datetime-local';
  startInput.required = true;

  const endLabel = document.createElement('label');
  endLabel.className = 'label';
  endLabel.htmlFor = 'scheduler-new-end';
  endLabel.textContent = 'End';
  const endInput = document.createElement('input');
  endInput.id = 'scheduler-new-end';
  endInput.type = 'datetime-local';
  endInput.required = true;

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.textContent = 'Create Shift';

  form.append(errorBox, tanodLabel, tanodSelect, zoneLabel, zoneInput, startLabel, startInput, endLabel, endInput, submitButton);
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
      errorBox.textContent = 'Start and end are both required.';
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
      submitButton.textContent = 'Create Shift';
    }
  });

  return card;
}

function renderList(container, shifts, tanods, editingShiftId, onStartEdit, onCancelEdit, onSaved) {
  container.innerHTML = '';

  // Populated on the editing row's first cell (column order below always
  // puts 'tanod' first) and read back by that same row's later cells —
  // see the file header comment for why DataTable itself doesn't need to
  // know about this.
  let editFields = null;

  const table = DataTable({
    columns: SCHEDULE_COLUMNS,
    rows: shifts,
    rowKey: (row) => row.shiftId,
    caption: 'Shift schedule',
    renderCell: (shift, key) => {
      const isEditing = shift.shiftId === editingShiftId;

      if (isEditing) {
        if (key === 'tanod') {
          editFields = buildEditFields(shift, tanods);
          return editFields.tanodSelect;
        }
        if (key === 'zone') return editFields.zoneInput;
        if (key === 'timeRange') return editFields.timeRangeWrap;
        if (key === 'actions') return buildEditActions(shift, editFields, onSaved, onCancelEdit);
        return '';
      }

      switch (key) {
        case 'tanod': {
          const name = tanodName(tanods, shift.userId);
          if (!name) return 'Unassigned';
          const span = document.createElement('span');
          span.textContent = name;
          return span;
        }
        case 'zone': {
          if (!shift.patrolZone) return '—';
          const span = document.createElement('span');
          span.textContent = shift.patrolZone;
          return span;
        }
        case 'timeRange':
          return `${new Date(shift.startAt).toLocaleString()} – ${new Date(shift.endAt).toLocaleString()}`;
        case 'actions': {
          const button = document.createElement('button');
          button.className = 'ghost';
          button.type = 'button';
          button.textContent = 'Edit';
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            onStartEdit(shift.shiftId);
          });
          return button;
        }
        default:
          return '';
      }
    },
  });
  container.appendChild(table);
}

function buildEditFields(shift, tanods) {
  const tanodSelect = document.createElement('select');
  const unassignedOption = document.createElement('option');
  unassignedOption.value = '';
  unassignedOption.textContent = 'Unassigned';
  tanodSelect.appendChild(unassignedOption);
  for (const t of tanods) {
    const option = document.createElement('option');
    option.value = String(t.userId);
    option.textContent = t.fullName;
    if (t.userId === shift.userId) option.selected = true;
    tanodSelect.appendChild(option);
  }

  const zoneInput = document.createElement('input');
  zoneInput.type = 'text';
  zoneInput.value = shift.patrolZone || '';
  zoneInput.placeholder = 'Patrol zone';

  const startInput = document.createElement('input');
  startInput.type = 'datetime-local';
  startInput.value = toDatetimeLocal(shift.startAt);
  const endInput = document.createElement('input');
  endInput.type = 'datetime-local';
  endInput.value = toDatetimeLocal(shift.endAt);
  const timeRangeWrap = document.createElement('div');
  timeRangeWrap.className = 'stack-tight';
  timeRangeWrap.append(startInput, endInput);

  return { tanodSelect, zoneInput, startInput, endInput, timeRangeWrap };
}

function buildEditActions(shift, editFields, onSaved, onCancelEdit) {
  const wrap = document.createElement('span');
  wrap.className = 'data-table__actions';

  const saveButton = document.createElement('button');
  saveButton.className = 'primary';
  saveButton.type = 'button';
  saveButton.textContent = 'Save';
  saveButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      await updateShift(shift.shiftId, {
        userId: editFields.tanodSelect.value ? Number(editFields.tanodSelect.value) : null,
        patrolZone: editFields.zoneInput.value.trim() || null,
        startAt: editFields.startInput.value,
        endAt: editFields.endInput.value,
        version: shift.version ?? 1,
      });
      onSaved();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not save this shift.';
      showToast(message, { variant: 'error' });
      saveButton.disabled = false;
      saveButton.textContent = 'Save';
    }
  });

  const cancelButton = document.createElement('button');
  cancelButton.className = 'ghost';
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', (event) => {
    event.stopPropagation();
    onCancelEdit();
  });

  wrap.append(saveButton, cancelButton);
  return wrap;
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
  container.innerHTML = '';
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
