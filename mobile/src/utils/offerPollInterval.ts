/** Poll cadence for GET /dispatch-offers: fast only while an offer is open, slow when idle. */
export const OFFER_POLL_IDLE_MS = 12000;
export const OFFER_POLL_ACTIVE_MS = 4000;

export function offerPollInterval(hasPendingOffer: boolean): number {
  return hasPendingOffer ? OFFER_POLL_ACTIVE_MS : OFFER_POLL_IDLE_MS;
}
