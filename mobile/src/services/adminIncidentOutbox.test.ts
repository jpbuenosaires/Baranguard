import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: { idempotencyKey: string; payload: Record<string, string>; createdAt: string; attempts: number; lastError: string | null }[] = [];
const send = vi.fn();

vi.mock('./db/adminIncidentOutboxRepository', () => ({
  addAdminIncidentToOutbox: async (key: string, payload: Record<string, string>) => {
    rows.push({ idempotencyKey: key, payload, createdAt: new Date().toISOString(), attempts: 0, lastError: null });
  },
  listAdminIncidentOutbox: async () => [...rows],
  removeAdminIncidentFromOutbox: async (key: string) => {
    const i = rows.findIndex((r) => r.idempotencyKey === key);
    if (i >= 0) rows.splice(i, 1);
  },
  recordAdminIncidentFailure: async (key: string, message: string) => {
    const r = rows.find((x) => x.idempotencyKey === key);
    if (r) {
      r.attempts += 1;
      r.lastError = message;
    }
  },
}));

vi.mock('./apiService', () => {
  class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
    get isOffline() {
      return this.status === 0;
    }
  }
  return { ApiError, createAdminIncident: (...args: unknown[]) => send(...args) };
});

import { ApiError } from './apiService';
import { flushAdminIncidentOutbox, submitAdminIncident } from './adminIncidentOutbox';

const payload = {
  incidentType: 'disturbance',
  priority: 'normal',
  reportChannel: 'phone_call',
  locationDescription: 'Purok 3',
  complainantName: '',
  narrative: 'Loud quarrel near the hall',
};

describe('Chief Tanod incident outbox', () => {
  beforeEach(() => {
    rows.length = 0;
    send.mockReset();
  });

  it('keeps the report on the phone when there is no connection, and sends it later', async () => {
    send.mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'offline'));
    const first = await submitAdminIncident(payload);
    expect(first).toEqual({ sent: 0, waiting: 1, refused: 0 });
    expect(rows).toHaveLength(1);

    send.mockResolvedValueOnce({ incidentId: 7, displayId: 'INC-2026-007' });
    const second = await flushAdminIncidentOutbox();
    expect(second.sent).toBe(1);
    expect(rows).toHaveLength(0);
    // the same idempotency key is reused on the resend
    expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1]);
  });

  it('records a server refusal on the row and does not drop the report', async () => {
    send.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'raw_narrative is required.'));
    const result = await submitAdminIncident(payload);
    expect(result.refused).toBe(1);
    expect(rows[0].lastError).toMatch(/required/);
  });
});
