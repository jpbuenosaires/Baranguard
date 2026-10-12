/**
 * scheduler.js — Personnel > Scheduler Tab.
 *
 * Two views of the same roster (2026-10-12 rework):
 * - Week (default): a grid with one row per tanod and one column per day.
 *   Each tanod's availability is a fixed input, shown as given; nobody
 *   accepts or revises it here. Click "+" in a cell to add the chosen
 *   standard shift, drag a chip to move it, open a chip to edit it. Chips
 *   warn when a shift is outside availability or over the hour limits, a
 *   coverage row counts the standard shifts covered per day, "Copy last
 *   week" repeats last week's pattern, and the whole week's drafts are
 *   published in one step once the printed A4 roster is signed.
 * - List: the earlier table with status filters, search and selection.
 * The New Shift form (custom times) stays available under the grid.
 */

import { createShift, updateShift, getBarangays, ApiClientError } from '../api/apiClient.js';
import { loadTanodRoster } from '../services/tanodRoster.js';
import {
  getShiftsDetailed, publishShifts, getAvailability, getOwnApprovalAuthority,
} from '../services/shellWorkflowApi.js';
import { manilaToday } from '../services/tanodWorkflowUi.js';
import {
  SHIFT_PRESETS, addDays, weekStartOf, weekDays, weekRangeLabel, shortDateLabel, presetRange,
  shiftsInWeek, shiftsOnDay, availabilityIntervals, isWithinAvailability, sourceAvailabilityFor,
  planCopyFromPreviousWeek, moveToDay, shiftTimeLabel, dayCoverage, WEEK_DAY_LABELS,
  suggestAvailableTanods, planSmartCoverage,
} from '../services/rosterWeek.js';
import { confirmDialog, promptFields } from '../components/ConfirmDialog.js';
import { DataTable } from '../components/DataTable.js';
import { StatStrip } from '../components/StatStrip.js';
import { ShiftWeekGrid } from '../components/ShiftWeekGrid.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';
import { avatarInitials } from '../components/Avatar.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { openPrintPreviewModal } from '../components/PrintPreviewModal.js';

const SCHEDULE_COLUMNS = [
  { key: 'select', label: 'Select' },
  { key: 'approval', label: 'Roster' },
  { key: 'status', label: 'Status' },
  { key: 'tanod', label: 'Assigned Tanod' },
  { key: 'zone', label: 'Patrol Zone' },
  { key: 'timeRange', label: 'Schedule & Duration' },
  { key: 'actions', label: 'Actions', align: 'right' },
];

// GET /shifts and GET /availability cap a page at 100; the grid needs every
// row to place a week and check hours, so pages are walked up to this many.
const MAX_PAGES = 20;
// POST /shifts/publish takes 1-100 ids per call.
const PUBLISH_BATCH = 100;

function rosterLabel(t) {
  return t.officialTitle ? `${t.fullName} - ${t.officialTitle}` : t.fullName;
}

async function fetchAllPages(fetchPage) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchPage(page);
    items.push(...res.items);
    if (res.items.length === 0 || items.length >= (res.total ?? items.length)) break;
  }
  return items;
}

/**
 * Personnel > Scheduler tab.
 *
 * @param {HTMLElement} container tab body to render into
 * @param {{fullName:string, role:string, barangayId?:number}} user
 * @param {ReturnType<import('../components/PageHeader.js').PageHeader>} [pageHeader]
 * @param {{searchQuery?: string}} [initialData]
 * @param {() => void} [onOpenSwaps] jump to the Swap requests tab
 */
