/**
 * syncScheduler.ts — decides WHEN `syncService.ts`'s `runSyncPass()` runs,
 * which that file's own header comment explicitly leaves to "a screen's
 * own effect" — this is that effect, centralized instead of duplicated
 * per-screen (Mobile Improvement Plan Phase 1.1).
 *
 * Before this file, a sync pass only ever ran when a Tanod manually
 * opened `SyncQueueModal.tsx` and tapped Sync — a real field-usability gap
 * for a Tanod who assumes returning to workstation Wi-Fi is enough.
 *
 * Three triggers, all best-effort and non-blocking:
 *   1. Network reconnect (`@capacitor/network`'s `networkStatusChange`).
 *   2. App foreground (`@capacitor/app`'s `appStateChange`) — covers
 *      "unlocked the phone back at the barangay hall" without needing a
 *      network event to have fired.
 *   3. A 60s interval, but ONLY while on duty — an off-duty Tanod has
 *      nothing time-sensitive to flush, and polling `POST /sync/batch`
 *      every minute for an idle device is a real battery/bandwidth cost
 *      with no offsetting benefit (§2 Rule 6 spirit: don't run a control
 *      nobody needs). `home.tsx` reports duty status here via
 *      `setKnownDutyStatus()` rather than this module querying the server
 *      itself, which would be a second, redundant `GET /duty-status`
 *      poll on top of the one `home.tsx` already does on mount.
 *
 * A module-level `isSyncing` mutex (same "no state library, hand-rolled
 * singleton" pattern as `criticalAlertStore.ts`) ensures overlapping
 * triggers (e.g. the network reconnects AND the app comes to the
 * foreground within the same second) never run two sync passes at once —
 * `runSyncPass()` itself has no such guard, and two concurrent passes
 * reading/marking the same unsynced rows would race.
 *
 * NOT DEVICE-VERIFIED for the network/foreground listeners specifically
 * (same caveat every native-plugin-backed module in this app carries) —
 * type-checked and built against `@capacitor/network`/`@capacitor/app`'s
 * documented API, exercised so far only via a manual `triggerSync()` call
 * path, not a real disconnect/reconnect or backgrounding cycle on device.
 */

import { App as CapacitorApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { runSyncPass, type SyncSummary } from './syncService';
import type { DutyStatus } from './apiService';

const ON_DUTY_INTERVAL_MS = 60000;

let started = false;
let isSyncing = false;
let knownDutyStatus: DutyStatus | null = null;
let lastSummary: SyncSummary | null = null;
const listeners = new Set<(summary: SyncSummary) => void>();

async function triggerSync(): Promise<void> {
  if (isSyncing) return; // A pass already in flight covers whatever prompted this one too.
  isSyncing = true;
  try {
    lastSummary = await runSyncPass();
    for (const listener of listeners) listener(lastSummary);
  } catch {
    // Offline, or the workstation rejected the batch — runSyncPass()
    // leaves local state untouched on failure (see its own doc comment),
    // so there is nothing to unwind; the next trigger retries naturally.
  } finally {
    isSyncing = false;
  }
}

/** The most recent completed pass's result, for a screen that wants to show it without triggering its own. */
export function getLastSyncSummary(): SyncSummary | null {
  return lastSummary;
}

/** Notified after every scheduler-triggered (or manually forced) pass completes. Returns an unsubscribe function. */
export function subscribeSyncSummary(listener: (summary: SyncSummary) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `home.tsx` calls this whenever it learns the real duty status (on load,
 * and after a successful toggle) — the on-duty interval trigger below
 * reads this cache rather than polling `GET /duty-status` itself.
 */
export function setKnownDutyStatus(status: DutyStatus | null): void {
  knownDutyStatus = status;
}

/** Forces a pass right now, outside the three automatic triggers — e.g. a manual "Sync now" button. Shares the same mutex. */
export function forceSyncNow(): Promise<void> {
  return triggerSync();
}

/**
 * Wires the three triggers exactly once for the app's lifetime. Call from
 * `App.tsx` on mount, mirroring `registerCriticalAlertListeners()`'s own
 * "register once, at the root" pattern.
 */
export function startSyncScheduler(): void {
  if (started) return;
  started = true;

  Network.addListener('networkStatusChange', (status) => {
    if (status.connected) void triggerSync();
  });

  CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) void triggerSync();
  });

  setInterval(() => {
    if (knownDutyStatus === 'on_duty') void triggerSync();
  }, ON_DUTY_INTERVAL_MS);

  // Covers cold start with connectivity already present and duty status
  // already on from a previous session — the three event-driven triggers
  // above only fire on a CHANGE, not on the state already being true when
  // this module loads.
  void triggerSync();
}
