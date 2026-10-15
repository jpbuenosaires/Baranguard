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

export function useActiveSosCount(): number {
  const [n, setN] = useState(count);
  useEffect(() => {
    listeners.add(setN);
    let alive = true;
    const poll = async () => {
      try {
        if (!(await hasStoredSession())) return;
        const alerts = await getSosAlerts();
        if (alive) publishActiveSosCount(activeSosCount(alerts));
      } catch {
        // Keep the last known count.
      }
    };
    void poll();
    const stop = visibleInterval(() => void poll(), 20000);
    return () => {
      alive = false;
      stop();
      listeners.delete(setN);
    };
  }, []);
  return n;
}
