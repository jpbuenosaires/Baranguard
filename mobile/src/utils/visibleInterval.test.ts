import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleInterval } from './visibleInterval';

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
}

describe('visibleInterval', () => {
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it('runs on schedule while visible and skips while hidden', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const stop = visibleInterval(fn, 1000);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    setHidden(true);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
  });

  it('refreshes immediately on return to the foreground and stops cleanly', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const stop = visibleInterval(fn, 1000);
    setHidden(true);
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(5000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
