import { describe, it, expect } from 'vitest';
import { buildQueueRows, formatQueueHeader, formatSyncResult } from './syncQueueSummary';

const base = { succeeded: 0, duplicates: 0, failed: 0, evidenceUploaded: 0, evidenceFailed: 0, dispatchRejected: 0, dutyRejected: 0 };
const zeros = { sos: 0, incidents: 0, dispatchAndDuty: 0, referrals: 0, workflowRecords: 0, gps: 0 };

describe('formatSyncResult', () => {
  it('maps success, duplicate and failed to plain words', () => {
    const r = formatSyncResult({ ...base, succeeded: 3, duplicates: 1, failed: 2 });
    expect(r.headline).toBe('3 sent, 1 already received by the server, 2 not sent.');
    expect(r.tone).toBe('warning');
  });
  it('is success only when nothing failed', () => {
    const r = formatSyncResult({ ...base, succeeded: 2 });
    expect(r.tone).toBe('success');
    expect(r.headline).toBe('2 sent.');
  });
  it('never reads as success when only evidence failed or a change was rejected', () => {
    expect(formatSyncResult({ ...base, evidenceFailed: 1 }).tone).toBe('warning');
    expect(formatSyncResult({ ...base, succeeded: 1, dispatchRejected: 1 }).tone).toBe('warning');
  });
  it('says so when nothing was waiting', () => {
    expect(formatSyncResult(base).headline).toBe('Nothing was waiting to send.');
  });
  it('does not claim "finished" or "synced"', () => {
    const text = JSON.stringify(formatSyncResult({ ...base, succeeded: 1, failed: 1 })).toLowerCase();
    expect(text).not.toContain('finished');
    expect(text).not.toContain('synced');
  });
  it('lists evidence and rejections as separate sentences', () => {
    const r = formatSyncResult({ ...base, succeeded: 1, evidenceUploaded: 2, evidenceFailed: 1, dutyRejected: 1 });
    expect(r.details).toEqual([
      '1 offline off-duty change rejected by HQ. See Home.',
      '2 evidence files sent, 1 not sent and will retry.',
    ]);
  });
});

describe('buildQueueRows', () => {
  it('puts SOS first and keeps a fixed order', () => {
    const rows = buildQueueRows(zeros, zeros, true);
    expect(rows.map((r) => r.kind)).toEqual(['sos', 'incidents', 'dispatchAndDuty', 'referrals', 'workflowRecords', 'gps']);
  });
  it('uses honest sync states', () => {
    const online = buildQueueRows({ ...zeros, sos: 1, gps: 4 }, zeros, true);
    expect(online[0].state).toBe('saved_on_phone');
    expect(online[5].state).toBe('saved_on_phone');
    expect(online[1].state).toBeNull();
    expect(buildQueueRows({ ...zeros, gps: 1 }, zeros, false)[5].state).toBe('waiting_connection');
    const failed = buildQueueRows({ ...zeros, sos: 1 }, { ...zeros, sos: 1 }, true)[0];
    expect(failed.state).toBe('failed');
    expect(failed.note).toContain('Call the barangay desk');
  });
});

describe('formatQueueHeader', () => {
  it('shows counts', () => {
    expect(formatQueueHeader(0, 0)).toBe('Nothing is waiting to send.');
    expect(formatQueueHeader(5, 0)).toBe('5 waiting to send');
    expect(formatQueueHeader(5, 1)).toBe('5 waiting to send, 1 needs attention');
    expect(formatQueueHeader(5, 2)).toBe('5 waiting to send, 2 need attention');
  });
});
