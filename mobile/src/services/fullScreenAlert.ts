/**
 * fullScreenAlert.ts — the TypeScript edge of `FullScreenAlertPlugin.java`
 * (Android), a LOCAL custom Capacitor plugin for M12's full-screen
 * critical alert (Mobile Improvement Plan Phase 4.2).
 *
 * Only ever called from Profile's diagnostics ("Test Full-Screen Alert")
 * in this build — the REAL trigger is `CriticalAlertMessagingService.java`
 * intercepting an incoming FCM push directly, which needs no JS call at
 * all. This function exists so the notification/full-screen-intent/
 * Activity path has SOME way to be exercised without a real Firebase
 * project (REMAINING.md A4).
 */

import { registerPlugin } from '@capacitor/core';

export interface PendingNativeAlert {
  pending: true;
  notificationId: string;
  notificationType: string;
  title: string;
  body: string;
}

export interface FullScreenAlertPlugin {
  showTest(options: { title?: string; body?: string }): Promise<{ shown: boolean }>;
  /** True only when the native Firebase SDK actually initialized (REMAINING.md A4) — see the Java method's own doc. */
  isFirebaseAvailable(): Promise<{ available: boolean }>;
  /**
   * Reads and clears whatever `CriticalAlertActivity`'s "Open Baranguard"
   * button stashed just before cold-launching the app (C4, 2026-09-15) —
   * see `criticalAlertStore.ts`'s `checkForPendingNativeAlert()`, the only
   * caller.
   */
  getPendingAlert(): Promise<PendingNativeAlert | { pending: false }>;
  /**
   * Cancels the system heads-up notification (id 2001) — see the Java
   * method's own doc. A no-op if nothing is posted.
   */
  dismiss(): Promise<void>;
}

const FullScreenAlert = registerPlugin<FullScreenAlertPlugin>('FullScreenAlert');

export default FullScreenAlert;
