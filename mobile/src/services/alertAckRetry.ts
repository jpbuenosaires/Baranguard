/**
 * alertAckRetry.ts — a critical alert's Acknowledge must not be lost when the
 * workstation is unreachable. The overlay still dismisses at once (the
 * Tanod must be able to act); the ack is remembered here and re-sent when the
 * network returns, the app is foregrounded, or on a slow timer. The server
 * treats a repeat ack as idempotent, so a duplicate is harmless.
 *
 * Only failures that can succeed later are kept: unreachable, 5xx, 401 (sign
 * in again). Any other 4xx is the server's answer (not ours, gone), so it is
 * dropped rather than retried forever.
 */

import { acknowledgeNotification, ApiError } from './apiService';

const KEY = 'baranguard.pendingAlertAcks';
const MAX_PENDING = 20;
const RETRY_INTERVAL_MS = 60_000;

function load(): number[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function save(ids: number[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(-MAX_PENDING)));
  } catch {
    // Storage blocked: the in-flight attempt was all we could do.
  }
}

function canRetryLater(error: unknown): boolean {
  return !(error instanceof ApiError) || error.isOffline || error.status >= 500 || error.status === 401;
}

/** Acknowledge now; on a failure worth retrying, remember the id for `flushPendingAcks`. Never throws. */
export async function acknowledgeAlert(notificationId: number): Promise<void> {
  try {
    await acknowledgeNotification(notificationId);
  } catch (error) {
    if (canRetryLater(error)) save([...load().filter((id) => id !== notificationId), notificationId]);
  }
}

let flushing = false;

/** Re-sends remembered acks oldest first; stops at the first one that still cannot go through. */
export async function flushPendingAcks(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (const id of load()) {
      try {
        await acknowledgeNotification(id);
      } catch (error) {
        if (canRetryLater(error)) return;
      }
      save(load().filter((pending) => pending !== id));
    }
  } finally {
    flushing = false;
  }
}

/** Call once at app start: flush on reconnect, on returning to the foreground, and every minute. */
export function startPendingAckRetry(): void {
  const flush = () => void flushPendingAcks();
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flush();
  });
  window.setInterval(flush, RETRY_INTERVAL_MS);
  flush();
}
