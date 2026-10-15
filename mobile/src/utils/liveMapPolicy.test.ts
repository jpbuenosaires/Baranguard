import { describe, it, expect } from 'vitest';
import {
  LABEL_FULL_ZOOM,
  agoPhrase,
  combinedLastOk,
  describeFreshness,
  incidentAriaLabel,
  pinLabel,
  shortPersonLabel,
  shouldRefetchOnMove,
  tanodAriaLabel,
  tanodInitials,
} from './liveMapPolicy';

const here = { latitude: 12.9186, longitude: 123.6667 };
// 0.0005 deg latitude is about 55 m, 0.002 is about 222 m.
const near = { latitude: 12.9191, longitude: 123.6667 };
const far = { latitude: 12.9206, longitude: 123.6667 };

describe('shouldRefetchOnMove', () => {
  it('refetches when there was no earlier fetch position', () => expect(shouldRefetchOnMove(null, here)).toBe(true));
  it('does nothing without a current position', () => expect(shouldRefetchOnMove(here, null)).toBe(false));
  it('does not refetch for a move under 100 m', () => expect(shouldRefetchOnMove(here, near)).toBe(false));
  it('does not refetch for an identical fix', () => expect(shouldRefetchOnMove(here, { ...here })).toBe(false));
  it('refetches for a move over 100 m', () => expect(shouldRefetchOnMove(here, far)).toBe(true));
  it('honours a custom threshold', () => expect(shouldRefetchOnMove(here, near, 30)).toBe(true));
});

describe('agoPhrase', () => {
  const now = 10_000_000;
  it('is just now under a minute', () => expect(agoPhrase(now - 59_000, now)).toBe('just now'));
  it('counts minutes', () => expect(agoPhrase(now - 3 * 60_000 - 5_000, now)).toBe('3 min ago'));
  it('counts hours', () => expect(agoPhrase(now - 2 * 3_600_000, now)).toBe('2 h ago'));
  it('counts days', () => expect(agoPhrase(now - 3 * 86_400_000, now)).toBe('3 d ago'));
  it('treats a clock that went backwards as just now', () => expect(agoPhrase(now + 5000, now)).toBe('just now'));
});

describe('describeFreshness', () => {
  const now = 10_000_000;
  it('says loading before the first load', () =>
    expect(describeFreshness(null, false, now)).toEqual({ text: 'Loading nearby data', offline: false }));
  it('says offline with no data when the first load failed', () =>
    expect(describeFreshness(null, true, now)).toEqual({ text: 'Offline, no nearby data loaded yet', offline: true }));
  it('shows updated just now', () =>
    expect(describeFreshness(now - 4000, false, now).text).toBe('Updated just now'));
  it('shows updated minutes ago', () =>
    expect(describeFreshness(now - 3 * 60_000, false, now).text).toBe('Updated 3 min ago'));
  it('shows offline with the real age of the data', () =>
    expect(describeFreshness(now - 3 * 60_000, true, now)).toEqual({
      text: 'Offline, showing last data from 3 min ago',
      offline: true,
    }));
});

describe('combinedLastOk', () => {
  it('needs tanods always', () => expect(combinedLastOk(5, null, false)).toBeNull());
  it('ignores incidents before a GPS fix', () => expect(combinedLastOk(null, 7, false)).toBe(7));
  it('is null when needed incidents never loaded', () => expect(combinedLastOk(null, 7, true)).toBeNull());
  it('uses the oldest list', () => expect(combinedLastOk(5, 9, true)).toBe(5));
});

describe('pinLabel', () => {
  const base = { kind: 'tanod' as const, selected: false, fullText: 'R. Gubaton', shortText: 'RG' };
  it('shows initials when zoomed out', () => expect(pinLabel({ ...base, zoom: 14 })).toEqual({ mode: 'short', text: 'RG' }));
  it('shows the full name at the threshold', () =>
    expect(pinLabel({ ...base, zoom: LABEL_FULL_ZOOM })).toEqual({ mode: 'full', text: 'R. Gubaton' }));
  it('shows the full name when selected even zoomed out', () =>
    expect(pinLabel({ ...base, zoom: 12, selected: true }).mode).toBe('full'));
  it('shows no text for an incident when zoomed out', () =>
    expect(pinLabel({ kind: 'incident', zoom: 14, selected: false, fullText: '#12' })).toEqual({ mode: 'none', text: '' }));
  it('shows the incident number when zoomed in', () =>
    expect(pinLabel({ kind: 'incident', zoom: 17, selected: false, fullText: '#12' }).text).toBe('#12'));
  it('keeps a pinned destination labelled', () =>
    expect(pinLabel({ kind: 'incident', zoom: 12, selected: false, pinned: true, fullText: '#12' }).mode).toBe('full'));
});

describe('names and aria labels', () => {
  it('shortens names', () => {
    expect(shortPersonLabel('Rey Gubaton')).toBe('R. Gubaton');
    expect(shortPersonLabel('Madonna')).toBe('Madonna');
    expect(shortPersonLabel('  ')).toBe('Tanod');
  });
  it('builds initials', () => {
    expect(tanodInitials('rey gubaton')).toBe('RG');
    expect(tanodInitials('Madonna')).toBe('M');
    expect(tanodInitials(null)).toBe('T');
  });
  it('describes tanod states', () => {
    expect(tanodAriaLabel({ fullName: 'Rey Gubaton', isStale: false, dispatchId: null, ageSeconds: 5 })).toBe('Tanod R. Gubaton, active');
    expect(tanodAriaLabel({ fullName: 'Rey Gubaton', isStale: false, dispatchId: 3, ageSeconds: 5 })).toBe('Tanod R. Gubaton, active, on dispatch');
    expect(tanodAriaLabel({ fullName: 'Rey Gubaton', isStale: true, dispatchId: null, ageSeconds: 300 })).toBe(
      'Tanod R. Gubaton, location stale, last seen 5 min ago'
    );
  });
  it('describes incidents without inventing an official code', () => {
    expect(incidentAriaLabel({ incidentId: 159, priority: 'critical', status: 'pending' })).toBe(
      'Incident INC-#159, critical priority, pending'
    );
  });
});
