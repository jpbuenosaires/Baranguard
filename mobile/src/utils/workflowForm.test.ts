import { describe, expect, it } from 'vitest';
import {
  clampHours,
  clampMinutes,
  fillAllDays,
  fillWeekdays,
  formatDurationTotal,
  isWeekday,
  summarizeWindows,
} from './workflowForm';

describe('duration helpers', () => {
  it('clamps hours to 24 and minutes to 59, digits only', () => {
    expect(clampHours('99')).toBe('24');
    expect(clampMinutes('75')).toBe('59');
    expect(clampMinutes('-5')).toBe('5');
    expect(clampHours('')).toBe('');
    expect(clampHours('abc')).toBe('');
    expect(clampMinutes('007')).toBe('7');
  });
  it('formats the total', () => {
    expect(formatDurationTotal('8', '30')).toBe('Total 8 h 30 min');
    expect(formatDurationTotal('2', '')).toBe('Total 2 h');
    expect(formatDurationTotal('', '45')).toBe('Total 45 min');
    expect(formatDurationTotal('', '')).toBeNull();
    expect(formatDurationTotal('0', '0')).toBeNull();
  });
});

describe('availability quick-fill', () => {
  const dates = ['2026-10-12', '2026-10-13', '2026-10-17', '2026-10-18']; // Mon Tue Sat Sun
  const win = [{ from: '06:00', to: '14:00' }];
  it('detects weekdays', () => {
    expect(dates.map(isWeekday)).toEqual([true, true, false, false]);
  });
  it('fills every day with independent copies', () => {
    const out = fillAllDays(dates, win);
    expect(Object.keys(out)).toHaveLength(4);
    out['2026-10-12'][0].from = '07:00';
    expect(out['2026-10-13'][0].from).toBe('06:00');
    expect(win[0].from).toBe('06:00');
  });
  it('fills weekdays only', () => {
    const out = fillWeekdays(dates, win);
    expect(out['2026-10-13']).toHaveLength(1);
    expect(out['2026-10-17']).toEqual([]);
  });
  it('summarises windows', () => {
    expect(summarizeWindows(win)).toBe('06:00-14:00');
    expect(summarizeWindows([])).toBe('Not available');
    expect(summarizeWindows([...win, { from: '18:00', to: '22:00' }])).toBe('06:00-14:00, 18:00-22:00');
  });
});

import { routeAccomplishmentProblem } from './workflowForm';

describe('routeAccomplishmentProblem', () => {
  it('routes messages to their field', () => {
    expect(routeAccomplishmentProblem('Duration must be between 1 minute and 24 hours.')).toBe('duration');
    expect(routeAccomplishmentProblem('The work date cannot be in the future.')).toBe('date');
    expect(routeAccomplishmentProblem('Entries can only be added up to 62 days back.')).toBe('date');
    expect(routeAccomplishmentProblem('Choose the date you worked.')).toBe('date');
    expect(routeAccomplishmentProblem('Describe what you did.')).toBe('text');
    expect(routeAccomplishmentProblem('Enter both a start and an end time, or leave both blank.')).toBe('times');
    expect(routeAccomplishmentProblem('Something else')).toBe('general');
  });
});
