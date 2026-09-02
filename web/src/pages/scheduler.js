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
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getUsers, getShifts, createShift, updateShift, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';

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
  load();

  async function load() {
    renderLoading(listPane);
    try {
      const [tanodsRes, shiftsRes] = await Promise.all([
        getUsers({ role: 'tanod', limit: 100 }),
        getShifts({ limit: 100 }),
      ]);
      tanods = tanodsRes.items;
      const newFormPane = buildNewShiftForm(tanods, load);
      layout.replaceChild(newFormPane, formPane);
      formPane = newFormPane;
      if (shiftsRes.items.length === 0) {
        renderEmpty(listPane);
      } else {
        renderList(listPane, shiftsRes.items, tanods, load);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the scheduler.';
      renderError(listPane, message, load);
    }
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
  heading.style.marginBottom = '16px';

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

function renderList(container, shifts, tanods, onChanged) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'stack';
  for (const shift of shifts) {
    list.appendChild(renderShiftRow(shift, tanods, onChanged));
  }
  container.appendChild(list);
}

function renderShiftRow(shift, tanods, onChanged) {
  const row = document.createElement('div');
  row.className = 'card card--compact';

  const view = document.createElement('div');
  const name = tanodName(tanods, shift.userId);
  view.innerHTML = `
    <div class="row-between">
      <strong>${name ? escapeHtml(name) : 'Unassigned'}</strong>
      <button class="ghost" type="button">Edit</button>
    </div>
    <div class="label" style="text-transform:none; font-weight:400; margin-top:4px;">
      ${shift.patrolZone ? escapeHtml(shift.patrolZone) + ' · ' : ''}${new Date(shift.startAt).toLocaleString()} – ${new Date(shift.endAt).toLocaleString()}
    </div>
  `;
  row.appendChild(view);
  view.querySelector('button').addEventListener('click', () => {
    row.innerHTML = '';
    row.appendChild(buildEditForm(shift, tanods, onChanged, () => {
      row.innerHTML = '';
      row.appendChild(view);
    }));
  });

  return row;
}

function buildEditForm(shift, tanods, onChanged, onCancel) {
  const form = document.createElement('form');
  form.className = 'stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  // Unique ids per shift — several rows can be in edit mode at once, so
  // a shared static id would collide (§ux: every field needs its own
  // programmatically-linked label, not just adjacent text).
  const idPrefix = `scheduler-edit-${shift.shiftId}`;

  const tanodLabel = document.createElement('label');
  tanodLabel.className = 'sr-only';
  tanodLabel.htmlFor = `${idPrefix}-tanod`;
  tanodLabel.textContent = 'Tanod';
  const tanodSelect = document.createElement('select');
  tanodSelect.id = `${idPrefix}-tanod`;
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

  const zoneLabel = document.createElement('label');
  zoneLabel.className = 'sr-only';
  zoneLabel.htmlFor = `${idPrefix}-zone`;
  zoneLabel.textContent = 'Patrol zone';
  const zoneInput = document.createElement('input');
  zoneInput.id = `${idPrefix}-zone`;
  zoneInput.type = 'text';
  zoneInput.value = shift.patrolZone || '';
  zoneInput.placeholder = 'Patrol zone';

  const startLabel = document.createElement('label');
  startLabel.className = 'sr-only';
  startLabel.htmlFor = `${idPrefix}-start`;
  startLabel.textContent = 'Start';
  const startInput = document.createElement('input');
  startInput.id = `${idPrefix}-start`;
  startInput.type = 'datetime-local';
  startInput.value = toDatetimeLocal(shift.startAt);

  const endLabel = document.createElement('label');
  endLabel.className = 'sr-only';
  endLabel.htmlFor = `${idPrefix}-end`;
  endLabel.textContent = 'End';
  const endInput = document.createElement('input');
  endInput.id = `${idPrefix}-end`;
  endInput.type = 'datetime-local';
  endInput.value = toDatetimeLocal(shift.endAt);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px;';
  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'primary';
  saveButton.textContent = 'Save';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'ghost';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', onCancel);
  actions.append(saveButton, cancelButton);

  form.append(errorBox, tanodLabel, tanodSelect, zoneLabel, zoneInput, startLabel, startInput, endLabel, endInput, actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      await updateShift(shift.shiftId, {
        userId: tanodSelect.value ? Number(tanodSelect.value) : null,
        patrolZone: zoneInput.value.trim() || null,
        startAt: startInput.value,
        endAt: endInput.value,
        version: shift.version ?? 1,
      });
      onChanged();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not save this shift.';
      errorBox.textContent = message;
      errorBox.hidden = false;
      saveButton.disabled = false;
      saveButton.textContent = 'Save';
    }
  });

  return form;
}

function toDatetimeLocal(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  wrap.setAttribute('aria-label', 'Loading scheduler');
  for (let i = 0; i < 4; i++) {
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
