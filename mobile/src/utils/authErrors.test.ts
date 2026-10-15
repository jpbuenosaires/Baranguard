import { describe, expect, it } from 'vitest';
import { isSessionEndingUnauthorized } from './authErrors';

describe('isSessionEndingUnauthorized', () => {
  it('treats an invalid or expired token as a dead session', () => {
    expect(isSessionEndingUnauthorized(401, 'Invalid or expired token.')).toBe(true);
    expect(isSessionEndingUnauthorized(401, undefined)).toBe(true);
  });
  it('keeps the session when only the device signature failed', () => {
    expect(isSessionEndingUnauthorized(401, 'Device signature verification failed.')).toBe(false);
  });
  it('ignores non-401 statuses', () => {
    expect(isSessionEndingUnauthorized(403, 'Forbidden')).toBe(false);
    expect(isSessionEndingUnauthorized(500, 'x')).toBe(false);
  });
});
