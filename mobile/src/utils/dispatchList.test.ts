import { describe, it, expect } from 'vitest';
import { dispatchStatusLabel, sortDispatches } from './dispatchList';

const r = (id: string, status: string, priority: string, lat: number | null = null, lon: number | null = null) => ({
  id, status, priority, latitude: lat, longitude: lon,
});

describe('dispatchStatusLabel', () => {
  it('maps known statuses', () => {
    expect(dispatchStatusLabel('en_route')).toBe('En Route');
    expect(dispatchStatusLabel('completed')).toBe('Completed');
    expect(dispatchStatusLabel('cancelled')).toBe('Cancelled');
  });
  it('never shows a raw snake_case value', () => {
    expect(dispatchStatusLabel('on_hold')).toBe('On hold');
    expect(dispatchStatusLabel('')).toBe('Unknown');
  });
});

describe('sortDispatches', () => {
  it('pins en_route/arrived first, even over a critical assigned call', () => {
    const out = sortDispatches(
      [r('a', 'assigned', 'critical'), r('b', 'arrived', 'normal'), r('c', 'en_route', 'high')],
      null
    );
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });
  it('then orders by priority', () => {
    const out = sortDispatches([r('a', 'assigned', 'normal'), r('b', 'assigned', 'critical'), r('c', 'assigned', 'high')], null);
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
  it('then most recent first within the same priority', () => {
    const a = { ...r('old', 'assigned', 'high'), dispatched_at: '2026-10-14T01:00:00Z' };
    const b = { ...r('new', 'assigned', 'high'), dispatched_at: '2026-10-14T02:00:00Z' };
    expect(sortDispatches([a, b], null).map((x) => x.id)).toEqual(['new', 'old']);
  });
  it('then nearest first when position and coordinates are known', () => {
    const pos = { latitude: 12.9, longitude: 123.7 };
    const out = sortDispatches(
      [r('far', 'assigned', 'normal', 13.5, 124.2), r('near', 'assigned', 'normal', 12.91, 123.71)],
      pos
    );
    expect(out.map((x) => x.id)).toEqual(['near', 'far']);
  });
  it('does not mutate its input', () => {
    const input = [r('a', 'assigned', 'normal'), r('b', 'en_route', 'normal')];
    sortDispatches(input, null);
    expect(input[0].id).toBe('a');
  });
});
