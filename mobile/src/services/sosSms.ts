/**
 * sosSms.ts — the TypeScript edge of `SosSmsPlugin.java` (Android,
 * `android/app/src/main/java/ph/baranguard/tanod/SosSmsPlugin.java`), a LOCAL custom Capacitor plugin (not
 * an npm dependency) for the third SOS fallback tier.
 *
 * `registerPlugin()` is Capacitor's own mechanism for a plugin whose native side isn't resolved through
 * `capacitor.config.ts`'s automatic dependency scan; the Java class is registered directly in
 * `MainActivity.onCreate()` instead.
 *
 * Gotcha: `SmsManager.sendTextMessage()` doesn't synchronously validate the destination address, so a
 * malformed number would report `sent: true` while nothing was transmitted. The native side
 * (`SosSmsPlugin.java`) therefore checks the number's format before ever calling `SmsManager`, and reports
 * a real `sentIntent`-based result instead of trusting the synchronous return. A genuine carrier
 * rejection (`sms_failed`) still needs airplane-mode/no-SIM testing to force.
 */

import { registerPlugin } from '@capacitor/core';

export interface SosSmsPlugin {
  sendDirect(options: { number: string; message: string }): Promise<{ sent: boolean }>;
}

const SosSms = registerPlugin<SosSmsPlugin>('SosSms');

export default SosSms;
