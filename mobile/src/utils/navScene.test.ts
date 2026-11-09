import { describe, expect, it } from 'vitest';
import { priorityChip, sceneSubline } from './navScene';

describe('navScene', () => {
  it('builds the straight-line subline', () => {
    expect(sceneSubline('S', 29500)).toBe('29.5 km south, straight-line');
    expect(sceneSubline(null, 29500)).toBe('29.5 km, straight-line');
    expect(sceneSubline('N', null)).toBe('Heading north');
    expect(sceneSubline('SSW', 450)).toBe('450 m south-southwest, straight-line');
    expect(sceneSubline(null, null)).toBeNull();
  });
  it('maps priority to a tone', () => {
    expect(priorityChip('critical')).toEqual({ label: 'Critical', tone: 'critical' });
    expect(priorityChip('high').tone).toBe('high');
    expect(priorityChip('normal').tone).toBe('normal');
  });
});
