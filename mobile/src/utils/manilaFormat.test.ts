import { describe, expect, it } from 'vitest';
import { formatManilaDateTime, updatedLine } from './manilaFormat';

describe('manilaFormat', () => {
  it('formats a UTC instant in Manila time with a 12h clock', () => {
    expect(formatManilaDateTime('2026-10-13T13:35:00Z')).toBe('Oct 13, 9:35 PM');
    expect(formatManilaDateTime('2026-10-13T16:05:00Z')).toBe('Oct 14, 12:05 AM');
    expect(formatManilaDateTime('2026-10-13T04:00:00Z')).toBe('Oct 13, 12:00 PM');
  });
  it('returns empty text for missing or bad input', () => {
    expect(formatManilaDateTime(null)).toBe('');
    expect(formatManilaDateTime('nope')).toBe('');
  });
  it('builds the updated line', () => {
    expect(updatedLine(null)).toBeNull();
    expect(updatedLine(Date.parse('2026-10-15T06:05:00Z'))).toBe('Updated 14:05');
  });
});
