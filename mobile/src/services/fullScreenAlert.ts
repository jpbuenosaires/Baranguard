/**
 * fullScreenAlert.ts — the TypeScript edge of `FullScreenAlertPlugin.java` (Android), a LOCAL custom
 * Capacitor plugin for the full-screen critical alert.
 *
 * Only ever called from Profile's diagnostics ("Test Full-Screen Alert"): the REAL trigger is
 * `CriticalAlertMessagingService.java` intercepting an incoming FCM push directly, which needs no JS
 * call at all. This function lets the notification/full-screen-intent/Activity path be exercised
 * without a real Firebase project.
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
  /** True only when the native Firebase SDK actually initialized — see the Java method's own doc. */
  isFirebaseAvailable(): Promise<{ available: boolean }>;
  /**
   * Reads and clears whatever `CriticalAlertActivity`'s "Open Baranguard"
   * button stashed just before cold-launching the app —
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
