import { describe, expect, it } from 'vitest';
import { normalizeServerTimestamps, toUtcIso } from './serverTime';

describe('toUtcIso', () => {
  it('marks the zone-less database form as UTC', () => {
    expect(toUtcIso('2026-10-15 04:47:01')).toBe('2026-10-15T04:47:01Z');
    expect(new Date(toUtcIso('2026-10-15 04:47:01')).getTime()).toBe(Date.UTC(2026, 9, 15, 4, 47, 1));
  });
  it('leaves zoned timestamps, plain dates and other text alone', () => {
    expect(toUtcIso('2026-10-15T04:47:01Z')).toBe('2026-10-15T04:47:01Z');
    expect(toUtcIso('2026-10-15T12:47:01+08:00')).toBe('2026-10-15T12:47:01+08:00');
    expect(toUtcIso('2026-10-15')).toBe('2026-10-15');
    expect(toUtcIso('Domestic dispute 2026-10-15 04:47:01 near the road')).toBe('Domestic dispute 2026-10-15 04:47:01 near the road');
  });
});

describe('normalizeServerTimestamps', () => {
  it('normalises nested fields and arrays without touching other values', () => {
    const out = normalizeServerTimestamps({
      dispatch_id: 133,
      dispatched_at: '2026-10-15 04:47:01',
      arrived_at: null,
      items: [{ completed_at: '2026-10-11 11:08:22' }, { note: 'plain' }],
    });
    expect(out).toEqual({
      dispatch_id: 133,
      dispatched_at: '2026-10-15T04:47:01Z',
      arrived_at: null,
      items: [{ completed_at: '2026-10-11T11:08:22Z' }, { note: 'plain' }],
    });
  });
});
