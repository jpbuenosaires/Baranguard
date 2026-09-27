/**
 * Bridges `NewIncidentScreen`'s "Pick on Map" button to the
 * `incidents/pick-location` modal route and back, as a promise — expo-router
 * has no built-in way for a modal route to hand a value back to whichever
 * screen pushed it, and this app has no shared state library, so a single
 * module-scope pending resolver is the smallest mechanism that works for
 * this one-at-a-time flow (only one picker can ever be open).
 */
import { router } from 'expo-router';
import type { FocusTarget } from '../components/LiveMapCanvas';

let pendingResolve: ((point: FocusTarget | null) => void) | null = null;

/** Navigates to the picker modal and resolves with the picked point, or null if cancelled. */
export function requestLocationPick(initial: FocusTarget | null): Promise<FocusTarget | null> {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    router.push({
      pathname: '/incidents/pick-location',
      params: initial ? { lat: String(initial.latitude), lng: String(initial.longitude) } : {},
    });
  });
}

/** Called by the picker modal on confirm/cancel, before navigating back. */
export function resolveLocationPick(point: FocusTarget | null): void {
  const resolve = pendingResolve;
  pendingResolve = null;
  resolve?.(point);
}
