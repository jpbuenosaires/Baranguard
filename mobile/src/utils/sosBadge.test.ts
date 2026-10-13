import { describe, it, expect } from 'vitest';
import { activeSosCount, splitSosAlerts, sosTabLabel } from './sosBadge';

const list = [{ status: 'resolved' }, { status: 'active' }, { status: 'acknowledged' }, { status: 'active' }] as never[];

describe('sosBadge', () => {
  it('counts only active alerts', () => expect(activeSosCount(list)).toBe(2));
  it('lists active first, keeps acknowledged visible, collapses resolved', () => {
    const { current, earlier } = splitSosAlerts(list);
    expect(current.map((a: { status: string }) => a.status)).toEqual(['active', 'active', 'acknowledged']);
    expect(earlier.map((a: { status: string }) => a.status)).toEqual(['resolved']);
  });
  it('builds an accessible tab name', () => {
    expect(sosTabLabel(0)).toBe('SOS');
    expect(sosTabLabel(2)).toBe('SOS, 2 active');
  });
});
