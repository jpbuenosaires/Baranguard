import { describe, expect, it } from 'vitest';
import {
  buildAssignOptions,
  capList,
  filterIncidents,
  offerStateText,
  sortNewestFirst,
  sortOffers,
  sosLocationText,
  visibleOffers,
} from '../components/adminFormat';

const inc = (id: number, displayId: string | null, type: string, status: string, loc: string | null = null) => ({
  incidentId: id,
  displayId,
  incidentType: type,
  status,
  locationDescription: loc,
});

describe('filterIncidents', () => {
  const list = [
    inc(1, 'INC-2026-001', 'medical_emergency', 'pending', 'Purok 2 market'),
    inc(2, 'INC-2026-002', 'fire', 'resolved'),
    inc(3, null, 'noise', 'duplicate'),
  ];
  it('matches code, type and location text', () => {
    expect(filterIncidents(list, '2026-002', 'all').map((i) => i.incidentId)).toEqual([2]);
    expect(filterIncidents(list, 'medical', 'all').map((i) => i.incidentId)).toEqual([1]);
    expect(filterIncidents(list, 'market', 'all').map((i) => i.incidentId)).toEqual([1]);
  });
  it('filters by status and "other"', () => {
    expect(filterIncidents(list, '', 'resolved')).toHaveLength(1);
    expect(filterIncidents(list, '', 'other').map((i) => i.incidentId)).toEqual([3]);
  });
});

describe('lists', () => {
  it('caps unless expanded', () => {
    expect(capList([1, 2, 3], false, 2)).toEqual([1, 2]);
    expect(capList([1, 2, 3], true, 2)).toHaveLength(3);
  });
  it('hides finished offers by default', () => {
    const o = [{ status: 'open' }, { status: 'accepted' }];
    expect(visibleOffers(o, false)).toHaveLength(1);
    expect(visibleOffers(o, true)).toHaveLength(2);
  });
  it('sorts offers live first then newest', () => {
    const o = [
      { status: 'accepted', createdAt: '2026-10-14 10:00:00' },
      { status: 'open', createdAt: '2026-10-14 08:00:00' },
      { status: 'open', createdAt: '2026-10-14 09:00:00' },
    ];
    expect(sortOffers(o).map((x) => x.createdAt)).toEqual(['2026-10-14 09:00:00', '2026-10-14 08:00:00', '2026-10-14 10:00:00']);
  });
  it('describes offer state', () => {
    expect(offerStateText({ status: 'accepted', round: 2, expiresAt: '' })).toBe('Round 2, accepted');
    expect(offerStateText({ status: 'open', round: 1, expiresAt: '2026-10-14 10:00:00' })).toMatch(/^Round 1, ends /);
  });
});

describe('sos', () => {
  it('sorts newest first without mutating', () => {
    const a = [{ triggeredAt: '2026-10-14 08:00:00' }, { triggeredAt: '2026-10-14 09:00:00' }];
    expect(sortNewestFirst(a)[0]).toBe(a[1]);
    expect(a[0].triggeredAt).toBe('2026-10-14 08:00:00');
  });
  it('words the location honestly', () => {
    expect(sosLocationText('live', null)).toBe('Live GPS fix');
    expect(sosLocationText('last_known', '2026-10-14 08:00:00')).toMatch(/Last known position, fix from .*not live/);
    expect(sosLocationText(null, null)).toBe('No location available');
    expect(sosLocationText('no_fix', null)).toBe('No location available');
  });
});

describe('buildAssignOptions', () => {
  it('marks assigned tanods and sorts them last', () => {
    const dir = [
      { userId: 1, fullName: 'A', officialTitle: null },
      { userId: 2, fullName: 'B', officialTitle: 'Chief Tanod' },
    ];
    const out = buildAssignOptions(dir, new Set([1]));
    expect(out.map((o) => o.userId)).toEqual([2, 1]);
    expect(out[0].label).toBe('B (Chief Tanod)');
    expect(out[1].label).toBe('A - already assigned');
    expect(out[1].assigned).toBe(true);
  });
});
