import { beforeEach, describe, expect, it, vi } from 'vitest';

const ack = vi.fn();
vi.mock('./apiService', () => {
  class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
      super(message);
    }
    get isOffline() {
      return this.code === 'NETWORK_ERROR';
    }
  }
  return { ApiError, acknowledgeNotification: (id: number) => ack(id) };
});

import { ApiError } from './apiService';
import { acknowledgeAlert, flushPendingAcks } from './alertAckRetry';

const KEY = 'baranguard.pendingAlertAcks';
const pending = () => JSON.parse(localStorage.getItem(KEY) ?? '[]');
const offline = () => new ApiError(0, 'NETWORK_ERROR', 'offline');

describe('critical alert acknowledge retry', () => {
  beforeEach(() => {
    localStorage.clear();
    ack.mockReset();
  });

  it('keeps nothing when the ack goes through', async () => {
    ack.mockResolvedValue({});
    await acknowledgeAlert(7);
    expect(pending()).toEqual([]);
  });

  it.each([
    ['offline', offline()],
    ['a server error', new ApiError(503, 'X', 'down')],
    ['an expired session', new ApiError(401, 'X', 'expired')],
  ])('remembers the id after %s, without throwing', async (_name, error) => {
    ack.mockRejectedValue(error);
    await expect(acknowledgeAlert(7)).resolves.toBeUndefined();
    expect(pending()).toEqual([7]);
  });

  it('drops an id the server refused (4xx), since retrying cannot help', async () => {
    ack.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'gone'));
    await acknowledgeAlert(7);
    expect(pending()).toEqual([]);
  });

  it('does not store the same id twice', async () => {
    ack.mockRejectedValue(offline());
    await acknowledgeAlert(7);
    await acknowledgeAlert(7);
    expect(pending()).toEqual([7]);
  });

  it('flush re-sends oldest first and clears what succeeded', async () => {
    localStorage.setItem(KEY, JSON.stringify([1, 2]));
    ack.mockResolvedValue({});
    await flushPendingAcks();
    expect(ack.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(pending()).toEqual([]);
  });

  it('flush stops at the first id that still cannot go through and keeps the rest', async () => {
    localStorage.setItem(KEY, JSON.stringify([1, 2, 3]));
    ack.mockResolvedValueOnce({}).mockRejectedValueOnce(offline());
    await flushPendingAcks();
    expect(ack).toHaveBeenCalledTimes(2);
    expect(pending()).toEqual([2, 3]);
  });

  it('flush discards an id the server now refuses and carries on', async () => {
    localStorage.setItem(KEY, JSON.stringify([1, 2]));
    ack.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'no')).mockResolvedValueOnce({});
    await flushPendingAcks();
    expect(pending()).toEqual([]);
  });
});
