/**
 * Decides WHEN `syncService.ts`'s `runSyncPass()` runs. Ported from
 * ../mobile's syncScheduler.ts; only the two native triggers' source
 * changed (`@capacitor/network`/`@capacitor/app` -> `@react-native-
 * community/netinfo`/RN `AppState`), the scheduling logic is unchanged.
 *
 * Three triggers, all best-effort and non-blocking:
 *   1. Network reconnect.
 *   2. App foreground — covers "unlocked the phone back at the barangay
 *      hall" without needing a network event to have fired.
 *   3. A 60s interval, but ONLY while on duty — an off-duty Tanod has
 *      nothing time-sensitive to flush. Screens report duty status here
 *      via `setKnownDutyStatus()` rather than this module polling
 *      `GET /duty-status` itself, which would duplicate a poll a screen
 *      already does on mount.
 *
 * A module-level `isSyncing` mutex ensures overlapping triggers never run
 * two passes at once — two concurrent passes reading/marking the same
 * unsynced rows would race.
 */
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
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
    // leaves local state untouched on failure, so there is nothing to
    // unwind; the next trigger retries naturally.
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

/** A screen calls this whenever it learns the real duty status (on load, and after a successful toggle). */
export function setKnownDutyStatus(status: DutyStatus | null): void {
  knownDutyStatus = status;
}

/** Forces a pass right now, outside the three automatic triggers — e.g. a manual "Sync now" button. Shares the same mutex. */
export function forceSyncNow(): Promise<void> {
  return triggerSync();
}

/** Wires the three triggers exactly once for the app's lifetime. Call from the root layout on mount. */
export function startSyncScheduler(): void {
  if (started) return;
  started = true;

  let wasConnected: boolean | null = null;
  NetInfo.addEventListener((state) => {
    const connected = Boolean(state.isConnected);
    if (connected && wasConnected === false) void triggerSync();
    wasConnected = connected;
  });

  AppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') void triggerSync();
  });

  setInterval(() => {
    if (knownDutyStatus === 'on_duty') void triggerSync();
  }, ON_DUTY_INTERVAL_MS);

  // Covers cold start with connectivity already present and duty status
  // already on from a previous session — the two event-driven triggers
  // above only fire on a CHANGE, not on state already true at load.
  void triggerSync();
}
