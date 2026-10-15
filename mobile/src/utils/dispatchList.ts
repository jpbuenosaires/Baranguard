/**
 * dispatchList.ts - pure presentation helpers for the Dispatches list.
 * No I/O, no status transitions: only ordering and wording.
 */

import { distanceMeters } from './geo';

const STATUS_LABELS: Record<string, string> = {
  assigned: 'Assigned',
  en_route: 'En Route',
  arrived: 'Arrived',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** Human wording for a dispatch status; unknown values are de-snaked, never shown raw. */
export function dispatchStatusLabel(status: string): string {
  const known = STATUS_LABELS[status];
  if (known) return known;
  const spaced = status.replace(/_/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Unknown';
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, normal: 2 };

export interface SortableDispatch {
  status: string;
  priority: string;
  latitude: number | null;
  longitude: number | null;
  /** ISO time the dispatch was raised; newer first among equal priority. */
  dispatched_at?: string | null;
}

export function isInProgress(status: string): boolean {
  return status === 'en_route' || status === 'arrived';
}

/**
 * In-progress job (en_route/arrived) first, then priority, then most
 * recent, then nearest first when both rows and the device position are known. Stable.
 */
export function sortDispatches<T extends SortableDispatch>(
  rows: readonly T[],
  position: { latitude: number; longitude: number } | null
): T[] {
  return [...rows].sort((a, b) => {
    const ipA = isInProgress(a.status) ? 0 : 1;
    const ipB = isInProgress(b.status) ? 0 : 1;
    if (ipA !== ipB) return ipA - ipB;

    const pA = PRIORITY_ORDER[a.priority] ?? 2;
    const pB = PRIORITY_ORDER[b.priority] ?? 2;
    if (pA !== pB) return pA - pB;

    const tA = a.dispatched_at ? Date.parse(a.dispatched_at) : NaN;
    const tB = b.dispatched_at ? Date.parse(b.dispatched_at) : NaN;
    if (Number.isFinite(tA) && Number.isFinite(tB) && tA !== tB) return tB - tA;

    if (position && a.latitude !== null && a.longitude !== null && b.latitude !== null && b.longitude !== null) {
      return (
        distanceMeters(position.latitude, position.longitude, a.latitude, a.longitude) -
        distanceMeters(position.latitude, position.longitude, b.latitude, b.longitude)
      );
    }
    return 0;
  });
}
