/**
 * ShiftWeekGrid — the Scheduler's weekly roster grid (2026-10-12).
 *
 * One row per tanod, one column per Manila day (Mon–Sun). Each cell shows a
 * thin 24-hour bar of the tanod's fixed availability for that day (shaded
 * where available, hatched when not available at all) and the shifts that
 * start that day as chips. A chip turns amber when the shift falls outside
 * the tanod's availability, and red when it takes them past 56 hours in a
 * rolling 7 days or past 12 hours in one day. A coverage row under the grid
 * counts how many of the three standard shifts (06-14, 14-22, 22-06) have
 * somebody on duty each day.
 *
 * Purely presentational: every action is a callback, and the server still
 * re-checks every rule (overlap, 12h/day, role, tenant) on write.
 *
 * @param {{
 *   days: string[],                 // 7 Manila dates, Monday first
 *   today: string,
 *   rows: Array<{userId:number|null, name:string}>,
 *   weekShifts: Array<object>,      // shifts starting in this week
 *   allShifts: Array<object>,       // for rolling-hours checks
 *   availability: Array<object>,
 *   availabilityLoaded: boolean,
 *   canEdit: boolean,
 *   addLabel: string,               // e.g. "Morning"
 *   onAdd?: (userId:number, date:string) => void,
 *   onOpen?: (shift:object) => void,
 *   onMove?: (shift:object, userId:number|null, date:string) => void,
 * }} props
 * @returns {HTMLElement}
 */

import {
  WEEK_DAY_LABELS, SHIFT_PRESETS, WEEKLY_HOURS_LIMIT, DAILY_HOURS_LIMIT,
  availabilityIntervals, availableSegmentsOnDay, segmentsLabel, isWithinAvailability,
  shiftsOnDay, shiftChipLabel, manilaParts, shiftTimeLabel, rollingHoursAt, dayCoverage, shortDateLabel,
} from '../services/rosterWeek.js';

const DAY_MINUTES = 24 * 60;

