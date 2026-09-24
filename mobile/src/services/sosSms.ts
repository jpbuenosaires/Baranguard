/**
 * sosSms.ts — the TypeScript edge of `SosSmsPlugin.java` (Android,
 * `android/app/src/main/java/ph/baranguard/tanod/SosSmsPlugin.java`), a
 * LOCAL custom Capacitor plugin (not an npm dependency) for G1's third
 * SOS fallback tier (Mobile Improvement Plan Phase 4.3).
 *
 * `registerPlugin()` is Capacitor's own mechanism for a plugin whose
 * native side isn't resolved through `capacitor.config.ts`'s automatic
 * dependency scan — the Java class is registered directly in
 * `MainActivity.onCreate()` instead.
 *
 * DEVICE-VERIFIED 2026-09-24 (DEVLOG entry (4)): a real completed send
 * was confirmed end-to-end with the user's explicit authorization
 * against their own number — `adb shell content query --uri
 * content://sms/sent` showed the exact composed message actually sent,
 * and it also round-tripped into the same device's own Messages app as
 * a second, independent confirmation.
 *
 * The failure path is NOT yet device-verified. A same-day attempt to
 * force it with a malformed number did NOT throw as expected — it
 * revealed a real gap instead: `SmsManager.sendTextMessage()` doesn't
 * synchronously validate the destination address, so the app reported
 * `sent: true` while nothing was transmitted and there was zero trace
 * in `content://sms/sent`/`/failed`/`/outbox` (DEVLOG entry (7)). Fixed
 * the same way twice on the native side (`SosSmsPlugin.java`): a format
 * check before ever calling `SmsManager`, and a real `sentIntent`-based
 * result instead of trusting the synchronous return. Both fixes are
 * code-only as of this comment — still needs a device retest (a
 * malformed number should now reject immediately; a real `sms_failed`
 * still needs airplane-mode/no-SIM testing to force a genuine carrier
 * rejection).
 */

import { registerPlugin } from '@capacitor/core';

export interface SosSmsPlugin {
  sendDirect(options: { number: string; message: string }): Promise<{ sent: boolean }>;
}

const SosSms = registerPlugin<SosSmsPlugin>('SosSms');

export default SosSms;
