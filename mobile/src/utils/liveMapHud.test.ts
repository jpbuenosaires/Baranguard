import { describe, it, expect } from 'vitest';
import { DATA_STALE_AFTER_MS, basemapChip, formatManilaTime, freshnessLine, isDataStale, thinLabels } from './liveMapHud';

describe('formatManilaTime', () => {
  it('shows Asia/Manila time', () => expect(formatManilaTime(Date.UTC(2026, 9, 15, 6, 5))).toBe('14:05'));
  it('rolls past midnight', () => expect(formatManilaTime(Date.UTC(2026, 9, 15, 17, 30))).toBe('01:30'));
});

describe('freshnessLine', () => {
  const t0 = Date.UTC(2026, 9, 15, 6, 5);
  it('shows Updated hh:mm when fresh', () =>
    expect(freshnessLine(t0, false, t0 + 5000)).toEqual({ text: 'Updated 14:05', offline: false }));
  it('is offline when the last request failed', () =>
    expect(freshnessLine(t0, true, t0 + 5000)).toEqual({ text: 'Offline - showing last known (14:05)', offline: true }));
  it('is offline when data is too old even without a failure', () =>
    expect(freshnessLine(t0, false, t0 + DATA_STALE_AFTER_MS + 1).offline).toBe(true));
  it('is honest before the first load', () => {
    expect(freshnessLine(null, false, t0).offline).toBe(false);
    expect(freshnessLine(null, true, t0).offline).toBe(true);
  });
  it('isDataStale handles null', () => expect(isDataStale(null, false, t0)).toBe(false));
});

describe('basemapChip', () => {
  it('names the offline package version', () =>
    expect(basemapChip({ kind: 'offline', version: 'v3' }, false).label).toBe('Offline map v3'));
  it('online tiles with signal', () => expect(basemapChip({ kind: 'online' }, true).label).toBe('Online map'));
  it('online tiles without signal warns', () => expect(basemapChip({ kind: 'online' }, false).tone).toBe('warning'));
  it('loading and unavailable', () => {
    expect(basemapChip({ kind: 'loading' }, true).label).toBe('Loading map');
    expect(basemapChip({ kind: 'unavailable' }, true).label).toBe('No map');
  });
});

describe('thinLabels', () => {
  it('keeps non-overlapping labels', () => {
    const k = thinLabels([
      { id: 'a', x: 0, y: 0, text: 'R. Gubaton' },
      { id: 'b', x: 300, y: 0, text: 'J. Reyes' },
    ]);
    expect([...k].sort()).toEqual(['a', 'b']);
  });
  it('drops the lower-ranked of two overlapping labels', () => {
    const k = thinLabels([
      { id: 'a', x: 0, y: 0, text: 'R. Gubaton', rank: 5 },
      { id: 'b', x: 10, y: 0, text: 'J. Reyes', rank: 1 },
    ]);
    expect([...k]).toEqual(['b']);
  });
  it('always keeps always-labelled markers, even over each other, and they win', () => {
    const k = thinLabels([
      { id: 'a', x: 0, y: 0, text: 'R. Gubaton', rank: 0 },
      { id: 'self', x: 5, y: 0, text: 'You', always: true },
      { id: 'sos', x: 8, y: 0, text: 'SOS', always: true },
    ]);
    expect(k.has('self')).toBe(true);
    expect(k.has('sos')).toBe(true);
    expect(k.has('a')).toBe(false);
  });
  it('skips markers with no text', () => expect(thinLabels([{ id: 'a', x: 0, y: 0, text: '' }]).size).toBe(0));
});
