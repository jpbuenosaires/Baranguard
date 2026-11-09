import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// sosFallbackSms.ts pulls in Capacitor plugins at import time; stub them so only this logic runs.
const m = vi.hoisted(() => ({
  sendDirect: vi.fn(),
  backup: vi.fn(),
  gateway: vi.fn(),
}));
vi.mock('../services/sosFallbackContact', () => ({
  getCachedSosFallbackContact: m.backup,
  getCachedSosGatewayNumber: m.gateway,
}));
vi.mock('../services/sosSms', () => ({ default: { sendDirect: m.sendDirect } }));
vi.mock('../services/sosEnvelope', () => ({ buildSosEnvelopeText: async () => '{"envelope":1}' }));
vi.mock('../services/session', () => ({ loadSession: async () => ({ barangayId: 1, fullName: 'José Peña' }) }));
vi.mock('./homeDuty', () => ({ barangayLabel: () => 'Dao' }));

import { manilaStamp, runSosSmsFallback, toGsm7 } from './sosFallbackSms';

describe('toGsm7', () => {
  it('keeps names readable: accents to the base letter, ñ kept, emoji dropped', () => {
    expect(toGsm7('José Peña Ángel')).toBe('Jose Peña Angel');
    expect(toGsm7('Ana 🔥')).toBe('Ana ');
  });
  it('replaces nothing in plain ASCII', () => {
    expect(toGsm7('Juan Dela Cruz')).toBe('Juan Dela Cruz');
  });
});

describe('manilaStamp', () => {
  it('is fixed Asia/Manila (+08:00) ASCII, whatever the phone locale', () => {
    expect(manilaStamp(new Date('2026-11-07T13:40:12Z'))).toBe('2026-11-07 21:40');
    expect(manilaStamp(new Date('2026-11-07T17:05:00Z'))).toBe('2026-11-08 01:05');
  });
});

describe('runSosSmsFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    m.sendDirect.mockReset();
    m.backup.mockResolvedValue('09170000001');
    m.gateway.mockResolvedValue('09170000002');
  });
  afterEach(() => vi.useRealTimers());

  it('texts the backup contact even while the gateway text never reports a result', async () => {
    m.sendDirect.mockImplementation(({ number }: { number: string }) =>
      number === '09170000002' ? new Promise(() => {}) : Promise.resolve({ sent: true })
    );
    const run = runSosSmsFallback({ latitude: 13.1, longitude: 123.2 }, 'evt-1');
    await vi.advanceTimersByTimeAsync(20001);
    const r = await run;
    expect(m.sendDirect).toHaveBeenCalledWith(expect.objectContaining({ number: '09170000001' }));
    expect(r.outcome.smsStatus).toBe('sent');
    expect(r.toast).toMatch(/backup contact/);
  });

  it('is "pending", not "failed", when nothing confirmed in time', async () => {
    m.sendDirect.mockImplementation(() => new Promise(() => {}));
    const run = runSosSmsFallback({}, 'evt-2');
    await vi.advanceTimersByTimeAsync(20001);
    const r = await run;
    expect(r.outcome.smsStatus).toBe('pending');
    expect(r.toast).toMatch(/not confirmed/);
  });

  it('is "failed" with the reason when every send is rejected', async () => {
    m.sendDirect.mockRejectedValue(new Error('SEND_SMS permission was not granted.'));
    const r = await runSosSmsFallback({}, 'evt-3');
    expect(r.outcome.smsStatus).toBe('failed');
    expect(r.toast).toMatch(/permission was not granted/);
  });

  it('sends the backup text with an ASCII name and Manila time', async () => {
    m.gateway.mockResolvedValue(null);
    m.sendDirect.mockResolvedValue({ sent: true });
    await runSosSmsFallback({}, 'evt-4');
    const msg = m.sendDirect.mock.calls[0][0].message as string;
    expect(msg).toContain('Tanod: Jose Peña (Brgy Dao)');
    expect(msg).toMatch(/Time: \d{4}-\d\d-\d\d \d\d:\d\d$/);
  });
});
