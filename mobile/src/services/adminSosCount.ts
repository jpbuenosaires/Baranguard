/**
 * adminSosCount - shared active-SOS count for the Chief Tanod tab badge.
 * One lightweight 20 s poll runs while the admin shell is mounted (the SOS
 * screen also publishes its own fresh list, so they never disagree). Offline
 * or on error the last known count is kept; nothing is polled when signed out.
 */
import { visibleInterval } from '../utils/visibleInterval';
import { useEffect, useState } from 'react';
import { getSosAlerts } from './apiService';
import { hasStoredSession } from './session';
import { activeSosCount } from '../utils/sosBadge';

let count = 0;
const listeners = new Set<(n: number) => void>();

export function publishActiveSosCount(n: number): void {
  if (n === count) return;
  count = n;
  listeners.forEach((l) => l(n));
}

let subscribers = 0;
let stopPoll: (() => void) | null = null;

/** Fetches the SOS list now and publishes the count; keeps the last count on any failure. */
export async function refreshActiveSosCount(): Promise<void> {
  try {
    if (!(await hasStoredSession())) return;
    publishActiveSosCount(activeSosCount(await getSosAlerts()));
  } catch {
    // Keep the last known count.
  }
}

/** One shared poll for every badge, however many components mount the hook. */
export function useActiveSosCount(): number {
  const [n, setN] = useState(count);
  useEffect(() => {
    listeners.add(setN);
    setN(count);
    if (subscribers++ === 0) {
      void refreshActiveSosCount();
      stopPoll = visibleInterval(() => void refreshActiveSosCount(), 20000);
    }
    return () => {
      listeners.delete(setN);
      if (--subscribers === 0) {
        stopPoll?.();
        stopPoll = null;
      }
    };
  }, []);
  return n;
}
