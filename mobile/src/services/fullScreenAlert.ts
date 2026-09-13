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

export interface FullScreenAlertPlugin {
  showTest(options: { title?: string; body?: string }): Promise<{ shown: boolean }>;
}

const FullScreenAlert = registerPlugin<FullScreenAlertPlugin>('FullScreenAlert');

export default FullScreenAlert;
