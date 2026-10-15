import type { DutyStatus } from '../services/apiService';

export const BARANGAY_NAMES: Record<number, string> = { 1: 'Dao', 2: 'Binanuahan', 3: 'Marifosque', 4: 'Banuyo' };

export function barangayLabel(barangayId: number): string {
  return BARANGAY_NAMES[barangayId] ?? `Barangay ${barangayId}`;
}

/**
 * Last duty status this device learned from the server (or set itself), so a
 * cold start with no signal can still show it — and still let an on-duty
 * Tanod go OFF duty offline. A per-device display convenience only: the
 * server stays the source of truth whenever it is reachable.
 */
const LAST_DUTY_STATUS_KEY = 'baranguard.lastKnownDutyStatus';

export function readCachedDutyStatus(): DutyStatus | null {
  try {
    const value = localStorage.getItem(LAST_DUTY_STATUS_KEY);
    return value === 'on_duty' || value === 'off_duty' || value === 'responding' ? value : null;
  } catch {
    return null;
  }
}

export function writeCachedDutyStatus(value: DutyStatus): void {
  try {
    localStorage.setItem(LAST_DUTY_STATUS_KEY, value);
  } catch {
    // Storage unavailable — the cache is optional.
  }
}
