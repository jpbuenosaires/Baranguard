import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, createPoller } from './pollLoop';

describe('backoffDelay', () => {
  it('is the base after success', () => expect(backoffDelay(30_000, 0)).toBe(30_000));
  it('doubles per failure and caps', () => {
    expect(backoffDelay(30_000, 1)).toBe(60_000);
    expect(backoffDelay(30_000, 2)).toBe(120_000);
    expect(backoffDelay(30_000, 9, 300_000)).toBe(300_000);
  });
});

describe('createPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs at once then on the interval', async () => {
    const run = vi.fn().mockResolvedValue(true);
    const p = createPoller(run, 1000);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('never overlaps requests', async () => {
    let resolve: (v: boolean) => void = () => {};
    const run = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    const p = createPoller(run, 1000);
    p.start();
    p.trigger();
    p.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    // the triggers made while in flight collapse into exactly one follow-up run
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('backs off after a failure and recovers after success', async () => {
    const run = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const p = createPoller(run, 1000);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('stop clears the timer and trigger is ignored when stopped', async () => {
    const run = vi.fn().mockResolvedValue(true);
    const p = createPoller(run, 1000);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.stop();
    p.trigger();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a throw as failure', async () => {
    const run = vi.fn().mockRejectedValue(new Error('x'));
    const p = createPoller(run, 1000);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });
});
