import { describe, expect, it } from 'vitest';
import { dutyStatusErrorMessage, formatPhMobile, formatShiftElapsed } from './homeDuty';

describe('formatShiftElapsed', () => {
  it('shows minutes under an hour and hours with minutes after', () => {
    expect(formatShiftElapsed(0)).toBe('0 min');
    expect(formatShiftElapsed(59 * 60000)).toBe('59 min');
    expect(formatShiftElapsed(135 * 60000)).toBe('2 h 15 min');
    expect(formatShiftElapsed(120 * 60000)).toBe('2 h');
  });
  it('never goes negative', () => {
    expect(formatShiftElapsed(-5000)).toBe('0 min');
  });
});

describe('dutyStatusErrorMessage', () => {
  it('is honest about offline with and without a cached status', () => {
    expect(dutyStatusErrorMessage(true, true)).toMatch(/last known/);
    expect(dutyStatusErrorMessage(true, false)).toMatch(/unknown/);
    expect(dutyStatusErrorMessage(false, false)).toMatch(/Could not fetch/);
  });
});

describe('formatPhMobile', () => {
  it('groups an 11-digit 09 number as 4-3-4', () => {
    expect(formatPhMobile('09170000099')).toBe('0917 000 0099');
  });
  it('leaves other formats as given', () => {
    expect(formatPhMobile('+639170000099')).toBe('+639170000099');
    expect(formatPhMobile('0917-000-0099')).toBe('0917-000-0099');
    expect(formatPhMobile('911')).toBe('911');
  });
});
