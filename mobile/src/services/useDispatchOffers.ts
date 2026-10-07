/**
 * useDispatchOffers — React binding for `dispatchOfferStore.ts`. Subscribing
 * (any number of components) keeps the shared foreground poll running.
 */

import { useEffect, useState } from 'react';
import {
  getDispatchOfferSnapshot,
  subscribeDispatchOffers,
  type DispatchOfferSnapshot,
} from './dispatchOfferStore';

export function useDispatchOffers(): DispatchOfferSnapshot {
  const [snapshot, setSnapshot] = useState<DispatchOfferSnapshot>(getDispatchOfferSnapshot);
  useEffect(() => subscribeDispatchOffers(setSnapshot), []);
  return snapshot;
}
