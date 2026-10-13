import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = new Map<string, Record<string, unknown>>();
const fakeDb = {
  run: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('DELETE')) {
      rows.delete(String(params[0]));
    } else {
      const [k, t, n, lat, lng, acc, sid, s, a, st] = params;
      rows.set(String(k), {
        incident_type: t,
        narrative: n,
        latitude: lat,
        longitude: lng,
        accuracy_m: acc,
        school_id: sid,
        c1_summary: s,
        c1_action_taken: a,
        c1_status_notes: st,
      });
    }
  }),
  query: vi.fn(async (_sql: string, params: unknown[]) => {
    const r = rows.get(String(params[0]));
    return { values: r ? [r] : [] };
  }),
};
vi.mock('./localDatabase', () => ({ openLocalDatabase: async () => fakeDb }));

import {
  clearIncidentDraft,
  draftKey,
  isDraftEmpty,
  loadIncidentDraft,
  saveIncidentDraft,
  type IncidentDraft,
} from './draftRepository';

const blank: IncidentDraft = {
  incidentType: 'theft',
  narrative: '',
  latitude: null,
  longitude: null,
  accuracyM: null,
  schoolId: '',
  c1Summary: '',
  c1ActionTaken: '',
  c1StatusNotes: '',
};

describe('incident draft repository', () => {
  beforeEach(() => rows.clear());

  it('treats an untouched form as empty', () => {
    expect(isDraftEmpty(blank)).toBe(true);
    expect(isDraftEmpty({ ...blank, narrative: '   ' })).toBe(true);
    expect(isDraftEmpty({ ...blank, narrative: 'x' })).toBe(false);
    expect(isDraftEmpty({ ...blank, latitude: 13.1 })).toBe(false);
  });

  it('round-trips a draft and keeps one row per user', async () => {
    await saveIncidentDraft(7, { ...blank, narrative: 'first', schoolId: '3' });
    await saveIncidentDraft(7, { ...blank, narrative: 'second', latitude: 13.1, longitude: 123.7, accuracyM: 8 });
    expect(rows.size).toBe(1);
    const d = await loadIncidentDraft(7);
    expect(d?.narrative).toBe('second');
    expect(d?.latitude).toBe(13.1);
    expect(d?.schoolId).toBe('');
    expect(await loadIncidentDraft(8)).toBeNull();
  });

  it('saving an empty form removes the draft; clear removes it too', async () => {
    await saveIncidentDraft(7, { ...blank, narrative: 'x' });
    await saveIncidentDraft(7, blank);
    expect(await loadIncidentDraft(7)).toBeNull();
    await saveIncidentDraft(7, { ...blank, narrative: 'x' });
    await clearIncidentDraft(7);
    expect(await loadIncidentDraft(7)).toBeNull();
    expect(draftKey(null)).toBe('user-unknown');
  });
});
