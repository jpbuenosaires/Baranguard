/**
 * rosterWeek.js — pure date and roster helpers for the Scheduler's weekly
 * grid (Personnel > Scheduler, 2026-10-12).
 *
 * Every calculation is done on Asia/Manila wall time (fixed +08:00, no DST),
 * whatever time zone the browser is in: shift timestamps arrive as UTC ISO
 * strings, availability windows as Manila `{date, start, end}`, and the API
 * reads a bare `YYYY-MM-DDTHH:MM` it receives as Manila time. Nothing here
 * touches the DOM or the network, so it is unit-tested directly.
 *
 * Availability is a fixed input: whatever a tanod submitted is shown as-is
 * (any status). The grid only warns when a shift falls outside it.
 */

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MANILA_OFFSET_MS = 8 * HOUR_MS;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const WEEK_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The three standard shifts. Night ends at 06:00 the next day. */
export const SHIFT_PRESETS = [
  { type: 'morning', label: 'Morning', short: 'AM', start: '06:00', end: '14:00' },
  { type: 'afternoon', label: 'Afternoon', short: 'PM', start: '14:00', end: '22:00' },
  { type: 'night', label: 'Night', short: 'Night', start: '22:00', end: '06:00' },
];

/** Hours a tanod may be scheduled in a rolling 7 days before a fatigue flag. */
export const WEEKLY_HOURS_LIMIT = 56;
/** Server hard cap per tanod per Manila day (422 DAILY_HOURS_EXCEEDED). */
export const DAILY_HOURS_LIMIT = 12;

const pad = (n) => String(n).padStart(2, '0');

/** UTC ms of a Manila wall-clock time. `time` is `HH:MM` (24:00 allowed). */
export function manilaToMs(date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - MANILA_OFFSET_MS;
}

