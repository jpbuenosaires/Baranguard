import { describe, it, expect } from 'vitest';
import { nextActionFor, nextActionBlockedReason } from './dispatchNext';

describe('nextActionFor', () => {
  it('words each server-defined next status', () => {
    expect(nextActionFor('arrived')?.label).toBe('Mark arrived');
    expect(nextActionFor('completed')?.label).toBe('Mark completed');
    expect(nextActionFor('en_route')?.label).toMatch(/en route/);
  });
  it('returns null when there is no next status', () => {
    expect(nextActionFor(null)).toBeNull();
    expect(nextActionFor('bogus')).toBeNull();
  });
});

describe('nextActionBlockedReason', () => {
  it('explains a missing server id', () => {
    expect(nextActionBlockedReason({ serverDispatchId: null, updating: false })).toMatch(/Connect/);
  });
  it('explains an in-flight save and is null when usable', () => {
    expect(nextActionBlockedReason({ serverDispatchId: 5, updating: true })).toMatch(/Saving/);
    expect(nextActionBlockedReason({ serverDispatchId: 5, updating: false })).toBeNull();
  });
});
