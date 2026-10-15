import { describe, expect, it } from 'vitest';
import { clampPeekHeight, combineStatus, statusLinePlacement, visibleDrawerHeight } from './mapStatusLine';

describe('mapStatusLine', () => {
  it('clamps the measured peek height', () => {
    expect(clampPeekHeight(null)).toBe(76);
    expect(clampPeekHeight(10)).toBe(52);
    expect(clampPeekHeight(60.2)).toBe(61);
    expect(clampPeekHeight(200)).toBe(76);
  });
  it('derives visible drawer height per mode', () => {
    expect(visibleDrawerHeight('peek', 60, 800)).toBe(60);
    expect(visibleDrawerHeight('selected', 60, 800)).toBe(215);
    expect(visibleDrawerHeight('expanded', 60, 800)).toBe(520);
  });
  it('keeps the line clear of the rail at collapsed, half and expanded drawer on a portrait phone', () => {
    for (const mode of ['peek', 'selected', 'expanded'] as const) {
      const p = statusLinePlacement(mode, 60, 800);
      expect(p.fits).toBe(true);
      expect(800 - p.bottomPx - 48).toBeGreaterThanOrEqual(120);
    }
  });
  it('reports no room in a short landscape viewport when expanded', () => {
    expect(statusLinePlacement('peek', 60, 360).fits).toBe(true);
    expect(statusLinePlacement('expanded', 60, 360).fits).toBe(false);
  });
  it('merges freshness and basemap into one line', () => {
    expect(combineStatus({ text: 'Updated 14:05', offline: false }, { label: 'Online map', tone: 'neutral' })).toEqual({
      text: 'Updated 14:05 · Online map',
      tone: 'neutral',
    });
    expect(combineStatus({ text: 'Updated 14:05', offline: false }, { label: 'No map', tone: 'warning' }).tone).toBe('warning');
    expect(combineStatus({ text: 'Offline', offline: true }, { label: 'Offline map v1', tone: 'success' }).tone).toBe('warning');
  });
});