export function ShiftWeekGrid({
  days, today, rows, weekShifts, allShifts, availability, availabilityLoaded,
  canEdit, addLabel, onAdd, onOpen, onMove, selectedShiftIds, onToggleSelect,
}) {
  const wrap = document.createElement('div');
  wrap.className = 'week-grid-wrap';

  const grid = document.createElement('div');
  grid.className = 'week-grid';
  grid.setAttribute('role', 'table');
  grid.setAttribute('aria-label', 'Weekly shift roster');

  // Header row
  const head = document.createElement('div');
  head.className = 'week-grid__row week-grid__row--head';
  head.setAttribute('role', 'row');
  head.appendChild(headerCell('Tanod', 'week-grid__name'));
  days.forEach((date, i) => {
    const cell = headerCell('', 'week-grid__day');
    if (date === today) cell.classList.add('is-today');
    const dow = document.createElement('span');
    dow.className = 'week-grid__dow';
    dow.textContent = WEEK_DAY_LABELS[i];
    const dl = document.createElement('span');
    dl.className = 'week-grid__date';
    dl.textContent = shortDateLabel(date);
    cell.append(dow, dl);
    head.appendChild(cell);
  });
  head.appendChild(headerCell('Hours', 'week-grid__hours'));
  grid.appendChild(head);

  for (const row of rows) {
    grid.appendChild(buildRow(row));
  }

  // Coverage row
  const cov = document.createElement('div');
  cov.className = 'week-grid__row week-grid__row--coverage';
  cov.setAttribute('role', 'row');
  const covLabel = document.createElement('div');
  covLabel.className = 'week-grid__name';
  covLabel.setAttribute('role', 'rowheader');
  covLabel.textContent = 'Coverage';
  cov.appendChild(covLabel);
  for (const date of days) {
    // Every shift, not just this day's: dayCoverage counts real overlap, so a
    // night shift from the evening before still covers this morning.
    const { covered, missing } = dayCoverage(allShifts, date);
    const cell = document.createElement('div');
    cell.className = 'week-grid__coverage';
    cell.setAttribute('role', 'cell');
    const tone = missing.length === 0 ? 'full' : (covered.length === 0 ? 'none' : 'partial');
    cell.classList.add(`week-grid__coverage--${tone}`);
    cell.textContent = `${covered.length}/${SHIFT_PRESETS.length}`;
    const missingNames = SHIFT_PRESETS.filter((p) => missing.includes(p.type)).map((p) => p.label);
    const tip = missingNames.length ? `No one on: ${missingNames.join(', ')}` : 'All three shifts covered';
    cell.title = tip;
    cell.setAttribute('aria-label', `${shortDateLabel(date)}: ${covered.length} of 3 shifts covered. ${tip}.`);
    cov.appendChild(cell);
  }
  const covEnd = document.createElement('div');
  covEnd.className = 'week-grid__hours';
  covEnd.setAttribute('role', 'cell');
  cov.appendChild(covEnd);
  grid.appendChild(cov);

  wrap.appendChild(grid);
  wrap.appendChild(buildLegend(availabilityLoaded));
  return wrap;

  function buildRow(row) {
    const tr = document.createElement('div');
    tr.className = 'week-grid__row';
    tr.setAttribute('role', 'row');

    const name = document.createElement('div');
    name.className = 'week-grid__name';
    name.setAttribute('role', 'rowheader');
    name.textContent = row.name;
    if (row.userId === null) name.classList.add('text-tertiary');
    tr.appendChild(name);

    const intervals = row.userId === null ? [] : availabilityIntervals(availability, row.userId);
    const rowShifts = weekShifts.filter((s) => (s.userId ?? null) === row.userId);

    for (const date of days) {
      tr.appendChild(buildCell(row, date, intervals, shiftsOnDay(rowShifts, date)));
    }

    const hours = rowShifts.reduce((acc, s) => acc + (new Date(s.endAt) - new Date(s.startAt)) / 3600000, 0);
    const hoursCell = document.createElement('div');
    hoursCell.className = 'week-grid__hours';
    hoursCell.setAttribute('role', 'cell');
    const rounded = Math.round(hours * 10) / 10;
    hoursCell.textContent = row.userId === null ? '' : `${rounded}`;
    if (row.userId !== null && rounded > WEEKLY_HOURS_LIMIT) {
      hoursCell.classList.add('is-over');
      hoursCell.title = `Over ${WEEKLY_HOURS_LIMIT} hours this week`;
    }
    tr.appendChild(hoursCell);
    return tr;
  }

  function buildCell(row, date, intervals, cellShifts) {
    const cell = document.createElement('div');
    cell.className = 'week-grid__cell';
    cell.setAttribute('role', 'cell');
    cell.dataset.date = date;
    if (date === today) cell.classList.add('is-today');

    // Availability bar (only for real tanods, and only once it loaded).
    if (row.userId !== null && availabilityLoaded) {
      const segments = availableSegmentsOnDay(date, intervals);
      const bar = document.createElement('div');
      bar.className = 'week-grid__avail';
      if (segments.length === 0) {
        cell.classList.add('is-unavailable');
        bar.title = 'Not available';
      } else {
        bar.title = `Available ${segmentsLabel(segments)}`;
        for (const seg of segments) {
          const fill = document.createElement('span');
          fill.className = 'week-grid__avail-fill';
          fill.style.left = `${(seg.from / DAY_MINUTES) * 100}%`;
          fill.style.width = `${((seg.to - seg.from) / DAY_MINUTES) * 100}%`;
          bar.appendChild(fill);
        }
      }
      cell.appendChild(bar);
    }

    const chips = document.createElement('div');
    chips.className = 'week-grid__chips';
    for (const shift of cellShifts) chips.appendChild(buildChip(row, shift, intervals));
    cell.appendChild(chips);

    if (canEdit && row.userId !== null && onAdd) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'week-grid__add';
      add.textContent = '+';
      add.title = `Add ${addLabel} shift`;
      add.setAttribute('aria-label', `Add ${addLabel} shift for ${row.name} on ${shortDateLabel(date)}`);
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        onAdd(row.userId, date);
      });
      cell.appendChild(add);
    }

    if (canEdit && onMove) {
      cell.addEventListener('dragover', (e) => {
        e.preventDefault();
        cell.classList.add('is-drop-target');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('is-drop-target'));
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        cell.classList.remove('is-drop-target');
        const id = Number(e.dataTransfer?.getData('text/plain'));
        const shift = weekShifts.find((s) => s.shiftId === id);
        if (!shift) return;
        if ((shift.userId ?? null) === row.userId && shiftsOnDay([shift], date).length === 1) return;
        onMove(shift, row.userId, date);
      });
    }
    return cell;
  }

  function buildChip(row, shift, intervals) {
    const draft = shift.approvalStatus === 'draft';
    const isSelected = Boolean(selectedShiftIds && selectedShiftIds.has(shift.shiftId));
    const chip = document.createElement(canEdit ? 'button' : 'span');
    if (canEdit) chip.type = 'button';
    chip.className = `shift-chip shift-chip--${draft ? 'draft' : 'published'}${isSelected ? ' is-selected' : ''}`;
    chip.dataset.shiftId = String(shift.shiftId);
    if (isSelected) chip.setAttribute('aria-selected', 'true');

    const problems = [];
    if (row.userId !== null && availabilityLoaded) {
      const startMs = new Date(shift.startAt).getTime();
      const endMs = new Date(shift.endAt).getTime();
      if (!isWithinAvailability(startMs, endMs, intervals)) problems.push({ tone: 'warn', text: 'outside availability' });
    }
    if (row.userId !== null) {
      const rolling = rollingHoursAt(allShifts, shift);
      if (rolling > WEEKLY_HOURS_LIMIT) problems.push({ tone: 'danger', text: `${rolling} h in 7 days (over ${WEEKLY_HOURS_LIMIT})` });
      const sameDay = shiftsOnDay(allShifts.filter((s) => s.userId === row.userId), manilaParts(shift.startAt).date);
      const dayHours = sameDay.reduce((acc, s) => acc + (new Date(s.endAt) - new Date(s.startAt)) / 3600000, 0);
      if (dayHours > DAILY_HOURS_LIMIT) problems.push({ tone: 'danger', text: `${Math.round(dayHours * 10) / 10} h in one day (over ${DAILY_HOURS_LIMIT})` });
    }
    if (problems.some((p) => p.tone === 'danger')) chip.classList.add('shift-chip--danger');
    else if (problems.length) chip.classList.add('shift-chip--warn');

    const label = document.createElement('span');
    label.className = 'shift-chip__label';
    if (isSelected) {
      const check = document.createElement('span');
      check.className = 'shift-chip__check';
      check.textContent = '✓ ';
      label.appendChild(check);
    }
    label.appendChild(document.createTextNode(shiftChipLabel(shift)));
    if (problems.length) {
      const warnBadge = document.createElement('span');
      warnBadge.className = 'shift-chip__alert';
      warnBadge.textContent = '!';
      warnBadge.setAttribute('aria-hidden', 'true');
      label.appendChild(document.createTextNode(' '));
      label.appendChild(warnBadge);
    }
    chip.appendChild(label);
    if (shift.patrolZone) {
      const zone = document.createElement('span');
      zone.className = 'shift-chip__zone';
      zone.textContent = shift.patrolZone;
      chip.appendChild(zone);
    }

    const parts = [
      `${shiftTimeLabel(shift)}${shift.patrolZone ? `, ${shift.patrolZone}` : ''}`,
      draft ? (shift.pendingReapproval ? 'draft, swap awaiting re-approval' : 'draft') : 'published',
      isSelected ? 'selected' : '',
      ...problems.map((p) => p.text),
    ].filter(Boolean);
    chip.title = parts.join(' · ');
    chip.setAttribute('aria-label', `${row.name}: ${parts.join(', ')}${canEdit ? '. Open to edit or Ctrl-click to select.' : ''}`);

    if (canEdit) {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onToggleSelect && (e.ctrlKey || e.metaKey || e.shiftKey || (selectedShiftIds && selectedShiftIds.size > 0))) {
          onToggleSelect(shift.shiftId);
          return;
        }
        onOpen?.(shift);
      });
      if (onMove) {
        chip.draggable = true;
        chip.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('text/plain', String(shift.shiftId));
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
      }
    }
    return chip;
  }
}

function headerCell(textValue, className) {
  const cell = document.createElement('div');
  cell.className = className;
  cell.setAttribute('role', 'columnheader');
  if (textValue) cell.textContent = textValue;
  return cell;
}

function buildLegend(availabilityLoaded) {
  const legend = document.createElement('div');
  legend.className = 'week-grid__legend';
  const items = [
    ['week-grid__key--avail', 'Available (as given by the tanod)'],
    ['week-grid__key--unavail', 'Not available'],
    ['week-grid__key--draft', 'Draft'],
    ['week-grid__key--warn', 'Outside availability'],
    ['week-grid__key--danger', `Over ${WEEKLY_HOURS_LIMIT} h a week or ${DAILY_HOURS_LIMIT} h a day`],
  ];
  for (const [cls, label] of items) {
    if (!availabilityLoaded && (cls.endsWith('avail') || cls.endsWith('warn'))) continue;
    const item = document.createElement('span');
    item.className = 'week-grid__legend-item';
    const key = document.createElement('span');
    key.className = `week-grid__key ${cls}`;
    key.setAttribute('aria-hidden', 'true');
    item.append(key, document.createTextNode(label));
    legend.appendChild(item);
  }
  return legend;
}
