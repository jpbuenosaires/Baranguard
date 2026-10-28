import { afterEach, describe, expect, it, vi } from 'vitest';
import { positionWithin } from './sosPosition';

describe('positionWithin', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the fix when it arrives in time', async () => {
    await expect(positionWithin(() => Promise.resolve({ latitude: 1 }), 2000)).resolves.toEqual({ latitude: 1 });
  });

  it('returns null on rejection', async () => {
    await expect(positionWithin(() => Promise.reject(new Error('denied')), 2000)).resolves.toBeNull();
  });

  it('gives up after the bound instead of waiting for a slow fix', async () => {
    vi.useFakeTimers();
    const p = positionWithin(() => new Promise(() => undefined), 2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBeNull();
  });
});
