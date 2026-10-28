import { beforeEach, describe, expect, it, vi } from 'vitest';

const runSyncPass = vi.fn();
vi.mock('./syncService', () => ({ runSyncPass: () => runSyncPass() }));
vi.mock('./role', () => ({ isTanodSession: async () => true }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn() } }));
vi.mock('@capacitor/network', () => ({ Network: { addListener: vi.fn() } }));

const summary = { attempted: 0, succeeded: 0, duplicates: 0, failed: 0, evidenceUploaded: 0, evidenceFailed: 0, dispatchRejected: 0, dutyRejected: 0 };

describe('sync scheduler', () => {
  beforeEach(() => {
    vi.resetModules();
    runSyncPass.mockReset();
  });

  it('runs one follow-up pass for a trigger that arrives mid-pass', async () => {
    const { forceSyncNow } = await import('./syncScheduler');
    let release!: () => void;
    runSyncPass.mockImplementationOnce(() => new Promise((r) => (release = () => r(summary))));
    runSyncPass.mockResolvedValue(summary);
    const first = forceSyncNow();
    await vi.waitFor(() => expect(runSyncPass).toHaveBeenCalledTimes(1));
    await forceSyncNow(); // mid-pass: marks dirty, returns at once
    await forceSyncNow(); // coalesced with the one above
    release();
    await first;
    expect(runSyncPass).toHaveBeenCalledTimes(2);
  });

  it('serialises a manual pass behind a running one and rethrows its error', async () => {
    const { forceSyncNow, runSyncPassExclusive } = await import('./syncScheduler');
    let release!: () => void;
    runSyncPass.mockImplementationOnce(() => new Promise((r) => (release = () => r(summary))));
    runSyncPass.mockRejectedValueOnce(new Error('offline'));
    const auto = forceSyncNow();
    await vi.waitFor(() => expect(runSyncPass).toHaveBeenCalledTimes(1));
    const manual = runSyncPassExclusive();
    await Promise.resolve();
    expect(runSyncPass).toHaveBeenCalledTimes(1);
    release();
    await auto;
    await expect(manual).rejects.toThrow('offline');
  });
});
