import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  manilaToMs, manilaParts, msToManilaLocal, addDays, weekStartOf, weekDays, presetRange,
  availabilityIntervals, uncoveredMinutes, isWithinAvailability, sourceAvailabilityFor,
  availableSegmentsOnDay, dayCoverage, planCopyFromPreviousWeek, moveToDay, shiftsInWeek,
  rollingHoursAt, shiftChipLabel, weekRangeLabel,
  suggestAvailableTanods, planSmartCoverage,
} from '../../src/services/rosterWeek.js';

// Shifts carry UTC ISO strings, as apiClient revives them.
const iso = (date, time) => new Date(manilaToMs(date, time)).toISOString();
const shift = (id, userId, date, start, endDate, end, extra = {}) => ({
  shiftId: id, userId, patrolZone: null, startAt: iso(date, start), endAt: iso(endDate, end),
  approvalStatus: 'draft', version: 1, ...extra,
});

test('Manila wall time is +08:00 whatever the browser zone', () => {
  assert.equal(new Date(manilaToMs('2026-10-12', '06:00')).toISOString(), '2026-10-11T22:00:00.000Z');
  assert.deepEqual(manilaParts('2026-10-11T22:00:00Z'), { date: '2026-10-12', time: '06:00' });
  assert.equal(msToManilaLocal(manilaToMs('2026-10-12', '22:30')), '2026-10-12T22:30');
});

test('weeks start on Monday and cross months', () => {
  assert.equal(weekStartOf('2026-10-12'), '2026-10-12'); // Monday
  assert.equal(weekStartOf('2026-10-18'), '2026-10-12'); // Sunday
  assert.equal(weekStartOf('2026-11-01'), '2026-10-26');
  assert.deepEqual(weekDays('2026-10-26').slice(-2), ['2026-10-31', '2026-11-01']);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekRangeLabel('2026-10-12'), 'Oct 12 – Oct 18, 2026');
});

test('presets: Night runs 22:00 to 06:00 the next day', () => {
  const night = presetRange('2026-10-12', 'night');
  assert.equal(night.startLocal, '2026-10-12T22:00');
  assert.equal(night.endLocal, '2026-10-13T06:00');
  assert.equal(presetRange('2026-10-12', 'morning').endLocal, '2026-10-12T14:00');
  assert.equal(presetRange('2026-10-12', 'nope'), null);
});

test('availability: windows of every submission count, 23:59 reaches midnight', () => {
  const availability = [
    { availId: 1, userId: 4, windows: [{ date: '2026-10-12', start: '22:00', end: '23:59' }] },
    { availId: 2, userId: 4, windows: [{ date: '2026-10-13', start: '00:00', end: '06:00' }, { date: 'bad', start: '01:00', end: '02:00' }] },
    { availId: 3, userId: 5, windows: [{ date: '2026-10-12', start: '06:00', end: '14:00' }] },
  ];
  const ivs = availabilityIntervals(availability, 4);
  assert.equal(ivs.length, 2, 'malformed windows and other tanods are ignored');
  const night = presetRange('2026-10-12', 'night');
  assert.equal(isWithinAvailability(night.startMs, night.endMs, ivs), true, 'two back-to-back windows cover a night shift');
  assert.equal(sourceAvailabilityFor(night.startMs, ivs), 1);
  const morning = presetRange('2026-10-13', 'morning');
  assert.equal(uncoveredMinutes(morning.startMs, morning.endMs, ivs), 480);
  assert.equal(isWithinAvailability(morning.startMs, morning.endMs, ivs), false);
  assert.deepEqual(availableSegmentsOnDay('2026-10-12', ivs), [{ from: 22 * 60, to: 24 * 60 }]);
  assert.deepEqual(availableSegmentsOnDay('2026-10-14', ivs), []);
});

test('coverage: a slot needs half its length on duty; a night shift covers the next morning only if it overlaps', () => {
  const shifts = [
    shift(1, 4, '2026-10-12', '06:00', '2026-10-12', '14:00'),
    shift(2, 5, '2026-10-12', '22:00', '2026-10-13', '06:00'),
    shift(3, null, '2026-10-12', '14:00', '2026-10-12', '22:00'), // unassigned does not count
  ];
  assert.deepEqual(dayCoverage(shifts, '2026-10-12'), { covered: ['morning', 'night'], missing: ['afternoon'] });
  assert.deepEqual(dayCoverage(shifts, '2026-10-13').covered, []);
});

