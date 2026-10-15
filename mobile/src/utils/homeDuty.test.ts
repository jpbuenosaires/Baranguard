import { describe, expect, it } from 'vitest';
import { dutyStatusErrorMessage, formatShiftElapsed } from './homeDuty';

describe('formatShiftElapsed', () => {
  it('shows minutes under an hour and hours with minutes after', () => {
    expect(formatShiftElapsed(0)).toBe('0m');
    expect(formatShiftElapsed(59 * 60000)).toBe('59m');
    expect(formatShiftElapsed(135 * 60000)).toBe('2h 15m');
  });
  it('never goes negative', () => {
    expect(formatShiftElapsed(-5000)).toBe('0m');
  });
});

describe('dutyStatusErrorMessage', () => {
  it('is honest about offline with and without a cached status', () => {
    expect(dutyStatusErrorMessage(true, true)).toMatch(/last known/);
    expect(dutyStatusErrorMessage(true, false)).toMatch(/unknown/);
    expect(dutyStatusErrorMessage(false, false)).toMatch(/Could not fetch/);
  });
});
