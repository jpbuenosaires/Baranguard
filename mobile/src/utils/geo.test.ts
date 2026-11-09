import { describe, expect, it } from 'vitest';
import { compassWord, formatDistance, formatDistanceDirection } from './geo';

describe('geo distance format', () => {
  it('spaces the unit', () => {
    expect(formatDistance(450)).toBe('450 m');
    expect(formatDistance(29200)).toBe('29.2 km');
  });
  it('writes the direction as a word', () => {
    expect(formatDistanceDirection(29200, 'S')).toBe('29.2 km south');
    expect(compassWord('NNE')).toBe('north-northeast');
    expect(compassWord('?')).toBe('?');
  });
});