test('copy last week: same times +7 days, skips unavailable and duplicates', () => {
  const week = '2026-10-12';
  const shifts = [
    shift(1, 4, '2026-10-05', '06:00', '2026-10-05', '14:00', { patrolZone: 'Zone 1' }),
    shift(2, 5, '2026-10-06', '06:00', '2026-10-06', '14:00'),
    shift(3, 6, '2026-10-07', '06:00', '2026-10-07', '14:00'),
    shift(4, 6, '2026-10-14', '06:00', '2026-10-14', '14:00'), // already copied
    shift(5, null, '2026-10-08', '06:00', '2026-10-08', '14:00'), // unassigned: never copied
  ];
  const availability = [
    { availId: 10, userId: 4, windows: [{ date: '2026-10-12', start: '06:00', end: '14:00' }] },
    { availId: 11, userId: 6, windows: [{ date: '2026-10-14', start: '00:00', end: '23:59' }] },
  ];
  const plan = planCopyFromPreviousWeek(shifts, availability, week);
  assert.deepEqual(plan.toCreate, [{
    userId: 4, patrolZone: 'Zone 1', startLocal: '2026-10-12T06:00', endLocal: '2026-10-12T14:00', sourceAvailabilityId: 10,
  }]);
  assert.equal(plan.skippedUnavailable, 1);
  assert.equal(plan.skippedExisting, 1);
});

test('moving to another day keeps the times, overnight included', () => {
  const s = shift(1, 4, '2026-10-12', '22:00', '2026-10-13', '06:00');
  const moved = moveToDay(s, '2026-10-15');
  assert.equal(moved.startLocal, '2026-10-15T22:00');
  assert.equal(moved.endLocal, '2026-10-16T06:00');
});

test('week membership, rolling hours and chip labels', () => {
  const shifts = [
    shift(1, 4, '2026-10-11', '22:00', '2026-10-12', '06:00'), // Sunday before: not in the week
    shift(2, 4, '2026-10-12', '06:00', '2026-10-12', '14:00'),
    shift(3, 4, '2026-10-18', '08:30', '2026-10-18', '12:00'),
  ];
  assert.deepEqual(shiftsInWeek(shifts, '2026-10-12').map((s) => s.shiftId), [2, 3]);
  assert.equal(rollingHoursAt(shifts, shifts[2]), 19.5);
  assert.equal(shiftChipLabel(shifts[1]), 'AM');
  assert.equal(shiftChipLabel(shifts[0]), 'Night');
  assert.equal(shiftChipLabel(shifts[2]), '08:30–12:00');
});

test('suggestAvailableTanods: recommends eligible tanods ranked by lowest weekly hours', () => {
  const tanods = [
    { userId: 4, fullName: 'Jose Reyes' },
    { userId: 5, fullName: 'Maria Dela Cruz' },
  ];
  const availability = [
    { availId: 10, userId: 4, windows: [{ date: '2026-10-12', start: '06:00', end: '14:00' }] },
    { availId: 11, userId: 5, windows: [{ date: '2026-10-12', start: '06:00', end: '14:00' }] },
  ];
  // Jose already has 8 hours scheduled on Tuesday
  const shifts = [
    shift(1, 4, '2026-10-13', '06:00', '2026-10-13', '14:00'),
  ];
  const candidates = suggestAvailableTanods(shifts, availability, '2026-10-12', 'morning', tanods);
  assert.equal(candidates.length, 2);
  // Maria has 0 hours, so ranked first; Jose has 8 hours, ranked second
  assert.equal(candidates[0].userId, 5);
  assert.equal(candidates[0].currentHours, 0);
  assert.equal(candidates[1].userId, 4);
  assert.equal(candidates[1].currentHours, 8);
});

test('planSmartCoverage: covers open slots with available tanods', () => {
  const tanods = [
    { userId: 4, fullName: 'Jose Reyes' },
    { userId: 5, fullName: 'Maria Dela Cruz' },
  ];
  const availability = [
    { availId: 10, userId: 4, windows: [{ date: '2026-10-12', start: '06:00', end: '14:00' }] },
    { availId: 11, userId: 5, windows: [{ date: '2026-10-12', start: '14:00', end: '22:00' }] },
  ];
  const plan = planSmartCoverage([], availability, '2026-10-12', tanods);
  assert.ok(plan.toCreate.length >= 2);
  assert.equal(plan.toCreate[0].userId, 4);
  assert.equal(plan.toCreate[0].startLocal, '2026-10-12T06:00');
  assert.equal(plan.toCreate[1].userId, 5);
  assert.equal(plan.toCreate[1].startLocal, '2026-10-12T14:00');
});

