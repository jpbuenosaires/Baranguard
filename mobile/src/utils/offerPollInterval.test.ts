import { describe, expect, it } from 'vitest';
import { offerPollInterval, OFFER_POLL_ACTIVE_MS, OFFER_POLL_IDLE_MS } from './offerPollInterval';

describe('offerPollInterval', () => {
  it('polls every 12 s while idle', () => {
    expect(offerPollInterval(false)).toBe(OFFER_POLL_IDLE_MS);
    expect(OFFER_POLL_IDLE_MS).toBe(12000);
  });
  it('polls every 4 s while an offer is open', () => {
    expect(offerPollInterval(true)).toBe(OFFER_POLL_ACTIVE_MS);
    expect(OFFER_POLL_ACTIVE_MS).toBe(4000);
  });
});
