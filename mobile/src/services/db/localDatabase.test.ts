import { describe, expect, it } from 'vitest';
import { withDbLock } from './localDatabase';

describe('withDbLock', () => {
  it('runs tasks one at a time, in order, even when one fails', async () => {
    const log: string[] = [];
    const task = (name: string, ms: number, fail = false) => () =>
      new Promise<string>((resolve, reject) => {
        log.push(`start ${name}`);
        setTimeout(() => {
          log.push(`end ${name}`);
          if (fail) reject(new Error(name));
          else resolve(name);
        }, ms);
      });
    const a = withDbLock(task('a', 20));
    const b = withDbLock(task('b', 1, true));
    const c = withDbLock(task('c', 1));
    await expect(a).resolves.toBe('a');
    await expect(b).rejects.toThrow('b');
    await expect(c).resolves.toBe('c');
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });
});
