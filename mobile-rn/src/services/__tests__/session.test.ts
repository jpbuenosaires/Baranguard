import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { clearSession, loadSession, readTokenExpiry, saveSession, storeRenewedToken } from '../session';

const mockStore = new Map<string, string>();
jest.mock('../storage', () => ({
  secrets: {
    get: async (key: string) => mockStore.get(key) ?? null,
    set: async (key: string, value: string) => void mockStore.set(key, value),
    remove: async (key: string) => void mockStore.delete(key),
  },
}));

function jwtWithExp(exp: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 4, exp })}.sig`;
}

const baseSession = { userId: 4, barangayId: 1, role: 'tanod', fullName: 'Juan Reyes' };

describe('readTokenExpiry', () => {
  it('reads exp from an unpadded base64url payload', () => {
    expect(readTokenExpiry(jwtWithExp(1790000000))).toBe(1790000000);
  });

  it('returns 0 for malformed tokens', () => {
    expect(readTokenExpiry('not-a-jwt')).toBe(0);
    expect(readTokenExpiry('a.!!!.c')).toBe(0);
  });
});

describe('storeRenewedToken (Rule 9 sliding renewal)', () => {
  beforeEach(async () => {
    mockStore.clear();
    await clearSession();
  });

  it('keeps a renewal that expires later', async () => {
    await saveSession({ ...baseSession, token: jwtWithExp(1000), expiresAt: 1000 });
    await storeRenewedToken(jwtWithExp(2000));
    expect((await loadSession())?.expiresAt).toBe(2000);
  });

  it('never moves the expiry backwards', async () => {
    await saveSession({ ...baseSession, token: jwtWithExp(2000), expiresAt: 2000 });
    await storeRenewedToken(jwtWithExp(1500));
    expect((await loadSession())?.expiresAt).toBe(2000);
  });

  it('never creates a session from a renewal alone', async () => {
    await storeRenewedToken(jwtWithExp(2000));
    expect(await loadSession()).toBeNull();
  });
});