/** `{date:'YYYY-MM-DD', time:'HH:MM'}` in Manila for an ISO string or ms. */
export function manilaParts(value) {
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  const d = new Date(ms + MANILA_OFFSET_MS);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/** The `YYYY-MM-DDTHH:MM` Manila string the shift endpoints accept. */
export function msToManilaLocal(ms) {
  const { date, time } = manilaParts(ms);
  return `${date}T${time}`;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Monday of the week holding `date`. */
export function weekStartOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function isDate(value) {
  return DATE_RE.test(String(value ?? ''));
}

/** "Oct 12" style label for a `YYYY-MM-DD`. */
export function shortDateLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Oct 12 – 18, 2026" (or across months/years) for the week toolbar and print. */
export function weekRangeLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const year = end.slice(0, 4);
  return `${shortDateLabel(weekStart)} – ${shortDateLabel(end)}, ${year}`;
}

/** Start/end (ms and Manila-local strings) of a preset shift on `date`. */
export function presetRange(date, type) {
  const preset = SHIFT_PRESETS.find((p) => p.type === type);
  if (!preset) return null;
  const startMs = manilaToMs(date, preset.start);
  const endDate = preset.end <= preset.start ? addDays(date, 1) : date;
  const endMs = manilaToMs(endDate, preset.end);
  return { startMs, endMs, startLocal: msToManilaLocal(startMs), endLocal: msToManilaLocal(endMs) };
}

/** Short label for a chip: the preset name when it matches one, else "08:00–16:00". */
export function shiftChipLabel(shift) {
  const s = manilaParts(shift.startAt);
  const e = manilaParts(shift.endAt);
  const preset = SHIFT_PRESETS.find((p) => p.start === s.time && p.end === e.time);
  return preset ? preset.short : `${s.time}–${e.time}`;
}

export function shiftTimeLabel(shift) {
  return `${manilaParts(shift.startAt).time}–${manilaParts(shift.endAt).time}`;
}

const startMsOf = (s) => new Date(s.startAt).getTime();
const endMsOf = (s) => new Date(s.endAt).getTime();

/** Shifts whose start falls on a Manila day of the week. */
export function shiftsInWeek(shifts, weekStart) {
  const from = manilaToMs(weekStart);
  const to = manilaToMs(addDays(weekStart, 7));
  return shifts.filter((s) => {
    const t = startMsOf(s);
    return t >= from && t < to;
  });
}

export function shiftsOnDay(shifts, date) {
  return shifts.filter((s) => manilaParts(s.startAt).date === date);
}

/**
 * A tanod's availability as UTC intervals, from every submission for them.
 * A window ending at 23:59 is read as running to midnight, so a Night shift
 * can be covered by two back-to-back windows.
 * @returns {Array<{startMs:number, endMs:number, availId:number}>}
 */
export function availabilityIntervals(availability, userId) {
  const out = [];
  for (const item of availability) {
    if (item.userId !== userId) continue;
    for (const w of item.windows || []) {
      if (!isDate(w?.date) || !w.start || !w.end) continue;
      const startMs = manilaToMs(w.date, w.start);
      const endMs = w.end === '23:59' ? manilaToMs(addDays(w.date, 1)) : manilaToMs(w.date, w.end);
      if (endMs > startMs) out.push({ startMs, endMs, availId: item.availId });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Minutes of [startMs, endMs) that no interval covers. */
export function uncoveredMinutes(startMs, endMs, intervals) {
  let cursor = startMs;
  let gap = 0;
  for (const iv of intervals) {
    if (iv.endMs <= cursor) continue;
    if (iv.startMs >= endMs) break;
    if (iv.startMs > cursor) gap += iv.startMs - cursor;
    cursor = Math.max(cursor, iv.endMs);
    if (cursor >= endMs) break;
  }
  if (cursor < endMs) gap += endMs - cursor;
  return Math.round(gap / 60000);
}

/** True when the whole span sits inside the tanod's availability (1 min slack). */
export function isWithinAvailability(startMs, endMs, intervals) {
  return uncoveredMinutes(startMs, endMs, intervals) <= 1;
}

/** The submission whose window holds the shift's start (for source_availability_id). */
export function sourceAvailabilityFor(startMs, intervals) {
  const hit = intervals.find((iv) => iv.startMs <= startMs && startMs < iv.endMs);
  return hit ? hit.availId : null;
}

/**
 * The parts of a Manila day a tanod is available, as minutes from midnight.
 * @returns {Array<{from:number, to:number}>}
 */
export function availableSegmentsOnDay(date, intervals) {
  const dayStart = manilaToMs(date);
  const dayEnd = dayStart + DAY_MS;
  const out = [];
  for (const iv of intervals) {
    const from = Math.max(iv.startMs, dayStart);
    const to = Math.min(iv.endMs, dayEnd);
    if (to > from) out.push({ from: (from - dayStart) / 60000, to: (to - dayStart) / 60000 });
  }
  return out;
}

/** "06:00–14:00, 18:00–24:00" for a cell's tooltip. */
export function segmentsLabel(segments) {
  const fmt = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  return segments.map((s) => `${fmt(s.from)}–${fmt(s.to)}`).join(', ');
}

const hoursOf = (s) => Math.max(0, endMsOf(s) - startMsOf(s)) / HOUR_MS;

/** Hours of the shifts a tanod STARTS in the given week. */
export function weekHours(shifts, userId, weekStart) {
  const sum = shiftsInWeek(shifts, weekStart)
    .filter((s) => s.userId === userId)
    .reduce((acc, s) => acc + hoursOf(s), 0);
  return Math.round(sum * 10) / 10;
}

/**
 * Rolling 7-day hours ending at this shift's end, the shift included (same
 * window as the backend FatigueCalculator: starts in [end - 7 days, end)).
 */
export function rollingHoursAt(shifts, shift) {
  if (!shift.userId) return 0;
  const end = endMsOf(shift);
  const from = end - 7 * DAY_MS;
  const sum = shifts
    .filter((s) => s.userId === shift.userId)
    .filter((s) => { const t = startMsOf(s); return t >= from && t < end; })
    .reduce((acc, s) => acc + hoursOf(s), 0);
  return Math.round(sum * 10) / 10;
}

/**
 * Which of the three standard shifts have someone on duty on `date`. A slot
 * counts as covered when assigned shifts overlap at least half of it.
 * @returns {{covered:string[], missing:string[]}} preset types
 */
export function dayCoverage(shifts, date) {
  const covered = [];
  const missing = [];
  for (const preset of SHIFT_PRESETS) {
    const slot = presetRange(date, preset.type);
    const need = (slot.endMs - slot.startMs) / 2;
    const overlap = shifts
      .filter((s) => s.userId)
      .reduce((acc, s) => acc + Math.max(0, Math.min(endMsOf(s), slot.endMs) - Math.max(startMsOf(s), slot.startMs)), 0);
    (overlap >= need ? covered : missing).push(preset.type);
  }
  return { covered, missing };
}

/**
 * What "Copy last week" would create: every assigned shift of the previous
 * week, moved forward 7 days, unless the tanod is not available then or an
 * identical shift already exists.
 * @returns {{toCreate:Array<{userId:number, patrolZone:string|null, startLocal:string, endLocal:string, sourceAvailabilityId:number|null}>, skippedUnavailable:number, skippedExisting:number}}
 */
export function planCopyFromPreviousWeek(shifts, availability, weekStart) {
  const previous = shiftsInWeek(shifts, addDays(weekStart, -7)).filter((s) => s.userId);
  const toCreate = [];
  let skippedUnavailable = 0;
  let skippedExisting = 0;
  for (const s of previous) {
    const startMs = startMsOf(s) + 7 * DAY_MS;
    const endMs = endMsOf(s) + 7 * DAY_MS;
    const exists = shifts.some((o) => o.userId === s.userId && startMsOf(o) === startMs && endMsOf(o) === endMs);
    if (exists) { skippedExisting += 1; continue; }
    const intervals = availabilityIntervals(availability, s.userId);
    if (!isWithinAvailability(startMs, endMs, intervals)) { skippedUnavailable += 1; continue; }
    toCreate.push({
      userId: s.userId,
      patrolZone: s.patrolZone || null,
      startLocal: msToManilaLocal(startMs),
      endLocal: msToManilaLocal(endMs),
      sourceAvailabilityId: sourceAvailabilityFor(startMs, intervals),
    });
  }
  return { toCreate, skippedUnavailable, skippedExisting };
}

/** New start/end when a shift is dragged to another day, keeping its times. */
export function moveToDay(shift, date) {
  const delta = manilaToMs(date) - manilaToMs(manilaParts(shift.startAt).date);
  const startMs = startMsOf(shift) + delta;
  const endMs = endMsOf(shift) + delta;
  return { startMs, endMs, startLocal: msToManilaLocal(startMs), endLocal: msToManilaLocal(endMs) };
}

/**
 * Returns tanods who are available for a given slot, not already scheduled in an overlapping
 * shift, and who won't exceed daily (12h) or weekly (56h) limits.
 * Ranked by lowest weekly hours first for balanced duty distribution.
 */
export function suggestAvailableTanods(shifts, availability, date, presetType, tanods) {
  const slot = presetRange(date, presetType);
  const slotDuration = (slot.endMs - slot.startMs) / HOUR_MS;
  const eligible = [];

  for (const t of tanods) {
    if (!t.userId) continue;
    const intervals = availabilityIntervals(availability, t.userId);
    if (!isWithinAvailability(slot.startMs, slot.endMs, intervals)) continue;

    const overlaps = shifts.some((s) => {
      if (s.userId !== t.userId) return false;
      return Math.max(startMsOf(s), slot.startMs) < Math.min(endMsOf(s), slot.endMs);
    });
    if (overlaps) continue;

    const sameDayShifts = shiftsOnDay(shifts.filter((s) => s.userId === t.userId), date);
    const dayHours = sameDayShifts.reduce((acc, s) => acc + hoursOf(s), 0) + slotDuration;
    if (dayHours > DAILY_HOURS_LIMIT) continue;

    const rollingStart = slot.endMs - 7 * DAY_MS;
    const rollingHours = shifts
      .filter((s) => s.userId === t.userId && startMsOf(s) >= rollingStart && startMsOf(s) < slot.endMs)
      .reduce((acc, s) => acc + hoursOf(s), 0) + slotDuration;
    if (rollingHours > WEEKLY_HOURS_LIMIT) continue;

    const currentWeekTotal = shifts
      .filter((s) => s.userId === t.userId)
      .reduce((acc, s) => acc + hoursOf(s), 0);

    eligible.push({
      userId: t.userId,
      fullName: t.fullName,
      officialTitle: t.officialTitle || null,
      currentHours: Math.round(currentWeekTotal * 10) / 10,
      sourceAvailabilityId: sourceAvailabilityFor(slot.startMs, intervals),
    });
  }

  eligible.sort((a, b) => a.currentHours - b.currentHours || a.fullName.localeCompare(b.fullName));
  return eligible;
}

/**
 * Automatically creates a plan to cover uncovered standard shift slots across the shown week.
 * Matches available tanods with lowest weekly workload without exceeding limits.
 */
export function planSmartCoverage(shifts, availability, weekStart, tanods) {
  const days = weekDays(weekStart);
  const simulatedShifts = [...shifts];
  const toCreate = [];
  let filledCount = 0;
  let unfilledCount = 0;

  for (const date of days) {
    const { missing } = dayCoverage(simulatedShifts, date);
    for (const presetType of missing) {
      const candidates = suggestAvailableTanods(simulatedShifts, availability, date, presetType, tanods);
      if (candidates.length === 0) {
        unfilledCount++;
        continue;
      }
      const chosen = candidates[0];
      const slot = presetRange(date, presetType);
      const newShift = {
        userId: chosen.userId,
        patrolZone: null,
        startAt: slot.startLocal,
        endAt: slot.endLocal,
        startLocal: slot.startLocal,
        endLocal: slot.endLocal,
        sourceAvailabilityId: chosen.sourceAvailabilityId,
      };
      toCreate.push(newShift);
      simulatedShifts.push(newShift);
      filledCount++;
    }
  }

  return { toCreate, filledCount, unfilledCount };
}