export function renderSchedulerTab(container, user, pageHeader, initialData, onOpenSwaps) {
  // Admin and Secretary manage shifts (create/edit; 2026-10-07 — the
  // Secretary is the Records & Reports Officer who builds the roster the
  // approver then publishes). Punong Barangay reaches this tab to publish
  // drafts (approve_roster) only. The server re-checks role and authority on
  // every action either way. The tanod list comes from loadTanodRoster()
  // (GET /users/directory) for both Admin and Secretary. The roster is
  // printed and signed on paper outside the app; publishing is a plain
  // confirm with nothing to record.
  // Availability is fixed per tanod (2026-10-12): it is shown in the week
  // grid as submitted, never accepted or sent back for revision here.
  const isAdmin = user.role === 'admin';
  const canManageShifts = isAdmin || user.role === 'secretary';

  // Stat Strip Host (Option A: Integrated Command Bar)
  const statStripHost = document.createElement('div');
  statStripHost.className = 'scheduler-stat-bar';
  statStripHost.setAttribute('role', 'toolbar');
  statStripHost.setAttribute('aria-label', 'Shift summary and quick filters');
  container.appendChild(statStripHost);

  // Split Panel Layout (stacked in the week view: the grid needs the width)
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
  // A search link (e.g. from global search) lands on the list it filters.
  let viewMode = searchQuery ? 'list' : 'week';
  let weekStart = weekStartOf(manilaToday());
  let activePreset = 'morning';
  // Draft shifts ticked for publishing (contract §3: POST /shifts/publish).
  const selectedShiftIds = new Set();
  let publishWarnings = [];
  let publishedCount = 0;
  let busy = false;
  // Publishing needs the approve_roster authority. Looked up once for the
  // tab; a failed lookup resolves to "does not hold it" so the controls stay
  // hidden rather than offering an action the server will refuse.
  let canApproveRoster = false;
  const rosterAuthorityPromise = getOwnApprovalAuthority(user.userId, user.role)
    .then((list) => list.includes('approve_roster'))
    .catch(() => false);
  // Availability feeds the grid's shading and warnings only. A failure here
  // never blanks the roster: the grid just says it could not be loaded.
  let availability = { status: 'loading', items: [] };

  if (pageHeader && pageHeader.actions) {
    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.id = 'preview-schedule-print-btn';
    printBtn.className = 'ghost';
    printBtn.innerHTML = `${icons.printer(15)} <span>Preview & Print Schedule</span>`;
    printBtn.addEventListener('click', () => {
      if (viewMode === 'week') {
        openWeekPrintModal({
          weekStart,
          rows: gridRows(),
          shifts,
          user,
          barangayName,
        });
        return;
      }
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

    if (onOpenSwaps) {
      const swapsBtn = document.createElement('button');
      swapsBtn.type = 'button';
      swapsBtn.className = 'ghost';
      swapsBtn.innerHTML = `${icons.repeat(15)} <span>Swap requests</span>`;
      swapsBtn.addEventListener('click', onOpenSwaps);
      pageHeader.actions.appendChild(swapsBtn);
    }
  }

  getBarangays().then((list) => {
    const found = list.find((b) => b.barangayId === (user?.barangayId ?? 1)) || list[0];
    if (found) barangayName = `Barangay ${found.name}`;
  }).catch(() => {});

  if (!canManageShifts || viewMode === 'week') {
    formPane.hidden = true;
    formPane.style.display = 'none';
    listPane.style.flex = '1 1 100%';
  }
  load();
  loadAvailability();

  function retryAll() {
    load();
    loadAvailability();
  }

  async function loadAvailability() {
    availability = { status: 'loading', items: [] };
    try {
      const items = await fetchAllPages((page) => getAvailability({ page, limit: 100 }));
      availability = { status: 'ready', items };
    } catch {
      availability = { status: 'error', items: [] };
    }
    if (shifts.length || tanods.length) renderMain();
  }

  async function load() {
    renderLoading(listPane);
    try {
      const [tanodsRes, shiftItems] = await Promise.all([
        loadTanodRoster(user, { purpose: 'roster' }).then((items) => ({ items })),
        fetchAllPages((page) => getShiftsDetailed({ page, limit: 100 })),
      ]);
      tanods = tanodsRes.items;
      shifts = shiftItems;
      canApproveRoster = await rosterAuthorityPromise;
      // Drop ticks for shifts that are gone or already published.
      for (const id of [...selectedShiftIds]) {
        if (!shifts.some((s) => s.shiftId === id && s.approvalStatus === 'draft')) selectedShiftIds.delete(id);
      }

      renderStatStrip();
      if (canManageShifts) {
        const newFormPane = buildNewShiftForm(tanods, load, shifts);
        layout.replaceChild(newFormPane, formPane);
        formPane = newFormPane;
      }

      renderMain();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the scheduler.';
      renderError(listPane, message, retryAll);
    }
  }

  function setView(mode) {
    viewMode = mode;
    renderMain();
  }

  function renderMain() {
    layout.classList.toggle('scheduler-layout--week', viewMode === 'week');
    if (viewMode === 'week') {
      if (formPane) {
        formPane.hidden = true;
        formPane.style.display = 'none';
      }
      listPane.style.flex = '1 1 100%';
      renderWeekView();
    } else {
      if (canManageShifts && formPane) {
        formPane.hidden = false;
        formPane.style.display = '';
        listPane.style.flex = '1 1 65%';
      }
      renderShiftsTable();
    }
  }

  function buildViewToggle() {
    const wrap = document.createElement('div');
    wrap.className = 'filter-chips scheduler-view-toggle';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Scheduler view');
    for (const [mode, label] of [['week', 'Week'], ['list', 'List']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `filter-chip${viewMode === mode ? ' is-active' : ''}`;
      b.textContent = label;
      b.setAttribute('aria-pressed', viewMode === mode ? 'true' : 'false');
      b.addEventListener('click', () => setView(mode));
      wrap.appendChild(b);
    }
    return wrap;
  }

  // --- Week view -------------------------------------------------------------

  function nameOf(userId) {
    const t = tanods.find((x) => x.userId === userId);
    if (t) return t.fullName;
    const fromAvail = availability.items.find((a) => a.userId === userId && a.userName);
    return fromAvail ? fromAvail.userName : `Tanod #${userId}`;
  }

  /** Every rostered tanod, plus anyone with a shift this week, plus Unassigned if needed. */
  function gridRows() {
    const week = shiftsInWeek(shifts, weekStart);
    const ids = new Set(tanods.map((t) => t.userId));
    for (const s of week) if (s.userId) ids.add(s.userId);
    const rows = [...ids].map((userId) => ({ userId, name: nameOf(userId) }));
    // Roster order for the directory, then extra names alphabetically.
    const order = new Map(tanods.map((t, i) => [t.userId, i]));
    rows.sort((a, b) => (order.get(a.userId) ?? 1e6) - (order.get(b.userId) ?? 1e6) || a.name.localeCompare(b.name));
    if (week.some((s) => !s.userId)) rows.push({ userId: null, name: 'Unassigned' });
    return rows;
  }

  function weekDrafts() {
    return shiftsInWeek(shifts, weekStart).filter((s) => s.approvalStatus === 'draft');
  }

  function renderWeekView() {
    listPane.innerHTML = '';
    const warningsBlock = buildWarningsBlock();
    if (warningsBlock) listPane.appendChild(warningsBlock);
    listPane.appendChild(buildPublishBar());

    const toolbar = document.createElement('div');
    toolbar.className = 'scheduler-week-toolbar';

    const nav = document.createElement('div');
    nav.className = 'scheduler-week-toolbar__nav';
    const prev = navButton('‹', 'Previous week', () => { weekStart = addDays(weekStart, -7); renderMain(); });
    const next = navButton('›', 'Next week', () => { weekStart = addDays(weekStart, 7); renderMain(); });
    const label = document.createElement('strong');
    label.className = 'scheduler-week-toolbar__label';
    label.textContent = weekRangeLabel(weekStart);
    const thisWeek = document.createElement('button');
    thisWeek.type = 'button';
    thisWeek.className = 'ghost';
    thisWeek.textContent = 'This week';
    thisWeek.disabled = weekStart === weekStartOf(manilaToday());
    thisWeek.addEventListener('click', () => { weekStart = weekStartOf(manilaToday()); renderMain(); });
    nav.append(prev, label, next, thisWeek);
    toolbar.append(nav, buildViewToggle());

    if (canManageShifts) {
      const tools = document.createElement('div');
      tools.className = 'scheduler-week-toolbar__tools';
      const presetsWrap = document.createElement('div');
      presetsWrap.className = 'scheduler-week-toolbar__presets';
      const presetLabel = document.createElement('span');
      presetLabel.className = 'scheduler-publish-bar__hint';
      presetLabel.textContent = '+ adds:';
      const presets = document.createElement('div');
      presets.className = 'filter-chips';
      presets.setAttribute('role', 'group');
      presets.setAttribute('aria-label', 'Shift added by +');
      for (const p of SHIFT_PRESETS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `filter-chip${activePreset === p.type ? ' is-active' : ''}`;
        b.textContent = `${p.label} ${p.start}–${p.end}`;
        b.setAttribute('aria-pressed', activePreset === p.type ? 'true' : 'false');
        b.addEventListener('click', () => { activePreset = p.type; renderMain(); });
        presets.appendChild(b);
      }
      presetsWrap.append(presetLabel, presets);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.id = 'scheduler-copy-week-btn';
      copy.className = 'ghost';
      copy.innerHTML = `${icons.repeat(15)} <span>Copy last week</span>`;
      copy.addEventListener('click', copyLastWeek);

      const smartFill = document.createElement('button');
      smartFill.type = 'button';
      smartFill.id = 'scheduler-smart-fill-btn';
      smartFill.className = 'ghost';
      smartFill.innerHTML = `${icons.checkCircle(15)} <span>Smart Fill</span>`;
      smartFill.title = 'Automatically fill open slots with available, low-hours tanods';
      smartFill.addEventListener('click', runSmartFill);

      const customShift = document.createElement('button');
      customShift.type = 'button';
      customShift.id = 'scheduler-custom-shift-btn';
      customShift.className = 'ghost';
      customShift.innerHTML = `${icons.plus(15)} <span>Custom Shift</span>`;
      customShift.title = 'Create a custom shift in a dialog';
      customShift.addEventListener('click', () => openNewShiftModal(tanods, load, shifts));

      tools.append(presetsWrap, copy, smartFill, customShift);
      toolbar.appendChild(tools);
    }
    listPane.appendChild(toolbar);

    if (availability.status === 'error') {
      const note = document.createElement('p');
      note.className = 'note';
      note.setAttribute('role', 'status');
      note.textContent = 'Tanod availability could not be loaded, so the grid cannot show it or warn about it. Shifts are still shown.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ghost';
      retry.textContent = 'Retry';
      retry.addEventListener('click', loadAvailability);
      note.append(' ', retry);
      listPane.appendChild(note);
    }

    const rows = gridRows();
    if (rows.length === 0) {
      const block = document.createElement('div');
      block.className = 'card state-block';
      const h = document.createElement('h3');
      h.textContent = 'No shifts this week';
      const p = document.createElement('p');
      p.textContent = 'There are no shifts scheduled for this week.';
      block.append(h, p);
      listPane.appendChild(block);
      return;
    }

    const presetName = SHIFT_PRESETS.find((p) => p.type === activePreset)?.label ?? 'Morning';
    listPane.appendChild(ShiftWeekGrid({
      days: weekDays(weekStart),
      today: manilaToday(),
      rows,
      weekShifts: shiftsInWeek(shifts, weekStart),
      allShifts: shifts,
      availability: availability.items,
      availabilityLoaded: availability.status === 'ready',
      canEdit: canManageShifts,
      addLabel: presetName,
      onAdd: addPresetShift,
      onOpen: (shift) => openEditModal(shift, tanods, load, shifts),
      onMove: moveShift,
      selectedShiftIds,
      onToggleSelect: (shiftId) => {
        if (selectedShiftIds.has(shiftId)) selectedShiftIds.delete(shiftId);
        else selectedShiftIds.add(shiftId);
        renderMain();
      },
    }));

    if (canManageShifts && selectedShiftIds.size > 0) {
      listPane.appendChild(buildFloatingBulkBar());
    }
  }

  function navButton(textValue, labelValue, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost scheduler-week-toolbar__step';
    b.textContent = textValue;
    b.setAttribute('aria-label', labelValue);
    b.addEventListener('click', onClick);
    return b;
  }

  function buildFloatingBulkBar() {
    const bar = document.createElement('div');
    bar.className = 'scheduler-bulk-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Bulk shift actions');

    const countBadge = document.createElement('span');
    countBadge.className = 'scheduler-bulk-bar__count';
    countBadge.textContent = `${selectedShiftIds.size} shift${selectedShiftIds.size === 1 ? '' : 's'} selected`;

    const actions = document.createElement('div');
    actions.className = 'scheduler-bulk-bar__actions';

    const zoneBtn = document.createElement('button');
    zoneBtn.type = 'button';
    zoneBtn.className = 'ghost scheduler-bulk-btn';
    zoneBtn.innerHTML = `${icons.map(14)} <span>Set Zone</span>`;
    zoneBtn.addEventListener('click', bulkSetZone);

    const reassignBtn = document.createElement('button');
    reassignBtn.type = 'button';
    reassignBtn.className = 'ghost scheduler-bulk-btn';
    reassignBtn.innerHTML = `${icons.users(14)} <span>Reassign</span>`;
    reassignBtn.addEventListener('click', bulkReassign);

    const unassignBtn = document.createElement('button');
    unassignBtn.type = 'button';
    unassignBtn.className = 'ghost scheduler-bulk-btn';
    unassignBtn.innerHTML = `<span>Unassign</span>`;
    unassignBtn.addEventListener('click', bulkUnassign);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'ghost scheduler-bulk-btn';
    clearBtn.innerHTML = `${icons.x(14)} <span>Clear</span>`;
    clearBtn.addEventListener('click', () => {
      selectedShiftIds.clear();
      renderMain();
    });

    actions.append(zoneBtn, reassignBtn, unassignBtn, clearBtn);
    bar.append(countBadge, actions);
    return bar;
  }

  async function bulkSetZone() {
    const selected = shifts.filter((s) => selectedShiftIds.has(s.shiftId));
    if (selected.length === 0) return;

    const result = await promptFields({
      title: `Set Patrol Zone for ${selected.length} shift${selected.length === 1 ? '' : 's'}?`,
      description: 'Enter the patrol zone or sector name to apply to all selected shifts.',
      fields: [
        { name: 'zone', label: 'Patrol Zone / Sector', type: 'text', placeholder: 'e.g. Purok 1-2, National Road' },
      ],
      confirmLabel: 'Apply Zone',
    });
    if (!result) return;

    busy = true;
    let updated = 0;
    for (const s of selected) {
      try {
        await updateShift(s.shiftId, {
          patrolZone: (result.zone || '').trim() || null,
          version: s.version ?? 1,
        });
        updated++;
      } catch {
        // continue
      }
    }
    busy = false;
    showToast(`Updated patrol zone for ${updated} shift${updated === 1 ? '' : 's'}.`, { variant: 'success' });
    selectedShiftIds.clear();
    await load();
  }

  async function bulkReassign() {
    const selected = shifts.filter((s) => selectedShiftIds.has(s.shiftId));
    if (selected.length === 0) return;

    const options = tanods.map((t) => ({ value: String(t.userId), label: rosterLabel(t) }));
    const result = await promptFields({
      title: `Reassign ${selected.length} shift${selected.length === 1 ? '' : 's'}?`,
      description: 'Choose which tanod to assign to all selected shifts.',
      fields: [
        { name: 'tanod', label: 'New Assignee', type: 'select', options },
      ],
      confirmLabel: 'Reassign',
    });
    if (!result || !result.tanod) return;

    const newUserId = Number(result.tanod);
    const targetTanod = tanods.find((t) => t.userId === newUserId);
    busy = true;
    let updated = 0;
    let failed = 0;
    for (const s of selected) {
      try {
        await updateShift(s.shiftId, {
          userId: newUserId,
          version: s.version ?? 1,
        });
        updated++;
      } catch {
        failed++;
      }
    }
    busy = false;
    if (failed) {
      showToast(`Reassigned ${updated} shift(s); ${failed} failed availability or limit checks.`, { variant: 'warning' });
    } else {
      showToast(`Reassigned ${updated} shift${updated === 1 ? '' : 's'} to ${targetTanod?.fullName || 'Tanod'}.`, { variant: 'success' });
    }
    selectedShiftIds.clear();
    await load();
  }

  async function bulkUnassign() {
    const selected = shifts.filter((s) => selectedShiftIds.has(s.shiftId));
    if (selected.length === 0) return;

    const ok = await confirmDialog({
      title: `Unassign ${selected.length} shift${selected.length === 1 ? '' : 's'}?`,
      description: 'The shifts will become Unassigned and no longer count toward any tanod\'s weekly hours.',
      confirmLabel: 'Unassign',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;

    busy = true;
    let updated = 0;
    for (const s of selected) {
      try {
        await updateShift(s.shiftId, {
          userId: null,
          version: s.version ?? 1,
        });
        updated++;
      } catch {
        // continue
      }
    }
    busy = false;
    showToast(`Unassigned ${updated} shift${updated === 1 ? '' : 's'}.`, { variant: 'success' });
    selectedShiftIds.clear();
    await load();
  }

  async function runSmartFill() {
    if (busy) return;
    if (availability.status !== 'ready') {
      showToast('Availability is still loading. Please wait a moment before using Smart Fill.', { variant: 'warning' });
      return;
    }
    const plan = planSmartCoverage(shifts, availability.items, weekStart, tanods);
    if (plan.toCreate.length === 0) {
      showToast('All standard shifts are already covered, or no available tanods match the open slots.', { variant: 'info' });
      return;
    }

    const ok = await confirmDialog({
      title: `Smart Fill: Schedule ${plan.toCreate.length} shift${plan.toCreate.length === 1 ? '' : 's'}?`,
      description: `Found ${plan.toCreate.length} open shift slots that match tanods' submitted availability without exceeding fatigue limits. They will be added as drafts.${plan.unfilledCount ? ` (${plan.unfilledCount} slots have no available tanods).` : ''}`,
      confirmLabel: 'Fill Roster',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;

    busy = true;
    let created = 0;
    for (const item of plan.toCreate) {
      try {
        await createShift({
          userId: item.userId,
          patrolZone: null,
          startAt: item.startLocal,
          endAt: item.endLocal,
          requestId: crypto.randomUUID(),
          sourceAvailabilityId: item.sourceAvailabilityId,
        });
        created++;
      } catch {
        // continue
      }
    }
    busy = false;
    showToast(`Smart Fill scheduled ${created} draft shift${created === 1 ? '' : 's'}.`, { variant: 'success' });
    await load();
  }

  function openNewShiftModal(tanodsList, onCreated, shiftList = []) {
    const overlay = document.createElement('div');
    overlay.className = 'personnel-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'personnel-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'scheduler-create-modal-title');

    const header = document.createElement('div');
    header.className = 'personnel-modal__header';

    const title = document.createElement('h3');
    title.id = 'scheduler-create-modal-title';
    title.className = 'personnel-modal__title';
    title.innerHTML = `<span aria-hidden="true">${icons.calendar(20)}</span><span>New Shift</span>`;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'personnel-modal__close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = icons.x(18);
    closeBtn.addEventListener('click', () => document.body.removeChild(overlay));

    header.append(title, closeBtn);

    const formCard = buildNewShiftForm(tanodsList, () => {
      document.body.removeChild(overlay);
      onCreated();
    }, shiftList);

    const innerHeading = formCard.querySelector('h3');
    if (innerHeading) innerHeading.remove();
    formCard.className = 'personnel-modal__body';

    modal.append(header, formCard);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) document.body.removeChild(overlay);
    });
  }

  async function addPresetShift(userId, date) {
    if (busy) return;
    const range = presetRange(date, activePreset);
    const preset = SHIFT_PRESETS.find((p) => p.type === activePreset);
    const intervals = availabilityIntervals(availability.items, userId);
    if (availability.status === 'ready' && !isWithinAvailability(range.startMs, range.endMs, intervals)) {
      const candidates = suggestAvailableTanods(shifts, availability.items, date, activePreset, tanods);
      const suggestions = candidates.slice(0, 3).map((c) => c.fullName).join(', ');
      const suggestionText = suggestions ? ` Available on this day: ${suggestions}.` : '';
      showToast(`${nameOf(userId)} is not available for ${preset.label} ${preset.start}–${preset.end} on ${shortDateLabel(date)}. Shifts must fit inside the availability the tanod gave.${suggestionText}`, { variant: 'warning' });
      return;
    }
    busy = true;
    try {
      await createShift({
        userId,
        patrolZone: null,
        startAt: range.startLocal,
        endAt: range.endLocal,
        requestId: crypto.randomUUID(),
        sourceAvailabilityId: sourceAvailabilityFor(range.startMs, intervals),
      });
      showToast(`${preset.label} shift added for ${nameOf(userId)} as a draft.`, { variant: 'success' });
      await load();
    } catch (err) {
      showToast(err instanceof ApiClientError ? err.message : 'Could not add this shift.', { variant: 'error' });
    } finally {
      busy = false;
    }
  }

  async function moveShift(shift, userId, date) {
    if (busy) return;
    const target = moveToDay(shift, date);
    const who = userId === null ? 'Unassigned' : nameOf(userId);
    const notes = [];
    if (shift.approvalStatus === 'published') {
      notes.push('This shift is published. Moving it puts it back to draft, so it needs to be published again.');
    }
    if (userId !== null && availability.status === 'ready'
      && !isWithinAvailability(target.startMs, target.endMs, availabilityIntervals(availability.items, userId))) {
      showToast(`${who} is not available at that time. Shifts must fit inside the availability the tanod gave.`, { variant: 'warning' });
      return;
    }
    const ok = await confirmDialog({
      title: `Move shift to ${who}, ${shortDateLabel(date)}?`,
      description: [`${shiftTimeLabel(shift)} keeps its times.`, ...notes].join(' '),
      confirmLabel: 'Move',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    busy = true;
    try {
      await updateShift(shift.shiftId, {
        userId,
        startAt: target.startLocal,
        endAt: target.endLocal,
        version: shift.version ?? 1,
      });
      showToast('Shift moved.', { variant: 'success' });
      await load();
    } catch (err) {
      showToast(err instanceof ApiClientError ? err.message : 'Could not move this shift.', { variant: 'error' });
    } finally {
      busy = false;
    }
  }

  async function copyLastWeek() {
    if (busy) return;
    const plan = planCopyFromPreviousWeek(shifts, availability.status === 'ready' ? availability.items : [], weekStart);
    const skipped = [];
    if (plan.skippedUnavailable) skipped.push(`${plan.skippedUnavailable} skipped because the tanod is not available`);
    if (plan.skippedExisting) skipped.push(`${plan.skippedExisting} already in this week`);
    if (plan.toCreate.length === 0) {
      showToast(skipped.length ? `Nothing to copy: ${skipped.join(', ')}.` : 'Last week has no assigned shifts to copy.', { variant: 'info' });
      return;
    }
    if (availability.status !== 'ready') {
      showToast('Availability is not loaded yet, so last week cannot be checked against it. Try again in a moment.', { variant: 'warning' });
      return;
    }
    const ok = await confirmDialog({
      title: `Copy ${plan.toCreate.length} shift${plan.toCreate.length === 1 ? '' : 's'} from last week?`,
      description: `They are added to ${weekRangeLabel(weekStart)} as drafts with the same tanods, times and zones.${skipped.length ? ` ${skipped.join('; ')}.` : ''}`,
      confirmLabel: 'Copy',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    busy = true;
    let created = 0;
    const failures = [];
    for (const item of plan.toCreate) {
      try {
        await createShift({
          userId: item.userId,
          patrolZone: item.patrolZone,
          startAt: item.startLocal,
          endAt: item.endLocal,
          requestId: crypto.randomUUID(),
          sourceAvailabilityId: item.sourceAvailabilityId,
        });
        created += 1;
      } catch (err) {
        failures.push(err instanceof ApiClientError ? err.message : 'Could not add a shift.');
      }
    }
    busy = false;
    if (failures.length) {
      showToast(`Copied ${created} shift${created === 1 ? '' : 's'}; ${failures.length} could not be added (${failures[0]}).`, { variant: 'warning' });
    } else {
      showToast(`Copied ${created} shift${created === 1 ? '' : 's'} from last week as drafts.`, { variant: 'success' });
    }
    await load();
  }

  let shiftCountMap = { all: 0, active: 0, upcoming: 0, completed: 0 };
  const statusChipBtns = [];

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

    shiftCountMap = {
      all: shifts.length,
      active: activeNow,
      upcoming,
      completed,
    };

    const statConfigs = [
      { id: 'all', label: 'Total Shifts', count: shifts.length, title: 'Show all shifts' },
      { id: 'active', label: 'Active Now', count: activeNow, tone: 'success', title: 'Filter: Active Now' },
      { id: 'upcoming', label: 'Upcoming', count: upcoming, tone: 'info', title: 'Filter: Upcoming' },
      { id: 'completed', label: 'Completed', count: completed, title: 'Filter: Completed' },
    ];

    statConfigs.forEach((cfg) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isActive = viewMode === 'list' && selectedStatus === cfg.id;
      btn.className = `personnel-stat-chip${isActive ? ' is-active' : ''}`;
      btn.title = cfg.title;
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      btn.setAttribute('aria-label', `${cfg.title} (${cfg.count})`);

      const labelSpan = document.createElement('span');
      labelSpan.className = 'stat-chip__label';
      labelSpan.textContent = cfg.label;

      const countSpan = document.createElement('span');
      countSpan.className = `stat-chip__count${cfg.tone ? ' tone-' + cfg.tone : ''}`;
      countSpan.textContent = String(cfg.count);

      btn.append(labelSpan, countSpan);

      btn.addEventListener('click', () => {
        selectedStatus = cfg.id;
        viewMode = 'list';
        renderMain();
      });

      statStripHost.appendChild(btn);
    });

    // Update list view filter chips if already initialized
    statusChipBtns.forEach((item) => {
      if (item.countSpan) {
        item.countSpan.textContent = String(shiftCountMap[item.id] ?? 0);
      }
    });
  }

  // Filter Bar elements
  const filterBar = document.createElement('div');
  filterBar.className = 'personnel-filter-bar';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'personnel-search-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'personnel-search-icon';
  searchIcon.innerHTML = icons.search(16);
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'personnel-search-input';
  searchInput.placeholder = 'Search by tanod or patrol zone…';
  searchInput.setAttribute('aria-label', 'Search shifts by tanod or patrol zone');
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
  filterChipsWrap.setAttribute('role', 'toolbar');
  filterChipsWrap.setAttribute('aria-label', 'Filter shifts by status');

  const statusOptions = [
    { id: 'all', label: 'All Shifts' },
    { id: 'active', label: 'Active Now', tone: 'success' },
    { id: 'upcoming', label: 'Upcoming', tone: 'info' },
    { id: 'completed', label: 'Completed' },
  ];

  statusOptions.forEach((opt) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip ${selectedStatus === opt.id ? 'is-active' : ''}`;
    chip.setAttribute('aria-pressed', selectedStatus === opt.id ? 'true' : 'false');

    const labelSpan = document.createElement('span');
    labelSpan.textContent = opt.label;

    const countSpan = document.createElement('span');
    countSpan.className = `chip-count${opt.tone ? ' tone-' + opt.tone : ''}`;
    countSpan.textContent = String(shiftCountMap[opt.id] ?? 0);

    chip.append(labelSpan, countSpan);

    chip.addEventListener('click', () => {
      selectedStatus = opt.id;
      statusChipBtns.forEach((item) => {
        const isActive = item.id === selectedStatus;
        item.btn.classList.toggle('is-active', isActive);
        item.btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
      renderStatStrip();
      renderShiftsTable();
    });

    statusChipBtns.push({ btn: chip, id: opt.id, countSpan });
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

  function buildPublishBar() {
    const week = viewMode === 'week';
    // Week view publishes every draft of the shown week; the list publishes
    // what is ticked.
    const draftShifts = week ? weekDrafts() : shifts.filter((s) => s.approvalStatus === 'draft');
    const bar = document.createElement('div');
    bar.className = 'scheduler-publish-bar';

    if (!canApproveRoster && !canManageShifts) {
      const note = document.createElement('span');
      note.className = 'scheduler-publish-bar__hint';
      note.textContent = 'You do not hold roster approval authority.';
      bar.appendChild(note);
      return bar;
    }

    const hint = document.createElement('span');
    hint.className = 'scheduler-publish-bar__hint';
    const scope = week ? ' this week' : '';
    hint.textContent = draftShifts.length === 0
      ? `No draft shifts${scope}. New shifts are saved as drafts and are only visible to tanods once published.`
      : `${draftShifts.length} draft shift${draftShifts.length === 1 ? '' : 's'}${scope} not yet visible to tanods.`
        + (canManageShifts ? ' Print the schedule and have it signed on paper, then publish.' : '');

    const buttons = document.createElement('div');
    buttons.className = 'availability-item__actions';
    if (!week && draftShifts.length > 0) {
      const selectAll = document.createElement('button');
      selectAll.type = 'button';
      selectAll.className = 'ghost';
      selectAll.textContent = selectedShiftIds.size === draftShifts.length ? 'Clear selection' : 'Select all drafts';
      selectAll.addEventListener('click', () => {
        if (selectedShiftIds.size === draftShifts.length) selectedShiftIds.clear();
        else draftShifts.forEach((s) => selectedShiftIds.add(s.shiftId));
        renderShiftsTable();
      });
      buttons.appendChild(selectAll);
    }
    const ids = () => (week ? draftShifts.map((s) => s.shiftId) : [...selectedShiftIds]);
    const count = week ? draftShifts.length : selectedShiftIds.size;

    const publishBtn = document.createElement('button');
    publishBtn.type = 'button';
    publishBtn.id = week ? 'publish-week-btn' : 'publish-shifts-btn';
    publishBtn.className = 'primary';
    publishBtn.disabled = count === 0;
    publishBtn.textContent = week
      ? `Publish week (${count})`
      : `Publish (${count})`;
    publishBtn.addEventListener('click', () => publishDrafts(ids()));
    buttons.appendChild(publishBtn);

    bar.append(hint, buttons);
    return bar;
  }

  /** POST /shifts/publish in chunks of 100; warnings are merged by date. */
  async function publishInBatches(list) {
    const published = [];
    const warnings = new Map();
    for (let i = 0; i < list.length; i += PUBLISH_BATCH) {
      const res = await publishShifts(list.slice(i, i + PUBLISH_BATCH), crypto.randomUUID());
      published.push(...res.published);
      for (const w of res.warnings) warnings.set(`${w.code}|${w.date}`, w);
    }
    return { published, warnings: [...warnings.values()] };
  }

  async function publishDrafts(list) {
    if (list.length === 0) return;
    const n = list.length;
    const result = await confirmDialog({
      title: `Publish ${n} shift${n === 1 ? '' : 's'}?`,
      description: 'The shifts become visible to the assigned tanods. Printing and signing the schedule is done on paper, outside the app.',
      confirmLabel: 'Publish',
      onConfirmAsync: async () => {
        try {
          const res = await publishInBatches(list);
          publishWarnings = res.warnings;
          publishedCount = res.published.length;
        } catch (err) {
          throw new Error(err instanceof ApiClientError ? err.message : 'Could not publish these shifts.');
        }
      },
    });
    if (result) {
      showToast(`${publishedCount} shift${publishedCount === 1 ? '' : 's'} published.`, { variant: 'success' });
      selectedShiftIds.clear();
      load();
    }
  }

  function buildWarningsBlock() {
    if (publishWarnings.length === 0) return null;
    const box = document.createElement('div');
    box.className = 'scheduler-publish-warnings';
    box.setAttribute('role', 'status');
    const title = document.createElement('strong');
    title.textContent = 'Published with coverage warnings';
    const list = document.createElement('ul');
    for (const w of publishWarnings) {
      const li = document.createElement('li');
      li.textContent = w.code === 'NO_COVERAGE'
        ? `${w.date}: no tanod is scheduled on this date.`
        : `${w.date}: ${w.code}`;
      list.appendChild(li);
    }
    box.append(title, list);
    return box;
  }

  function renderShiftsTable() {
    listPane.innerHTML = '';
    const warningsBlock = buildWarningsBlock();
    if (warningsBlock) listPane.appendChild(warningsBlock);
    listPane.appendChild(buildPublishBar());
    const listToolbar = document.createElement('div');
    listToolbar.className = 'scheduler-week-toolbar';
    listToolbar.appendChild(buildViewToggle());
    listPane.appendChild(listToolbar);

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
          case 'select': {
            if (!(canApproveRoster || canManageShifts) || shift.approvalStatus !== 'draft') return '<span class="text-tertiary">—</span>';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = selectedShiftIds.has(shift.shiftId);
            box.setAttribute('aria-label', `Select draft shift #${shift.shiftId} for publishing`);
            box.addEventListener('change', () => {
              if (box.checked) selectedShiftIds.add(shift.shiftId);
              else selectedShiftIds.delete(shift.shiftId);
              renderShiftsTable();
            });
            return box;
          }

          case 'approval': {
            const pill = document.createElement('span');
            const draft = shift.approvalStatus === 'draft';
            pill.className = `shift-approval-pill shift-approval-pill--${draft ? 'draft' : 'published'}`;
            pill.textContent = draft ? 'Draft' : 'Published';
            if (draft && shift.pendingReapproval) {
              // An approved swap changed this (previously published) shift:
              // it needs the approver again before the tanod sees it as final.
              pill.textContent = 'Draft — swap awaiting re-approval';
            }
            return pill;
          }

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
              // Without the roster (non-Admin) an assigned shift shows its id
              // rather than being mislabelled "Unassigned".
              unassigned.textContent = shift.userId ? `Tanod #${shift.userId}` : 'Unassigned';
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
            if (!canManageShifts) return '<span class="text-tertiary">—</span>';
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

    const tableCard = document.createElement('div');
    tableCard.className = 'scheduler-table-card unified-table-card';
    tableCard.append(filterBar, table);
    listPane.appendChild(tableCard);
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
        Adding this <strong>${preview.shiftDuration.toFixed(1)}h</strong> shift brings ${escapeHtml(tanodName)}'s 7-day schedule to <strong>${preview.projectedHours.toFixed(1)} hrs</strong> (+${preview.overBy.toFixed(1)}h over the 56h threshold). A fatigue safety flag will be triggered.
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
        Adding this <strong>${preview.shiftDuration.toFixed(1)}h</strong> shift brings ${escapeHtml(tanodName)} to <strong>${preview.projectedHours.toFixed(1)} hrs / 56h max</strong> (${(FATIGUE_THRESHOLD_HOURS - preview.projectedHours).toFixed(1)}h remaining before safety limit).
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
    option.textContent = `${rosterLabel(t)} (${currentHours.toFixed(1)}h scheduled${badge})`;
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

  const draftNote = document.createElement('p');
  draftNote.className = 'note';
  draftNote.textContent = 'New shifts are saved as drafts. Tanods see a shift only after it is published.';

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
    draftNote,
    submitButton
  );
  card.append(heading, form);

  if (tanods.length === 0) {
    form.hidden = true;
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'No active Tanods exist in this barangay yet.';
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
      showToast('Shift saved as a draft.', { variant: 'success' });
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
  modal.setAttribute('aria-labelledby', 'scheduler-edit-title');

  const header = document.createElement('div');
  header.className = 'personnel-modal__header';

  const title = document.createElement('h3');
  title.id = 'scheduler-edit-title';
  title.className = 'personnel-modal__title';
  title.innerHTML = `<span aria-hidden="true">${icons.calendar(20)}</span><span>Edit Shift Schedule</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'personnel-modal__close';
  closeBtn.setAttribute('aria-label', 'Close');
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
  tanodLabel.htmlFor = 'scheduler-edit-tanod';
  const tanodSelect = document.createElement('select');
  tanodSelect.id = 'scheduler-edit-tanod';
  tanodSelect.className = 'personnel-form-select';
  const unassignedOpt = document.createElement('option');
  unassignedOpt.value = '';
  unassignedOpt.textContent = 'Unassigned';
  tanodSelect.appendChild(unassignedOpt);
  // The shift's current tanod may be missing from the list (a Secretary's
  // list only holds tanods with submitted availability). Keep them as a
  // selectable option so saving never silently unassigns the shift.
  const editableTanods = (shift.userId && !tanods.some((t) => t.userId === shift.userId))
    ? [{ userId: shift.userId, fullName: `Tanod #${shift.userId} (current)` }, ...tanods]
    : tanods;
  for (const t of editableTanods) {
    const currentHours = calculateTanodHoursInWindow(shifts, t.userId, new Date().toISOString(), shift.shiftId);
    const opt = document.createElement('option');
    opt.value = String(t.userId);
    const badge = currentHours > FATIGUE_THRESHOLD_HOURS ? ' [Over Limit]' : (currentHours >= 48 ? ' [Near Limit]' : '');
    opt.textContent = `${rosterLabel(t)} (${currentHours.toFixed(1)}h scheduled${badge})`;
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
  zoneLabel.htmlFor = 'scheduler-edit-zone';
  const zoneInput = document.createElement('input');
  zoneInput.id = 'scheduler-edit-zone';
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
  startLabel.htmlFor = 'scheduler-edit-start';
  const startInput = document.createElement('input');
  startInput.id = 'scheduler-edit-start';
  startInput.type = 'datetime-local';
  startInput.className = 'personnel-form-input';
  startInput.value = toDatetimeLocal(shift.startAt);
  startField.append(startLabel, startInput);

  const endField = document.createElement('div');
  endField.className = 'personnel-form-field';
  const endLabel = document.createElement('label');
  endLabel.className = 'personnel-form-label';
  endLabel.textContent = 'End Time';
  endLabel.htmlFor = 'scheduler-edit-end';
  const endInput = document.createElement('input');
  endInput.id = 'scheduler-edit-end';
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
        const tanodName = tanod ? tanod.fullName : (shift.userId ? `Tanod #${shift.userId}` : 'Unassigned');
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


/**
 * A4 print of one week as a grid (rows = tanods, columns = days), for the
 * official to sign on paper before the week is published.
 */
function openWeekPrintModal({ weekStart, rows, shifts, user, barangayName }) {
  const days = weekDays(weekStart);
  const week = shiftsInWeek(shifts, weekStart);
  const cellHtml = (userId, date) => {
    const list = shiftsOnDay(week.filter((s) => (s.userId ?? null) === userId), date);
    if (list.length === 0) return '<span class="week-print__empty">—</span>';
    return list.map((s) => `<div class="week-print__shift">${escapeHtml(shiftTimeLabel(s))}${s.patrolZone ? `<small>${escapeHtml(s.patrolZone)}</small>` : ''}</div>`).join('');
  };
  const hoursOf = (userId) => {
    const h = week.filter((s) => (s.userId ?? null) === userId)
      .reduce((acc, s) => acc + (new Date(s.endAt) - new Date(s.startAt)) / 3600000, 0);
    return Math.round(h * 10) / 10;
  };
  const bodyRows = rows.length > 0
    ? rows.map((r) => `
        <tr>
          <td><strong>${escapeHtml(r.name)}</strong></td>
          ${days.map((d) => `<td>${cellHtml(r.userId, d)}</td>`).join('')}
          <td class="print-sheet__table--right">${r.userId === null ? '' : escapeHtml(String(hoursOf(r.userId)))}</td>
        </tr>`).join('')
    : `<tr><td colspan="9" style="text-align:center;">No shifts this week.</td></tr>`;
  const coverageRow = days.map((d) => {
    const { covered } = dayCoverage(shifts, d);
    return `<td>${covered.length}/${SHIFT_PRESETS.length}</td>`;
  }).join('');
  const generatedStamp = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const sheetHtml = `
    <div class="print-sheet__header">
      <img src="assets/logo.svg" alt="" width="44" height="44" class="print-sheet__header-logo" aria-hidden="true" />
      <div class="print-sheet__header-text">
        <p style="margin:0;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;color:#475569;">Republic of the Philippines · Province of Sorsogon · Municipality of Pilar</p>
        <h1 class="print-sheet__doc-title">BARANGAY TANOD WEEKLY DUTY ROSTER</h1>
        <p class="print-sheet__doc-subtitle">${escapeHtml(barangayName)} · Week of ${escapeHtml(weekRangeLabel(weekStart))}</p>
      </div>
    </div>

    <div class="print-sheet__meta-bar">
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__meta-label">Week</span>
        <span class="print-sheet__meta-val">${escapeHtml(weekRangeLabel(weekStart))}</span>
      </div>
      <div class="print-sheet__meta-cell">
        <span class="print-sheet__meta-label">Shifts</span>
        <span class="print-sheet__meta-val print-sheet__meta-val--mono">${week.length}</span>
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

    <div class="print-sheet__section">
      <table class="print-sheet__table week-print">
        <thead>
          <tr>
            <th>Tanod</th>
            ${days.map((d, i) => `<th>${WEEK_DAY_LABELS[i]}<br><small>${escapeHtml(shortDateLabel(d))}</small></th>`).join('')}
            <th class="print-sheet__table--right">Hours</th>
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
          <tr class="week-print__coverage">
            <td>Shifts covered</td>
            ${coverageRow}
            <td></td>
          </tr>
        </tbody>
      </table>
      <p class="week-print__note">Standard shifts: Morning 06:00–14:00 · Afternoon 14:00–22:00 · Night 22:00–06:00. "Shifts covered" counts how many of the three have a tanod on duty.</p>
    </div>

    <div class="print-sheet__signatures">
      <div class="print-sheet__sig-box">
        <div class="print-sheet__sig-line"></div>
        <div class="print-sheet__sig-name">${escapeHtml(user?.fullName || 'Chief Tanod / Admin Officer')}</div>
        <div class="print-sheet__sig-role">Prepared By</div>
      </div>
      <div class="print-sheet__sig-box">
        <div class="print-sheet__sig-line"></div>
        <div class="print-sheet__sig-name">Punong Barangay</div>
        <div class="print-sheet__sig-role">Approved · Date signed: ____________</div>
      </div>
    </div>

    <div class="print-sheet__footer">
      <span>BARANGUARD · Weekly Duty Roster</span>
      <span>Printed ${escapeHtml(generatedStamp)}</span>
    </div>
  `;

  openPrintPreviewModal({
    title: 'Weekly Duty Roster — Print Preview',
    subtitle: 'A4 roster to print and sign on paper, then publish the week',
    sheetId: 'printable-week-roster-sheet',
    sheetHtml,
    orientation: 'landscape',
  });
}
